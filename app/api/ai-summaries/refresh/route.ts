import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// ═══════════════════════════════════════════════════════════════════
// v27bc: AI Financial Summary generator for NGX equities.
// ═══════════════════════════════════════════════════════════════════
//
// Reads fundamentals + valuation + dividend + price data already in
// instruments + market_prices, asks Claude to synthesize a four-part
// discursive analysis (tilt + strength + concern + watch_for), and
// writes the structured JSON back to instruments.ai_summary_json.
//
// Same batch + cron pattern as /api/fundamentals/refresh:
//   • BATCH_SIZE=5 (narrative responses are token-heavy — 300+ words
//     per ticker = ~700-900 output tokens; batch of 5 ≈ 4k tokens)
//   • MAX_INSTRUMENTS_PER_RUN=30
//   • Staleness rotation: oldest summary first, NULLS FIRST
//
// Unlike fundamentals/refresh, this route does NOT need web_search —
// it works exclusively from data already in the database. Faster
// per-batch (~30-45s vs ~60-90s for fundamentals).
//
// Eligibility filter: only equities with profit_after_tax_ngn_m
// populated. Summaries against null fundamentals would be useless.
//
// Output schema (written to ai_summary_json):
//   {
//     tilt:         'bullish' | 'neutral' | 'bearish',
//     tilt_reason:  string (1 sentence),
//     strength:     string (3-4 sentences, ~80-120 words),
//     concern:      string (3-4 sentences, ~80-120 words),
//     watch_for:    string (3-4 sentences, ~80-120 words),
//     confidence:   'high' | 'medium' | 'low',
//     generated_at: ISO timestamp (server-injected)
//   }
//
// Critical prompt discipline: when fundamentals fields are null, the
// model must explicitly note the data gap rather than speculate. This
// matters because the v27bb AI extraction is imperfect — some balance
// sheet fields may be missing even when income statement is complete.
// ═══════════════════════════════════════════════════════════════════

export const maxDuration = 300

const BATCH_SIZE = 5
const MAX_INSTRUMENTS_PER_RUN = 30

interface AISummaryPayload {
  ticker:       string
  tilt:         'bullish' | 'neutral' | 'bearish'
  tilt_reason:  string
  strength:     string
  concern:      string
  watch_for:    string
  confidence:   'high' | 'medium' | 'low'
}

interface InstrumentContext {
  instrument_id:           string
  name:                    string | null
  sector:                  string | null
  current_price:           number | null
  price_date:              string | null
  day_change_pct:          number | null
  shares_outstanding:      number | null
  market_cap_ngn:          number | null
  eps_basic:               number | null
  eps_diluted:             number | null
  book_value_per_share:    number | null
  revenue_ngn_m:           number | null
  gross_profit_ngn_m:      number | null
  operating_profit_ngn_m:  number | null
  profit_before_tax_ngn_m: number | null
  profit_after_tax_ngn_m:  number | null
  total_assets_ngn_m:      number | null
  total_equity_ngn_m:      number | null
  total_debt_ngn_m:        number | null
  roe_pct:                 number | null
  roa_pct:                 number | null
  net_margin_pct:          number | null
  fundamentals_period_type:string | null
  fundamentals_source:     string | null
  fundamentals_notes:      string | null
  div_per_share:           number | null
  div_yield_pct:           number | null
  div_status:              string | null
  div_frequency:           string | null
  pe_ratio:                number | null
  pb_ratio:                number | null
  graham_number:           number | null
  graham_test_passes:      boolean | null
  intrinsic_value_gap_pct: number | null
}

// ─── Helpers ────────────────────────────────────────────────────────

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return isFinite(v) ? v : null
  if (typeof v === 'string') {
    const n = Number(v)
    return isFinite(n) ? n : null
  }
  return null
}

function describeNum(label: string, v: number | null, formatter: (x: number) => string): string {
  if (v === null) return `${label}: NOT REPORTED`
  return `${label}: ${formatter(v)}`
}

function fmtNgnM(v: number): string {
  // v is in millions of naira
  if (v >= 1e6) return `\u20a6${(v / 1e6).toFixed(2)}T`
  if (v >= 1e3) return `\u20a6${(v / 1e3).toFixed(2)}B`
  return `\u20a6${v.toFixed(0)}M`
}

function fmtPct(v: number): string {
  return `${v.toFixed(2)}%`
}

