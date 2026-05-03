/**
 * lib/fee-periods.ts — v27am
 *
 * Pure period boundary logic. Given fee_year_end_md (e.g. '12-31') and
 * fee_relationship_start_date, generate fee periods covering all time
 * from relationship_start through asOf.
 *
 * Convention: a period is [period_start, period_end] inclusive.
 * Periods are non-overlapping and contiguous (next period_start = prior period_end + 1 day).
 *
 * The first period may be partial (relationship_start to next year-end anniversary).
 * The trailing period (in-progress) ends at min(next_year_end, asOf) and has
 * is_complete=false.
 *
 * Edge case (deferred): fee_year_end_md='02-29' rolls forward to March 1 in
 * non-leap years via JS Date semantics. Not validated in v27am — no current
 * portfolio uses that boundary. Address when first negotiated.
 */

export interface FeePeriod {
  period_start: string  // ISO yyyy-mm-dd
  period_end: string    // ISO yyyy-mm-dd
  is_complete: boolean  // true if period_end <= asOf (period closed)
}

export function parseFeeYearEnd(md: string): { month: number; day: number } {
  const parts = md.split('-')
  if (parts.length !== 2) {
    throw new Error(`Invalid fee_year_end_md format: ${md} (expected 'MM-DD')`)
  }
  const month = parseInt(parts[0], 10)
  const day = parseInt(parts[1], 10)
  if (isNaN(month) || isNaN(day) || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new Error(`Invalid fee_year_end_md values: ${md}`)
  }
  return { month, day }
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

function utcDate(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day))
}

function addDays(d: Date, days: number): Date {
  const next = new Date(d)
  next.setUTCDate(next.getUTCDate() + days)
  return next
}

/**
 * Find the next occurrence of (month, day) on or after `start`.
 * If start IS the (month, day), returns start itself (zero-day period;
 * caller should advance).
 */
function nextYearEnd(start: Date, month: number, day: number): Date {
  const year = start.getUTCFullYear()
  const candidate = utcDate(year, month, day)
  if (candidate < start) {
    return utcDate(year + 1, month, day)
  }
  return candidate
}

/**
 * Generate fee periods from relationshipStart through asOf, with period
 * end boundaries on feeYearEndMD anniversaries.
 *
 * @param relationshipStart First day of fee accrual (HWM anchor).
 * @param asOf Today (or simulated cutoff for testing).
 * @param feeYearEndMD 'MM-DD' format. Default '12-31' = calendar year.
 * @returns Array of FeePeriod ordered chronologically. Empty if relationshipStart > asOf.
 */
export function generatePeriods(
  relationshipStart: Date,
  asOf: Date,
  feeYearEndMD: string
): FeePeriod[] {
  const { month, day } = parseFeeYearEnd(feeYearEndMD)
  const periods: FeePeriod[] = []

  // Normalize both bounds to UTC midnight for consistent date math
  const start0 = utcDate(
    relationshipStart.getUTCFullYear(),
    relationshipStart.getUTCMonth() + 1,
    relationshipStart.getUTCDate()
  )
  const asOf0 = utcDate(
    asOf.getUTCFullYear(),
    asOf.getUTCMonth() + 1,
    asOf.getUTCDate()
  )

  if (start0 > asOf0) return periods

  let currentStart = start0
  let safety = 0
  const SAFETY_LIMIT = 200  // ~200 years; sanity bound against runaway loops

  while (currentStart <= asOf0 && safety < SAFETY_LIMIT) {
    safety++

    const yearEnd = nextYearEnd(currentStart, month, day)
    const isComplete = yearEnd <= asOf0
    const periodEnd = isComplete ? yearEnd : asOf0

    if (periodEnd < currentStart) break  // zero/negative-length defensive

    periods.push({
      period_start: isoDate(currentStart),
      period_end: isoDate(periodEnd),
      is_complete: isComplete,
    })

    if (!isComplete) break  // in-progress period; nothing further to compute

    currentStart = addDays(yearEnd, 1)
  }

  return periods
}
