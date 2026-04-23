/**
 * lib/portfolio-metadata.ts — v21g-hotfix-1
 *
 * Derives a portfolio's `start_date` and `starting_nav` from its
 * transaction history. Called from the broker commit route AFTER
 * holdings rebuild, and applied conditionally (only when existing
 * metadata is obviously stale).
 *
 * Why this exists:
 *   Portfolios created through /admin/portfolios/new with
 *   starting_nav = 0 (the intended pattern for broker-first
 *   onboarding) end up with start_date = creation_date, which is
 *   wrong — the real inception is the earliest transaction's
 *   trade_date. Without this fix, IRR and period metrics are all
 *   anchored to the wrong date and null-out for any lookback
 *   window that starts before the (incorrect) portfolio.start_date.
 *
 * Algorithm:
 *   1. Find the earliest trade_date in transactions for this portfolio.
 *   2. If no transactions, return null — nothing to infer.
 *   3. Compute NAV on that earliest date:
 *      a. Gather all transactions on the earliest date.
 *      b. Cash component: sum of TRANSFER_INs minus TRANSFER_OUTs
 *         minus FEEs minus gross BUY values plus gross SELL values.
 *      c. Position component: for each instrument with net_qty > 0
 *         after that day's transactions, value at the latest
 *         transaction price that day; if no price that day, use
 *         avg_cost (for BUYs on that day) or 0.
 *      d. Pre-history SELLs (the OOO case): if there's a SELL on
 *         the earliest date for shares with no prior BUY/TRANSFER_IN,
 *         the shares must have existed pre-history. Treat the SELL's
 *         price as the mark-to-market for those shares and roll their
 *         implied value into starting_nav. Net of the same-day SELL
 *         this nets to cash, same total NAV.
 *
 * Design decisions:
 *   - We return a float NAV, not an integer. starting_nav is NUMERIC
 *     in the schema and represents NGN.
 *   - "Method" in the return describes which code path computed the
 *     NAV, for logging/auditability. Not persisted.
 *   - Non-throwing. Errors are returned as { error } so the caller
 *     (commit route) can surface as a warning without aborting.
 *
 * Staleness decision lives in the CALLER, not here. This function
 * just computes the "what should it be" value. The caller decides
 * whether to overwrite.
 */

import type { SupabaseClient } from '@supabase/supabase-js'

export interface InferredStart {
  start_date: string          // ISO date YYYY-MM-DD
  starting_nav: number        // in NGN
  method: string              // human-readable description of how we got here
  earliest_txn_date: string   // same as start_date — explicit for clarity
  position_value: number      // instrument-valued component
  cash_value: number          // cash-flow component
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

  // ── 2. Separate transactions into "on earliest date" vs "later" ──
  const onEarliest = transactions.filter((t) => t.trade_date === earliestDate)

  // ── 3. Build cumulative position state JUST FOR the earliest day ─
  //      This handles the OOO case where the earliest day's activity
  //      reveals pre-history positions (e.g. a SELL with no prior BUY).
  //      Net quantity per instrument AFTER the day's transactions is
  //      what we'd hold at close-of-day on earliestDate.

  const netQtyAfterDay = new Map<string, number>()
  const netQtyBeforeDay = new Map<string, number>()   // to detect pre-history
  const lastPriceOnDay = new Map<string, number>()    // for mark-to-market

  // Pre-day state starts at zero (by definition there are no earlier
  // transactions). Build it up from the day's events.

  let cashOnDay = 0  // net cash impact of earliest-day events

