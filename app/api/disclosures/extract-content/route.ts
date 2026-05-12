// v27cb-a-fix7h — Per-ticker disclosure + dealing PDF extraction route
//
// Reads up to 25 most-recent disclosures and 15 dealings per ticker, runs each
// through Claude for structured fact extraction, upserts to disclosure_extractions
// and updates dealing columns on instrument_director_dealings.
//
// Eligibility: ticker must be on screened watchlist (section='equity') OR have
// instruments.priority_disclosures = true.
//
// Idempotency:
//   - Disclosure extraction skipped if extraction exists and
//     extracted_at >= instrument_disclosures.modified_at
//   - Dealing extraction skipped if extracted_at IS NOT NULL
//
// Endpoints:
//   POST ?ticker=X     — single-ticker (operator-triggered)
//   POST              — batch mode: 5 stalest eligible tickers
//   GET  ?cron_secret  — cron entry point
//
// maxDuration=800 (13min): 25+15 PDFs × ~10s each = ~7min worst case per ticker.

import { NextRequest, NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { supabaseAdmin } from '@/lib/supabase'
import { extractDisclosure } from '@/lib/ngx-disclosure-extractor'
import { extractDealing } from '@/lib/ngx-dealing-extractor'

export const dynamic = 'force-dynamic'
export const maxDuration = 800
export const runtime = 'nodejs'

const BATCH_SIZE = 5
const MAX_DISCLOSURES_PER_RUN = 25
const MAX_DEALINGS_PER_RUN = 15

interface PerTickerResult {
  ticker: string
  ok: boolean
  eligibility: 'watchlist' | 'priority' | 'skipped_not_eligible'
  disclosures_extracted: number
  disclosures_skipped_scanned: number
  disclosures_failed: number
  disclosures_skipped_idempotent: number
  dealings_extracted: number
  dealings_skipped_scanned: number
  dealings_failed: number
  dealings_skipped_idempotent: number
  total_cost_usd: number
  errors: string[]
}

function client(): Anthropic {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) {
    throw new Error('ANTHROPIC_API_KEY missing from env')
  }
  return new Anthropic({ apiKey: key })
}

async function isEligible(
  db: NonNullable<ReturnType<typeof supabaseAdmin>>,
  ticker: string,
): Promise<'watchlist' | 'priority' | 'skipped_not_eligible'> {
  // Watchlist check (section='equity' AND active=true)
  const { data: wl } = await db
    .from('watchlist')
    .select('ticker')
    .eq('ticker', ticker)
    .eq('section', 'equity')
    .eq('active', true)
    .maybeSingle()
  if (wl) return 'watchlist'

  // Priority flag check
  const { data: inst } = await db
    .from('instruments')
    .select('priority_disclosures')
    .eq('instrument_id', ticker)
    .maybeSingle()
  if (inst && inst.priority_disclosures === true) return 'priority'

  return 'skipped_not_eligible'
}