function fmtRatio(v: number): string {
  return `${v.toFixed(2)}\u00d7`
}

function fmtPrice(v: number): string {
  return `\u20a6${v.toFixed(2)}`
}

// Build the per-ticker context string passed to Claude. Lays out all
// known data points; explicitly marks gaps with "NOT REPORTED" so the
// model knows what NOT to speculate about.
function buildContextDescription(ctx: InstrumentContext): string {
  const lines: string[] = []

  lines.push(`Ticker: ${ctx.instrument_id} (${ctx.name ?? '—'})`)
  lines.push(`Sector: ${ctx.sector ?? 'Unclassified'}`)
  lines.push(`Reporting period: ${ctx.fundamentals_period_type ?? 'NOT REPORTED'}`)

  // Price section
  lines.push('')
  lines.push('CURRENT MARKET DATA:')
  lines.push(describeNum('  Current price', ctx.current_price, fmtPrice))
  if (ctx.day_change_pct !== null) {
    lines.push(`  Day change: ${(ctx.day_change_pct * 100).toFixed(2)}%`)
  } else {
    lines.push(`  Day change: NOT REPORTED`)
  }
  lines.push(describeNum('  Market cap', ctx.market_cap_ngn, x => fmtNgnM(x / 1e6)))
  lines.push(describeNum('  Shares outstanding', ctx.shares_outstanding, x => `${(x / 1e9).toFixed(2)}B shares`))

  // Income statement section
  lines.push('')
  lines.push('INCOME STATEMENT:')
  lines.push(describeNum('  Revenue', ctx.revenue_ngn_m, fmtNgnM))
  lines.push(describeNum('  Gross profit', ctx.gross_profit_ngn_m, fmtNgnM))
  lines.push(describeNum('  Operating profit', ctx.operating_profit_ngn_m, fmtNgnM))
  lines.push(describeNum('  PBT', ctx.profit_before_tax_ngn_m, fmtNgnM))
  lines.push(describeNum('  PAT', ctx.profit_after_tax_ngn_m, fmtNgnM))

  // Balance sheet section
  lines.push('')
  lines.push('BALANCE SHEET:')
  lines.push(describeNum('  Total assets', ctx.total_assets_ngn_m, fmtNgnM))
  lines.push(describeNum('  Total equity', ctx.total_equity_ngn_m, fmtNgnM))
  lines.push(describeNum('  Total debt', ctx.total_debt_ngn_m, fmtNgnM))

  // Ratios section
  lines.push('')
  lines.push('PROFITABILITY RATIOS:')
  lines.push(describeNum('  ROE', ctx.roe_pct, fmtPct))
  lines.push(describeNum('  ROA', ctx.roa_pct, fmtPct))
  lines.push(describeNum('  Net margin', ctx.net_margin_pct, fmtPct))

  // Per-share data
  lines.push('')
  lines.push('PER-SHARE METRICS:')
  lines.push(describeNum('  EPS (basic)', ctx.eps_basic, fmtPrice))
  lines.push(describeNum('  EPS (diluted)', ctx.eps_diluted, fmtPrice))
  lines.push(describeNum('  Book value per share', ctx.book_value_per_share, fmtPrice))

  // Valuation
  lines.push('')
  lines.push('VALUATION:')
  lines.push(describeNum('  P/E ratio', ctx.pe_ratio, fmtRatio))
  lines.push(describeNum('  P/B ratio', ctx.pb_ratio, fmtRatio))
  lines.push(describeNum('  Graham Number (intrinsic value)', ctx.graham_number, fmtPrice))
  if (ctx.graham_test_passes !== null) {
    lines.push(`  Graham 22.5 test (P/E × P/B ≤ 22.5): ${ctx.graham_test_passes ? 'PASSES' : 'FAILS'}`)
  } else {
    lines.push(`  Graham 22.5 test: NOT COMPUTABLE`)
  }
  if (ctx.intrinsic_value_gap_pct !== null) {
    const direction = ctx.intrinsic_value_gap_pct > 0 ? 'undervalued' : 'overvalued'
    lines.push(`  Intrinsic value gap: ${(ctx.intrinsic_value_gap_pct * 100).toFixed(2)}% (${direction})`)
  } else {
    lines.push(`  Intrinsic value gap: NOT COMPUTABLE`)
  }

  // Dividend
  lines.push('')
  lines.push('DIVIDEND PROFILE:')
  lines.push(describeNum('  Dividend per share', ctx.div_per_share, fmtPrice))
  lines.push(describeNum('  Dividend yield', ctx.div_yield_pct, fmtPct))
  lines.push(`  Status: ${ctx.div_status ?? 'NOT REPORTED'}`)
  lines.push(`  Frequency: ${ctx.div_frequency ?? 'NOT REPORTED'}`)

  // Provenance
  if (ctx.fundamentals_source || ctx.fundamentals_notes) {
    lines.push('')
    lines.push('DATA PROVENANCE:')
    if (ctx.fundamentals_source) lines.push(`  Source: ${ctx.fundamentals_source}`)
    if (ctx.fundamentals_notes)  lines.push(`  Analyst notes: ${ctx.fundamentals_notes}`)
  }

  return lines.join('\n')
}

