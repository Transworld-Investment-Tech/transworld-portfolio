/**
 * lib/cash.ts — v27ag
 *
 * Single source of truth for cash bookkeeping. Cash is derived from the
 * transaction series. Three exports:
 *
 *   applyCashEvent(currentCash, t)  - reducer over a single transaction
 *   computeCashBalance(transactions) - walk the full transaction series
 *   computeNAVWithCash(holdings, transactions) - share NAV + cash, with
 *     CASH_NGN holdings filtered out to avoid double-counting against
 *     the accumulator below
 *
 * THE IN-KIND RULE
 * ────────────────
 * Recovery-account portfolios (ADE-D, DON-C, OPC-A, etc.) and the variance-
 * panel reconciliation flow both produce TRANSFER_IN/TRANSFER_OUT rows
 * tagged with an instrument_id and a quantity, representing in-kind share
 * movements (not cash). A naive cash accumulator that treats every
 * TRANSFER_IN as a cash inflow overstates cash by the value of those in-
 * kind shares.
 *
 * For ADE-D this is a ~₦111M overstatement (24 reconciliation TRANSFER_IN
 * rows totalling 110.9M); for DON-C the synth path stamps these too but
 * the smaller portfolio amplifies less. The rule below is exhaustive
 * across every TRANSFER row pattern observed in production:
 *
 *   instrument_id IS NULL              → real cash event
 *   instrument_id = 'CASH_NGN'         → real cash event (legacy import)
 *   instrument_id is anything else     → in-kind shares, no cash impact
 *
 * The CASH_NGN carve-out matters because the legacy DON-C import (and
 * earlier import scripts) used CASH_NGN as a sentinel instrument_id on
 * deposit/withdrawal/fee rows. We must continue to treat those as cash.
 *
 * ACTION-BY-ACTION
 * ────────────────
 *
 *   BUY (non-CASH_NGN):
 *     cash -= gross_value (or qty × price + fees if gross_value missing)
 *
 *   BUY of CASH_NGN (rare; cash deposit recorded as a BUY):
 *     cash += gross_value || amount || qty × price
 *
 *   SELL (non-CASH_NGN):
 *     cash += gross_value (or qty × price - fees if gross_value missing)
 *     gross_value on SELLs is the broker-side post-fee credit per
 *     statements, so we trust it as-is.
 *
 *   SELL of CASH_NGN (rare):
 *     cash -= gross_value || amount || qty × price
 *
 *   FEE: cash -= amount  (instrument_id may be NULL or CASH_NGN)
 *
 *   TRANSFER_IN with cash-eligible instrument_id (NULL or CASH_NGN):
 *     cash += amount
 *
 *   TRANSFER_IN with share instrument_id:
 *     cash impact = 0 (in-kind shares — share-side accounting only)
 *
 *   TRANSFER_OUT mirrors TRANSFER_IN (with sign flipped).
 *
 *   INCOME: cash += amount  (dividends, INCOME-tagged events)
 *
 * CASH_NGN HOLDING ROWS
 * ─────────────────────
 * Some portfolios (DON-C and others using the legacy import path) carry
 * a CASH_NGN row in the holdings cache representing cash as a "holding"
 * with quantity = cash_balance and avg_cost = 1.0. This pre-dates the
 * v27ag cash accumulator. To prevent double-counting (cash recorded as
 * both a CASH_NGN holding AND through the transaction walk),
 * computeNAVWithCash filters CASH_NGN out of the holdings array before
 * delegating to computeNAV. Same exclusion lives in nav-reconstruct.ts
 * via this same module.
 *
 * Existing computeNAV in lib/portfolio.ts is intentionally NOT changed.
 * Its callers that should display TRUE NAV switch to computeNAVWithCash;
 * callers that should display share-only NAV continue to use computeNAV.
 */

import { Holding, computeNAV } from './portfolio'

