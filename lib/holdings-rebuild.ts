/**
 * lib/holdings-rebuild.ts — v21d
 *
 * Recomputes a portfolio's holdings table from its transactions.
 * Called by:
 *   - app/api/broker/sessions/[id]/commit/route.ts  (after transactions INSERT)
 *   - app/api/broker/sessions/[id]/rollback/route.ts (after transactions DELETE)
 *
 * Why not incremental?  The portfolio-wide full rebuild is trivially
 * correct for any mix of historical SQL-seeded transactions + new
 * broker-committed transactions, and at typical scales (<1000
 * transactions per portfolio) it's sub-second. Incremental gets
 * complicated fast — partial fills, transfer-in cost treatment,
 * rollbacks of split trades.
 *
 * Algorithm per instrument_id (skipping NULL, which indicates cash
 * events / fees / untyped transfers):
 *
 *   net_quantity  = sum(BUY.qty) + sum(TRANSFER_IN.qty)
 *                 − sum(SELL.qty) − sum(TRANSFER_OUT.qty)
 *
 *   weighted_avg  = Σ(BUY.price × BUY.qty) / Σ(BUY.qty)
 *     (SELLs do NOT change avg_cost — standard cost-basis accounting.
 *      TRANSFER_IN is treated as avg_cost = 0 per known issue #5.
 *      If a holding exists only from TRANSFER_IN, avg_cost stays 0
 *      and the user overrides via /admin/prices manual price.)
 *
 *   as_of_date    = latest market_prices.price_date globally
 *                   (falls back to CURRENT_DATE if the table is empty)
 *
 *   sleeve_id     = copied from instruments master
 *
 * Then:
 *   - net_quantity > 0  → upsert holdings row
 *   - net_quantity ≤ 0  → delete existing holdings row (if any)
 *   - any holdings row for an instrument_id that appears in NONE of
 *     the portfolio's transactions → delete (rollback may have wiped
 *     all trades of a security that was only ever broker-ingested)
 *
 * Returns a summary for logging / UI confirmation. Does not throw —
 * callers can surface warnings but a failed rebuild shouldn't roll
 * back an already-successful transactions INSERT / DELETE.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface RebuildResult {
  upserted: number
  deleted: number
  skipped_no_instrument: number
  errors: string[]
}

type TxRow = {
  action: string
  instrument_id: string | null
  quantity: number | null
  price: number | null
}

type InstrumentRow = {
  instrument_id: string
  sleeve_id: string | null
}

export async function rebuildPortfolioHoldings(
  db: SupabaseClient,
  portfolio_id: string
): Promise<RebuildResult> {
  const result: RebuildResult = {
    upserted: 0,
    deleted: 0,
    skipped_no_instrument: 0,
    errors: [],
  }

  // ── 1. Fetch all transactions for this portfolio ────────────
  const { data: txs, error: txErr } = await db
    .from('transactions')
    .select('action, instrument_id, quantity, price')
    .eq('portfolio_id', portfolio_id)

  if (txErr) {
    result.errors.push(`transactions query: ${txErr.message}`)
    return result
  }

  const transactions = (txs || []) as TxRow[]

  // ── 2. Fetch instruments master (for sleeve_id + validation) ─
  const { data: instr, error: instrErr } = await db
    .from('instruments')
    .select('instrument_id, sleeve_id')

  if (instrErr) {
    result.errors.push(`instruments query: ${instrErr.message}`)
    return result
  }

  const instrumentsMap = new Map<string, InstrumentRow>()
  for (const i of (instr || []) as InstrumentRow[]) {
    instrumentsMap.set(i.instrument_id, i)
  }

  // ── 3. Determine as_of_date from latest market_prices row ────
  const { data: latestPrice, error: lpErr } = await db
    .from('market_prices')
    .select('price_date')
    .order('price_date', { ascending: false })
    .limit(1)
    .single()

  // Fallback to today if market_prices is empty or errors — don't
  // fail the whole rebuild over the as_of_date lookup.
  const asOfDate: string =
    !lpErr && latestPrice?.price_date
      ? latestPrice.price_date
      : new Date().toISOString().slice(0, 10)

  // ── 4. Aggregate per instrument_id ───────────────────────────
  type Agg = {
    instrument_id: string
    quantity: number
    buy_qty_sum: number
    buy_qxp_sum: number // Σ(buy qty × buy price)
  }

  const aggMap = new Map<string, Agg>()

  for (const tx of transactions) {
    if (!tx.instrument_id) {
      result.skipped_no_instrument++
      continue
    }
    const key = tx.instrument_id
    if (!aggMap.has(key)) {
      aggMap.set(key, {
        instrument_id: key,
        quantity: 0,
        buy_qty_sum: 0,
        buy_qxp_sum: 0,
      })
    }
    const agg = aggMap.get(key)!
    const qty = tx.quantity ?? 0
    const price = tx.price ?? 0

    switch (tx.action) {
      case 'BUY':
        agg.quantity += qty
        agg.buy_qty_sum += qty
        agg.buy_qxp_sum += qty * price
        break
      case 'SELL':
        agg.quantity -= qty
        // Does NOT touch buy_qty_sum / buy_qxp_sum — avg_cost
        // reflects original cost basis, not disposal.
        break
      case 'TRANSFER_IN':
        agg.quantity += qty
        // Known-issue #5: TRANSFER_IN comes in at avg_cost = 0.
        // Intentionally does NOT contribute to buy_qty_sum.
        break
      case 'TRANSFER_OUT':
        agg.quantity -= qty
        break
      // INCOME, FEE, and any other action are no-ops for holdings.
    }
  }

  // ── 5. Fetch existing holdings for this portfolio ────────────
  //      We need this to know what to delete (zero-qty or instruments
  //      that no longer appear in any transaction at all).
  const { data: existing, error: exErr } = await db
    .from('holdings')
    .select('instrument_id')
    .eq('portfolio_id', portfolio_id)

  if (exErr) {
    result.errors.push(`existing holdings query: ${exErr.message}`)
    return result
  }

  const existingIds = new Set(
    ((existing || []) as { instrument_id: string }[]).map((h) => h.instrument_id)
  )

  // ── 6. Decide upserts vs deletes ─────────────────────────────
  const upsertRows: any[] = []
  const deleteIds: string[] = []

  for (const agg of aggMap.values()) {
    if (agg.quantity > 0) {
      const instrument = instrumentsMap.get(agg.instrument_id)
      if (!instrument) {
        // Should be impossible after commit pre-check, but belt-and-braces
        result.errors.push(
          `instrument ${agg.instrument_id} missing from instruments master — skipping holding`
        )
        continue
      }
      const avgCost =
        agg.buy_qty_sum > 0 ? agg.buy_qxp_sum / agg.buy_qty_sum : 0

      upsertRows.push({
        portfolio_id,
        instrument_id: agg.instrument_id,
        sleeve_id: instrument.sleeve_id,
        quantity: agg.quantity,
        avg_cost: avgCost,
        as_of_date: asOfDate,
      })
    } else {
      // Net qty ≤ 0 — position closed. Delete if exists.
      if (existingIds.has(agg.instrument_id)) {
        deleteIds.push(agg.instrument_id)
      }
    }
  }

  // Also delete any existing holdings row for an instrument_id
  // that has NO transactions in the portfolio at all (post-rollback
  // cleanup).
  for (const existingId of existingIds) {
    if (!aggMap.has(existingId) && !deleteIds.includes(existingId)) {
      deleteIds.push(existingId)
    }
  }

  // ── 7. Execute ───────────────────────────────────────────────
  if (upsertRows.length > 0) {
    const { data: upResult, error: upErr } = await db
      .from('holdings')
      .upsert(upsertRows, { onConflict: 'portfolio_id,instrument_id' })
      .select('id')
    if (upErr) {
      result.errors.push(`holdings upsert: ${upErr.message}`)
    } else {
      result.upserted = upResult?.length ?? upsertRows.length
    }
  }

  if (deleteIds.length > 0) {
    const { data: delResult, error: delErr } = await db
      .from('holdings')
      .delete()
      .eq('portfolio_id', portfolio_id)
      .in('instrument_id', deleteIds)
      .select('id')
    if (delErr) {
      result.errors.push(`holdings delete: ${delErr.message}`)
    } else {
      result.deleted = delResult?.length ?? deleteIds.length
    }
  }

  return result
}
