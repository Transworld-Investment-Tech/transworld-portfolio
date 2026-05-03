/**
 * lib/fee-calc.ts — v27o-fix1
 *
 * v27o-fix1 change: Period-flow filter now strict on the lower bound.
 * Flows DATED EXACTLY ON the period start are excluded — they're
 * already captured by startNAV.
 *
 * THE BUG IN v27n
 * ───────────────
 * v27n's flow filter was inclusive on startDate:
 *   if (flowDate < startDate || flowDate > endDate) continue
 *
 * Synthetic recovery TRANSFER_IN rows produced by v27o are dated AT
 * portfolio.start_date. inferPortfolioStart already includes those
 * shares' value in starting_nav (via postDayPositionValue). With the
 * old filter, fee-calc then ALSO added them as period flows — double-
 * counting.
 *
 * Concrete failure on DON-C ITD (post v27o, pre v27o-fix1):
 *   startNAV (incl. synth)        = ₦41.54M
 *   Period flows (incl. synth)    = +₦22.97M − ₦1.43M
 *   contributedCapital            = ₦64.51M     ← inflated
 *   targetValue at 15%            = ₦143.74M    ← grossly inflated
 *   IRR (ITD)                     = +3.53%      ← nonsense low
 *
 * THE FIX
 * ───────
 * Change the filter to strict-less-than-or-equal on the lower bound:
 *   if (flowDate <= startDate || flowDate > endDate) continue
 *
 * Flows on or before startDate are already accounted for in startNAV
 * (whether by inferPortfolioStart's day-1 valuation or by upstream
 * NAV computation for non-inception periods). Including them as flows
 * is double-counting in every period.
 *
 * Verified semantics across period types:
 *   - ITD: startDate = portfolio.start_date. Synth TRANSFER_INs at
 *     start_date are part of starting NAV, not flows. ✓
 *   - YTD/LY/L3Y/L5Y: startDate is a calendar date. Any TRANSFER_IN
 *     happening on that calendar date is part of EOD NAV at that
 *     date, which is the "starting NAV" for the period. ✓
 *
 * METHODOLOGY (preserved from v27n)
 * ─────────────────────────────────
 * Contributed capital is the FACE-VALUE sum of all flows over the period:
 *
 *   contributedCapital = startNAV + Σ TRANSFER_IN − Σ TRANSFER_OUT
 *
 * (No time-weighting on contributed capital itself — this represents the
 * actual net amount of capital the client has put to work.)
 *
 * Target value at end-of-period grows each flow forward at the threshold
 * rate from its flow date to the period end:
 *
 *   targetValue = Σ flow_i × (1 + r)^(years_remaining_i)
 *
 * Standard XIRR-style calculation.
 *
 * EFFECTIVE RETURN
 * ────────────────
 * effectiveReturnPct = (clientFinalValue − contributedCapital) / contributedCapital
 *
 * This is a PERIOD return (total return over the window), not annualized.
 * For annualized return, see lib/analytics.ts → computeIRR (Newton-Raphson).
 */

export interface FeeInput {
  startNAV:       number
  endNAV:         number
  startDate:      Date
  endDate:        Date
  transactions:   Array<{
    trade_date: string
    action:     string
    amount:     number | null
  }>
  thresholdRate:  number   // e.g., 0.15 for 15% p.a.
  clientShare?:   number   // default 0.70
}

export interface FeeOutput {
  contributedCapital:    number   // face-value sum of flows
  yearsInPeriod:         number
  thresholdRate:         number
  targetValue:           number   // Σ flow × (1 + r)^years_remaining
  actualValue:           number   // = endNAV
  excessReturn:          number   // actualValue − targetValue (can be negative)
  belowTarget:           boolean
  clientFee:             number   // 0 if below target
  transworldFee:         number   // 0 if below target
  clientFinalValue:      number   // actualValue − transworldFee
  effectiveReturnPct:    number   // (clientFinalValue − contributedCapital) / contributedCapital
  flows: Array<{
    date:                string
    label:               string
    amount:              number   // signed: + for contribution, − for withdrawal
    yearsRemaining:      number
    futureValueAtTarget: number   // amount × (1 + thresholdRate)^yearsRemaining
  }>
}

const ONE_DAY_MS = 24 * 3600 * 1000
const ONE_YEAR_MS = 365.25 * ONE_DAY_MS