async function processTicker(
  db: NonNullable<ReturnType<typeof supabaseAdmin>>,
  anth: Anthropic,
  ticker: string,
): Promise<PerTickerResult> {
  const r: PerTickerResult = {
    ticker,
    ok: false,
    eligibility: 'skipped_not_eligible',
    disclosures_extracted: 0,
    disclosures_skipped_scanned: 0,
    disclosures_failed: 0,
    disclosures_skipped_idempotent: 0,
    dealings_extracted: 0,
    dealings_skipped_scanned: 0,
    dealings_failed: 0,
    dealings_skipped_idempotent: 0,
    total_cost_usd: 0,
    errors: [],
  }

  try {
    r.eligibility = await isEligible(db, ticker)
    if (r.eligibility === 'skipped_not_eligible') {
      r.ok = true
      return r
    }

    // ─── Disclosures ───
    const { data: discRows, error: discErr } = await db
      .from('instrument_disclosures')
      .select('id, title, modified_at, pdf_source_url')
      .eq('instrument_id', ticker)
      .order('modified_at', { ascending: false })
      .limit(MAX_DISCLOSURES_PER_RUN)
    if (discErr) {
      r.errors.push(`disclosures select failed: ${discErr.message}`)
    } else if (discRows) {
      // Bulk-fetch existing extractions to determine idempotency
      const discIds = discRows.map((d) => d.id as string)
      const { data: existing } = await db
        .from('disclosure_extractions')
        .select('disclosure_id, extracted_at')
        .in('disclosure_id', discIds)
      const existingMap = new Map<string, string>()
      for (const e of existing ?? []) {
        existingMap.set(String(e.disclosure_id), String(e.extracted_at))
      }

      for (const d of discRows) {
        const pdfUrl = d.pdf_source_url as string | null
        if (!pdfUrl) {
          r.disclosures_failed++
          continue
        }
        const existingAt = existingMap.get(String(d.id))
        if (existingAt && new Date(existingAt) >= new Date(String(d.modified_at))) {
          r.disclosures_skipped_idempotent++
          continue
        }

        const result = await extractDisclosure({
          pdfUrl,
          title: String(d.title ?? ''),
          modifiedAt: String(d.modified_at),
          ticker,
          client: anth,
        })

        r.total_cost_usd += result.cost_estimate_usd

        if (result.status === 'scanned_pdf') {
          r.disclosures_skipped_scanned++
        } else if (result.status === 'extracted') {
          r.disclosures_extracted++
        } else {
          r.disclosures_failed++
          if (result.error) {
            r.errors.push(`disc ${String(d.id).slice(0, 8)}: ${result.error}`)
          }
        }

        // Always upsert (record extraction attempt, even failures, so we don't
        // burn cycles re-attempting a confirmed-bad PDF)
        const upsertRow = {
          disclosure_id: d.id,
          instrument_id: ticker,
          subcategory: result.subcategory ?? 'other',
          extraction_status: result.status,
          facts: result.facts,
          material_event: result.material_event,
          currency: result.currency,
          extracted_at: new Date().toISOString(),
          extraction_notes: result.extraction_notes,
          model_used: result.model_used,
          input_chars: result.input_chars,
          cost_estimate_usd: result.cost_estimate_usd,
        }
        const { error: upErr } = await db
          .from('disclosure_extractions')
          .upsert(upsertRow, { onConflict: 'disclosure_id' })
        if (upErr) {
          r.errors.push(`disc upsert failed for ${String(d.id).slice(0, 8)}: ${upErr.message}`)
        }
      }
    }

    // ─── Director dealings ───
    const { data: dealRows, error: dealErr } = await db
      .from('instrument_director_dealings')
      .select('id, title, modified_at, pdf_source_url, extracted_at')
      .eq('instrument_id', ticker)
      .order('modified_at', { ascending: false })
      .limit(MAX_DEALINGS_PER_RUN)
    if (dealErr) {
      r.errors.push(`dealings select failed: ${dealErr.message}`)
    } else if (dealRows) {
      for (const d of dealRows) {
        const pdfUrl = d.pdf_source_url as string | null
        if (!pdfUrl) {
          r.dealings_failed++
          continue
        }
        if (d.extracted_at) {
          r.dealings_skipped_idempotent++
          continue
        }

        const result = await extractDealing({
          pdfUrl,
          title: String(d.title ?? ''),
          modifiedAt: String(d.modified_at),
          ticker,
          client: anth,
        })

        r.total_cost_usd += result.cost_estimate_usd

        if (result.status === 'scanned_pdf') {
          r.dealings_skipped_scanned++
        } else if (result.status === 'extracted') {
          r.dealings_extracted++
        } else {
          r.dealings_failed++
          if (result.error) {
            r.errors.push(`deal ${String(d.id).slice(0, 8)}: ${result.error}`)
          }
        }

        const updatePayload = {
          insider_name: result.insider_name,
          insider_position: result.insider_position,
          transaction_type: result.transaction_type,
          share_count: result.share_count,
          price_per_share: result.price_per_share,
          total_value: result.total_value,
          currency: result.currency,
          transaction_date: result.transaction_date,
          notification_type: result.notification_type,
          extraction_status: result.status,
          extracted_at: new Date().toISOString(),
          extraction_notes: result.extraction_notes,
        }
        const { error: upErr } = await db
          .from('instrument_director_dealings')
          .update(updatePayload as never)
          .eq('id', d.id)
        if (upErr) {
          r.errors.push(`deal update failed for ${String(d.id).slice(0, 8)}: ${upErr.message}`)
        }
      }
    }

    // Stamp last_extraction_at only on full success
    if (r.errors.length === 0) {
      await db
        .from('instruments')
        .update({ last_extraction_at: new Date().toISOString() } as never)
        .eq('instrument_id', ticker)
    }

    r.ok = r.errors.length === 0
  } catch (e) {
    r.errors.push(e instanceof Error ? e.message : String(e))
  }

  return r
}

