/**
 * lib/fee-math.ts — v27av
 *
 * Pure-functional fee math primitives + the period walker.
 *
 * This module is the foundation for three call modes that downstream engines
 * (v27aw cockpit fee-outlook, v27ax scenario engine, v27ay+ AI cockpit reports)
 * will exercise. v27av ships only the API; production code (lib/hwm-engine.ts)
 * uses Mode 1 with byte-identical behaviour to v27am-fix2.
 *
 *   Mode 1 — Production recompute (used by lib/hwm-engine.ts)
 *     Caller loads real portfolio config + nav_log + transactions + preserved
 *     fee_periods rows; calls walkPeriods; persists computedPeriods to DB.
 *
 *   Mode 2 — Forward projection (used by v27aw onward)
 *     Caller loads real data, then synthesises forward NAV via projectNavForward
 *     given an assumed annual return; calls walkPeriods; never persists.
 *     Result describes "what fees would crystallise if the portfolio continued
 *     at the assumed return through the projection date".
 *
 *   Mode 3 — Counterfactual / parameter override (used by v27ax onward)
 *     Caller loads real data, merges configOverrides into config (different
 *     fee_model, different split, different anchor, different fixed amount),
 *     calls walkPeriods, never persists. Result describes "what fees would have
 *     crystallised under the alternative configuration".
 *
 * Modes 2 and 3 compose: forward-project NAV AND override config to ask
 * "what fees would the portfolio earn next year under structure X assuming
 * return Y" — a core question for the quant CIO surface.
 *
 * No DB IO. No async. No external deps beyond ./fee-periods + ./fee-calc.
 *
 * Numeric coercion at the Supabase boundary (pitfall #72): num() and numOrNull()
 * exported here so downstream callers don't re-implement.
 */

import { generatePeriods, type FeePeriod } from './fee-periods'
import { computePeriodFee, type FeeModel } from './fee-calc'

// ─── Numeric coercion helpers (pitfall #72) ─────────────────────────────────

export function num(v: any, fallback = 0): number {
  if (v === null || v === undefined || v === '') return fallback
  const n = typeof v === 'string' ? parseFloat(v) : v
  return Number.isFinite(n) ? n : fallback
}

export function numOrNull(v: any): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'string' ? parseFloat(v) : v
  return Number.isFinite(n) ? n : null
}

// ─── Input row types (Supabase-coerced) ─────────────────────────────────────

export interface NavLogRow {
  nav_date: string  // YYYY-MM-DD
  nav_value: number
}

export interface TransactionRow {
  trade_date: string  // YYYY-MM-DD
  action: string      // 'BUY' | 'SELL' | 'TRANSFER_IN' | 'TRANSFER_OUT' | 'FEE' | 'INCOME'
  amount: number | null
}

export interface PreservedPeriodRow {
  period_start: string  // YYYY-MM-DD
  closing_hwm: number | null
}

// ─── Walker config + output types ───────────────────────────────────────────

export interface FeeWalkConfig {
  fee_model: FeeModel
  target_return: number
  performance_fee_split: number | null
  fixed_annual_fee_ngn: number | null
  fee_year_end_md: string
  fee_relationship_start_date: string | null
}

export interface ComputedPeriod {
  period_start: string
  period_end: string
  opening_hwm: number | null
  closing_hwm: number | null
  period_high_nav: number | null
  opening_nav: number
  closing_nav: number
  contributions: number
  withdrawals: number
  cwa_factor: number | null
  gross_period_return_pct: number | null
  excess_above_threshold: number | null
  hwm_excess_amount: number | null
  qualifying_excess: number | null
  fee_earned: number
  fee_model_snapshot: string
  performance_fee_threshold_snapshot: number | null
  performance_fee_split_snapshot: number | null
  fixed_annual_fee_ngn_snapshot: number | null
}