// ─── Build the prompt asking for all batch tickers in one call ─────

function buildPrompt(contexts: InstrumentContext[], today: string): string {
  const contextBlocks = contexts
    .map((c, i) => `═══ STOCK ${i + 1} OF ${contexts.length} ═══\n${buildContextDescription(c)}`)
    .join('\n\n')

  return `You are a senior NGX research analyst preparing decision-framing notes for a portfolio CIO managing 10 discretionary mandates worth ~₦773M total. Today is ${today}.

For each stock below, produce a FOUR-PART analysis. Do NOT speculate beyond the data — if a field is marked "NOT REPORTED", you must NOT fabricate or estimate that data. Where critical data is missing, mention the gap explicitly in your analysis.

═══════════════════════════════════════════════════════════════════
DATA FOR EACH STOCK:
═══════════════════════════════════════════════════════════════════

${contextBlocks}

═══════════════════════════════════════════════════════════════════
YOUR TASK:
═══════════════════════════════════════════════════════════════════

For each stock, produce a JSON object with these fields:

1. **tilt**: One of 'bullish', 'neutral', or 'bearish'. Your overall investment-case lean based on the totality of the data.

2. **tilt_reason**: ONE sentence (~15-25 words) summarizing why this tilt. Must reference 1-2 specific numbers from the data.

3. **strength**: 3-4 sentences (~80-120 words) on what's POSITIVE about this investment case. Cite specific numbers from the data (margins, ROE, valuation multiples, dividend yield, etc.). If positives are thin, say so honestly — don't pad. If a sector is highly cyclical or operationally challenged, acknowledge that even within the "strength" framing.

4. **concern**: 3-4 sentences (~80-120 words) on what's NEGATIVE, RISKY, or QUESTIONABLE about the investment case. Cite specific numbers. If debt/equity looks high, say so. If margins are compressing year-over-year (though this single-period snapshot may not show that, you can note "single-period data only — trend not visible"), flag it. If data gaps in fundamentals prevent a full assessment, explicitly note this.

5. **watch_for**: 3-4 sentences (~80-120 words) on what an active operator should monitor going forward. Sector-aware: for banks, mention asset quality / impairments / regulatory; for consumer, mention input costs / pricing power / FX; for oil & gas, mention commodity prices / production; for telecom, mention subscriber growth / spectrum / regulatory. Cite 1-2 specific catalysts when possible (e.g. next interim filing, dividend declaration date, sector tailwind).

6. **confidence**: One of 'high', 'medium', or 'low' — how confident you are in your overall tilt given the data quality and completeness.

═══════════════════════════════════════════════════════════════════
NIGERIAN CONTEXT TO BAKE IN:
═══════════════════════════════════════════════════════════════════

- High interest rate environment (CBN MPR ~27%+) means equity risk premiums are compressed relative to T-bills/bonds. Acknowledge when a stock's yield is competitive (or not) vs. risk-free rate.
- Naira FX volatility affects USD-revenue or USD-cost businesses differently than local-only. Note FX exposure when relevant.
- Banks dominate the index by weight; bank-specific factors (NPLs, capital adequacy, CRR) matter for sector-relative calls.
- Many NGX names trade thin — flag where market cap or daily volume might constrain entry/exit for a ₦5-50M position.
- Inflation context: structurally elevated. Real returns on cash are negative.

═══════════════════════════════════════════════════════════════════
OUTPUT FORMAT:
═══════════════════════════════════════════════════════════════════

Respond with ONLY a JSON array — no preamble, no markdown fences, no commentary. One entry per stock, in the same order as presented above:

[
  {
    "ticker": "<TICKER>",
    "tilt": "bullish" | "neutral" | "bearish",
    "tilt_reason": "<one sentence>",
    "strength": "<3-4 sentences>",
    "concern": "<3-4 sentences>",
    "watch_for": "<3-4 sentences>",
    "confidence": "high" | "medium" | "low"
  }
]

Accuracy and intellectual honesty matter. Operators will be making investment decisions on this analysis. Don't pad weak cases with vague platitudes. Don't fabricate data. Don't pretend missing data is present.`
}

