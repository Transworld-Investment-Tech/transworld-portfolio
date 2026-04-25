// ═══════════════════════════════════════════════════════════════
// MANDATE HEALTH ENGINE (v27 → v27a → v27d)
// ═══════════════════════════════════════════════════════════════
//
// Best-practice surveillance for a single mandate. Returns 11 structured
// checks per portfolio, color-coded green/amber/red/na. Drives:
//   - Cockpit Mandate Health Grid (rows = portfolios, cols = checks)
//   - Portfolio Overview banner alerts (legacy complianceAlerts replacement
//     via healthToLegacyAlerts adapter)
//
// All checks read from data already on the table. No schema changes.
// Numeric coercion at every Supabase boundary (pitfall #72).
//
// Thresholds are hardcoded with comments. They can be moved to
// portfolio-level columns in a later release if needed.
//
// v27d — Watchlist alignment check live. checkWatchlistAlignment now
// computes "% of equity NAV in watchlist-tagged equity tickers" against
// the active firm watchlist (section = 'equity' AND active = true).
// Threshold: ≥60% green, ≥30% amber, <30% red.
// ═══════════════════════════════════════════════════════════════

import { computeSleeveData, estimatedIncomePA } from './portfolio'

// Local minimal portfolio shape — engine doesn't import the full Portfolio type
// from lib/portfolio.ts to stay decoupled from schema changes there.
export interface MandateHealthPortfolio {
  id: string
  name: string
  label?: string
  starting_nav: number
  start_date: string
  income_target: number
  liq_min: number
  dd_alert: number
  dd_action: number
  max_eq_single: number
  max_eq_sleeve?: number
  status: string
  client?: { name: string; code: string; type?: string }
}

export interface MandateHealthHolding {
  instrument_id: string
  quantity: number
  avg_cost: number
  latest_price?: number
  sleeve_id?: string
  instrument?: { type?: string; sleeve_id?: string; name?: string } | null
}

export interface MandateHealthSleeveDef {
  sleeve_id: string
  target_pct: number
  min_pct: number
  max_pct: number
  name?: string
}

// ─── Types ─────────────────────────────────────────────────────
export type HealthLevel = 'green' | 'amber' | 'red' | 'na'

export interface HealthCheckResult {
  level: HealthLevel
  message: string
  detail?: any
}

export interface MandateHealth {
  portfolio_id: string
  portfolio_name: string
  client_name: string
  client_code: string
  is_internal: boolean

  // Snapshot values (for grid display)
  current_nav: number
  starting_nav: number
  ytd_return_pct: number | null   // simple YTD return as decimal

  // 11 checks
  allocation_in_band:        HealthCheckResult
  single_name_concentration: HealthCheckResult
  sleeve_concentration:      HealthCheckResult
  drawdown_clean:            HealthCheckResult
  income_on_track:           HealthCheckResult
  cash_in_band:              HealthCheckResult
  fi_duration_sane:          HealthCheckResult
  recent_activity:           HealthCheckResult
  report_current:            HealthCheckResult
  watchlist_alignment:       HealthCheckResult   // v27d — real check
  beating_benchmark:         HealthCheckResult

  // Aggregate
  worst_level: HealthLevel
  red_count: number
  amber_count: number
}

// ─── Numeric coercion (pitfall #72) ────────────────────────────
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return isFinite(n) ? n : null
}
const num = (v: unknown, fallback = 0): number => numOrNull(v) ?? fallback

// ─── Format helpers ────────────────────────────────────────────
const fmtPct = (v: number | null, dp = 1): string => {
  if (v === null || !isFinite(v)) return '—'
  return (v * 100).toFixed(dp) + '%'
}

// ─── Worst-of aggregator ───────────────────────────────────────
function worstLevel(checks: HealthCheckResult[]): HealthLevel {
  if (checks.some(c => c.level === 'red'))   return 'red'
  if (checks.some(c => c.level === 'amber')) return 'amber'
  if (checks.every(c => c.level === 'na'))   return 'na'
  return 'green'
}

// ═══════════════════════════════════════════════════════════════
// CHECK IMPLEMENTATIONS
// ═══════════════════════════════════════════════════════════════

