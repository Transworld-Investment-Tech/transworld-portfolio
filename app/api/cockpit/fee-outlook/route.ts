import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import {
  fetchAllActivePortfolios,
  computeAllPortfolioNAVs,
  fetchFeeOutlookInputs,
} from '@/lib/cockpit-aggregations'
import { computeFeeOutlook } from '@/lib/fee-outlook'

export const maxDuration = 60

// v27 — Cockpit Fee Outlook endpoint
//
// Returns one FeeOutlook result per active portfolio, sorted by excess_ngn ascending
// (worst at top — most at-risk-of-zero-fee shows first).

export async function GET(_req: NextRequest) {
  try {
    const db = supabaseAdmin()

    const portfolios = await fetchAllActivePortfolios(db)
    const portfolioIds = portfolios.map(p => p.id)

    if (portfolios.length === 0) {
      return NextResponse.json({ portfolios: [] })
    }

    const [navMap, feeInputsMap] = await Promise.all([
      computeAllPortfolioNAVs(db, portfolioIds),
      fetchFeeOutlookInputs(db, portfolios),
    ])

    const results = portfolios.map(p => {
      const inputs = feeInputsMap.get(p.id) ?? { navAtYearStart: null, yearlyCashflows: [] }
      const totalNAV = navMap.get(p.id) ?? 0
      return computeFeeOutlook({
        portfolio: {
          id: p.id,
          name: p.name,
          starting_nav: p.starting_nav,
          start_date: p.start_date,
          client: { name: p.client_name, code: p.client_code, type: p.client_type },
        },
        totalNAV,
        navAtYearStart: inputs.navAtYearStart,
        yearlyCashflows: inputs.yearlyCashflows,
      })
    })

    // Sort: non-internal first by excess_ngn ASC (worst first), then internal at bottom
    results.sort((a, b) => {
      if (a.is_internal !== b.is_internal) return a.is_internal ? 1 : -1
      return a.excess_ngn - b.excess_ngn
    })

    return NextResponse.json({ portfolios: results })
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 })
  }
}
