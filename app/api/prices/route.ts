import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { fetchAllMarketData } from '@/lib/market-data'

// v19: added GET handler for Vercel Cron. Keep maxDuration generous in case
// the NGX endpoint is slow under load (pitfall #12).
// v20h: write richer per-day data (OHLC, volume, trades, value, change_ngn)
//       plus per-security classification (sector, ngx_market). Use API's
//       TradeDate for price_date so we don't drift across UTC midnight.
export const maxDuration = 60

// ─── Shared work: the actual price refresh ──────────────────────────
// Extracted so POST (UI button) and GET (Vercel Cron) run the exact same
// logic. Returns a uniform { status, body } envelope so both wrappers
// can do NextResponse.json(body, { status }) consistently.
async function runPriceRefresh() {
  const db = supabaseAdmin()

  // Fetch every known instrument_id so we only upsert prices for
  // securities that exist in `instruments`. Prevents FK violations on
  // market_prices and keeps the price table tidy.
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

  // ─── market_prices upsert ─────────────────────────────────────────
  // UNIQUE constraint on (instrument_id, price_date) exists — using
  // onConflict here is correct (unlike nav_log per pitfall #3).
  //
  // v20h: use the API's TradeDate when present. It's the authoritative
  // Lagos trading date. Server UTC `today` is the fallback for rows that
  // arrive without TradeDate (shouldn't happen against the current
  // endpoint, but keeps the route resilient to future API changes).
  const serverToday = new Date().toISOString().slice(0, 10)

  const priceUpserts = quotes.map((q) => ({
    instrument_id: q.instrument_id,
    price_date:    q.trade_date || serverToday,
    price:         q.price,
    day_change:    q.day_change,       // percent (historical semantic)
    change_ngn:    q.change_ngn ?? null,
    open_price:    q.open_price ?? null,
    high_price:    q.high_price ?? null,
    low_price:     q.low_price  ?? null,
    prev_close:    q.prev_close ?? null,
    volume:        q.volume     ?? null,
    trades:        q.trades     ?? null,
    value_ngn:     q.value_ngn  ?? null,
    source:        q.source,
  }))

  const { error: priceErr } = await db
    .from('market_prices')
    .upsert(priceUpserts, { onConflict: 'instrument_id,price_date' })

  if (priceErr) throw priceErr

  // ─── instruments metadata upsert (v20h) ───────────────────────────
  // Sector and board classification (ngx_market) are per-security, not
  // per-day. We upsert them on every refresh — it's cheap, keeps us
  // aligned if NGX reclassifies something (Premium → Main, sector
  // recategorisation), and acts as the backfill path on first run.
  //
  // Only targets instruments that already exist (we filtered via
  // validInstrumentIds above), so the upsert is effectively an UPDATE
  // — partial payload leaves other columns (name, sleeve_id, type,
  // notes, approved, dividend fields) untouched.
  //
  // Non-fatal on failure: if this upsert errors, the price refresh
  // still completed successfully and we log + continue.
  const metaUpdates = quotes
    .filter((q) => q.sector !== undefined || q.ngx_market !== undefined)
    .map((q) => ({
      instrument_id: q.instrument_id,
      sector:        q.sector     ?? null,
      ngx_market:    q.ngx_market ?? null,
    }))

  let metaUpdated = 0
  const metaErrors: string[] = []
  if (metaUpdates.length > 0) {
    const { error: metaErr } = await db
      .from('instruments')
      .upsert(metaUpdates, { onConflict: 'instrument_id' })

    if (metaErr) {
      metaErrors.push(`instruments metadata upsert failed: ${metaErr.message}`)
      console.warn('[prices] instruments metadata upsert failed:', metaErr.message)
    } else {
      metaUpdated = metaUpdates.length
    }
  }

  return {
    status: 200,
    body: {
      success: true,
      updated: quotes.length,
      metaUpdated,
      fxRate,
      errors: [...errors, ...metaErrors],
      quotes: quotes.map((q) => ({
        id:     q.instrument_id,
        price:  q.price,
        change: q.day_change,
      })),
    },
  }
}

// POST — triggered by the "Live prices" button on the portfolio overview
// and by "Refresh from NGX" on /admin/prices. Unauthenticated because
// callers are already logged into the app.
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
// "Authorization: Bearer <CRON_SECRET>" when CRON_SECRET is set in
// project settings. We reject any GET without that header so the
// endpoint isn't abusable from the open internet.
//
// Schedule (from vercel.json): "0 16 * * 1-5"
//   = 16:00 UTC Mon-Fri = 17:00 WAT, ~2.5 hours after NGX close.
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
      metaUpdated: (result.body as any).metaUpdated,
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