// computeSleeveData returns an array of sleeve rows with status; we re-type its
// return shape locally so we don't depend on the exact export type.
type SleeveRow = {
  sleeve_id: string
  name: string
  act: number
  status: string
  min_pct: number
  max_pct: number
}

// 1. Allocation in band — reuses computeSleeveData status mapping
function checkAllocationInBand(sleeveData: SleeveRow[]): HealthCheckResult {
  const breaches = sleeveData.filter(s => s.status === 'BREACH')
  const overs    = sleeveData.filter(s => s.status === 'OVER')
  if (breaches.length > 0) {
    return {
      level: 'red',
      message: `${breaches.map(s => `${s.name} ${(s.act * 100).toFixed(1)}% < min ${(s.min_pct * 100).toFixed(1)}%`).join('; ')}`,
      detail: { breaches: breaches.map(s => s.sleeve_id) },
    }
  }
  if (overs.length > 0) {
    return {
      level: 'amber',
      message: `${overs.map(s => `${s.name} ${(s.act * 100).toFixed(1)}% > max ${(s.max_pct * 100).toFixed(1)}%`).join('; ')}`,
      detail: { overs: overs.map(s => s.sleeve_id) },
    }
  }
  return { level: 'green', message: 'All sleeves within band' }
}

// 2. Single-name concentration
//    Red: any equity > max_eq_single
//    Amber: any equity > 80% of max_eq_single (early warning)
function checkSingleNameConcentration(
  portfolio: MandateHealthPortfolio,
  holdings: MandateHealthHolding[],
  totalNAV: number
): HealthCheckResult {
  if (totalNAV <= 0) return { level: 'na', message: 'No NAV' }
  const maxSingle = num(portfolio.max_eq_single, 0.10)
  if (maxSingle <= 0) return { level: 'na', message: 'No single-name limit set' }

  const equities = holdings.filter(h => h.instrument?.type === 'Stock')
  const weights = equities.map(h => {
    const price = h.latest_price ?? h.avg_cost
    const w = (h.quantity * price) / totalNAV
    return { ticker: h.instrument_id, name: h.instrument?.name ?? h.instrument_id, w }
  }).filter(x => x.w > 0).sort((a, b) => b.w - a.w)

  const breaches = weights.filter(x => x.w > maxSingle)
  const warnings = weights.filter(x => x.w > maxSingle * 0.8 && x.w <= maxSingle)

  if (breaches.length > 0) {
    return {
      level: 'red',
      message: `${breaches.map(b => `${b.ticker} ${(b.w * 100).toFixed(1)}%`).join(', ')} > ${(maxSingle * 100).toFixed(0)}% limit`,
      detail: { breaches, max: maxSingle },
    }
  }
  if (warnings.length > 0) {
    return {
      level: 'amber',
      message: `${warnings[0].ticker} ${(warnings[0].w * 100).toFixed(1)}% approaching ${(maxSingle * 100).toFixed(0)}% limit`,
      detail: { warnings, max: maxSingle },
    }
  }
  const top = weights[0]
  return {
    level: 'green',
    message: top ? `Largest position ${top.ticker} at ${(top.w * 100).toFixed(1)}%` : 'No equity positions',
  }
}

// 3. Sleeve concentration
//    Red: any sleeve OVER max OR UNDER min (already covered by allocation_in_band — but
//         this check's role is about how CLOSE to the edge we are within band)
//    Amber: within 10% of either edge
function checkSleeveConcentration(sleeveData: SleeveRow[]): HealthCheckResult {
  if (sleeveData.length === 0) return { level: 'na', message: 'No sleeves defined' }

  // If allocation_in_band catches breaches/overs, this returns green — they've
  // already been flagged elsewhere. This check focuses on near-edge warnings.
  const nearEdge = sleeveData.filter(s => {
    if (s.status !== 'OK') return false
    const range = (s.max_pct ?? 1) - (s.min_pct ?? 0)
    if (range <= 0) return false
    const distFromMin = s.act - (s.min_pct ?? 0)
    const distFromMax = (s.max_pct ?? 1) - s.act
    return distFromMin / range < 0.1 || distFromMax / range < 0.1
  })

  if (nearEdge.length > 0) {
    return {
      level: 'amber',
      message: `${nearEdge.map(s => `${s.name} ${(s.act * 100).toFixed(1)}% near edge`).join('; ')}`,
      detail: { near_edge: nearEdge.map(s => s.sleeve_id) },
    }
  }
  return { level: 'green', message: 'All sleeves comfortably in band' }
}

