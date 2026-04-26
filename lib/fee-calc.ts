/**
 * lib/fee-calc.ts — v27n
 *
 * Pure fee-math helper. Implements XIRR-style timing-aware target calculation
 * matching standard portfolio-finance practice.
 *
 * METHODOLOGY
 * ───────────
 * Contributed capital is the FACE-VALUE sum of all flows over the period:
 *
 *   contributedCapital = startNAV + Σ TRANSFER_IN − Σ TRANSFER_OUT
 *
 * (No time-weighting on contributed capital itself — this represents the actual
 * net amount of capital the client has put to work, in flat naira terms.)
 *
 * Target value at end-of-period is computed by growing each flow forward from
 * its flow date to the period end at the threshold rate:
 *
 *   targetValue = Σ flow_i × (1 + r)^(years_remaining_i)
 *
 * where years_remaining_i = (endDate − flow_date_i) / 365.25.
 *
 * This is the standard XIRR-style calculation. Beginning NAV is treated as a
 * flow at period start (full-period growth). A ₦10M deposit at midyear of a
 * 1-year, 15% target period contributes ₦10M × 1.15^0.5 ≈ ₦10.72M to the
 * target. A ₦5M withdrawal at midyear is netted negatively, growing at the
 * same rate (the firm doesn't owe a return on capital that has been pulled).
 *
 * FEE SPLIT
 * ─────────
 * Excess return = actualEndingNAV − targetValue (can be negative)
 * Below target → no fee charged
 * Above target → 70/30 client/Transworld split (configurable via clientShare)
 *
 * EFFECTIVE RETURN
 * ────────────────
 * effectiveReturnPct = (clientFinalValue − contributedCapital) / contributedCapital
 *
 * This is a PERIOD return (total return over the window), not annualized.
 * For annualized return, see lib/analytics.ts → computeIRR (Newton-Raphson).
 *
 * HISTORICAL CONTEXT
 * ──────────────────
 * Prior to v27n (v27k–v27m), this module computed contributedCapital as the
 * time-weighted sum (Σ amount × years_remaining). That mechanic was wrong:
 * it inflated contributed capital for any period > 1 year (e.g. DON-C L5Y
 * showed startNAV × 5 ≈ ₦59.69M instead of face-value ~₦12M) and deflated
 * it for periods < 1 year (e.g. DON-C YTD at Apr 2026 showed startNAV × 0.32
 * ≈ ₦8.03M instead of face value ~₦25.49M). v27n reverts contributedCapital
 * to face-value semantics (standard XIRR) and applies time-weighting only
 * inside the target calculation, where it belongs.
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

  // 1. Beginning NAV — treated as a flow at period start (full-period growth)
  if (startNAV > 0) {
    flows.push({
      date:                startDate.toISOString().slice(0, 10),
      label:               'Beginning NAV',
      amount:              startNAV,
      yearsRemaining:      yearsInPeriod,
      futureValueAtTarget: startNAV * Math.pow(1 + thresholdRate, yearsInPeriod),
    })
  }

  // 2. TRANSFER_IN / TRANSFER_OUT during the period — time-weighted growth from flow date
  for (const t of transactions) {
    if (t.action !== 'TRANSFER_IN' && t.action !== 'TRANSFER_OUT') continue
    const flowDate = new Date(t.trade_date)
    if (flowDate < startDate || flowDate > endDate) continue

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

  // 3. Face-value contributed capital (XIRR semantics — flat naira sum, no time-weighting)
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
