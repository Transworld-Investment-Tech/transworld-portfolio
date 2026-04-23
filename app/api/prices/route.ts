import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { fetchAllMarketData } from '@/lib/market-data'

// v19: added GET handler for Vercel Cron.
// v20h: write richer per-day data (OHLC, volume, trades, value, change_ngn)
//       plus per-security classification (sector, ngx_market). Use API's
//       TradeDate for price_date so we don't drift across UTC midnight.
// v20i: instruments metadata path uses direct UPDATE instead of upsert
//       (partial upsert would null out NOT NULL columns — pitfall #39).
// v21i: Auto-register unknown NGX instruments.
//       Previously, fetchAllMarketData was called with `validInstrumentIds`
//       so only our 74 known tickers got prices; 78 NGX equities were
//       silently dropped every run. Now:
//       1. fetchAllMarketData() returns all ~146 NGX equities.
//       2. Any ticker not yet in `instruments` is batch-upserted as a new
//          instrument (approved=false, type=Stock, sleeve_id=eq). This
//          makes them findable in holdings search immediately while keeping
//          them out of the investment-universe until explicitly approved.
//       3. Price upsert covers all instruments (known + newly registered).
//       Response now includes `newlyRegistered` count.
export const maxDuration = 60

// ─── Shared work: the actual price refresh ──────────────────────────
async function runPriceRefresh() {
  const db = supabaseAdmin()

  // Load all known instrument_ids for the auto-registration check.
  const { data: instruments, error: instErr } = await db
    .from('instruments')
    .select('instrument_id')

  if (instErr) throw instErr

  const validInstrumentIds = new Set<string>(
    (instruments || []).map((r: any) => r.instrument_id as string)
  )

  // v21i: call without validInstrumentIds — get every equity NGX publishes.
  const { quotes, fxRate, errors } = await fetchAllMarketData()

  if (quotes.length === 0) {
    return {
      status: 502,
      body: {
        error:
          errors.length > 0
            ? `Price fetch failed: ${errors.join('; ')}`
            : 'No prices returned from NGX. Check upstream.',
        errors,
      },
    }
  }

  // ─── v21i: Auto-register unknown instruments ──────────────────────
  // Any NGX ticker not yet in our instruments master gets inserted now.
  // approved=false keeps them out of investment proposals; they are
  // immediately searchable for manual portfolio building.
  const unknownQuotes = quotes.filter(
    (q) => !validInstrumentIds.has(q.instrument_id)
  )
  let newlyRegistered = 0

  if (unknownQuotes.length > 0) {
    const newInstruments = unknownQuotes.map((q) => ({
      instrument_id: q.instrument_id,
      name:          q.name || q.instrument_id, // Company2 from API, fallback to ticker
      type:          'Stock',
      sleeve_id:     'eq',
      asset_class:   'Equity',
      currency:      'NGN',
      approved:      false,
      sector:        q.sector     ?? null,
      ngx_market:    q.ngx_market ?? null,
    }))

    // upsert with ignoreDuplicates=true (ON CONFLICT DO NOTHING) — safe
    // because we provide every NOT NULL column. If the batch fails for
    // any reason we log and fall back to pricing only known instruments
    // this run; the registration will be retried on the next refresh.
    const { error: regErr } = await (db.from('instruments') as any).upsert(
      newInstruments,
      { onConflict: 'instrument_id', ignoreDuplicates: true }
    )

    if (regErr) {
      console.warn(
        `[prices] auto-register ${unknownQuotes.length} new instruments failed:`,
        regErr.message
      )
      // Leave validInstrumentIds unchanged; unknowns skipped this run.
    } else {
      newlyRegistered = unknownQuotes.length
      // Add to valid set so price upsert covers them immediately.
      unknownQuotes.forEach((q) => validInstrumentIds.add(q.instrument_id))
      console.log(
        `[prices] auto-registered ${newlyRegistered} new instruments:`,
        unknownQuotes.map((q) => q.instrument_id).join(', ')
      )
    }
  }

  // ─── market_prices upsert ─────────────────────────────────────────
  // Only upsert prices for instruments that exist (known + newly registered).
  // UNIQUE constraint on (instrument_id, price_date) — onConflict is safe here.
  const serverToday = new Date().toISOString().slice(0, 10)

  const quotesToUpsert = quotes.filter((q) =>
    validInstrumentIds.has(q.instrument_id)
  )

  const priceUpserts = quotesToUpsert.map((q) => ({
    instrument_id: q.instrument_id,
    price_date:    q.trade_date || serverToday,
    price:         q.price,
    day_change:    q.day_change,
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

  // ─── instruments metadata updates (v20i) ──────────────────────────
  // Sector and board classification are per-security, not per-day.
  // Uses UPDATE (not upsert) to avoid nulling out NOT NULL columns
  // (pitfall #39 / v20i header comment). Parallel UPDATEs are non-fatal.
  let metaUpdated = 0
  const metaErrors: string[] = []

  await Promise.all(
    quotesToUpsert.map(async (q) => {
      const { error } = await db
        .from('instruments')
        .update({
          sector:     q.sector     ?? null,
          ngx_market: q.ngx_market ?? null,
        })
        .eq('instrument_id', q.instrument_id)

      if (error) {
        metaErrors.push(`${q.instrument_id}: ${error.message}`)
      } else {
        metaUpdated += 1
      }
    })
  )

  if (metaErrors.length > 0) {
    console.warn(
      `[prices] ${metaErrors.length} metadata updates failed, ${metaUpdated} succeeded. First 3:`,
      metaErrors.slice(0, 3)
    )
  }

  return {
    status: 200,
    body: {
      success: true,
      updated: quotesToUpsert.length,
      newlyRegistered,
      metaUpdated,
      fxRate,
      errors: [...errors, ...metaErrors],
      quotes: quotesToUpsert.map((q) => ({
        id:     q.instrument_id,
        price:  q.price,
        change: q.day_change,
      })),
    },
  }
}

// POST — triggered by the "Live prices" button and "Refresh from NGX".
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

// GET — Vercel Cron (daily NGX price refresh).
// Schedule (from vercel.json): "0 16 * * 1-5" = 17:00 WAT weekdays.
export async function GET(req: NextRequest) {
  const expected = `Bearer ${process.env.CRON_SECRET ?? ''}`
  const got = req.headers.get('authorization') ?? ''
  if (!process.env.CRON_SECRET || got !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const result = await runPriceRefresh()
    console.log('[cron /api/prices]', JSON.stringify({
      ok:               result.status === 200,
      updated:          (result.body as any).updated,
      newlyRegistered:  (result.body as any).newlyRegistered,
      metaUpdated:      (result.body as any).metaUpdated,
      errors:           (result.body as any).errors,
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