// 4. Drawdown clean
//    DD = (currentNAV - peakNAV) / peakNAV (negative)
//    Red: DD worse than dd_action
//    Amber: DD worse than dd_alert
function checkDrawdown(
  portfolio: MandateHealthPortfolio,
  currentNAV: number,
  navHistory: { nav_date: string; nav_value: number }[]
): HealthCheckResult {
  if (currentNAV <= 0) return { level: 'na', message: 'No NAV' }
  if (navHistory.length === 0) return { level: 'na', message: 'No NAV history' }

  const peak = Math.max(...navHistory.map(n => num(n.nav_value)), currentNAV)
  if (peak <= 0) return { level: 'na', message: 'Peak NAV unavailable' }
  const dd = (currentNAV - peak) / peak  // negative or zero

  const ddAlert  = num(portfolio.dd_alert,  -0.10)   // typically -0.10 (10%)
  const ddAction = num(portfolio.dd_action, -0.15)   // typically -0.15 (15%)

  if (dd <= ddAction) {
    return {
      level: 'red',
      message: `Drawdown ${(dd * 100).toFixed(1)}% breaches action threshold ${(ddAction * 100).toFixed(0)}%`,
      detail: { dd, peak, dd_action: ddAction },
    }
  }
  if (dd <= ddAlert) {
    return {
      level: 'amber',
      message: `Drawdown ${(dd * 100).toFixed(1)}% past alert ${(ddAlert * 100).toFixed(0)}%`,
      detail: { dd, peak, dd_alert: ddAlert },
    }
  }
  return {
    level: 'green',
    message: dd === 0 ? 'At or above peak NAV' : `Drawdown ${(dd * 100).toFixed(1)}% within tolerance`,
    detail: { dd, peak },
  }
}

// 5. Income on track
//    Green if projected income / target ≥ 1.0
//    Amber if ≥ 0.8 but < 1.0
//    Red if < 0.8
//    NA if income_target = 0
function checkIncomeOnTrack(
  portfolio: MandateHealthPortfolio,
  holdings: MandateHealthHolding[],
  totalNAV: number
): HealthCheckResult {
  const target = num(portfolio.income_target, 0)
  if (target <= 0) return { level: 'na', message: 'No income target' }
  if (totalNAV <= 0) return { level: 'na', message: 'No NAV' }

  const projectedIncome = estimatedIncomePA(holdings as any)
  const actualYield = projectedIncome / totalNAV
  const ratio = actualYield / target

  const targetPctLabel = (target * 100).toFixed(0) + '%'
  const actualPctLabel = (actualYield * 100).toFixed(2) + '%'

  if (ratio >= 1.0) {
    return {
      level: 'green',
      message: `Yield ${actualPctLabel} ≥ target ${targetPctLabel}`,
      detail: { ratio, target, actual: actualYield },
    }
  }
  if (ratio >= 0.8) {
    return {
      level: 'amber',
      message: `Yield ${actualPctLabel} below target ${targetPctLabel} (${(ratio * 100).toFixed(0)}% of target)`,
      detail: { ratio, target, actual: actualYield },
    }
  }
  return {
    level: 'red',
    message: `Yield ${actualPctLabel} far below target ${targetPctLabel} (${(ratio * 100).toFixed(0)}% of target)`,
    detail: { ratio, target, actual: actualYield },
  }
}

// 6. Cash in band
//    Green if liq sleeve actual ≥ liq_min
//    Red if below
function checkCashInBand(
  portfolio: MandateHealthPortfolio,
  sleeveData: SleeveRow[]
): HealthCheckResult {
  const liq = sleeveData.find(s => s.sleeve_id === 'liq')
  if (!liq) return { level: 'na', message: 'No liquidity sleeve defined' }
  const liqMin = num(portfolio.liq_min, 0)

  if (liq.act < liqMin) {
    return {
      level: 'red',
      message: `Cash ${(liq.act * 100).toFixed(1)}% < min ${(liqMin * 100).toFixed(0)}%`,
      detail: { actual: liq.act, min: liqMin },
    }
  }
  // Also flag overshoot via sleeve max — but allocation_in_band already does.
  return {
    level: 'green',
    message: `Cash ${(liq.act * 100).toFixed(1)}% within band`,
    detail: { actual: liq.act, min: liqMin },
  }
}

