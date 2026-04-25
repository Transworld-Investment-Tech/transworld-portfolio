import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import {
  fetchAllActivePortfolios,
  computeAllPortfolioNAVs,
  fetchHoldingsForPortfolios,
  fetchSleeveTargetsForPortfolios,
  fetchNavHistoryForPortfolios,
  fetchYTDReturns,
  fetchRecentTxnCounts,
  fetchDaysSinceLastReport,
  fetchWatchlistTickers,
} from '@/lib/cockpit-aggregations'
import { computeMandateHealth } from '@/lib/mandate-health'

export const maxDuration = 60

// v27 — Cockpit Mandate Health Grid endpoint
// v27d — Now also fetches the active equity watchlist universe and passes it
//        to computeMandateHealth so the Watchlist Alignment check produces a
//        real green/amber/red instead of 'na'.
//
// Returns one MandateHealth result per active portfolio. Drives the
// MandateHealthGrid panel on / (rows = portfolios, cols = 11 checks).

export async function GET(_req: NextRequest) {
  try {
    const db = supabaseAdmin()

    const portfolios = await fetchAllActivePortfolios(db)
    const portfolioIds = portfolios.map(p => p.id)

    if (portfolios.length === 0) {
      return NextResponse.json({ portfolios: [] })
    }

    const [
      navMap,
      holdingsMap,
      sleeveTargetsMap,
      navHistoryMap,
      recentTxnMap,
      daysSinceMap,
      watchlistTickers,   // v27d
    ] = await Promise.all([
      computeAllPortfolioNAVs(db, portfolioIds),
      fetchHoldingsForPortfolios(db, portfolioIds),
      fetchSleeveTargetsForPortfolios(db, portfolioIds),
      fetchNavHistoryForPortfolios(db, portfolioIds),
      fetchRecentTxnCounts(db, portfolioIds, 90),
      fetchDaysSinceLastReport(db, portfolioIds),
      fetchWatchlistTickers(db, ['equity']),
    ])

    // YTD return needs navMap from above
    const ytdMap = await fetchYTDReturns(db, portfolios, navMap)

    const results = portfolios.map(p => {
      const holdings   = holdingsMap.get(p.id) ?? []
      const sleeveDefs = sleeveTargetsMap.get(p.id) ?? []
      const navHist    = navHistoryMap.get(p.id) ?? []
      const totalNAV   = navMap.get(p.id) ?? 0

      return computeMandateHealth({
        portfolio: {
          id: p.id,
          name: p.name,
          starting_nav: p.starting_nav,
          start_date: p.start_date,
          income_target: p.income_target,
          liq_min: p.liq_min,
          dd_alert: p.dd_alert,
          dd_action: p.dd_action,
          max_eq_single: p.max_eq_single,
          max_eq_sleeve: p.max_eq_sleeve,
          status: p.status,
          client: { name: p.client_name, code: p.client_code, type: p.client_type },
        },
        holdings,
        sleeveDefs,
        totalNAV,
        navHistory: navHist,
        recentTxnCount90d: recentTxnMap.get(p.id) ?? 0,
        daysSinceLastReport: daysSinceMap.get(p.id) ?? null,
        ytdReturn: ytdMap.get(p.id) ?? null,
        watchlistTickers,   // v27d
      })
    })

    return NextResponse.json({ portfolios: results })
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 })
  }
}
