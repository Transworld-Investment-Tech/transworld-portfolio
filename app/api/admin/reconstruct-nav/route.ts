import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// v21o: POST /api/admin/reconstruct-nav
// For each active portfolio, replays its full transaction history at every
// distinct price_date in market_prices to compute a historical NAV snapshot.
// Inserts new entries into nav_log with notes='Reconstructed from historical prices'.
// Idempotent — skips dates already in nav_log for each portfolio.
//
// Algorithm per portfolio × date:
//   1. Replay all BUY/SELL/TRANSFER_IN/TRANSFER_OUT up to (and including) the date
//      to derive shares held at that date.
//   2. For each holding: price from market_prices on that date, fallback to avg_cost.
//   3. CASH_NGN positions are always priced at ₦1 per unit.
//   4. NAV = sum(quantity × price). Skip if NAV = 0 (no holdings yet).
//   5. Insert nav_log row.
//
// Body: { portfolioId?: string }  — omit for all active portfolios.

export const runtime = 'nodejs'
export const maxDuration = 60

interface HoldingState {
  quantity:  number
  costSum:   number   // for avg_cost calculation
  buyQty:    number
}

function replayToDate(
  txns: any[],   // sorted by trade_date ascending
  date: string
): Record<string, { quantity: number; avgCost: number }> {
  const state: Record<string, HoldingState> = {}

  for (const t of txns) {
    if (t.trade_date > date) break
    const id  = t.instrument_id
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

    // ── 1. Determine which portfolios to process ─────────────────────────
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
      return NextResponse.json({ ok: true, message: 'No active portfolios found', navEntriesAdded: 0 })
    }

    // ── 2. Get all distinct price dates from historical import ────────────
    // We process ALL dates in market_prices (any source) so nav_log is as
    // complete as possible. The ignoreDuplicates check below prevents overwrites.
    const { data: dateRows } = await db
      .from('market_prices')
      .select('price_date')
      .order('price_date', { ascending: true })
    const allDates = Array.from(new Set((dateRows ?? []).map((r: any) => r.price_date as string))).sort()

    if (allDates.length === 0) {
      return NextResponse.json({ ok: true, message: 'No price dates found in market_prices', navEntriesAdded: 0 })
    }

    // ── 3. Pre-fetch all prices for all dates in one query ───────────────
    // Much more efficient than one query per date.
    const { data: allPrices } = await db
      .from('market_prices')
      .select('instrument_id, price_date, price')
      .in('price_date', allDates)

    // priceByDateAndInstrument[date][instrument_id] = price
    const priceMap: Record<string, Record<string, number>> = {}
    for (const p of allPrices ?? []) {
      if (!priceMap[p.price_date]) priceMap[p.price_date] = {}
      priceMap[p.price_date][p.instrument_id] = p.price
    }

    // ── 4. Process each portfolio ────────────────────────────────────────
    let totalNavEntriesAdded = 0
    const portfolioResults: any[] = []

    for (const pfId of portfolioIds) {
      // Load transactions sorted ascending
      const { data: txns } = await db
        .from('transactions')
        .select('trade_date, action, instrument_id, quantity, price, amount')
        .eq('portfolio_id', pfId)
        .order('trade_date', { ascending: true })

      if (!txns || txns.length === 0) continue

      // Load existing nav_log entries to skip
      const { data: existingNav } = await db
        .from('nav_log')
        .select('nav_date')
        .eq('portfolio_id', pfId)
      const existingDates = new Set((existingNav ?? []).map((n: any) => n.nav_date as string))

      // Earliest transaction date — skip price dates before first transaction
      const firstTxDate = txns[0].trade_date as string

      const newNavEntries: any[] = []

      for (const date of allDates) {
        // Skip dates before this portfolio had any activity
        if (date < firstTxDate) continue
        // Skip dates already in nav_log
        if (existingDates.has(date)) continue

        // Compute holdings at this date
        const holdings = replayToDate(txns, date)
        if (Object.keys(holdings).length === 0) continue

        const prices = priceMap[date] ?? {}
        let nav = 0

        for (const [instrId, { quantity, avgCost }] of Object.entries(holdings)) {
          let price: number
          if (instrId === 'CASH_NGN') {
            price = 1  // ₦1 per naira unit
          } else {
            price = prices[instrId] ?? avgCost  // fallback to avg_cost if no market price
          }
          nav += quantity * price
        }

        if (nav > 0) {
          newNavEntries.push({
            portfolio_id: pfId,
            nav_date:     date,
            nav_value:    Math.round(nav * 100) / 100,   // round to 2dp
            notes:        'Reconstructed from historical prices',
          })
        }
      }

      // Insert new nav_log entries for this portfolio
      if (newNavEntries.length > 0) {
        // nav_log has NO unique constraint — use insert (not upsert)
        // We already filtered out existing dates above so no dups
        const { error } = await db.from('nav_log').insert(newNavEntries)
        if (!error) {
          totalNavEntriesAdded += newNavEntries.length
        }
      }

      portfolioResults.push({
        portfolioId: pfId,
        navEntriesAdded: newNavEntries.length,
        datesProcessed:  newNavEntries.length,
        datesSkipped:    existingDates.size,
      })
    }

    return NextResponse.json({
      ok:               true,
      navEntriesAdded:  totalNavEntriesAdded,
      portfoliosProcessed: portfolioIds.length,
      portfolioResults,
    })
  } catch (err: any) {
    console.error('[reconstruct-nav]', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