// 7. FI duration — display-only, always green
//    Surfaces weighted MD as a number for the tooltip.
function checkFIDurationSane(holdings: MandateHealthHolding[]): HealthCheckResult {
  const fiHoldings = holdings.filter(h => h.instrument?.sleeve_id === 'fi')
  if (fiHoldings.length === 0) {
    return { level: 'na', message: 'No FI holdings' }
  }
  return {
    level: 'green',
    message: `${fiHoldings.length} FI position${fiHoldings.length === 1 ? '' : 's'}`,
    detail: { fi_count: fiHoldings.length },
  }
}

// 8. Recent activity
//    Green if any non-FEE transaction in last 90 days
//    Amber otherwise
function checkRecentActivity(
  recentTxnCount90d: number
): HealthCheckResult {
  if (recentTxnCount90d > 0) {
    return {
      level: 'green',
      message: `${recentTxnCount90d} transaction${recentTxnCount90d === 1 ? '' : 's'} in last 90 days`,
      detail: { count_90d: recentTxnCount90d },
    }
  }
  return {
    level: 'amber',
    message: 'No transactions in last 90 days',
    detail: { count_90d: 0 },
  }
}

// 9. Report current
//    Green if any report within 100 days
//    Amber 100-130
//    Red > 130
//    Quarterly cadence assumed per DMA proposal
function checkReportCurrent(
  daysSinceLastReport: number | null
): HealthCheckResult {
  if (daysSinceLastReport === null) {
    return {
      level: 'red',
      message: 'No reports generated',
      detail: { days_since: null },
    }
  }
  if (daysSinceLastReport <= 100) {
    return {
      level: 'green',
      message: `Last report ${daysSinceLastReport}d ago`,
      detail: { days_since: daysSinceLastReport },
    }
  }
  if (daysSinceLastReport <= 130) {
    return {
      level: 'amber',
      message: `Last report ${daysSinceLastReport}d ago — quarterly cadence at risk`,
      detail: { days_since: daysSinceLastReport },
    }
  }
  return {
    level: 'red',
    message: `Last report ${daysSinceLastReport}d ago — quarterly overdue`,
    detail: { days_since: daysSinceLastReport },
  }
}

// 10. Watchlist alignment — v27d — Watchlist alignment check live
//
//    Computes % of equity NAV held in watchlist-tagged equity tickers.
//    The "watchlist universe" here is the firm's research universe:
//    section = 'equity' AND active = true (60 rows in production).
//    Tickers come pre-deduplicated from fetchWatchlistTickers.
//
//    Thresholds:
//      ≥ 60% → green   (allocation aligned with firm research)
//      ≥ 30% → amber   (mixed alignment)
//      < 30% → red     (drift from research universe)
//
//    NA cases:
//      - Empty watchlist universe (data quality issue)
//      - Portfolio has no equity holdings (FI-only mandate)
//      - totalNAV is zero
function checkWatchlistAlignment(
  holdings: MandateHealthHolding[],
  totalNAV: number,
  watchlistTickers: Set<string> | undefined
): HealthCheckResult {
  if (!watchlistTickers || watchlistTickers.size === 0) {
    return { level: 'na', message: 'Watchlist universe empty' }
  }
  if (totalNAV <= 0) return { level: 'na', message: 'No NAV' }

  const equityHoldings = holdings.filter(h =>
    h.instrument?.type === 'Stock' || h.instrument?.sleeve_id === 'eq'
  )
  if (equityHoldings.length === 0) {
    return { level: 'na', message: 'No equity holdings' }
  }

  const equityNav = equityHoldings.reduce((s, h) => {
    const px = h.latest_price ?? h.avg_cost
    return s + num(h.quantity) * num(px)
  }, 0)
  if (equityNav <= 0) return { level: 'na', message: 'No equity NAV' }

  const alignedNav = equityHoldings
    .filter(h => watchlistTickers.has(h.instrument_id))
    .reduce((s, h) => {
      const px = h.latest_price ?? h.avg_cost
      return s + num(h.quantity) * num(px)
    }, 0)

  const alignment = alignedNav / equityNav
  const alignedPctLabel = (alignment * 100).toFixed(1) + '%'

  if (alignment >= 0.60) {
    return {
      level: 'green',
      message: `${alignedPctLabel} of equity NAV on firm watchlist`,
      detail: { alignment, aligned_ngn: alignedNav, equity_ngn: equityNav, threshold: 0.60 },
    }
  }
  if (alignment >= 0.30) {
    return {
      level: 'amber',
      message: `${alignedPctLabel} on watchlist (target ≥60%)`,
      detail: { alignment, aligned_ngn: alignedNav, equity_ngn: equityNav, threshold: 0.30 },
    }
  }
  return {
    level: 'red',
    message: `${alignedPctLabel} on watchlist — drifted from firm research universe`,
    detail: { alignment, aligned_ngn: alignedNav, equity_ngn: equityNav },
  }
}

