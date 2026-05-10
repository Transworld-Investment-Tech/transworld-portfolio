import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import {
  fetchAllActivePortfolios,
  computeAllPortfolioNAVs,
} from '@/lib/cockpit-aggregations'
import { computeFeeOutlook } from '@/lib/fee-outlook'
import { fetchFeeOutlookEngineInputs } from '@/lib/fee-outlook-fetchers'

export const maxDuration = 60

// v27aw — Cockpit Fee Outlook endpoint
//
// Returns one FeeOutlook per active portfolio. Sorted by excess_ngn ASC
// (worst at top), with internal portfolios at bottom.
//
// Engine ground-truth crystallised fees (from fee_periods) and hold-flat
// year-end projection (from walker) computed per portfolio. Anchor-aware:
// unanchored fee-bearing portfolios short-circuit to status='unanchored'.

export async function GET(_req: NextRequest) {
  try {
    const db = supabaseAdmin()

    const portfolios = await fetchAllActivePortfolios(db)
    const portfolioIds = portfolios.map(p => p.id)

    if (portfolios.length === 0) {
      return NextResponse.json({ portfolios: [] })
    }

    const [navMap, engineInputsMap] = await Promise.all([
      computeAllPortfolioNAVs(db, portfolioIds),
      fetchFeeOutlookEngineInputs(db, portfolioIds),
    ])

    const results = portfolios.map(p => {
      const inputs = engineInputsMap.get(p.id)
      const totalNAV = navMap.get(p.id) ?? 0
      return computeFeeOutlook({
        portfolio: {
          id: p.id,
          name: p.name,
          starting_nav: p.starting_nav,
          start_date: p.start_date,
          client: { name: p.client_name, code: p.client_code, type: p.client_type },
          fee_model: p.fee_model,
          fixed_annual_fee_ngn: p.fixed_annual_fee_ngn,
          target_return: p.target_return,
          performance_fee_split: p.performance_fee_split,
          // v27aw: anchor + year_end_md from supplemental fetch
          fee_year_end_md: inputs?.feeYearEndMd ?? null,
          fee_relationship_start_date: inputs?.feeRelationshipStartDate ?? null,
        },
        totalNAV,
        navRows: inputs?.navRows ?? [],
        txRows: inputs?.txRows ?? [],
        preservedRows: inputs?.preservedRows ?? [],
        crystallisedYtdFee: inputs?.crystallisedYtdFee ?? 0,
        todaysPending: inputs?.todaysPending ?? null,
      })
    })

    // Sort: non-internal first by excess_ngn ASC (worst-at-risk first),
    // then internal at bottom.
    results.sort((a, b) => {
      if (a.is_internal !== b.is_internal) return a.is_internal ? 1 : -1
      return a.excess_ngn - b.excess_ngn
    })

    return NextResponse.json({ portfolios: results })
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 })
  }
}
