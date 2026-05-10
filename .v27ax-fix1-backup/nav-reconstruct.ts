/**
 * lib/nav-reconstruct.ts — v27ag
 *
 * v27ag change: NAV reconstruction is now cash-aware. The previous
 * replayToDate() walked only share-bearing rows and returned a holdings
 * dictionary; the resulting nav_value was share-only. For every recovery-
 * flow portfolio (and any portfolio with non-trivial uninvested cash)
 * this understated the true NAV by exactly the cash balance.
 *
 * The fix:
 *   - replayToDate now also walks cash-touching rows (BUY, SELL, FEE,
 *     TRANSFER_IN, TRANSFER_OUT, INCOME) using applyCashEvent from
 *     lib/cash.ts, applying the in-kind rule.
 *   - The CASH_NGN legacy holding is excluded from share valuation,
 *     because cash now comes from the accumulator. Without this, any
 *     portfolio that imported with the legacy CASH_NGN-as-holding
 *     pattern would double-count.
 *   - SELECT in reconstructPortfolioNav broadens to include
 *     gross_value, amount, fees so the cash walk has the data it needs.
 *   - nav_log row notes change to flag cash-aware reconstruction.
 *
 * After deploying v27ag, existing nav_log rows MUST be wiped for any
 * portfolio with non-trivial cash activity and re-reconstructed via
 * POST /api/admin/rebuild-with-cash.
 *
 * v27r preserved: market_prices loader uses get_prices_for_recon RPC +
 * jsonb to bypass PostgREST's server-side db-max-rows cap.
 *
 * v27k preserved: three-level price fallback (market → lastKnown →
 * avgCost) eliminates day-to-day NAV oscillation on sparse coverage.
 */

import { SupabaseClient } from '@supabase/supabase-js'
import { applyCashEvent } from './cash'

interface HoldingState {
  quantity: number
  costSum:  number
  buyQty:   number
}

interface ReplayResult {
  holdings: Record<string, { quantity: number; avgCost: number }>
  cash:     number
}

