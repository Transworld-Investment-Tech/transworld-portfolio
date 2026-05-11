import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// ═══════════════════════════════════════════════════════════════════
// v27ba: AI-powered shares outstanding refresh for NGX equities.
// ═══════════════════════════════════════════════════════════════════
//
// Modeled directly after /api/dividends/refresh (live since v19). Same
// Anthropic + web_search pattern, same batching, same staleness rotation.
//
// Why AI/web_search instead of a direct NGX endpoint?
// The NGX REST equities API (/REST/api/statistics/equities/) used by
// our existing price pipeline returns OHLC, volume, value-traded etc.
// but does NOT return shares_outstanding. The NGX per-equity page has
// it, but parsing that is fragile and breaks on layout changes. Claude
// + web_search reads issuer IR pages, NGX corporate filings, audited
// annual reports, and reputable Nigerian financial media (Nairametrics,
// Proshare, BusinessDay) to find authoritative current values.
//
// Corporate actions (rights issues, buybacks) are infrequent enough
// that weekly cron is plenty fresh. Sunday 09:00 UTC ships well after
// the Friday close and before Monday open.
//
// Writes only when confidence is medium/high AND value is positive.
// Low-confidence and unknown returns are SKIPPED — neither the value
// nor the timestamp is updated, so the row cycles back to the top of
// the queue (nulls-first ordering) on the next run.
// ═══════════════════════════════════════════════════════════════════

export const maxDuration = 300

const BATCH_SIZE = 10

// Per-run cap (matches dividends/refresh): 3 batches × ~50s = ~150s,
// safe under the 300s Vercel Pro function timeout. Approximately 2-3
// cron runs to cycle through all ~68 approved equities.
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

interface SharesOutstandingPayload {
  ticker:             string
  sharesOutstanding:  number
  asOfDate:           string | null
  source:             string
  confidence:         'high' | 'medium' | 'low' | 'unknown'
  notes:              string
}

// ─── Single batch call to Anthropic with web_search enabled ─────────
async function refreshBatch(
  batch: Array<{ instrument_id: string; name: string | null }>,
  anthropicKey: string,
): Promise<{ data: SharesOutstandingPayload[]; error?: string }> {
  const today = new Date().toISOString().slice(0, 10)
  const tickerList = batch
    .map(i => `- ${i.instrument_id} (${i.name || NGX_TICKER_NAMES[i.instrument_id] || i.instrument_id})`)
    .join('\n')

  const prompt = `You are a Nigerian capital markets research analyst. I need CURRENT shares outstanding (total issued shares) for these NGX-listed stocks as of today (${today}).

Stocks to research:
${tickerList}

Use web search to find the most recent authoritative shares outstanding count for each. Prefer primary sources in this order:
1. NGX corporate disclosures and bulletins
2. The issuer's investor relations page or most recent audited annual report
3. Reputable Nigerian financial media (Nairametrics, Proshare, BusinessDay, AFX/afx.kwayisi.org)

CRITICAL: Be alert to recent corporate actions. The Nigerian banking sector in particular has been undergoing recapitalisation through 2024-2026, and many banks have completed rights issues that materially changed their share counts. Use the POST-corporate-action figure when applicable. Same for stock splits, bonus issues, or buybacks in any sector.

Respond with ONLY a JSON array — no preamble, no markdown fences, no commentary. Each entry must match this exact schema:

[
  {
    "ticker": "ACCESSCORP",
    "sharesOutstanding": 53499861928,
    "asOfDate": "2025-12-31",
    "source": "NGX Annual Report 2024 / company IR page",
    "confidence": "high",
    "notes": "FY2024 audited count post-recapitalisation rights issue."
  }
]

Field rules:
- sharesOutstanding: integer count of total issued shares (in full units, NOT millions/billions). Use 0 if unknown.
- asOfDate: ISO YYYY-MM-DD of the date the count is verified as of. Use null if unverifiable.
- source: brief plain-text reference (e.g. "NGX Q3 2025 filing", "FY2024 Annual Report"). Use "unknown" if no source.
- confidence: "high" = primary source verified | "medium" = single secondary source | "low" = uncertain | "unknown" = could not verify
- notes: brief context. Mention recent corporate actions, recapitalisation, or any anomaly worth flagging.

Accuracy matters. If you are not reasonably confident, set sharesOutstanding to 0 and confidence to "unknown". Include exactly one entry per ticker I provided, even if you have no data for it.`

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
  //   - server_tool_use         (the model calling web_search)
  //   - web_search_tool_result  (the tool's response)
  //   - text                    (the model's actual answer)
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
    return { data: parsed as SharesOutstandingPayload[] }
  } catch (err) {
    return { data: [], error: `JSON parse failed: ${(err as Error).message}` }
  }
}

