import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { rebuildPortfolioHoldings } from '@/lib/holdings-rebuild'

// v21p: POST writes a BUY transaction and rebuilds holdings from
// transactions instead of writing directly to the holdings table.
// This ensures nav_log reconstruction works for all positions.
//
// v27ae: DELETE and PATCH added. The pre-v27ae trash button on the
// Holdings page deleted only the holdings cache row, leaving orphan
// BUY transactions that re-derived on next rebuild (pitfall #61 + #90).
// New DELETE removes manual-entry transaction rows along with the cache
// row; PATCH performs an atomic delete-then-add for in-place quantity /
// price / date corrections. Both preserve provenance — synth, recon,
// and broker-import rows are NEVER touched.

export const MANUAL_ENTRY_NOTES = [
  'Added via Holdings page — Add Position',
  'Added via Holdings page — Edit Position',
]

export async function GET(req: NextRequest) {
  const portfolioId = req.nextUrl.searchParams.get('portfolioId')
  if (!portfolioId) return NextResponse.json({ error: 'portfolioId required' }, { status: 400 })
  const db = supabaseAdmin()
  const { data, error } = await db
    .from('holdings')
    .select('*, instrument:instruments(*)')
    .eq('portfolio_id', portfolioId)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ holdings: data })
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const { portfolioId, instrumentId, quantity, avgCost, tradeDate } = body

  if (!portfolioId || !instrumentId || !quantity) {
    return NextResponse.json(
      { error: 'portfolioId, instrumentId and quantity are required' },
      { status: 400 }
    )
  }

  const db = supabaseAdmin()

  // Verify instrument exists
  const { data: instr } = await db
    .from('instruments')
    .select('instrument_id, sleeve_id')
    .eq('instrument_id', instrumentId)
    .maybeSingle()

  if (!instr) {
    return NextResponse.json({ error: `Instrument ${instrumentId} not found in master` }, { status: 400 })
  }

  const date  = tradeDate || new Date().toISOString().slice(0, 10)
  const price = Number(avgCost)  || 0
  const qty   = Number(quantity)

  // Write BUY transaction — this is the source of truth
  const { error: txError } = await db.from('transactions').insert({
    portfolio_id:    portfolioId,
    trade_date:      date,
    settlement_date: date,
    action:          'BUY',
    instrument_id:   instrumentId,
    quantity:        qty,
    price:           price,
    gross_value:     qty * price,
    amount:          qty * price,
    fees:            0,
    broker:          'Manual entry',
    notes:           'Added via Holdings page — Add Position',
  })

  if (txError) return NextResponse.json({ error: txError.message }, { status: 500 })

  // Rebuild holdings from full transaction history
  const result = await rebuildPortfolioHoldings(db, portfolioId)

  return NextResponse.json({ success: true, rebuild: result })
}

// PUT — legacy direct holdings cache update path. Preserved verbatim.
// Note: this path bypasses transaction-derivation discipline (#61) and is
// retained only for compatibility with the inline Save buttons on the
// Holdings page. New manual-entry edits should use PATCH (atomic
// delete-then-add) which keeps holdings derived from transactions.
export async function PUT(req: NextRequest) {
  const body = await req.json()
  const { portfolioId, instrumentId, quantity, avgCost } = body
  const db = supabaseAdmin()
  const { error } = await (db.from('holdings') as any).update({
    quantity, avg_cost: avgCost, updated_at: new Date().toISOString()
  }).match({ portfolio_id: portfolioId, instrument_id: instrumentId })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}

