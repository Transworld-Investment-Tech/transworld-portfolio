import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function GET(req: NextRequest) {
  const db = supabaseAdmin()
  const section = req.nextUrl.searchParams.get('section')
  let query = db.from('watchlist').select('*').eq('active', true).order('rank').order('name')
  if (section) query = query.eq('section', section)
  const { data, error } = await query
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ items: data })
}

export async function POST(req: NextRequest) {
  const db = supabaseAdmin()
  const body = await req.json()
  const { data, error } = await db.from('watchlist').insert({
    ticker:    body.ticker ?? '',
    name:      body.name,
    section:   body.section,
    sub_type:  body.sub_type ?? null,
    rationale: body.rationale ?? null,
    tags:      body.tags ?? [],
    notes:     body.notes ?? null,
    rank:      body.rank ?? 999,
  }).select().single()
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ item: data })
}
