/**
 * lib/portfolio-metadata.ts — v27i
 *
 * v27i change: Replaced the single-line `startingNav = cashOnDay + positionValue`
 * with conservation-of-value logic. The old formulation hit a degenerate case
 * for any portfolio whose day-1 events were pure BUYs (no same-day TRANSFER_IN
 * cash): cashOnDay = -grossValue, positionValue = +grossValue, sum = 0 →
 * safeNav fallback to 1. This was visible after v27h's "always re-infer"
 * landed: DON A's 21.48M starting_nav got overwritten with 1 because its
 * earliest date (2020-07-23) had BUYs without an explicit cash transfer.
 *
 * The new logic:
 *   starting_nav = max(preDayNav, postDayNav)
 * where:
 *   preDayNav = preDayCashFloor + preDayPositionValue
 *     preDayCashFloor   = max(0, -cashOnDay)  // min cash that had to exist pre-day to fund net outflow
 *     preDayPositionValue = sum over instruments where SELL/TRANSFER_OUT today implies pre-day shares
 *   postDayNav = postDayCash + postDayPositionValue
 *     postDayCash        = max(0, cashOnDay)
 *     postDayPositionValue = current EOD positions (sum of netQtyAfter × price)
 *
 * Walks through correctly for every case observed in the production data:
 *   - BUY-only day:        pre-day cash = grossValue, post-day position = grossValue → max ✓
 *   - TRANSFER_IN cash:    post-day cash = amount → ✓
 *   - SELL pre-history:    pre-day position = qty × sale price → ✓ (matches user's stated rule)
 *   - Mixed BUY+TRANSFER_IN: post-day NAV captures total injected → ✓
 *   - SELL+BUY same day:   conservation makes both sides equal → ✓
 *
 * The safeNav = 1 fallback now only triggers in true degenerate cases (e.g.,
 * day with only zero-quantity rows or perfectly-cancelling FEE-against-zero
 * scenarios). Real portfolios won't hit it.
 *
 * v21g-hotfix-1 baseline preserved otherwise: same control flow, same
 * netQtyAfterDay/netQtyBeforeDay tracking, same lastPriceOnDay map, same
 * non-throwing { ok, inferred?, error? } return shape.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface InferredStart {
  start_date: string
  starting_nav: number
  method: string
  earliest_txn_date: string
  position_value: number
  cash_value: number
}

export interface InferResult {
  ok: boolean
  inferred?: InferredStart
  error?: string
}

type TxRow = {
  trade_date: string
  action: string
  instrument_id: string | null
  quantity: number | null
  price: number | null
  gross_value: number | null
  amount: number | null
}

export async function inferPortfolioStart(
  db: SupabaseClient,
  portfolio_id: string
): Promise<InferResult> {
  // ── 1. Fetch all transactions in chronological order ─────────
  const { data: txs, error: txErr } = await db
    .from('transactions')
    .select('trade_date, action, instrument_id, quantity, price, gross_value, amount')
    .eq('portfolio_id', portfolio_id)
    .order('trade_date', { ascending: true })

  if (txErr) {
    return { ok: false, error: `transactions query: ${txErr.message}` }
  }

  const transactions = (txs || []) as TxRow[]
  if (transactions.length === 0) {
    return { ok: false, error: 'No transactions — cannot infer start metadata' }
  }

  const earliestDate = transactions[0].trade_date

  // ── 2. Filter to earliest-day transactions ───────────────────
  const onEarliest = transactions.filter((t) => t.trade_date === earliestDate)

  // ── 3. Build state for the earliest day ──────────────────────
  //
  // netQtyAfterDay[i]  = net qty held at close of day for instrument i
  //                     (can go negative if SELL exceeds same-day BUYs;
  //                     we clamp to 0 when computing post-day position value)
  //
  // netQtyBeforeDay[i] = minimum implied pre-day qty (set when SELL or
  //                     TRANSFER_OUT on day 1 implies pre-existing shares)
  //
  // lastPriceOnDay[i]  = last price observed for instrument i today
  //                     (used for marking pre-day positions to market)
  //
  // cashOnDay          = net cash flow from day's events
  //                     (+ TRANSFER_IN amount, + SELL grossValue,
  //                      − TRANSFER_OUT amount, − BUY grossValue, − FEE amount)

  const netQtyAfterDay  = new Map<string, number>()
  const netQtyBeforeDay = new Map<string, number>()
  const lastPriceOnDay  = new Map<string, number>()
  let   cashOnDay       = 0

  for (const tx of onEarliest) {
    const qty        = tx.quantity ?? 0
    const price      = tx.price ?? 0
    const grossValue = tx.gross_value ?? (qty * price)
    const amount     = tx.amount ?? 0

    if (tx.instrument_id) {
      const before = netQtyBeforeDay.get(tx.instrument_id) ?? 0
      const after  = netQtyAfterDay.get(tx.instrument_id) ?? 0

      if (price > 0) {
        lastPriceOnDay.set(tx.instrument_id, price)
      }

      switch (tx.action) {
        case 'BUY':
          netQtyAfterDay.set(tx.instrument_id, after + qty)
          cashOnDay -= grossValue
          break
        case 'SELL':
          netQtyAfterDay.set(tx.instrument_id, after - qty)
          netQtyBeforeDay.set(tx.instrument_id, Math.max(before, qty))
          cashOnDay += grossValue
          break
        case 'TRANSFER_IN':
          netQtyAfterDay.set(tx.instrument_id, after + qty)
          break
        case 'TRANSFER_OUT':
          netQtyAfterDay.set(tx.instrument_id, after - qty)
          netQtyBeforeDay.set(tx.instrument_id, Math.max(before, qty))
          break
      }
    } else {
      // Instrument-less cash events
      switch (tx.action) {
        case 'TRANSFER_IN':  cashOnDay += amount; break
        case 'TRANSFER_OUT': cashOnDay -= amount; break
        case 'FEE':          cashOnDay -= amount; break
      }
    }
  }

  // ── 4. v27i: Conservation-of-value NAV computation ────────────
  //
  // Old (degenerate for BUY-only day 1):
  //   startingNav = cashOnDay + positionValue
  //
  // New: starting_nav = max(preDayNav, postDayNav)
  //
  // For a clean rebalancing day (BUY funded by SELL), pre and post are
  // equal — the day shifts assets between cash and shares, total value
  // conserved. For TRANSFER_IN days, post > pre (capital injected). For
  // TRANSFER_OUT/FEE days, pre > post (capital removed). Max captures the
  // value that participated in inception either way.

  // EOD position value: positions held at close of day
  let postDayPositionValue = 0
  for (const [instrId, qtyAfter] of netQtyAfterDay.entries()) {
    if (qtyAfter <= 0) continue
    const price = lastPriceOnDay.get(instrId) ?? 0
    postDayPositionValue += qtyAfter * price
  }

  // SOD position value: positions implied to have existed pre-day
  // (instruments with same-day SELL or TRANSFER_OUT)
  let preDayPositionValue = 0
  for (const [instrId, qtyBefore] of netQtyBeforeDay.entries()) {
    if (qtyBefore <= 0) continue
    const price = lastPriceOnDay.get(instrId) ?? 0
    preDayPositionValue += qtyBefore * price
  }

  // SOD cash floor: minimum cash that had to exist pre-day to fund a net
  // outflow. If day has more outflow than inflow, pre-day cash must cover
  // the gap. If day has more inflow, pre-day cash floor is 0.
  const preDayCashFloor = Math.max(0, -cashOnDay)

  // EOD cash: assuming the minimum pre-day cash, what's left after the day
  const postDayCash = Math.max(0, cashOnDay)

  const preDayNav  = preDayCashFloor + preDayPositionValue
  const postDayNav = postDayCash + postDayPositionValue
  const startingNav = Math.max(preDayNav, postDayNav)

  // ── 5. Method label (for logging/audit trail) ────────────────
  const hasPreHistoryPositions = preDayPositionValue > 0
  const hasEodPositions        = postDayPositionValue > 0
  const hasNetInflow           = cashOnDay > 0
  const hasNetOutflow          = cashOnDay < 0

  let method: string
  if (hasPreHistoryPositions && hasEodPositions) {
    method = `mixed: pre-history + EOD positions on ${earliestDate}`
  } else if (hasPreHistoryPositions) {
    method = `pre-history positions mark-to-market on ${earliestDate}`
  } else if (hasEodPositions && hasNetInflow) {
    method = `positions + net inflow on ${earliestDate}`
  } else if (hasEodPositions && hasNetOutflow) {
    method = `BUY funded by pre-existing cash on ${earliestDate}`
  } else if (hasEodPositions) {
    method = `positions only (clean inception) on ${earliestDate}`
  } else if (hasNetInflow) {
    method = `cash inflow only on ${earliestDate}`
  } else if (hasNetOutflow) {
    method = `cash outflow against pre-existing cash on ${earliestDate}`
  } else {
    method = `degenerate: zero net activity on ${earliestDate}`
  }

  // True-degenerate guard: only triggers when both pre and post NAV are 0,
  // which requires day 1 to have only zero-quantity transactions or
  // perfectly-cancelling cash events with no positions. Real portfolios
  // shouldn't hit this.
  const safeNav = startingNav > 0 ? startingNav : 1

  return {
    ok: true,
    inferred: {
      start_date:        earliestDate,
      starting_nav:      safeNav,
      method,
      earliest_txn_date: earliestDate,
      position_value:    postDayPositionValue,
      cash_value:        cashOnDay,
    },
  }
}