export function computeFeeMetrics(input: FeeInput): FeeOutput {
  const {
    startNAV, endNAV, startDate, endDate, transactions,
    thresholdRate,
  } = input
  const clientShare = input.clientShare ?? 0.70

  const yearsInPeriod = Math.max(
    0,
    (endDate.getTime() - startDate.getTime()) / ONE_YEAR_MS
  )

  const flows: FeeOutput['flows'] = []

  // 1. Beginning NAV — treated as a flow at period start (full-period growth).
  // This is the value the portfolio held going into the period: position
  // values at start, plus same-day transfers and BUYs (per inferPortfolioStart
  // for ITD, or NAV reconstruction for other periods).
  if (startNAV > 0) {
    flows.push({
      date:                startDate.toISOString().slice(0, 10),
      label:               'Beginning NAV',
      amount:              startNAV,
      yearsRemaining:      yearsInPeriod,
      futureValueAtTarget: startNAV * Math.pow(1 + thresholdRate, yearsInPeriod),
    })
  }

  // 2. TRANSFER_IN / TRANSFER_OUT STRICTLY AFTER startDate, on/before endDate.
  //
  // v27o-fix1: Strict inequality on the lower bound (flowDate <= startDate
  // means SKIP). Flows on the period start are already captured in startNAV
  // and would be double-counted if included here. See module header for
  // the v27o → v27o-fix1 bug description.
  for (const t of transactions) {
    if (t.action !== 'TRANSFER_IN' && t.action !== 'TRANSFER_OUT') continue
    const flowDate = new Date(t.trade_date)
    if (flowDate <= startDate || flowDate > endDate) continue

    const amt = Math.abs(Number(t.amount ?? 0))
    if (amt === 0) continue
    const yearsRemaining = Math.max(
      0,
      (endDate.getTime() - flowDate.getTime()) / ONE_YEAR_MS
    )
    const signed = t.action === 'TRANSFER_IN' ? +amt : -amt
    flows.push({
      date:                t.trade_date,
      label:               t.action === 'TRANSFER_IN' ? 'Capital top-up' : 'Capital withdrawal',
      amount:              signed,
      yearsRemaining,
      futureValueAtTarget: signed * Math.pow(1 + thresholdRate, yearsRemaining),
    })
  }

  // 3. Face-value contributed capital (XIRR semantics — flat naira sum).
  const contributedCapital = flows.reduce((s, f) => s + f.amount, 0)

  // 4. Target value = Σ flow_i × (1 + r)^years_remaining_i
  const targetValue = flows.reduce((s, f) => s + f.futureValueAtTarget, 0)

  const actualValue   = endNAV
  const excessReturn  = actualValue - targetValue
  const belowTarget   = excessReturn <= 0

  const clientFee:    number = belowTarget ? 0 : excessReturn * clientShare
  const transworldFee:number = belowTarget ? 0 : excessReturn * (1 - clientShare)

  const clientFinalValue   = actualValue - transworldFee
  const effectiveReturnPct = contributedCapital > 0
    ? (clientFinalValue - contributedCapital) / contributedCapital
    : 0

  return {
    contributedCapital,
    yearsInPeriod,
    thresholdRate,
    targetValue,
    actualValue,
    excessReturn,
    belowTarget,
    clientFee,
    transworldFee,
    clientFinalValue,
    effectiveReturnPct,
    flows,
  }
}

/**
 * For UI display: formats a signed naira number with sign.
 */
export function fmtSignedNGN(n: number): string {
  const sign = n < 0 ? '−' : '+'
  const abs = Math.abs(n)
  return `${sign}₦${abs.toLocaleString('en-GB', { maximumFractionDigits: 0 })}`
}

// ═══════════════════════════════════════════════════════════════
// v27am: Fee architecture dispatcher
// ═══════════════════════════════════════════════════════════════
//
// Per-period fee calculator. Called by lib/hwm-engine.ts for each
// fee period of every portfolio with fee_model != 'none' and
// fee_relationship_start_date set.
//
// Branches on portfolio.fee_model:
//   'fixed_annual'         → fee_earned = fixed_annual_fee_ngn × period_days/365
//   'performance_excess'   → fee on period TWR above (target_return × period_days/365) × split
//   'performance_hwm'      → fee on period_high above adjusted opening HWM × split
//   'performance_combined' → fee on min(period_excess, hwm_excess) × split
//
// Snapshot fields populated to preserve audit trail: when a client
// renegotiates (e.g. switches from performance_excess 15%/20% to
// performance_combined 12%/25%), historical fee_periods retain their
// original calc inputs.
//
// Returns null on coherence failure (e.g. performance_fee_split is null
// for a performance_* mode). Caller logs the reason and skips writing
// the period row.
//
// Coexists with legacy computeFeeMetrics (XIRR-style face-value sum
// preserved unchanged for analytics route + Overview Performance fee
// panel). v27an UI work surfaces dispatcher output in the Overview.
// ═══════════════════════════════════════════════════════════════

export type FeeModel =
  | 'none'
  | 'performance_excess'
  | 'performance_hwm'
  | 'performance_combined'
  | 'fixed_annual'

export interface PeriodFeeInput {
  portfolio: {
    fee_model: FeeModel
    target_return: number              // annualised, decimal (0.15 = 15%)
    performance_fee_split: number | null  // %, e.g. 20 for 20%
    fixed_annual_fee_ngn: number | null
    fee_year_end_md: string
  }
  period_start: Date
  period_end: Date
  opening_nav: number
  closing_nav: number
  contributions: number
  withdrawals: number
  cwa_factor: number | null         // null for non-HWM models
  opening_hwm: number | null        // post-flow-adjustment (HWM-1 applied by engine)
  period_high_nav: number | null    // null for non-HWM models
}