// Transactions can come from various sources (live Supabase rows, broker
// imports, in-memory test fixtures), so we accept a structural shape
// rather than the full Transaction interface — this lets us walk
// transactions before they've been narrowed by the loader.
export interface CashTxnLike {
  action?:        string | null
  instrument_id?: string | null
  quantity?:      number | string | null
  price?:         number | string | null
  gross_value?:   number | string | null
  amount?:        number | string | null
  fees?:          number | string | null
}

const num = (v: unknown): number => {
  if (v === null || v === undefined) return 0
  const n = typeof v === 'number' ? v : Number(v)
  return isFinite(n) ? n : 0
}

// Returns true when an instrument_id should be treated as cash-eligible
// (i.e. cash event flows through). NULL or CASH_NGN qualify; share
// tickers do not.
function isCashEligibleId(id: string | null | undefined): boolean {
  if (id === null || id === undefined || id === '') return true
  if (id === 'CASH_NGN') return true
  return false
}

/**
 * Reducer step. Returns the new cash balance after applying transaction t
 * to currentCash. Pure function; no I/O.
 */
export function applyCashEvent(currentCash: number, t: CashTxnLike): number {
  const action     = (t.action ?? '').toString().toUpperCase()
  const id         = (t.instrument_id ?? null) as string | null
  const qty        = num(t.quantity)
  const price      = num(t.price)
  const grossValue = num(t.gross_value)
  const amount     = num(t.amount)
  const fees       = num(t.fees)

  switch (action) {
    case 'BUY': {
      if (id === 'CASH_NGN') {
        // Cash deposit recorded as BUY — cash up
        const credit = grossValue > 0 ? grossValue : (amount > 0 ? amount : qty * price)
        return currentCash + credit
      }
      // Standard share purchase — cash down
      // Trust gross_value if present (post-fee debit per broker statements),
      // else fall back to qty*price + fees.
      const debit = grossValue > 0 ? grossValue : (qty * price + fees)
      return currentCash - debit
    }
    case 'SELL': {
      if (id === 'CASH_NGN') {
        const debit = grossValue > 0 ? grossValue : (amount > 0 ? amount : qty * price)
        return currentCash - debit
      }
      // Standard share sale — cash up. gross_value is broker-side post-fee
      // credit; if absent fall back to qty*price - fees.
      const credit = grossValue > 0 ? grossValue : Math.max(0, qty * price - fees)
      return currentCash + credit
    }
    case 'FEE': {
      // FEE rows are unconditionally cash debits regardless of how
      // instrument_id was populated by the importer.
      return currentCash - amount
    }
    case 'TRANSFER_IN': {
      // The in-kind rule: only fires when instrument_id is cash-eligible
      if (isCashEligibleId(id)) return currentCash + amount
      return currentCash
    }
    case 'TRANSFER_OUT': {
      if (isCashEligibleId(id)) return currentCash - amount
      return currentCash
    }
    case 'INCOME': {
      // Dividends paid into the brokerage account. Treat as cash inflow
      // regardless of instrument_id (often set to the paying security).
      return currentCash + amount
    }
    default:
      return currentCash
  }
}

/**
 * Walk a full transaction series and compute the resulting cash balance.
 * Transactions are assumed to be in chronological order (or order-
 * independent — the operations are all linear additions/subtractions so
 * the result is order-invariant).
 */
export function computeCashBalance(transactions: CashTxnLike[] | null | undefined): number {
  if (!transactions || transactions.length === 0) return 0
  let cash = 0
  for (const t of transactions) {
    cash = applyCashEvent(cash, t)
  }
  return cash
}

/**
 * Cash-aware NAV: share value (excluding the legacy CASH_NGN holding,
 * which would otherwise double-count against the cash accumulator) plus
 * cash balance derived from the transaction series.
 *
 * Drop-in replacement for computeNAV(holdings) at any callsite that
 * should display the TRUE portfolio NAV including cash.
 */
export function computeNAVWithCash(
  holdings: Holding[],
  transactions: CashTxnLike[] | null | undefined
): number {
  const realHoldings = (holdings ?? []).filter(h => h.instrument_id !== 'CASH_NGN')
  return computeNAV(realHoldings) + computeCashBalance(transactions)
}
