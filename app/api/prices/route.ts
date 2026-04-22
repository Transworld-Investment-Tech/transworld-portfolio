import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { fetchAllMarketData } from '@/lib/market-data'

// v16: Direct NGX scrape does not need Apify. Keep a generous timeout
// in case the NGX page is slow under load (pitfall #12).
export const maxDuration = 60

export async function POST(_req: NextRequest) {
  try {
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
      return NextResponse.json(
        {
          error:
            errors.length > 0
              ? `Price fetch failed: ${errors.join('; ')}`
              : 'No matching prices returned from NGX. Check that your instrument_ids match NGX tickers.',
          errors,
        },
        { status: 502 }
      )
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

    return NextResponse.json({
      success: true,
      updated: quotes.length,
      fxRate,
      errors,
      quotes: quotes.map((q) => ({
        id: q.instrument_id,
        price: q.price,
        change: q.day_change,
      })),
    })
  } catch (err) {
    console.error('[/api/prices] fatal:', err)
    return NextResponse.json(
      { error: (err as Error).message || 'Unknown error in /api/prices' },
      { status: 500 }
    )
  }
}
