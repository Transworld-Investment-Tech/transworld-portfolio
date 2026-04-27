/**
 * app/api/broker/upload/route.ts — v27p
 *
 * v27p change: status decision logic separates three concerns that v27g
 * conflated under 'parse_failed':
 *
 *   - 'parsed'        — extraction succeeded, audit passed (or no audit)
 *   - 'parse_warning' — extraction succeeded, header metadata missing
 *                       (e.g. CN with no CSCS number but 290+ trade rows)
 *   - 'audit_warning' — extraction succeeded, audit imbalance present
 *                       (e.g. statement closing balance off by ₦56k)
 *   - 'parse_failed'  — extraction genuinely failed, no usable rows
 *
 * Only 'parse_failed' blocks commit. The two _warning states surface as
 * banners in the staging UI but do not gate the button. Operator can
 * deselect affected rows and commit the rest.
 *
 * The schema CHECK constraint was extended in the v27p SQL migration
 * (separate from this code ship) to permit the two new values.
 *
 * v27g baseline preserved otherwise.
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
} from '@/lib/broker-parser'
import { getAliasMap, applyAlias } from '@/lib/ticker-aliases'
import { parseCSCSFile } from '@/lib/cscs-parser'

export const runtime = 'nodejs'
export const maxDuration = 300

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

type FileKind = 'contract_notes' | 'statement' | 'canonical_positions'

interface UploadedFile {
  broker_file_id: string
  kind: FileKind
  filename: string
  storage_path: string
  parse_status: string
  parse_error?: string
}

// v27p: classify CN status. Extraction succeeded if rows.length > 0.
// Errors that don't reflect extraction failure (missing header metadata)
// downgrade to parse_warning rather than parse_failed.
function classifyCnStatus(parsed: ParsedContractNotes): string {
  if (parsed.rows.length === 0) return 'parse_failed'
  if (parsed.parse_errors.length === 0) return 'parsed'
  return 'parse_warning'
}

// v27p: classify statement status. Audit imbalance gets its own state;
// no-rows is a hard failure; otherwise parsed.
function classifyStatementStatus(parsed: ParsedStatement): string {
  if (parsed.rows.length === 0) return 'parse_failed'
  if (!parsed.audit.passes) return 'audit_warning'
  if (parsed.parse_errors.length > 0) return 'parse_warning'
  return 'parsed'
}

// v27p: classify canonical status. Same shape as v27g — strict.
function classifyCanonicalStatus(parsed: { rows: any[]; errors: string[] }): string {
  if (parsed.errors.length > 0 || parsed.rows.length === 0) return 'parse_failed'
  return 'parsed'
}

export async function POST(req: NextRequest) {
  const started = Date.now()
  let supabase: SupabaseClient
  try {
    supabase = admin()
  } catch (err: any) {
    return NextResponse.json({ error: err.message }, { status: 500 })
  }

  const aliasMap = await getAliasMap(supabase)

  let form: FormData
  try {
    form = await req.formData()
  } catch (err: any) {
    return NextResponse.json(
      { error: `Could not read multipart form: ${err.message}` },
      { status: 400 }
    )
  }

  const portfolio_id   = form.get('portfolio_id')
  const uploaded_by    = form.get('uploaded_by')
  const cnField        = form.get('contract_notes')
  const stFields       = form.getAll('statements')
  const canonicalField = form.get('canonical_positions')

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

  const errors: string[]              = []
  const uploadedFiles: UploadedFile[] = []
  const timestamp                     = Date.now()
  const uploadSessionId               = randomUUID()

  // ── Upload + parse contract notes ────────────────────────
  let parsedCN: ParsedContractNotes | null = null
  let cnBrokerFileId: string | null = null

  {
    const up = await uploadFile(
      supabase,
      portfolio_id,
      cnField,
      'contract_notes',
      'application/pdf',
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
        kind:           'contract_notes',
        filename:       cnField.name,
        storage_path:   up.storage_path,
        parse_status:   'pending',
      }

      try {
        const buf  = Buffer.from(await cnField.arrayBuffer())
        parsedCN   = await parseContractNotesPdf(buf)

        // v27p: three-way classification
        const parse_status = classifyCnStatus(parsedCN)

        await supabase
          .from('broker_files')
          .update({
            parsed_at:      new Date().toISOString(),
            parse_status,
            parse_error:    parsedCN.parse_errors.length ? parsedCN.parse_errors.join('; ') : null,
            account_holder: parsedCN.account_holder || null,
            cscs_number:    parsedCN.cscs_number    || null,
            updated_at:     new Date().toISOString(),
          })
          .eq('id', up.broker_file_id)

        status.parse_status = parse_status
        if (parsedCN.parse_errors.length) {
          status.parse_error = parsedCN.parse_errors.join('; ')
          // Only push to errors[] (which surfaces as upload-warnings) if it's
          // a hard failure or a notable warning. Header-metadata-only is silent.
          if (parse_status === 'parse_failed') {
            errors.push(`contract_notes parse: ${status.parse_error}`)
          }
        }
      } catch (err: any) {
        await supabase
          .from('broker_files')
          .update({
            parse_status: 'parse_failed',
            parse_error:  err.message,
            updated_at:   new Date().toISOString(),
          })
          .eq('id', up.broker_file_id)
        status.parse_status = 'parse_failed'
        status.parse_error  = err.message
        errors.push(`contract_notes parse: ${err.message}`)
        parsedCN = null
      }

      uploadedFiles.push(status as UploadedFile)
    }
  }

  // ── Upload + parse each statement ────────────────────────
  const parsedStatements: ParsedStatement[]   = []
  const statementBrokerFileIds: string[]      = []

  for (const file of statementFiles) {
    const up = await uploadFile(
      supabase,
      portfolio_id,
      file,
      'statement',
      'application/pdf',
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
      kind:           'statement',
      filename:       file.name,
      storage_path:   up.storage_path,
      parse_status:   'pending',
    }

    try {
      const buf    = Buffer.from(await file.arrayBuffer())
      const parsed = await parseStatementPdf(buf)
      parsedStatements.push(parsed)
      statementBrokerFileIds.push(up.broker_file_id)

      // v27p: three-way classification
      const parse_status = classifyStatementStatus(parsed)

      await supabase
        .from('broker_files')
        .update({
          parsed_at:      new Date().toISOString(),
          parse_status,
          parse_error:    parsed.parse_errors.length ? parsed.parse_errors.join('; ') : null,
          account_holder: parsed.account_holder || null,
          cscs_number:    parsed.cscs_number    || null,
          period_from:    parsed.period.from    || null,
          period_to:      parsed.period.to      || null,
          audit_opening:  parsed.opening_balance,
          audit_closing:  parsed.closing_balance,
          audit_computed: parsed.audit.computed_closing,
          audit_passes:   parsed.audit.passes,
          updated_at:     new Date().toISOString(),
        })
        .eq('id', up.broker_file_id)

      status.parse_status = parse_status
      if (parsed.parse_errors.length) {
        status.parse_error = parsed.parse_errors.join('; ')
        if (parse_status === 'parse_failed') {
          errors.push(`${file.name}: ${status.parse_error}`)
        }
      }
    } catch (err: any) {
      await supabase
        .from('broker_files')
        .update({
          parse_status: 'parse_failed',
          parse_error:  err.message,
          updated_at:   new Date().toISOString(),
        })
        .eq('id', up.broker_file_id)
      status.parse_status = 'parse_failed'
      status.parse_error  = err.message
      errors.push(`${file.name} parse: ${err.message}`)
    }

    uploadedFiles.push(status as UploadedFile)
  }

  // ── Upload + parse canonical positions (optional) ─────────
  if (canonicalField instanceof File) {
    const lower = canonicalField.name.toLowerCase()
    const isXlsx = lower.endsWith('.xlsx')
    const isCsv  = lower.endsWith('.csv')

    if (!isXlsx && !isCsv) {
      errors.push(`canonical_positions: unsupported extension for ${canonicalField.name} — must be .csv or .xlsx`)
    } else {
      const contentType = isXlsx
        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        : 'text/csv'

      const up = await uploadFile(
        supabase,
        portfolio_id,
        canonicalField,
        'canonical_positions',
        contentType,
        timestamp,
        typeof uploaded_by === 'string' ? uploaded_by : null,
        uploadSessionId
      )

      if (up.error) {
        errors.push(`canonical_positions upload: ${up.error}`)
      } else {
        const status: Partial<UploadedFile> = {
          broker_file_id: up.broker_file_id,
          kind:           'canonical_positions',
          filename:       canonicalField.name,
          storage_path:   up.storage_path,
          parse_status:   'pending',
        }

        try {
          const buf    = Buffer.from(await canonicalField.arrayBuffer())
          const parsed = parseCSCSFile(buf, canonicalField.name, aliasMap)

          // v27p: explicit classifier for canonical (still binary semantics)
          const parse_status = classifyCanonicalStatus(parsed)

          await supabase
            .from('broker_files')
            .update({
              parsed_at:      new Date().toISOString(),
              parse_status,
              parse_error:    parsed.errors.length ? parsed.errors.join('; ') : null,
              account_holder: parsed.accountName || null,
              cscs_number:    parsed.cscsNumber  || null,
              updated_at:     new Date().toISOString(),
            })
            .eq('id', up.broker_file_id)

          status.parse_status = parse_status
          if (parsed.errors.length) {
            status.parse_error = parsed.errors.join('; ')
            errors.push(`canonical_positions parse: ${status.parse_error}`)
          }
        } catch (err: any) {
          await supabase
            .from('broker_files')
            .update({
              parse_status: 'parse_failed',
              parse_error:  err.message,
              updated_at:   new Date().toISOString(),
            })
            .eq('id', up.broker_file_id)
          status.parse_status = 'parse_failed'
          status.parse_error  = err.message
          errors.push(`canonical_positions parse: ${err.message}`)
        }

        uploadedFiles.push(status as UploadedFile)
      }
    }
  }

  // ── Reconcile + stage (CN + statements only) ─────────────
  if (!parsedCN || !cnBrokerFileId) {
    return NextResponse.json(
      {
        ok: false,
        portfolio:      { id: portfolio.id, name: portfolio.name, label: portfolio.label },
        broker_files:   uploadedFiles,
        staged_count:   0,
        errors:         [...errors, 'No contract notes parsed — cannot reconcile or stage transactions'],
        upload_session_id: uploadSessionId,
        elapsed_ms:     Date.now() - started,
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
    statementBrokerFileIds,
    aliasMap
  )

  let inserted = 0
  if (stagedRows.length > 0) {
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
      portfolio:              { id: portfolio.id, name: portfolio.name, label: portfolio.label },
      broker_files:           uploadedFiles,
      staged_count:           inserted,
      reconciliation_summary: reconciliation.summary,
      upload_session_id:      uploadSessionId,
      errors,
      elapsed_ms:             Date.now() - started,
    },
    { status: 200 }
  )
}

export async function GET() {
  return NextResponse.json({
    endpoint: '/api/broker/upload',
    method: 'POST multipart/form-data',
    fields: {
      portfolio_id:        'UUID of target portfolio (required)',
      contract_notes:      'single PDF (required)',
      statements:          '0..N PDFs',
      canonical_positions: 'optional single CSV or XLSX (CSCS Asset Position extract)',
      uploaded_by:         'optional text identifier',
    },
    returns: 'broker_files (array), staged_count, reconciliation_summary, upload_session_id, errors',
  })
}

// ─── Helpers ─────────────────────────────────────────────────────

function aliasTicker(
  t: string | null | undefined,
  aliasMap: Record<string, string>
): string | null {
  return applyAlias(t, aliasMap)
}

async function uploadFile(
  supabase: SupabaseClient,
  portfolio_id: string,
  file: File,
  kind: FileKind,
  contentType: string,
  timestamp: number,
  uploaded_by: string | null,
  upload_session_id: string
): Promise<{ broker_file_id: string; storage_path: string; error?: string }> {
  const storage_path = `${portfolio_id}/${timestamp}-${sanitize(file.name)}`
  const bytes = Buffer.from(await file.arrayBuffer())

  const up = await supabase.storage
    .from('broker-files')
    .upload(storage_path, bytes, {
      contentType,
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
      file_kind:         kind,
      original_filename: file.name,
      storage_path,
      size_bytes:        file.size,
      parse_status:      'pending',
      uploaded_by,
      upload_session_id,
      created_at:        now,
      updated_at:        now,
    })
    .select('id')
    .single()

  if (error || !data) {
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

function mapReconKind(
  k: 'exact' | 'split' | 'partial_mismatch' | 'unmatched'
): 'matched_exact' | 'matched_split' | 'partial_mismatch' | 'unmatched' {
  switch (k) {
    case 'exact':            return 'matched_exact'
    case 'split':            return 'matched_split'
    case 'partial_mismatch': return 'partial_mismatch'
    case 'unmatched':        return 'unmatched'
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
  statementBrokerFileIds: string[],
  aliasMap: Record<string, string>
): any[] {
  const rows: any[] = []

  for (const match of rec.trade_matches) {
    const cnRow: ContractNoteRow = cn.rows[match.cn_row_index]

    let cnNumbers = ''
    let narration = ''
    if (match.statement_refs.length > 0) {
      const parts: string[]     = []
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
      narration = `${cnRow.action === 'BUY' ? 'Purchase' : 'Sale'} of ${cnRow.quantity} unit(s) of ${cnRow.security_code} @ ${cnRow.price} (no statement match)`
    }

    rows.push({
      broker_file_id:    cnBrokerFileId,
      portfolio_id,
      trade_date:        cnRow.trade_date,
      settlement_date:   cnRow.settlement_date,
      action:            cnRow.action,
      instrument_id:     aliasTicker(cnRow.security_code, aliasMap),
      quantity:          cnRow.quantity,
      price:             cnRow.price,
      gross_value:       cnRow.consideration,
      amount:            cnRow.total,
      fee_commission:    cnRow.fee_commission,
      fee_vat:           cnRow.fee_vat,
      fee_exchange:      cnRow.fee_exchange,
      fee_clearing:      cnRow.fee_clearing,
      fee_sec:           cnRow.fee_sec,
      fee_contract_stamp: cnRow.fee_contract_stamp,
      fee_sms:           cnRow.fee_sms,
      cn_number:         cnNumbers || null,
      narration,
      recon_kind:        mapReconKind(match.kind),
      recon_note:        match.note || null,
      dedup_status:      'new',
      include_in_commit: true,
    })
  }

  for (const ev of rec.cash_events) {
    const brokerFileId = statementBrokerFileIds[ev.statement_index] ?? cnBrokerFileId
    const sRow: StatementRow | undefined =
      statements[ev.statement_index]?.rows[ev.row_index]
    if (!sRow) continue

    const row: any = {
      broker_file_id:    brokerFileId,
      portfolio_id,
      trade_date:        ev.date,
      action:            ev.proposed_action,
      amount:            ev.amount,
      narration:         ev.narration,
      recon_kind:        'cash_event_auto',
      dedup_status:      'new',
      include_in_commit: true,
    }

    switch (ev.kind) {
      case 'management_fee': row.fee_management = ev.amount; break
      case 'demat_fee':      row.fee_demat      = ev.amount; break
      case 'bank_charge':    row.fee_other       = ev.amount; break
    }

    const ref = extractReference(ev.narration)
    if (ref) row.external_ref = ref

    rows.push(row)
  }

  for (const orphan of rec.orphan_statement_trades) {
    const sRow = statements[orphan.statement_index]?.rows[orphan.row_index]
    if (!sRow) continue
    const brokerFileId = statementBrokerFileIds[orphan.statement_index] ?? cnBrokerFileId

    rows.push({
      broker_file_id:    brokerFileId,
      portfolio_id,
      trade_date:        sRow.trans_date,
      action:            sRow.kind === 'trade_buy' ? 'BUY' : 'SELL',
      instrument_id:     aliasTicker(sRow.ticker, aliasMap),
      quantity:          sRow.quantity,
      price:             sRow.price,
      amount:            sRow.debit > 0 ? sRow.debit : sRow.credit,
      cn_number:         sRow.cn_number || null,
      narration:         sRow.narration,
      recon_kind:        'unmatched',
      recon_note:        orphan.reason,
      dedup_status:      'new',
      include_in_commit: false,
    })
  }

  return rows
}
