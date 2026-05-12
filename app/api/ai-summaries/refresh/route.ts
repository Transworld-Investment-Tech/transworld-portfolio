// ═══════════════════════════════════════════════════════════════
// /api/ai-summaries/refresh (v27cb-a-fix7g-fix2)
// ═══════════════════════════════════════════════════════════════
//
// Full rewrite of the AI Financial Summary engine. Replaces the
// v27bc batched-5-per-call engine with a per-ticker engine that:
//
//   • Pulls 5-6 periods of fundamentals_history (annual preferred,
//     quarterly as supplement)
//   • Pulls latest 15 disclosures + 10 director dealings
//   • Includes current price + movement deltas + dividend snapshot
//   • Enables Anthropic web_search tool for sentiment context
//   • Explicit prompt instruction: "structured data is source of
//     truth; web is for sentiment / narrative only"
//   • Returns same schema (tilt/tilt_reason/strength/concern/
//     watch_for/confidence) PLUS new dividend_narration field
//   • dividend_narration flows into instruments.div_notes
//
// Endpoints:
//   • POST /api/ai-summaries/refresh                  — cron mode,
//       batches MAX_INSTRUMENTS_PER_RUN stalest tickers
//   • POST /api/ai-summaries/refresh?ticker=MTNN      — single-
//       ticker mode (used by per-instrument page refresh button)
//   • GET  /api/ai-summaries/refresh                  — vercel
//       cron variant (auth via CRON_SECRET, same as POST behaviour)
//
// Cost characteristics:
//   • ~$0.20-0.30 per ticker (5-7k input + 1-2k output tokens
//     + ~3 web_search calls at $0.005-0.01 each)
//   • Full 33-ticker refresh: ~$8-10
//   • Cron at MAX_INSTRUMENTS_PER_RUN=10, weekly: ~$2-3/week,
//     rotates through 33 in ~4 weeks (stalest first)
// ═══════════════════════════════════════════════════════════════

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic    = 'force-dynamic'
export const maxDuration = 800   // Vercel Pro allows up to 800s

// ─── Constants ──────────────────────────────────────────────────

const MAX_INSTRUMENTS_PER_RUN = 10
const MAX_PERIODS_IN_PROMPT   = 6
const MAX_DISCLOSURES         = 15
const MAX_DEALINGS            = 10
const ANTHROPIC_MODEL         = 'claude-sonnet-4-20250514'
const ANTHROPIC_MAX_TOKENS    = 8000

// ─── Types ──────────────────────────────────────────────────────

type FundRow = {
  period_end:                   string
  period_type:                  'annual' | 'quarterly'
  verified_status:              'unverified' | 'verified' | 'flagged'
  revenue_ngn_m:                number | string | null
  gross_profit_ngn_m:           number | string | null
  operating_profit_ngn_m:       number | string | null
  profit_before_tax_ngn_m:      number | string | null
  profit_after_tax_ngn_m:       number | string | null
  eps_basic:                    number | string | null
  eps_diluted:                  number | string | null
  total_assets_ngn_m:           number | string | null
  total_equity_ngn_m:           number | string | null
  total_debt_ngn_m:             number | string | null
  cash_and_equivalents_ngn_m:   number | string | null
  cash_from_operations_ngn_m:   number | string | null
  shares_outstanding:           number | string | null
  source:                       string | null
}

type DiscRow = {
  category:    string
  title:       string | null
  modified_at: string
}

type DealRow = {
  title:       string | null
  modified_at: string
}

type PriceRow = {
  price:      number | string | null
  price_date: string
}

type InstRow = {
  instrument_id:              string
  name:                       string
  sector:                     string | null
  sleeve_id:                  string | null
  div_per_share:              number | null
  div_yield_pct:              number | null
  div_frequency:              string | null
  div_status:                 string | null
  last_div_date:              string | null
  next_div_date:              string | null
  ai_summary_refreshed_at:    string | null
}

type SummaryShape = {
  tilt:                'bullish' | 'neutral' | 'bearish'
  tilt_reason:         string
  strength:            string
  concern:             string
  watch_for:           string
  confidence:          'high' | 'medium' | 'low'
  dividend_narration?: string | null
}

type ProcessResult = {
  ticker:    string
  ok:        boolean
  reason?:   string
  tilt?:     string
  cost_estimate_usd?: number
}

