/**
 * app/api/broker/sessions/[id]/rollback/route.ts — v21d
 *
 * POST /api/broker/sessions/[id]/rollback
 *
 * Reverses a prior commit of this session:
 *   - Deletes transactions where source_file_id IN (session's broker_file ids)
 *   - Resets broker_files.parse_status from 'committed' back to 'parsed'
 *   - Rebuilds the portfolio's holdings from the now-smaller
 *     transactions set (v21d)
 *
 * Guards:
 *   - 409 if no file in the session is in parse_status='committed'.
 *     Nothing to roll back.
 *
 * Returns { ok, transactions_deleted, broker_files_reset,
 *           holdings_rebuild, elapsed_ms }.
 *
 * Note: staged_transactions rows are NOT touched — they remain
 * exactly as they were, so you can re-commit (possibly with
 * different include_in_commit selections) after a rollback.
 *
 * v21d: After the transactions DELETE, we call rebuildPortfolioHoldings
 * so the holdings table reflects the post-rollback state. Without
 * this, a rollback would leave stale holdings pointing at trades
 * that no longer exist. Failure of the rebuild is surfaced as a
 * warning; the rollback itself stays committed (transactions are
 * the source of truth).
 *
 * Next.js 15: params is a Promise.
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
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars'
    )
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const started = Date.now()
  try {
    const { id: session_id } = await params
    if (!session_id) {
      return NextResponse.json({ error: 'session_id required' }, { status: 400 })
    }

    const db = admin()

    // 1. Fetch all broker_files in session.
    const { data: files, error: filesErr } = await db
      .from('broker_files')
      .select('id, portfolio_id, parse_status')
      .eq('upload_session_id', session_id)

    if (filesErr) {
      return NextResponse.json({ error: filesErr.message }, { status: 500 })
    }
    if (!files || files.length === 0) {
      return NextResponse.json({ error: 'No files in session' }, { status: 404 })
    }

    const committedFiles = files.filter((f) => f.parse_status === 'committed')
    if (committedFiles.length === 0) {
      return NextResponse.json(
        {
          error:
            'No committed files in this session — nothing to roll back.',
        },
        { status: 409 }
      )
    }

    const committedFileIds = committedFiles.map((f) => f.id)
    const portfolio_id = committedFiles[0].portfolio_id

    // 2. Delete transactions linked to these broker_files.
    //    transactions.source_file_id (on the transactions table, this
    //    column IS correctly named source_file_id — unlike the
    //    staged_transactions side which uses broker_file_id).
    const { data: deleted, error: delErr } = await db
      .from('transactions')
      .delete()
      .in('source_file_id', committedFileIds)
      .select('id')

    if (delErr) {
      return NextResponse.json(
        { error: `transactions delete failed: ${delErr.message}` },
        { status: 500 }
      )
    }

    const transactions_deleted = deleted?.length || 0

    // 3. Reset parse_status → 'parsed' on committed files only.
    const { error: updErr } = await db
      .from('broker_files')
      .update({
        parse_status: 'parsed',
        updated_at: new Date().toISOString(),
      })
      .in('id', committedFileIds)

    if (updErr) {
      return NextResponse.json(
        {
          error: `broker_files status update failed: ${updErr.message}`,
          transactions_deleted,
          warning:
            'Transactions were deleted but broker_files state not reset. Manual cleanup may be needed.',
        },
        { status: 500 }
      )
    }

    // 4. v21d: Rebuild holdings from the now-smaller transactions set.
    //    Non-fatal. If the rebuild errors, holdings may be stale but
    //    the rollback itself is still correct (transactions truly got
    //    deleted). The user can retry via a future operation or manual fix.
    const holdingsRebuild = await rebuildPortfolioHoldings(db, portfolio_id)

    return NextResponse.json({
      ok: true,
      transactions_deleted,
      broker_files_reset: committedFileIds.length,
      holdings_rebuild: {
        upserted: holdingsRebuild.upserted,
        deleted: holdingsRebuild.deleted,
        skipped_no_instrument: holdingsRebuild.skipped_no_instrument,
        errors: holdingsRebuild.errors,
      },
      elapsed_ms: Date.now() - started,
    })
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'unknown error' },
      { status: 500 }
    )
  }
}
