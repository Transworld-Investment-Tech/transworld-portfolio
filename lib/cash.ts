/**
 * Cash-aware NAV reducer (v27ag → v27ah → v27ai → v27ak).
 *
 * Single source of truth for cash math across the application.
 *
 * Sign convention by action:
 *   BUY:          cash -= (principal + fees)        [v27ah]
 *   SELL:         cash += (principal - fees)        [v27ah]
 *   FEE:          cash -= feeAmount                 [v27ai column-fallback]
 *   TRANSFER_IN:  cash += amount  if cash-eligible  [v27ag in-kind rule]
 *   TRANSFER_OUT: cash -= amount  if cash-eligible  [v27ag in-kind rule]
 *   INCOME: cash += amount        [unchanged]
 */

import { Holding, computeNAV } from './portfolio'

export interface CashTxnLike {
  action?:        string | null
  instrument_id?: string | null
  quantity?:      number | string | null
  price?:         number | string | null
  gross_value?:   number | string | null
  amount?:        number | string | null
  fees?:          number | string | null
  notes?:         string | null  // v27aw-fix3: in-kind detection via marker string
}

/**
 * v27ak: Component breakdown of cash-aware NAV. Allows callsites to
 * display Securities NAV and Cash NAV as first-class panels rather
 * than only the combined total. Total field stays bit-identical to
 * the legacy `computeNAVWithCash` return value.
 */
export interface NAVComponents {
  shareValue: number  // value of non-cash holdings (excludes legacy CASH_NGN row)
  cash:       number  // cash balance derived from transaction series
  total:      number  // shareValue + cash; same as computeNAVWithCash()
}

const num = (v: unknown): number => {
  if (v === null || v === undefined) return 0
  const n = typeof v === 'number' ? v : Number(v)
  return isFinite(n) ? n : 0
}

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
        // Cash deposit recorded as BUY — no broker fees, principal is the cash credit
        const credit = grossValue > 0 ? grossValue : (amount > 0 ? amount : qty * price)
        return currentCash + credit
      }
      // v27aw-fix3: in-kind seed positions added via the Holdings page
      // "Add Position" UI must NOT debit cash. Those rows represent in-kind
      // transfers (the security existed before; we're recording it for
      // tracking), not cash purchases. Pre-fix3 the cash equation counted
      // them as cash debits, leaving portfolios seeded entirely in-kind
      // (CKNET-A, CKNET-B) with cash = −starting_nav permanently. The
      // Holdings page writes a stable notes marker; detect via that string.
      // No schema change required.
      const notes = (t.notes ?? '').toString()
      if (notes.includes('Added via Holdings page')) {
        return currentCash
      }
      // v27ah: principal + fees. principal = qty × price (= gross_value
      // by importer convention). Trust gross_value when present, fall
      // back to qty × price; ALWAYS add fees on top.
      const principal = grossValue > 0 ? grossValue : qty * price
      return currentCash - principal - fees
    }
    case 'SELL': {
      if (id === 'CASH_NGN') {
        // Cash withdrawal recorded as SELL — no broker fees, principal is cash debit
        const debit = grossValue > 0 ? grossValue : (amount > 0 ? amount : qty * price)
        return currentCash - debit
      }
      // v27ah: principal − fees. Symmetric correction.
      const principal = grossValue > 0 ? grossValue : qty * price
      return currentCash + principal - fees
    }
    case 'FEE': {
      // v27ai (#119): tolerate CRUD column reshuffles that left `amount` zeroed.
      // First non-zero candidate wins — NEVER sums (no double-counting).
      // Precedence: amount → fees → fee_management → fee_other → gross_value.
      // Standalone management fee / demat fee / etc. cash debit.
      const feeAmount = amount     > 0 ? amount
                      : fees       > 0 ? fees
                      : num((t as any).fee_management) > 0 ? num((t as any).fee_management)
                      : num((t as any).fee_other)      > 0 ? num((t as any).fee_other)
                      : grossValue > 0 ? grossValue
                      : 0
      return currentCash - feeAmount
    }
    case 'TRANSFER_IN': {
      // In-kind rule: only cash-eligible instrument_ids fire
      if (isCashEligibleId(id)) return currentCash + amount
      return currentCash
    }
    case 'TRANSFER_OUT': {
      if (isCashEligibleId(id)) return currentCash - amount
      return currentCash
    }
    case 'INCOME': {
      // Dividends paid into the brokerage account
      return currentCash + amount
    }
    default:
      return currentCash
  }
}

/**
 * Walk a full transaction series and compute the resulting cash balance.
 * Order-invariant — operations are linear additions/subtractions.
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
 * v27ak: Component breakdown of cash-aware NAV.
 *
 * Returns share value, cash balance, and combined total as discrete fields.
 * Use this when the UI needs to display Securities and Cash as separate panels.
 *
 * Total is bit-identical to computeNAVWithCash() return — same filter, same math.
 */
export function computeNAVComponents(
  holdings: Holding[],
  transactions: CashTxnLike[] | null | undefined
): NAVComponents {
  const realHoldings = (holdings ?? []).filter(h => h.instrument_id !== 'CASH_NGN')
  const shareValue   = computeNAV(realHoldings)
  const cash         = computeCashBalance(transactions)
  return { shareValue, cash, total: shareValue + cash }
}

/**
 * Cash-aware NAV: share value (excluding the legacy CASH_NGN holding)
 * plus cash balance derived from the transaction series.
 *
 * Drop-in replacement for computeNAV(holdings) at any callsite that
 * should display the TRUE portfolio NAV including cash.
 *
 * v27ak: refactored to a thin wrapper around computeNAVComponents.
 * Behaviour bit-identical to the v27ai implementation across all 5 callsites.
 */
export function computeNAVWithCash(
  holdings: Holding[],
  transactions: CashTxnLike[] | null | undefined
): number {
  return computeNAVComponents(holdings, transactions).total
}
