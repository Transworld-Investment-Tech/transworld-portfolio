// lib/fee-outlook-fetchers.ts — v27aw
//
// Bulk fetchers for the cockpit Fee Outlook engine. Replaces v27ao's
// fetchFeeOutlookInputs in lib/cockpit-aggregations.ts (now obsolete; left
// in place to avoid touching the 1,654-line file — pitfall #131 territory).
//
// Returns per-portfolio:
//   - navRows: nav_log rows since earliest anchor
//   - txRows: TRANSFER_IN/TRANSFER_OUT since earliest anchor
//   - preservedRows: paid/invoiced/waived fee_periods rows (for HWM continuity)
//   - crystallisedYtdFee: sum of pending fee_periods.fee_earned (engine ground truth)
//   - todaysPending: latest pending row metrics (excess, target NAV components)
//   - feeRelationshipStartDate, feeYearEndMd: per-portfolio columns missing
//     from fetchAllActivePortfolios; supplemental fetch.
//
// Bulk queries grouped by portfolio_id in JS to minimise round-trips.
// Conservative fetch floor (earliest anchor) avoids over-loading nav_log.

import type { SupabaseClient } from '@supabase/supabase-js'
import {
  num,
  numOrNull,
  type NavLogRow,
  type TransactionRow,
  type PreservedPeriodRow,
} from './fee-math'
import type { TodaysPendingRow } from './fee-outlook'

export interface FeeOutlookEngineInputs {
  navRows:                   NavLogRow[]
  txRows:                    TransactionRow[]
  preservedRows:             PreservedPeriodRow[]
  crystallisedYtdFee:        number
  todaysPending:             TodaysPendingRow | null
  feeRelationshipStartDate:  string | null
  feeYearEndMd:              string | null
}

export async function fetchFeeOutlookEngineInputs(
  db: SupabaseClient,
  portfolioIds: string[]
): Promise<Map<string, FeeOutlookEngineInputs>> {
  const out = new Map<string, FeeOutlookEngineInputs>()
  if (portfolioIds.length === 0) return out

  // Initialise empty entries for every portfolio so callers get a defined map
  for (const id of portfolioIds) {
    out.set(id, {
      navRows:                   [],
      txRows:                    [],
      preservedRows:             [],
      crystallisedYtdFee:        0,
      todaysPending:             null,
      feeRelationshipStartDate:  null,
      feeYearEndMd:              null,
    })
  }

  // ─── Supplemental portfolio columns ──────────────────────────
  // fetchAllActivePortfolios returns fee_model + fee_split + fixed_annual_fee
  // + target_return, but NOT fee_relationship_start_date or fee_year_end_md.
  // Single supplemental query; merge into the map.
  const { data: portfolioMeta } = await db
    .from('portfolios')
    .select('id, fee_relationship_start_date, fee_year_end_md')
    .in('id', portfolioIds)

  const anchorDates: string[] = []
  for (const p of (portfolioMeta ?? []) as any[]) {
    const entry = out.get(p.id)
    if (entry) {
      entry.feeRelationshipStartDate = p.fee_relationship_start_date ?? null
      entry.feeYearEndMd = p.fee_year_end_md ?? null
    }
    if (p.fee_relationship_start_date) {
      anchorDates.push(p.fee_relationship_start_date)
    }
  }

  // v27aw-fix2: fetch floor must be BEFORE the earliest anchor to allow
  // at-or-before resolution for portfolios whose anchor sits at the earliest
  // date in the universe. Pre-fix2 the floor equalled the earliest anchor
  // exactly, so a portfolio anchored 2026-01-01 couldn't find a nav_log row
  // dated 2025-12-31 (or any earlier weekend/year-end snapshot) — Starting
  // NAV in the cockpit panel would render '—' even though the row existed
  // in nav_log (per-portfolio IRR audit panels resolve via full history and
  // saw it correctly). Buffer of 365 days is generous; nav_log row counts
  // stay well under the 50000 limit because the floor never goes deeper
  // than 1 year pre-earliest-anchor.
  const yearStart = `${new Date().getFullYear()}-01-01`
  const earliestNeeded = anchorDates.length > 0 ? anchorDates.sort()[0] : yearStart
  const floorDate = new Date(earliestNeeded)
  floorDate.setDate(floorDate.getDate() - 365)
  const fetchFloor = floorDate.toISOString().slice(0, 10)

  // ─── Bulk nav_log fetch ──────────────────────────────────────
  const { data: navData } = await db
    .from('nav_log')
    .select('portfolio_id, nav_date, nav_value')
    .in('portfolio_id', portfolioIds)
    .gte('nav_date', fetchFloor)
    .order('nav_date', { ascending: true })
    .limit(50000)

  for (const r of (navData ?? []) as any[]) {
    const entry = out.get(r.portfolio_id)
    if (entry) {
      entry.navRows.push({
        nav_date: r.nav_date as string,
        nav_value: num(r.nav_value, 0),
      })
    }
  }

  // ─── Bulk transactions fetch (TRANSFER_IN/OUT only) ──────────
  const { data: txData } = await db
    .from('transactions')
    .select('portfolio_id, trade_date, action, amount')
    .in('portfolio_id', portfolioIds)
    .in('action', ['TRANSFER_IN', 'TRANSFER_OUT'])
    .gte('trade_date', fetchFloor)
    .order('trade_date', { ascending: true })
    .limit(50000)

  for (const r of (txData ?? []) as any[]) {
    const entry = out.get(r.portfolio_id)
    if (entry) {
      entry.txRows.push({
        trade_date: r.trade_date as string,
        action: r.action as string,
        amount: numOrNull(r.amount),
      })
    }
  }

  // ─── Bulk fee_periods fetch ──────────────────────────────────
  // Pending rows: sum fee_earned into crystallisedYtdFee + track the latest
  //               pending row by period_end (for "as of today" panel metrics).
  // Preserved rows: collect paid/invoiced/waived for the walker's HWM rollover.
  const { data: feePeriodData } = await db
    .from('fee_periods')
    .select('portfolio_id, period_start, period_end, fee_status, fee_earned, closing_hwm, opening_nav, closing_nav, excess_above_threshold')
    .in('portfolio_id', portfolioIds)

  const latestPendingByPortfolio = new Map<string, any>()

  for (const r of (feePeriodData ?? []) as any[]) {
    const entry = out.get(r.portfolio_id)
    if (!entry) continue

    if (r.fee_status === 'pending') {
      entry.crystallisedYtdFee += num(r.fee_earned, 0)
      const cur = latestPendingByPortfolio.get(r.portfolio_id)
      if (!cur || (r.period_end as string) > (cur.period_end as string)) {
        latestPendingByPortfolio.set(r.portfolio_id, r)
      }
    } else if (r.fee_status === 'paid' || r.fee_status === 'invoiced' || r.fee_status === 'waived') {
      entry.preservedRows.push({
        period_start: r.period_start as string,
        closing_hwm: numOrNull(r.closing_hwm),
      })
    }
  }

  // Hydrate todaysPending with the latest-pending row's "as of today" metrics.
  // These are engine ground truth — closer to the truth than re-deriving in
  // the cockpit layer.
  for (const [portfolioId, row] of latestPendingByPortfolio) {
    const entry = out.get(portfolioId)
    if (entry) {
      entry.todaysPending = {
        fee_earned:              num(row.fee_earned, 0),
        excess_above_threshold:  numOrNull(row.excess_above_threshold),
        closing_nav:             numOrNull(row.closing_nav),
        opening_nav:             numOrNull(row.opening_nav),
      }
    }
  }

  return out
}
