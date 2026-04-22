/**
 * app/api/broker/staged/[id]/route.ts — v21b-3b
 *
 * PATCH /api/broker/staged/[id]
 *   Body: { include_in_commit: boolean }
 *   Toggles a single staged row's include_in_commit flag.
 *   Used by the session detail page checkboxes.
 *
 *   Returns { staged: { id, include_in_commit } } on success.
 *
 * No guard on parse_status — you CAN toggle after a session is
 * committed; it just has no effect on the already-committed
 * transactions. Useful when preparing for a second commit
 * after a rollback.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient, SupabaseClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function admin(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars'
    )
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    if (!id) {
      return NextResponse.json({ error: 'staged row id required' }, { status: 400 })
    }

    const body = await req.json().catch(() => null)
    if (!body || typeof body.include_in_commit !== 'boolean') {
      return NextResponse.json(
        { error: 'Body must be { include_in_commit: boolean }' },
        { status: 400 }
      )
    }

    const db = admin()
    const { data, error } = await db
      .from('staged_transactions')
      .update({ include_in_commit: body.include_in_commit })
      .eq('id', id)
      .select('id, include_in_commit')
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    if (!data) {
      return NextResponse.json({ error: 'staged row not found' }, { status: 404 })
    }

    return NextResponse.json({ staged: data })
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'unknown error' },
      { status: 500 }
    )
  }
}
