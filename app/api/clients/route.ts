import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

// POST /api/clients — create a new client
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { code, name, type } = body

    // Validation
    if (!code || typeof code !== 'string') {
      return NextResponse.json({ error: 'code is required' }, { status: 400 })
    }
    if (!name || typeof name !== 'string') {
      return NextResponse.json({ error: 'name is required' }, { status: 400 })
    }
    if (!type || !['discretionary', 'advisory', 'internal'].includes(type)) {
      return NextResponse.json(
        { error: 'type must be discretionary, advisory, or internal' },
        { status: 400 }
      )
    }

    const normalisedCode = code.toUpperCase().trim()
    if (!/^[A-Z0-9]{2,10}$/.test(normalisedCode)) {
      return NextResponse.json(
        { error: 'code must be 2-10 uppercase letters/digits' },
        { status: 400 }
      )
    }

    const db = supabaseAdmin()

    // Uniqueness check (DB also enforces via UNIQUE constraint, but we want a nicer error)
    const { data: existing } = await db
      .from('clients')
      .select('id')
      .eq('code', normalisedCode)
      .maybeSingle()
    if (existing) {
      return NextResponse.json(
        { error: `Code "${normalisedCode}" is already in use` },
        { status: 409 }
      )
    }

    const { data, error } = await (db.from('clients') as any)
      .insert({
        code: normalisedCode,
        name: name.trim(),
        type,
        status: 'active',
      })
      .select()
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ client: data })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
