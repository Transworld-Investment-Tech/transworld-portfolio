import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// v27ad: hard-delete capability via ?hard=true&confirm_code=<CODE> query params.
// Without query params: existing soft-archive behavior preserved verbatim.
//
// Hard-delete leverages CASCADE on all 8 FK referencers (transactions,
// holdings, nav_log, staged_transactions, broker_files, reports, briefs,
// sleeve_targets). A single DELETE on portfolios atomically removes all
// dependent rows in one Postgres transaction.
//
// Storage objects in 'broker-files' bucket are NOT FK-bound and must be
// removed via Supabase Storage API after the DB delete. Storage failures
// do NOT roll back the DB delete (the DB cascade is the source of truth).
// Per Supabase docs, storage objects are NOT included in DB backups.
//
// confirm_code is a server-side belt-and-braces against accidental
// scripted deletion: the param must equal the looked-up
// "<client_code>-<portfolio_label>" exactly (case-insensitive). Belt is
// the type-to-confirm UI; braces is this server check.

export const runtime = 'nodejs'
export const maxDuration = 60

async function safeCount(
  db: ReturnType<typeof supabaseAdmin>,
  table: string,
  portfolioId: string
): Promise<number> {
  try {
    const { count } = await db
      .from(table as any)
      .select('portfolio_id', { count: 'exact', head: true })
      .eq('portfolio_id', portfolioId)
    return count ?? 0
  } catch {
    return 0
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const url = new URL(req.url)
  const hard = url.searchParams.get('hard') === 'true'
  const db = supabaseAdmin()

  // Soft-archive path (default, unchanged from pre-v27ad behavior)
  if (!hard) {
    const { error } = await db.from('portfolios')
      .update({ status: 'archived', updated_at: new Date().toISOString() })
      .eq('id', id)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  }

  // Hard-delete path
  const t0 = Date.now()
  const confirmCode = url.searchParams.get('confirm_code')

  // 0. Verify portfolio exists and capture identity for response + confirm_code check
  const { data: portfolio, error: pfErr } = await db
    .from('portfolios')
    .select('id, label, name, client_id')
    .eq('id', id)
    .maybeSingle()

  if (pfErr) {
    return NextResponse.json({ error: `lookup failed: ${pfErr.message}` }, { status: 500 })
  }
  if (!portfolio) {
    return NextResponse.json({ error: 'portfolio not found' }, { status: 404 })
  }

  const { data: client } = await db
    .from('clients')
    .select('code')
    .eq('id', portfolio.client_id)
    .maybeSingle()
  const clientCode = client?.code ?? '?'
  const portfolioCode = `${clientCode}-${portfolio.label}`

  // confirm_code server check — belt-and-braces against accidental scripted delete
  if (!confirmCode || confirmCode.trim().toUpperCase() !== portfolioCode.toUpperCase()) {
    return NextResponse.json({
      error: `confirm_code mismatch (expected "${portfolioCode}", got "${confirmCode ?? '<missing>'}")`,
    }, { status: 400 })
  }

  // 1. Pre-count rows in each FK referencer (for response visibility)
  const [tx, hold, nav, stage, bf, rep, br, sl] = await Promise.all([
    safeCount(db, 'transactions', id),
    safeCount(db, 'holdings', id),
    safeCount(db, 'nav_log', id),
    safeCount(db, 'staged_transactions', id),
    safeCount(db, 'broker_files', id),
    safeCount(db, 'reports', id),
    safeCount(db, 'briefs', id),
    safeCount(db, 'sleeve_targets', id),
  ])
  const counts = {
    transactions: tx,
    holdings: hold,
    nav_log: nav,
    staged_transactions: stage,
    broker_files: bf,
    reports: rep,
    briefs: br,
    sleeve_targets: sl,
  }

  // 2. Capture storage_paths BEFORE the DELETE (CASCADE wipes broker_files DB rows)
  const { data: bfRows, error: bfErr } = await db
    .from('broker_files')
    .select('storage_path')
    .eq('portfolio_id', id)
  if (bfErr) {
    return NextResponse.json({ error: `broker_files lookup failed: ${bfErr.message}` }, { status: 500 })
  }
  const storagePaths = (bfRows ?? [])
    .map((r: any) => r.storage_path)
    .filter((p: any): p is string => typeof p === 'string' && p.length > 0)

  // 3. DELETE the portfolio row — CASCADE atomically handles all 8 dependent tables
  const { error: delErr } = await db.from('portfolios').delete().eq('id', id)
  if (delErr) {
    return NextResponse.json({
      error: `portfolio delete failed: ${delErr.message}`,
      partial: { counts, storage_objects: 0, db_deleted: false },
    }, { status: 500 })
  }

  // 4. Remove storage objects (chunked at 1000)
  let storageRemoved = 0
  const storageFailed: string[] = []
  if (storagePaths.length > 0) {
    const CHUNK = 1000
    for (let i = 0; i < storagePaths.length; i += CHUNK) {
      const chunk = storagePaths.slice(i, i + CHUNK)
      const { data, error } = await db.storage.from('broker-files').remove(chunk)
      if (error) {
        storageFailed.push(...chunk)
      } else {
        storageRemoved += (data ?? []).length
      }
    }
  }

  const elapsed_ms = Date.now() - t0

  if (storageFailed.length > 0) {
    return NextResponse.json({
      ok: true,
      portfolio_id: id,
      portfolio_code: portfolioCode,
      portfolio_name: portfolio.name,
      deleted: { ...counts, storage_objects: storageRemoved },
      storage_partial: {
        removed_count: storageRemoved,
        failed_count: storageFailed.length,
        failed_paths: storageFailed.slice(0, 10),
      },
      elapsed_ms,
    })
  }

  return NextResponse.json({
    ok: true,
    portfolio_id: id,
    portfolio_code: portfolioCode,
    portfolio_name: portfolio.name,
    deleted: { ...counts, storage_objects: storageRemoved },
    elapsed_ms,
  })
}
