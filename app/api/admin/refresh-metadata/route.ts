/**
 * app/api/admin/refresh-metadata/route.ts — v27h (NEW)
 *
 * One-shot firm-wide refresh of portfolios.start_date and
 * portfolios.starting_nav from transaction history.
 *
 * Why this exists:
 *   v27h drops the isStale gate from the broker commit route, so
 *   every future commit/apply re-infers metadata. But existing
 *   portfolios (DON A, DON C, and others currently sitting at
 *   starting_nav=0 because the v27g release wrote that as a placeholder
 *   before the orphan-write fix) need a one-shot refresh to pick up
 *   correct values now, without needing a fresh broker action on each.
 *
 * Algorithm:
 *   1. Optionally limited to a single portfolio via body.portfolioId
 *   2. Otherwise loops over all active portfolios
 *   3. For each, calls inferPortfolioStart and writes the result
 *   4. Returns per-portfolio summary
 *
 * Idempotent: safe to re-run. Each call recomputes from current
 * transactions and writes, so re-running never produces a different
 * result unless transactions changed in between.
 *
 * Triggered by:
 *   curl -X POST https://transworld-portfolio.vercel.app/api/admin/refresh-metadata
 *
 * Or for a single portfolio:
 *   curl -X POST https://transworld-portfolio.vercel.app/api/admin/refresh-metadata \
 *        -H 'Content-Type: application/json' \
 *        -d '{"portfolioId": "<uuid>"}'
 */

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { inferPortfolioStart } from '@/lib/portfolio-metadata'

export const runtime = 'nodejs'
export const maxDuration = 60
export const dynamic = 'force-dynamic'

interface PortfolioResult {
  portfolioId: string
  applied:     boolean
  reason:      string
  previous?:   { start_date: string | null; starting_nav: number }
  updated?:    { start_date: string; starting_nav: number; method: string }
  error?:      string
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
        message: 'No active portfolios to refresh',
        portfolios_processed: 0,
        portfolios_applied: 0,
        results: [],
      })
    }

    const results: PortfolioResult[] = []
    let appliedCount = 0

    for (const pfId of portfolioIds) {
      const result: PortfolioResult = {
        portfolioId: pfId,
        applied:     false,
        reason:      'not evaluated',
      }

      try {
        const { data: portfolioRow } = await db
          .from('portfolios')
          .select('start_date, starting_nav')
          .eq('id', pfId)
          .single()

        const previousNav = Number(portfolioRow?.starting_nav ?? 0)
        const previousStart = portfolioRow?.start_date ?? null
        result.previous = { start_date: previousStart, starting_nav: previousNav }

        const inferResult = await inferPortfolioStart(db, pfId)
        if (!inferResult.ok || !inferResult.inferred) {
          result.reason = `inference failed: ${inferResult.error ?? 'unknown'}`
          result.error = inferResult.error
        } else {
          const inferred = inferResult.inferred
          const { error: upErr } = await db
            .from('portfolios')
            .update({
              start_date:   inferred.start_date,
              starting_nav: inferred.starting_nav,
              updated_at:   new Date().toISOString(),
            })
            .eq('id', pfId)

          if (upErr) {
            result.reason = `UPDATE failed: ${upErr.message}`
            result.error = upErr.message
          } else {
            result.applied = true
            result.reason = `re-inferred from transactions (was starting_nav=${previousNav})`
            result.updated = {
              start_date:   inferred.start_date,
              starting_nav: inferred.starting_nav,
              method:       inferred.method,
            }
            appliedCount++
          }
        }
      } catch (e: any) {
        result.reason = `unexpected: ${e.message || 'unknown'}`
        result.error = e.message
      }

      results.push(result)
    }

    return NextResponse.json({
      ok: true,
      portfolios_processed: portfolioIds.length,
      portfolios_applied:   appliedCount,
      results,
      elapsed_ms: Date.now() - started,
    })
  } catch (err: any) {
    console.error('[admin/refresh-metadata]', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}

export async function GET() {
  return NextResponse.json({
    endpoint: '/api/admin/refresh-metadata',
    method:   'POST application/json',
    body:     '{ "portfolioId"?: string } — omit to refresh all active portfolios',
    returns:  'portfolios_processed, portfolios_applied, results[]',
  })
}