// ─── Single batch call to Anthropic ─────────────────────────────────

async function summariseBatch(
  contexts: InstrumentContext[],
  anthropicKey: string,
): Promise<{ data: AISummaryPayload[]; error?: string }> {
  const today = new Date().toISOString().slice(0, 10)
  const prompt = buildPrompt(contexts, today)

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
    return { data: parsed as AISummaryPayload[] }
  } catch (err) {
    return { data: [], error: `JSON parse failed: ${(err as Error).message}` }
  }
}

// ─── Validation helper ─────────────────────────────────────────────

function shouldSkip(p: AISummaryPayload): string | null {
  if (!p.ticker)                                    return 'no ticker'
  if (!p.tilt || !['bullish','neutral','bearish'].includes(p.tilt)) return 'invalid tilt'
  if (!p.strength || p.strength.length < 50)        return 'strength section too short'
  if (!p.concern || p.concern.length < 50)          return 'concern section too short'
  if (!p.watch_for || p.watch_for.length < 50)      return 'watch_for section too short'
  return null
}

// ─── Main work: build contexts, batch through Claude, write back ───

async function runAISummaryRefresh() {
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (!anthropicKey) {
    return { status: 500, body: { error: 'ANTHROPIC_API_KEY not set' } }
  }

  const db = supabaseAdmin()

  // Count total eligible (equities with PAT populated — proxy for
  // "fundamentals refreshed at least once")
  const { count: totalCount } = await db
    .from('instruments')
    .select('instrument_id', { count: 'exact', head: true })
    .eq('type', 'Stock')
    .eq('approved', true)
    .not('profit_after_tax_ngn_m', 'is', null)

  const totalEligible = totalCount ?? 0

  // Stalest first; only equities with fundamentals data already present
  const { data: instruments, error: instErr } = await db
    .from('instruments')
    .select('instrument_id, name, sector, shares_outstanding, eps_basic, eps_diluted, book_value_per_share, revenue_ngn_m, gross_profit_ngn_m, operating_profit_ngn_m, profit_before_tax_ngn_m, profit_after_tax_ngn_m, total_assets_ngn_m, total_equity_ngn_m, total_debt_ngn_m, roe_pct, roa_pct, net_margin_pct, fundamentals_period_type, fundamentals_source, fundamentals_notes, div_per_share, div_yield_pct, div_status, div_frequency, ai_summary_refreshed_at')
    .eq('type', 'Stock')
    .eq('approved', true)
    .not('profit_after_tax_ngn_m', 'is', null)
    .order('ai_summary_refreshed_at', { ascending: true, nullsFirst: true })
    .order('instrument_id', { ascending: true })
    .limit(MAX_INSTRUMENTS_PER_RUN)

  if (instErr) {
    return { status: 500, body: { error: instErr.message } }
  }

  const equities = (instruments ?? []) as Array<{
    instrument_id: string
    name: string | null
    sector: string | null
    shares_outstanding: number | string | null
    eps_basic: number | string | null
    eps_diluted: number | string | null
    book_value_per_share: number | string | null
    revenue_ngn_m: number | string | null
    gross_profit_ngn_m: number | string | null
    operating_profit_ngn_m: number | string | null
    profit_before_tax_ngn_m: number | string | null
    profit_after_tax_ngn_m: number | string | null
    total_assets_ngn_m: number | string | null
    total_equity_ngn_m: number | string | null
    total_debt_ngn_m: number | string | null
    roe_pct: number | string | null
    roa_pct: number | string | null
    net_margin_pct: number | string | null
    fundamentals_period_type: string | null
    fundamentals_source: string | null
    fundamentals_notes: string | null
    div_per_share: number | string | null
    div_yield_pct: number | string | null
    div_status: string | null
    div_frequency: string | null
  }>

  if (equities.length === 0) {
    return {
      status: 200,
      body: { ok: true, message: 'No eligible equities to summarize (no fundamentals data present yet)', updated: 0 },
    }
  }

  // Fetch most recent price + market cap for each ticker
  const tickerList = equities.map(e => e.instrument_id)
  const { data: priceData } = await db
    .from('market_prices')
    .select('instrument_id, price, price_date')
    .in('instrument_id', tickerList)
    .order('price_date', { ascending: false })

  const priceMap = new Map<string, { current: number; previous: number | null; date: string }>()
  if (priceData) {
    const groups = new Map<string, Array<{ price: number; price_date: string }>>()
    for (const row of priceData as Array<{ instrument_id: string; price: number | string; price_date: string }>) {
      const id = row.instrument_id
      const p = num(row.price)
      if (p === null) continue
      if (!groups.has(id)) groups.set(id, [])
      groups.get(id)!.push({ price: p, price_date: row.price_date })
    }
    for (const [id, rows] of groups) {
      if (rows.length > 0) {
        priceMap.set(id, {
          current: rows[0].price,
          previous: rows.length > 1 ? rows[1].price : null,
          date: rows[0].price_date,
        })
      }
    }
  }

  // Build contexts with computed valuation fields
  const contexts: InstrumentContext[] = equities.map(e => {
    const priceInfo = priceMap.get(e.instrument_id)
    const current_price = priceInfo?.current ?? null
    const previous = priceInfo?.previous ?? null
    const day_change_pct = current_price !== null && previous !== null && previous > 0
      ? (current_price - previous) / previous
      : null

    const sharesOut = num(e.shares_outstanding)
    const market_cap = current_price !== null && sharesOut !== null && sharesOut > 0
      ? current_price * sharesOut
      : null

    const epsBasic   = num(e.eps_basic)
    const epsDiluted = num(e.eps_diluted)
    const bvps       = num(e.book_value_per_share)
    const epsUsed = epsDiluted !== null ? epsDiluted : epsBasic
    const pe = current_price !== null && epsUsed !== null && epsUsed !== 0
      ? current_price / epsUsed
      : null
    const pb = current_price !== null && bvps !== null && bvps > 0
      ? current_price / bvps
      : null
    let graham: number | null = null
    let grahamPasses: boolean | null = null
    let gapPct: number | null = null
    if (epsUsed !== null && epsUsed > 0 && bvps !== null && bvps > 0) {
      graham = Math.sqrt(22.5 * epsUsed * bvps)
      if (current_price !== null && current_price > 0) {
        gapPct = (graham - current_price) / current_price
      }
    }
    if (pe !== null && pe > 0 && pb !== null && pb > 0) {
      grahamPasses = (pe * pb) <= 22.5
    }

    return {
      instrument_id:           e.instrument_id,
      name:                    e.name,
      sector:                  e.sector,
      current_price,
      price_date:              priceInfo?.date ?? null,
      day_change_pct,
      shares_outstanding:      sharesOut,
      market_cap_ngn:          market_cap,
      eps_basic:               epsBasic,
      eps_diluted:             epsDiluted,
      book_value_per_share:    bvps,
      revenue_ngn_m:           num(e.revenue_ngn_m),
      gross_profit_ngn_m:      num(e.gross_profit_ngn_m),
      operating_profit_ngn_m:  num(e.operating_profit_ngn_m),
      profit_before_tax_ngn_m: num(e.profit_before_tax_ngn_m),
      profit_after_tax_ngn_m:  num(e.profit_after_tax_ngn_m),
      total_assets_ngn_m:      num(e.total_assets_ngn_m),
      total_equity_ngn_m:      num(e.total_equity_ngn_m),
      total_debt_ngn_m:        num(e.total_debt_ngn_m),
      roe_pct:                 num(e.roe_pct),
      roa_pct:                 num(e.roa_pct),
      net_margin_pct:          num(e.net_margin_pct),
      fundamentals_period_type:e.fundamentals_period_type,
      fundamentals_source:     e.fundamentals_source,
      fundamentals_notes:      e.fundamentals_notes,
      div_per_share:           num(e.div_per_share),
      div_yield_pct:           num(e.div_yield_pct),
      div_status:              e.div_status,
      div_frequency:           e.div_frequency,
      pe_ratio:                pe,
      pb_ratio:                pb,
      graham_number:           graham,
      graham_test_passes:      grahamPasses,
      intrinsic_value_gap_pct: gapPct,
    }
  })

  // Batch through Claude
  const batches: InstrumentContext[][] = []
  for (let i = 0; i < contexts.length; i += BATCH_SIZE) {
    batches.push(contexts.slice(i, i + BATCH_SIZE))
  }

  const allSummaries: AISummaryPayload[] = []
  const batchErrors: string[] = []

  for (let idx = 0; idx < batches.length; idx++) {
    const batch = batches[idx]
    console.log(`[ai-summaries/refresh] batch ${idx + 1}/${batches.length} (${batch.length} tickers)`)
    const { data, error } = await summariseBatch(batch, anthropicKey)
    if (error) batchErrors.push(`batch ${idx + 1}: ${error}`)
    allSummaries.push(...data)
  }

  // Write back
  const now = new Date().toISOString()
  const updated: string[] = []
  const skipped: Array<{ ticker: string; reason: string }> = []
  const updateErrors: string[] = []

  for (const s of allSummaries) {
    const skipReason = shouldSkip(s)
    if (skipReason) {
      skipped.push({ ticker: s.ticker || '?', reason: skipReason })
      continue
    }

    const payload = {
      tilt:         s.tilt,
      tilt_reason:  s.tilt_reason,
      strength:     s.strength,
      concern:      s.concern,
      watch_for:    s.watch_for,
      confidence:   s.confidence,
      generated_at: now,
    }

    const { error: upErr } = await (db.from('instruments') as any)
      .update({
        ai_summary_json:           payload,
        ai_summary_refreshed_at:   now,
      })
      .eq('instrument_id', s.ticker)

    if (upErr) updateErrors.push(`${s.ticker}: ${upErr.message}`)
    else       updated.push(s.ticker)
  }

  // Coverage stats for response
  const { count: neverSummarizedCount } = await db
    .from('instruments')
    .select('instrument_id', { count: 'exact', head: true })
    .eq('type', 'Stock')
    .eq('approved', true)
    .not('profit_after_tax_ngn_m', 'is', null)
    .is('ai_summary_refreshed_at', null)

  const neverSummarized = neverSummarizedCount ?? 0
  const summary = neverSummarized > 0
    ? `Summarized ${updated.length}/${equities.length} this run. ${skipped.length} skipped. ${neverSummarized} eligible equities still have never been summarized.`
    : `Summarized ${updated.length}/${equities.length} this run. ${skipped.length} skipped. All ${totalEligible} eligible equities have been summarized at least once.`

  return {
    status: 200,
    body: {
      ok:                        true,
      method:                    'ai-narration',
      batches:                   batches.length,
      scopeThisRun:              equities.length,
      totalEligibleEquities:     totalEligible,
      neverSummarized,
      summariesReturned:         allSummaries.length,
      updated,
      skipped,
      batchErrors,
      updateErrors,
      message:                   summary,
    },
  }
}

