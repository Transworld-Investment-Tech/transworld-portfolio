import { REPORT_TONE_INSTRUCTION } from './report-tone'
import Anthropic from '@anthropic-ai/sdk'
import type { FIInstrument } from './fi-context'
import { buildFIContextBlock } from './fi-context'

// v21k: generateConsolidatedReport()
// v23: FI universe with current yields injected (buildFIContextBlock).
//
// Parallel to generateAIReport() in lib/report-engine.ts but adapted for
// a multi-portfolio consolidated view. Covers all active portfolios for
// a client in a single report with per-portfolio breakdown, combined
// holdings analysis, and the full watchlist opportunity analysis.

export interface ConsolidatedReportInput {
  client: { name: string; code: string; type: string }
  portfolios: Array<{
    id: string; label: string; name: string
    starting_nav: number; start_date: string | null
    income_target: number; current_nav: number
  }>
  summary: {
    totalNAV: number
    totalStartingNAV: number
    totalPnL: number
    totalPnLPct: number
    blendedIRR: number | null
  }
  combinedHoldings: Array<{
    instrument_id: string; name: string; type: string
    sector: string | null; sleeve_id: string
    totalQuantity: number; blendedAvgCost: number
    latestPrice: number; totalValue: number
    totalPnL: number; totalPnLPct: number; weight: number
    breakdown: Array<{ label: string; quantity: number; avgCost: number }>
  }>
  reportType: 'monthly' | 'quarterly'
  watchlist?: Array<{
    ticker: string; name: string; section: string
    sub_type: string | null; rank: number; rationale: string | null
  }>
  fiUniverse?: FIInstrument[]   // v23: FI yields universe
  fxRate?: number
}

function fmtPct(v: number | null): string {
  if (v === null || !isFinite(v)) return 'N/A'
  return `${(v * 100).toFixed(1)}%`
}

function periodLabel(type: 'monthly' | 'quarterly'): string {
  const today = new Date()
  if (type === 'monthly') return today.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
  const q = Math.floor(today.getMonth() / 3) + 1
  return `Q${q} ${today.getFullYear()}`
}

function buildConsolidatedWatchlistContext(
  combinedHoldings: ConsolidatedReportInput['combinedHoldings'],
  watchlist: ConsolidatedReportInput['watchlist'] = [],
): string {
  if (!watchlist.length) return ''

  const heldTickers = new Set(combinedHoldings.map(h => h.instrument_id))
  const watchEquities = watchlist.filter(w => w.section === 'equity')
  const watchFI       = watchlist.filter(w => w.section === 'fixed_income')
  const watchEagle    = watchlist.filter(w => w.section === 'watch')

  const notHeld       = watchEquities.filter(w => w.ticker && !heldTickers.has(w.ticker))
  const heldWatched   = watchEquities.filter(w => w.ticker && heldTickers.has(w.ticker))
  const heldNotOnList = combinedHoldings
    .filter(h => h.type === 'Stock' && !watchEquities.find(w => w.ticker === h.instrument_id))
    .map(h => h.instrument_id)

  return [
    '',
    '═══════════════════════════════════════════════════════',
    'TRANSWORLD NGX MASTER WATCHLIST CONTEXT',
    `UNIVERSE: ${watchEquities.length} equities | ${watchFI.length} fixed income | ${watchlist.filter(w => w.section === 'other').length} other`,
    '',
    '── TOP WATCHLIST EQUITIES (by rank) ─────────────────',
    ...watchEquities.slice(0, 15).map(w =>
      `  #${w.rank} ${w.ticker || '—'} — ${w.name}${heldTickers.has(w.ticker) ? ' [IN PORTFOLIO]' : ''}${w.sub_type ? ' (' + w.sub_type + ')' : ''}`
    ),
    '',
    '── COMBINED PORTFOLIO vs WATCHLIST ──────────────────',
    `Holdings confirmed on watchlist (${heldWatched.length}):`,
    ...heldWatched.map(w => `  ✓ ${w.ticker} (#${w.rank}) — ${w.rationale?.slice(0, 80) ?? ''}`),
    '',
    `Top watchlist equities NOT in any portfolio (${Math.min(notHeld.length, 8)} shown):`,
    ...notHeld.slice(0, 8).map(w => `  → #${w.rank} ${w.ticker} — ${w.name}: ${w.rationale?.slice(0, 100) ?? ''}`),
    '',
    heldNotOnList.length > 0
      ? `Holdings NOT on master watchlist (review warranted): ${heldNotOnList.join(', ')}`
      : 'All equity holdings are confirmed on the master watchlist.',
    '',
    '── TOP 8 FIXED INCOME ON WATCHLIST ─────────────────',
    ...watchFI.slice(0, 8).map(w =>
      `  #${w.rank} ${w.ticker || '—'} — ${w.name} [${w.sub_type ?? ''}]: ${w.rationale?.slice(0, 80) ?? ''}`
    ),
    '',
    '── EAGLE-EYE WATCH ITEMS ────────────────────────────',
    ...watchEagle.map(w => `  ⚡ ${w.name}: ${w.rationale?.slice(0, 120) ?? ''}`),
    '═══════════════════════════════════════════════════════',
  ].join('\n')
}

