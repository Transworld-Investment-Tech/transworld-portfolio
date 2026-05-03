import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import {
  fetchAllActivePortfolios,
  buildWatchlistPulse,
} from '@/lib/cockpit-aggregations'

export const maxDuration = 60

// v27d → v27aq — Cockpit Watchlist Pulse endpoint (windowed)
//
// Returns active equity-watchlist tickers unheld by any active portfolio,
// across four rolling windows with per-window thresholds:
//   - day     (0d):   |change| ≥ 2.0%
//   - week    (7d):   |change| ≥ 5.0%
//   - month   (30d):  |change| ≥ 10.0%
//   - quarter (90d):  |change| ≥ 20.0%
//
// Each window self-reports instruments_with_data so the panel can render
// data-sufficiency banners. Drives WatchlistPulsePanel on / (Firm Cockpit).

export async function GET(_req: NextRequest) {
  try {
    const db = supabaseAdmin()
    const portfolios = await fetchAllActivePortfolios(db)
    // v27aq: thresholds are now per-window (baked into builder), no args needed
    const data = await buildWatchlistPulse(db, portfolios)
    return NextResponse.json(data)
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 })
  }
}
