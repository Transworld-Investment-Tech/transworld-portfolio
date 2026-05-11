// v27ca — Build ISIN registry for NGX equities
//
// One-shot operator action (then idempotent). Iterates over all approved
// equities in `instruments` where `isin` is NULL, queries the NGX SharePoint
// OData feed for each to find their InternationSecIN, and writes back.
//
// Trigger:
//   curl -X POST 'https://transworld-portfolio.vercel.app/api/admin/build-isin-registry'
//
// Output: structured JSON with coverage report — total eligible, updated rows,
// skipped (no OData record found), and errors per ticker.
//
// Throughput: 60 tickers × ~1s per OData call = ~60s. Sequential to avoid
// hammering NGX's SharePoint instance. Under the 60s Vercel function timeout
// by careful design.

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { findIsinForTicker } from '@/lib/ngx-odata'

export const dynamic = 'force-dynamic'
export const maxDuration = 60
export const runtime = 'nodejs'

// Cap per-run to stay safely under 60s. 35 tickers × ~1.2s = 42s budget used.
// Operator can re-run if more tickers remain unmapped.
const MAX_PER_RUN = 35

interface RegistryReport {
  ok: boolean
  total_eligible: number
  total_attempted: number
  updated: Array<{ ticker: string; isin: string }>
  skipped_no_odata_record: string[]
  errors: Array<{ ticker: string; message: string }>
  remaining_unmapped_after_run: number
}

async function runBuildRegistry(forceTicker?: string): Promise<RegistryReport> {
  const db = supabaseAdmin()

  // Eligible: approved stocks without ISIN yet (or all stocks if forceTicker)
  let q = db
    .from('instruments')
    .select('instrument_id')
    .eq('type', 'Stock')
    .eq('approved', true)

  if (forceTicker) {
    q = q.eq('instrument_id', forceTicker)
  } else {
    q = q.is('isin', null).order('instrument_id', { ascending: true }).limit(MAX_PER_RUN)
  }

  const { data: rows, error: selectErr } = await q
  if (selectErr) {
    return {
      ok: false,
      total_eligible: 0,
      total_attempted: 0,
      updated: [],
      skipped_no_odata_record: [],
      errors: [{ ticker: '*', message: `instruments SELECT failed: ${selectErr.message}` }],
      remaining_unmapped_after_run: 0,
    }
  }

  const eligibleTickers = (rows ?? []).map((r) => r.instrument_id as string)

  const updated: Array<{ ticker: string; isin: string }> = []
  const skipped: string[] = []
  const errors: Array<{ ticker: string; message: string }> = []

  for (const ticker of eligibleTickers) {
    try {
      const isin = await findIsinForTicker(ticker)
      if (!isin) {
        skipped.push(ticker)
        continue
      }
      const { error: updErr } = await db
        .from('instruments')
        .update({ isin })
        .eq('instrument_id', ticker)
      if (updErr) {
        errors.push({ ticker, message: `UPDATE failed: ${updErr.message}` })
        continue
      }
      updated.push({ ticker, isin })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      errors.push({ ticker, message: msg })
    }
  }

  // How many remain unmapped after this run?
  const { count: remainingCount } = await db
    .from('instruments')
    .select('instrument_id', { count: 'exact', head: true })
    .eq('type', 'Stock')
    .eq('approved', true)
    .is('isin', null)

  return {
    ok: errors.length === 0,
    total_eligible: eligibleTickers.length,
    total_attempted: eligibleTickers.length,
    updated,
    skipped_no_odata_record: skipped,
    errors,
    remaining_unmapped_after_run: remainingCount ?? 0,
  }
}

function getForceTicker(req: NextRequest): string | undefined {
  const url = new URL(req.url)
  const t = url.searchParams.get('ticker')
  return t ? t.trim().toUpperCase() : undefined
}

export async function POST(req: NextRequest) {
  const forceTicker = getForceTicker(req)
  const report = await runBuildRegistry(forceTicker)
  return NextResponse.json(report)
}

export async function GET(req: NextRequest) {
  // Cron-gated GET path
  const url = new URL(req.url)
  const cronSecret = url.searchParams.get('cron_secret')
  const envSecret = process.env.CRON_SECRET
  const forceTicker = getForceTicker(req)
  if (envSecret && cronSecret !== envSecret && !forceTicker) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const report = await runBuildRegistry(forceTicker)
  return NextResponse.json(report)
}
