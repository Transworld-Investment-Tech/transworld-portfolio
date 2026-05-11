import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// ═══════════════════════════════════════════════════════════════════
// v27bb: AI-powered fundamentals refresh for NGX equities.
// ═══════════════════════════════════════════════════════════════════
//
// Modeled directly after /api/dividends/refresh and /api/shares-outstanding/
// refresh. Same Anthropic + web_search pattern, same batching, same
// staleness rotation. Pre-flight schema check confirmed all 20 columns
// were already dormant on instruments — this route is the populate
// mechanism. No ALTER TABLE required.
//
// What it extracts per ticker:
//   • Per-share: eps_basic, eps_diluted, book_value_per_share
//   • Income statement (₦M): revenue, gross profit, operating profit, PBT, PAT
//   • Balance sheet (₦M): total assets, total equity, total debt
//   • Ratios (%): ROE, ROA, net margin
//   • Period: end date, period type (FY2024 / H1-2025 / Q1-2026)
//   • Provenance: source, confidence, notes
//
// Sector awareness baked into the prompt:
//   • Banks don't have "gross profit" → AI sets gross_profit_ngn_m to null
//   • For banks, revenue ≈ gross earnings (interest + non-interest income)
//   • For consumer/industrial, conventional revenue → gross → operating → PBT → PAT
//
// Skip-write rules (don't pollute the columns with bogus data):
//   • confidence === 'unknown' → entire row skipped
//   • profit_after_tax_ngn_m is null (no anchor metric) → skipped
//   • book_value_per_share <= 0 → skipped (would break Graham Number)
// ═══════════════════════════════════════════════════════════════════

export const maxDuration = 300

// v27bb: smaller batch than dividends/shares-out (10) because the prompt
// asks for ~20 fields per ticker vs ~7 in dividends and ~5 in shares-out.
// Batches of 5 keep individual API calls under ~3-4k output tokens.
const BATCH_SIZE = 5

// Per-run cap: 6 batches × ~45s = ~270s, safe under the 300s Vercel Pro
// function timeout. Approximately 3 cron runs to cycle through all
// ~68 approved equities.
const MAX_INSTRUMENTS_PER_RUN = 30

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
  FIRSTHOLDCO:'FBN Holdings',
  MTNN:       'MTN Nigeria',
}

interface FundamentalsPayload {
  ticker:                  string

  // Per-share (in ₦, NOT millions)
  epsBasic:                number | null
  epsDiluted:              number | null
  bookValuePerShare:       number | null

  // Income statement (in ₦ millions)
  revenueNgnM:             number | null
  grossProfitNgnM:         number | null
  operatingProfitNgnM:     number | null
  profitBeforeTaxNgnM:     number | null
  profitAfterTaxNgnM:      number | null

  // Balance sheet (in ₦ millions)
  totalAssetsNgnM:         number | null
  totalEquityNgnM:         number | null
  totalDebtNgnM:           number | null

  // Ratios (in percent, e.g. 11.7 means 11.7%)
  roePct:                  number | null
  roaPct:                  number | null
  netMarginPct:            number | null

  // Period
  periodEnd:               string | null     // ISO YYYY-MM-DD
  periodType:              string | null     // 'FY2024' | 'H1-2025' | 'Q1-2026'
  currency:                string | null     // 'NGN' for almost all NGX names

  // Provenance
  source:                  string
  confidence:              'high' | 'medium' | 'low' | 'unknown'
  notes:                   string
}

