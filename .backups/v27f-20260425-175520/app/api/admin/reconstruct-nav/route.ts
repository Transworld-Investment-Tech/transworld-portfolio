import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// v21o-hotfix-1: Two Supabase 1000-row default cap bugs fixed.
//
// Bug 1: allDates query returned 1000 rows from market_prices. With ~300
//   instruments per date, 1000 rows = only ~3-4 distinct dates processed.
//   Fix: .limit(50000) on the allDates query.
//
// Bug 2: allPrices batch query capped at 1000 rows — most pricesByDate
//   entries empty. Fix: filter by portfolio instruments only (10-15 rows
//   per date instead of 300+), plus .limit(50000) safety net.

export const runtime = 'nodejs'
export const maxDuration = 60

interface HoldingState {
  quantity:  number
  costSum:   number
  buyQty:    number
}

function replayToDate(
  txns: any[],
  date: string
): Record<string, { quantity: number; avgCost: number }> {
  const state: Record<string, HoldingState> = {}

  for (const t of txns) {
    if (t.trade_date > date) break
    const id = t.instrument_id
    if (!id || !['BUY','SELL','TRANSFER_IN','TRANSFER_OUT'].includes(t.action)) continue
    if (!state[id]) state[id] = { quantity: 0, costSum: 0, buyQty: 0 }

    const qty   = Math.abs(Number(t.quantity ?? 0))
    const price = Number(t.price ?? 0)

    if (t.action === 'BUY') {
      state[id].quantity += qty
      state[id].costSum  += qty * price
      state[id].buyQty   += qty
    } else if (t.action === 'SELL') {
      state[id].quantity -= qty
    } else if (t.action === 'TRANSFER_IN') {
      state[id].quantity += qty
    } else if (t.action === 'TRANSFER_OUT') {
      state[id].quantity -= qty
    }
  }

  const result: Record<string, { quantity: number; avgCost: number }> = {}
  for (const [id, s] of Object.entries(state)) {
    if (s.quantity > 0.0001) {
      result[id] = {
        quantity: s.quantity,
        avgCost:  s.buyQty > 0 ? s.costSum / s.buyQty : 0,
      }
    }
  }
  return result
}

export async function POST(req: NextRequest) {
  try {
    const body        = await req.json().catch(() => ({}))
    const portfolioId = body.portfolioId as string | undefined

    const db = supabaseAdmin()

    // ── 1. Determine portfolios ────────────────────────────────────────
    let portfolioIds: string[]
    if (portfolioId) {
      portfolioIds = [portfolioId]
    } else {
      const { data: pf } = await db
        .from('portfolios')
        .select('id')
        .eq('status', 'active')
      portfolioIds = (pf ?? []).map((p: any) => p.id as string)
    }

    if (portfolioIds.length === 0) {
      return NextResponse.json({ ok: true, message: 'No active portfolios', navEntriesAdded: 0 })
    }

    // ── 2. Get ALL distinct price dates ─────────────────────────────────
    // FIX: .limit(50000) overrides Supabase default 1000-row cap.
    // Without this, 1000 rows ÷ ~300 instruments/date = only ~3 dates processed.
    const { data: dateRows } = await db
      .from('market_prices')
      .select('price_date')
      .order('price_date', { ascending: true })
      .limit(50000)

    const allDates = [...new Set((dateRows ?? []).map((r: any) => r.price_date as string))].sort()

    if (allDates.length === 0) {
      return NextResponse.json({ ok: true, message: 'No price dates in market_prices', navEntriesAdded: 0 })
    }

    // ── 3. Process each portfolio ────────────────────────────────────────
    let totalNavEntriesAdded = 0
    const portfolioResults: any[] = []

    for (const pfId of portfolioIds) {

      // Load transactions sorted ascending
      const { data: txns } = await db
        .from('transactions')
        .select('trade_date, action, instrument_id, quantity, price')
        .eq('portfolio_id', pfId)
        .order('trade_date', { ascending: true })
        .limit(50000)

      if (!txns || txns.length === 0) continue

      // FIX: filter price fetch to only instruments this portfolio ever held.
      // This reduces the price query from ~300 instruments/date to ~10-15,
      // well within the 1000-row cap even without an explicit override.
      const portfolioInstruments = [...new Set(
        txns.map((t: any) => t.instrument_id).filter(Boolean) as string[]
      )]

      // Fetch prices only for this portfolio's instruments across all dates.
      // .limit(50000) as safety net — 15 instruments × 200 dates = ~3000 rows max.
      const { data: priceRows } = await db
        .from('market_prices')
        .select('instrument_id, price_date, price')
        .in('instrument_id', portfolioInstruments)
        .in('price_date', allDates)
        .limit(50000)

      // Build priceByDateAndInstrument map
      const priceMap: Record<string, Record<string, number>> = {}
      for (const p of priceRows ?? []) {
        if (!priceMap[p.price_date]) priceMap[p.price_date] = {}
        priceMap[p.price_date][p.instrument_id] = p.price
      }

      // Load existing nav_log entries to skip
      const { data: existingNav } = await db
        .from('nav_log')
        .select('nav_date')
        .eq('portfolio_id', pfId)
        .limit(50000)
      const existingDates = new Set((existingNav ?? []).map((n: any) => n.nav_date as string))

      const firstTxDate = txns[0].trade_date as string
      const newNavEntries: any[] = []

      for (const date of allDates) {
        if (date < firstTxDate) continue
        if (existingDates.has(date))  continue

        const holdings = replayToDate(txns, date)
        if (Object.keys(holdings).length === 0) continue

        const prices = priceMap[date] ?? {}
        let nav = 0

        for (const [instrId, { quantity, avgCost }] of Object.entries(holdings)) {
          const price = instrId === 'CASH_NGN'
            ? 1
            : (prices[instrId] ?? avgCost)
          nav += quantity * price
        }

        if (nav > 0) {
          newNavEntries.push({
            portfolio_id: pfId,
            nav_date:     date,
            nav_value:    Math.round(nav * 100) / 100,
            notes:        'Reconstructed from historical prices',
          })
        }
      }

      if (newNavEntries.length > 0) {
        const { error } = await db.from('nav_log').insert(newNavEntries)
        if (!error) totalNavEntriesAdded += newNavEntries.length
      }

      portfolioResults.push({
        portfolioId:     pfId,
        navEntriesAdded: newNavEntries.length,
        datesProcessed:  allDates.length,
        instrumentsTracked: portfolioInstruments.length,
      })
    }

    return NextResponse.json({
      ok:                  true,
      navEntriesAdded:     totalNavEntriesAdded,
      portfoliosProcessed: portfolioIds.length,
      totalDatesAvailable: allDates.length,
      portfolioResults,
    })
  } catch (err: any) {
    console.error('[reconstruct-nav]', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
