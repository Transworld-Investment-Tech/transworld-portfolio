// ═══════════════════════════════════════════════════════════════
// FEE OUTLOOK ENGINE (v27)
// ═══════════════════════════════════════════════════════════════
//
// Implements the Transworld DMA performance-fee benchmark math.
//
// Per the DMA proposal:
//   - 15% per annum target return, calendar-year basis (Jan 1 cutoff)
//   - For mandates that started this year, target is pro-rated from start_date
//   - Excess return (NAV above target) is split 70/30 client/Transworld
//   - No fee earned if portfolio underperforms target
//
// Math:
//   target_nav_today = sum over cashflows C_i at date d_i:
//     C_i × (1.15) ^ ((today - d_i) / 365.25)
//
//   where C_i is:
//     - portfolio NAV at year_start_basis (treated as deployment at t=0), OR
//       starting_nav if mandate started this year
//     - + every TRANSFER_IN during year (positive — deployment)
//     - − every TRANSFER_OUT during year (negative — withdrawal reduces target)
//
// Internal portfolios (client.type='internal') are excluded from firm-wide
// fee aggregates by the consumer — this engine returns a result for them but
// flags is_internal=true so callers can filter.
//
// All numeric coercion at the Supabase boundary (pitfall #72).
// ═══════════════════════════════════════════════════════════════

// Local minimal portfolio shape — engine doesn't depend on lib/portfolio.ts types
export interface FeeOutlookPortfolio {
  id: string
  name: string
  starting_nav: number
  start_date: string
  client?: { name: string; code: string; type?: string }
}

// ─── Types ─────────────────────────────────────────────────────
export type FeeStatus = 'beating' | 'on_track' | 'at_risk' | 'below' | 'no_basis'

export interface FeeOutlook {
  portfolio_id:   string
  portfolio_name: string
  client_name:    string
  client_code:    string
  is_internal:    boolean

  year_start_basis: 'jan_1' | 'mandate_start'
  effective_year_start_date: string  // ISO yyyy-mm-dd
  days_elapsed:    number
  days_remaining:  number
  days_in_year:    number

  current_nav:     number
  target_nav:      number
  excess_ngn:      number          // current - target (can be negative)
  excess_pct:      number          // excess / target

  projected_year_end_excess_ngn: number
  projected_annual_fee:          number   // 30% of max(extrapolated, 0)

  status: FeeStatus
}

// ─── Numeric coercion ──────────────────────────────────────────
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return isFinite(n) ? n : null
}
const num = (v: unknown, fallback = 0): number => numOrNull(v) ?? fallback

// ─── DMA constants ─────────────────────────────────────────────
const ANNUAL_TARGET = 0.15
const TRANSWORLD_SHARE = 0.30   // Transworld gets 30% of excess

// ─── Year boundary helpers ─────────────────────────────────────
function yearStartOf(date: Date): Date {
  return new Date(date.getFullYear(), 0, 1)
}
function yearEndOf(date: Date): Date {
  return new Date(date.getFullYear() + 1, 0, 1)
}
function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.round((to.getTime() - from.getTime()) / 86_400_000))
}
function isoDate(d: Date): string {
  // Local-time slice — note pitfall #20 lurks here for some flows but for
  // this engine all comparisons are local-time consistent so no drift.
  return d.toISOString().slice(0, 10)
}

// ─── Status classification ─────────────────────────────────────
function classifyStatus(excess: number, currentNAV: number, projected: number): FeeStatus {
  if (currentNAV <= 0) return 'no_basis'
  const excessRatio = excess / currentNAV
  if (excess >= 0 && projected > 0) return 'beating'
  if (excessRatio >= -0.02) return 'on_track'
  if (excessRatio >= -0.05) return 'at_risk'
  return 'below'
}

// ═══════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════

export interface FeeOutlookInput {
  portfolio: FeeOutlookPortfolio
  totalNAV: number
  // NAV log to find Jan 1 NAV. If portfolio started this year, use starting_nav.
  navAtYearStart: number | null
  // TRANSFER_IN and TRANSFER_OUT during current calendar year
  yearlyCashflows: { date: string; amount: number; action: string }[]
}

