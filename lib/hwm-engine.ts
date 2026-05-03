/**
 * lib/hwm-engine.ts — v27am
 *
 * Per-portfolio fee period walker. Anchored on fee_relationship_start_date.
 * Generates fee_periods rows by walking nav_log + transactions period by period.
 *
 * Idempotency contract:
 *   - Wipes fee_periods rows where fee_status IN ('pending','superseded')
 *   - Preserves rows where fee_status IN ('paid','invoiced','waived')
 *   - For preserved periods: skips re-computation; rolls runningHwm forward
 *     using the preserved row's closing_hwm to maintain HWM continuity
 *   - Inserts fresh 'pending' rows only for periods without a preserved row
 *   - Running twice produces same final state (no UNIQUE violations against
 *     fee_periods (portfolio_id, period_start) constraint)
 *
 * Skip conditions (return ok=true, periods_computed=0, with reason):
 *   - portfolio.fee_model = 'none'
 *   - portfolio.fee_relationship_start_date IS NULL
 *
 * Coherence failures (return ok=false):
 *   - fee_model='fixed_annual' but fixed_annual_fee_ngn is null
 *   - fee_model startsWith 'performance_' but performance_fee_split is null
 *
 * HWM-1 (CWA): contribution-weighted HWM adjustments on flows.
 *   - Deposits raise HWM by face value (deposit gets locked in at NAV-on-date)
 *   - Withdrawals lower HWM proportionally to withdrawal-as-pct-of-NAV
 *
 * HWM-2: fee crystallisation. Closing HWM = max(opening_hwm_after_flows,
 *   closing_nav − fee_earned). Prevents fee-on-fee compounding.
 *
 * Note: HWM machinery ships in v27am but no active portfolio uses
 * performance_hwm or performance_combined. First live HWM portfolio will
 * calibrate the CWA formulation against client expectations.
 */

import { generatePeriods, type FeePeriod } from './fee-periods'
import { computePeriodFee, type FeeModel } from './fee-calc'

// Minimal Supabase client shape (avoids version-locked import from supabase-js).
// Caller passes a hydrated client; the engine treats `from(...)` as opaque.
type SupabaseLike = {
  from: (table: string) => any
}

interface PortfolioForFeeWalk {
  id: string
  fee_model: FeeModel | null
  target_return: number | string | null
  performance_fee_split: number | string | null
  fixed_annual_fee_ngn: number | string | null
  fee_year_end_md: string | null
  fee_relationship_start_date: string | null
  start_date: string | null
}

interface NavLogRow {
  nav_date: string
  nav_value: number
}

interface TransactionRow {
  trade_date: string
  action: string
  amount: number | null
}

export interface HwmEngineResult {
  ok: boolean
  portfolio_id: string
  reason?: string
  periods_computed: number
  periods_preserved: number
  rows_inserted: Array<{
    id: string
    period_start: string
    period_end: string
    fee_earned: number
    fee_status: string
  }>
}

// Numeric coercion at the Supabase boundary (pitfall #72)
function num(v: any, fallback = 0): number {
  if (v === null || v === undefined || v === '') return fallback
  const n = typeof v === 'string' ? parseFloat(v) : v
  return Number.isFinite(n) ? n : fallback
}

function numOrNull(v: any): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'string' ? parseFloat(v) : v
  return Number.isFinite(n) ? n : null
}

function skip(portfolioId: string, reason: string): HwmEngineResult {
  return {
    ok: true, portfolio_id: portfolioId, reason,
    periods_computed: 0, periods_preserved: 0, rows_inserted: [],
  }
}

function fail(portfolioId: string, reason: string, periodsPreserved = 0): HwmEngineResult {
  return {
    ok: false, portfolio_id: portfolioId, reason,
    periods_computed: 0, periods_preserved: periodsPreserved, rows_inserted: [],
  }
}