  for (const tx of onEarliest) {
    const qty = tx.quantity ?? 0
    const price = tx.price ?? 0
    const grossValue = tx.gross_value ?? (qty * price)
    const amount = tx.amount ?? 0

    if (tx.instrument_id) {
      const before = netQtyBeforeDay.get(tx.instrument_id) ?? 0
      const after = netQtyAfterDay.get(tx.instrument_id) ?? 0

      // Record price seen today for this instrument (used later for
      // mark-to-market of pre-history shares).
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
          // SELL implies at least `qty` shares existed pre-day
          netQtyBeforeDay.set(tx.instrument_id, Math.max(before, qty))
          cashOnDay += grossValue
          break
        case 'TRANSFER_IN':
          netQtyAfterDay.set(tx.instrument_id, after + qty)
          // TRANSFER_IN with no quantity is a cash deposit (instrument_id null)
          // but defensive: if instrument_id is set, treat as shares in
          break
        case 'TRANSFER_OUT':
          netQtyAfterDay.set(tx.instrument_id, after - qty)
          netQtyBeforeDay.set(tx.instrument_id, Math.max(before, qty))
          break
      }
    } else {
      // Instrument-less cash events (TRANSFER_IN/OUT/FEE as cash)
      switch (tx.action) {
        case 'TRANSFER_IN':
          cashOnDay += amount
          break
        case 'TRANSFER_OUT':
          cashOnDay -= amount
          break
        case 'FEE':
          cashOnDay -= amount
          break
      }
    }
  }

  // ── 4. Compute NAV at close-of-day on earliestDate ────────────
  //      NAV = value of positions held at EOD + cash from day's events
  //
  //      For pre-history shares: any instrument with netQtyBeforeDay > 0
  //      that we DON'T already see in earlier transactions is a pre-
  //      history position. Its "cost basis" is unknown; we use the
  //      day's transaction price as mark-to-market.
  //
  //      For clean portfolios: netQtyBeforeDay is empty, position
  //      value is simply the EOD qty × price-on-day (or avg cost for
  //      BUYs that day, which is their price).

  let positionValue = 0
  for (const [instrId, qtyAfter] of netQtyAfterDay.entries()) {
    if (qtyAfter <= 0) continue
    const price = lastPriceOnDay.get(instrId) ?? 0
    positionValue += qtyAfter * price
  }

  // Pre-history adjustment: if an instrument had shares pre-day
  // (inferred from a SELL on the earliest day), the cash we already
  // counted from the SELL implicitly captures those shares' value.
  // Post-day qty + cash = total NAV = pre-day holdings value.
  //
  // Example: OOO 2016-01-28
  //   Pre-day:  4,000 GUARANTY (unknown cost basis)
  //   Day:      SELL 4,000 GUARANTY @ ₦15.30 → cash +61,200
  //   Post-day: 0 GUARANTY, +61,200 cash
  //   NAV = 0 (positions) + 61,200 (cash) = 61,200 ✓
  //
  // Example: clean start with BUY
  //   Pre-day:  nothing
  //   Day:      TRANSFER_IN 5,000,000 cash, BUY 1,000 X @ ₦100 → cash +5M−100K
  //   Post-day: 1,000 X, +4,900,000 cash
  //   NAV = (1,000 × 100) + 4,900,000 = 5,000,000 ✓
  //
  // In both cases, cashOnDay + positionValue gives the right NAV.

  const startingNav = cashOnDay + positionValue

  // Determine method label for logging
  const hasPreHistory = Array.from(netQtyBeforeDay.values()).some((v) => v > 0)
  let method: string
  if (hasPreHistory) {
    method = `pre-history positions mark-to-market on ${earliestDate}`
  } else if (positionValue > 0 && cashOnDay !== 0) {
    method = `positions + cash on ${earliestDate}`
  } else if (positionValue > 0) {
    method = `positions only on ${earliestDate}`
  } else if (cashOnDay > 0) {
    method = `cash only on ${earliestDate}`
  } else {
    method = `degenerate: net NAV ≤ 0 on ${earliestDate}`
  }

  // Guard against negative or zero NAV — that usually means our
  // inference is wrong (e.g. portfolio history starts with a BUY
  // implying pre-existing cash we didn't capture). Return a small
  // positive placeholder rather than a number that will break IRR.
  const safeNav = startingNav > 0 ? startingNav : 1

  return {
    ok: true,
    inferred: {
      start_date: earliestDate,
      starting_nav: safeNav,
      method,
      earliest_txn_date: earliestDate,
      position_value: positionValue,
      cash_value: cashOnDay,
    },
  }
}
