/**
 * app/api/broker/sessions/[id]/commit/route.ts — v21d
 *
 * POST /api/broker/sessions/[id]/commit
 *
 * Moves all staged_transactions for this session where
 * include_in_commit = true into the real `transactions` table.
 * Then rebuilds the portfolio's holdings from its now-current
 * transaction history (v21d).
 *
 * v21b-3b-hotfix-1 additions:
 *   1. Defensive NGX_TICKER_ALIASES pass when mapping staged →
 *      transactions, so legacy staged rows (written before the
 *      upload-route alias fix) still commit cleanly.
 *   2. Pre-check: before INSERT, query `instruments` for every
 *      distinct instrument_id in the rows-to-commit. If any are
 *      missing from the master table, return a structured 400
 *      with `missing_instruments: string[]` so the UI can render
 *      a helpful error instead of a raw FK violation.
 *
 * v21d additions:
 *   - After a successful transactions INSERT (and before returning
 *     success), call rebuildPortfolioHoldings(). Recomputes the
 *     holdings table from the portfolio's full transaction history.
 *     Failure of the rebuild is surfaced as a warning in the
 *     response but does NOT cause the commit itself to fail —
 *     transactions have already been inserted and we don't want
 *     to roll them back over a holdings derivation issue.
 *
 * Side effects on success:
 *   - transactions.source_file_id is set to the staged row's
 *     broker_file_id (FK column name differs across tables).
 *   - broker_files.parse_status transitions to 'committed'.
 *   - If the target portfolio has a NULL cscs_number and any
 *     broker_file in the session has one populated, it's
 *     backfilled onto the portfolio.
 *   - holdings for the portfolio are fully rebuilt from the
 *     current transactions history (v21d).
 *
 * Guards:
 *   - 409 if any broker_file in the session is already
 *     parse_status='committed'. Rollback first to re-commit.
 *   - 400 if any instrument_id on a to-be-committed row is
 *     missing from the instruments master table.
 *
 * Returns { ok, committed, skipped, broker_files, holdings_rebuild,
 *           elapsed_ms } on success;
 * { error, missing_instruments?, hint? } on failure.
 *
 * Next.js 15: params is a Promise.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { NGX_TICKER_ALIASES } from '@/lib/market-data'
import { rebuildPortfolioHoldings } from '@/lib/holdings-rebuild'

export const runtime = 'nodejs'
export const maxDuration = 60
export const dynamic = 'force-dynamic'

function admin(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars'
    )
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

function sumNonNull(xs: Array<number | null | undefined>): number | null {
  const nn = xs.filter((x): x is number => x !== null && x !== undefined)
  if (nn.length === 0) return null
  return nn.reduce((a, b) => a + b, 0)
}

// Defensive second pass of the same alias resolution used at upload
// time. Covers pre-hotfix staged rows that were written with raw
// tickers (e.g. FBNH). No-op on rows that were already aliased.
function aliasTicker(t: string | null | undefined): string | null {
  if (t === null || t === undefined) return null
  const up = String(t).toUpperCase()
  if (up === '') return null
  return NGX_TICKER_ALIASES[up] || up
}

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const started = Date.now()
  try {
    const { id: session_id } = await params
    if (!session_id) {
      return NextResponse.json({ error: 'session_id required' }, { status: 400 })
    }

    const db = admin()

    // 1. Fetch all broker_files in session.
    const { data: files, error: filesErr } = await db
      .from('broker_files')
      .select('id, portfolio_id, parse_status, cscs_number')
      .eq('upload_session_id', session_id)

    if (filesErr) {
      return NextResponse.json({ error: filesErr.message }, { status: 500 })
    }
    if (!files || files.length === 0) {
      return NextResponse.json({ error: 'No files in session' }, { status: 404 })
    }

    // 2. Refuse if any file is already committed.
    const alreadyCommitted = files.filter((f) => f.parse_status === 'committed')
    if (alreadyCommitted.length > 0) {
      return NextResponse.json(
        {
          error: `Session already committed (${alreadyCommitted.length} of ${files.length} file${files.length === 1 ? '' : 's'}). Rollback first to re-commit.`,
        },
        { status: 409 }
      )
    }

    const portfolio_id = files[0].portfolio_id
    const fileIds = files.map((f) => f.id)

    // 3. Fetch staged rows to commit (include_in_commit=true).
    const { data: staged, error: stagedErr } = await db
      .from('staged_transactions')
      .select(
        `id, broker_file_id, portfolio_id, trade_date, settlement_date,
         action, instrument_id, quantity, price, gross_value, amount,
         fee_commission, fee_vat, fee_contract_stamp,
         fee_exchange, fee_clearing, fee_sec, fee_sms,
         fee_management, fee_demat, fee_other,
         cn_number, external_ref, narration, include_in_commit`
      )
      .in('broker_file_id', fileIds)
      .eq('include_in_commit', true)
      .order('trade_date', { ascending: true })
      .order('created_at', { ascending: true })

    if (stagedErr) {
      return NextResponse.json(
        { error: `staged_transactions query: ${stagedErr.message}` },
        { status: 500 }
      )
    }

    const toCommit = staged || []

    // 4. Count total staged rows for skipped calculation.
    const { count: totalStaged } = await db
      .from('staged_transactions')
      .select('*', { count: 'exact', head: true })
      .in('broker_file_id', fileIds)

    const total = totalStaged ?? toCommit.length
    const skipped = total - toCommit.length

    // 5. Build transactions rows — defensive alias pass on instrument_id.
    const txRows = toCommit.map((s: any) => {
      const fees = sumNonNull([
        s.fee_commission,
        s.fee_vat,
        s.fee_contract_stamp,
        s.fee_exchange,
        s.fee_clearing,
        s.fee_sec,
        s.fee_sms,
        s.fee_management,
        s.fee_demat,
        s.fee_other,
      ])
      return {
        portfolio_id: s.portfolio_id,
        trade_date: s.trade_date,
        action: s.action,
        instrument_id: aliasTicker(s.instrument_id),
        quantity: s.quantity,
        price: s.price,
        gross_value: s.gross_value,
        amount: s.amount,
        fees,
        fee_commission: s.fee_commission,
        fee_vat: s.fee_vat,
        fee_contract_stamp: s.fee_contract_stamp,
        fee_exchange: s.fee_exchange,
        fee_clearing: s.fee_clearing,
        fee_sec: s.fee_sec,
        fee_sms: s.fee_sms,
        fee_management: s.fee_management,
        fee_demat: s.fee_demat,
        fee_other: s.fee_other,
        notes: s.narration,
        cn_number: s.cn_number,
        settlement_date: s.settlement_date,
        external_ref: s.external_ref,
        source_file_id: s.broker_file_id,
      }
    })

    // 6. PRE-CHECK: surface missing instruments as a structured 400
    //    rather than letting PostgreSQL raise a cryptic FK violation.
    const distinctTickers = Array.from(
      new Set(
        txRows
          .map((r) => r.instrument_id)
          .filter((t): t is string => typeof t === 'string' && t.length > 0)
      )
    )

    if (distinctTickers.length > 0) {
      const { data: found, error: lookupErr } = await db
        .from('instruments')
        .select('instrument_id')
        .in('instrument_id', distinctTickers)

      if (lookupErr) {
        return NextResponse.json(
          { error: `instruments lookup: ${lookupErr.message}` },
          { status: 500 }
        )
      }

      const foundSet = new Set((found || []).map((r: any) => r.instrument_id))
      const missing = distinctTickers.filter((t) => !foundSet.has(t))

      if (missing.length > 0) {
        return NextResponse.json(
          {
            error: `Commit blocked: ${missing.length} ticker${missing.length === 1 ? '' : 's'} not in instruments master.`,
            missing_instruments: missing,
            hint: 'Add these tickers to the instruments table (INSERT via SQL or admin UI), then retry commit.',
          },
          { status: 400 }
        )
      }
    }

    // 7. Insert into transactions.
    let committed = 0
    if (txRows.length > 0) {
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
      committed = inserted?.length || 0
    }

    // 8. Transition broker_files.parse_status → 'committed'.
    const { error: updErr } = await db
      .from('broker_files')
      .update({
        parse_status: 'committed',
        updated_at: new Date().toISOString(),
      })
      .in('id', fileIds)

    if (updErr) {
      return NextResponse.json(
        {
          error: `broker_files status update failed: ${updErr.message}`,
          committed,
          warning:
            'Transactions were inserted but broker_files state not updated. Manual cleanup may be needed.',
        },
        { status: 500 }
      )
    }

    // 9. CSCS backfill on the portfolio (non-fatal if it errors).
    try {
      const { data: portfolio } = await db
        .from('portfolios')
        .select('cscs_number')
        .eq('id', portfolio_id)
        .single()
      if (portfolio && !portfolio.cscs_number) {
        const firstCscs = files.find((f) => f.cscs_number)?.cscs_number
        if (firstCscs) {
          await db
            .from('portfolios')
            .update({ cscs_number: firstCscs })
            .eq('id', portfolio_id)
        }
      }
    } catch {
      // best-effort; continue
    }

    // 10. v21d: Rebuild holdings from the portfolio's transaction
    //     history. Non-fatal — if the rebuild errors, we surface it
    //     as a warning but keep the commit successful. Transactions
    //     are the source of truth; holdings are a derived cache.
    const holdingsRebuild = await rebuildPortfolioHoldings(db, portfolio_id)

    return NextResponse.json({
      ok: true,
      committed,
      skipped,
      broker_files: fileIds.length,
      holdings_rebuild: {
        upserted: holdingsRebuild.upserted,
        deleted: holdingsRebuild.deleted,
        skipped_no_instrument: holdingsRebuild.skipped_no_instrument,
        errors: holdingsRebuild.errors,
      },
      elapsed_ms: Date.now() - started,
    })
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'unknown error' },
      { status: 500 }
    )
  }
}
