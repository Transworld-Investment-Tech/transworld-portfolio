/**
 * app/api/broker/sessions/[id]/route.ts — v21b-3a
 *
 * GET /api/broker/sessions/[id]
 *   Returns full detail for a single upload session:
 *     - session metadata
 *     - all broker_files in the session (with parse results + audit stats)
 *     - all staged_transactions across those files
 *
 * Response shape (success):
 *   {
 *     session: {
 *       session_id,
 *       portfolio: { id, name, label, client },
 *       upload_time,
 *       uploaded_by,
 *     },
 *     files: [
 *       {
 *         id, kind, filename, parse_status, parse_error,
 *         account_holder, cscs_number,
 *         period_from, period_to,
 *         audit: { opening, closing, computed, passes } | null,
 *         size_bytes, created_at
 *       }
 *     ],
 *     staged: [
 *       { ...staged_transactions row, portfolio_id omitted }
 *     ],
 *     summary: {
 *       file_count,
 *       staged_count,
 *       by_recon_kind: { [kind]: number },
 *       by_action: { [action]: number },
 *       all_balanced: boolean,
 *     }
 *   }
 *
 * Next.js 15 note: params is a Promise — must await.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient, SupabaseClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'
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

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: session_id } = await params
    if (!session_id) {
      return NextResponse.json({ error: 'session_id required' }, { status: 400 })
    }

    const db = admin()

    // 1. Fetch all broker_files in the session.
    const { data: filesData, error: filesErr } = await db
      .from('broker_files')
      .select(
        `id, upload_session_id, portfolio_id, file_kind,
         original_filename, storage_path, size_bytes,
         parse_status, parse_error,
         account_holder, cscs_number,
         period_from, period_to,
         audit_opening, audit_closing, audit_computed, audit_passes,
         uploaded_by, created_at, updated_at, parsed_at,
         portfolios (
           id, name, label,
           clients ( code, name )
         )`
      )
      .eq('upload_session_id', session_id)
      .order('file_kind', { ascending: true })
      .order('created_at', { ascending: true })

    if (filesErr) {
      return NextResponse.json(
        { error: `broker_files query: ${filesErr.message}` },
        { status: 500 }
      )
    }

    const files = (filesData || []) as any[]
    if (files.length === 0) {
      return NextResponse.json(
        { error: `No files found for session ${session_id}` },
        { status: 404 }
      )
    }

    // Derive session metadata from the first file.
    const firstFile = files[0]
    const portfolio = firstFile.portfolios
      ? {
          id: (firstFile.portfolios as any).id,
          name: (firstFile.portfolios as any).name,
          label: (firstFile.portfolios as any).label,
          client: (firstFile.portfolios as any).clients || null,
        }
      : null

    const uploadTime = files.reduce((min, f) => {
      return new Date(f.created_at) < new Date(min) ? f.created_at : min
    }, firstFile.created_at)

    const fileIds = files.map((f) => f.id)

    // 2. Fetch all staged_transactions for these files.
    const { data: stagedData, error: stagedErr } = await db
      .from('staged_transactions')
      .select(
        `id, source_file_id, trade_date, settlement_date,
         action, instrument_id, quantity, price,
         gross_value, amount,
         fees, fee_commission, fee_vat, fee_contract_stamp,
         fee_exchange, fee_clearing, fee_sec, fee_sms,
         fee_management, fee_demat, fee_other,
         broker, cn_number, external_ref, narration,
         recon_kind, recon_note,
         dedup_status, duplicate_of, include_in_commit,
         notes, created_at`
      )
      .in('source_file_id', fileIds)
      .order('trade_date', { ascending: true })
      .order('created_at', { ascending: true })

    if (stagedErr) {
      return NextResponse.json(
        { error: `staged_transactions query: ${stagedErr.message}` },
        { status: 500 }
      )
    }

    const staged = (stagedData || []) as any[]

    // 3. Build summary.
    const by_recon_kind: Record<string, number> = {}
    const by_action: Record<string, number> = {}
    for (const s of staged) {
      by_recon_kind[s.recon_kind] = (by_recon_kind[s.recon_kind] || 0) + 1
      by_action[s.action] = (by_action[s.action] || 0) + 1
    }

    const statementsWithAudit = files.filter(
      (f) => f.file_kind === 'statement' && f.audit_passes !== null
    )
    const allBalanced =
      statementsWithAudit.length === 0 ||
      statementsWithAudit.every((f) => f.audit_passes === true)

    // 4. Shape file output.
    const filesOut = files.map((f) => ({
      id: f.id,
      kind: f.file_kind,
      filename: f.original_filename,
      storage_path: f.storage_path,
      size_bytes: f.size_bytes,
      parse_status: f.parse_status,
      parse_error: f.parse_error,
      account_holder: f.account_holder,
      cscs_number: f.cscs_number,
      period_from: f.period_from,
      period_to: f.period_to,
      audit:
        f.audit_opening !== null ||
        f.audit_closing !== null ||
        f.audit_computed !== null ||
        f.audit_passes !== null
          ? {
              opening: f.audit_opening,
              closing: f.audit_closing,
              computed: f.audit_computed,
              passes: f.audit_passes,
            }
          : null,
      uploaded_by: f.uploaded_by,
      created_at: f.created_at,
      parsed_at: f.parsed_at,
    }))

    return NextResponse.json({
      session: {
        session_id,
        portfolio,
        upload_time: uploadTime,
        uploaded_by: firstFile.uploaded_by,
      },
      files: filesOut,
      staged,
      summary: {
        file_count: files.length,
        staged_count: staged.length,
        by_recon_kind,
        by_action,
        all_balanced: allBalanced,
      },
    })
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'unknown error' },
      { status: 500 }
    )
  }
}