export interface WalkPeriodsInput {
  config: FeeWalkConfig
  navRows: NavLogRow[]            // sorted ascending by nav_date
  txRows: TransactionRow[]        // sorted ascending by trade_date
  preservedRows: PreservedPeriodRow[]
  asOf: Date
}

/**
 * Outcome of a walker run.
 *
 *   ok=false              → coherence/IO failure (fixed_annual without amount,
 *                           performance without split, generatePeriods threw,
 *                           seed nav <= 0). Caller should NOT wipe/persist.
 *
 *   ok=true, ranWalk=false → skip case (fee_model=none, anchor=null, no periods
 *                           generated). Caller should NOT wipe/persist.
 *
 *   ok=true, ranWalk=true  → walker iterated. Caller MAY wipe/persist depending
 *                           on whether computedPeriods is non-empty.
 *                           Persistence callers (Mode 1) should wipe pending/
 *                           superseded fee_periods rows even when
 *                           computedPeriods is empty (all-preserved case),
 *                           matching the v27am-fix2 wipe-then-walk semantics.
 */
export interface WalkPeriodsOutcome {
  ok: boolean
  reason?: string
  computedPeriods: ComputedPeriod[]
  periodsPreserved: number
  ranWalk: boolean
}

// ─── Pure primitives ────────────────────────────────────────────────────────

/**
 * Latest nav_log row at-or-before the given date.
 * Returns defaultValue (default 0) if no row precedes the date.
 *
 * Critical detail: if a row IS found and its nav_value is 0, returns 0 (not
 * defaultValue). The default fires only when the search comes up empty.
 * This matches v27am hwm-engine.ts opening/closing NAV resolution semantics
 * exactly.
 *
 * Assumes navRows is sorted ascending by nav_date (caller's responsibility).
 */
export function resolveNavAtOrBefore(
  navRows: NavLogRow[],
  date: string,
  defaultValue: number = 0
): number {
  for (let k = navRows.length - 1; k >= 0; k--) {
    if (navRows[k].nav_date <= date) {
      return navRows[k].nav_value
    }
  }
  return defaultValue
}

/**
 * Max nav_value strictly inside the half-open window (periodStart, periodEnd].
 * Returns floor (typically closingNav) if no rows fall in window.
 */
export function resolvePeriodHigh(
  navRows: NavLogRow[],
  periodStart: string,
  periodEnd: string,
  floor: number
): number {
  let high = floor
  for (const r of navRows) {
    if (r.nav_date > periodStart && r.nav_date <= periodEnd) {
      if (r.nav_value > high) high = r.nav_value
    }
  }
  return high
}

/**
 * Sum TRANSFER_IN and TRANSFER_OUT amounts in the half-open window
 * (periodStart, periodEnd]. Strict on lower bound — flows ON period_start
 * are part of opening NAV, not period flows (v27o-fix1 semantics, preserved
 * verbatim).
 */
export function sumFlowsInWindow(
  txRows: TransactionRow[],
  periodStart: string,
  periodEnd: string
): { contributions: number; withdrawals: number } {
  let contributions = 0
  let withdrawals = 0
  for (const t of txRows) {
    if (t.trade_date <= periodStart || t.trade_date > periodEnd) continue
    if (t.amount == null || t.amount <= 0) continue
    if (t.action === 'TRANSFER_IN') contributions += t.amount
    else if (t.action === 'TRANSFER_OUT') withdrawals += t.amount
  }
  return { contributions, withdrawals }
}

/**
 * Contribution-weighted adjustment factor:
 *   (closingNav - netFlows) / openingNav
 * Returns null if openingNav is non-positive (div-by-zero guard).
 */
export function computeCwaFactor(
  openingNav: number,
  closingNav: number,
  netFlows: number
): number | null {
  if (openingNav <= 0) return null
  return (closingNav - netFlows) / openingNav
}

/**
 * HWM-1: flow-adjusted opening HWM.
 *   - Deposits raise HWM by face value (deposit gets locked in at NAV-on-date)
 *   - Withdrawals lower HWM proportionally to withdrawal-as-pct-of-pre-withdrawal-NAV
 * Returns null if runningHwm is null (HWM not initialised yet).
 */
