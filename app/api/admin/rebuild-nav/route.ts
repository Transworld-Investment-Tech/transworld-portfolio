/**
 * app/api/admin/rebuild-nav/route.ts — v27k (NEW)
 *
 * Destructive nav_log rebuild endpoint. Wipes existing nav_log rows for
 * the target portfolio(s) and reconstructs from scratch using the v27k
 * three-level price fallback logic (market_price → lastKnownPrice → avgCost).
 *
 * Why destructive:
 *   The existing reconstructPortfolioNav helper is idempotent — it skips
 *   dates already in nav_log. After upgrading the price-fallback logic in
 *   v27k, existing rows still hold the v27g-computed values (with the
 *   day-to-day NAV oscillation bug). To pick up the new values for those
 *   dates, we have to delete + re-insert.
 *
 * Body:
 *   {portfolioId?: string}  — omit to rebuild all active portfolios
 *
 * Behaviour:
 *   1. Determine target portfolio(s)
 *   2. For each: DELETE FROM nav_log WHERE portfolio_id = ?
 *   3. For each: call reconstructPortfolioNav (which now picks up all dates
 *      since none exist after the wipe)
 *   4. Return per-portfolio summary
 *
 * After deploy and a no-body POST, the entire firm's nav_log is rebuilt
 * with the new monotonic logic.
 *
 * Triggered by:
 *   curl -X POST https://transworld-portfolio.vercel.app/api/admin/rebuild-nav
 *
 * Or for a single portfolio:
 *   curl -X POST https://transworld-portfolio.vercel.app/api/admin/rebuild-nav \
 *        -H 'Content-Type: application/json' \
 *        -d '{"portfolioId": "<uuid>"}'
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { reconstructPortfolioNav } from '@/lib/nav-reconstruct'

export const runtime = 'nodejs'
export const maxDuration = 300
export const dynamic = 'force-dynamic'

interface PortfolioResult {
  portfolioId:     string
  rowsDeleted:     number
  rowsInserted:    number
  error?:          string
}

export async function POST(req: NextRequest) {
  const started = Date.now()
  try {
    const body = await req.json().catch(() => ({}))
    const portfolioId = body.portfolioId as string | undefined

    const db = supabaseAdmin()

    let portfolioIds: string[]
    if (portfolioId) {
      portfolioIds = [portfolioId]
    } else {
      const { data: pf, error } = await db
        .from('portfolios')
        .select('id')
        .eq('status', 'active')
      if (error) {
        return NextResponse.json(
          { error: `portfolios query: ${error.message}` },
          { status: 500 }
        )
      }
      portfolioIds = (pf ?? []).map((p: any) => p.id as string)
    }

    if (portfolioIds.length === 0) {
      return NextResponse.json({
        ok: true,
        message: 'No active portfolios to rebuild',
        portfolios_processed: 0,
        results: [],
      })
    }

    // Fetch dates ONCE for the loop (matches v27f optimisation pattern)
    const { data: dateRows, error: dateErr } = await db
      .rpc('get_distinct_market_price_dates')
    if (dateErr) {
      return NextResponse.json(
        { error: `get_distinct_market_price_dates: ${dateErr.message}` },
        { status: 500 }
      )
    }
    const allDates = ((dateRows ?? []) as { price_date: string }[])
      .map(r => r.price_date)
      .sort()

    const results: PortfolioResult[] = []

    for (const pfId of portfolioIds) {
      const result: PortfolioResult = {
        portfolioId: pfId,
        rowsDeleted: 0,
        rowsInserted: 0,
      }

      try {
        // 1. Count existing rows (for reporting)
        const { count: beforeCount } = await db
          .from('nav_log')
          .select('*', { count: 'exact', head: true })
          .eq('portfolio_id', pfId)

        // 2. Wipe
        const { error: delErr } = await db
          .from('nav_log')
          .delete()
          .eq('portfolio_id', pfId)
        if (delErr) {
          result.error = `delete: ${delErr.message}`
          results.push(result)
          continue
        }
        result.rowsDeleted = beforeCount ?? 0

        // 3. Rebuild (helper now sees an empty nav_log so processes all dates)
        const r = await reconstructPortfolioNav(db, pfId, allDates)
        result.rowsInserted = r.navEntriesAdded
        if (r.error) result.error = r.error
      } catch (e: any) {
        result.error = `unexpected: ${e.message || 'unknown'}`
      }

      results.push(result)
    }

    return NextResponse.json({
      ok: true,
      portfolios_processed: portfolioIds.length,
      results,
      elapsed_ms: Date.now() - started,
    })
  } catch (err: any) {
    console.error('[admin/rebuild-nav]', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

export async function GET() {
  return NextResponse.json({
    endpoint: '/api/admin/rebuild-nav',
    method: 'POST application/json',
    body: '{ "portfolioId"?: string } — omit to rebuild all active portfolios',
    behaviour: 'DESTRUCTIVE — DELETEs existing nav_log rows then reconstructs',
    returns: 'portfolios_processed, results[]',
  })
}
