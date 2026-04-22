import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// v19 rewrite:
//   - DELETED: Apify cheerio scrape path. It was dead code — the AI branch
//     always overwrote its results (`if (aiEstimates.length > 0) dividends = aiEstimates`).
//     And Apify's NGX page structure changes frequently, making parsing fragile.
//   - ADDED: Anthropic web_search tool. The AI now fetches live dividend
//     announcements from NGX corporate filings and Nigerian financial media
//     instead of relying on training-data recall.
//   - ADDED: batch processing. Previously capped at tickers.slice(0, 15) to
//     avoid rate limits, which silently ignored ~28 instruments. Now chunks
//     through every approved equity in groups of 10.
//   - ADDED: div_last_refreshed_at column write (introduced by v19 migration).
//     Lets the UI show a staleness indicator. v20 wires the UI.
//   - ADDED: GET handler protected by CRON_SECRET so Vercel Cron can trigger
//     a weekly refresh without exposing the endpoint publicly.

export const maxDuration = 300

const BATCH_SIZE = 10

// v19b: Vercel Pro caps function execution at 300s. Each batch of 10 tickers
// with web_search takes ~40-60s. Refreshing all ~70 approved equities in one
// run reliably hits the timeout (confirmed: v19 first cron run returned 504
// after timing out mid-batch 6). Cap per-run scope so we always fit under the
// limit, and use the `div_last_refreshed_at` column to cycle through the
// remainder on subsequent runs (nulls-first ordering guarantees fairness).
//
// With MAX_INSTRUMENTS_PER_RUN = 30 and BATCH_SIZE = 10:
//   - 3 batches per run × ~50s = ~150s (well under 300s)
//   - ~70 total equities cycle through in roughly 2-3 weekly cron runs
//   - Instruments that failed a run stay at the top of the queue (nulls-first)
const MAX_INSTRUMENTS_PER_RUN = 30

// Friendly-name fallback for tickers not in the database's `name` field.
// Not authoritative — `instruments.name` wins when present.
const NGX_TICKER_NAMES: Record<string, string> = {
  ACCESSCORP: 'Access Holdings',
  ARADEL:     'Aradel Holdings',
  FCMB:       'FCMB Group',
  NB:         'Nigerian Breweries',
  NESTLE:     'Nestle Nigeria',
  UACN:       'UAC of Nigeria',
  UNILEVER:   'Unilever Nigeria',
  WAPCO:      'Lafarge Africa',
  GTCO:       'Guaranty Trust',
  ZENITHBANK: 'Zenith Bank',
  DANGCEM:    'Dangote Cement',
  SEPLAT:     'Seplat Energy',
  UBA:        'United Bank for Africa',
  STANBIC:    'Stanbic IBTC',
  FBNH:       'FBN Holdings',
  MTNN:       'MTN Nigeria',
}

interface DividendPayload {
  ticker:       string
  divPerShare:  number
  divYieldPct:  number
  divStatus:    string   // 'paying' | 'suspended' | 'none' | 'variable' | 'unknown'
  divFrequency: string   // 'annual' | 'interim' | 'quarterly' | 'unknown'
  lastDivDate:  string | null
  nextDivDate:  string | null
  divNotes:     string
}

