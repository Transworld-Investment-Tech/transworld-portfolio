import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import {
  fetchAllActivePortfolios,
  buildWatchlistPulse,
} from '@/lib/cockpit-aggregations'

export const maxDuration = 60

// v27d — Cockpit Watchlist Pulse endpoint
//
// Returns active equity-watchlist tickers that are unheld by any active
// portfolio AND have |day_change| ≥ 2.0% today. Drives the
// WatchlistPulsePanel on / (Firm Cockpit).

export async function GET(_req: NextRequest) {
  try {
    const db = supabaseAdmin()
    const portfolios = await fetchAllActivePortfolios(db)
    const data = await buildWatchlistPulse(db, portfolios, 2.0, 10)
    return NextResponse.json(data)
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 })
  }
}
