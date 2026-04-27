/**
 * app/api/broker/sessions/[id]/apply-reconciliation/route.ts — v27q-fix5
 *
 * v27q-fix5: TransferInput accepts forceZero?: boolean. Force-zero rows
 * skip market_prices lookup and write price=0, amount=0 — for corporate
 * actions where the broker's transaction ledger never recorded the event
 * (license revocation, share consolidation phantom retirement).
 *
 * external_ref tagging:
 *   - forceZero=true                  → corp-action-zero-recovery-<sessionId>
 *   - portfolio_only TRANSFER_OUT     → corp-action-delisting-<sessionId>
 *   - top_up_needed / cscs_only       → no external_ref (regular reconciliation)
 *
 * The retired-shares report at /admin/portfolios/[id]/retired-shares
 * filters by these tags to surface positions warranting registrar follow-up.
 *
 * v27p baseline:
 * v27p changes:
 *   1. Per-row transferDate is now REQUIRED in the request body. Operator
 *      picked a date in the variance panel; server uses that date.
 *   2. Server re-resolves price by exact (ticker, transferDate) lookup
 *      against market_prices. The price field in the request body is
 *      ignored — server is authoritative. If no price exists for the
 *      (ticker, date) pair, the row fails with a structured error.
 *   3. Sign convention: TRANSFER_IN and TRANSFER_OUT both write POSITIVE
 *      amount values, matching lib/recovery-synth.ts and DON-C's
 *      pre-v27o existing real TRANSFER_IN row. fee-calc.ts and
 *      analytics.ts use Math.abs() so existing data isn't broken.
 *      v27g's negative-for-TRANSFER_IN convention was inconsistent
 *      with every other writer in the codebase — fixed.
 *
 * Idempotency unchanged: the v27g "selected rows can't reappear after
 * apply" property holds because variance recomputes against rebuilt
 * holdings post-apply.
 *
 * v27h preserved: step 8 metadata re-inference.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { rebuildPortfolioHoldings } from '@/lib/holdings-rebuild'
import { reconstructPortfolioNav } from '@/lib/nav-reconstruct'
import { inferPortfolioStart } from '@/lib/portfolio-metadata'

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
  ticker:       string
  action:       'TRANSFER_IN' | 'TRANSFER_OUT'
  quantity:     number
  transferDate: string   // v27p: required, ISO YYYY-MM-DD
  reason:       string
  // price field deliberately ignored; server resolves authoritatively
  price?:       number
  // v27q-fix5: force write at price=0 (corporate action with no recovery)
  forceZero?:   boolean
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

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

    // v27p: shape validation now requires transferDate per row
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
      if (typeof t.transferDate !== 'string' || !ISO_DATE_RE.test(t.transferDate)) {
        return NextResponse.json(
          { error: `transfer[${i}] (${t.ticker}): transferDate is required and must be ISO YYYY-MM-DD` },
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

    // 2. Validate all tickers exist in instruments master
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

    // 3. v27p: Resolve price for every (ticker, transferDate) pair via
    // exact match against market_prices. Build a lookup table in a single
    // query, then walk transfers.
    // v27q-fix5: force-zero rows skip the lookup entirely (price=0).
    const lookupTransfers = transfers.filter(t => !t.forceZero)
    const distinctPairs = Array.from(new Set(lookupTransfers.map(t => `${t.ticker}|${t.transferDate}`)))
    const distinctDates = Array.from(new Set(lookupTransfers.map(t => t.transferDate)))

    // v27q-fix5: skip the lookup entirely if no non-force-zero rows
    let priceRows: Array<{ instrument_id: string; price_date: string; price: number }> = []
    let priceErr: { message: string } | null = null
    if (distinctDates.length > 0) {
      const lookupResult = await db
        .from('market_prices')
        .select('instrument_id, price_date, price')
        .in('instrument_id', distinctTickers)
        .in('price_date', distinctDates)
        .limit(50000)
      priceRows = (lookupResult.data ?? []) as typeof priceRows
      priceErr = lookupResult.error
    }

    if (priceErr) {
      return NextResponse.json(
        { error: `market_prices lookup: ${priceErr.message}` },
        { status: 500 }
      )
    }

    const priceMap: Record<string, number> = {}
    for (const p of priceRows) {
      const key = `${p.instrument_id}|${p.price_date}`
      priceMap[key] = Number(p.price ?? 0)
    }

    // Validate every pair (excluding force-zero) found a price
    const missingPairs: Array<{ ticker: string; date: string }> = []
    for (const pair of distinctPairs) {
      if (priceMap[pair] === undefined || priceMap[pair] === null) {
        const [ticker, date] = pair.split('|')
        missingPairs.push({ ticker, date })
      }
    }
    if (missingPairs.length > 0) {
      return NextResponse.json(
        {
          error: `Apply blocked: ${missingPairs.length} (ticker, date) pair${missingPairs.length === 1 ? '' : 's'} have no market_prices row.`,
          missing_price_dates: missingPairs,
          hint: 'Pick a different date for these rows in the variance panel — only dates with a market price are valid.',
        },
        { status: 400 }
      )
    }

    // 4. v27q-fix5: Build transactions rows.
    //    - Force-zero rows: price=0, amount=0, external_ref=corp-action-zero-recovery-...
    //    - portfolio_only TRANSFER_OUT (delisting): external_ref=corp-action-delisting-...
    //    - everything else: no external_ref
    const txRows = transfers.map(t => {
      const isForceZero = t.forceZero === true
      const price = isForceZero ? 0 : priceMap[`${t.ticker}|${t.transferDate}`]
      const grossValue = Math.abs(t.quantity * price)

      let external_ref: string | null = null
      let notesPrefix = 'Reconciliation TRANSFER'
      if (isForceZero) {
        external_ref = `corp-action-zero-recovery-${session_id}`
        notesPrefix = 'Corporate action — zero recovery'
      } else if (t.action === 'TRANSFER_OUT' && t.reason === 'portfolio_only') {
        external_ref = `corp-action-delisting-${session_id}`
        notesPrefix = 'Delisting writeoff'
      }

      return {
        portfolio_id,
        trade_date:     t.transferDate,
        action:         t.action,
        instrument_id:  t.ticker,
        quantity:       t.quantity,
        price,
        gross_value:    grossValue,
        amount:         grossValue,   // v27p: POSITIVE for both IN and OUT
        notes:          `${notesPrefix} (session=${session_id}, ticker=${t.ticker}, reason=${t.reason}, date=${t.transferDate}${isForceZero ? ', forceZero=true' : ''})`,
        source_file_id: canonicalFile.id,
        external_ref,
      }
    })

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

    // 8. v27h preserved: re-infer portfolio start metadata
    let metadataBackfill: {
      attempted: boolean
      applied: boolean
      reason: string
      previous?: { start_date: string | null; starting_nav: number }
      updated?: { start_date: string; starting_nav: number; method: string }
      error?: string
    } = { attempted: false, applied: false, reason: 'not evaluated' }

    try {
      metadataBackfill.attempted = true
      const { data: portfolioRow } = await db
        .from('portfolios')
        .select('start_date, starting_nav')
        .eq('id', portfolio_id)
        .single()
      const previousNav = Number(portfolioRow?.starting_nav ?? 0)
      const previousStart = portfolioRow?.start_date ?? null

      const inferResult = await inferPortfolioStart(db, portfolio_id)
      if (!inferResult.ok || !inferResult.inferred) {
        metadataBackfill = {
          attempted: true, applied: false,
          reason: `inference failed: ${inferResult.error ?? 'unknown'}`,
          error: inferResult.error,
          previous: { start_date: previousStart, starting_nav: previousNav },
        }
      } else {
        const inferred = inferResult.inferred
        const { error: upErr } = await db
          .from('portfolios')
          .update({
            start_date:   inferred.start_date,
            starting_nav: inferred.starting_nav,
            updated_at:   new Date().toISOString(),
          })
          .eq('id', portfolio_id)

        if (upErr) {
          metadataBackfill = {
            attempted: true, applied: false,
            reason: `UPDATE failed: ${upErr.message}`,
            error: upErr.message,
            previous: { start_date: previousStart, starting_nav: previousNav },
          }
        } else {
          metadataBackfill = {
            attempted: true, applied: true,
            reason: `re-inferred from transactions (previous starting_nav=${previousNav})`,
            previous: { start_date: previousStart, starting_nav: previousNav },
            updated: {
              start_date:   inferred.start_date,
              starting_nav: inferred.starting_nav,
              method:       inferred.method,
            },
          }
        }
      }
    } catch (e: any) {
      metadataBackfill = {
        attempted: true, applied: false,
        reason: `unexpected error: ${e.message || 'unknown'}`,
        error: e.message,
      }
    }

    return NextResponse.json({
      ok:           true,
      transferred,
      portfolio_id,
      holdings_rebuild: {
        upserted:              holdingsRebuild.upserted,
        deleted:               holdingsRebuild.deleted,
        skipped_no_instrument: holdingsRebuild.skipped_no_instrument,
        errors:                holdingsRebuild.errors,
      },
      nav_reconstruction: navReconstruction,
      metadata_backfill:  metadataBackfill,
      elapsed_ms: Date.now() - started,
    })
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'unknown error' },
      { status: 500 }
    )
  }
}