// ─── Helpers ────────────────────────────────────────────────────

function client() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
            ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) return null
  return createClient(url, key)
}

function num(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return isFinite(v) ? v : null
  if (typeof v === 'string') {
    if (v.trim() === '') return null
    const n = Number(v)
    return isFinite(n) ? n : null
  }
  return null
}

function fmtNgnM(v: number | null | undefined): string {
  if (v === null || v === undefined || !isFinite(v)) return '—'
  if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(2) + 'T'
  if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(2) + 'B'
  if (Math.abs(v) >= 1)   return v.toFixed(0) + 'M'
  return (v * 1e3).toFixed(0) + 'K'
}

function fmtPct(v: number | null | undefined, dp = 1): string {
  if (v === null || v === undefined || !isFinite(v)) return '—'
  return v.toFixed(dp) + '%'
}

function fmtEps(v: number | null | undefined): string {
  if (v === null || v === undefined || !isFinite(v)) return '—'
  return '\u20a6' + v.toFixed(2)
}

// Derive ratios live from raw row data
function deriveRatios(row: FundRow): { roe_pct: number | null; roa_pct: number | null; net_margin_pct: number | null } {
  const pat     = num(row.profit_after_tax_ngn_m)
  const equity  = num(row.total_equity_ngn_m)
  const assets  = num(row.total_assets_ngn_m)
  const revenue = num(row.revenue_ngn_m)
  return {
    roe_pct:        (pat !== null && equity  !== null && equity  > 0) ? (pat / equity)  * 100 : null,
    roa_pct:        (pat !== null && assets  !== null && assets  > 0) ? (pat / assets)  * 100 : null,
    net_margin_pct: (pat !== null && revenue !== null && revenue > 0) ? (pat / revenue) * 100 : null,
  }
}

