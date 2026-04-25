import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// v24:  POST /api/admin/import-bond-yields/accept
// v24b: Within-batch dedupe before UPSERT.
//
// The Postgres ON CONFLICT clause can only resolve ONE conflict per row in
// a single INSERT statement. If the proposals array contains two rows with
// the same (instrument_id, yield_as_of), Postgres rejects the whole INSERT
// with: "ON CONFLICT DO UPDATE command cannot affect row a second time".
//
// In practice this happens whenever two uploaded brokerage files share a
// Market Day (e.g. a re-pulled file, a renamed copy, or two file numbers
// coincidentally targeting the same EOM date). The server collapses the
// proposals array by (instrument_id, yield_as_of) — last write wins —
// and reports the dedupe count in the response.

export const maxDuration = 60

interface AcceptedProposal {
  instrument_id:  string
  yield_pct:      number
  yield_as_of:    string   // ISO date 'YYYY-MM-DD'
  coupon_pct:     number | null
  maturity_date:  string | null
  clean_price:    number | null
  notes:          string
}

interface AcceptResponse {
  history_inserted: number
  current_updated:  number
  unique_dates:     number
  deduped:          number  // v24b: count of within-batch collisions collapsed
  errors:           Array<{ instrument_id: string; message: string }>
}

const numOrNull = (v: any): number | null => {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return isFinite(n) ? n : null
}

export async function POST(req: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseKey) {
    return NextResponse.json({ error: 'Supabase config missing' }, { status: 500 })
  }

  let body: { proposals?: AcceptedProposal[] }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const proposals = body.proposals ?? []
  if (proposals.length === 0) {
    return NextResponse.json({ error: 'No proposals provided' }, { status: 400 })
  }

  // Validate + coerce each proposal at the boundary
  const valid: AcceptedProposal[] = []
  const errors: Array<{ instrument_id: string; message: string }> = []

  for (const p of proposals) {
    if (!p.instrument_id || typeof p.instrument_id !== 'string') {
      errors.push({ instrument_id: String(p.instrument_id ?? '?'), message: 'missing instrument_id' })
      continue
    }
    const y = numOrNull(p.yield_pct)
    if (y === null || y <= 0 || y > 200) {
      errors.push({ instrument_id: p.instrument_id, message: `invalid yield_pct: ${p.yield_pct}` })
      continue
    }
    if (!p.yield_as_of || !/^\d{4}-\d{2}-\d{2}$/.test(p.yield_as_of)) {
      errors.push({ instrument_id: p.instrument_id, message: `invalid yield_as_of: ${p.yield_as_of}` })
      continue
    }
    valid.push({
      instrument_id:  p.instrument_id,
      yield_pct:      y,
      yield_as_of:    p.yield_as_of,
      coupon_pct:     numOrNull(p.coupon_pct),
      maturity_date:  p.maturity_date ?? null,
      clean_price:    numOrNull(p.clean_price),
      notes:          p.notes ?? '',
    })
  }

  if (valid.length === 0) {
    return NextResponse.json({ error: 'All proposals invalid', errors }, { status: 400 })
  }

  // ── v24b: dedupe within-batch by (instrument_id, yield_as_of) ─────────
  // When two files in the upload share a Market Day, the same instrument
  // appears twice with the same yield_as_of. Postgres can't UPSERT both in
  // one statement, so collapse to a single row per key — last-write-wins.
  // Order in the array is preserved by the original parse (file iteration
  // order); the LAST occurrence wins, which means the file the user picked
  // most recently in their picker takes precedence. In practice the YTM
  // values for the same (instrument, date) should be identical anyway.
  const dedupeMap = new Map<string, AcceptedProposal>()
  for (const p of valid) {
    const key = `${p.instrument_id}|${p.yield_as_of}`
    dedupeMap.set(key, p)
  }
  const clean = Array.from(dedupeMap.values())
  const dedupedCount = valid.length - clean.length

  const db = createClient(supabaseUrl, supabaseKey)

  // 1. Upsert into yield_history.
  const historyRows = clean.map(p => ({
    instrument_id: p.instrument_id,
    yield_as_of:   p.yield_as_of,
    yield_pct:     Number(p.yield_pct.toFixed(4)),
    yield_source:  'brokerage',
    coupon_pct:    p.coupon_pct,
    maturity_date: p.maturity_date,
    price_clean:   p.clean_price,
    notes:         p.notes,
  }))

  const { error: histErr, count: histCount } = await db
    .from('yield_history')
    .upsert(historyRows, { onConflict: 'instrument_id,yield_as_of', count: 'exact' })

  if (histErr) {
    const isMissing = /relation .* does not exist|table .* does not exist/i.test(histErr.message)
    return NextResponse.json({
      error: isMissing
        ? 'yield_history table does not exist. Run 001-create-yield-history.sql in Supabase SQL editor first.'
        : `yield_history upsert failed: ${histErr.message}`,
    }, { status: 500 })
  }

  // 2. Conditional update of instruments.yield_* to the most-recent yield
  //    per instrument from this batch (only if newer than current value).

  const latestByInstrument = new Map<string, AcceptedProposal>()
  for (const p of clean) {
    const existing = latestByInstrument.get(p.instrument_id)
    if (!existing || p.yield_as_of > existing.yield_as_of) {
      latestByInstrument.set(p.instrument_id, p)
    }
  }

  const ids = Array.from(latestByInstrument.keys())
  const { data: currentRows, error: cErr } = await db
    .from('instruments')
    .select('instrument_id, yield_as_of')
    .in('instrument_id', ids)

  if (cErr) {
    return NextResponse.json({
      error: `Failed to read current instruments state: ${cErr.message}`,
      history_inserted: histCount ?? 0,
      deduped: dedupedCount,
    }, { status: 500 })
  }

  const currentMap = new Map<string, string | null>()
  for (const r of currentRows ?? []) {
    currentMap.set((r as any).instrument_id, (r as any).yield_as_of)
  }

  const nowIso = new Date().toISOString()
  const toUpdate: AcceptedProposal[] = []
  for (const [iid, p] of latestByInstrument) {
    const currentAsOf = currentMap.get(iid)
    if (!currentAsOf || p.yield_as_of > currentAsOf) {
      toUpdate.push(p)
    }
  }

  let updatedCount = 0
  for (const p of toUpdate) {
    const { error: uErr } = await (db.from('instruments') as any)
      .update({
        yield_pct:               Number(p.yield_pct.toFixed(4)),
        yield_as_of:             p.yield_as_of,
        yield_source:            'brokerage',
        yield_notes:             p.notes,
        yield_last_refreshed_at: nowIso,
      })
      .eq('instrument_id', p.instrument_id)
    if (uErr) {
      errors.push({ instrument_id: p.instrument_id, message: `instruments update failed: ${uErr.message}` })
    } else {
      updatedCount++
    }
  }

  const uniqueDates = new Set(clean.map(p => p.yield_as_of)).size

  const response: AcceptResponse = {
    history_inserted: histCount ?? clean.length,
    current_updated:  updatedCount,
    unique_dates:     uniqueDates,
    deduped:          dedupedCount,
    errors,
  }

  return NextResponse.json(response)
}
