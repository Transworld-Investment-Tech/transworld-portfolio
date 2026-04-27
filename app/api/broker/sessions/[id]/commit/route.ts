/**
 * app/api/broker/sessions/[id]/commit/route.ts — v27o
 *
 * v27o change: Step 7.5 — recovery-transfer synthesis.
 *
 * After staged transactions are inserted into the transactions table
 * (step 7) but before broker_files status flips to 'committed' (step 8),
 * we run synthesizeRecoveryTransfers to detect orphan SELLs (i.e.,
 * shares sold without a prior corresponding BUY — by definition,
 * in-kind shares the client transferred in at recovery). These get
 * dated at portfolio.start_date (with fallback to earliest transaction
 * date) and tagged with external_ref for idempotency.
 *
 * Best-effort like steps 9/11/12 — wrapped in try/catch so a synthesis
 * failure doesn't undo the commit. Result surfaced in the response
 * under recovery_synthesis key.
 *
 * v27h preserved: Step 11 always re-infers portfolio start metadata.
 *
 * The v21g-hotfix-1 isStale gate (only-infer-when-starting_nav-is-zero)
 * has been removed. Earliest transaction date IS inception by definition,
 * so a manually-set non-zero starting_nav from before the first real
 * trade is always wrong and gets superseded. v27h drops the gate and
 * always re-infers, so a freshly-built portfolio (or one that just had
 * canonical reconciliation transfers written) gets its starting_nav
 * and start_date anchored to actual transaction history every time.
 *
 * v27g preserved: Step 12 auto-fires NAV reconstruction. After the
 * v21d holdings rebuild (step 10) and metadata backfill (step 11),
 * we call lib/nav-reconstruct's reconstructPortfolioNav helper for the
 * just-committed portfolio. Closes the second half of pitfall #86.
 *
 * v21l preserved: alias map loaded once, applied defensively
 * to instrument_id on every committed row.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { getAliasMap, applyAlias } from '@/lib/ticker-aliases'
import { rebuildPortfolioHoldings } from '@/lib/holdings-rebuild'
import { inferPortfolioStart } from '@/lib/portfolio-metadata'
import { reconstructPortfolioNav } from '@/lib/nav-reconstruct'
import { synthesizeRecoveryTransfers, type SynthesisResult } from '@/lib/recovery-synth'

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

function sumNonNull(xs: Array<number | null | undefined>): number | null {
  const nn = xs.filter((x): x is number => x !== null && x !== undefined)
  if (nn.length === 0) return null
  return nn.reduce((a, b) => a + b, 0)
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

    // v21l: Load merged alias map (DB + hardcoded) once at handler start.
    const aliasMap = await getAliasMap(db)

    // 1. Fetch all broker_files in session.
    // v27g: exclude canonical_positions from commit pipeline — those are
    // metadata-only files used post-commit by the variance panel.
    const { data: files, error: filesErr } = await db
      .from('broker_files')
      .select('id, portfolio_id, parse_status, cscs_number, file_kind')
      .eq('upload_session_id', session_id)

    if (filesErr) {
      return NextResponse.json({ error: filesErr.message }, { status: 500 })
    }
    if (!files || files.length === 0) {
      return NextResponse.json({ error: 'No files in session' }, { status: 404 })
    }

    // v27g: filter canonical_positions out of the commit logic. They go
    // through their own apply-reconciliation flow post-commit and have no
    // staged_transactions to insert.
    const tradeFiles = files.filter(f => f.file_kind !== 'canonical_positions')

    // 2. Refuse if any trade file is already committed.
    const alreadyCommitted = tradeFiles.filter((f) => f.parse_status === 'committed')
    if (alreadyCommitted.length > 0) {
      return NextResponse.json(
        {
          error: `Session already committed (${alreadyCommitted.length} of ${tradeFiles.length} file${tradeFiles.length === 1 ? '' : 's'}). Rollback first to re-commit.`,
        },
        { status: 409 }
      )
    }

    if (tradeFiles.length === 0) {
      return NextResponse.json(
        { error: 'No trade files in session — only canonical_positions present.' },
        { status: 400 }
      )
    }

    const portfolio_id = tradeFiles[0].portfolio_id
    const fileIds      = tradeFiles.map((f) => f.id)

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

    const total   = totalStaged ?? toCommit.length
    const skipped = total - toCommit.length

    // 5. Build transactions rows.
    // v21l: defensive alias pass uses the merged aliasMap (DB + hardcoded).
    const txRows = toCommit.map((s: any) => {
      const fees = sumNonNull([
        s.fee_commission, s.fee_vat, s.fee_contract_stamp,
        s.fee_exchange,   s.fee_clearing, s.fee_sec, s.fee_sms,
        s.fee_management, s.fee_demat, s.fee_other,
      ])
      return {
        portfolio_id:       s.portfolio_id,
        trade_date:         s.trade_date,
        action:             s.action,
        instrument_id:      applyAlias(s.instrument_id, aliasMap),
        quantity:           s.quantity,
        price:              s.price,
        gross_value:        s.gross_value,
        amount:             s.amount,
        fees,
        fee_commission:     s.fee_commission,
        fee_vat:            s.fee_vat,
        fee_contract_stamp: s.fee_contract_stamp,
        fee_exchange:       s.fee_exchange,
        fee_clearing:       s.fee_clearing,
        fee_sec:            s.fee_sec,
        fee_sms:            s.fee_sms,
        fee_management:     s.fee_management,
        fee_demat:          s.fee_demat,
        fee_other:          s.fee_other,
        notes:              s.narration,
        cn_number:          s.cn_number,
        settlement_date:    s.settlement_date,
        external_ref:       s.external_ref,
        source_file_id:     s.broker_file_id,
      }
    })

    // 6. PRE-CHECK: surface missing instruments as a structured 400.
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
      const missing  = distinctTickers.filter((t) => !foundSet.has(t))

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

    // 7.5. v27o: Synthesize recovery transfers for in-kind shares.
    //
    // Recovery-account clients walk through the door already holding shares
    // in their CSCS account. The broker-import flow records subsequent
    // BUY/SELL/FEE activity from contract notes — but NOT the in-kind value
    // those starting shares represent. Without this step, contributedCapital
    // is radically understated and IRR correspondingly inflated.
    //
    // Algorithm (FIFO walk per instrument, in lib/recovery-synth.ts):
    //   - Any SELL whose cumulative same-instrument SELL qty exceeds the
    //     cumulative BUY qty at that point indicates an in-kind transfer
    //     (NGX prohibits short-selling; the excess MUST have been brought in)
    //   - Each orphan SELL portion → one synthetic TRANSFER_IN row dated
    //     at portfolio.start_date (with fallback to earliest transaction
    //     date if start_date is NULL — common for fresh portfolios that
    //     haven't run inferPortfolioStart yet)
    //   - Idempotent via external_ref = 'synthetic-recovery-v1-<portfolio_id>'
    //
    // Best-effort like steps 9/11/12 — surfaces result but doesn't fail the
    // commit if synthesis errors. The downstream steps (10 holdings rebuild,
    // 11 metadata backfill, 12 NAV reconstruction) will pick up the synthetic
    // rows automatically since they're now in the transactions table.
    let recoverySynth: SynthesisResult = {
      attempted:          false,
      applied:            false,
      inserted:           0,
      totalAmount:        0,
      startDate:          null,
      externalRef:        '',
      alreadySynthesized: false,
      reason:             'not yet evaluated',
    }
    try {
      recoverySynth = await synthesizeRecoveryTransfers(db, portfolio_id)
    } catch (e: any) {
      recoverySynth = {
        ...recoverySynth,
        attempted: true,
        reason:    `unexpected error: ${e.message || 'unknown'}`,
        error:     e.message,
      }
    }

    // 8. Transition broker_files.parse_status → 'committed'.
    // v27g: also flip canonical_positions files in the same session to
    // 'committed' so the staging UI knows to render the variance panel.
    const allFileIds = files.map(f => f.id)
    const { error: updErr } = await db
      .from('broker_files')
      .update({
        parse_status: 'committed',
        updated_at:   new Date().toISOString(),
      })
      .in('id', allFileIds)

    if (updErr) {
      return NextResponse.json(
        {
          error:   `broker_files status update failed: ${updErr.message}`,
          committed,
          warning: 'Transactions were inserted but broker_files state not updated. Manual cleanup may be needed.',
        },
        { status: 500 }
      )
    }

    // 9. CSCS backfill on the portfolio (non-fatal).
    try {
      const { data: portfolio } = await db
        .from('portfolios')
        .select('cscs_number')
        .eq('id', portfolio_id)
        .single()
      if (portfolio && !portfolio.cscs_number) {
        const firstCscs = files.find((f) => f.cscs_number)?.cscs_number
        if (firstCscs) {
          await db.from('portfolios').update({ cscs_number: firstCscs }).eq('id', portfolio_id)
        }
      }
    } catch { /* best-effort */ }

    // 10. v21d: Rebuild holdings.
    const holdingsRebuild = await rebuildPortfolioHoldings(db, portfolio_id)

    // 11. v27h: always re-infer portfolio start metadata.
    //
    // Earliest transaction date IS inception by definition. The previous
    // v21g-hotfix-1 isStale gate (only-infer-when-starting_nav-is-zero)
    // preserved manually-set values, but a manually-set starting_nav from
    // before any real transactions exist is meaningless — by definition
    // it gets superseded by the first real trade. v27h drops the gate
    // and always re-infers, so the displayed starting NAV is always
    // anchored to actual transaction history.
    //
    // inferPortfolioStart handles all cases: clean BUY-first portfolios
    // (cash + position value on day 1), OOO sale-of-pre-existing-shares
    // (mark-to-sell-price, NAV = sale proceeds), and reconciliation-only
    // portfolios (post-canonical-apply, NAV = sum of TRANSFER_IN values).
    let metadataBackfill: {
      attempted: boolean
      applied: boolean
      reason: string
      previous?: { start_date: string; starting_nav: number }
      updated?: { start_date: string; starting_nav: number; method: string }
      error?: string
    } = { attempted: false, applied: false, reason: 'not evaluated' }

    try {
      const { data: portfolioRow, error: pfErr } = await db
        .from('portfolios')
        .select('start_date, starting_nav')
        .eq('id', portfolio_id)
        .single()

      if (pfErr) {
        metadataBackfill = {
          attempted: true, applied: false,
          reason: `could not read portfolio row: ${pfErr.message}`,
          error: pfErr.message,
        }
      } else {
        const previousNav = Number(portfolioRow?.starting_nav ?? 0)
        metadataBackfill.attempted = true
        const inferResult = await inferPortfolioStart(db, portfolio_id)

        if (!inferResult.ok || !inferResult.inferred) {
          metadataBackfill = {
            attempted: true, applied: false,
            reason: `inference failed: ${inferResult.error ?? 'unknown'}`,
            error: inferResult.error,
            previous: { start_date: portfolioRow.start_date, starting_nav: previousNav },
          }
        } else {
          const inferred = inferResult.inferred
          const { error: updatePfErr } = await db
            .from('portfolios')
            .update({
              start_date:   inferred.start_date,
              starting_nav: inferred.starting_nav,
              updated_at:   new Date().toISOString(),
            })
            .eq('id', portfolio_id)

          if (updatePfErr) {
            metadataBackfill = {
              attempted: true, applied: false,
              reason: `UPDATE failed: ${updatePfErr.message}`,
              error: updatePfErr.message,
              previous: { start_date: portfolioRow.start_date, starting_nav: previousNav },
            }
          } else {
            metadataBackfill = {
              attempted: true, applied: true,
              reason: `re-inferred from transactions (previous starting_nav=${previousNav})`,
              previous: { start_date: portfolioRow.start_date, starting_nav: previousNav },
              updated: {
                start_date:   inferred.start_date,
                starting_nav: inferred.starting_nav,
                method:       inferred.method,
              },
            }
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

    // 12. v27g: Auto-fire NAV reconstruction (closes pitfall #86).
    // Best-effort like steps 9 and 11 — surfaces result but doesn't fail
    // the commit if reconstruction errors. ~5 seconds for a portfolio-scoped
    // run; well under the 60s maxDuration.
    let navReconstruction: {
      attempted:          boolean
      navEntriesAdded:    number
      datesProcessed:     number
      instrumentsTracked: number
      error?:             string
    } = {
      attempted: false,
      navEntriesAdded: 0,
      datesProcessed: 0,
      instrumentsTracked: 0,
    }

    try {
      navReconstruction.attempted = true
      const r = await reconstructPortfolioNav(db, portfolio_id)
      navReconstruction = {
        attempted:          true,
        navEntriesAdded:    r.navEntriesAdded,
        datesProcessed:     r.datesProcessed,
        instrumentsTracked: r.instrumentsTracked,
        error:              r.error,
      }
    } catch (e: any) {
      navReconstruction.error = `unexpected error: ${e.message || 'unknown'}`
    }

    return NextResponse.json({
      ok: true,
      committed,
      skipped,
      broker_files: fileIds.length,
      holdings_rebuild: {
        upserted:             holdingsRebuild.upserted,
        deleted:              holdingsRebuild.deleted,
        skipped_no_instrument: holdingsRebuild.skipped_no_instrument,
        errors:               holdingsRebuild.errors,
      },
      metadata_backfill: metadataBackfill,
      recovery_synthesis: recoverySynth,
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
