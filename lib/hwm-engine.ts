/**
 * lib/hwm-engine.ts — v27av
 *
 * Per-portfolio fee period persistence wrapper.
 *
 * As of v27av, the math has been extracted to lib/fee-math.ts. This file is
 * responsible only for:
 *   1. Loading portfolio config + nav_log + transactions + preserved rows from DB
 *   2. Calling walkPeriods (Mode 1: production, no overrides, no projection)
 *   3. Wiping pending/superseded fee_periods rows
 *   4. Inserting computed rows
 *   5. Returning HwmEngineResult (shape preserved for caller compatibility)
 *
 * All semantic guarantees from v27am-fix2 preserved byte-identical:
 *   - Idempotency: wipes pending/superseded only; preserves paid/invoiced/waived
 *   - Skip on fee_model=none, skip on null anchor
 *   - Coherence fail on fixed_annual without amount, performance without split
 *   - v27am-fix1 nav_log fetch from inception (no lower bound)
 *   - v27am-fix2 atomic-failure on seed_nav <= 0
 *   - HWM-1 (CWA on flows) and HWM-2 (fee crystallisation) for HWM/combined modes
 *   - Snapshot fields preserved for already-billed periods
 *
 * Validation gate: SQL diff of fee_periods rows pre/post v27av deploy must be
 * empty across all 8 anchored portfolios.
 */

import {
  walkPeriods,
  num,
  numOrNull,
  type FeeWalkConfig,
  type NavLogRow,
  type TransactionRow,
  type PreservedPeriodRow,
} from './fee-math'
import { type FeeModel } from './fee-calc'

