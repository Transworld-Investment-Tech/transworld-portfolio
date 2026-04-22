import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { fetchAllMarketData } from '@/lib/market-data'

// v19: added GET handler for Vercel Cron. Keep maxDuration generous in case
// the NGX page is slow under load (pitfall #12).
export const maxDuration = 60

// ─── Shared work: the actual price refresh ──────────────────────────
// Extracted so POST (UI button) and GET (Vercel Cron) run the exact same
// logic. Returns a uniform { ok, status, body } envelope so both wrappers
// can do NextResponse.json(body, { status }) consistently.
async function runPriceRefresh() {
  const db = supabaseAdmin()

  // Fetch every known instrument_id so we only try to upsert prices for
  // securities that actually exist in the `instruments` table. Prevents
  // FK-constraint violations on market_prices and keeps the price table tidy.
  const { data: instruments, error: instErr } = await db
    .from('instruments')
    .select('instrument_id')

  if (instErr) throw instErr

  const validInstrumentIds = new Set<string>(
    (instruments || []).map((r: any) => r.instrument_id as string)
  )

  const { quotes, fxRate, errors } = await fetchAllMarketData({
    validInstrumentIds,
  })

  if (quotes.length === 0) {
    return {
      status: 502,
      body: {
        error:
          errors.length > 0
            ? `Price fetch failed: ${errors.join('; ')}`
            : 'No matching prices returned from NGX. Check that your instrument_ids match NGX tickers.',
        errors,
      },
    }
  }

  // Upsert into market_prices. UNIQUE constraint on (instrument_id, price_date)
  // exists — using onConflict here is correct (unlike nav_log per pitfall #3).
  const today = new Date().toISOString().slice(0, 10)
  const upserts = quotes.map((q) => ({
    instrument_id: q.instrument_id,
    price_date: today,
    price: q.price,
    day_change: q.day_change,
    source: q.source,
  }))

  const { error: upsertErr } = await db
    .from('market_prices')
    .upsert(upserts, { onConflict: 'instrument_id,price_date' })

  if (upsertErr) throw upsertErr

  return {
    status: 200,
    body: {
      success: true,
      updated: quotes.length,
      fxRate,
      errors,
      quotes: quotes.map((q) => ({
        id: q.instrument_id,
        price: q.price,
        change: q.day_change,
      })),
    },
  }
}

// POST — existing behaviour. Triggered by the "Live prices" button on the
// portfolio overview and by the "Refresh from NGX" button on /admin/prices.
// Left unauthenticated because callers are already logged into the app.
export async function POST(_req: NextRequest) {
  try {
    const result = await runPriceRefresh()
    return NextResponse.json(result.body, { status: result.status })
  } catch (err) {
    console.error('[/api/prices] fatal:', err)
    return NextResponse.json(
      { error: (err as Error).message || 'Unknown error in /api/prices' },
      { status: 500 }
    )
  }
}

// GET — v19: used by Vercel Cron (daily NGX price refresh).
//
// Vercel Cron sends GET requests and automatically includes the header
// "Authorization: Bearer <CRON_SECRET>" when the CRON_SECRET environment
// variable is set in the project settings. We reject any GET without that
// header so the endpoint isn't abusable from the open internet.
//
// Schedule (from vercel.json): "0 16 * * 1-5"
//   = 16:00 UTC Mon-Fri = 17:00 WAT, ~2.5 hours after NGX market close.
export async function GET(req: NextRequest) {
  const expected = `Bearer ${process.env.CRON_SECRET ?? ''}`
  const got = req.headers.get('authorization') ?? ''
  if (!process.env.CRON_SECRET || got !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const result = await runPriceRefresh()
    console.log('[cron /api/prices]', JSON.stringify({
      ok: result.status === 200,
      updated: (result.body as any).updated,
      errors: (result.body as any).errors,
    }))
    return NextResponse.json(result.body, { status: result.status })
  } catch (err) {
    console.error('[cron /api/prices] fatal:', err)
    return NextResponse.json(
      { error: (err as Error).message || 'Unknown error in /api/prices' },
      { status: 500 }
    )
  }
}
