import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// v21l: GET /api/aliases — list all ticker aliases
//       POST /api/aliases — create a new alias

export async function GET() {
  const db = supabaseAdmin()
  const { data, error } = await db
    .from('ticker_aliases')
    .select('id, broker_ticker, canonical_id, notes, created_at, updated_at')
    .order('broker_ticker')

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ aliases: data ?? [] })
}

export async function POST(req: NextRequest) {
  const { broker_ticker, canonical_id, notes } = await req.json()

  if (!broker_ticker || !canonical_id) {
    return NextResponse.json(
      { error: 'broker_ticker and canonical_id are required' },
      { status: 400 }
    )
  }

  const db = supabaseAdmin()

  // Verify canonical_id exists in instruments
  const { data: instr } = await db
    .from('instruments')
    .select('instrument_id, name')
    .eq('instrument_id', canonical_id.toUpperCase().trim())
    .single()

  if (!instr) {
    return NextResponse.json(
      { error: `canonical_id '${canonical_id}' not found in instruments master` },
      { status: 400 }
    )
  }

  const now = new Date().toISOString()
  const { data, error } = await db
    .from('ticker_aliases')
    .insert({
      broker_ticker: broker_ticker.toUpperCase().trim(),
      canonical_id:  canonical_id.toUpperCase().trim(),
      notes:         notes ?? null,
      created_at:    now,
      updated_at:    now,
    })
    .select('id, broker_ticker, canonical_id, notes, created_at')
    .single()

  if (error) {
    if (error.code === '23505') {
      return NextResponse.json(
        { error: `Alias for '${broker_ticker.toUpperCase()}' already exists` },
        { status: 409 }
      )
    }
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ alias: data }, { status: 201 })
}
