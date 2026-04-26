/**
 * app/api/broker/sessions/[id]/apply-reconciliation/route.ts — v27g
 *
 * Applies CSCS variance reconciliation as TRANSFER_IN/OUT transactions.
 * Called by the variance panel post-commit when an operator picks rows
 * to apply.
 *
 * Body shape:
 *   {
 *     transfers: [
 *       {
 *         ticker:   string,
 *         action:   'TRANSFER_IN' | 'TRANSFER_OUT',
 *         quantity: number,
 *         price:    number,
 *         reason:   'cscs_only' | 'top_up_needed' |
 *                   'portfolio_only' | 'portfolio_overshoot'
 *       },
 *       ...
 *     ]
 *   }
 *
 * Algorithm:
 *   1. Validate session has a committed canonical_positions broker_file
 *   2. Resolve portfolio_id from that broker_file
 *   3. Resolve transfer date = MAX(market_prices.price_date) [pitfall #87]
 *   4. Validate every ticker exists in instruments master
 *   5. Build transactions rows with notes pattern:
 *      "Reconciliation TRANSFER (session=<id>, ticker=<T>, reason=<bucket>)"
 *   6. Insert
 *   7. rebuildPortfolioHoldings(db, portfolio_id)
 *   8. reconstructPortfolioNav(db, portfolio_id)
 *   9. Return summary
 *
 * Idempotency: not enforced server-side. The client uses the
 * ConfirmButton 4-second pattern for accidental-click protection. After
 * Apply, the parent page reloads and the variance recomputes against
 * updated holdings — already-applied tickers will show as 'match' and
 * won't appear in the actionable filter, so accidental re-apply is
 * structurally hard (operator would have to deliberately reselect a
 * matched row from the 'all' filter).
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { rebuildPortfolioHoldings } from '@/lib/holdings-rebuild'
import { reconstructPortfolioNav } from '@/lib/nav-reconstruct'

export const runtime = 'nodejs'
export const maxDuration = 60
export const dynamic = 'force-dynamic'

function admin(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars')
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

interface TransferInput {
  ticker:   string
  action:   'TRANSFER_IN' | 'TRANSFER_OUT'
  quantity: number
  price:    number
  reason:   string
}

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const started = Date.now()
  try {
    const { id: session_id } = await params
    if (!session_id) {
      return NextResponse.json({ error: 'session_id required' }, { status: 400 })
    }

    let body: { transfers?: TransferInput[] }
    try {
      body = await req.json()
    } catch (e: any) {
      return NextResponse.json(
        { error: `Invalid JSON body: ${e.message}` },
        { status: 400 }
      )
    }

    const transfers = Array.isArray(body.transfers) ? body.transfers : []
    if (transfers.length === 0) {
      return NextResponse.json(
        { error: 'transfers array is required and must contain at least one row' },
        { status: 400 }
      )
    }

    // Basic shape validation
    for (let i = 0; i < transfers.length; i++) {
      const t = transfers[i]
      if (typeof t.ticker !== 'string' || !t.ticker) {
        return NextResponse.json({ error: `transfer[${i}]: ticker missing or invalid` }, { status: 400 })
      }
      if (t.action !== 'TRANSFER_IN' && t.action !== 'TRANSFER_OUT') {
        return NextResponse.json(
          { error: `transfer[${i}] (${t.ticker}): action must be TRANSFER_IN or TRANSFER_OUT` },
          { status: 400 }
        )
      }
      if (typeof t.quantity !== 'number' || !Number.isFinite(t.quantity) || t.quantity <= 0) {
        return NextResponse.json(
          { error: `transfer[${i}] (${t.ticker}): quantity must be a positive number` },
          { status: 400 }
        )
      }
      if (typeof t.price !== 'number' || !Number.isFinite(t.price) || t.price < 0) {
        return NextResponse.json(
          { error: `transfer[${i}] (${t.ticker}): price must be a non-negative number` },
          { status: 400 }
        )
      }
    }

    const db = admin()

    // 1. Find canonical broker_file for this session
    const { data: files, error: filesErr } = await db
      .from('broker_files')
      .select('id, portfolio_id, file_kind, parse_status')
      .eq('upload_session_id', session_id)

    if (filesErr) {
      return NextResponse.json({ error: filesErr.message }, { status: 500 })
    }
    if (!files || files.length === 0) {
      return NextResponse.json({ error: 'No files found for session' }, { status: 404 })
    }

    const canonicalFile = files.find(f => f.file_kind === 'canonical_positions')
    if (!canonicalFile) {
      return NextResponse.json(
        { error: 'No canonical_positions file in this session — apply-reconciliation requires one' },
        { status: 400 }
      )
    }
    if (canonicalFile.parse_status !== 'committed') {
      return NextResponse.json(
        { error: `Session not yet committed (canonical file status: ${canonicalFile.parse_status}). Commit the session first.` },
        { status: 409 }
      )
    }

    const portfolio_id = canonicalFile.portfolio_id as string

    // 2. Resolve transfer date = MAX(market_prices.price_date)  — pitfall #87
    const { data: maxDateRows, error: maxDateErr } = await db
      .from('market_prices')
      .select('price_date')
      .order('price_date', { ascending: false })
      .limit(1)

    if (maxDateErr) {
      return NextResponse.json(
        { error: `market_prices max date query: ${maxDateErr.message}` },
        { status: 500 }
      )
    }
    if (!maxDateRows || maxDateRows.length === 0) {
      return NextResponse.json(
        { error: 'market_prices is empty — cannot date reconciliation transfers. Import prices first.' },
        { status: 400 }
      )
    }
    const transferDate = (maxDateRows[0] as any).price_date as string

    // 3. Validate all tickers exist in instruments master
    const distinctTickers = Array.from(new Set(transfers.map(t => t.ticker)))
    const { data: foundInstr, error: instrErr } = await db
      .from('instruments')
      .select('instrument_id')
      .in('instrument_id', distinctTickers)

    if (instrErr) {
      return NextResponse.json(
        { error: `instruments lookup: ${instrErr.message}` },
        { status: 500 }
      )
    }
    const foundSet = new Set((foundInstr || []).map((r: any) => r.instrument_id))
    const missing  = distinctTickers.filter(t => !foundSet.has(t))
    if (missing.length > 0) {
      return NextResponse.json(
        {
          error: `Apply blocked: ${missing.length} ticker${missing.length === 1 ? '' : 's'} not in instruments master.`,
          missing_instruments: missing,
          hint: 'Add these tickers to the instruments table (INSERT via SQL or admin UI), then retry.',
        },
        { status: 400 }
      )
    }

    // 4. Build transactions rows with traceable notes pattern
    const txRows = transfers.map(t => ({
      portfolio_id,
      trade_date:     transferDate,
      action:         t.action,
      instrument_id:  t.ticker,
      quantity:       t.quantity,
      price:          t.price,
      gross_value:    t.quantity * t.price,
      amount:         t.action === 'TRANSFER_IN' ? -(t.quantity * t.price) : (t.quantity * t.price),
      notes:          `Reconciliation TRANSFER (session=${session_id}, ticker=${t.ticker}, reason=${t.reason})`,
      source_file_id: canonicalFile.id,
    }))

    // 5. Insert
    const { data: inserted, error: insErr } = await db
      .from('transactions')
      .insert(txRows)
      .select('id')

    if (insErr) {
      return NextResponse.json(
        { error: `transactions insert failed: ${insErr.message}` },
        { status: 500 }
      )
    }
    const transferred = inserted?.length || 0

    // 6. Rebuild holdings
    const holdingsRebuild = await rebuildPortfolioHoldings(db, portfolio_id)

    // 7. Reconstruct NAV
    let navReconstruction: {
      navEntriesAdded:    number
      datesProcessed:     number
      instrumentsTracked: number
      error?:             string
    } = { navEntriesAdded: 0, datesProcessed: 0, instrumentsTracked: 0 }
    try {
      const r = await reconstructPortfolioNav(db, portfolio_id)
      navReconstruction = {
        navEntriesAdded:    r.navEntriesAdded,
        datesProcessed:     r.datesProcessed,
        instrumentsTracked: r.instrumentsTracked,
        error:              r.error,
      }
    } catch (e: any) {
      navReconstruction.error = `unexpected: ${e.message || 'unknown'}`
    }

    return NextResponse.json({
      ok:           true,
      transferred,
      date_used:    transferDate,
      portfolio_id,
      holdings_rebuild: {
        upserted:              holdingsRebuild.upserted,
        deleted:               holdingsRebuild.deleted,
        skipped_no_instrument: holdingsRebuild.skipped_no_instrument,
        errors:                holdingsRebuild.errors,
      },
      nav_reconstruction: navReconstruction,
      elapsed_ms: Date.now() - started,
    })
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'unknown error' },
      { status: 500 }
    )
  }
}
