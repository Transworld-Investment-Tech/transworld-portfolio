import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { reconstructPortfolioNav } from '@/lib/nav-reconstruct'

// v27g: Refactored to delegate per-portfolio reconstruction to
// lib/nav-reconstruct.ts. The same helper is now called from
// app/api/broker/sessions/[id]/commit/route.ts step 12 (auto-fire
// post broker-commit, closes pitfall #86 second half) and from
// app/api/broker/sessions/[id]/apply-reconciliation/route.ts.
//
// Firm-wide behaviour preserved bit-for-bit: distinct dates are fetched
// ONCE via get_distinct_market_price_dates RPC (v27f, pitfall #92 fix),
// then passed into each per-portfolio call to avoid N redundant RPC hits.
//
// History: v21o-hotfix-1 raised allDates limit to 50k; v27f replaced
// the row-fetch-then-dedupe with an RPC; v27g extracted the per-portfolio
// algorithm into lib so it can be reused at commit time.

export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(req: NextRequest) {
  try {
    const body        = await req.json().catch(() => ({}))
    const portfolioId = body.portfolioId as string | undefined

    const db = supabaseAdmin()

    // ── 1. Determine portfolios ────────────────────────────────────────
    let portfolioIds: string[]
    if (portfolioId) {
      portfolioIds = [portfolioId]
    } else {
      const { data: pf } = await db
        .from('portfolios')
        .select('id')
        .eq('status', 'active')
      portfolioIds = (pf ?? []).map((p: any) => p.id as string)
    }

    if (portfolioIds.length === 0) {
      return NextResponse.json({ ok: true, message: 'No active portfolios', navEntriesAdded: 0 })
    }

    // ── 2. Fetch distinct dates ONCE for the whole loop (v27f RPC) ──
    const { data: dateRows, error: dateErr } = await db
      .rpc('get_distinct_market_price_dates')

    if (dateErr) {
      return NextResponse.json(
        { error: `Failed to fetch distinct dates: ${dateErr.message}` },
        { status: 500 }
      )
    }

    const allDates = ((dateRows ?? []) as { price_date: string }[])
      .map(r => r.price_date)
      .sort()

    if (allDates.length === 0) {
      return NextResponse.json({ ok: true, message: 'No price dates in market_prices', navEntriesAdded: 0 })
    }

    // ── 3. Process each portfolio via lib helper ────────────────────
    let totalNavEntriesAdded = 0
    const portfolioResults: any[] = []

    for (const pfId of portfolioIds) {
      const result = await reconstructPortfolioNav(db, pfId, allDates)
      totalNavEntriesAdded += result.navEntriesAdded
      portfolioResults.push(result)
    }

    return NextResponse.json({
      ok:                  true,
      navEntriesAdded:     totalNavEntriesAdded,
      portfoliosProcessed: portfolioIds.length,
      totalDatesAvailable: allDates.length,
      portfolioResults,
    })
  } catch (err: any) {
    console.error('[reconstruct-nav]', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
