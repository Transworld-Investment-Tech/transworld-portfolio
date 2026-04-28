/**
 * lib/nav-reconstruct.ts — v27r
 *
 * v27r change: market_prices loader migrated to RPC + jsonb to bypass
 * PostgREST's server-side db-max-rows cap (~1000 rows). The previous
 * .from('market_prices').select(...).in(...).in(...).limit(50000) call
 * was silently truncating to 1000 rows, missing up to 70% of price data
 * for portfolios with broad instrument coverage. Holdings whose prices
 * were missing fell through to lastKnownPrice → avgCost → 0 (for
 * TRANSFER_IN-only positions), undercounting NAV by 30-50% across the
 * entire history. ADE-D's NAV on 2024-12-31 was reconstructed as ₦54.76M
 * vs the actual ₦107.13M (51% ratio). YTD/LY/L3Y/L5Y IRRs were all
 * distorted as a result; ITD escaped because it reads starting NAV from
 * portfolios.starting_nav and current NAV from the live holdings cache,
 * neither of which goes through reconstruction.
 *
 * The fix uses get_prices_for_recon(p_instrument_ids text[], p_dates date[])
 * which RETURNS jsonb — PostgREST treats the result as a single scalar,
 * which is not subject to db-max-rows. Same pattern as v27q-fix4's
 * get_prices_for_tickers. Defensive Array.isArray guard on the response.
 *
 * v27k preserved: three-level price fallback eliminates day-to-day NAV
 * oscillation on sparse coverage. Chain unchanged:
 *   price = prices[instrId] ?? lastKnownPrice.get(instrId) ?? avgCost
 *
 * The lastKnownPrice map is rebuilt per-portfolio (not global) and
 * updated each time a date has market price for an instrument. NAV
 * trajectory becomes monotonic-ish — same behavior as a real broker
 * statement.
 *
 * To benefit, existing nav_log rows must be wiped and rebuilt. Use the
 * companion POST /api/admin/rebuild-nav endpoint (destructive) to wipe
 * and rebuild firm-wide, or DELETE FROM nav_log WHERE portfolio_id = ...
 * for a single portfolio then click Reconstruct in the UI.
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
  const { data: txns } = await db
    .from('transactions')
    .select('trade_date, action, instrument_id, quantity, price')
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

  // ── 5. Replay & compute (v27k: with lastKnownPrice carry-forward) ─
  const firstTxDate = txns[0].trade_date as string
  const newNavEntries: any[] = []

  // v27k: maintain last-known price per instrument across the date walk.
  // Each iteration:
  //   (a) if market_prices has a value for instrument today, update lastKnownPrice
  //   (b) when valuing today's holdings, use market price → lastKnown → avgCost
  // This produces monotonic NAV trajectories (no oscillation from sparse coverage).
  const lastKnownPrice = new Map<string, number>()

  for (const date of dates) {
    if (date < firstTxDate) continue

    const prices = priceMap[date] ?? {}

    // v27k step (a): update lastKnownPrice for any instrument with today's data,
    // BEFORE the existing-date skip. We want carry-forward to be unaffected by
    // whether we re-emit a nav_log row — the price information is real either way.
    for (const [instrId, price] of Object.entries(prices)) {
      if (price > 0) lastKnownPrice.set(instrId, price)
    }

    if (existingDates.has(date)) continue

    const holdings = replayToDate(txns, date)
    if (Object.keys(holdings).length === 0) continue

    // v27k step (b): three-level fallback.
    let nav = 0
    for (const [instrId, { quantity, avgCost }] of Object.entries(holdings)) {
      let price: number
      if (instrId === 'CASH_NGN') {
        price = 1
      } else if (prices[instrId] !== undefined) {
        price = prices[instrId]
      } else if (lastKnownPrice.has(instrId)) {
        price = lastKnownPrice.get(instrId)!
      } else {
        price = avgCost
      }
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
