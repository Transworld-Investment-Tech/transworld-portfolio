/**
 * lib/nav-reconstruct.ts — v27g
 *
 * Per-portfolio NAV reconstruction helper, extracted from
 * app/api/admin/reconstruct-nav/route.ts. Shared between the original
 * route (which loops over active portfolios) and the new commit-time
 * auto-fire (closes the second half of pitfall #86).
 *
 * Algorithm preserved bit-for-bit from v27f route:
 *   1. Fetch distinct price dates via get_distinct_market_price_dates RPC
 *      (server-side SELECT DISTINCT, no row-cap risk — pitfall #92 fix).
 *   2. Load portfolio's transactions sorted ascending.
 *   3. Filter market_prices to portfolio's distinct instruments only
 *      (~10-15 rows per date instead of ~300+).
 *   4. Skip dates already in nav_log (idempotent).
 *   5. Replay transactions to each new date via replayToDate;
 *      compute NAV using market price ?? avg cost; CASH_NGN priced at 1.
 *   6. Insert new nav_log rows with notes 'Reconstructed from historical prices'.
 */

import { SupabaseClient } from '@supabase/supabase-js'

interface HoldingState {
  quantity: number
  costSum:  number
  buyQty:   number
}

function replayToDate(
  txns: any[],
  date: string
): Record<string, { quantity: number; avgCost: number }> {
  const state: Record<string, HoldingState> = {}

  for (const t of txns) {
    if (t.trade_date > date) break
    const id = t.instrument_id
    if (!id || !['BUY', 'SELL', 'TRANSFER_IN', 'TRANSFER_OUT'].includes(t.action)) continue
    if (!state[id]) state[id] = { quantity: 0, costSum: 0, buyQty: 0 }

    const qty   = Math.abs(Number(t.quantity ?? 0))
    const price = Number(t.price ?? 0)

    if (t.action === 'BUY') {
      state[id].quantity += qty
      state[id].costSum  += qty * price
      state[id].buyQty   += qty
    } else if (t.action === 'SELL') {
      state[id].quantity -= qty
    } else if (t.action === 'TRANSFER_IN') {
      state[id].quantity += qty
    } else if (t.action === 'TRANSFER_OUT') {
      state[id].quantity -= qty
    }
  }

  const result: Record<string, { quantity: number; avgCost: number }> = {}
  for (const [id, s] of Object.entries(state)) {
    if (s.quantity > 0.0001) {
      result[id] = {
        quantity: s.quantity,
        avgCost:  s.buyQty > 0 ? s.costSum / s.buyQty : 0,
      }
    }
  }
  return result
}

export interface ReconstructResult {
  portfolioId:        string
  navEntriesAdded:    number
  datesProcessed:     number
  instrumentsTracked: number
  error?:             string
}

/**
 * Reconstruct NAV for a single portfolio.
 *
 * @param db          Supabase admin client (service role).
 * @param portfolioId Target portfolio UUID.
 * @param allDates    Optional pre-fetched distinct price dates. If omitted,
 *                    the helper fetches them via the v27f RPC. Passing dates
 *                    in is the firm-wide caller's optimization (one fetch,
 *                    N portfolios).
 */
export async function reconstructPortfolioNav(
  db: SupabaseClient,
  portfolioId: string,
  allDates?: string[]
): Promise<ReconstructResult> {
  // ── 1. Fetch dates (or use the caller's pre-fetched set) ──────────
  let dates = allDates
  if (!dates) {
    const { data: dateRows, error: dateErr } = await db.rpc('get_distinct_market_price_dates')
    if (dateErr) {
      return {
        portfolioId,
        navEntriesAdded: 0,
        datesProcessed: 0,
        instrumentsTracked: 0,
        error: `get_distinct_market_price_dates: ${dateErr.message}`,
      }
    }
    dates = ((dateRows ?? []) as { price_date: string }[])
      .map(r => r.price_date)
      .sort()
  }

  if (dates.length === 0) {
    return {
      portfolioId,
      navEntriesAdded: 0,
      datesProcessed: 0,
      instrumentsTracked: 0,
    }
  }

  // ── 2. Load transactions ──────────────────────────────────────────
  const { data: txns } = await db
    .from('transactions')
    .select('trade_date, action, instrument_id, quantity, price')
    .eq('portfolio_id', portfolioId)
    .order('trade_date', { ascending: true })
    .limit(50000)

  if (!txns || txns.length === 0) {
    return {
      portfolioId,
      navEntriesAdded: 0,
      datesProcessed: dates.length,
      instrumentsTracked: 0,
    }
  }

  // ── 3. Filter prices to portfolio's instruments only ──────────────
  const portfolioInstruments = [...new Set(
    txns.map((t: any) => t.instrument_id).filter(Boolean) as string[]
  )]

  const { data: priceRows } = await db
    .from('market_prices')
    .select('instrument_id, price_date, price')
    .in('instrument_id', portfolioInstruments)
    .in('price_date', dates)
    .limit(50000)

  const priceMap: Record<string, Record<string, number>> = {}
  for (const p of priceRows ?? []) {
    if (!priceMap[p.price_date]) priceMap[p.price_date] = {}
    priceMap[p.price_date][p.instrument_id] = p.price
  }

  // ── 4. Skip existing nav_log dates ────────────────────────────────
  const { data: existingNav } = await db
    .from('nav_log')
    .select('nav_date')
    .eq('portfolio_id', portfolioId)
    .limit(50000)
  const existingDates = new Set(
    (existingNav ?? []).map((n: any) => n.nav_date as string)
  )

  // ── 5. Replay & compute ───────────────────────────────────────────
  const firstTxDate = txns[0].trade_date as string
  const newNavEntries: any[] = []

  for (const date of dates) {
    if (date < firstTxDate) continue
    if (existingDates.has(date)) continue

    const holdings = replayToDate(txns, date)
    if (Object.keys(holdings).length === 0) continue

    const prices = priceMap[date] ?? {}
    let nav = 0

    for (const [instrId, { quantity, avgCost }] of Object.entries(holdings)) {
      const price = instrId === 'CASH_NGN'
        ? 1
        : (prices[instrId] ?? avgCost)
      nav += quantity * price
    }

    if (nav > 0) {
      newNavEntries.push({
        portfolio_id: portfolioId,
        nav_date:     date,
        nav_value:    Math.round(nav * 100) / 100,
        notes:        'Reconstructed from historical prices',
      })
    }
  }

  // ── 6. Insert ─────────────────────────────────────────────────────
  if (newNavEntries.length > 0) {
    const { error } = await db.from('nav_log').insert(newNavEntries)
    if (error) {
      return {
        portfolioId,
        navEntriesAdded: 0,
        datesProcessed: dates.length,
        instrumentsTracked: portfolioInstruments.length,
        error: `nav_log insert: ${error.message}`,
      }
    }
  }

  return {
    portfolioId,
    navEntriesAdded:    newNavEntries.length,
    datesProcessed:     dates.length,
    instrumentsTracked: portfolioInstruments.length,
  }
}
