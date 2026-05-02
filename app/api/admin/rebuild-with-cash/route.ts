/**
 * app/api/admin/rebuild-with-cash/route.ts — v27ag
 *
 * Admin endpoint: wipe nav_log for a portfolio and re-run NAV
 * reconstruction with the v27ag cash-aware code path.
 *
 * Use after deploying v27ag to refresh historical NAV for any portfolio
 * with cash activity. Replaces the manual `DELETE FROM nav_log WHERE
 * portfolio_id = ...` + click-Reconstruct sequence.
 *
 * POST body: { portfolio_id: string }
 * Returns:   {
 *              ok: boolean,
 *              portfolio_id: string,
 *              portfolio_label: string | null,
 *              wiped_count: number,
 *              nav_entries_added: number,
 *              dates_processed: number,
 *              instruments_tracked: number,
 *              elapsed_ms: number,
 *              error?: string,
 *            }
 *
 * Mirrors the shape of /api/admin/rebuild-holdings (v27ab). Pinned to
 * the nodejs runtime with maxDuration 300 since reconstruction across
 * thousands of dates can run long.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { reconstructPortfolioNav } from '@/lib/nav-reconstruct'

export const runtime     = 'nodejs'
export const maxDuration = 300
export const dynamic     = 'force-dynamic'

function admin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

export async function POST(req: NextRequest) {
  const t0 = Date.now()
  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json(
      { ok: false, error: 'invalid JSON body' },
      { status: 400 },
    )
  }

  const portfolioId = body?.portfolio_id
  if (!portfolioId || typeof portfolioId !== 'string') {
    return NextResponse.json(
      { ok: false, error: 'portfolio_id required (string)' },
      { status: 400 },
    )
  }

  const db = admin()

  // Look up label for the response payload (helpful for ops logs).
  const { data: portfolio, error: pfErr } = await db
    .from('portfolios')
    .select('id, label, name, client:clients(code)')
    .eq('id', portfolioId)
    .maybeSingle()

  if (pfErr) {
    return NextResponse.json(
      { ok: false, error: `portfolio fetch: ${pfErr.message}` },
      { status: 500 },
    )
  }
  if (!portfolio) {
    return NextResponse.json(
      { ok: false, error: 'portfolio not found' },
      { status: 404 },
    )
  }

  const portfolioLabel = portfolio.client?.[0]?.code && portfolio.label
    ? `${portfolio.client[0].code}-${portfolio.label}`
    : portfolio.label ?? null

  // ── 1. Wipe nav_log for this portfolio ────────────────────────────
  // Delete-and-rebuild rather than upsert: v27ag changes nav_value
  // semantics (now includes cash) so stale rows from pre-v27ag
  // reconstruction must be discarded entirely.
  const { count: wipedCount, error: delErr } = await db
    .from('nav_log')
    .delete({ count: 'exact' })
    .eq('portfolio_id', portfolioId)

  if (delErr) {
    return NextResponse.json(
      {
        ok: false,
        portfolio_id: portfolioId,
        portfolio_label: portfolioLabel,
        error: `nav_log delete: ${delErr.message}`,
      },
      { status: 500 },
    )
  }

  // ── 2. Re-run reconstruction with v27ag cash-aware code ───────────
  const result = await reconstructPortfolioNav(db, portfolioId)

  if (result.error) {
    return NextResponse.json(
      {
        ok: false,
        portfolio_id: portfolioId,
        portfolio_label: portfolioLabel,
        wiped_count: wipedCount ?? 0,
        nav_entries_added: result.navEntriesAdded,
        dates_processed: result.datesProcessed,
        instruments_tracked: result.instrumentsTracked,
        elapsed_ms: Date.now() - t0,
        error: `reconstruct: ${result.error}`,
      },
      { status: 500 },
    )
  }

  return NextResponse.json({
    ok: true,
    portfolio_id: portfolioId,
    portfolio_label: portfolioLabel,
    portfolio_name: portfolio.name ?? null,
    wiped_count: wipedCount ?? 0,
    nav_entries_added: result.navEntriesAdded,
    dates_processed: result.datesProcessed,
    instruments_tracked: result.instrumentsTracked,
    elapsed_ms: Date.now() - t0,
  })
}