export function applyHwm1FlowAdjustment(
  runningHwm: number | null,
  openingNav: number,
  contributions: number,
  withdrawals: number
): number | null {
  if (runningHwm == null) return null
  let adj = runningHwm + contributions
  const navBeforeWithdrawals = openingNav + contributions
  if (withdrawals > 0 && navBeforeWithdrawals > 0) {
    adj = adj * (1 - withdrawals / navBeforeWithdrawals)
  }
  return adj
}

/**
 * HWM-2: closing HWM = max(opening_hwm_after_flows, closing_nav − fee_earned).
 * Prevents fee-on-fee compounding.
 * Returns null if openingHwmAdj is null.
 */
export function applyHwm2Crystallisation(
  openingHwmAdj: number | null,
  closingNav: number,
  feeEarned: number
): number | null {
  if (openingHwmAdj == null) return null
  return Math.max(openingHwmAdj, closingNav - feeEarned)
}

// ─── Forward projection helper (Mode 2) ─────────────────────────────────────

export interface ProjectNavForwardInput {
  navRows: NavLogRow[]
  asOf: Date
  throughDate: Date
  assumedAnnualReturn: number  // e.g. 0.18 for 18%
}

/**
 * Synthesise NavLogRow entries from asOf+1 day through throughDate by
 * extrapolating the asOf NAV at a linear annualised return:
 *
 *   nav_t = nav_asOf * (1 + assumedAnnualReturn * days_from_asOf / 365)
 *
 * Linear annualisation matches the cockpit Fee Outlook convention pre-v27av
 * (one return rate × time elapsed). For compounded projections, callers can
 * pass a different anchor and assumedAnnualReturn shape — but linear is the
 * default.
 *
 * Synthetic rows are emitted weekly (sufficient resolution for period
 * resolveNavAtOrBefore lookups), plus an explicit row at throughDate.
 *
 * Originals always win on date conflicts (real data > projected data).
 *
 * If the asOf-anchor NAV is non-positive, returns the original navRows
 * unchanged — there's no basis to project from.
 */
export function projectNavForward(input: ProjectNavForwardInput): NavLogRow[] {
  const { navRows, asOf, throughDate, assumedAnnualReturn } = input
  const asOfStr = asOf.toISOString().slice(0, 10)
  const throughStr = throughDate.toISOString().slice(0, 10)
  if (throughStr <= asOfStr) return [...navRows]

  const anchorNav = resolveNavAtOrBefore(navRows, asOfStr)
  if (anchorNav <= 0) return [...navRows]

  const synthetic: NavLogRow[] = []
  const oneDay = 86400000
  const asOfMs = new Date(asOfStr + 'T00:00:00Z').getTime()
  const throughMs = new Date(throughStr + 'T00:00:00Z').getTime()

  for (let t = asOfMs + 7 * oneDay; t <= throughMs; t += 7 * oneDay) {
    const days = (t - asOfMs) / oneDay
    const navT = anchorNav * (1 + assumedAnnualReturn * days / 365)
    synthetic.push({
      nav_date: new Date(t).toISOString().slice(0, 10),
      nav_value: navT,
    })
  }

  // Always include throughDate exactly
  const totalDays = (throughMs - asOfMs) / oneDay
  if (totalDays > 0) {
    synthetic.push({
      nav_date: throughStr,
      nav_value: anchorNav * (1 + assumedAnnualReturn * totalDays / 365),
    })
  }

  // Originals win on date conflicts
  const byDate = new Map<string, NavLogRow>()
  for (const r of synthetic) byDate.set(r.nav_date, r)
  for (const r of navRows) byDate.set(r.nav_date, r)
  return Array.from(byDate.values()).sort((a, b) =>
    a.nav_date < b.nav_date ? -1 : a.nav_date > b.nav_date ? 1 : 0
  )
}

