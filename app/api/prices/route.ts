import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { fetchAllMarketData } from '@/lib/market-data'
import { getAliasMap, applyAlias } from '@/lib/ticker-aliases'

// v19: added GET handler for Vercel Cron.
// v20h: write richer per-day data (OHLC, volume, trades, value, change_ngn)
//       plus per-security classification (sector, ngx_market). Use API's
//       TradeDate for price_date so we don't drift across UTC midnight.
// v20i: instruments metadata path uses direct UPDATE instead of upsert
//       (partial upsert would null out NOT NULL columns — pitfall #39).
// v21i: Auto-register unknown NGX instruments.
// v21l: DB-driven ticker alias map. After fetching quotes (which already
//       have hardcoded NGX_TICKER_ALIASES applied by fetchNGXPrices),
//       we apply a second alias pass using the DB table so any alias
//       added via /admin/aliases takes effect on the next refresh without
//       a code deploy. The hardcoded map remains as a permanent fallback.
export const maxDuration = 60

// ─── Shared work: the actual price refresh ──────────────────────────
async function runPriceRefresh() {
  const db = supabaseAdmin()

  // Load alias map from DB (merges on top of hardcoded NGX_TICKER_ALIASES).
  const aliasMap = await getAliasMap(db)

  // Load all known instrument_ids for the auto-registration check.
  const { data: instruments, error: instErr } = await db
    .from('instruments')
    .select('instrument_id')

  if (instErr) throw instErr

  const validInstrumentIds = new Set<string>(
    (instruments || []).map((r: any) => r.instrument_id as string)
  )

  // v21i: call without validInstrumentIds — get every equity NGX publishes.
  // fetchNGXPrices already applies the hardcoded NGX_TICKER_ALIASES.
  const { quotes: rawQuotes, fxRate, errors } = await fetchAllMarketData()

  if (rawQuotes.length === 0) {
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

  // v21l: Apply DB alias pass to any quote whose instrument_id needs
  // further remapping (e.g. aliases added via admin UI that aren't in
  // the hardcoded map). No-op for tickers already aliased by fetchNGXPrices.
  const quotes = rawQuotes.map(q => {
    const remapped = applyAlias(q.instrument_id, aliasMap)
    if (remapped && remapped !== q.instrument_id) {
      return { ...q, instrument_id: remapped }
    }
    return q
  })

  // ─── v21i: Auto-register unknown instruments ──────────────────────
  const unknownQuotes = quotes.filter(
    (q) => !validInstrumentIds.has(q.instrument_id)
  )
  let newlyRegistered = 0

  if (unknownQuotes.length > 0) {
    const newInstruments = unknownQuotes.map((q) => ({
      instrument_id: q.instrument_id,
      name:          q.name || q.instrument_id,
      type:          'Stock',
      sleeve_id:     'eq',
      asset_class:   'Equity',
      currency:      'NGN',
      approved:      false,
      sector:        q.sector     ?? null,
      ngx_market:    q.ngx_market ?? null,
    }))

    const { error: regErr } = await (db.from('instruments') as any).upsert(
      newInstruments,
      { onConflict: 'instrument_id', ignoreDuplicates: true }
    )

    if (regErr) {
      console.warn(
        `[prices] auto-register ${unknownQuotes.length} new instruments failed:`,
        regErr.message
      )
    } else {
      newlyRegistered = unknownQuotes.length
      unknownQuotes.forEach((q) => validInstrumentIds.add(q.instrument_id))
      console.log(
        `[prices] auto-registered ${newlyRegistered} new instruments:`,
        unknownQuotes.map((q) => q.instrument_id).join(', ')
      )
    }
  }

  // ─── market_prices upsert ─────────────────────────────────────────
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
