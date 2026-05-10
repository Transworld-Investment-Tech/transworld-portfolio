// ═══════════════════════════════════════════════════════════════
// /api/cockpit/signal-dispositions (v27ay)
// ═══════════════════════════════════════════════════════════════
//
// Reads/writes per-signal dispositions for "today" (UTC date,
// matching the signals localStorage cache key).
//
// GET   ?as_of_date=YYYY-MM-DD       (defaults to today UTC)
//       returns { as_of_date, dispositions: { signal_id: 'dismissed'|'acted_on' } }
//
// POST  body: { signal_id, as_of_date, disposition: 'dismissed'|'acted_on'|null }
//       null  → DELETE the row for (signal_id, as_of_date)
//       value → UPSERT on the (signal_id, as_of_date) unique constraint
//       returns { ok: true } on success or { error } on failure
//
// Same Supabase client pattern as /api/cockpit/signals/route.ts:
// service-role-key with anon fallback. Returns empty dispositions
// (200) if env is missing or any error fires, so the UI degrades
// gracefully rather than blocking the page.
// ═══════════════════════════════════════════════════════════════

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import {
  todayIsoDate,
  type Disposition,
  type DispositionMap,
} from '@/lib/cockpit-signal-dispositions'

export const dynamic = 'force-dynamic'
export const maxDuration = 15

function client() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
            ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) return null
  return createClient(url, key)
}

const validDisposition = (v: unknown): v is Disposition =>
  v === 'dismissed' || v === 'acted_on'

const isIsoDate = (s: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(s)

export async function GET(request: Request) {
  const db = client()
  if (!db) {
    return NextResponse.json(
      { error: 'supabase env missing', dispositions: {} },
      { status: 500 },
    )
  }

  const url = new URL(request.url)
  const as_of_date = url.searchParams.get('as_of_date') || todayIsoDate()

  if (!isIsoDate(as_of_date)) {
    return NextResponse.json(
      { error: 'as_of_date must be YYYY-MM-DD', dispositions: {} },
      { status: 400 },
    )
  }

  try {
    const { data, error } = await db
      .from('cockpit_signal_dispositions')
      .select('signal_id, disposition')
      .eq('as_of_date', as_of_date)

    if (error) {
      return NextResponse.json(
        { error: error.message, dispositions: {} },
        { status: 500 },
      )
    }

    const dispositions: DispositionMap = {}
    for (const row of (data ?? []) as { signal_id: string; disposition: Disposition }[]) {
      dispositions[row.signal_id] = row.disposition
    }
    return NextResponse.json({ as_of_date, dispositions })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error'
    return NextResponse.json(
      { error: msg, dispositions: {} },
      { status: 500 },
    )
  }
}

export async function POST(request: Request) {
  const db = client()
  if (!db) {
    return NextResponse.json({ error: 'supabase env missing' }, { status: 500 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'invalid json' }, { status: 400 })
  }

  const b = body as {
    signal_id?:   unknown
    as_of_date?:  unknown
    disposition?: unknown
  }
  const signal_id  = typeof b.signal_id  === 'string' ? b.signal_id  : null
  const as_of_date = typeof b.as_of_date === 'string' ? b.as_of_date : null

  if (!signal_id || !as_of_date) {
    return NextResponse.json(
      { error: 'signal_id and as_of_date required' },
      { status: 400 },
    )
  }
  if (!isIsoDate(as_of_date)) {
    return NextResponse.json(
      { error: 'as_of_date must be YYYY-MM-DD' },
      { status: 400 },
    )
  }

  try {
    if (b.disposition === null) {
      const { error } = await db
        .from('cockpit_signal_dispositions')
        .delete()
        .eq('signal_id', signal_id)
        .eq('as_of_date', as_of_date)
      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
      return NextResponse.json({ ok: true })
    }

    if (!validDisposition(b.disposition)) {
      return NextResponse.json(
        { error: 'disposition must be dismissed | acted_on | null' },
        { status: 400 },
      )
    }

    const { error } = await db
      .from('cockpit_signal_dispositions')
      .upsert(
        { signal_id, as_of_date, disposition: b.disposition },
        { onConflict: 'signal_id,as_of_date' },
      )
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error'
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