// ─── The walker ─────────────────────────────────────────────────────────────

/**
 * Walk fee periods deterministically. Pure function.
 *
 * Caller decides what to do with computedPeriods (write to fee_periods table,
 * render in cockpit, format into Claude prompt, etc.).
 *
 * Skip conditions (ok=true, ranWalk=false):
 *   - config.fee_model = 'none'
 *   - config.fee_relationship_start_date is null
 *   - generatePeriods returns empty (relationshipStart in future)
 *
 * Coherence failures (ok=false, ranWalk=false):
 *   - fee_model='fixed_annual' but fixed_annual_fee_ngn is null
 *   - fee_model startsWith 'performance_' but performance_fee_split is null
 *   - generatePeriods throws
 *   - performance-fee mode but seed nav <= 0 (v27am-fix2 atomic-failure guard)
 *
 * Normal walks return ok=true, ranWalk=true. computedPeriods is non-empty
 * unless every period has a preserved (paid/invoiced/waived) row.
 */
export function walkPeriods(input: WalkPeriodsInput): WalkPeriodsOutcome {
  const { config, navRows, txRows, preservedRows, asOf } = input
  const feeModel = config.fee_model

  // ─── Skip conditions ────────────────────────────────────────
  if (feeModel === 'none') {
    return { ok: true, reason: 'fee_model is none', computedPeriods: [], periodsPreserved: 0, ranWalk: false }
  }
  if (!config.fee_relationship_start_date) {
    return { ok: true, reason: 'fee_relationship_start_date is null', computedPeriods: [], periodsPreserved: 0, ranWalk: false }
  }

  // ─── Coherence checks ───────────────────────────────────────
  if (feeModel === 'fixed_annual' && config.fixed_annual_fee_ngn == null) {
    return { ok: false, reason: 'fee_model=fixed_annual but fixed_annual_fee_ngn is null', computedPeriods: [], periodsPreserved: 0, ranWalk: false }
  }
  if (feeModel.startsWith('performance_') && config.performance_fee_split == null) {
    return { ok: false, reason: 'performance_fee_split is null', computedPeriods: [], periodsPreserved: 0, ranWalk: false }
  }

  // ─── Generate periods ───────────────────────────────────────
  const relationshipStart = new Date(config.fee_relationship_start_date)
  let periods: FeePeriod[]
  try {
    periods = generatePeriods(relationshipStart, asOf, config.fee_year_end_md)
  } catch (e: any) {
    return { ok: false, reason: `period generation failed: ${e?.message ?? e}`, computedPeriods: [], periodsPreserved: 0, ranWalk: false }
  }

  if (periods.length === 0) {
    return { ok: true, reason: 'no periods to compute (relationshipStart in future?)', computedPeriods: [], periodsPreserved: 0, ranWalk: false }
  }

  // ─── Opening NAV coherence guard (v27am-fix2 atomic-failure design) ──
  // For performance-fee modes, the engine cannot compute without a positive
  // opening NAV at the first period_start. Refuse early rather than silently
  // underbill (the div-by-zero defensive guard inside computePeriodFee would
  // otherwise return gross_return=0 and zero fees).
  if (feeModel.startsWith('performance_')) {
    const seedNav = resolveNavAtOrBefore(navRows, periods[0].period_start)
    if (seedNav <= 0) {
      return {
        ok: false,
        reason:
          `opening_nav resolves to 0 at first period_start (${periods[0].period_start}). ` +
          `Performance-fee modes require a positive opening NAV. Verify nav_log ` +
          `coverage at-or-before fee_relationship_start_date, or push the anchor ` +
          `to the earliest nav_log entry.`,
        computedPeriods: [],
        periodsPreserved: 0,
        ranWalk: false,
      }
    }
  }

  // ─── Build preserved-period map ─────────────────────────────
  const preservedByStart = new Map<string, { closing_hwm: number | null }>()
  for (const r of preservedRows) {
    preservedByStart.set(r.period_start, { closing_hwm: r.closing_hwm })
  }
  const periodsPreserved = preservedByStart.size

  // ─── Walk ──────────────────────────────────────────────────
  const isHwmModel = feeModel === 'performance_hwm' || feeModel === 'performance_combined'
  let runningHwm: number | null = null
  const computedPeriods: ComputedPeriod[] = []

  for (let i = 0; i < periods.length; i++) {
    const period = periods[i]
    const periodStart = new Date(period.period_start)
    const periodEnd = new Date(period.period_end)

    const openingNav = resolveNavAtOrBefore(navRows, period.period_start)
    const closingNav = resolveNavAtOrBefore(navRows, period.period_end, openingNav)
    const periodHighNav = resolvePeriodHigh(navRows, period.period_start, period.period_end, closingNav)

    const { contributions, withdrawals } = sumFlowsInWindow(txRows, period.period_start, period.period_end)
    const netFlows = contributions - withdrawals
    const cwaFactor = computeCwaFactor(openingNav, closingNav, netFlows)

    // Initialise running HWM on first period for HWM models (matches v27am
    // pre-preservation-check ordering exactly)
    if (isHwmModel && runningHwm == null) runningHwm = openingNav

    // Preserved-period short-circuit
    const preserved = preservedByStart.get(period.period_start)
    if (preserved) {
      if (isHwmModel && preserved.closing_hwm != null) {
        runningHwm = preserved.closing_hwm
      }
      continue
    }

    // HWM-1: flow-adjusted opening HWM (only for HWM models)
    const openingHwmAdj: number | null = isHwmModel
      ? applyHwm1FlowAdjustment(runningHwm, openingNav, contributions, withdrawals)
      : null

    // Compute fee
    const result = computePeriodFee({
      portfolio: {
        fee_model: feeModel,
        target_return: config.target_return,
        performance_fee_split: config.performance_fee_split,
        fixed_annual_fee_ngn: config.fixed_annual_fee_ngn,
        fee_year_end_md: config.fee_year_end_md,
      },
      period_start: periodStart,
      period_end: periodEnd,
      opening_nav: openingNav,
      closing_nav: closingNav,
      contributions,
      withdrawals,
      cwa_factor: cwaFactor,
      opening_hwm: openingHwmAdj,
      period_high_nav: isHwmModel ? periodHighNav : null,
    })

    if (!result) continue  // coherence failure or unknown branch — skip silently per v27am

    // HWM-2: closing HWM crystallisation
    const closingHwm: number | null = isHwmModel
      ? applyHwm2Crystallisation(openingHwmAdj, closingNav, result.fee_earned)
      : null

    if (isHwmModel && closingHwm != null) {
      runningHwm = closingHwm
    }

    computedPeriods.push({
      period_start: period.period_start,
      period_end: period.period_end,
      opening_hwm: isHwmModel ? openingHwmAdj : null,
      closing_hwm: closingHwm,
      period_high_nav: isHwmModel ? periodHighNav : null,
      opening_nav: openingNav,
      closing_nav: closingNav,
      contributions,
      withdrawals,
      cwa_factor: cwaFactor,
      gross_period_return_pct: result.gross_period_return_pct,
      excess_above_threshold: result.excess_above_threshold,
      hwm_excess_amount: result.hwm_excess_amount,
      qualifying_excess: result.qualifying_excess,
      fee_earned: result.fee_earned,
      fee_model_snapshot: result.fee_model_snapshot,
      performance_fee_threshold_snapshot: result.performance_fee_threshold_snapshot,
      performance_fee_split_snapshot: result.performance_fee_split_snapshot,
      fixed_annual_fee_ngn_snapshot: result.fixed_annual_fee_ngn_snapshot,
    })
  }

  return {
    ok: true,
    reason: computedPeriods.length === 0 ? 'no rows produced (all periods preserved or coherence-skipped)' : undefined,
    computedPeriods,
    periodsPreserved,
    ranWalk: true,
  }
}
