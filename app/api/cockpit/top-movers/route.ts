import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import {
  fetchAllActivePortfolios,
  buildTopMovers,
} from '@/lib/cockpit-aggregations'

export const maxDuration = 60

// v27c → v27ap — Top Movers endpoint (windowed)
//
// Returns gainers/losers across four rolling windows:
//   - day     (0d):   feed-supplied day_change column
//   - week    (7d):   vs closest price_date ≤ 7 days ago
//   - month   (30d):  vs closest price_date ≤ 30 days ago
//   - quarter (90d):  vs closest price_date ≤ 90 days ago
//
// Each window weighted by aggregate NGN exposure. Each window self-reports
// instruments_with_data / total_held_instruments so the panel can render
// data-sufficiency banners honestly. Month/quarter populate naturally as
// NGX price history accumulates.
//
// Equity-only — NGX bonds aren't priced daily.

export async function GET(_req: NextRequest) {
  try {
    const db = supabaseAdmin()
    const portfolios = await fetchAllActivePortfolios(db)
    if (portfolios.length === 0) {
      // v27ap: return all four windows empty rather than legacy flat shape
      const emptyWindow = (days: number) => ({
        gainers: [], losers: [], as_of_date: null,
        lookback_target_days: days,
        instruments_with_data: 0,
        total_held_instruments: 0,
      })
      return NextResponse.json({
        day:     emptyWindow(0),
        week:    emptyWindow(7),
        month:   emptyWindow(30),
        quarter: emptyWindow(90),
      })
    }
    const movers = await buildTopMovers(db, portfolios)
    return NextResponse.json(movers)
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 })
  }
}