// ─── Single batch call to Anthropic with web_search enabled ─────────
async function refreshBatch(
  batch: Array<{ instrument_id: string; name: string | null }>,
  anthropicKey: string,
): Promise<{ data: FundamentalsPayload[]; error?: string }> {
  const today = new Date().toISOString().slice(0, 10)
  const tickerList = batch
    .map(i => `- ${i.instrument_id} (${i.name || NGX_TICKER_NAMES[i.instrument_id] || i.instrument_id})`)
    .join('\n')

  const prompt = `You are a Nigerian capital markets research analyst. I need the most recent full-year financial summary for these NGX-listed stocks as of today (${today}).

Stocks to research:
${tickerList}

For each stock, find the MOST RECENT audited or reviewed financial statements. Order of preference:
1. Most recent full fiscal year (FY) audited annual report
2. If FY not yet filed, most recent half-year (H1) interim report
3. If H1 not available, most recent quarterly (Q1/Q3) report

Prefer primary sources: NGX corporate disclosures, the issuer's investor relations page, the audited annual report PDF. Fall back to reputable Nigerian financial media (Nairametrics, Proshare, BusinessDay) when the primary is gated.

CRITICAL SECTOR ADJUSTMENTS:
- BANKS (ACCESSCORP, GTCO, ZENITHBANK, UBA, STANBIC, FIRSTHOLDCO, FCMB, FIDELITYBK, etc.):
  • "Revenue" = Gross Earnings (interest income + non-interest income combined)
  • Banks do NOT have "Gross Profit" — set grossProfitNgnM to null
  • "Operating Profit" = profit before impairment charges and tax (or operating income if reported that way)
- INSURANCE companies:
  • "Revenue" = Gross Premium Written
  • grossProfitNgnM typically null
- All other sectors (consumer, industrial, oil & gas, telecom, etc.):
  • Standard: Revenue → Gross Profit → Operating Profit → PBT → PAT

UNITS — read carefully:
- All ₦M fields are in MILLIONS of naira. If a company reports ₦1,250 billion, that's 1,250,000 in revenueNgnM (1.25 trillion = 1,250,000 million).
- EPS and BVPS are in actual naira (per share), NOT millions. e.g. ₦5.23 EPS = 5.23.
- Percentages: roePct=11.7 means 11.7%, NOT 0.117.

Respond with ONLY a JSON array — no preamble, no markdown fences, no commentary. Each entry must match this exact schema (use null for any field unavailable, but always include the field):

[
  {
    "ticker": "ACCESSCORP",
    "epsBasic": 5.23,
    "epsDiluted": 5.18,
    "bookValuePerShare": 42.50,
    "revenueNgnM": 1250000,
    "grossProfitNgnM": null,
    "operatingProfitNgnM": 380000,
    "profitBeforeTaxNgnM": 320000,
    "profitAfterTaxNgnM": 280000,
    "totalAssetsNgnM": 28000000,
    "totalEquityNgnM": 2400000,
    "totalDebtNgnM": 8000000,
    "roePct": 11.7,
    "roaPct": 1.0,
    "netMarginPct": 22.4,
    "periodEnd": "2024-12-31",
    "periodType": "FY2024",
    "currency": "NGN",
    "source": "FY2024 Audited Annual Report",
    "confidence": "high",
    "notes": "Brief context. Mention any restatements, one-off items, recent corporate actions, or anomalies worth flagging."
  }
]

Field rules:
- epsDiluted: use the diluted EPS where reported; if only basic is available, set epsDiluted equal to epsBasic and note this in 'notes'.
- bookValuePerShare: total_equity / shares_outstanding at period end. If reported directly, use the reported value. If not, compute it.
- periodType: format as 'FY2024' / 'H1-2025' / 'Q1-2026' / 'Q3-2025' etc. Use the period the data covers.
- confidence: "high" = full audited report read directly | "medium" = company press release or single reputable media source | "low" = inferred from multiple secondary sources | "unknown" = could not verify
- Include exactly one entry per ticker even if you have no data for it (set fields to null and confidence to "unknown").
- If any field is impossible to determine, use null — do NOT guess.

Accuracy matters. Operators will be making investment decisions on this data. If you are not confident in a number, set it to null rather than estimating.`

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         anthropicKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      'claude-sonnet-4-20250514',
      max_tokens: 8000,
      tools:      [{ type: 'web_search_20250305', name: 'web_search' }],
      messages:   [{ role: 'user', content: prompt }],
    }),
  })

  if (!res.ok) {
    const errText = await res.text().catch(() => '')
    return { data: [], error: `Anthropic ${res.status}: ${errText.slice(0, 300)}` }
  }

  const d = await res.json()

  const text = (d.content || [])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text as string)
    .join('')

  if (!text) {
    return { data: [], error: 'No text content in Anthropic response' }
  }

  try {
    const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
    const start = clean.indexOf('[')
    const end   = clean.lastIndexOf(']')
    const slice = (start >= 0 && end > start) ? clean.slice(start, end + 1) : clean
    const parsed = JSON.parse(slice)
    if (!Array.isArray(parsed)) {
      return { data: [], error: 'Response JSON was not an array' }
    }
    return { data: parsed as FundamentalsPayload[] }
  } catch (err) {
    return { data: [], error: `JSON parse failed: ${(err as Error).message}` }
  }
}

// ─── Validation helper ───────────────────────────────────────────────
// Skip writes when the data quality threshold isn't met. Returns a
// short reason string when skipped, null when the row passes.
function shouldSkip(p: FundamentalsPayload): string | null {
  if (!p.ticker)                                            return 'no ticker'
  if (p.confidence === 'unknown')                           return 'confidence unknown'
  if (p.profitAfterTaxNgnM === null)                        return 'no PAT anchor'
  // BVPS <= 0 means the company has negative book equity per share —
  // exceptionally rare for a going concern listed on NGX, but if it
  // happens, Graham Number would be NaN (sqrt of negative). Skip cleanly.
  if (p.bookValuePerShare !== null && p.bookValuePerShare <= 0) {
    return 'BVPS <= 0 (would break Graham)'
  }
  return null
}