// ─── Main work: iterate stalest approved equities through batched calls ──
async function runSharesOutstandingRefresh() {
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (!anthropicKey) {
    return { status: 500, body: { error: 'ANTHROPIC_API_KEY not set' } }
  }

  const db = supabaseAdmin()

  // Count total approved equities — used in the response so callers can
  // see how many are in scope vs how many got processed this run.
  const { count: totalCount, error: countErr } = await db
    .from('instruments')
    .select('instrument_id', { count: 'exact', head: true })
    .eq('type', 'Stock')
    .eq('approved', true)

  if (countErr) {
    return { status: 500, body: { error: countErr.message } }
  }
  const totalApproved = totalCount ?? 0

  // Query the stalest MAX_INSTRUMENTS_PER_RUN. Nulls-first ordering means
  // instruments that have never been refreshed get priority, then least-
  // recently-refreshed. Over successive cron runs everything cycles through.
  const { data: instruments, error: instErr } = await db
    .from('instruments')
    .select('instrument_id, name, shares_outstanding_last_refreshed_at')
    .eq('type', 'Stock')
    .eq('approved', true)
    .order('shares_outstanding_last_refreshed_at', { ascending: true, nullsFirst: true })
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

  // Chunk the run
  const batches: Array<typeof equities> = []
  for (let i = 0; i < equities.length; i += BATCH_SIZE) {
    batches.push(equities.slice(i, i + BATCH_SIZE))
  }

  const allShares: SharesOutstandingPayload[] = []
  const batchErrors: string[] = []

  // Sequential batching. Parallel would trip Anthropic Tier 1 rate limits
  // (30k tokens/min) and each batch also spawns several web_search calls
  // internally which add latency.
  for (let idx = 0; idx < batches.length; idx++) {
    const batch = batches[idx]
    console.log(`[shares-outstanding/refresh] batch ${idx + 1}/${batches.length} (${batch.length} tickers)`)
    const { data, error } = await refreshBatch(batch, anthropicKey)
    if (error) batchErrors.push(`batch ${idx + 1}: ${error}`)
    allShares.push(...data)
  }

  // Update instruments table — skip rows with unknown confidence or 0 shares.
  // For skipped rows the timestamp is NOT updated either, so they stay at
  // the top of the queue on the next run.
  const now = new Date().toISOString()
  const updated: string[] = []
  const skipped: Array<{ ticker: string; reason: string }> = []
  const updateErrors: string[] = []

  for (const s of allShares) {
    if (!s.ticker) continue

    if (s.confidence === 'unknown' || !s.sharesOutstanding || s.sharesOutstanding <= 0) {
      skipped.push({
        ticker: s.ticker,
        reason: s.confidence === 'unknown' ? 'confidence unknown' : 'shares <= 0',
      })
      continue
    }

    const { error: upErr } = await (db.from('instruments') as any)
      .update({
        shares_outstanding: s.sharesOutstanding,
        shares_outstanding_last_refreshed_at: now,
      })
      .eq('instrument_id', s.ticker)

    if (upErr) updateErrors.push(`${s.ticker}: ${upErr.message}`)
    else       updated.push(s.ticker)
  }

  // Post-update count: how many approved equities still have NULL refresh
  // timestamp (= truly untouched).
  const { count: neverRefreshedCount } = await db
    .from('instruments')
    .select('instrument_id', { count: 'exact', head: true })
    .eq('type', 'Stock')
    .eq('approved', true)
    .is('shares_outstanding_last_refreshed_at', null)

  const neverRefreshed = neverRefreshedCount ?? 0
  const summary = neverRefreshed > 0
    ? `Refreshed ${updated.length}/${equities.length} this run. ${skipped.length} skipped (low confidence). ${neverRefreshed} approved equities still have never been refreshed.`
    : `Refreshed ${updated.length}/${equities.length} this run. ${skipped.length} skipped (low confidence). All ${totalApproved} approved equities have been refreshed at least once.`

  return {
    status: 200,
    body: {
      ok:                      true,
      method:                  'ai+web_search',
      batches:                 batches.length,
      scopeThisRun:            equities.length,
      totalApprovedEquities:   totalApproved,
      neverRefreshed,
      sharesEntriesReturned:   allShares.length,
      updated,
      skipped,
      batchErrors,
      updateErrors,
      message:                 summary,
      auditTrail:              allShares,
    },
  }
}

// ─── POST — triggered by UI button or manual curl ───────────────────
export async function POST(_req: NextRequest) {
  try {
    const result = await runSharesOutstandingRefresh()
    return NextResponse.json(result.body, { status: result.status })
  } catch (err) {
    console.error('[/api/shares-outstanding/refresh] fatal:', err)
    return NextResponse.json(
      { error: (err as Error).message || 'Unknown error' },
      { status: 500 }
    )
  }
}

// ─── GET — Vercel Cron (weekly Sunday 09:00 UTC, per vercel.json) ───
export async function GET(req: NextRequest) {
  const expected = `Bearer ${process.env.CRON_SECRET ?? ''}`
  const got      = req.headers.get('authorization') ?? ''
  if (!process.env.CRON_SECRET || got !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const result = await runSharesOutstandingRefresh()
    console.log('[cron /api/shares-outstanding/refresh]', JSON.stringify({
      ok:                  result.status === 200,
      updated:             (result.body as any).updated?.length ?? 0,
      skipped:             (result.body as any).skipped?.length ?? 0,
      scopeThisRun:        (result.body as any).scopeThisRun,
      totalApproved:       (result.body as any).totalApprovedEquities,
      neverRefreshed:      (result.body as any).neverRefreshed,
      batchErrorsCount:    (result.body as any).batchErrors?.length ?? 0,
    }))
    return NextResponse.json(result.body, { status: result.status })
  } catch (err) {
    console.error('[cron /api/shares-outstanding/refresh] fatal:', err)
    return NextResponse.json(
      { error: (err as Error).message || 'Unknown error' },
      { status: 500 }
    )
  }
}
