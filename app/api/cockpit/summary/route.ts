import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import {
  fetchAllActivePortfolios,
  computeAllPortfolioNAVs,
  buildFirmAUMTrend,
  buildFirmAllocationRollup,
  buildIdleCashFlags,
  buildStaleReports,
  fetchFeeOutlookInputs,
} from '@/lib/cockpit-aggregations'
import { computeFeeOutlook } from '@/lib/fee-outlook'

export const maxDuration = 60

// v27 — Cockpit summary endpoint
//
// Returns a single fat JSON payload powering:
//   - KPI strip (Total AUM, Active Mandates, Projected Annual Fees, Stale Reports)
//   - Firm AUM trend (12mo line)
//   - Firm allocation rollup (donut)
//   - Idle Cash flags
//   - Stale Reports flags
//
// Mandate Health and Fee Outlook tables are split into their own endpoints
// (/api/cockpit/health, /api/cockpit/fee-outlook) so the cockpit page can
// stagger loading.

export async function GET(_req: NextRequest) {
  try {
    const db = supabaseAdmin()

    const portfolios = await fetchAllActivePortfolios(db)
    const portfolioIds = portfolios.map(p => p.id)

    if (portfolios.length === 0) {
      return NextResponse.json({
        kpis: { total_aum_ngn: 0, active_mandates: 0, projected_annual_fees_ngn: 0, mandates_earning_fee: 0, stale_reports_count: 0 },
        aum_trend: [],
        allocation_rollup: [],
        idle_cash: [],
        stale_reports: [],
      })
    }

    const [navMap, aumTrend, allocationRollup, feeInputsMap] = await Promise.all([
      computeAllPortfolioNAVs(db, portfolioIds),
      buildFirmAUMTrend(db, 12),
      buildFirmAllocationRollup(db, portfolioIds),
      fetchFeeOutlookInputs(db, portfolios),
    ])

    const idleCash    = await buildIdleCashFlags(db, portfolios, navMap)
    const staleReports = await buildStaleReports(db, portfolios, 100)

    // Compute fee outlook for each non-internal portfolio to derive firm KPI
    let projectedFees = 0
    let mandatesEarningFee = 0
    for (const p of portfolios) {
      if (p.is_internal) continue
      const inputs = feeInputsMap.get(p.id) ?? { navAtYearStart: null, yearlyCashflows: [] }
      const totalNAV = navMap.get(p.id) ?? 0
      const fo = computeFeeOutlook({
        portfolio: {
          id: p.id,
          name: p.name,
          starting_nav: p.starting_nav,
          start_date: p.start_date,
          client: { name: p.client_name, code: p.client_code, type: p.client_type },
          // v27ao: pass-through fee-architecture columns
          fee_model: p.fee_model,
          fixed_annual_fee_ngn: p.fixed_annual_fee_ngn,
          target_return: p.target_return,
          performance_fee_split: p.performance_fee_split,
        },
        totalNAV,
        navAtYearStart: inputs.navAtYearStart,
        yearlyCashflows: inputs.yearlyCashflows,
      })
      projectedFees += fo.projected_annual_fee
      if (fo.projected_annual_fee > 0) mandatesEarningFee++
    }

    const totalAUM = Array.from(navMap.values()).reduce((s, v) => s + v, 0)
    const externalMandates = portfolios.filter(p => !p.is_internal).length

    return NextResponse.json({
      kpis: {
        total_aum_ngn:               totalAUM,
        active_mandates:             externalMandates,
        total_active_portfolios:     portfolios.length,
        projected_annual_fees_ngn:   projectedFees,
        mandates_earning_fee:        mandatesEarningFee,
        stale_reports_count:         staleReports.length,
      },
      aum_trend:         aumTrend,
      allocation_rollup: allocationRollup,
      idle_cash:         idleCash,
      stale_reports:     staleReports,
    })
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 })
  }
}
