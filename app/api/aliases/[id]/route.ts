import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// v21l: DELETE /api/aliases/[id] — delete an alias
//       PATCH  /api/aliases/[id] — update notes (broker_ticker and canonical_id are immutable)

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const db = supabaseAdmin()
  const { error } = await db.from('ticker_aliases').delete().eq('id', id)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const body = await req.json()
  const db = supabaseAdmin()

  const updateData: any = { updated_at: new Date().toISOString() }
  if (typeof body.notes !== 'undefined') updateData.notes = body.notes

  const { data, error } = await db
    .from('ticker_aliases')
    .update(updateData)
    .eq('id', id)
    .select('id, broker_ticker, canonical_id, notes, updated_at')
    .single()

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ alias: data })
}