// Minimal Supabase client shape (avoids version-locked import from supabase-js).
// Caller passes a hydrated client; the engine treats `from(...)` as opaque.
type SupabaseLike = {
  from: (table: string) => any
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

function fail(portfolioId: string, reason: string, periodsPreserved = 0): HwmEngineResult {
  return {
    ok: false,
    portfolio_id: portfolioId,
    reason,
    periods_computed: 0,
    periods_preserved: periodsPreserved,
    rows_inserted: [],
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

  const config: FeeWalkConfig = {
    fee_model: ((portfolio as any).fee_model ?? 'none') as FeeModel,
    target_return: num((portfolio as any).target_return, 0.15),
    performance_fee_split: numOrNull((portfolio as any).performance_fee_split),
    fixed_annual_fee_ngn: numOrNull((portfolio as any).fixed_annual_fee_ngn),
    fee_year_end_md: (portfolio as any).fee_year_end_md ?? '12-31',
    fee_relationship_start_date: (portfolio as any).fee_relationship_start_date ?? null,
  }

  const cutoff = asOf.toISOString().slice(0, 10)

  // ─── 2. Load nav_log (full history at-or-before asOf, v27am-fix1) ──
  // Engine needs latest row at-or-before first period_start to resolve opening
  // NAV. Do not apply a lower-bound filter — would silently zero opening_nav
  // when no exact-date match exists.
  const { data: navLogData, error: nErr } = await supabase
    .from('nav_log')
    .select('nav_date, nav_value')
    .eq('portfolio_id', portfolioId)
    .lte('nav_date', cutoff)
    .order('nav_date', { ascending: true })
    .limit(50000)

  if (nErr) return fail(portfolioId, `nav_log fetch failed: ${nErr.message}`)

  // ─── 3. Load transactions ─────────────────────────────────
  // Lower bound: anchor (or cutoff for unanchored — walker will skip anyway).
  // Walker filters flows by period boundaries internally; over-loading is safe.
  const txLowerBound = config.fee_relationship_start_date ?? cutoff

  const { data: txData, error: tErr } = await supabase
    .from('transactions')
    .select('trade_date, action, amount')
    .eq('portfolio_id', portfolioId)
    .gte('trade_date', txLowerBound)
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

  // ─── 4. Load preserved rows BEFORE wiping ────────────────
  // Preserved = paid/invoiced/waived. Walker skips re-computation for these
  // periods and rolls runningHwm forward from preserved closing_hwm.
  const { data: preservedData, error: prErr } = await supabase
    .from('fee_periods')
    .select('period_start, closing_hwm')
    .eq('portfolio_id', portfolioId)
    .in('fee_status', ['paid', 'invoiced', 'waived'])

  if (prErr) return fail(portfolioId, `preserved rows fetch failed: ${prErr.message}`)

  const preservedRows: PreservedPeriodRow[] = (preservedData ?? []).map((r: any) => ({
    period_start: r.period_start as string,
    closing_hwm: numOrNull(r.closing_hwm),
  }))

  // ─── 5. Walk (Mode 1: production, no overrides, no projection) ─────
  const walkResult = walkPeriods({
    config,
    navRows,
    txRows,
    preservedRows,
    asOf,
  })

  // Coherence failure → return without wipe (matches v27am pre-step-7 placement)
  if (!walkResult.ok) {
    return fail(portfolioId, walkResult.reason ?? 'walker failed', walkResult.periodsPreserved)
  }

  // Skip case (didn't iterate periods) → return without wipe
  if (!walkResult.ranWalk) {
    return {
      ok: true,
      portfolio_id: portfolioId,
      reason: walkResult.reason,
      periods_computed: 0,
      periods_preserved: walkResult.periodsPreserved,
      rows_inserted: [],
    }
  }

  // ─── 6. Wipe pending/superseded rows ─────────────────────
  // Reached only if walker iterated periods. Wipe is unconditional here,
  // matching v27am section-7 placement (cleans dangling rows even when all
  // current periods are preserved).
  const { error: dErr } = await supabase
    .from('fee_periods')
    .delete()
    .eq('portfolio_id', portfolioId)
    .in('fee_status', ['pending', 'superseded'])

  if (dErr) {
    return fail(portfolioId, `delete pending/superseded failed: ${dErr.message}`, walkResult.periodsPreserved)
  }

  // ─── 7. Insert computed rows ─────────────────────────────
  if (walkResult.computedPeriods.length === 0) {
    // All periods preserved (or every period coherence-skipped inside computePeriodFee).
    // Wipe done above; nothing to insert.
    return {
      ok: true,
      portfolio_id: portfolioId,
      reason: walkResult.reason,
      periods_computed: 0,
      periods_preserved: walkResult.periodsPreserved,
      rows_inserted: [],
    }
  }

  const rowsToInsert = walkResult.computedPeriods.map(cp => ({
    portfolio_id: portfolioId,
    period_start: cp.period_start,
    period_end: cp.period_end,
    opening_hwm: cp.opening_hwm,
    closing_hwm: cp.closing_hwm,
    period_high_nav: cp.period_high_nav,
    opening_nav: cp.opening_nav,
    closing_nav: cp.closing_nav,
    contributions: cp.contributions,
    withdrawals: cp.withdrawals,
    cwa_factor: cp.cwa_factor,
    gross_period_return_pct: cp.gross_period_return_pct,
    excess_above_threshold: cp.excess_above_threshold,
    hwm_excess_amount: cp.hwm_excess_amount,
    qualifying_excess: cp.qualifying_excess,
    fee_earned: cp.fee_earned,
    fee_status: 'pending',
    fee_model_snapshot: cp.fee_model_snapshot,
    performance_fee_threshold_snapshot: cp.performance_fee_threshold_snapshot,
    performance_fee_split_snapshot: cp.performance_fee_split_snapshot,
    fixed_annual_fee_ngn_snapshot: cp.fixed_annual_fee_ngn_snapshot,
  }))

  const { data: inserted, error: iErr } = await supabase
    .from('fee_periods')
    .insert(rowsToInsert)
    .select('id, period_start, period_end, fee_earned, fee_status')

  if (iErr) {
    return fail(portfolioId, `insert failed: ${iErr.message}`, walkResult.periodsPreserved)
  }

  return {
    ok: true,
    portfolio_id: portfolioId,
    periods_computed: rowsToInsert.length,
    periods_preserved: walkResult.periodsPreserved,
    rows_inserted: (inserted ?? []).map((r: any) => ({
      id: r.id as string,
      period_start: r.period_start as string,
      period_end: r.period_end as string,
      fee_earned: num(r.fee_earned, 0),
      fee_status: r.fee_status as string,
    })),
  }
}
