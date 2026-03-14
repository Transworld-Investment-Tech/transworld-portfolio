import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export interface ImportRow {
  trade_date:      string
  action:          string   // BUY | SELL | INCOME | FEE | TRANSFER_IN | TRANSFER_OUT
  instrument_id:   string
  quantity:        number | null
  price:           number | null
  gross_value:     number | null
  fees:            number | null
  fee_commission:  number | null
  fee_vat:         number | null
  fee_contract_stamp: number | null
  fee_exchange:    number | null
  fee_clearing:    number | null
  fee_sms:         number | null
  amount:          number | null
  broker:          string | null
  notes:           string | null
}

export interface ImportRequest {
  portfolioId: string
  rows:        ImportRow[]
  skipDupes:   boolean
}

export async function POST(req: NextRequest) {
  const db = supabaseAdmin()
  const body: ImportRequest = await req.json()
  const { portfolioId, rows, skipDupes } = body

  if (!portfolioId || !rows?.length)
    return NextResponse.json({ error: 'portfolioId and rows required' }, { status: 400 })

  // Verify portfolio exists
  const { data: port } = await db.from('portfolios').select('id, name').eq('id', portfolioId).single()
  if (!port) return NextResponse.json({ error: 'Portfolio not found' }, { status: 404 })

  // Get existing transactions to detect duplicates
  const { data: existing } = await db.from('transactions')
    .select('trade_date, instrument_id, action, quantity, price')
    .eq('portfolio_id', portfolioId)

  const existingKeys = new Set(
    (existing ?? []).map(t =>
      `${t.trade_date}|${t.instrument_id}|${t.action}|${t.quantity}|${t.price}`
    )
  )

  // Get all known instruments
  const { data: instruments } = await db.from('instruments').select('instrument_id')
  const knownInstruments = new Set((instruments ?? []).map((i: any) => i.instrument_id))

  const results = { inserted: 0, skipped: 0, errors: [] as string[], warnings: [] as string[] }

  for (const row of rows) {
    // Validate
    if (!row.trade_date || !row.action) {
      results.errors.push(`Row missing date or action: ${JSON.stringify(row)}`)
      continue
    }

    // Normalise action
    const action = row.action.toUpperCase().trim().replace(/\s+/g, '_')
    if (!['BUY','SELL','INCOME','FEE','TRANSFER_IN','TRANSFER_OUT'].includes(action)) {
      results.errors.push(`Unknown action "${row.action}" — skipped`)
      continue
    }

    // Normalise instrument
    const instrId = (row.instrument_id ?? '').toUpperCase().trim()
    if (!knownInstruments.has(instrId) && instrId) {
      results.warnings.push(`Unknown instrument "${instrId}" — auto-creating as Stock`)
      await db.from('instruments').upsert({
        instrument_id: instrId, name: instrId, type: 'Stock',
        sleeve_id: 'eq', asset_class: 'Equity', approved: false,
      }, { onConflict: 'instrument_id', ignoreDuplicates: true })
    }

    // Compute gross value if missing
    const qty   = row.quantity ?? null
    const price = row.price ?? null
    const gross = row.gross_value ?? (qty && price ? qty * price : null)

    // Duplicate check
    const key = `${row.trade_date}|${instrId}|${action}|${qty}|${price}`
    if (skipDupes && existingKeys.has(key)) {
      results.skipped++
      continue
    }

    const { error } = await db.from('transactions').insert({
      portfolio_id:        portfolioId,
      trade_date:          row.trade_date,
      action,
      instrument_id:       instrId || null,
      quantity:            qty,
      price,
      gross_value:         gross,
      amount:              row.amount ?? null,
      fees:                row.fees ?? null,
      fee_commission:      row.fee_commission ?? null,
      fee_vat:             row.fee_vat ?? null,
      fee_contract_stamp:  row.fee_contract_stamp ?? null,
      fee_exchange:        row.fee_exchange ?? null,
      fee_clearing:        row.fee_clearing ?? null,
      fee_sms:             row.fee_sms ?? null,
      broker:              row.broker ?? null,
      notes:               row.notes ?? null,
    })

    if (error) results.errors.push(`${row.trade_date} ${instrId}: ${error.message}`)
    else { results.inserted++; existingKeys.add(key) }
  }

  return NextResponse.json({
    ok:       results.errors.length === 0,
    portfolio: port.name,
    ...results,
    summary: `${results.inserted} inserted, ${results.skipped} skipped, ${results.errors.length} errors`,
  })
}