export interface PeriodFeeOutput {
  fee_model_used: FeeModel
  period_days: number
  gross_period_return_pct: number | null
  excess_above_threshold: number | null   // % decimal
  hwm_excess_amount: number | null        // NGN
  qualifying_excess: number | null        // NGN, base for fee × split
  fee_earned: number                       // NGN
  // Snapshots written into fee_periods row for audit trail
  fee_model_snapshot: FeeModel
  performance_fee_threshold_snapshot: number | null
  performance_fee_split_snapshot: number | null
  fixed_annual_fee_ngn_snapshot: number | null
}

const V27AM_MS_PER_DAY = 24 * 3600 * 1000

function v27amPeriodDays(start: Date, end: Date): number {
  // Inclusive both ends. Same-day period = 1 day.
  return Math.max(1, Math.round((end.getTime() - start.getTime()) / V27AM_MS_PER_DAY) + 1)
}

export function computePeriodFee(input: PeriodFeeInput): PeriodFeeOutput | null {
  const { portfolio } = input
  const days = v27amPeriodDays(input.period_start, input.period_end)

  // Snapshots populated regardless of branch
  const baseSnapshot = {
    fee_model_used: portfolio.fee_model,
    period_days: days,
    fee_model_snapshot: portfolio.fee_model,
    performance_fee_threshold_snapshot: portfolio.target_return,
    performance_fee_split_snapshot: portfolio.performance_fee_split,
    fixed_annual_fee_ngn_snapshot: portfolio.fixed_annual_fee_ngn,
  }

  // ─── 'none' ─────────────────────────────────────────────────
  if (portfolio.fee_model === 'none') {
    // Engine should skip 'none' portfolios before calling. Defensive null.
    return null
  }

  // ─── 'fixed_annual' ─────────────────────────────────────────
  if (portfolio.fee_model === 'fixed_annual') {
    if (portfolio.fixed_annual_fee_ngn == null) return null
    const annualFee = portfolio.fixed_annual_fee_ngn
    const feeEarned = annualFee * (days / 365)
    return {
      ...baseSnapshot,
      gross_period_return_pct: null,
      excess_above_threshold: null,
      hwm_excess_amount: null,
      qualifying_excess: null,
      fee_earned: feeEarned,
    }
  }

  // ─── Performance modes: coherence + common math ─────────────
  if (portfolio.performance_fee_split == null) return null
  const splitFraction = portfolio.performance_fee_split / 100

  // Period TWR (simple, flow-adjusted): (closing − opening − net_flows) / opening
  // For full TWR with sub-period chaining, use lib/analytics.ts. For fee_periods
  // the simple form is acceptable per the locked architecture decisions; a
  // future v27 may upgrade to chained TWR if a client mandate demands it.
  const netFlows = input.contributions - input.withdrawals
  const grossReturnPct = input.opening_nav > 0
    ? (input.closing_nav - input.opening_nav - netFlows) / input.opening_nav
    : 0

  // Pro-rate annual threshold to actual period length
  const periodThresholdPct = portfolio.target_return * (days / 365)

  // ─── 'performance_excess' ───────────────────────────────────
  if (portfolio.fee_model === 'performance_excess') {
    const excessPct = Math.max(0, grossReturnPct - periodThresholdPct)
    const qualifyingExcess = excessPct > 0 ? input.opening_nav * excessPct : 0
    const feeEarned = qualifyingExcess * splitFraction
    return {
      ...baseSnapshot,
      gross_period_return_pct: grossReturnPct,
      excess_above_threshold: excessPct,
      hwm_excess_amount: null,
      qualifying_excess: qualifyingExcess,
      fee_earned: feeEarned,
    }
  }

  // ─── 'performance_hwm' ──────────────────────────────────────
  if (portfolio.fee_model === 'performance_hwm') {
    if (input.opening_hwm == null || input.period_high_nav == null) return null
    const hwmExcessAmount = Math.max(0, input.period_high_nav - input.opening_hwm)
    const feeEarned = hwmExcessAmount * splitFraction
    return {
      ...baseSnapshot,
      gross_period_return_pct: grossReturnPct,
      excess_above_threshold: null,
      hwm_excess_amount: hwmExcessAmount,
      qualifying_excess: hwmExcessAmount,
      fee_earned: feeEarned,
    }
  }

  // ─── 'performance_combined' ─────────────────────────────────
  if (portfolio.fee_model === 'performance_combined') {
    if (input.opening_hwm == null || input.period_high_nav == null) return null
    // Both gates must pass; fee on the smaller qualifying base
    const excessPct = Math.max(0, grossReturnPct - periodThresholdPct)
    const periodExcessNgn = excessPct > 0 ? input.opening_nav * excessPct : 0
    const hwmExcessAmount = Math.max(0, input.period_high_nav - input.opening_hwm)
    const qualifying = Math.min(periodExcessNgn, hwmExcessAmount)
    const feeEarned = qualifying * splitFraction
    return {
      ...baseSnapshot,
      gross_period_return_pct: grossReturnPct,
      excess_above_threshold: excessPct,
      hwm_excess_amount: hwmExcessAmount,
      qualifying_excess: qualifying,
      fee_earned: feeEarned,
    }
  }

  // Unknown / unhandled fee_model
  return null
}
