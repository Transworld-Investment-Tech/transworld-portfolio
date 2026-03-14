import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

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

export async function PUT(req: NextRequest) {
  const body = await req.json()
  const { portfolioId, instrumentId, quantity, avgCost } = body
  const db = supabaseAdmin()
  const { error } = await db.from('holdings').update({
    quantity, avg_cost: avgCost, updated_at: new Date().toISOString()
  }).match({ portfolio_id: portfolioId, instrument_id: instrumentId })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