// 11. Beating benchmark
//    Pro-rated 15% target for the calendar year
//    Green if YTD return ≥ pro-rated target
//    Amber within 200bps below
//    Red > 200bps below
//    NA for internal portfolios (TW own book — no benchmark)
function checkBeatingBenchmark(
  isInternal: boolean,
  ytdReturn: number | null,
  daysElapsed: number,
  daysInYear: number
): HealthCheckResult {
  if (isInternal) {
    return { level: 'na', message: 'Internal book — no benchmark' }
  }
  if (ytdReturn === null) {
    return { level: 'na', message: 'YTD return not computable yet' }
  }
  const annualTarget = 0.15
  const proRatedTarget = annualTarget * (daysElapsed / daysInYear)
  const gap = ytdReturn - proRatedTarget
  const gapBps = gap * 10000

  if (gap >= 0) {
    return {
      level: 'green',
      message: `YTD ${fmtPct(ytdReturn)} beating ${fmtPct(proRatedTarget)} pro-rated target`,
      detail: { ytd: ytdReturn, target: proRatedTarget, gap_bps: gapBps },
    }
  }
  if (gapBps >= -200) {
    return {
      level: 'amber',
      message: `YTD ${fmtPct(ytdReturn)} vs ${fmtPct(proRatedTarget)} target (${gapBps.toFixed(0)}bps below)`,
      detail: { ytd: ytdReturn, target: proRatedTarget, gap_bps: gapBps },
    }
  }
  return {
    level: 'red',
    message: `YTD ${fmtPct(ytdReturn)} vs ${fmtPct(proRatedTarget)} target (${gapBps.toFixed(0)}bps below)`,
    detail: { ytd: ytdReturn, target: proRatedTarget, gap_bps: gapBps },
  }
}

// ═══════════════════════════════════════════════════════════════
// MAIN ENTRY POINT
// ═══════════════════════════════════════════════════════════════

export interface MandateHealthInput {
  portfolio: MandateHealthPortfolio
  holdings: MandateHealthHolding[]
  sleeveDefs: MandateHealthSleeveDef[]
  totalNAV: number
  navHistory: { nav_date: string; nav_value: number }[]
  recentTxnCount90d: number
  daysSinceLastReport: number | null
  ytdReturn: number | null   // computed by caller via computePeriodMetrics or similar
  watchlistTickers?: Set<string>   // v27d — equity-section watchlist (optional; check returns 'na' if absent)
}

