/**
 * app/api/broker/upload/route.ts — v21b-2
 *
 * The ingestion pipeline for broker PDFs. POST multipart/form-data:
 *   - portfolio_id: UUID of target portfolio
 *   - contract_notes: one PDF (required)
 *   - statements: zero or more PDFs
 *   - uploaded_by: optional text identifier
 *
 * For each file:
 *   1. Uploads raw bytes to Supabase Storage bucket `broker-files`
 *   2. Creates a broker_files row (parse_status = 'pending')
 *   3. Runs the v21a parser on the bytes
 *   4. Updates broker_files with parse results + audit outcome
 *
 * After all files are parsed, runs the reconciler across them and
 * writes the reconciled output as staged_transactions rows — one
 * per CN row (aggregated across partial-fill splits) plus one per
 * cash event. The staged rows are the preview that the inbox UI
 * (v21b-3) will show before commit.
 *
 * Returns the broker_file IDs, staged row count, and the reconciler
 * summary so the caller can confirm what landed.
 *
 * NO DEDUP in this release — v21d handles dedup via cn_number.
 * Accidental double-uploads create fresh staged rows; user can
 * delete broker_files rows manually until dedup ships.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
import {
  parseContractNotesPdf,
  parseStatementPdf,
  reconcile,
  type ParsedContractNotes,
  type ParsedStatement,
  type ContractNoteRow,
  type StatementRow,
  type TradeMatch,
  type CashEvent,
} from '@/lib/broker-parser'

export const runtime = 'nodejs'
export const maxDuration = 300

// ─── Supabase admin client ───────────────────────────────────────
function admin(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars — ' +
      'set them in Vercel project settings.'
    )
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

// ─── Types for internal bookkeeping ──────────────────────────────
interface UploadedFile {
  broker_file_id: string
  kind: 'contract_notes' | 'statement'
  filename: string
  storage_path: string
  parse_status: string
  parse_error?: string
}

// ─── POST handler ────────────────────────────────────────────────
export async function POST(req: NextRequest) {
  const started = Date.now()
  let supabase: SupabaseClient
  try {
    supabase = admin()
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }

  // ── Parse form ───────────────────────────────────────────
  let form: FormData
  try {
    form = await req.formData()
  } catch (err: any) {
    return NextResponse.json(
      { error: `Could not read multipart form: ${err.message}` },
      { status: 400 }
    )
  }

  const portfolio_id = form.get('portfolio_id')
  const uploaded_by = form.get('uploaded_by')
  const cnField = form.get('contract_notes')
  const stFields = form.getAll('statements')

  if (typeof portfolio_id !== 'string' || !portfolio_id) {
    return NextResponse.json({ error: 'portfolio_id is required' }, { status: 400 })
  }
  if (!(cnField instanceof File)) {
    return NextResponse.json(
      { error: 'contract_notes PDF is required' },
      { status: 400 }
    )
  }
  const statementFiles: File[] = stFields.filter(
    (f): f is File => f instanceof File
  )

  // ── Verify portfolio exists ──────────────────────────────
  const { data: portfolio, error: pErr } = await supabase
    .from('portfolios')
    .select('id, name, label, status')
    .eq('id', portfolio_id)
    .single()
  if (pErr || !portfolio) {
    return NextResponse.json(
      { error: `Portfolio not found: ${portfolio_id}` },
      { status: 404 }
    )
  }

  const errors: string[] = []
  const uploadedFiles: UploadedFile[] = []
  const timestamp = Date.now()
  const uploadSessionId = randomUUID()  // v21b-3a: groups all files from this POST

  // ── Upload + parse contract notes ────────────────────────
  let parsedCN: ParsedContractNotes | null = null
  let cnBrokerFileId: string | null = null

  {
    const up = await uploadPdf(
      supabase,
      portfolio_id,
      cnField,
      'contract_notes',
      timestamp,
      typeof uploaded_by === 'string' ? uploaded_by : null,
      uploadSessionId
    )
    if (up.error) {
      errors.push(`contract_notes upload: ${up.error}`)
    } else {
      cnBrokerFileId = up.broker_file_id
      const status: Partial<UploadedFile> = {
        broker_file_id: up.broker_file_id,
        kind: 'contract_notes',
        filename: cnField.name,
        storage_path: up.storage_path,
        parse_status: 'pending',
      }

      try {
        const buf = Buffer.from(await cnField.arrayBuffer())
        parsedCN = await parseContractNotesPdf(buf)

        const parse_status = parsedCN.parse_errors.length
          ? 'parse_failed'
          : 'parsed'
        await supabase
          .from('broker_files')
          .update({
            parsed_at: new Date().toISOString(),
            parse_status,
            parse_error: parsedCN.parse_errors.length
              ? parsedCN.parse_errors.join('; ')
              : null,
            account_holder: parsedCN.account_holder || null,
            cscs_number: parsedCN.cscs_number || null,
            updated_at: new Date().toISOString(),
          })
          .eq('id', up.broker_file_id)

        status.parse_status = parse_status
        if (parsedCN.parse_errors.length) {
          status.parse_error = parsedCN.parse_errors.join('; ')
          errors.push(`contract_notes parse: ${status.parse_error}`)
        }
      } catch (err: any) {
        await supabase
          .from('broker_files')
          .update({
            parse_status: 'parse_failed',
            parse_error: err.message,
            updated_at: new Date().toISOString(),
          })
          .eq('id', up.broker_file_id)
        status.parse_status = 'parse_failed'
        status.parse_error = err.message
        errors.push(`contract_notes parse: ${err.message}`)
        parsedCN = null
      }

      uploadedFiles.push(status as UploadedFile)
    }
  }

  // ── Upload + parse each statement ────────────────────────
  const parsedStatements: ParsedStatement[] = []
  const statementBrokerFileIds: string[] = []

  for (const file of statementFiles) {
    const up = await uploadPdf(
      supabase,
      portfolio_id,
      file,
      'statement',
      timestamp,
      typeof uploaded_by === 'string' ? uploaded_by : null,
      uploadSessionId
    )
    if (up.error) {
      errors.push(`${file.name} upload: ${up.error}`)
      continue
    }

    const status: Partial<UploadedFile> = {
      broker_file_id: up.broker_file_id,
      kind: 'statement',
      filename: file.name,
      storage_path: up.storage_path,
      parse_status: 'pending',
    }

    try {
      const buf = Buffer.from(await file.arrayBuffer())
      const parsed = await parseStatementPdf(buf)
      parsedStatements.push(parsed)
      statementBrokerFileIds.push(up.broker_file_id)

      const parse_status = parsed.audit.passes ? 'parsed' : 'parse_failed'
      await supabase
        .from('broker_files')
        .update({
          parsed_at: new Date().toISOString(),
          parse_status,
          parse_error: parsed.parse_errors.length
            ? parsed.parse_errors.join('; ')
            : null,
          account_holder: parsed.account_holder || null,
          cscs_number: parsed.cscs_number || null,
          period_from: parsed.period.from || null,
          period_to: parsed.period.to || null,
          audit_opening: parsed.opening_balance,
          audit_closing: parsed.closing_balance,
          audit_computed: parsed.audit.computed_closing,
          audit_passes: parsed.audit.passes,
          updated_at: new Date().toISOString(),
        })
        .eq('id', up.broker_file_id)

      status.parse_status = parse_status
      if (parsed.parse_errors.length) {
        status.parse_error = parsed.parse_errors.join('; ')
        errors.push(`${file.name}: ${status.parse_error}`)
      }
    } catch (err: any) {
      await supabase
        .from('broker_files')
        .update({
          parse_status: 'parse_failed',
          parse_error: err.message,
          updated_at: new Date().toISOString(),
        })
        .eq('id', up.broker_file_id)
      status.parse_status = 'parse_failed'
      status.parse_error = err.message
      errors.push(`${file.name} parse: ${err.message}`)
    }

    uploadedFiles.push(status as UploadedFile)
  }

  // ── Reconcile + stage ────────────────────────────────────
  if (!parsedCN || !cnBrokerFileId) {
    return NextResponse.json(
      {
        ok: false,
        portfolio: { id: portfolio.id, name: portfolio.name, label: portfolio.label },
        broker_files: uploadedFiles,
        staged_count: 0,
        errors: [
          ...errors,
          'No contract notes parsed — cannot reconcile or stage transactions',
        ],
        elapsed_ms: Date.now() - started,
      },
      { status: 200 }
    )
  }

  const reconciliation = reconcile(parsedCN, parsedStatements)

  const stagedRows = buildStagedRows(
    parsedCN,
    parsedStatements,
    reconciliation,
    portfolio_id,
    cnBrokerFileId,
    statementBrokerFileIds
  )

  let inserted = 0
  if (stagedRows.length > 0) {
    // Batch insert. Supabase handles large arrays fine; we keep a
    // single call for atomicity.
    const { data: insData, error: insErr } = await supabase
      .from('staged_transactions')
      .insert(stagedRows)
      .select('id')
    if (insErr) {
      errors.push(`staged_transactions insert failed: ${insErr.message}`)
    } else {
      inserted = insData?.length ?? stagedRows.length
    }
  }

  return NextResponse.json(
    {
      ok: errors.length === 0,
      portfolio: {
        id: portfolio.id,
        name: portfolio.name,
        label: portfolio.label,
      },
      broker_files: uploadedFiles,
      staged_count: inserted,
      reconciliation_summary: reconciliation.summary,
      errors,
      elapsed_ms: Date.now() - started,
    },
    { status: 200 }
  )
}

// ─── GET: usage doc ──────────────────────────────────────────────
export async function GET() {
  return NextResponse.json({
    endpoint: '/api/broker/upload',
    method: 'POST multipart/form-data',
    fields: {
      portfolio_id: 'UUID of target portfolio (required)',
      contract_notes: 'single PDF (required)',
      statements: '0..N PDFs',
      uploaded_by: 'optional text identifier',
    },
    example_curl: [
      'curl -sS -X POST https://YOUR-DEPLOYMENT/api/broker/upload \\',
      '  -F "portfolio_id=<uuid>" \\',
      '  -F "contract_notes=@Contract_Notes.pdf" \\',
      '  -F "statements=@Statement_1.pdf" \\',
      '  -F "statements=@Statement_2.pdf"',
    ].join('\n'),
    returns:
      'broker_files (array), staged_count, reconciliation_summary, errors',
  })
}

// ─── Helpers ─────────────────────────────────────────────────────

async function uploadPdf(
  supabase: SupabaseClient,
  portfolio_id: string,
  file: File,
  kind: 'contract_notes' | 'statement',
  timestamp: number,
  uploaded_by: string | null,
  upload_session_id: string
): Promise<{ broker_file_id: string; storage_path: string; error?: string }> {
  const storage_path = `${portfolio_id}/${timestamp}-${sanitize(file.name)}`
  const bytes = Buffer.from(await file.arrayBuffer())

  const up = await supabase.storage
    .from('broker-files')
    .upload(storage_path, bytes, {
      contentType: 'application/pdf',
      upsert: false,
    })
  if (up.error) {
    return { broker_file_id: '', storage_path: '', error: up.error.message }
  }

  const now = new Date().toISOString()
  const { data, error } = await supabase
    .from('broker_files')
    .insert({
      portfolio_id,
      file_kind: kind,
      original_filename: file.name,
      storage_path,
      size_bytes: file.size,
      parse_status: 'pending',
      uploaded_by,
      upload_session_id,
      created_at: now,
      updated_at: now,
    })
    .select('id')
    .single()

  if (error || !data) {
    // Best-effort cleanup of the storage object on DB insert failure
    await supabase.storage.from('broker-files').remove([storage_path])
    return {
      broker_file_id: '',
      storage_path,
      error: error?.message || 'unknown insert error',
    }
  }

  return { broker_file_id: data.id, storage_path }
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200)
}

// Maps the parser's internal TradeMatch.kind values to the
// staged_transactions.recon_kind check-constraint values.
// The parser uses terse names ('exact', 'split') while the DB
// uses 'matched_exact' / 'matched_split' for clarity when
// reading recon_kind alongside 'cash_event_auto' etc. v21b-2-hotfix-2.
function mapReconKind(
  k: 'exact' | 'split' | 'partial_mismatch' | 'unmatched'
): 'matched_exact' | 'matched_split' | 'partial_mismatch' | 'unmatched' {
  switch (k) {
    case 'exact': return 'matched_exact'
    case 'split': return 'matched_split'
    case 'partial_mismatch': return 'partial_mismatch'
    case 'unmatched': return 'unmatched'
  }
}

function extractReference(narration: string): string | null {
  const m = narration.match(/\b(NIBSS|CHEQUE|TRANSFER)\s+([A-Za-z0-9.-]+)/i)
  if (!m) return null
  return `${m[1].toUpperCase()} ${m[2]}`
}

function buildStagedRows(
  cn: ParsedContractNotes,
  statements: ParsedStatement[],
  rec: ReturnType<typeof reconcile>,
  portfolio_id: string,
  cnBrokerFileId: string,
  statementBrokerFileIds: string[]
): any[] {
  const rows: any[] = []

  // ── One staged row per CN row (trade) ──────────────────────
  // For splits (N statement rows → 1 CN row), we aggregate:
  //   quantity/price/fees from CN (authoritative totals)
  //   cn_number = comma-separated list of statement CN#s
  //   narration = concat of statement narrations
  for (const match of rec.trade_matches) {
    const cnRow: ContractNoteRow = cn.rows[match.cn_row_index]

    let cnNumbers = ''
    let narration = ''
    if (match.statement_refs.length > 0) {
      const parts: string[] = []
      const narrParts: string[] = []
      for (const ref of match.statement_refs) {
        const sRow = statements[ref.statement_index]?.rows[ref.row_index]
        if (!sRow) continue
        if (sRow.cn_number) parts.push(sRow.cn_number)
        if (sRow.narration) narrParts.push(sRow.narration)
      }
      cnNumbers = parts.join(',')
      narration = narrParts.join(' | ')
    } else {
      // Unmatched CN — synthesise a narration from CN data
      narration = `${cnRow.action === 'BUY' ? 'Purchase' : 'Sale'} of ${cnRow.quantity} unit(s) of ${cnRow.security_code} @ ${cnRow.price} (no statement match)`
    }

    rows.push({
      broker_file_id: cnBrokerFileId,
      portfolio_id,
      trade_date: cnRow.trade_date,
      settlement_date: cnRow.settlement_date,
      action: cnRow.action,
      instrument_id: cnRow.security_code,
      quantity: cnRow.quantity,
      price: cnRow.price,
      gross_value: cnRow.consideration,
      amount: cnRow.total,
      fee_commission: cnRow.fee_commission,
      fee_vat: cnRow.fee_vat,
      fee_exchange: cnRow.fee_exchange,
      fee_clearing: cnRow.fee_clearing,
      fee_sec: cnRow.fee_sec,
      fee_contract_stamp: cnRow.fee_contract_stamp,
      fee_sms: cnRow.fee_sms,
      cn_number: cnNumbers || null,
      narration,
      recon_kind: mapReconKind(match.kind),
      recon_note: match.note || null,
      dedup_status: 'new',
      include_in_commit: true,
    })
  }

  // ── One staged row per cash event ──────────────────────────
  for (const ev of rec.cash_events) {
    const brokerFileId =
      statementBrokerFileIds[ev.statement_index] ?? cnBrokerFileId
    const sRow: StatementRow | undefined =
      statements[ev.statement_index]?.rows[ev.row_index]
    if (!sRow) continue

    const row: any = {
      broker_file_id: brokerFileId,
      portfolio_id,
      trade_date: ev.date,
      action: ev.proposed_action,
      amount: ev.amount,
      narration: ev.narration,
      recon_kind: 'cash_event_auto',
      dedup_status: 'new',
      include_in_commit: true,
    }

    // Populate fee breakdown based on the underlying kind
    switch (ev.kind) {
      case 'management_fee':
        row.fee_management = ev.amount
        break
      case 'demat_fee':
        row.fee_demat = ev.amount
        break
      case 'bank_charge':
        row.fee_other = ev.amount
        break
      // deposit / withdrawal / refund: no fee column; the action
      // alone carries the meaning.
    }

    // Pull NIBSS / CHEQUE / TRANSFER reference from narration.
    const ref = extractReference(ev.narration)
    if (ref) row.external_ref = ref

    rows.push(row)
  }

  // ── Orphan statement trades (statement rows with no CN match) ──
  // These are unusual — it means the statement recorded a trade
  // that the contract notes don't show. We stage them as-is so
  // the user can inspect and decide in the inbox.
  for (const orphan of rec.orphan_statement_trades) {
    const sRow =
      statements[orphan.statement_index]?.rows[orphan.row_index]
    if (!sRow) continue
    const brokerFileId =
      statementBrokerFileIds[orphan.statement_index] ?? cnBrokerFileId

    rows.push({
      broker_file_id: brokerFileId,
      portfolio_id,
      trade_date: sRow.trans_date,
      action: sRow.kind === 'trade_buy' ? 'BUY' : 'SELL',
      instrument_id: sRow.ticker,
      quantity: sRow.quantity,
      price: sRow.price,
      amount: sRow.debit > 0 ? sRow.debit : sRow.credit,
      cn_number: sRow.cn_number || null,
      narration: sRow.narration,
      recon_kind: 'unmatched',
      recon_note: orphan.reason,
      dedup_status: 'new',
      include_in_commit: false, // default off for orphans — user reviews
    })
  }

  return rows
}