// v27ae: DELETE — Cascade-delete only manual-entry transactions for
// (portfolioId, instrumentId), then rebuild. Synth / reconciliation /
// broker-import rows are PRESERVED. Returns counts so the UI can confirm
// expected vs actual deletion scope.
export async function DELETE(req: NextRequest) {
  const portfolioId  = req.nextUrl.searchParams.get('portfolioId')
  const instrumentId = req.nextUrl.searchParams.get('instrumentId')

  if (!portfolioId || !instrumentId) {
    return NextResponse.json(
      { error: 'portfolioId and instrumentId query params required' },
      { status: 400 }
    )
  }

  const db = supabaseAdmin()

  // Pre-count for response visibility — what's about to be deleted vs
  // what stays. Manual-only deletion preserves all provenance-tagged rows.
  const { data: allTxns, error: countErr } = await db
    .from('transactions')
    .select('id, action, notes, external_ref, source_file_id')
    .eq('portfolio_id', portfolioId)
    .eq('instrument_id', instrumentId)

  if (countErr) {
    return NextResponse.json({ error: `lookup failed: ${countErr.message}` }, { status: 500 })
  }

  const txns = allTxns ?? []
  const manualIds  = txns.filter(t => MANUAL_ENTRY_NOTES.includes(t.notes ?? '')).map(t => t.id)
  const preserved  = txns.filter(t => !MANUAL_ENTRY_NOTES.includes(t.notes ?? ''))

  if (manualIds.length === 0) {
    return NextResponse.json({
      error: 'No manual-entry transactions found for this position. Use the broker import / reconciliation / synth flow to manage non-manual rows.',
      preserved_count: preserved.length,
    }, { status: 400 })
  }

  // Delete manual-entry rows
  const { error: delErr } = await db
    .from('transactions')
    .delete()
    .in('id', manualIds)

  if (delErr) {
    return NextResponse.json({ error: `delete failed: ${delErr.message}` }, { status: 500 })
  }

  // Rebuild holdings from remaining transactions. If preserved.length === 0
  // (pure manual-entry position), the rebuild will end up with no row
  // for this instrument and the cache entry will be cleaned up too.
  const rebuild = await rebuildPortfolioHoldings(db, portfolioId)

  return NextResponse.json({
    success: true,
    deleted_count: manualIds.length,
    preserved_count: preserved.length,
    rebuild,
  })
}

// v27ae: PATCH — Atomic edit. Deletes existing manual-entry rows for
// (portfolioId, instrumentId), then writes one fresh BUY tagged
// 'Edit Position' with the new (qty, price, date). Synth / recon /
// broker rows are preserved. Implementation is sequential not transactional
// because Supabase JS client does not expose explicit BEGIN/COMMIT. If the
// INSERT fails after the DELETE, the position is left empty of manual
// rows but with all non-manual rows still intact — the operator can simply
// re-Add the position. This is acceptable degradation; the failure mode
// of the prior code (silent re-derivation from orphan rows) is worse.
export async function PATCH(req: NextRequest) {
  const body = await req.json()
  const { portfolioId, instrumentId, quantity, avgCost, tradeDate } = body

  if (!portfolioId || !instrumentId || !quantity || !tradeDate) {
    return NextResponse.json(
      { error: 'portfolioId, instrumentId, quantity, tradeDate required' },
      { status: 400 }
    )
  }

  const db = supabaseAdmin()

  // Verify instrument still exists
  const { data: instr } = await db
    .from('instruments')
    .select('instrument_id, sleeve_id')
    .eq('instrument_id', instrumentId)
    .maybeSingle()
  if (!instr) {
    return NextResponse.json({ error: `Instrument ${instrumentId} not found in master` }, { status: 400 })
  }

  // Find manual rows to replace
  const { data: txns, error: lookupErr } = await db
    .from('transactions')
    .select('id, notes')
    .eq('portfolio_id', portfolioId)
    .eq('instrument_id', instrumentId)

  if (lookupErr) {
    return NextResponse.json({ error: `lookup failed: ${lookupErr.message}` }, { status: 500 })
  }

  const manualIds = (txns ?? [])
    .filter(t => MANUAL_ENTRY_NOTES.includes(t.notes ?? ''))
    .map(t => t.id)

  let deleted_count = 0
  if (manualIds.length > 0) {
    const { error: delErr } = await db
      .from('transactions')
      .delete()
      .in('id', manualIds)
    if (delErr) {
      return NextResponse.json({ error: `delete-phase failed: ${delErr.message}` }, { status: 500 })
    }
    deleted_count = manualIds.length
  }

  // Insert replacement BUY
  const price = Number(avgCost) || 0
  const qty   = Number(quantity)
  const { data: newTxn, error: insErr } = await db
    .from('transactions')
    .insert({
      portfolio_id:    portfolioId,
      trade_date:      tradeDate,
      settlement_date: tradeDate,
      action:          'BUY',
      instrument_id:   instrumentId,
      quantity:        qty,
      price:           price,
      gross_value:     qty * price,
      amount:          qty * price,
      fees:            0,
      broker:          'Manual entry',
      notes:           'Added via Holdings page — Edit Position',
    })
    .select('id')
    .maybeSingle()

  if (insErr) {
    return NextResponse.json({
      error: `insert-phase failed (${deleted_count} manual rows already deleted): ${insErr.message}`,
      deleted_count,
      partial: true,
    }, { status: 500 })
  }

  const rebuild = await rebuildPortfolioHoldings(db, portfolioId)

  return NextResponse.json({
    success: true,
    deleted_count,
    new_transaction_id: newTxn?.id ?? null,
    rebuild,
  })
}