// Build the prompt text from gathered context
function buildPrompt(
  inst:           InstRow,
  fundRows:       FundRow[],
  discRows:       DiscRow[],
  dealRows:       DealRow[],
  prices:         PriceRow[],
  todayISO:       string,
): string {
  const currentPrice = prices.length > 0 ? num(prices[0].price) : null
  const priceDate    = prices.length > 0 ? prices[0].price_date : null

  // Movement deltas
  function findLookbackPrice(daysBack: number): number | null {
    if (prices.length === 0) return null
    const today = prices[0].price_date
    const target = new Date(today + 'T00:00:00')
    target.setDate(target.getDate() - daysBack)
    const targetIso = target.toISOString().slice(0, 10)
    for (const p of prices) {
      if (p.price_date <= targetIso && p.price_date !== today) {
        return num(p.price)
      }
    }
    return null
  }

  const dayPrev    = prices.length > 1 ? num(prices[1].price) : null
  const weekPrev   = findLookbackPrice(7)
  const monthPrev  = findLookbackPrice(30)
  const quarterPrev = findLookbackPrice(90)

  const pct = (now: number | null, then: number | null): string => {
    if (now === null || then === null || then <= 0) return '—'
    const v = (now - then) / then
    return (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + '%'
  }

  // Fundamentals table (most recent at top)
  const fundamentalsTable = fundRows.slice(0, MAX_PERIODS_IN_PROMPT).map(r => {
    const ratios = deriveRatios(r)
    const epsD = num(r.eps_diluted)
    const epsB = num(r.eps_basic)
    const eps = epsD !== null ? epsD : epsB
    return `  ${r.period_end} ${r.period_type === 'annual' ? '(FY)' : '(Q)'} ${r.verified_status === 'verified' ? '✓' : r.verified_status === 'flagged' ? '⚠' : ' '}: `
      + `rev=${fmtNgnM(num(r.revenue_ngn_m))} PAT=${fmtNgnM(num(r.profit_after_tax_ngn_m))} `
      + `assets=${fmtNgnM(num(r.total_assets_ngn_m))} equity=${fmtNgnM(num(r.total_equity_ngn_m))} `
      + `debt=${fmtNgnM(num(r.total_debt_ngn_m))} cash=${fmtNgnM(num(r.cash_and_equivalents_ngn_m))} `
      + `CFO=${fmtNgnM(num(r.cash_from_operations_ngn_m))} EPS=${fmtEps(eps)} `
      + `ROE=${fmtPct(ratios.roe_pct)} NM=${fmtPct(ratios.net_margin_pct)}`
  }).join('\n')

  // Calculate EPS CAGR for context
  const annuals = fundRows.filter(r => r.period_type === 'annual')
  const pickEps = (r: FundRow): number | null => {
    const d = num(r.eps_diluted)
    if (d !== null) return d
    return num(r.eps_basic)
  }
  let cagr3yr: string = '—'
  let cagr5yr: string = '—'
  let cagrWarning: string = ''
  if (annuals.length >= 4) {
    const latest = pickEps(annuals[0])
    const start  = pickEps(annuals[3])
    if (latest !== null && start !== null && latest > 0 && start > 0) {
      const c = (Math.pow(latest / start, 1/3) - 1) * 100
      cagr3yr = (c >= 0 ? '+' : '') + c.toFixed(1) + '%'
    }
  }
  if (annuals.length >= 6) {
    const latest = pickEps(annuals[0])
    const start  = pickEps(annuals[5])
    if (latest !== null && start !== null && latest > 0 && start > 0) {
      const c = (Math.pow(latest / start, 1/5) - 1) * 100
      cagr5yr = (c >= 0 ? '+' : '') + c.toFixed(1) + '%'
    }
    if (annuals[5].period_end < '2023-06-01' && annuals[0].period_end >= '2023-06-01') {
      cagrWarning = ' [5yr straddles NGN unification — FX-distorted]'
    }
  }

  // Disclosures list
  const disclosuresList = discRows.slice(0, MAX_DISCLOSURES).map(d => {
    const dateOnly = d.modified_at ? d.modified_at.slice(0, 10) : ''
    const cat = d.category === 'corporate_actions' ? 'CA'
              : d.category === 'board_meeting'    ? 'BM'
              : d.category
    return `  ${dateOnly} [${cat}] ${d.title ?? '(untitled)'}`
  }).join('\n')

  // Dealings list
  const dealingsList = dealRows.slice(0, MAX_DEALINGS).map(d => {
    const dateOnly = d.modified_at ? d.modified_at.slice(0, 10) : ''
    return `  ${dateOnly}: ${d.title ?? '(untitled)'}`
  }).join('\n')

  // Latest period for valuation
  const latestFund = fundRows[0] ?? null
  const latestEpsD = latestFund ? num(latestFund.eps_diluted) : null
  const latestEpsB = latestFund ? num(latestFund.eps_basic)   : null
  const latestEps  = latestEpsD !== null ? latestEpsD : latestEpsB
  const peRatio    = (currentPrice !== null && latestEps !== null && latestEps > 0)
                       ? currentPrice / latestEps
                       : null

  // Dividend block
  const divLine = inst.div_status && inst.div_status !== 'unknown' && inst.div_status !== 'none'
    ? `DPS ₦${(inst.div_per_share ?? 0).toFixed(2)}, yield ${((inst.div_yield_pct ?? 0) * 100).toFixed(2)}%, ${inst.div_frequency ?? 'unknown frequency'}, status: ${inst.div_status}, last paid ${inst.last_div_date ?? '—'}, next ${inst.next_div_date ?? '—'}`
    : 'No active dividend program reported.'

  return `You are a senior NGX equity research analyst preparing decision-framing notes for the CIO of Transworld Investment & Securities, a discretionary portfolio management firm managing approximately ₦780M across 10 mandates. Your output is read by a working CIO immediately before allocation, rotation, or position-sizing decisions.

Today: ${todayISO}
Ticker: ${inst.instrument_id}
Company: ${inst.name}
Sector: ${inst.sector ?? 'Unclassified'}

═══════════════════════════════════════════════════════════════
STRUCTURED DATA (SOURCE OF TRUTH)
═══════════════════════════════════════════════════════════════

This data was extracted from primary NGX filings via the firm's
verified-fundamentals pipeline. Treat it as authoritative. Do NOT
override these numbers with web-sourced figures.

CURRENT MARKET DATA
  Price:     ${currentPrice !== null ? '\u20a6' + currentPrice.toFixed(2) : '—'}${priceDate ? ' (as of ' + priceDate + ')' : ''}
  Day:       ${pct(currentPrice, dayPrev)}
  Week:      ${pct(currentPrice, weekPrev)}
  Month:     ${pct(currentPrice, monthPrev)}
  Quarter:   ${pct(currentPrice, quarterPrev)}
  P/E:       ${peRatio !== null ? peRatio.toFixed(1) + '×' : 'N/M (loss or no EPS)'}
  EPS CAGR:  3yr ${cagr3yr}, 5yr ${cagr5yr}${cagrWarning}

FUNDAMENTALS HISTORY (${fundRows.length} periods, most recent first)
  Legend: rev/PAT/assets/equity/debt/cash/CFO in NGN; EPS in ₦/share; ROE & NM as %
  Verification: ✓ = verified, ⚠ = flagged, (blank) = unverified

${fundamentalsTable || '  (No fundamentals_history on file)'}

DIVIDEND PROFILE
  ${divLine}

RECENT CORPORATE DISCLOSURES (latest ${discRows.length})
  Format: date [category] title (CA = Corporate Actions, BM = Board Meeting)

${disclosuresList || '  (No disclosures on file)'}

INSIDER DEALINGS (latest ${dealRows.length})

${dealingsList || '  (No director dealings on file)'}

═══════════════════════════════════════════════════════════════
WEB CONTEXT (SUPPLEMENTARY)
═══════════════════════════════════════════════════════════════

USE the web_search tool to gather additional context before
writing. Focus your searches on:

  1. Analyst sentiment / commentary from:
     - proshare.com.ng
     - africanfinancials.com
     - nairametrics.com
     - simplywall.st
     - tradingview.com
     - businessday.ng
  2. Recent news (last 90 days) about ${inst.instrument_id} or ${inst.name}
  3. Sector dynamics relevant to ${inst.sector ?? 'this name'} in Nigeria
  4. Macro/regulatory context affecting this position

Suggested initial searches:
  - "${inst.instrument_id} NGX ${new Date(todayISO).getFullYear()}"
  - "${inst.name} earnings analysis"
  - "${inst.sector ?? ''} Nigeria outlook ${new Date(todayISO).getFullYear()}"

CRITICAL RULES:
  • Structured data above is the SOURCE OF TRUTH for numbers.
  • Use web_search for context, sentiment, news narrative — not for
    overriding the verified fundamentals above.
  • If web sources contradict the structured data, trust the
    structured data and call out the discrepancy.

═══════════════════════════════════════════════════════════════
NIGERIAN CONTEXT (UNCHANGING)
═══════════════════════════════════════════════════════════════

  • CBN MPR currently elevated (27%+); risk-free yields compress
    equity valuations. Cash earns more than most dividends.
  • NGN unification June 2023 caused massive FX-translation effects.
    Pre-2023 NGN financials are not directly comparable to post-2023.
    EPS growth straddling this date often reflects naira devaluation,
    not real earnings expansion. Be skeptical of headline CAGRs.
  • Banks dominate the NGX-30 by weight; bank-specific factors
    (NPL ratios, capital adequacy, regulatory recapitalisation,
    cash reserve ratio) carry outsized index influence.
  • Inflation structurally elevated; real returns on cash negative.
  • Many NGX names are thin-traded relative to our typical position
    size (₦10-50M). Flag liquidity constraints where relevant.

═══════════════════════════════════════════════════════════════
YOUR TASK
═══════════════════════════════════════════════════════════════

Produce a JSON object with these fields. EVERY field is required.

{
  "tilt": "bullish" | "neutral" | "bearish",
    // Your directional view based on the data + web context.

  "tilt_reason": string,
    // ONE sentence (15-25 words). Lead with the most important
    // specific number. Should justify the tilt by itself.

  "strength": string,
    // 3-4 sentences (80-120 words). Cite specific numbers from the
    // fundamentals table. Note sector-specific positives. Reference
    // disclosures or dealings that support the bull case.

  "concern": string,
    // 3-4 sentences (80-120 words). Cite specific numbers and
    // risks. Note macroeconomic, sectoral, or company-specific
    // risks. Reference disclosures or dealings that indicate risk.

  "watch_for": string,
    // 3-4 sentences (80-120 words). Sector-aware monitoring items,
    // upcoming events (Board Meetings if disclosed, expected
    // earnings dates), and what would shift your tilt. Include
    // specific levels/dates where possible.

  "confidence": "high" | "medium" | "low",
    // Your confidence in the tilt based on data completeness,
    // verification status, and web-context clarity.

  "dividend_narration": string | null
    // 2-3 sentences (40-80 words) describing the dividend profile
    // in context. Cover: yield vs Nigerian risk-free rate context,
    // recent dividend disclosures, frequency / consistency,
    // forward expectations. Return null ONLY if no dividend data.
}

═══════════════════════════════════════════════════════════════
OUTPUT FORMAT
═══════════════════════════════════════════════════════════════

Respond ONLY with the JSON object — no preamble, no markdown
backticks, no commentary. Start with { and end with }.`
}

// Call Anthropic with web_search tool, return parsed JSON
type AnthropicResp = {
  content?: Array<{
    type: string
    text?: string
    name?: string
    input?: unknown
    content?: unknown
  }>
  usage?: {
    input_tokens?:  number
    output_tokens?: number
  }
}

async function callAnthropic(prompt: string): Promise<{
  text:        string
  searchCount: number
  inTokens:    number
  outTokens:   number
}> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY missing')

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type':      'application/json',
      'x-api-key':         apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model:      ANTHROPIC_MODEL,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      messages:   [{ role: 'user', content: prompt }],
      tools: [
        {
          type: 'web_search_20250305',
          name: 'web_search',
        },
      ],
    }),
  })

  if (!resp.ok) {
    const errText = await resp.text()
    throw new Error(`Anthropic API ${resp.status}: ${errText.slice(0, 500)}`)
  }

  const d = await resp.json() as AnthropicResp

  // Count web searches issued. Server-side tool blocks are
  // 'server_tool_use' for the call and 'web_search_tool_result'
  // for the result; defensively count both possible block types.
  let searchCount = 0
  if (Array.isArray(d.content)) {
    for (const b of d.content) {
      if (b.type === 'server_tool_use' && b.name === 'web_search') searchCount += 1
      if (b.type === 'tool_use'        && b.name === 'web_search') searchCount += 1
    }
  }

  // Concatenate all text blocks (model's reasoning interleaves
  // tool calls but final answer is in text blocks).
  const text = (d.content ?? [])
    .filter(b => b.type === 'text' && typeof b.text === 'string')
    .map(b => b.text as string)
    .join('')

  return {
    text,
    searchCount,
    inTokens:  d.usage?.input_tokens  ?? 0,
    outTokens: d.usage?.output_tokens ?? 0,
  }
}