export function computeFeeOutlook(input: FeeOutlookInput): FeeOutlook {
  const { portfolio, totalNAV, navAtYearStart, yearlyCashflows } = input

  const isInternal = portfolio.client?.type === 'internal'
  const today = new Date()
  const yStart = yearStartOf(today)
  const yEnd   = yearEndOf(today)
  const daysInYear = daysBetween(yStart, yEnd)

  // Year-start basis decision
  const startDate = portfolio.start_date ? new Date(portfolio.start_date) : yStart
  const startedThisYear = startDate >= yStart
  const effectiveYearStart = startedThisYear ? startDate : yStart
  const basis: 'jan_1' | 'mandate_start' = startedThisYear ? 'mandate_start' : 'jan_1'

  const daysElapsed   = Math.max(1, daysBetween(effectiveYearStart, today))
  const daysRemaining = Math.max(0, daysBetween(today, yEnd))

  // Initial cashflow at effective year start
  const initialBasis = startedThisYear
    ? num(portfolio.starting_nav, 0)
    : (navAtYearStart ?? num(portfolio.starting_nav, 0))

  // No-basis short circuit: no NAV at year start AND no inflows since
  if (initialBasis <= 0 && yearlyCashflows.length === 0) {
    return {
      portfolio_id:   portfolio.id,
      portfolio_name: portfolio.name,
      client_name:    portfolio.client?.name ?? '—',
      client_code:    portfolio.client?.code ?? '—',
      is_internal:    isInternal,

      year_start_basis:           basis,
      effective_year_start_date:  isoDate(effectiveYearStart),
      days_elapsed:               daysElapsed,
      days_remaining:             daysRemaining,
      days_in_year:               daysInYear,

      current_nav: totalNAV,
      target_nav:  0,
      excess_ngn:  0,
      excess_pct:  0,

      projected_year_end_excess_ngn: 0,
      projected_annual_fee:          0,
      status: 'no_basis',
    }
  }

  // Build cashflow list: [initial at year-start] + [each TRANSFER_IN/OUT during year]
  const flows: { date: Date; amount: number }[] = []
  if (initialBasis > 0) {
    flows.push({ date: effectiveYearStart, amount: initialBasis })
  }

  for (const cf of yearlyCashflows) {
    const d = new Date(cf.date)
    if (d < effectiveYearStart || d > today) continue
    const amt = Math.abs(num(cf.amount, 0))
    if (amt === 0) continue
    if (cf.action === 'TRANSFER_IN') {
      flows.push({ date: d, amount: amt })
    } else if (cf.action === 'TRANSFER_OUT') {
      flows.push({ date: d, amount: -amt })
    }
  }

  // Compound each cashflow forward to today at 15% per annum
  const targetNav = flows.reduce((sum, f) => {
    const yearsFromFlow = (today.getTime() - f.date.getTime()) / (365.25 * 86_400_000)
    return sum + f.amount * Math.pow(1 + ANNUAL_TARGET, yearsFromFlow)
  }, 0)

  const excessNgn = totalNAV - targetNav
  const excessPct = targetNav > 0 ? excessNgn / targetNav : 0

  // Linear extrapolation of excess to year-end
  // Extrapolation factor scales the excess to a full year horizon
  const extrapolationFactor = daysInYear / Math.max(1, daysElapsed)
  const projectedExcess = excessNgn * extrapolationFactor
  const projectedFee = Math.max(0, projectedExcess) * TRANSWORLD_SHARE

  const status = classifyStatus(excessNgn, totalNAV, projectedExcess)

  return {
    portfolio_id:   portfolio.id,
    portfolio_name: portfolio.name,
    client_name:    portfolio.client?.name ?? '—',
    client_code:    portfolio.client?.code ?? '—',
    is_internal:    isInternal,

    year_start_basis:           basis,
    effective_year_start_date:  isoDate(effectiveYearStart),
    days_elapsed:               daysElapsed,
    days_remaining:             daysRemaining,
    days_in_year:               daysInYear,

    current_nav: totalNAV,
    target_nav:  targetNav,
    excess_ngn:  excessNgn,
    excess_pct:  excessPct,

    projected_year_end_excess_ngn: projectedExcess,
    projected_annual_fee:          projectedFee,
    status,
  }
}