// ─── POST — triggered by Admin "Refresh now" button ─────────────────

export async function POST(_req: NextRequest) {
  try {
    const result = await runAISummaryRefresh()
    return NextResponse.json(result.body, { status: result.status })
  } catch (err) {
    console.error('[/api/ai-summaries/refresh] fatal:', err)
    return NextResponse.json(
      { error: (err as Error).message || 'Unknown error' },
      { status: 500 }
    )
  }
}

// ─── GET — Vercel Cron (weekly Sunday 14:00 UTC, per vercel.json) ──

export async function GET(req: NextRequest) {
  const expected = `Bearer ${process.env.CRON_SECRET ?? ''}`
  const got      = req.headers.get('authorization') ?? ''
  if (!process.env.CRON_SECRET || got !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const result = await runAISummaryRefresh()
    console.log('[cron /api/ai-summaries/refresh]', JSON.stringify({
      ok:                result.status === 200,
      updated:           (result.body as any).updated?.length ?? 0,
      skipped:           (result.body as any).skipped?.length ?? 0,
      scopeThisRun:      (result.body as any).scopeThisRun,
      totalEligible:     (result.body as any).totalEligibleEquities,
      neverSummarized:   (result.body as any).neverSummarized,
      batchErrorsCount:  (result.body as any).batchErrors?.length ?? 0,
    }))
    return NextResponse.json(result.body, { status: result.status })
  } catch (err) {
    console.error('[cron /api/ai-summaries/refresh] fatal:', err)
    return NextResponse.json(
      { error: (err as Error).message || 'Unknown error' },
      { status: 500 }
    )
  }
}
