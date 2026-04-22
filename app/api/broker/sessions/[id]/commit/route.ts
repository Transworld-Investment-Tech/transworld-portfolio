/**
 * app/api/broker/sessions/[id]/commit/route.ts — v21b-3b
 *
 * POST /api/broker/sessions/[id]/commit
 *
 * Moves all staged_transactions for this session where
 * include_in_commit = true into the real `transactions` table.
 *
 * Side effects:
 *   - transactions.source_file_id is set to the staged row's
 *     broker_file_id (the FK column name differs across the two
 *     tables — staged uses broker_file_id, transactions uses
 *     source_file_id).
 *   - broker_files.parse_status transitions to 'committed'.
 *   - If the target portfolio has a NULL cscs_number and any
 *     broker_file in the session has one populated, it's
 *     backfilled onto the portfolio.
 *
 * Guards:
 *   - 409 if any broker_file in the session is already
 *     parse_status='committed'. Rollback first to re-commit.
 *
 * Returns { ok, committed, skipped, broker_files, elapsed_ms }.
 *
 * Next.js 15: params is a Promise.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient, SupabaseClient } from '@supabase/supabase-js'

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

function sumNonNull(xs: Array<number | null | undefined>): number | null {
  const nn = xs.filter((x): x is number => x !== null && x !== undefined)
  if (nn.length === 0) return null
  return nn.reduce((a, b) => a + b, 0)
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
      .select('id, portfolio_id, parse_status, cscs_number')
      .eq('upload_session_id', session_id)

    if (filesErr) {
      return NextResponse.json({ error: filesErr.message }, { status: 500 })
    }
    if (!files || files.length === 0) {
      return NextResponse.json({ error: 'No files in session' }, { status: 404 })
    }

    // 2. Refuse if any file is already committed.
    const alreadyCommitted = files.filter((f) => f.parse_status === 'committed')
    if (alreadyCommitted.length > 0) {
      return NextResponse.json(
        {
          error: `Session already committed (${alreadyCommitted.length} of ${files.length} file${files.length === 1 ? '' : 's'}). Rollback first to re-commit.`,
        },
        { status: 409 }
      )
    }

    const portfolio_id = files[0].portfolio_id
    const fileIds = files.map((f) => f.id)

    // 3. Fetch staged rows to commit (include_in_commit=true).
    const { data: staged, error: stagedErr } = await db
      .from('staged_transactions')
      .select(
        `id, broker_file_id, portfolio_id, trade_date, settlement_date,
         action, instrument_id, quantity, price, gross_value, amount,
         fee_commission, fee_vat, fee_contract_stamp,
         fee_exchange, fee_clearing, fee_sec, fee_sms,
         fee_management, fee_demat, fee_other,
         cn_number, external_ref, narration, include_in_commit`
      )
      .in('broker_file_id', fileIds)
      .eq('include_in_commit', true)
      .order('trade_date', { ascending: true })
      .order('created_at', { ascending: true })

    if (stagedErr) {
      return NextResponse.json(
        { error: `staged_transactions query: ${stagedErr.message}` },
        { status: 500 }
      )
    }

    const toCommit = staged || []

    // 4. Count total staged rows for skipped calculation.
    const { count: totalStaged } = await db
      .from('staged_transactions')
      .select('*', { count: 'exact', head: true })
      .in('broker_file_id', fileIds)

    const total = totalStaged ?? toCommit.length
    const skipped = total - toCommit.length

    // 5. Build transactions rows.
    const txRows = toCommit.map((s: any) => {
      const fees = sumNonNull([
        s.fee_commission,
        s.fee_vat,
        s.fee_contract_stamp,
        s.fee_exchange,
        s.fee_clearing,
        s.fee_sec,
        s.fee_sms,
        s.fee_management,
        s.fee_demat,
        s.fee_other,
      ])
      return {
        portfolio_id: s.portfolio_id,
        trade_date: s.trade_date,
        action: s.action,
        instrument_id: s.instrument_id,
        quantity: s.quantity,
        price: s.price,
        gross_value: s.gross_value,
        amount: s.amount,
        fees,
        fee_commission: s.fee_commission,
        fee_vat: s.fee_vat,
        fee_contract_stamp: s.fee_contract_stamp,
        fee_exchange: s.fee_exchange,
        fee_clearing: s.fee_clearing,
        fee_sec: s.fee_sec,
        fee_sms: s.fee_sms,
        fee_management: s.fee_management,
        fee_demat: s.fee_demat,
        fee_other: s.fee_other,
        notes: s.narration,
        cn_number: s.cn_number,
        settlement_date: s.settlement_date,
        external_ref: s.external_ref,
        // staged.broker_file_id → transactions.source_file_id (column
        // name differs between the two tables; the value is the same).
        source_file_id: s.broker_file_id,
      }
    })

    // 6. Insert into transactions.
    let committed = 0
    if (txRows.length > 0) {
      const { data: inserted, error: insErr } = await db
        .from('transactions')
        .insert(txRows)
        .select('id')
      if (insErr) {
        return NextResponse.json(
          { error: `transactions insert failed: ${insErr.message}` },
          { status: 500 }
        )
      }
      committed = inserted?.length || 0
    }

    // 7. Transition broker_files.parse_status → 'committed'.
    const { error: updErr } = await db
      .from('broker_files')
      .update({
        parse_status: 'committed',
        updated_at: new Date().toISOString(),
      })
      .in('id', fileIds)

    if (updErr) {
      return NextResponse.json(
        {
          error: `broker_files status update failed: ${updErr.message}`,
          committed,
          warning:
            'Transactions were inserted but broker_files state not updated. Manual cleanup may be needed.',
        },
        { status: 500 }
      )
    }

    // 8. CSCS backfill on the portfolio (non-fatal if it errors).
    try {
      const { data: portfolio } = await db
        .from('portfolios')
        .select('cscs_number')
        .eq('id', portfolio_id)
        .single()
      if (portfolio && !portfolio.cscs_number) {
        const firstCscs = files.find((f) => f.cscs_number)?.cscs_number
        if (firstCscs) {
          await db
            .from('portfolios')
            .update({ cscs_number: firstCscs })
            .eq('id', portfolio_id)
        }
      }
    } catch {
      // best-effort; continue
    }

    return NextResponse.json({
      ok: true,
      committed,
      skipped,
      broker_files: fileIds.length,
      elapsed_ms: Date.now() - started,
    })
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'unknown error' },
      { status: 500 }
    )
  }
}