function getForceTicker(req: NextRequest): string | undefined {
  const url = new URL(req.url)
  const t = url.searchParams.get('ticker')
  return t ? t.trim().toUpperCase() : undefined
}

async function runExtraction(forceTicker?: string): Promise<{
  ok: boolean
  mode: 'single_ticker' | 'batch'
  tickers_processed: PerTickerResult[]
  total_cost_usd: number
  message: string
}> {
  const db = supabaseAdmin()
  if (!db) {
    return {
      ok: false,
      mode: forceTicker ? 'single_ticker' : 'batch',
      tickers_processed: [],
      total_cost_usd: 0,
      message: 'supabaseAdmin not available',
    }
  }

  let anth: Anthropic
  try {
    anth = client()
  } catch (e) {
    return {
      ok: false,
      mode: forceTicker ? 'single_ticker' : 'batch',
      tickers_processed: [],
      total_cost_usd: 0,
      message: e instanceof Error ? e.message : String(e),
    }
  }

  let tickers: string[] = []
  if (forceTicker) {
    tickers = [forceTicker]
  } else {
    // Batch mode: pick stalest BATCH_SIZE eligible tickers
    // (watchlist + priority_disclosures, ordered by last_extraction_at asc)
    const { data: wlRows } = await db
      .from('watchlist')
      .select('ticker')
      .eq('section', 'equity')
      .eq('active', true)
    const { data: priorityRows } = await db
      .from('instruments')
      .select('instrument_id')
      .eq('priority_disclosures', true)
    const set = new Set<string>()
    for (const w of wlRows ?? []) {
      if (w.ticker) set.add(String(w.ticker))
    }
    for (const p of priorityRows ?? []) {
      if (p.instrument_id) set.add(String(p.instrument_id))
    }
    const eligibleList = Array.from(set)
    if (eligibleList.length > 0) {
      const { data: orderedRows } = await db
        .from('instruments')
        .select('instrument_id, last_extraction_at')
        .in('instrument_id', eligibleList)
        .order('last_extraction_at', { ascending: true, nullsFirst: true })
        .limit(BATCH_SIZE)
      tickers = (orderedRows ?? []).map((r) => String(r.instrument_id))
    }
  }

  const results: PerTickerResult[] = []
  let totalCost = 0
  for (const t of tickers) {
    const r = await processTicker(db, anth, t)
    results.push(r)
    totalCost += r.total_cost_usd
  }

  const allOk = results.every((r) => r.ok)
  const totalExtracted = results.reduce(
    (s, r) => s + r.disclosures_extracted + r.dealings_extracted,
    0,
  )
  return {
    ok: allOk,
    mode: forceTicker ? 'single_ticker' : 'batch',
    tickers_processed: results,
    total_cost_usd: totalCost,
    message: allOk
      ? `Extracted ${totalExtracted} items across ${results.length} ticker(s). Total cost $${totalCost.toFixed(4)}.`
      : `Completed with errors — see per-ticker .errors[]`,
  }
}

export async function POST(req: NextRequest) {
  const forceTicker = getForceTicker(req)
  const result = await runExtraction(forceTicker)
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
  const result = await runExtraction(forceTicker)
  return NextResponse.json(result)
}