function extractJson(raw: string): unknown | null {
  if (!raw || !raw.trim()) return null
  // Strip markdown backticks if model still slipped them in
  let s = raw.trim()
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '')
  // Find first { and last } and parse the substring
  const first = s.indexOf('{')
  const last  = s.lastIndexOf('}')
  if (first === -1 || last === -1 || last < first) return null
  try {
    return JSON.parse(s.slice(first, last + 1))
  } catch {
    return null
  }
}

function validateSummary(raw: unknown): SummaryShape | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.tilt !== 'string' || !['bullish','neutral','bearish'].includes(r.tilt)) return null
  if (typeof r.tilt_reason !== 'string' || r.tilt_reason.length < 5) return null
  if (typeof r.strength    !== 'string' || r.strength.length    < 10) return null
  if (typeof r.concern     !== 'string' || r.concern.length     < 10) return null
  if (typeof r.watch_for   !== 'string' || r.watch_for.length   < 10) return null
  if (typeof r.confidence  !== 'string' || !['high','medium','low'].includes(r.confidence)) return null
  // dividend_narration is optional/nullable
  let divNarration: string | null = null
  if (r.dividend_narration !== undefined && r.dividend_narration !== null) {
    if (typeof r.dividend_narration !== 'string') return null
    divNarration = r.dividend_narration.length >= 10 ? r.dividend_narration : null
  }
  return {
    tilt:                r.tilt as 'bullish' | 'neutral' | 'bearish',
    tilt_reason:         r.tilt_reason,
    strength:            r.strength,
    concern:             r.concern,
    watch_for:           r.watch_for,
    confidence:          r.confidence as 'high' | 'medium' | 'low',
    dividend_narration:  divNarration,
  }
}

