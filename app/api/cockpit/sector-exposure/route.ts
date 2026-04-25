import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import {
  fetchAllActivePortfolios,
  computeAllPortfolioNAVs,
  buildSectorExposureGrid,
} from '@/lib/cockpit-aggregations'

export const maxDuration = 60

// v27c — Sector Exposure Grid endpoint
//
// Returns firm × portfolios sector heatmap (equity sleeve only).
//   - sectors: array of distinct sectors sorted desc by firm-wide exposure
//   - firm_totals: ngn per sector firm-wide
//   - firm_total: total firm equity NAV across all sectors
//   - portfolios: per-portfolio rows with sectors map (ngn per sector)

export async function GET(_req: NextRequest) {
  try {
    const db = supabaseAdmin()
    const portfolios = await fetchAllActivePortfolios(db)
    if (portfolios.length === 0) {
      return NextResponse.json({
        sectors: [], firm_totals: {}, firm_total: 0, portfolios: [],
      })
    }
    const portfolioIds = portfolios.map(p => p.id)
    const navMap = await computeAllPortfolioNAVs(db, portfolioIds)
    const grid = await buildSectorExposureGrid(db, portfolios, navMap)
    return NextResponse.json(grid)
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 })
  }
}
