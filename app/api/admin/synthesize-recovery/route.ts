/**
 * app/api/admin/synthesize-recovery/route.ts — v27o
 *
 * Admin endpoint for triggering recovery-transfer synthesis on existing
 * portfolios. Same code path as the broker commit route's step 7.5,
 * just exposed standalone so portfolios that were imported pre-v27o
 * can be backfilled without re-running their broker imports.
 *
 * Body shape:
 *   { portfolio_id: string, rerun?: boolean }
 *
 *   rerun=true wipes existing synthetic rows (matched by
 *   external_ref = 'synthetic-recovery-v1-<portfolio_id>') before
 *   re-detecting. Use this if data has changed or you want to redo
 *   synthesis after fixing upstream issues.
 *
 * After insertion, fires the same post-processing chain as the commit
 * route:
 *   - rebuildPortfolioHoldings  (so holdings reflect the synthetic TRANSFER_IN qty)
 *   - inferPortfolioStart       (so portfolios.start_date / starting_nav re-anchor)
 *   - reconstructPortfolioNav   (so nav_log captures the new starting position)
 *
 * Same best-effort pattern — each post-step wrapped in try/catch and
 * surfaced in the response.
 *
 * Targeted use case for v27o backfill: hit this once per affected
 * portfolio (DON-C, ADE-C, CDOO-A, CMFB-D, FMI-A, OPC-A) to fix the
 * existing data corruption. After v27o ships, new clients are handled
 * automatically via the broker commit route.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { synthesizeRecoveryTransfers } from '@/lib/recovery-synth'
import { rebuildPortfolioHoldings } from '@/lib/holdings-rebuild'
import { inferPortfolioStart } from '@/lib/portfolio-metadata'
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

export async function POST(req: NextRequest) {
  const started = Date.now()
  try {
    let body: { portfolio_id?: string; rerun?: boolean }
    try {
      body = await req.json()
    } catch (e: any) {
      return NextResponse.json(
        { error: `Invalid JSON body: ${e.message}` },
        { status: 400 }
      )
    }

    const portfolio_id = body.portfolio_id
    if (!portfolio_id || typeof portfolio_id !== 'string') {
      return NextResponse.json(
        { error: 'portfolio_id (string) required in body' },
        { status: 400 }
      )
    }

    const rerun = body.rerun === true
    const db    = admin()

    // 1. Synthesize.
    const synth = await synthesizeRecoveryTransfers(db, portfolio_id, { rerun })

    // If detection failed (e.g. portfolio not found, no start_date available)
    // surface as a 400 so the caller knows nothing was applied.
    if (!synth.applied && !synth.alreadySynthesized) {
      return NextResponse.json(
        {
          ok: false,
          recovery_synthesis: synth,
          elapsed_ms: Date.now() - started,
        },
        { status: 400 }
      )
    }

    const didWrite = synth.inserted > 0 || (rerun && synth.applied)

    // 2. Rebuild holdings (only if rows changed).
    let holdingsRebuild: any = { skipped: true, reason: 'no rows changed' }
    if (didWrite) {
      try {
        const r = await rebuildPortfolioHoldings(db, portfolio_id)
        holdingsRebuild = {
          upserted:              r.upserted,
          deleted:               r.deleted,
          skipped_no_instrument: r.skipped_no_instrument,
          errors:                r.errors,
        }
      } catch (e: any) {
        holdingsRebuild = { error: e.message || 'unknown' }
      }
    }

    // 3. Re-infer start metadata.
    let metadataBackfill: any = { attempted: false, reason: 'no rows changed' }
    if (didWrite) {
      metadataBackfill = { attempted: true, applied: false, reason: 'not yet evaluated' }
      try {
        const { data: portfolioRow } = await db
          .from('portfolios')
          .select('start_date, starting_nav')
          .eq('id', portfolio_id)
          .single()
        const previousNav   = Number(portfolioRow?.starting_nav ?? 0)
        const previousStart = portfolioRow?.start_date ?? null

        const inferResult = await inferPortfolioStart(db, portfolio_id)
        if (inferResult.ok && inferResult.inferred) {
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
              previous: { start_date: previousStart, starting_nav: previousNav },
              updated:  inferred,
            }
          }
        } else {
          metadataBackfill = {
            attempted: true, applied: false,
            reason: `inference failed: ${inferResult.error ?? 'unknown'}`,
            error: inferResult.error,
            previous: { start_date: previousStart, starting_nav: previousNav },
          }
        }
      } catch (e: any) {
        metadataBackfill = {
          attempted: true, applied: false,
          reason: `unexpected error: ${e.message || 'unknown'}`,
          error: e.message,
        }
      }
    }

    // 4. NAV reconstruction.
    let navReconstruction: any = { attempted: false, reason: 'no rows changed' }
    if (didWrite) {
      navReconstruction = {
        attempted:          true,
        navEntriesAdded:    0,
        datesProcessed:     0,
        instrumentsTracked: 0,
      }
      try {
        const r = await reconstructPortfolioNav(db, portfolio_id)
        navReconstruction = {
          attempted:          true,
          navEntriesAdded:    r.navEntriesAdded,
          datesProcessed:     r.datesProcessed,
          instrumentsTracked: r.instrumentsTracked,
          error:              r.error,
        }
      } catch (e: any) {
        navReconstruction.error = `unexpected: ${e.message || 'unknown'}`
      }
    }

    return NextResponse.json({
      ok:                 true,
      portfolio_id,
      recovery_synthesis: synth,
      holdings_rebuild:   holdingsRebuild,
      metadata_backfill:  metadataBackfill,
      nav_reconstruction: navReconstruction,
      elapsed_ms:         Date.now() - started,
    })
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'unknown error' },
      { status: 500 }
    )
  }
}
