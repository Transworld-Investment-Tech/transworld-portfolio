// v27cb-a-fix7f — Instrument disclosures + director dealings refresh route
//
// Pulls metadata for two categories from NGX SharePoint OData feed:
//   1. Disclosures (Corporate Actions + Board Meeting) → instrument_disclosures
//   2. Director Dealings                                → instrument_director_dealings
//
// Up to 25 most-recent of each kind per ticker. No PDF download, no Claude
// extraction — pure metadata + URL storage. Fast: ~500ms-2s per ticker.
//
// Endpoints:
//   POST ?ticker=X     — single-ticker refresh (operator-triggered)
//   POST (no ticker)   — batch mode: stalest BATCH_SIZE tickers
//   GET  ?cron_secret= — cron entry point (uses same CRON_SECRET as fundamentals)
//
// On each per-ticker run:
//   1. fetchAllRecentFilings(isin, 200)
//   2. Filter + cap to 25 disclosures + 25 dealings
//   3. Batch upsert to respective tables (one round-trip per kind)
//   4. Stamp instruments.last_disclosures_refresh_at

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import {
  fetchAllRecentFilings,
  categorizeDisclosure,
  deriveItemId,
} from '@/lib/ngx-disclosures'

export const dynamic = 'force-dynamic'
export const maxDuration = 300
export const runtime = 'nodejs'

const BATCH_SIZE = 10
const MAX_DISCLOSURES_PER_TICKER = 25
const MAX_DEALINGS_PER_TICKER = 25

interface PerTickerResult {
  ticker: string
  isin: string
  ok: boolean
  disclosures_fetched: number
  disclosures_written: number
  dealings_fetched: number
  dealings_written: number
  errors: string[]
}

async function processTicker(ticker: string, isin: string): Promise<PerTickerResult> {
  const db = supabaseAdmin()
  const result: PerTickerResult = {
    ticker,
    isin,
    ok: false,
    disclosures_fetched: 0,
    disclosures_written: 0,
    dealings_fetched: 0,
    dealings_written: 0,
    errors: [],
  }

  try {
    const allFilings = await fetchAllRecentFilings(isin, 200)

    // Filter + cap
    const disclosureItems = allFilings
      .filter((f) => {
        const cat = categorizeDisclosure(f.Type_of_Submission)
        return cat === 'corporate_actions' || cat === 'board_meeting'
      })
      .slice(0, MAX_DISCLOSURES_PER_TICKER)

    const dealingItems = allFilings
      .filter((f) => categorizeDisclosure(f.Type_of_Submission) === 'director_dealings')
      .slice(0, MAX_DEALINGS_PER_TICKER)

    result.disclosures_fetched = disclosureItems.length
    result.dealings_fetched = dealingItems.length

    // Build disclosure rows
    if (disclosureItems.length > 0) {
      const rows = disclosureItems.map((item) => ({
        instrument_id: ticker,
        ngx_item_id: deriveItemId(item),
        title: item.URL?.Description ?? null,
        category: categorizeDisclosure(item.Type_of_Submission),
        raw_type_of_submission: item.Type_of_Submission ?? null,
        pdf_source_url: item.URL?.Url ?? null,
        pdf_filename: item.URL?.Description ?? null,
        modified_at: item.Modified,
      }))
      const { error: discErr, count } = await db
        .from('instrument_disclosures')
        .upsert(rows, { onConflict: 'instrument_id,ngx_item_id', count: 'exact' })
      if (discErr) {
        result.errors.push(`disclosures upsert failed: ${discErr.message}`)
      } else {
        result.disclosures_written = count ?? rows.length
      }
    }

    // Build dealing rows
    if (dealingItems.length > 0) {
      const rows = dealingItems.map((item) => ({
        instrument_id: ticker,
        ngx_item_id: deriveItemId(item),
        title: item.URL?.Description ?? null,
        pdf_source_url: item.URL?.Url ?? null,
        pdf_filename: item.URL?.Description ?? null,
        modified_at: item.Modified,
      }))
      const { error: dealErr, count } = await db
        .from('instrument_director_dealings')
        .upsert(rows, { onConflict: 'instrument_id,ngx_item_id', count: 'exact' })
      if (dealErr) {
        result.errors.push(`dealings upsert failed: ${dealErr.message}`)
      } else {
        result.dealings_written = count ?? rows.length
      }
    }

    // Stamp refresh time — only stamp if we successfully wrote SOMETHING
    if (result.errors.length === 0) {
      await db
        .from('instruments')
        .update({ last_disclosures_refresh_at: new Date().toISOString() })
        .eq('instrument_id', ticker)
    }

    result.ok = result.errors.length === 0
  } catch (e) {
    result.errors.push(e instanceof Error ? e.message : String(e))
  }

  return result
}

async function runRefresh(forceTicker?: string): Promise<{
  ok: boolean
  mode: 'single_ticker' | 'batch'
  tickers_processed: PerTickerResult[]
  total_eligible: number
  remaining_after_run: number
  message: string
}> {
  const db = supabaseAdmin()

  let q = db
    .from('instruments')
    .select('instrument_id, isin')
    .eq('type', 'Stock')
    .eq('approved', true)
    .not('isin', 'is', null)

  if (forceTicker) {
    q = q.eq('instrument_id', forceTicker)
  } else {
    q = q.order('last_disclosures_refresh_at', { ascending: true, nullsFirst: true }).limit(BATCH_SIZE)
  }

  const { data: rows, error: selectErr } = await q
  if (selectErr) {
    return {
      ok: false,
      mode: forceTicker ? 'single_ticker' : 'batch',
      tickers_processed: [],
      total_eligible: 0,
      remaining_after_run: 0,
      message: `instruments SELECT failed: ${selectErr.message}`,
    }
  }

  const eligible = rows ?? []
  const results: PerTickerResult[] = []
  for (const row of eligible) {
    const ticker = row.instrument_id as string
    const isin = row.isin as string
    const r = await processTicker(ticker, isin)
    results.push(r)
  }

  const { count: remainingCount } = await db
    .from('instruments')
    .select('instrument_id', { count: 'exact', head: true })
    .eq('type', 'Stock')
    .eq('approved', true)
    .not('isin', 'is', null)

  const allOk = results.every((r) => r.ok)
  const totalDisc = results.reduce((s, r) => s + r.disclosures_written, 0)
  const totalDeal = results.reduce((s, r) => s + r.dealings_written, 0)
  return {
    ok: allOk,
    mode: forceTicker ? 'single_ticker' : 'batch',
    tickers_processed: results,
    total_eligible: eligible.length,
    remaining_after_run: remainingCount ?? 0,
    message: allOk
      ? `Refreshed ${results.length} ticker(s). ${totalDisc} disclosures + ${totalDeal} dealings written.`
      : `Completed with errors — see per-ticker .errors[]`,
  }
}

function getForceTicker(req: NextRequest): string | undefined {
  const url = new URL(req.url)
  const t = url.searchParams.get('ticker')
  return t ? t.trim().toUpperCase() : undefined
}

export async function POST(req: NextRequest) {
  const forceTicker = getForceTicker(req)
  const result = await runRefresh(forceTicker)
  return NextResponse.json(result)
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const cronSecret = url.searchParams.get('cron_secret')
  const envSecret = process.env.CRON_SECRET
  const forceTicker = getForceTicker(req)
  if (envSecret && cronSecret !== envSecret && !forceTicker) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const result = await runRefresh(forceTicker)
  return NextResponse.json(result)
}