export async function generateConsolidatedReport(input: ConsolidatedReportInput): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const { portfolios, summary, combinedHoldings, reportType, watchlist, fiUniverse, fxRate } = input

  const period  = periodLabel(reportType)
  const today   = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const equities = combinedHoldings.filter(h => h.type === 'Stock')
  const tickers  = equities.map(h => h.instrument_id).join(', ')
  const watchCtx = buildConsolidatedWatchlistContext(combinedHoldings, watchlist)
  const fiContext = buildFIContextBlock(fiUniverse ?? [])   // v23

  const prompt = `You are a senior investment analyst and portfolio strategist at Transworld Investment and Securities, Lagos, Nigeria. You have deep expertise in Nigerian capital markets — NGX equities, FGN bonds, NTBs, CBN monetary policy, and discretionary portfolio management.

${REPORT_TONE_INSTRUCTION}

Generate a rigorous, insightful CONSOLIDATED ${reportType.toUpperCase()} portfolio intelligence report for: ${period}
Generated: ${today}

═══════════════════════════════════════════════════════
CLIENT: ${input.client.name} (${input.client.code}) — ${input.client.type}
MANDATE TYPE: ${input.client.type}
FX RATE: ${fxRate ? `\u20a6${Math.round(fxRate).toLocaleString()}/USD` : 'N/A'}
═══════════════════════════════════════════════════════

CONSOLIDATED PERFORMANCE SUMMARY:
  Total starting NAV:  \u20a6${(summary.totalStartingNAV / 1e6).toFixed(2)}M
  Total current NAV:   \u20a6${(summary.totalNAV / 1e6).toFixed(2)}M
  Combined P&L:        \u20a6${(summary.totalPnL / 1e6).toFixed(2)}M  (${fmtPct(summary.totalPnLPct)} total return)
  Blended IRR:         ${summary.blendedIRR !== null ? (summary.blendedIRR * 100).toFixed(1) + '%' : 'N/A'} p.a. (Newton-Raphson; merged cash flows across all portfolios)
  Active portfolios:   ${portfolios.length}

PER-PORTFOLIO BREAKDOWN:
${portfolios.map(p => {
  const gain    = p.current_nav - p.starting_nav
  const gainPct = p.starting_nav > 0 ? gain / p.starting_nav : 0
  return `  Portfolio ${p.label} — ${p.name}
    Starting NAV: \u20a6${(p.starting_nav / 1e6).toFixed(2)}M  (${p.start_date ?? 'N/A'})
    Current NAV:  \u20a6${(p.current_nav / 1e6).toFixed(2)}M
    P&L:          \u20a6${(gain / 1e6).toFixed(2)}M  (${gainPct >= 0 ? '+' : ''}${(gainPct * 100).toFixed(1)}%)
    Income target: ${fmtPct(p.income_target)} p.a.`
}).join('\n\n')}

COMBINED EQUITY HOLDINGS (${equities.length} positions — ${tickers}):
${equities.map(h => {
  const pnlPct = h.blendedAvgCost > 0 ? (h.latestPrice - h.blendedAvgCost) / h.blendedAvgCost : 0
  const inPortfolios = h.breakdown.map(b => `Port.${b.label}: ${Math.round(b.quantity).toLocaleString()} @ \u20a6${b.avgCost.toFixed(2)}`).join(' | ')
  return `  ${h.instrument_id} (${h.name}):
    Total: ${Math.round(h.totalQuantity).toLocaleString()} shares | blended cost \u20a6${h.blendedAvgCost.toFixed(2)} | price \u20a6${h.latestPrice.toFixed(2)}
    Value: \u20a6${(h.totalValue / 1e6).toFixed(2)}M | weight: ${(h.weight * 100).toFixed(1)}% | unrealised: ${h.totalPnL >= 0 ? '+' : ''}\u20a6${(h.totalPnL / 1e6).toFixed(2)}M (${pnlPct >= 0 ? '+' : ''}${(pnlPct * 100).toFixed(1)}%)
    By portfolio: ${inPortfolios}`
}).join('\n\n')}

${combinedHoldings.filter(h => h.type !== 'Stock').length > 0
  ? 'FIXED INCOME / CASH:\n' + combinedHoldings.filter(h => h.type !== 'Stock').map(h =>
      `  ${h.name}: \u20a6${(h.totalValue / 1e6).toFixed(2)}M | yield ${(h as any).coupon_pct ?? 0}%`
    ).join('\n')
  : 'FIXED INCOME / CASH: None held across any portfolio.'}

${watchCtx}
${fiContext}

═══════════════════════════════════════════════════════
REPORT STRUCTURE (write in clean markdown with ## headers)
═══════════════════════════════════════════════════════

## EXECUTIVE SUMMARY
3–4 sentences covering the consolidated picture. Lead with the most important cross-portfolio insight. Final sentence bold = most urgent consolidated action.

## CONSOLIDATED PERFORMANCE REVIEW
Total NAV, combined P&L, blended IRR vs mandate targets.
Which portfolio is the strongest performer and why?
Are combined income targets being met? Shortfall in \u20a6.

## PORTFOLIO-BY-PORTFOLIO BREAKDOWN
For each portfolio (${portfolios.map(p => `Portfolio ${p.label}`).join(', ')}):
- Individual return and NAV trajectory
- Key contributors / detractors within that portfolio
- Mandate compliance (income target, drawdown)
- One specific action needed for this portfolio

## MARKET CONTEXT: NIGERIA — ${period}

### Monetary Policy & Rates
CBN MPR at 26.5% (cut 50bps Feb 2026). Inflation at 15.1% (Jan 2026, declining 11 months).
Real yield trajectory, rate cut timing, equity vs fixed income implications.

### NGX Equity Market
NGX YTD performance, sector rotation, banking recapitalisation progress.
How does the combined equity book position the client vs the broader market?

### Fixed Income Opportunity
Reference the FIXED INCOME UNIVERSE block above — cite specific instruments with their
current market yields rather than abstract rate anchors.
For this client's combined NAV — what is the total income foregone by being underweight fixed income?

### FX & Macro Risks
USD/NGN stability, oil price implications (name any ARADEL/WAPCO held).
Top 3 macro risks over 90 days relevant to this combined portfolio.

## COMBINED EQUITY HOLDINGS DEEP-DIVE
For each stock held across all portfolios (${tickers}):
- Consolidated position size and which portfolios hold it (highlight any concentration across mandates)
- Watchlist rank and conviction level
- Signal: ACCUMULATE / HOLD / REDUCE / WATCH
- Key catalyst and price target

## WATCHLIST OPPORTUNITY ANALYSIS
**Using the Transworld NGX Master Watchlist.**

### Top Unowned Names Most Relevant to This Client
3–5 watchlist equities not held in ANY portfolio. For each: why relevant to this client's profile, what entry trigger to watch.

### Cross-Portfolio Consistency Check
- Are all holdings confirmed quality names per the watchlist?
- Is there any duplication risk — same position in multiple portfolios where consolidation/rebalancing would be more efficient?
- Any holding NOT on the watchlist across any portfolio?

### Fixed Income Gap vs FI Watchlist and Universe
Given the combined FI exposure — using the FIXED INCOME UNIVERSE above, recommend 2-4 specific
instruments to prioritise for the combined mandate. Cite ticker, current yield, and tenor
rationale. Flag any recommendation that relies on a \u26a0-tagged line with a liquidity caveat.

## CONSOLIDATED RISK & COMPLIANCE
Check each portfolio's mandate limits. Flag any breaches with specific \u20a6 amounts.
Flag any cross-portfolio concentration that may not be visible at individual level.

## REBALANCING & ACTION PLAN
Concrete trades across portfolios. Prioritise by urgency.
Where to trim, where to add — with \u20a6 sizes and which portfolio executes.

## PORTFOLIO MANAGER ACTION LIST
1–5 actions ranked by urgency. Format:
**[IMMEDIATE/THIS WEEK/THIS MONTH]** — Action: Portfolio X — Instrument, size, rationale

## OUTLOOK & FORWARD GUIDANCE
3-month view for the combined mandate.
Key data events and watchlist triggers to monitor.

---
*Consolidated report generated ${today} | Transworld Investment and Securities — Discretionary Account Management*
*Covers: ${portfolios.map(p => `Portfolio ${p.label} (${p.name})`).join(', ')}*
*Watchlist: Transworld NGX Master Watchlist (${watchlist?.length ?? 0} securities). FI Universe: ${(fiUniverse ?? []).length} instruments. Valuations are analytical estimates.*
*All investment decisions remain at the discretion of the portfolio manager.*`

  const response = await client.messages.create({
    model:      'claude-sonnet-4-20250514',
    max_tokens: reportType === 'quarterly' ? 4500 : 3000,
    messages:   [{ role: 'user', content: prompt }],
  } as any)

  const text = (response.content as any[])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text as string)
    .join('\n')
    .trim()

  return text || 'Report generation failed — no content returned.'
}