// ─── Single batch call to Anthropic with web_search enabled ─────────
async function refreshBatch(
  batch: Array<{ instrument_id: string; name: string | null }>,
  anthropicKey: string,
): Promise<{ data: DividendPayload[]; error?: string }> {
  const today = new Date().toISOString().slice(0, 10)
  const tickerList = batch
    .map(i => `- ${i.instrument_id} (${i.name || NGX_TICKER_NAMES[i.instrument_id] || i.instrument_id})`)
    .join('\n')

  const prompt = `You are a Nigerian capital markets research analyst. I need CURRENT dividend information for these NGX-listed stocks as of today (${today}).

Stocks to research:
${tickerList}

Use web search to find the most recent dividend declaration, DPS, yield, and payment dates for each. Prefer primary sources: NGX corporate disclosures, the issuer's investor relations page, or reputable Nigerian financial media (Nairametrics, Proshare, BusinessDay, CardinalStone, AFX / afx.kwayisi.org).

Respond with ONLY a JSON array — no preamble, no markdown fences, no commentary. Each entry must match this exact schema:

[
  {
    "ticker": "ACCESSCORP",
    "divPerShare": 2.05,
    "divYieldPct": 0.068,
    "divStatus": "paying",
    "divFrequency": "annual",
    "lastDivDate": "2025-07-15",
    "nextDivDate": "2026-07-01",
    "divNotes": "FY2024 final dividend N2.05/share paid July 2025. Interim of N0.80 paid January 2026."
  }
]

Field rules:
- divPerShare: in Naira (e.g. 2.05 means N2.05/share). Use 0 if suspended or unknown.
- divYieldPct: as a decimal (0.068 = 6.8%). Use 0 if unknown.
- divStatus: "paying" | "suspended" | "none" | "variable" | "unknown"
- divFrequency: "annual" | "interim" | "quarterly" | "unknown"
- lastDivDate / nextDivDate: ISO YYYY-MM-DD. Use null if you cannot verify.
- divNotes: brief plain-text context. Mention recapitalisation, policy changes, or anomalies.

Accuracy matters. If you are not reasonably confident, set divStatus to "unknown" and explain in divNotes. Include exactly one entry per ticker I provided, even if you have no data for it.`

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 4000,
      tools:      [{ type: 'web_search_20250305', name: 'web_search' }],
      messages:   [{ role: 'user', content: prompt }],
    }),
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    return { data: [], error: `Anthropic ${res.status}: ${errText.slice(0, 300)}` }
  }

  const d = await res.json()

  // With web_search enabled the content array contains a mix of blocks:
  //   - server_tool_use    (the model calling web_search)
  //   - web_search_tool_result (the tool's response)
  //   - text               (the model's actual answer)
  // We only care about text blocks for the final JSON payload.
  const text = (d.content || [])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text as string)
    .join('')

  if (!text) {
    return { data: [], error: 'No text content in Anthropic response' }
  }

  try {
    // Strip any accidental markdown fences and locate the JSON array.
    const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
    const start = clean.indexOf('[')
    const end   = clean.lastIndexOf(']')
    const slice = (start >= 0 && end > start) ? clean.slice(start, end + 1) : clean
    const parsed = JSON.parse(slice)
    if (!Array.isArray(parsed)) {
      return { data: [], error: 'Response JSON was not an array' }
    }
    return { data: parsed as DividendPayload[] }
  } catch (err) {
    return { data: [], error: `JSON parse failed: ${(err as Error).message}` }
  }
}

