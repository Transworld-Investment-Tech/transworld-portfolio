import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import {
  fetchAllActivePortfolios,
  buildTopMovers,
} from '@/lib/cockpit-aggregations'

export const maxDuration = 60

// v27c — Top Movers endpoint
//
// Top 5 gainers and top 5 losers across firm equity holdings,
// weighted by aggregate NGN exposure. Returns:
//   - gainers: top 5 by ngn_impact desc
//   - losers:  top 5 by ngn_impact asc (most negative first)
//   - as_of_date: max price_date observed across firm holdings
//
// Equity-only — bonds aren't priced daily on NGX.

export async function GET(_req: NextRequest) {
  try {
    const db = supabaseAdmin()
    const portfolios = await fetchAllActivePortfolios(db)
    if (portfolios.length === 0) {
      return NextResponse.json({ gainers: [], losers: [], as_of_date: null })
    }
    const movers = await buildTopMovers(db, portfolios)
    return NextResponse.json(movers)
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 })
  }
}
