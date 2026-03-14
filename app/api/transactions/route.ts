import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  const portfolioId = req.nextUrl.searchParams.get('portfolioId')
  if (!portfolioId) return NextResponse.json({ error: 'portfolioId required' }, { status: 400 })
  const db = supabaseAdmin()
  const { data, error } = await db
    .from('transactions')
    .select('*')
    .eq('portfolio_id', portfolioId)
    .order('trade_date', { ascending: false })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ transactions: data })
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const db = supabaseAdmin()
  const { error, data } = await db.from('transactions').insert(body).select().single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ transaction: data }, { status: 201 })
}
