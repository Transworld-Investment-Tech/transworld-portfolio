import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// POST /api/prices/manual
// Body: { instrument_id, price, price_date?, day_change? }
// Upserts a manually-entered price into market_prices with source='manual'.
// A later NGX refresh for the same (instrument_id, price_date) will overwrite.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const { instrument_id, price, price_date, day_change } = body

    // Validation
    if (!instrument_id || typeof instrument_id !== 'string') {
      return NextResponse.json({ error: 'instrument_id is required' }, { status: 400 })
    }
    const priceNum = Number(price)
    if (!Number.isFinite(priceNum) || priceNum <= 0) {
      return NextResponse.json({ error: 'price must be a positive number' }, { status: 400 })
    }
    const dateStr = price_date || new Date().toISOString().slice(0, 10)
    // Basic ISO date sanity check
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      return NextResponse.json({ error: 'price_date must be YYYY-MM-DD' }, { status: 400 })
    }
    const changeNum = day_change !== undefined && day_change !== null ? Number(day_change) : 0

    const db = supabaseAdmin()

    // Verify instrument exists (avoid FK violations — pitfall #5)
    const { data: instrument, error: instrErr } = await db
      .from('instruments')
      .select('instrument_id, name')
      .eq('instrument_id', instrument_id)
      .maybeSingle()

    if (instrErr) throw instrErr
    if (!instrument) {
      return NextResponse.json(
        { error: `Instrument "${instrument_id}" does not exist in the instruments table` },
        { status: 404 }
      )
    }

    const { error: upsertErr } = await db
      .from('market_prices')
      .upsert(
        {
          instrument_id,
          price_date: dateStr,
          price: priceNum,
          day_change: Number.isFinite(changeNum) ? changeNum : 0,
          source: 'manual',
        },
        { onConflict: 'instrument_id,price_date' }
      )

    if (upsertErr) throw upsertErr

    return NextResponse.json({
      success: true,
      instrument_id,
      instrument_name: instrument.name,
      price: priceNum,
      price_date: dateStr,
      source: 'manual',
    })
  } catch (err) {
    console.error('[/api/prices/manual POST] fatal:', err)
    return NextResponse.json(
      { error: (err as Error).message || 'Unknown error' },
      { status: 500 }
    )
  }
}

// DELETE /api/prices/manual?instrument_id=XXX&price_date=YYYY-MM-DD
// Removes a manual override. Only deletes rows where source='manual' to
// protect against accidentally purging ngx-sourced prices.
export async function DELETE(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const instrument_id = searchParams.get('instrument_id')
    const price_date = searchParams.get('price_date')

    if (!instrument_id || !price_date) {
      return NextResponse.json(
        { error: 'instrument_id and price_date query params required' },
        { status: 400 }
      )
    }

    const db = supabaseAdmin()
    const { error } = await db
      .from('market_prices')
      .delete()
      .eq('instrument_id', instrument_id)
      .eq('price_date', price_date)
      .eq('source', 'manual')

    if (error) throw error

    return NextResponse.json({ success: true })
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message || 'Unknown error' },
      { status: 500 }
    )
  }
}