export function computeMandateHealth(input: MandateHealthInput): MandateHealth {
  const {
    portfolio, holdings, sleeveDefs, totalNAV, navHistory,
    recentTxnCount90d, daysSinceLastReport, ytdReturn, watchlistTickers,
  } = input

  // computeSleeveData expects (holdings, sleeveDefs, totalNAV) → array of sleeve rows
  const sleeveData = computeSleeveData(holdings as any, sleeveDefs as any, totalNAV) as SleeveRow[]
  const isInternal = portfolio.client?.type === 'internal'

  // Days elapsed in calendar year (today)
  const now = new Date()
  const yearStart = new Date(now.getFullYear(), 0, 1)
  const yearEnd = new Date(now.getFullYear() + 1, 0, 1)
  const daysElapsed = Math.max(1, Math.round((now.getTime() - yearStart.getTime()) / 86_400_000))
  const daysInYear  = Math.round((yearEnd.getTime() - yearStart.getTime()) / 86_400_000)

  const checks: Record<string, HealthCheckResult> = {
    allocation_in_band:        checkAllocationInBand(sleeveData),
    single_name_concentration: checkSingleNameConcentration(portfolio, holdings, totalNAV),
    sleeve_concentration:      checkSleeveConcentration(sleeveData),
    drawdown_clean:            checkDrawdown(portfolio, totalNAV, navHistory),
    income_on_track:           checkIncomeOnTrack(portfolio, holdings, totalNAV),
    cash_in_band:              checkCashInBand(portfolio, sleeveData),
    fi_duration_sane:          checkFIDurationSane(holdings),
    recent_activity:           checkRecentActivity(recentTxnCount90d),
    report_current:            checkReportCurrent(daysSinceLastReport),
    watchlist_alignment:       checkWatchlistAlignment(holdings, totalNAV, watchlistTickers),
    beating_benchmark:         checkBeatingBenchmark(isInternal, ytdReturn, daysElapsed, daysInYear),
  }

  const allChecks = Object.values(checks)
  const worst = worstLevel(allChecks)
  const redCount   = allChecks.filter(c => c.level === 'red').length
  const amberCount = allChecks.filter(c => c.level === 'amber').length

  return {
    portfolio_id:   portfolio.id,
    portfolio_name: portfolio.name,
    client_name:    portfolio.client?.name ?? '—',
    client_code:    portfolio.client?.code ?? '—',
    is_internal:    isInternal,

    current_nav:    totalNAV,
    starting_nav:   num(portfolio.starting_nav, 0),
    ytd_return_pct: ytdReturn,

    allocation_in_band:        checks.allocation_in_band,
    single_name_concentration: checks.single_name_concentration,
    sleeve_concentration:      checks.sleeve_concentration,
    drawdown_clean:            checks.drawdown_clean,
    income_on_track:           checks.income_on_track,
    cash_in_band:              checks.cash_in_band,
    fi_duration_sane:          checks.fi_duration_sane,
    recent_activity:           checks.recent_activity,
    report_current:            checks.report_current,
    watchlist_alignment:       checks.watchlist_alignment,
    beating_benchmark:         checks.beating_benchmark,

    worst_level: worst,
    red_count:   redCount,
    amber_count: amberCount,
  }
}

// ═══════════════════════════════════════════════════════════════
// LEGACY ADAPTER — preserves existing complianceAlerts UX
// ═══════════════════════════════════════════════════════════════
//
// The portfolio overview banner consumed { level: 'critical' | 'warn' | 'info', message }[].
// This adapter converts the structured health result into that shape so the
// existing JSX continues to render without changes. Red → critical, Amber → warn,
// Green/NA → suppressed.
//
// Watchlist alignment is intentionally OMITTED from the legacy adapter — it's
// a portfolio-fit signal for the cockpit, not a compliance/breach alert for the
// portfolio overview banner.

export interface LegacyAlert {
  level: 'critical' | 'warn' | 'info'
  message: string
}

export function healthToLegacyAlerts(h: MandateHealth): LegacyAlert[] {
  const out: LegacyAlert[] = []
  const allChecks: { name: string; check: HealthCheckResult }[] = [
    { name: 'allocation_in_band',        check: h.allocation_in_band },
    { name: 'single_name_concentration', check: h.single_name_concentration },
    { name: 'sleeve_concentration',      check: h.sleeve_concentration },
    { name: 'drawdown_clean',            check: h.drawdown_clean },
    { name: 'income_on_track',           check: h.income_on_track },
    { name: 'cash_in_band',               check: h.cash_in_band },
    { name: 'recent_activity',           check: h.recent_activity },
    { name: 'report_current',            check: h.report_current },
    { name: 'beating_benchmark',         check: h.beating_benchmark },
  ]

  for (const { check } of allChecks) {
    if (check.level === 'red')   out.push({ level: 'critical', message: check.message })
    if (check.level === 'amber') out.push({ level: 'warn',     message: check.message })
  }

  return out
}