// ─── Main work: iterate stalest approved equities through batched calls ──
async function runFundamentalsRefresh() {
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (!anthropicKey) {
    return { status: 500, body: { error: 'ANTHROPIC_API_KEY not set' } }
  }

  const db = supabaseAdmin()

  const { count: totalCount, error: countErr } = await db
    .from('instruments')
    .select('instrument_id', { count: 'exact', head: true })
    .eq('type', 'Stock')
    .eq('approved', true)

  if (countErr) {
    return { status: 500, body: { error: countErr.message } }
  }
  const totalApproved = totalCount ?? 0

  const { data: instruments, error: instErr } = await db
    .from('instruments')
    .select('instrument_id, name, fundamentals_last_refreshed_at')
    .eq('type', 'Stock')
    .eq('approved', true)
    .order('fundamentals_last_refreshed_at', { ascending: true, nullsFirst: true })
    .order('instrument_id', { ascending: true })
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

  const batches: Array<typeof equities> = []
  for (let i = 0; i < equities.length; i += BATCH_SIZE) {
    batches.push(equities.slice(i, i + BATCH_SIZE))
  }

  const allFundamentals: FundamentalsPayload[] = []
  const batchErrors: string[] = []

  for (let idx = 0; idx < batches.length; idx++) {
    const batch = batches[idx]
    console.log(`[fundamentals/refresh] batch ${idx + 1}/${batches.length} (${batch.length} tickers)`)
    const { data, error } = await refreshBatch(batch, anthropicKey)
    if (error) batchErrors.push(`batch ${idx + 1}: ${error}`)
    allFundamentals.push(...data)
  }

  const now = new Date().toISOString()
  const updated: string[] = []
  const skipped: Array<{ ticker: string; reason: string }> = []
  const updateErrors: string[] = []

  for (const f of allFundamentals) {
    const skipReason = shouldSkip(f)
    if (skipReason) {
      skipped.push({ ticker: f.ticker || '?', reason: skipReason })
      continue
    }

    const { error: upErr } = await (db.from('instruments') as any)
      .update({
        eps_basic:                       f.epsBasic,
        eps_diluted:                     f.epsDiluted,
        book_value_per_share:            f.bookValuePerShare,
        revenue_ngn_m:                   f.revenueNgnM,
        gross_profit_ngn_m:              f.grossProfitNgnM,
        operating_profit_ngn_m:          f.operatingProfitNgnM,
        profit_before_tax_ngn_m:         f.profitBeforeTaxNgnM,
        profit_after_tax_ngn_m:          f.profitAfterTaxNgnM,
        total_assets_ngn_m:              f.totalAssetsNgnM,
        total_equity_ngn_m:              f.totalEquityNgnM,
        total_debt_ngn_m:                f.totalDebtNgnM,
        roe_pct:                         f.roePct,
        roa_pct:                         f.roaPct,
        net_margin_pct:                  f.netMarginPct,
        fundamentals_period_end:         f.periodEnd,
        fundamentals_period_type:        f.periodType,
        fundamentals_currency:           f.currency,
        fundamentals_source:             f.source,
        fundamentals_notes:              f.notes,
        fundamentals_last_refreshed_at:  now,
      })
      .eq('instrument_id', f.ticker)

    if (upErr) updateErrors.push(`${f.ticker}: ${upErr.message}`)
    else       updated.push(f.ticker)
  }

  const { count: neverRefreshedCount } = await db
    .from('instruments')
    .select('instrument_id', { count: 'exact', head: true })
    .eq('type', 'Stock')
    .eq('approved', true)
    .is('fundamentals_last_refreshed_at', null)

  const neverRefreshed = neverRefreshedCount ?? 0
  const summary = neverRefreshed > 0
    ? `Refreshed ${updated.length}/${equities.length} this run. ${skipped.length} skipped. ${neverRefreshed} approved equities still have never been refreshed.`
    : `Refreshed ${updated.length}/${equities.length} this run. ${skipped.length} skipped. All ${totalApproved} approved equities have been refreshed at least once.`

  return {
    status: 200,
    body: {
      ok:                      true,
      method:                  'ai+web_search',
      batches:                 batches.length,
      scopeThisRun:            equities.length,
      totalApprovedEquities:   totalApproved,
      neverRefreshed,
      fundamentalsEntriesReturned: allFundamentals.length,
      updated,
      skipped,
      batchErrors,
      updateErrors,
      message:                 summary,
      auditTrail:              allFundamentals,
    },
  }
}

// ─── POST — triggered by UI button or manual curl ───────────────────
export async function POST(_req: NextRequest) {
  try {
    const result = await runFundamentalsRefresh()
    return NextResponse.json(result.body, { status: result.status })
  } catch (err) {
    console.error('[/api/fundamentals/refresh] fatal:', err)
    return NextResponse.json(
      { error: (err as Error).message || 'Unknown error' },
      { status: 500 }
    )
  }
}

// ─── GET — Vercel Cron (weekly Sunday 10:00 UTC, per vercel.json) ───
export async function GET(req: NextRequest) {
  const expected = `Bearer ${process.env.CRON_SECRET ?? ''}`
  const got      = req.headers.get('authorization') ?? ''
  if (!process.env.CRON_SECRET || got !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const result = await runFundamentalsRefresh()
    console.log('[cron /api/fundamentals/refresh]', JSON.stringify({
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
    console.error('[cron /api/fundamentals/refresh] fatal:', err)
    return NextResponse.json(
      { error: (err as Error).message || 'Unknown error' },
      { status: 500 }
    )
  }
}
