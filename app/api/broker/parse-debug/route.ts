/**
 * app/api/broker/parse-debug/route.ts — v21a
 *
 * Throwaway debug endpoint for the v21 parser work. Takes multipart
 * form-data with:
 *   - "contract_notes": one PDF (the broker's printed contract notes)
 *   - "statements":     zero or more PDFs (yearly statements of account)
 *
 * Returns full parsed + reconciled JSON for inspection. No DB writes.
 * No auth beyond Next's normal flow. Will be deleted in v21b when the
 * real broker-import UI lands.
 */

import { NextRequest, NextResponse } from 'next/server'
import {
  parseContractNotesPdf,
  parseStatementPdf,
  reconcile,
  type ParsedContractNotes,
  type ParsedStatement,
} from '@/lib/broker-parser'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(req: NextRequest) {
  const started = Date.now()

  let formData: FormData
  try {
    formData = await req.formData()
  } catch (err: any) {
    return NextResponse.json(
      { error: `Could not read multipart form data: ${err.message}` },
      { status: 400 }
    )
  }

  const cnFile = formData.get('contract_notes')
  const stFiles = formData.getAll('statements')
  const includeRawLines = formData.get('include_raw_lines') === 'true'

  const errors: string[] = []
  let contract_notes: ParsedContractNotes | null = null
  const statements: ParsedStatement[] = []

  if (cnFile && cnFile instanceof File) {
    try {
      const buf = Buffer.from(await cnFile.arrayBuffer())
      contract_notes = await parseContractNotesPdf(buf, { includeRawLines })
    } catch (err: any) {
      errors.push(`contract_notes (${cnFile.name}): ${err.message}`)
    }
  }

  for (const f of stFiles) {
    if (!(f instanceof File)) continue
    try {
      const buf = Buffer.from(await f.arrayBuffer())
      const parsed = await parseStatementPdf(buf, { includeRawLines })
      statements.push(parsed)
    } catch (err: any) {
      errors.push(`statement (${f.name}): ${err.message}`)
    }
  }

  const response: any = {
    ok: errors.length === 0,
    elapsed_ms: 0,
    errors,
    contract_notes,
    statements,
  }

  if (contract_notes) {
    response.reconciliation = reconcile(contract_notes, statements)
  }

  response.elapsed_ms = Date.now() - started
  return NextResponse.json(response, { status: 200 })
}

export async function GET() {
  return NextResponse.json({
    endpoint: '/api/broker/parse-debug',
    method: 'POST multipart/form-data',
    fields: {
      contract_notes: 'single PDF (broker contract notes)',
      statements: '0..N PDFs (yearly statements of account)',
      include_raw_lines: '"true" to include the raw text-extracted lines per file (large output)',
    },
    example_curl: [
      'curl -sS -X POST https://YOUR-DEPLOYMENT/api/broker/parse-debug \\',
      '  -F "contract_notes=@path/to/Contract_Notes.pdf" \\',
      '  -F "statements=@path/to/Statement_1.pdf" \\',
      '  -F "statements=@path/to/Statement_2.pdf"',
    ].join('\n'),
    note: 'Throwaway endpoint — will be removed in v21b when the real broker-import UI ships.',
  })
}
