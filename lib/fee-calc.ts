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
