/**
 * app/api/broker/sessions/[id]/route.ts — v27q-fix4
 *
 * v27q-fix4: pairs with a Supabase function rewrite (RETURNS jsonb instead
 * of RETURNS TABLE). PostgREST db-max-rows applies to RPC table-returns
 * too — v27q-fix3's .rpc() call was capped at 1705 rows, just at a
 * different alphabetical boundary than v27p's direct query. Switching the
 * function to return jsonb (a scalar from PostgREST's perspective) lifts
 * the cap entirely. Code-side change: defensive Array.isArray() guard
 * around the iteration. Wire-format-compatible with the v27q-fix3 code
 * because Supabase JS surfaces both shapes as `data: Array<row>`.
 *
 * v27q-fix3 history: replaced .from('market_prices').select(...).in().order().limit()
 * with .rpc('get_prices_for_tickers', { p_tickers }). Correct call site,
 * but the RPC was still server-capped due to TABLE return type.
 * Pitfall #59 + #92 + new pitfall (server-side row cap overrides client .limit AND RPC TABLE returns).
 *
 * v27p change: variance engine now needs full per-ticker price history
 * (not just latest price) to power the date picker, plus
 * portfolio.start_date as the smart-default anchor for cscs_only rows.
 *
 *   1. Download canonical from storage
 *   2. Parse via lib/cscs-parser
 *   3. Load current portfolio holdings
 *   4. Load full market_prices history for relevant tickers (NEW: history,
 *      not just latest)
 *   5. Load portfolio.start_date (NEW)
 *   6. Compute variance via lib/variance-engine (NEW signature)
 *   7. Returns parsed metadata + variance result + portfolio start date
 *
 * v27g baseline preserved otherwise. The latestMarketPriceDate field
 * is kept in the response shape for backward-compat with the panel —
 * v27p uses suggestedTransferDate per row instead, but legacy code
 * paths (e.g. apply-reconciliation default) may still reference it.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { getAliasMap } from '@/lib/ticker-aliases'
import { parseCSCSFile, type ParsedCSCS } from '@/lib/cscs-parser'
import {
  computeVariance,
  type CanonicalPosition,
  type PortfolioPosition,
  type PriceEntry,
  type VarianceResult,
} from '@/lib/variance-engine'

export const runtime = 'nodejs'
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

interface CanonicalSection {
  brokerFileId:           string
  filename:               string
  parsed:                 ParsedCSCS | null
  variance:               VarianceResult | null
  latestMarketPriceDate:  string | null
  portfolioStartDate:     string | null   // v27p
  error?:                 string
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: session_id } = await params
    if (!session_id) {
      return NextResponse.json({ error: 'session_id required' }, { status: 400 })
    }

    const db = admin()

    const { data: filesData, error: filesErr } = await db
      .from('broker_files')
      .select(
        `id, upload_session_id, portfolio_id, file_kind,
         original_filename, storage_path, size_bytes,
         parse_status, parse_error,
         account_holder, cscs_number,
         period_from, period_to,
         audit_opening, audit_closing, audit_computed, audit_passes,
         uploaded_by, created_at, updated_at, parsed_at,
         portfolios (
           id, name, label,
           clients ( code, name )
         )`
      )
      .eq('upload_session_id', session_id)
      .order('file_kind', { ascending: true })
      .order('created_at', { ascending: true })

    if (filesErr) {
      return NextResponse.json(
        { error: `broker_files query: ${filesErr.message}` },
        { status: 500 }
      )
    }

    const files = (filesData || []) as any[]
    if (files.length === 0) {
      return NextResponse.json(
        { error: `No files found for session ${session_id}` },
        { status: 404 }
      )
    }

    const firstFile = files[0]
    const portfolio = firstFile.portfolios
      ? {
          id: (firstFile.portfolios as any).id,
          name: (firstFile.portfolios as any).name,
          label: (firstFile.portfolios as any).label,
          client: (firstFile.portfolios as any).clients || null,
        }
      : null

    const portfolioId = firstFile.portfolio_id as string

    const uploadTime = files.reduce((min, f) => {
      return new Date(f.created_at) < new Date(min) ? f.created_at : min
    }, firstFile.created_at)

    const tradeFiles = files.filter(f => f.file_kind !== 'canonical_positions')
    const fileIds = tradeFiles.map((f) => f.id)

    const { data: stagedData, error: stagedErr } = fileIds.length > 0
      ? await db
          .from('staged_transactions')
          .select(
            `id, broker_file_id, trade_date, settlement_date,
             action, instrument_id, quantity, price,
             gross_value, amount,
             fee_commission, fee_vat, fee_contract_stamp,
             fee_exchange, fee_clearing, fee_sec, fee_sms,
             fee_management, fee_demat, fee_other,
             cn_number, external_ref, narration,
             recon_kind, recon_note,
             dedup_status, duplicate_of, include_in_commit,
             created_at`
          )
          .in('broker_file_id', fileIds)
          .order('trade_date', { ascending: true })
          .order('created_at', { ascending: true })
      : { data: [], error: null }

    if (stagedErr) {
      return NextResponse.json(
        { error: `staged_transactions query: ${stagedErr.message}` },
        { status: 500 }
      )
    }

    const staged = (stagedData || []) as any[]

    const by_recon_kind: Record<string, number> = {}
    const by_action: Record<string, number> = {}
    for (const s of staged) {
      by_recon_kind[s.recon_kind] = (by_recon_kind[s.recon_kind] || 0) + 1
      by_action[s.action] = (by_action[s.action] || 0) + 1
    }

    const statementsWithAudit = files.filter(
      (f) => f.file_kind === 'statement' && f.audit_passes !== null
    )
    const allBalanced =
      statementsWithAudit.length === 0 ||
      statementsWithAudit.every((f) => f.audit_passes === true)

    const filesOut = files.map((f) => ({
      id: f.id,
      kind: f.file_kind,
      filename: f.original_filename,
      storage_path: f.storage_path,
      size_bytes: f.size_bytes,
      parse_status: f.parse_status,
      parse_error: f.parse_error,
      account_holder: f.account_holder,
      cscs_number: f.cscs_number,
      period_from: f.period_from,
      period_to: f.period_to,
      audit:
        f.audit_opening !== null ||
        f.audit_closing !== null ||
        f.audit_computed !== null ||
        f.audit_passes !== null
          ? {
              opening: f.audit_opening,
              closing: f.audit_closing,
              computed: f.audit_computed,
              passes: f.audit_passes,
            }
          : null,
      uploaded_by: f.uploaded_by,
      created_at: f.created_at,
      parsed_at: f.parsed_at,
    }))

    // v27p: status derivation accepts the new parse_warning + audit_warning
    // values. Both are non-failure states. parse_failed remains the only
    // value that should block commit.
    const parseStatusSet = new Set(tradeFiles.map((f) => f.parse_status))
    let session_status: 'parsed' | 'committed' | 'rolled_back' | 'parse_failed' | 'mixed'
    if (parseStatusSet.size === 1) {
      const only = Array.from(parseStatusSet)[0]
      if (only === 'parsed') session_status = 'parsed'
      else if (only === 'committed') session_status = 'committed'
      else if (only === 'rolled_back') session_status = 'rolled_back'
      else if (only === 'parse_failed') session_status = 'parse_failed'
      else if (only === 'parse_warning' || only === 'audit_warning') session_status = 'parsed'
      else session_status = 'mixed'
    } else {
      // Mixed set — if it's only the non-failure variants, treat as parsed.
      const allNonFailure = Array.from(parseStatusSet).every(s =>
        s === 'parsed' || s === 'parse_warning' || s === 'audit_warning'
      )
      if (allNonFailure) session_status = 'parsed'
      else session_status = 'mixed'
    }

    // ── v27p: build canonical section ───────────────────────────────
    let canonical: CanonicalSection | null = null

    const canonicalFile = files.find(
      (f) => f.file_kind === 'canonical_positions' && f.parse_status !== 'parse_failed'
    )

    if (canonicalFile && session_status === 'committed') {
      canonical = {
        brokerFileId: canonicalFile.id,
        filename:     canonicalFile.original_filename,
        parsed:       null,
        variance:     null,
        latestMarketPriceDate: null,
        portfolioStartDate:    null,
      }

      try {
        const { data: blob, error: dlErr } = await db.storage
          .from('broker-files')
          .download(canonicalFile.storage_path)

        if (dlErr || !blob) {
          canonical.error = `download: ${dlErr?.message || 'no blob returned'}`
        } else {
          const buf = Buffer.from(await blob.arrayBuffer())
          const aliasMap = await getAliasMap(db)
          const parsed = parseCSCSFile(buf, canonicalFile.original_filename, aliasMap)
          canonical.parsed = parsed

          if (parsed.errors.length > 0 || parsed.rows.length === 0) {
            canonical.error = parsed.errors.length
              ? parsed.errors.join('; ')
              : 'no rows in canonical file'
          } else {
            // Load current portfolio holdings
            const { data: holdings, error: hErr } = await db
              .from('holdings')
              .select('instrument_id, quantity')
              .eq('portfolio_id', portfolioId)
              .gt('quantity', 0)
              .limit(50000)

            if (hErr) {
              canonical.error = `holdings query: ${hErr.message}`
            } else {
              const portfolioPositions: PortfolioPosition[] = (holdings || []).map((h: any) => ({
                instrument_id: h.instrument_id,
                quantity:      Number(h.quantity ?? 0),
              }))

              // v27p: load portfolio.start_date for smart-default anchor
              const { data: portfolioRow } = await db
                .from('portfolios')
                .select('start_date')
                .eq('id', portfolioId)
                .single()
              const portfolioStartDate: string | null = portfolioRow?.start_date ?? null
              canonical.portfolioStartDate = portfolioStartDate

              // v27p: load full price history per ticker (not just latest)
              const allTickers = new Set<string>()
              for (const r of parsed.rows) allTickers.add(r.symbol)
              for (const p of portfolioPositions) allTickers.add(p.instrument_id)
              allTickers.delete('CASH_NGN')

              const tickerList = Array.from(allTickers)

              // v27q-fix4: load via RPC returning jsonb (paired with a Supabase
              // function rewrite from RETURNS TABLE -> RETURNS jsonb). PostgREST's
              // db-max-rows caps RPC TABLE returns just like .from().select() —
              // v27q-fix3's RPC was silently truncating at 1705 rows. jsonb scalar
              // returns aren't subject to the cap. Wire format is identical from
              // Supabase JS's perspective (both surface as Array<row>), so the
              // change here is just a defensive Array.isArray() guard plus the
              // version marker. See pitfall #59 / #92 / new (RPC cap).
              const pricesByTicker: Record<string, PriceEntry[]> = {}
              if (tickerList.length > 0) {
                const { data: prices, error: pErr } = await db
                  .rpc('get_prices_for_tickers', { p_tickers: tickerList })

                if (!pErr && Array.isArray(prices)) {
                  for (const p of prices as Array<{ instrument_id: string; price_date: string; price: number | string | null }>) {
                    const id = p.instrument_id
                    if (!pricesByTicker[id]) pricesByTicker[id] = []
                    pricesByTicker[id].push({
                      date:  p.price_date,
                      price: Number(p.price ?? 0),
                    })
                  }
                }
              }

              // v27p: compute variance with new signature
              const canonicalPositions: CanonicalPosition[] = parsed.rows.map(r => ({
                ticker:       r.symbol,
                units:        r.units,
                closingPrice: r.closingPrice,
                symbolName:   r.symbolName,
              }))

              canonical.variance = computeVariance(
                canonicalPositions,
                portfolioPositions,
                pricesByTicker,
                portfolioStartDate
              )

              // Backward-compat: latestMarketPriceDate (used by legacy paths
              // and as fallback in panel display when a row has no priced dates).
              const { data: maxDateRows } = await db
                .from('market_prices')
                .select('price_date')
                .order('price_date', { ascending: false })
                .limit(1)
              if (maxDateRows && maxDateRows.length > 0) {
                canonical.latestMarketPriceDate = (maxDateRows[0] as any).price_date
              }
            }
          }
        }
      } catch (e: any) {
        canonical.error = `unexpected: ${e.message || 'unknown'}`
      }
    }

    return NextResponse.json({
      session: {
        session_id,
        portfolio,
        upload_time: uploadTime,
        uploaded_by: firstFile.uploaded_by,
        status: session_status,
      },
      files: filesOut,
      staged,
      summary: {
        file_count: files.length,
        staged_count: staged.length,
        by_recon_kind,
        by_action,
        all_balanced: allBalanced,
      },
      canonical,
    })
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'unknown error' },
      { status: 500 }
    )
  }
}
