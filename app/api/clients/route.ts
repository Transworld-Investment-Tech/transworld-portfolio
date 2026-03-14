import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  const db = supabaseAdmin()
  const id = req.nextUrl.searchParams.get('id')

  if (id) {
    const { data, error } = await db
      .from('clients')
      .select('*, portfolios(id, label, name, starting_nav, currency, status, valuation_date, created_at)')
      .eq('id', id)
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 404 })
    return NextResponse.json({ client: data })
  }

  const { data, error } = await db
    .from('clients')
    .select('*, portfolios(id, label, name, starting_nav, status)')
    .order('created_at', { ascending: true })
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ clients: data })
}

export async function POST(req: NextRequest) {
  const body = await req.json()
  const db = supabaseAdmin()
  const { data, error } = await db.from('clients').insert(body).select().single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ client: data }, { status: 201 })
}

export async function PATCH(req: NextRequest) {
  const { id, ...updates } = await req.json()
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const db = supabaseAdmin()
  const { data, error } = await db.from('clients').update(updates).eq('id', id).select().single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ client: data })
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('id')
  if (!id) return NextResponse.json({ error: 'id required' }, { status: 400 })
  const db = supabaseAdmin()
  // Soft delete — set status to inactive
  const { error } = await db.from('clients').update({ status: 'inactive' }).eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ success: true })
}
