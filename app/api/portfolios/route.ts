import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// GET all portfolios (optionally filtered by client)
export async function GET(req: NextRequest) {
  const clientId = req.nextUrl.searchParams.get('clientId')
  const db = supabaseAdmin()

  let query = db.from('portfolios')
    .select('*, client:clients(name,code), sleeve_targets(*)')
    .order('created_at', { ascending: true })

  if (clientId) query = query.eq('client_id', clientId)

  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ portfolios: data })
}

// POST — create a new portfolio with default sleeves and holdings
export async function POST(req: NextRequest) {
  const body = await req.json()
  const db = supabaseAdmin()

  const {
    client_id, label, name, currency = 'NGN',
    starting_nav, start_date, income_target = 0.15, cap_target = 0.30,
    liq_min = 0.05, dd_alert = -0.07, dd_action = -0.10,
    max_eq_single = 0.07, max_eq_sleeve = 0.35,
    notes = '',
    // Optional: sleeve targets override
    sleeves,
    // Optional: seed holdings from Excel defaults
    seedHoldings = false,
  } = body

  if (!client_id || !label || !name || !starting_nav || !start_date) {
    return NextResponse.json({ error: 'Missing required fields: client_id, label, name, starting_nav, start_date' }, { status: 400 })
  }

  // Check capacity (max 25 portfolios)
  const { count } = await db.from('portfolios').select('*', { count: 'exact', head: true })
  if ((count ?? 0) >= 25) {
    return NextResponse.json({ error: 'Maximum 25 portfolios reached.' }, { status: 400 })
  }

  // Create portfolio
  const { data: portfolio, error: portErr } = await db.from('portfolios').insert({
    client_id, label, name, currency, starting_nav: Number(starting_nav),
    start_date, valuation_date: start_date, income_target, cap_target,
    liq_min, dd_alert, dd_action, max_eq_single, max_eq_sleeve, notes,
    status: 'active',
  }).select().single()

  if (portErr || !portfolio) {
    return NextResponse.json({ error: portErr?.message || 'Failed to create portfolio' }, { status: 500 })
  }

  // Create sleeve targets (use defaults if not provided)
  const defaultSleeves = [
    { sleeve_id: 'liq', name: 'Liquidity (≤7 days)',         target_pct: 0.05, min_pct: 0.05, max_pct: 0.10, sort_order: 0 },
    { sleeve_id: 'ntb', name: 'NTB ladder (income core)',     target_pct: 0.40, min_pct: 0.30, max_pct: 0.55, sort_order: 1 },
    { sleeve_id: 'fgn', name: 'FGN bonds (rate-cut upside)',  target_pct: 0.25, min_pct: 0.15, max_pct: 0.35, sort_order: 2 },
    { sleeve_id: 'eq',  name: 'Equities (total return)',      target_pct: 0.30, min_pct: 0.20, max_pct: 0.35, sort_order: 3 },
  ]
  const sleevesToInsert = (sleeves || defaultSleeves).map((s: any) => ({ ...s, portfolio_id: portfolio.id }))
  await db.from('sleeve_targets').insert(sleevesToInsert)

  // Optionally seed default holdings from Portfolio A Excel data
  if (seedHoldings) {
    const seedData = [
      { instrument_id: 'CASH_NGN', sleeve_id: 'liq', quantity: starting_nav * 0.05,  avg_cost: 1 },
      { instrument_id: 'NTB_91',   sleeve_id: 'ntb', quantity: starting_nav * 0.133, avg_cost: 1 },
      { instrument_id: 'NTB_182',  sleeve_id: 'ntb', quantity: starting_nav * 0.133, avg_cost: 1 },
      { instrument_id: 'NTB_364',  sleeve_id: 'ntb', quantity: starting_nav * 0.134, avg_cost: 1 },
      { instrument_id: 'FGN_5_7',  sleeve_id: 'fgn', quantity: starting_nav * 0.133, avg_cost: 1 },
      { instrument_id: 'FGN_10',   sleeve_id: 'fgn', quantity: starting_nav * 0.117, avg_cost: 1 },
      { instrument_id: 'UBA',      sleeve_id: 'eq',  quantity: Math.floor(starting_nav * 0.05  / 27.50),  avg_cost: 27.50 },
      { instrument_id: 'GTCO',     sleeve_id: 'eq',  quantity: Math.floor(starting_nav * 0.05  / 58.30),  avg_cost: 58.30 },
      { instrument_id: 'ZENITH',   sleeve_id: 'eq',  quantity: Math.floor(starting_nav * 0.05  / 47.80),  avg_cost: 47.80 },
      { instrument_id: 'DANGCEM',  sleeve_id: 'eq',  quantity: Math.floor(starting_nav * 0.05  / 335.00), avg_cost: 335.00 },
      { instrument_id: 'STANBIC',  sleeve_id: 'eq',  quantity: Math.floor(starting_nav * 0.05  / 82.50),  avg_cost: 82.50 },
      { instrument_id: 'SEPLAT',   sleeve_id: 'eq',  quantity: Math.floor(starting_nav * 0.05  / 4850),   avg_cost: 4850 },
    ]
    await db.from('holdings').insert(seedData.map(h => ({ ...h, portfolio_id: portfolio.id, as_of_date: start_date })))
  }

  return NextResponse.json({ portfolio }, { status: 201 })
}
