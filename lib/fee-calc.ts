/**
 * lib/fee-calc.ts — v27k
 *
 * Pure fee-math helper. Mirrors the DMA proposal worked example on page 3:
 *
 *   Total invested over the year (timing-adjusted): ₦17M
 *   Target value at 15%:                            ₦19.225M
 *   Actual total value:                             ₦27.9M
 *   Excess return above target:                     ₦8.675M
 *   Fee split:
 *     Client (70%):     ₦6.07M
 *     Transworld (30%): ₦2.60M
 *   Client final value: ₦25.3M
 *   Effective return:   49%
 *
 * Timing-adjusted contributed capital uses the standard portfolio-finance
 * interpretation:
 *
 *   adjusted_capital = sum over flows of (amount × years_remaining_in_period)
 *
 * where years_remaining_in_period = (period_end - flow_date) / 365.25.
 *
 * Example: ₦10M deployed at period start + ₦10M deployed at midpoint of a
 * 1-year period → adjusted = (10M × 1.0) + (10M × 0.5) = ₦15M.
 *
 * Beginning NAV is treated as a flow at period start (full year credit).
 * TRANSFER_IN flows are positive contributions; TRANSFER_OUT flows reduce
 * the contribution base (deployed capital that was withdrawn shouldn't
 * count toward the target). FEEs are NOT counted — they're already
 * reflected in actual ending NAV (Gap 1 lock from the design discussion).
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
  thresholdRate:  number   // e.g., 0.15 for 15%
  clientShare?:   number   // default 0.70
}

export interface FeeOutput {
  contributedCapital:    number   // timing-adjusted
  yearsInPeriod:         number
  thresholdRate:         number
  targetValue:           number
  actualValue:           number   // = endNAV
  excessReturn:          number   // can be negative
  belowTarget:           boolean
  clientFee:             number   // 0 if below target
  transworldFee:         number   // 0 if below target
  clientFinalValue:      number   // actualValue − transworldFee
  effectiveReturnPct:    number   // (clientFinalValue − contributedCapital) / contributedCapital
  flows: Array<{
    date:           string
    label:          string
    amount:         number   // signed: + for contribution, − for withdrawal
    yearsRemaining: number
    contributionWeight: number   // amount × yearsRemaining
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

  // 1. Beginning NAV — counts as a contribution at period start (full credit)
  if (startNAV > 0) {
    flows.push({
      date:           startDate.toISOString().slice(0, 10),
      label:          'Beginning NAV',
      amount:         startNAV,
      yearsRemaining: yearsInPeriod,
      contributionWeight: startNAV * yearsInPeriod,
    })
  }

  // 2. TRANSFER_IN / TRANSFER_OUT during the period
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
      date:           t.trade_date,
      label:          t.action === 'TRANSFER_IN' ? 'Capital top-up' : 'Capital withdrawal',
      amount:         signed,
      yearsRemaining,
      contributionWeight: signed * yearsRemaining,
    })
  }

  // 3. Timing-adjusted contributed capital
  const contributedCapital = flows.reduce((s, f) => s + f.contributionWeight, 0)

  // 4. Target value at threshold
  // Per DMA proposal worked example:
  //   ₦17M × (1 + 0.15)^1 ≈ ₦19.55M (proposal rounds to ₦19.225M which suggests
  //   simple multiplication ₦17M × 1.13 — but standard portfolio finance is
  //   compound). Using compounded form which is the standard convention; if
  //   the firm wants simple ₦17M × (1 + 0.15 × yrs), can be swapped here.
  const targetValue = contributedCapital * Math.pow(1 + thresholdRate, yearsInPeriod)

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
 * For UI display: formats a contribution-weight number with sign.
 */
export function fmtSignedNGN(n: number): string {
  const sign = n < 0 ? '−' : '+'
  const abs = Math.abs(n)
  return `${sign}₦${abs.toLocaleString('en-GB', { maximumFractionDigits: 0 })}`
}
