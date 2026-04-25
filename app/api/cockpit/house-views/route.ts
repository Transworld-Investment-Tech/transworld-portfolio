import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import {
  fetchAllActivePortfolios,
  buildHouseViews,
} from '@/lib/cockpit-aggregations'

export const maxDuration = 60

// v27d — Cockpit House Views endpoint
//
// Returns tickers held by ≥2 active portfolios across the firm.
// Drives the HouseViewsPanel on / (Firm Cockpit).

export async function GET(_req: NextRequest) {
  try {
    const db = supabaseAdmin()
    const portfolios = await fetchAllActivePortfolios(db)
    const data = await buildHouseViews(db, portfolios)
    return NextResponse.json(data)
  } catch (e: any) {
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 })
  }
}