export async function recomputeFeePeriodsForPortfolio(
  supabase: SupabaseLike,
  portfolioId: string,
  asOf: Date = new Date()
): Promise<HwmEngineResult> {
  // ─── 1. Load portfolio ────────────────────────────────────
  const { data: portfolio, error: pErr } = await supabase
    .from('portfolios')
    .select('id, fee_model, target_return, performance_fee_split, fixed_annual_fee_ngn, fee_year_end_md, fee_relationship_start_date, start_date')
    .eq('id', portfolioId)
    .single()

  if (pErr || !portfolio) {
    return fail(portfolioId, `portfolio not found: ${pErr?.message ?? 'no row'}`)
  }

  const p = portfolio as PortfolioForFeeWalk
  const feeModel = (p.fee_model ?? 'none') as FeeModel

  // ─── 2. Skip conditions ───────────────────────────────────
  if (feeModel === 'none') {
    return skip(portfolioId, 'fee_model is none')
  }
  if (!p.fee_relationship_start_date) {
    return skip(portfolioId, 'fee_relationship_start_date is null')
  }

  // ─── 3. Coherence checks ──────────────────────────────────
  const fixedFee = numOrNull(p.fixed_annual_fee_ngn)
  const splitPct = numOrNull(p.performance_fee_split)
  const targetReturn = num(p.target_return, 0.15)
  const feeYearEndMD = p.fee_year_end_md ?? '12-31'

  if (feeModel === 'fixed_annual' && fixedFee == null) {
    return fail(portfolioId, 'fee_model=fixed_annual but fixed_annual_fee_ngn is null')
  }
  if (feeModel.startsWith('performance_') && splitPct == null) {
    return fail(portfolioId, 'performance_fee_split is null')
  }

  // ─── 4. Generate periods ──────────────────────────────────
  const relationshipStart = new Date(p.fee_relationship_start_date)
  let periods: FeePeriod[]
  try {
    periods = generatePeriods(relationshipStart, asOf, feeYearEndMD)
  } catch (e: any) {
    return fail(portfolioId, `period generation failed: ${e?.message ?? e}`)
  }

  if (periods.length === 0) {
    return skip(portfolioId, 'no periods to compute (relationshipStart in future?)')
  }

  // ─── 5. Load nav_log + transactions ───────────────────────
  const earliestStart = periods[0].period_start
  const cutoff = asOf.toISOString().slice(0, 10)

  // v27am-fix1: nav_log fetch loads from inception. The engine needs the
  // latest row AT OR BEFORE the first period_start to resolve opening NAV.
  // The previous lower-bound filter excluded pre-period rows, leaving
  // opening_nav=0 for portfolios whose nav_log lacked an exact match on
  // period_start. For performance-fee portfolios this silently zeroed fees
  // (div-by-zero defensive guard). For fixed-annual portfolios the column
  // was wrong but fee math was unaffected (time-only). Now no lower bound.
  const { data: navLogData, error: nErr } = await supabase
    .from('nav_log')
    .select('nav_date, nav_value')
    .eq('portfolio_id', portfolioId)
    .lte('nav_date', cutoff)
    .order('nav_date', { ascending: true })
    .limit(50000)

  if (nErr) return fail(portfolioId, `nav_log fetch failed: ${nErr.message}`)

  const { data: txData, error: tErr } = await supabase
    .from('transactions')
    .select('trade_date, action, amount')
    .eq('portfolio_id', portfolioId)
    .gte('trade_date', earliestStart)
    .lte('trade_date', cutoff)
    .order('trade_date', { ascending: true })
    .limit(50000)

  if (tErr) return fail(portfolioId, `transactions fetch failed: ${tErr.message}`)

  const navRows: NavLogRow[] = (navLogData ?? []).map((r: any) => ({
    nav_date: r.nav_date as string,
    nav_value: num(r.nav_value, 0),
  }))
  const txRows: TransactionRow[] = (txData ?? []).map((r: any) => ({
    trade_date: r.trade_date as string,
    action: r.action as string,
    amount: numOrNull(r.amount),
  }))

  // ─── 6. Load preserved rows BEFORE wiping ─────────────────
  // Preserved = fee_status IN ('paid','invoiced','waived'). Skip these periods
  // in the recompute loop and use their closing_hwm to roll runningHwm forward.
  const { data: preservedRows, error: prErr } = await supabase
    .from('fee_periods')
    .select('period_start, closing_hwm')
    .eq('portfolio_id', portfolioId)
    .in('fee_status', ['paid', 'invoiced', 'waived'])

  if (prErr) return fail(portfolioId, `preserved rows fetch failed: ${prErr.message}`)

  const preservedByStart = new Map<string, { closing_hwm: number | null }>()
  for (const r of (preservedRows ?? [])) {
    preservedByStart.set(r.period_start as string, {
      closing_hwm: numOrNull(r.closing_hwm),
    })
  }
  const periodsPreserved = preservedByStart.size

  // ─── 7. Wipe pending/superseded rows ──────────────────────
  const { error: dErr } = await supabase
    .from('fee_periods')
    .delete()
    .eq('portfolio_id', portfolioId)
    .in('fee_status', ['pending', 'superseded'])

  if (dErr) {
    return fail(portfolioId, `delete pending/superseded failed: ${dErr.message}`, periodsPreserved)
  }

  // ─── 8. Walk periods, compute, accumulate HWM ─────────────
  const isHwmModel = feeModel === 'performance_hwm' || feeModel === 'performance_combined'
  let runningHwm: number | null = null
  const rowsToInsert: Array<Record<string, any>> = []

  for (let i = 0; i < periods.length; i++) {
    const period = periods[i]
    const periodStart = new Date(period.period_start)
    const periodEnd = new Date(period.period_end)

    // Opening NAV: latest nav_log row at or before period_start
    let openingNav = 0
    for (let k = navRows.length - 1; k >= 0; k--) {
      if (navRows[k].nav_date <= period.period_start) {
        openingNav = navRows[k].nav_value
        break
      }
    }

    // Closing NAV: latest nav_log row at or before period_end
    let closingNav = openingNav
    for (let k = navRows.length - 1; k >= 0; k--) {
      if (navRows[k].nav_date <= period.period_end) {
        closingNav = navRows[k].nav_value
        break
      }
    }

    // Period high: max nav_value in (period_start, period_end]
    let periodHighNav = closingNav
    for (const r of navRows) {
      if (r.nav_date > period.period_start && r.nav_date <= period.period_end) {
        if (r.nav_value > periodHighNav) periodHighNav = r.nav_value
      }
    }

    // Sum flows in (period_start, period_end] — strict on lower bound (matches
    // legacy fee-calc v27o-fix1 semantics: flows ON period_start are part of
    // opening NAV, not period flows)
    let contributions = 0
    let withdrawals = 0
    for (const t of txRows) {
      if (t.trade_date <= period.period_start || t.trade_date > period.period_end) continue
      if (t.amount == null || t.amount <= 0) continue
      if (t.action === 'TRANSFER_IN') contributions += t.amount
      else if (t.action === 'TRANSFER_OUT') withdrawals += t.amount
    }

    const netFlows = contributions - withdrawals
    const cwaFactor = openingNav > 0 ? (closingNav - netFlows) / openingNav : null

    // Initialise running HWM on first period for HWM models
    if (isHwmModel && runningHwm == null) runningHwm = openingNav

    // ─── Preserved-period short-circuit ──────────────────────
    // If this period_start has a paid/invoiced/waived row preserved,
    // skip re-computation but advance runningHwm from the preserved closing_hwm.
    const preserved = preservedByStart.get(period.period_start)
    if (preserved) {
      if (isHwmModel && preserved.closing_hwm != null) {
        runningHwm = preserved.closing_hwm
      }
      continue
    }

    // HWM-1: flow-adjusted opening HWM (only for HWM models)
    let openingHwmAdj: number | null = null
    if (isHwmModel && runningHwm != null) {
      openingHwmAdj = runningHwm + contributions  // deposits raise HWM by face
      const navBeforeWithdrawals = openingNav + contributions
      if (withdrawals > 0 && navBeforeWithdrawals > 0) {
        openingHwmAdj = openingHwmAdj * (1 - withdrawals / navBeforeWithdrawals)
      }
    }

    // Compute fee
    const result = computePeriodFee({
      portfolio: {
        fee_model: feeModel,
        target_return: targetReturn,
        performance_fee_split: splitPct,
        fixed_annual_fee_ngn: fixedFee,
        fee_year_end_md: feeYearEndMD,
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

    if (!result) continue  // coherence failure or unknown branch

    // HWM-2: closing HWM = max(opening_hwm_after_flows, closing_nav − fee_earned)
    let closingHwm: number | null = null
    if (isHwmModel && openingHwmAdj != null) {
      closingHwm = Math.max(openingHwmAdj, closingNav - result.fee_earned)
      runningHwm = closingHwm  // roll forward
    }

    rowsToInsert.push({
      portfolio_id: portfolioId,
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
      fee_status: 'pending',
      fee_model_snapshot: result.fee_model_snapshot,
      performance_fee_threshold_snapshot: result.performance_fee_threshold_snapshot,
      performance_fee_split_snapshot: result.performance_fee_split_snapshot,
      fixed_annual_fee_ngn_snapshot: result.fixed_annual_fee_ngn_snapshot,
    })
  }

  // ─── 9. Insert rows ──────────────────────────────────────
  if (rowsToInsert.length === 0) {
    return {
      ok: true, portfolio_id: portfolioId,
      reason: 'no rows produced (all periods preserved or coherence-skipped)',
      periods_computed: 0,
      periods_preserved: periodsPreserved,
      rows_inserted: [],
    }
  }

  const { data: inserted, error: iErr } = await supabase
    .from('fee_periods')
    .insert(rowsToInsert)
    .select('id, period_start, period_end, fee_earned, fee_status')

  if (iErr) {
    return fail(portfolioId, `insert failed: ${iErr.message}`, periodsPreserved)
  }

  return {
    ok: true,
    portfolio_id: portfolioId,
    periods_computed: rowsToInsert.length,
    periods_preserved: periodsPreserved,
    rows_inserted: (inserted ?? []).map((r: any) => ({
      id: r.id as string,
      period_start: r.period_start as string,
      period_end: r.period_end as string,
      fee_earned: num(r.fee_earned, 0),
      fee_status: r.fee_status as string,
    })),
  }
}
