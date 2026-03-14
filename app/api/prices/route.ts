import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { fetchAllMarketData } from '@/lib/market-data'

export async function POST(req: NextRequest) {
  try {
    const db = supabaseAdmin()

    // Get API keys from config table
    const { data: keys } = await db.from('api_config').select('key_name, key_value').in('key_name', ['apify', 'alpha_vantage'])
    const keyMap = Object.fromEntries((keys || []).map((k: any) => [k.key_name, k.key_value]))

    if (!keyMap.apify && !keyMap.alpha_vantage) {
      return NextResponse.json({ error: 'No market data API keys configured. Add Apify key in Admin > Settings.' }, { status: 400 })
    }

    const { quotes, fxRate, errors } = await fetchAllMarketData({
      apifyKey: keyMap.apify,
      alphaVantageKey: keyMap.alpha_vantage,
    })

    if (quotes.length === 0 && errors.length > 0) {
      return NextResponse.json({ error: errors.join('; ') }, { status: 502 })
    }

    // Upsert prices into market_prices table
    const today = new Date().toISOString().slice(0, 10)
    const upserts = quotes.map(q => ({
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
      quotes: quotes.map(q => ({ id: q.instrument_id, price: q.price, change: q.day_change })),
    })
  } catch (err) {
    console.error('Price fetch error:', err)
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}
