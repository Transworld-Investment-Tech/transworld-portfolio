/**
 * lib/holdings-rebuild.ts — v27aa
 *
 * Recomputes a portfolio's holdings table from its transactions.
 * Called by:
 *   - app/api/broker/sessions/[id]/commit/route.ts  (after transactions INSERT)
 *   - app/api/broker/sessions/[id]/rollback/route.ts (after transactions DELETE)
 *   - app/api/admin/synthesize-recovery/route.ts    (after synth INSERT)
 *   - app/api/admin/transactions/[id]/route.ts      (v27v: after CRUD edit/delete)
 *   - app/api/holdings/route.ts                     (manual rebuild trigger)
 *
 * v27aa change (Priority 2 from 02_app_state.md):
 * ─────────────────────────────────────────────────────────────────
 * Previously TRANSFER_IN rows were ignored in avg_cost computation,
 * which left transfer-only positions showing avg_cost = ₦0.00 and
 * inflated unrealised P&L (~₦56M aggregate across affected portfolios).
 *
 * v27aa makes avg_cost category-aware for TRANSFER_IN rows:
 *
 *   (A) SYNTH ROWS (external_ref LIKE 'synthetic-recovery-%')
 *       Use the price stored on the row. recovery-synth.ts populates
 *       this with the orphan SELL match price — the correct economic
 *       anchor for synth-derived positions. Cannot use market_prices
 *       because synth dates are typically portfolio inception (e.g.
 *       2015-12-23) which predates our market_prices history.
 *
 *   (B) RECONCILIATION + MANUAL ROWS (everything else)
 *       Look up market_prices[(instrument_id, trade_date)] for the
 *       authoritative historical price. The row's `price` field is
 *       NOT trusted — it can be stale (e.g. v27r date corrections
 *       changed trade_date but not price, leaving 2026-era prices
 *       on rows now dated 2024). Fallback chain:
 *
 *         1. market_prices exact match (instrument_id, trade_date)
 *         2. market_prices nearest-prior (instrument_id, ≤ trade_date)
 *         3. row's stored `price` field (last resort)
 *         4. skip cost contribution (qty contributes; cost does not)
 *
 * Algorithm per instrument_id (skipping NULL, which indicates cash
 * events / fees / untyped transfers):
 *
 *   net_quantity  = sum(BUY.qty) + sum(TRANSFER_IN.qty)
 *                 − sum(SELL.qty) − sum(TRANSFER_OUT.qty)
 *
 *   weighted_avg  = Σ(BUY.price × BUY.qty + TRANSFER_IN.cost × TRANSFER_IN.qty)
 *                 / Σ(BUY.qty + TRANSFER_IN.qty_with_cost)
 *
 *     where TRANSFER_IN.cost is resolved via the category-aware chain
 *     above. SELLs and TRANSFER_OUTs do NOT change avg_cost — standard
 *     cost-basis accounting.
 *
 *   as_of_date    = latest market_prices.price_date globally
 *   sleeve_id     = copied from instruments master
 *
 * Then:
 *   - net_quantity > 0  → upsert holdings row
 *   - net_quantity ≤ 0  → delete existing holdings row (if any)
 *   - any holdings row for an instrument_id with NO transactions
 *     → delete (post-rollback cleanup)
 *
 * Returns a summary for logging / UI confirmation.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface RebuildResult {
  upserted: number
  deleted: number
  skipped_no_instrument: number
  errors: string[]
}

type TxRow = {
  action:        string
  instrument_id: string | null
  quantity:      number | null
  price:         number | null
  trade_date:    string | null
  external_ref:  string | null
}

type InstrumentRow = {
  instrument_id: string
  sleeve_id:     string | null
}

type PriceRow = {
  instrument_id: string
  price_date:    string
  price:         number
}

export async function rebuildPortfolioHoldings(
  db: SupabaseClient,
  portfolio_id: string
): Promise<RebuildResult> {
  const result: RebuildResult = {
    upserted:              0,
    deleted:               0,
    skipped_no_instrument: 0,
    errors:                [],
  }

  // ── 1. Fetch all transactions for this portfolio ────────────
  // v27aa: now also pulls trade_date + external_ref for category-aware
  // TRANSFER_IN cost basis resolution.
  const { data: txs, error: txErr } = await db
    .from('transactions')
    .select('action, instrument_id, quantity, price, trade_date, external_ref')
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

  // ── 3. v27aa: Pre-fetch market_prices for non-synth TRANSFER_IN rows ──
  //
  // Build the unique set of (instrument_id, trade_date) pairs we need
  // for cost-basis resolution. Synth rows are excluded — they always
  // use their stored row.price per the category rule.
  //
  // Two-step lookup:
  //   (a) Exact-date match for non-synth TRANSFER_IN rows
  //   (b) Nearest-prior-date map per instrument (built once, used as
  //       fallback when exact-date misses)
  const isSynth = (ref: string | null | undefined): boolean =>
    !!ref && ref.startsWith('synthetic-recovery-')

  const nonSynthTransferIns = transactions.filter(
    t => t.action === 'TRANSFER_IN' &&
         t.instrument_id &&
         t.trade_date &&
         !isSynth(t.external_ref)
  )

  const exactPriceMap = new Map<string, number>()  // key: `${id}|${date}`
  const allPricesByInstrument = new Map<string, PriceRow[]>()  // for nearest-prior fallback

  if (nonSynthTransferIns.length > 0) {
    const distinctIds = Array.from(new Set(
      nonSynthTransferIns.map(t => t.instrument_id!).filter(Boolean)
    ))
    const distinctDates = Array.from(new Set(
      nonSynthTransferIns.map(t => t.trade_date!).filter(Boolean)
    ))

    // 3a. Exact-date prefetch.
    if (distinctIds.length > 0 && distinctDates.length > 0) {
      const { data: exactRows, error: exactErr } = await db
        .from('market_prices')
        .select('instrument_id, price_date, price')
        .in('instrument_id', distinctIds)
        .in('price_date', distinctDates)

      if (exactErr) {
        result.errors.push(`market_prices exact lookup: ${exactErr.message}`)
        // Continue — fallback chain will still work via row.price + skip
      } else {
        for (const p of (exactRows || []) as PriceRow[]) {
          exactPriceMap.set(`${p.instrument_id}|${p.price_date}`, Number(p.price))
        }
      }
    }

    // 3b. Nearest-prior prefetch — fetch all price history for the
    // distinct instruments, sorted descending. We'll scan this in
    // the resolver to find the latest price ≤ trade_date.
    //
    // This is a single batched query that returns all rows we might
    // need; with v27y's db-max-rows raise to 50,000, we have plenty
    // of headroom.
    if (distinctIds.length > 0) {
      const { data: priorRows, error: priorErr } = await db
        .from('market_prices')
        .select('instrument_id, price_date, price')
        .in('instrument_id', distinctIds)
        .order('price_date', { ascending: false })
        .limit(50000)

      if (priorErr) {
        result.errors.push(`market_prices nearest-prior lookup: ${priorErr.message}`)
      } else {
        for (const p of (priorRows || []) as PriceRow[]) {
          if (!allPricesByInstrument.has(p.instrument_id)) {
            allPricesByInstrument.set(p.instrument_id, [])
          }
          allPricesByInstrument.get(p.instrument_id)!.push({
            instrument_id: p.instrument_id,
            price_date:    p.price_date,
            price:         Number(p.price),
          })
        }
      }
    }
  }

  // Cost-basis resolver for TRANSFER_IN rows. Returns 0 if no cost
  // contribution should be made (in which case caller must NOT add
  // to cost_qty_sum either).
  function resolveTransferInCost(tx: TxRow): number {
    // (A) Synth rows always use stored price.
    if (isSynth(tx.external_ref)) {
      return Number(tx.price ?? 0)
    }

    // (B) Reconciliation / manual rows: market_prices first, fallback chain.
    if (tx.instrument_id && tx.trade_date) {
      // 1. Exact match
      const exactKey = `${tx.instrument_id}|${tx.trade_date}`
      if (exactPriceMap.has(exactKey)) {
        return exactPriceMap.get(exactKey)!
      }

      // 2. Nearest prior
      const history = allPricesByInstrument.get(tx.instrument_id)
      if (history && history.length > 0) {
        // history is sorted descending by price_date — find first row
        // whose price_date <= tx.trade_date
        for (const p of history) {
          if (p.price_date <= tx.trade_date) {
            return p.price
          }
        }
      }
    }

    // 3. Last resort: row's stored price
    if (tx.price !== null && tx.price !== undefined && Number(tx.price) > 0) {
      return Number(tx.price)
    }

    // 4. Nothing usable.
    return 0
  }

  // ── 4. Determine as_of_date from latest market_prices row ────
  const { data: latestPrice, error: lpErr } = await db
    .from('market_prices')
    .select('price_date')
    .order('price_date', { ascending: false })
    .limit(1)
    .single()

  const asOfDate: string =
    !lpErr && latestPrice?.price_date
      ? latestPrice.price_date
      : new Date().toISOString().slice(0, 10)

  // ── 5. Aggregate per instrument_id ───────────────────────────
  // v27aa: cost_qty_sum / cost_qxp_sum (renamed from buy_qty_sum /
  // buy_qxp_sum) since they now include both BUY and TRANSFER_IN
  // contributions.
  type Agg = {
    instrument_id: string
    quantity:      number
    cost_qty_sum:  number
    cost_qxp_sum:  number  // Σ(qty × cost_basis)
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
        quantity:      0,
        cost_qty_sum:  0,
        cost_qxp_sum:  0,
      })
    }
    const agg = aggMap.get(key)!
    const qty = Number(tx.quantity ?? 0)

    switch (tx.action) {
      case 'BUY': {
        const price = Number(tx.price ?? 0)
        agg.quantity     += qty
        agg.cost_qty_sum += qty
        agg.cost_qxp_sum += qty * price
        break
      }
      case 'SELL':
        agg.quantity -= qty
        // SELLs do NOT touch cost_qty_sum / cost_qxp_sum —
        // avg_cost reflects original cost basis, not disposal.
        break
      case 'TRANSFER_IN': {
        agg.quantity += qty
        // v27aa: category-aware cost basis. resolveTransferInCost
        // returns 0 if no cost source could be determined (in which
        // case the row contributes quantity but not cost).
        const cost = resolveTransferInCost(tx)
        if (cost > 0) {
          agg.cost_qty_sum += qty
          agg.cost_qxp_sum += qty * cost
        }
        break
      }
      case 'TRANSFER_OUT':
        agg.quantity -= qty
        break
      // INCOME, FEE, and any other action are no-ops for holdings.
    }
  }

  // ── 6. Fetch existing holdings for this portfolio ────────────
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

  // ── 7. Decide upserts vs deletes ─────────────────────────────
  const upsertRows: any[] = []
  const deleteIds: string[] = []

  for (const agg of aggMap.values()) {
    if (agg.quantity > 0) {
      const instrument = instrumentsMap.get(agg.instrument_id)
      if (!instrument) {
        result.errors.push(
          `instrument ${agg.instrument_id} missing from instruments master — skipping holding`
        )
        continue
      }
      // v27aa: avg_cost from cost_qxp_sum / cost_qty_sum. If no cost
      // source resolved for any row contributing to this position,
      // avg_cost is 0 (preserved fallback behavior — but should be
      // rare now that TRANSFER_IN contributes via market_prices).
      const avgCost =
        agg.cost_qty_sum > 0 ? agg.cost_qxp_sum / agg.cost_qty_sum : 0

      upsertRows.push({
        portfolio_id,
        instrument_id: agg.instrument_id,
        sleeve_id:     instrument.sleeve_id,
        quantity:      agg.quantity,
        avg_cost:      avgCost,
        as_of_date:    asOfDate,
      })
    } else {
      if (existingIds.has(agg.instrument_id)) {
        deleteIds.push(agg.instrument_id)
      }
    }
  }

  for (const existingId of existingIds) {
    if (!aggMap.has(existingId) && !deleteIds.includes(existingId)) {
      deleteIds.push(existingId)
    }
  }

  // ── 8. Execute ───────────────────────────────────────────────
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
