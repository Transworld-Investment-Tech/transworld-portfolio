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
  // v27am: optional fee architecture fields. When undefined, falls back
  // to legacy client.type detection.
  // v27ao: target_return and performance_fee_split decommission the
  // hardcoded 15%/30% constants in computeFeeOutlook.
  fee_model?: 'none' | 'performance_excess' | 'performance_hwm' | 'performance_combined' | 'fixed_annual' | null
  fixed_annual_fee_ngn?: number | null
  target_return?: number | null
  performance_fee_split?: number | null
}

// ─── Types ─────────────────────────────────────────────────────
// v27ao: extended with 'fixed_annual' and 'no_fee' for fee-architecture
// awareness. Performance modes still use the original 5 values.
export type FeeStatus = 'beating' | 'on_track' | 'at_risk' | 'below' | 'no_basis' | 'fixed_annual' | 'no_fee'

export interface FeeOutlook {
  portfolio_id:   string
  portfolio_name: string
  client_name:    string
  client_code:    string
  is_internal:    boolean
  // v27am: fee architecture awareness. Optional so existing return
  // statements compile unchanged. Consumers that branch on these
  // get full differentiation; legacy consumers ignore them.
  // v27ao: pro_rata_ytd_fee added for fixed-annual panel rendering.
  is_fixed_annual?: boolean
  fixed_annual_fee_ngn?: number | null
  pro_rata_ytd_fee?: number

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

// ─── DMA defaults (v27ao: per-portfolio overrides honored) ─────
// Defaults for performance-mode portfolios when target_return or
// performance_fee_split is null. Live data has both columns populated
// for all six performance-fee mandates (15% target / 20% split), so
// these defaults are defensive backstops only.
const ANNUAL_TARGET_DEFAULT = 0.15
const FIRM_SHARE_DEFAULT_DECIMAL = 0.20

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

  const isInternal = portfolio.fee_model === 'none' || portfolio.client?.type === 'internal'
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

  // ─── v27ao: fee-architecture dispatcher ──────────────────────
  // Branches BEFORE the legacy performance math so internal and fixed-fee
  // mandates produce honest results rather than running a 15%/20%
  // performance projection that doesn't apply to them.

  // No-fee branch: fee_model='none' OR legacy client.type='internal'.
  // Engine returns a structurally complete result with all fee math zeroed
  // and status='no_fee'.
  if (isInternal) {
    return {
      portfolio_id:   portfolio.id,
      portfolio_name: portfolio.name,
      client_name:    portfolio.client?.name ?? '—',
      client_code:    portfolio.client?.code ?? '—',
      is_internal:    true,

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
      status: 'no_fee',
    }
  }

  // Fixed-annual branch: flat NGN per year, time-pro-rated YTD value.
  // projected_annual_fee = full annual amount (the headline fee).
  // pro_rata_ytd_fee = annual × (daysElapsed / daysInYear) — what's
  // accrued so far for the panel's secondary line.
  if (portfolio.fee_model === 'fixed_annual') {
    const annualFee = num(portfolio.fixed_annual_fee_ngn, 0)
    const ytdProRata = annualFee * (daysElapsed / Math.max(1, daysInYear))
    return {
      portfolio_id:   portfolio.id,
      portfolio_name: portfolio.name,
      client_name:    portfolio.client?.name ?? '—',
      client_code:    portfolio.client?.code ?? '—',
      is_internal:    false,
      is_fixed_annual: true,
      fixed_annual_fee_ngn: annualFee,
      pro_rata_ytd_fee: ytdProRata,

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
      projected_annual_fee:          annualFee,
      status: 'fixed_annual',
    }
  }

  // Performance modes (performance_excess, performance_hwm,
  // performance_combined) fall through to compound-target math below,
  // parameterised with per-portfolio target_return and
  // performance_fee_split. HWM and combined modes use the same forward
  // projection as performance_excess; fee_periods written by hwm-engine
  // remains the authoritative source for crystallised fees.

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

  // v27ao: per-portfolio target_return (decimal) drives compounding.
  // Falls back to 15% default if column is null.
  const annualTarget = num(portfolio.target_return, ANNUAL_TARGET_DEFAULT)

  // Compound each cashflow forward to today at the portfolio's target rate
  const targetNav = flows.reduce((sum, f) => {
    const yearsFromFlow = (today.getTime() - f.date.getTime()) / (365.25 * 86_400_000)
    return sum + f.amount * Math.pow(1 + annualTarget, yearsFromFlow)
  }, 0)

  const excessNgn = totalNAV - targetNav
  const excessPct = targetNav > 0 ? excessNgn / targetNav : 0

  // Linear extrapolation of excess to year-end
  // Extrapolation factor scales the excess to a full year horizon
  const extrapolationFactor = daysInYear / Math.max(1, daysElapsed)
  const projectedExcess = excessNgn * extrapolationFactor
  // v27ao: per-portfolio performance_fee_split (stored as percent, e.g. 20.0)
  // drives the firm share. Divide by 100 for decimal. Falls back to 20%.
  const splitPct = num(portfolio.performance_fee_split, FIRM_SHARE_DEFAULT_DECIMAL * 100)
  const projectedFee = Math.max(0, projectedExcess) * (splitPct / 100)

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
