/**
 * lib/cash.ts — v27ai
 *
 * v27ai change: FEE branch column-fallback chain (pitfall #119).
 *
 * The v27ah FEE branch read `amount` only:
 *   case 'FEE': return currentCash - amount
 *
 * This was correct for the common case but silently zeroed cash impact
 * when a CRUD edit reshuffled values from `amount` into one of the
 * breakdown columns (`fees`, `fee_management`, `fee_other`). Concrete
 * v27ah-session instance: ADE-D 22-Jan-2024 FEE row id=d8c4d308...
 * had amount=NULL after a CRUD reclassification, leaving ₦9.87M of
 * fee debit invisible to the cash-aware NAV reducer.
 *
 * v27ai fix: the FEE branch now falls through a precedence chain,
 * taking the FIRST non-zero candidate as the fee debit:
 *
 *   amount → fees → fee_management → fee_other → gross_value → 0
 *
 * Behaviour is IDENTICAL to v27ah whenever `amount` is populated
 * (the common case). Fallback only fires when `amount` has been
 * zeroed by an edit. NEVER sums — first match wins, no double-
 * counting risk by construction.
 *
 * Sub-rule (#119 sub-rule): when a single column's null-vs-populated
 * state determines whether cash math fires, that column must be
 * either (a) NOT NULL by schema, (b) protected by UI guardrails, or
 * (c) made fallback-tolerant in code. v27ai chooses option (c).
 *
 * ───────────────────────────────────────────────────────────────────
 * v27ah change (preserved): BUY/SELL cash math corrected. The v27ag
 * implementation trusted `gross_value` as a post-fee net amount, but
 * in this schema the importer populates `gross_value` as the PRE-fee
 * principal (= quantity × price). The trade fees live in a separate
 * `fees` column (or in the breakdown columns: fee_commission,
 * fee_vat, fee_exchange, fee_clearing, fee_sec, fee_contract_stamp,
 * fee_sms).
 *
 * Concrete failure on DON-C:
 *   App cash post-v27ag:          ₦11,805,017.13
 *   Canonical broker statement:   ₦ 7,439,622.43
 *   Overstatement:                ₦ 4,365,394.70
 *
 * Decomposition of the gap:
 *   - SELL fees not deducted:     ₦1,970,330.54
 *   - BUY  fees not added:        ₦1,433,196.50
 *   - NIBSS pass-through debit:   ₦  961,867.66  (parser fix in v27aj)
 *
 * Symmetric corrected rule:
 *   BUY  → cash -= principal + fees   (pay for shares, plus pay broker)
 *   SELL → cash += principal − fees   (receive proceeds, less broker fees)
 *   where principal = qty × price (or gross_value if non-zero — they
 *   are equal in this schema, gross_value being qty × price by
 *   importer convention)
 *
 * THE IN-KIND RULE (preserved from v27ag)
 * ────────────────────────────────────────
 *   instrument_id IS NULL              → real cash event
 *   instrument_id = 'CASH_NGN'         → real cash event (legacy import)
 *   instrument_id is anything else     → in-kind shares, no cash impact
 *
 * (CASH_NGN BUY/SELL paths preserved for the legacy DON-C-style
 *  importer pattern — when CASH_NGN is the instrument the row is a
 *  cash deposit/withdrawal recorded as a trade, and the principal IS
 *  the cash amount with no separate broker fees.)
 *
 * ACTION-BY-ACTION (post-v27ai)
 * ─────────────────────────────
 *
 *   BUY (non-CASH_NGN):
 *     cash -= principal + fees    [v27ah]
 *
 *   BUY of CASH_NGN (cash deposit recorded as BUY):
 *     cash += principal           [no fees on cash deposits]
 *
 *   SELL (non-CASH_NGN):
 *     cash += principal − fees    [v27ah]
 *
 *   SELL of CASH_NGN (cash withdrawal recorded as SELL):
 *     cash -= principal           [no fees on cash withdrawals]
 *
 *   FEE: cash -= feeAmount        [v27ai: fallback chain
 *                                  amount → fees → fee_management
 *                                  → fee_other → gross_value]
 *
 *   TRANSFER_IN with cash-eligible instrument_id:
 *     cash += amount              [unchanged]
 *
 *   TRANSFER_IN with share instrument_id:
 *     cash impact = 0             [unchanged — in-kind rule]
 *
 *   TRANSFER_OUT mirrors TRANSFER_IN.
 *
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
 * Cash-aware NAV: share value (excluding the legacy CASH_NGN holding)
 * plus cash balance derived from the transaction series.
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
