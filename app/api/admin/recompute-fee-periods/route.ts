/**
 * app/api/admin/recompute-fee-periods/route.ts — v27am
 *
 * POST {portfolio_id} → recompute fee_periods for the given portfolio.
 *
 * Behavior (per lib/hwm-engine):
 *   - Skip with reason if fee_model='none' or fee_relationship_start_date IS NULL
 *   - Wipe pending/superseded fee_periods rows; preserve paid/invoiced/waived
 *   - Walk nav_log + transactions period by period
 *   - Insert fresh pending rows for periods not already preserved
 *
 * Idempotent: running twice produces the same final state.
 *
 * Auth: relies on SUPABASE_SERVICE_ROLE_KEY. No additional gating in v27am
 * (consistent with /api/admin/rebuild-with-cash). Wrap with auth middleware
 * if the admin surface gets a unified gate later.
 */

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { recomputeFeePeriodsForPortfolio } from '@/lib/hwm-engine'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({}))
    const portfolioId = body?.portfolio_id

    if (!portfolioId || typeof portfolioId !== 'string') {
      return NextResponse.json(
        { ok: false, error: 'portfolio_id (string) required in request body' },
        { status: 400 }
      )
    }

    const url = process.env.NEXT_PUBLIC_SUPABASE_URL
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!url || !key) {
      return NextResponse.json(
        { ok: false, error: 'Supabase service config missing (NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY)' },
        { status: 500 }
      )
    }

    const supabase = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    })

    const t0 = Date.now()
    const result = await recomputeFeePeriodsForPortfolio(supabase, portfolioId)
    const elapsedMs = Date.now() - t0

    return NextResponse.json({ ...result, elapsed_ms: elapsedMs })
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message ?? 'unknown error' },
      { status: 500 }
    )
  }
}