// Estimate cost in USD for tracking. Sonnet 4 pricing as of 2026-05:
// input $3/MTok, output $15/MTok. Web search ~$0.01/search.
function estimateCost(inTokens: number, outTokens: number, searchCount: number): number {
  return (inTokens / 1_000_000) * 3
       + (outTokens / 1_000_000) * 15
       + searchCount * 0.01
}

// ─── Per-ticker processor ──────────────────────────────────────

async function processTicker(
  db:     NonNullable<ReturnType<typeof client>>,
  ticker: string,
): Promise<ProcessResult> {

  // 1. Instrument metadata
  const { data: rawInst, error: instErr } = await db
    .from('instruments')
    .select('instrument_id, name, sector, sleeve_id, div_per_share, div_yield_pct, div_frequency, div_status, last_div_date, next_div_date, ai_summary_refreshed_at')
    .eq('instrument_id', ticker)
    .maybeSingle()
  if (instErr) return { ticker, ok: false, reason: 'instrument-lookup: ' + instErr.message }
  if (!rawInst) return { ticker, ok: false, reason: 'instrument-not-found' }
  const inst = rawInst as unknown as InstRow

  if (inst.sleeve_id !== 'eq') {
    return { ticker, ok: false, reason: 'not-equity (sleeve=' + inst.sleeve_id + ')' }
  }

  // 2. Fundamentals history (annual preferred, then quarterly)
  const { data: rawFund, error: fundErr } = await db
    .from('fundamentals_history')
    .select('period_end, period_type, verified_status, revenue_ngn_m, gross_profit_ngn_m, operating_profit_ngn_m, profit_before_tax_ngn_m, profit_after_tax_ngn_m, eps_basic, eps_diluted, total_assets_ngn_m, total_equity_ngn_m, total_debt_ngn_m, cash_and_equivalents_ngn_m, cash_from_operations_ngn_m, shares_outstanding, source')
    .eq('instrument_id', ticker)
    .order('period_end', { ascending: false })
    .limit(20)
  if (fundErr) return { ticker, ok: false, reason: 'fundamentals: ' + fundErr.message }
  const fundRowsAll = (rawFund ?? []) as unknown as FundRow[]

  // Prioritize annuals, then quarterlies. Cap at MAX_PERIODS_IN_PROMPT (6).
  const annuals    = fundRowsAll.filter(r => r.period_type === 'annual')
  const quarterlies = fundRowsAll.filter(r => r.period_type === 'quarterly')
  const fundRows: FundRow[] = []
  fundRows.push(...annuals.slice(0, MAX_PERIODS_IN_PROMPT))
  if (fundRows.length < MAX_PERIODS_IN_PROMPT) {
    fundRows.push(...quarterlies.slice(0, MAX_PERIODS_IN_PROMPT - fundRows.length))
  }

  if (fundRows.length === 0) {
    return { ticker, ok: false, reason: 'no-fundamentals' }
  }

  // 3. Disclosures
  const { data: rawDisc } = await db
    .from('instrument_disclosures')
    .select('category, title, modified_at')
    .eq('instrument_id', ticker)
    .order('modified_at', { ascending: false })
    .limit(MAX_DISCLOSURES)
  const discRows = (rawDisc ?? []) as unknown as DiscRow[]

  // 4. Dealings
  const { data: rawDeal } = await db
    .from('instrument_director_dealings')
    .select('title, modified_at')
    .eq('instrument_id', ticker)
    .order('modified_at', { ascending: false })
    .limit(MAX_DEALINGS)
  const dealRows = (rawDeal ?? []) as unknown as DealRow[]

  // 5. Recent price history
  const { data: rawPrices } = await db
    .from('market_prices')
    .select('price, price_date')
    .eq('instrument_id', ticker)
    .order('price_date', { ascending: false })
    .limit(100)
  const prices = (rawPrices ?? []) as unknown as PriceRow[]

  // 6. Build prompt + call Anthropic
  const today = new Date().toISOString().slice(0, 10)
  const prompt = buildPrompt(inst, fundRows, discRows, dealRows, prices, today)

  let resp: { text: string; searchCount: number; inTokens: number; outTokens: number }
  try {
    resp = await callAnthropic(prompt)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ticker, ok: false, reason: 'anthropic-call: ' + msg.slice(0, 200) }
  }

  const parsed = extractJson(resp.text)
  const summary = validateSummary(parsed)
  if (!summary) {
    return { ticker, ok: false, reason: 'invalid-json-or-shape (text: ' + resp.text.slice(0, 100) + '...)' }
  }

  // 7. Persist to instruments table
  const ai_summary_json = {
    tilt:         summary.tilt,
    tilt_reason:  summary.tilt_reason,
    strength:     summary.strength,
    concern:      summary.concern,
    watch_for:    summary.watch_for,
    confidence:   summary.confidence,
    generated_at: new Date().toISOString(),
  }

  const updatePayload: Record<string, unknown> = {
    ai_summary_json,
    ai_summary_refreshed_at: new Date().toISOString(),
  }

  // Flow dividend_narration into instruments.div_notes if produced
  if (summary.dividend_narration) {
    updatePayload.div_notes = summary.dividend_narration
  }

  const { error: updErr } = await db
    .from('instruments')
    .update(updatePayload as never)
    .eq('instrument_id', ticker)

  if (updErr) {
    return { ticker, ok: false, reason: 'update-failed: ' + updErr.message }
  }

  return {
    ticker,
    ok:                true,
    tilt:              summary.tilt,
    cost_estimate_usd: estimateCost(resp.inTokens, resp.outTokens, resp.searchCount),
  }
}

