import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { MANUAL_ENTRY_NOTES } from '../route'

// v27ae: GET /api/holdings/provenance?portfolioId=X&instrumentId=Y
// Returns the breakdown of transaction provenance for (portfolio, instrument).
// The Holdings-page Edit and Delete modals call this BEFORE showing the
// confirm action so the operator can see what stays and what gets replaced.
//
// Categories:
//   manual       — notes in MANUAL_ENTRY_NOTES (Add/Edit Position)
//   synth        — external_ref LIKE 'synthetic-recovery-%'
//   reconciliation — external_ref LIKE 'corp-action-%' (variance panel writes)
//   broker       — has source_file_id (broker import flow)
//   other        — everything else (legacy / SQL-direct edits)

export async function GET(req: NextRequest) {
  const portfolioId  = req.nextUrl.searchParams.get('portfolioId')
  const instrumentId = req.nextUrl.searchParams.get('instrumentId')

  if (!portfolioId || !instrumentId) {
    return NextResponse.json(
      { error: 'portfolioId and instrumentId required' },
      { status: 400 }
    )
  }

  const db = supabaseAdmin()

  const { data: txns, error } = await db
    .from('transactions')
    .select('id, action, quantity, notes, external_ref, source_file_id')
    .eq('portfolio_id', portfolioId)
    .eq('instrument_id', instrumentId)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  const rows = txns ?? []
  let manual = 0
  let synth = 0
  let recon = 0
  let broker = 0
  let other = 0

  for (const t of rows) {
    if (MANUAL_ENTRY_NOTES.includes(t.notes ?? '')) {
      manual++
    } else if ((t.external_ref ?? '').startsWith('synthetic-recovery-')) {
      synth++
    } else if ((t.external_ref ?? '').startsWith('corp-action-')) {
      recon++
    } else if (t.source_file_id) {
      broker++
    } else {
      other++
    }
  }

  return NextResponse.json({
    portfolio_id: portfolioId,
    instrument_id: instrumentId,
    counts: { manual, synth, reconciliation: recon, broker, other, total: rows.length },
    has_non_manual: synth + recon + broker + other > 0,
  })
}