function replayToDate(
  txns: any[],
  date: string
): ReplayResult {
  const state: Record<string, HoldingState> = {}
  let cash = 0

  for (const t of txns) {
    if (t.trade_date > date) break

    // ── Cash side: walk every transaction through applyCashEvent ────
    // The function applies the in-kind rule and CASH_NGN carve-out.
    cash = applyCashEvent(cash, t)

    // ── Share side: BUY/SELL/TRANSFER_IN/TRANSFER_OUT against a real
    //    instrument (not CASH_NGN, which is tracked via the cash
    //    accumulator above) ───────────────────────────────────────────
    const id = t.instrument_id as string | null | undefined
    if (!id || id === 'CASH_NGN') continue
    if (!['BUY', 'SELL', 'TRANSFER_IN', 'TRANSFER_OUT'].includes(t.action)) continue

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

  const holdings: Record<string, { quantity: number; avgCost: number }> = {}
  for (const [id, s] of Object.entries(state)) {
    if (s.quantity > 0.0001) {
      holdings[id] = {
        quantity: s.quantity,
        avgCost:  s.buyQty > 0 ? s.costSum / s.buyQty : 0,
      }
    }
  }
  return { holdings, cash }
}

export interface ReconstructResult {
  portfolioId:        string
  navEntriesAdded:    number
  datesProcessed:     number
  instrumentsTracked: number
  error?:             string
}

export async function reconstructPortfolioNav(
  db: SupabaseClient,
  portfolioId: string,
  allDates?: string[]
): Promise<ReconstructResult> {
  // ── 1. Fetch dates ────────────────────────────────────────────────
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
      .sort()  // ascending — critical for v27k carry-forward logic
  }

  if (dates.length === 0) {
    return { portfolioId, navEntriesAdded: 0, datesProcessed: 0, instrumentsTracked: 0 }
  }

  // ── 2. Load transactions ──────────────────────────────────────────
  // v27ag: SELECT broadened to include gross_value, amount, fees so the
  // cash walk in replayToDate has the data it needs.
  const { data: txns } = await db
    .from('transactions')
    .select('trade_date, action, instrument_id, quantity, price, gross_value, amount, fees')
    .eq('portfolio_id', portfolioId)
    .order('trade_date', { ascending: true })
    .limit(50000)

  if (!txns || txns.length === 0) {
    return { portfolioId, navEntriesAdded: 0, datesProcessed: dates.length, instrumentsTracked: 0 }
  }

  // ── 3. Filter prices to portfolio's instruments only ──────────────
  // v27r: switched from .from('market_prices').select(...).in(...).in(...).limit(50000)
  // to .rpc('get_prices_for_recon', ...) because PostgREST's server-side
  // db-max-rows cap (~1000) silently truncated the direct query. The RPC
  // returns jsonb, which is treated as a single scalar by PostgREST and
  // bypasses the cap. Same pattern as v27q-fix4's get_prices_for_tickers.
  const portfolioInstruments = [...new Set(
    txns.map((t: any) => t.instrument_id).filter(Boolean) as string[]
  )]

  const { data: priceRowsRaw, error: priceErr } = await db.rpc(
    'get_prices_for_recon',
    { p_instrument_ids: portfolioInstruments, p_dates: dates }
  )

  if (priceErr) {
    return {
      portfolioId,
      navEntriesAdded: 0,
      datesProcessed: dates.length,
      instrumentsTracked: portfolioInstruments.length,
      error: `get_prices_for_recon: ${priceErr.message}`,
    }
  }

  // Defensive guard: RPC returns jsonb which deserialises to array,
  // but null/undefined possible if function returns nothing.
  const priceRows = Array.isArray(priceRowsRaw) ? priceRowsRaw : []

  const priceMap: Record<string, Record<string, number>> = {}
  for (const p of priceRows) {
    if (!priceMap[p.price_date]) priceMap[p.price_date] = {}
    priceMap[p.price_date][p.instrument_id] = Number(p.price)
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

  // ── 5. Replay & compute (v27k carry-forward + v27ag cash-aware) ──
  const firstTxDate = txns[0].trade_date as string
  const newNavEntries: any[] = []

  // v27k: maintain last-known price per instrument across the date walk.
  const lastKnownPrice = new Map<string, number>()

  for (const date of dates) {
    if (date < firstTxDate) continue

    const prices = priceMap[date] ?? {}

    // v27k step (a): update lastKnownPrice for any instrument with today's data,
    // BEFORE the existing-date skip. Carry-forward should be unaffected by
    // whether we re-emit a nav_log row.
    for (const [instrId, price] of Object.entries(prices)) {
      if (price > 0) lastKnownPrice.set(instrId, price)
    }

    if (existingDates.has(date)) continue

    const { holdings, cash } = replayToDate(txns, date)

    // v27ag: skip-condition is now share-empty AND cash-zero. A portfolio
    // with cash but no shares (rare but possible — e.g. all positions
    // sold, awaiting redeployment) is still a valid NAV row.
    if (Object.keys(holdings).length === 0 && Math.abs(cash) < 0.01) continue

    // v27k step (b): three-level fallback for share valuation. CASH_NGN
    // is already excluded from `holdings` by replayToDate; cash is added
    // separately from the accumulator below.
    let sharesValue = 0
    for (const [instrId, { quantity, avgCost }] of Object.entries(holdings)) {
      let price: number
      if (prices[instrId] !== undefined) {
        price = prices[instrId]
      } else if (lastKnownPrice.has(instrId)) {
        price = lastKnownPrice.get(instrId)!
      } else {
        price = avgCost
      }
      sharesValue += quantity * price
    }

    const nav = sharesValue + cash

    if (nav > 0) {
      newNavEntries.push({
        portfolio_id: portfolioId,
        nav_date:     date,
        nav_value:    Math.round(nav * 100) / 100,
        notes:        'Reconstructed (cash-aware, v27ag) from historical prices + transaction walk',
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