// ─── Stalest rotation for cron mode ─────────────────────────────

async function pickStalestTickers(
  db:    NonNullable<ReturnType<typeof client>>,
  limit: number,
): Promise<string[]> {
  // Pull all approved equity tickers ordered by ai_summary_refreshed_at
  // ascending (nulls first → highest priority for first generation).
  const { data, error } = await db
    .from('instruments')
    .select('instrument_id, ai_summary_refreshed_at')
    .eq('sleeve_id', 'eq')
    .eq('approved', true)
    .order('ai_summary_refreshed_at', { ascending: true, nullsFirst: true })
    .limit(limit)
  if (error) {
    console.error('[ai-summaries-refresh] pickStalestTickers error:', error.message)
    return []
  }
  type Row = { instrument_id: string }
  return ((data ?? []) as unknown as Row[]).map(r => r.instrument_id)
}

// ─── Main handler ──────────────────────────────────────────────

async function runRefresh(request: Request) {
  const db = client()
  if (!db) {
    return NextResponse.json({ error: 'supabase env missing' }, { status: 500 })
  }

  const url = new URL(request.url)
  const specificTicker = (url.searchParams.get('ticker') ?? '').trim().toUpperCase()

  // Cron-only auth check on GET
  if (request.method === 'GET') {
    const auth = request.headers.get('authorization') ?? ''
    const cronSecret = process.env.CRON_SECRET
    if (cronSecret && auth !== 'Bearer ' + cronSecret) {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
  }

  let tickers: string[] = []
  if (specificTicker) {
    tickers = [specificTicker]
  } else {
    tickers = await pickStalestTickers(db, MAX_INSTRUMENTS_PER_RUN)
  }

  if (tickers.length === 0) {
    return NextResponse.json({
      mode:           specificTicker ? 'single' : 'cron',
      tickers_planned: 0,
      results:         [],
      total_cost_usd:  0,
      note:            'No tickers to process',
    })
  }

  const startedAt = Date.now()
  const results: ProcessResult[] = []
  let totalCost = 0

  // Sequential per-ticker — Anthropic web_search is heavy, run serially.
  for (const t of tickers) {
    const result = await processTicker(db, t)
    results.push(result)
    if (result.cost_estimate_usd) totalCost += result.cost_estimate_usd
    // eslint-disable-next-line no-console
    console.log(`[ai-summaries-refresh] ${t}: ${result.ok ? 'OK tilt=' + result.tilt : 'FAIL ' + result.reason}`)
  }

  const elapsedMs = Date.now() - startedAt
  const successCount = results.filter(r => r.ok).length

  return NextResponse.json({
    mode:           specificTicker ? 'single' : 'cron',
    tickers_planned: tickers.length,
    success_count:   successCount,
    failure_count:   results.length - successCount,
    elapsed_ms:      elapsedMs,
    total_cost_usd:  Number(totalCost.toFixed(4)),
    results,
  })
}

export async function POST(request: Request) {
  return runRefresh(request)
}

export async function GET(request: Request) {
  return runRefresh(request)
}
