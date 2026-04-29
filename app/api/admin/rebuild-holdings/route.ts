/**
 * app/api/admin/rebuild-holdings/route.ts — v27ab
 *
 * Standalone admin endpoint to trigger holdings rebuild for an
 * arbitrary portfolio. No side effects beyond the rebuild itself —
 * does NOT touch synth rows, does NOT trigger NAV reconstruct.
 *
 * Why this exists: the existing /api/holdings POST writes a new BUY
 * transaction (manual position entry) and rebuilds as a side effect.
 * The existing /api/admin/synthesize-recovery rebuilds only when
 * synth rows actually changed (didWrite gate). Neither is suitable
 * for "just rebuild this portfolio" use cases:
 *   - validating algorithm changes (e.g. v27aa Priority 2 fix)
 *   - re-anchoring holdings after manual SQL edits to transactions
 *   - fan-out across multiple portfolios after a lib/ change
 *
 * Pattern mirrors /api/admin/synthesize-recovery: same admin()
 * factory, same runtime/duration/dynamic exports, same response
 * envelope shape.
 *
 * Body shape:
 *   { portfolio_id: string }
 *
 * Response shape:
 *   {
 *     ok: true,
 *     portfolio_id: string,
 *     holdings_rebuild: { upserted, deleted, skipped_no_instrument, errors },
 *     elapsed_ms: number,
 *   }
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { rebuildPortfolioHoldings } from '@/lib/holdings-rebuild'

export const runtime = 'nodejs'
export const maxDuration = 60
export const dynamic = 'force-dynamic'

function admin(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars')
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

export async function POST(req: NextRequest) {
  const started = Date.now()
  try {
    let body: { portfolio_id?: string }
    try {
      body = await req.json()
    } catch (e: any) {
      return NextResponse.json(
        { error: `Invalid JSON body: ${e.message}` },
        { status: 400 }
      )
    }

    const portfolio_id = body.portfolio_id
    if (!portfolio_id || typeof portfolio_id !== 'string') {
      return NextResponse.json(
        { error: 'portfolio_id (string) required in body' },
        { status: 400 }
      )
    }

    const db = admin()

    // Verify portfolio exists (defensive — return 404 not 500 if not).
    const { data: portfolioRow, error: portfolioErr } = await db
      .from('portfolios')
      .select('id, label, name')
      .eq('id', portfolio_id)
      .single()

    if (portfolioErr || !portfolioRow) {
      return NextResponse.json(
        { error: `portfolio not found: ${portfolioErr?.message ?? 'no row'}` },
        { status: 404 }
      )
    }

    // Run rebuild.
    const r = await rebuildPortfolioHoldings(db, portfolio_id)

    return NextResponse.json({
      ok:           true,
      portfolio_id,
      portfolio_label: portfolioRow.label,
      portfolio_name:  portfolioRow.name,
      holdings_rebuild: {
        upserted:              r.upserted,
        deleted:               r.deleted,
        skipped_no_instrument: r.skipped_no_instrument,
        errors:                r.errors,
      },
      elapsed_ms:   Date.now() - started,
    })
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'unknown error' },
      { status: 500 }
    )
  }
}