// ─── Main work: iterate all equities through batched calls ──────────
async function runDividendRefresh() {
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (!anthropicKey) {
    return { status: 500, body: { error: 'ANTHROPIC_API_KEY not set' } }
  }

  const db = supabaseAdmin()

  // Count total approved equities — used in the response so callers can see
  // how many are in scope vs how many got processed this run.
  const { count: totalCount, error: countErr } = await db
    .from('instruments')
    .select('instrument_id', { count: 'exact', head: true })
    .eq('type', 'Stock')
    .eq('approved', true)

  if (countErr) {
    return { status: 500, body: { error: countErr.message } }
  }
  const totalApproved = totalCount ?? 0

  // v19b: query the stalest MAX_INSTRUMENTS_PER_RUN only.
  //
  //   order by div_last_refreshed_at ASC NULLS FIRST
  //
  // Nulls-first means instruments that have never been refreshed get priority,
  // then we work through the least-recently-refreshed ones. Over successive
  // weekly cron runs, everything cycles through.
  const { data: instruments, error: instErr } = await db
    .from('instruments')
    .select('instrument_id, name, div_last_refreshed_at')
    .eq('type', 'Stock')
    .eq('approved', true)
    .order('div_last_refreshed_at', { ascending: true, nullsFirst: true })
    .order('instrument_id', { ascending: true })  // stable tiebreaker
    .limit(MAX_INSTRUMENTS_PER_RUN)

  if (instErr) {
    return { status: 500, body: { error: instErr.message } }
  }

  const equities = (instruments || []) as Array<{ instrument_id: string; name: string | null }>
  if (equities.length === 0) {
    return {
      status: 200,
      body: { ok: true, message: 'No approved equity instruments to refresh', updated: 0 },
    }
  }

  // Chunk the full list
  const batches: Array<typeof equities> = []
  for (let i = 0; i < equities.length; i += BATCH_SIZE) {
    batches.push(equities.slice(i, i + BATCH_SIZE))
  }

  const allDividends: DividendPayload[] = []
  const batchErrors: string[] = []

  // Sequential batching. Parallel would trip Anthropic Tier 1 rate limits
  // (30k tokens/min), and each batch also spawns several web_search calls
  // internally which add latency and token pressure.
  for (let idx = 0; idx < batches.length; idx++) {
    const batch = batches[idx]
    console.log(`[dividends/refresh] batch ${idx + 1}/${batches.length} (${batch.length} tickers)`)
    const { data, error } = await refreshBatch(batch, anthropicKey)
    if (error) batchErrors.push(`batch ${idx + 1}: ${error}`)
    allDividends.push(...data)
  }

  // Update instruments table with what came back
  const now = new Date().toISOString()
  const updated: string[] = []
  const updateErrors: string[] = []

  for (const div of allDividends) {
    if (!div.ticker) continue

    const updateData: any = {
      div_per_share: typeof div.divPerShare === 'number' ? div.divPerShare : 0,
      div_yield_pct: typeof div.divYieldPct === 'number' ? div.divYieldPct : 0,
      div_status:    div.divStatus    || 'unknown',
      div_frequency: div.divFrequency || 'annual',
      div_notes:     div.divNotes     || 'Refreshed via AI + web_search',
      div_last_refreshed_at: now,
    }
    if (div.lastDivDate) updateData.last_div_date = div.lastDivDate
    if (div.nextDivDate) updateData.next_div_date = div.nextDivDate

    const { error: upErr } = await (db.from('instruments') as any)
      .update(updateData)
      .eq('instrument_id', div.ticker)

    if (upErr) updateErrors.push(`${div.ticker}: ${upErr.message}`)
    else       updated.push(div.ticker)
  }

  const remaining = Math.max(0, totalApproved - updated.length)
  const summary = totalApproved > MAX_INSTRUMENTS_PER_RUN
    ? `Refreshed ${updated.length}/${equities.length} processed this run (${totalApproved} approved equities total; ${remaining} pending future runs)`
    : `Refreshed ${updated.length}/${equities.length} approved equities`

  return {
    status: 200,
    body: {
      ok:                      true,
      method:                  'ai+web_search',
      batches:                 batches.length,
      scopeThisRun:            equities.length,
      totalApprovedEquities:   totalApproved,
      remaining,
      dividendEntriesReturned: allDividends.length,
      updated,
      batchErrors,
      updateErrors,
      message:                 summary,
    },
  }
}

// ─── POST — triggered by UI button ──────────────────────────────────
export async function POST(_req: NextRequest) {
  try {
    const result = await runDividendRefresh()
    return NextResponse.json(result.body, { status: result.status })
  } catch (err) {
    console.error('[/api/dividends/refresh] fatal:', err)
    return NextResponse.json(
      { error: (err as Error).message || 'Unknown error' },
      { status: 500 }
    )
  }
}

// ─── GET — Vercel Cron (weekly Sunday 08:00 UTC, per vercel.json) ───
export async function GET(req: NextRequest) {
  const expected = `Bearer ${process.env.CRON_SECRET ?? ''}`
  const got      = req.headers.get('authorization') ?? ''
  if (!process.env.CRON_SECRET || got !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const result = await runDividendRefresh()
    console.log('[cron /api/dividends/refresh]', JSON.stringify({
      ok:                  result.status === 200,
      updated:             (result.body as any).updated?.length ?? 0,
      scopeThisRun:        (result.body as any).scopeThisRun,
      totalApproved:       (result.body as any).totalApprovedEquities,
      remaining:           (result.body as any).remaining,
      batchErrorsCount:    (result.body as any).batchErrors?.length ?? 0,
    }))
    return NextResponse.json(result.body, { status: result.status })
  } catch (err) {
    console.error('[cron /api/dividends/refresh] fatal:', err)
    return NextResponse.json(
      { error: (err as Error).message || 'Unknown error' },
      { status: 500 }
    )
  }
}
