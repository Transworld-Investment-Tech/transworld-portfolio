import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const db = supabaseAdmin()

  // Soft archive the client and all their portfolios
  const [ce, pe] = await Promise.all([
    db.from('clients').update({ status: 'archived' }).eq('id', id),
    db.from('portfolios').update({ status: 'archived' }).eq('client_id', id),
  ])

  if (ce.error) return NextResponse.json({ error: ce.error.message }, { status: 500 })
  return NextResponse.json({ ok: true })
}
