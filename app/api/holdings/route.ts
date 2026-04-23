import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { rebuildPortfolioHoldings } from '@/lib/holdings-rebuild'

// v21p: POST now writes a BUY transaction and rebuilds holdings from
// transactions instead of writing directly to the holdings table.
// This ensures nav_log reconstruction works for all positions.

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
