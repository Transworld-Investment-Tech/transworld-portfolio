import { REPORT_TONE_INSTRUCTION } from './report-tone'
import Anthropic from '@anthropic-ai/sdk'
import { Portfolio, Holding, SleeveTarget, computeNAV, computeSleeveData, fmt } from './portfolio'
import { buildCashFlows, solveIRR } from './analytics'

// v21n: Critical fix to the performance section of the AI report prompt.
//
// BEFORE: The prompt showed (currentNAV − startingNAV) / startingNAV as
// "Total P&L" with a percentage — e.g. +20,090% for OOO Portfolio A.
// This raw HPR (Holding Period Return) is unadjusted for capital additions.
// When ₦9.6M was added as TRANSFER_IN over the years, the growth from
// ₦0.05M → ₦10.10M reflects those capital injections, NOT investment
// performance. The AI was anchoring on 20,090% and producing spurious analysis.
//
// AFTER: The prompt now shows:
//   1. ITD IRR p.a. (Money-Weighted Return) — headline metric, computed via
//      Newton-Raphson on the full transaction cash flow history
//   2. Absolute ₦ P&L — net of inflows and outflows
//   3. Raw HPR — labeled explicitly as NOT the performance metric, with a
//      warning if it exceeds 500% explaining exactly why it's distorted
//
// The AI is explicitly instructed to cite IRR, not HPR, when discussing returns.

export type ReportType = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'annual'

export interface WatchlistItem {
  ticker:    string
  name:      string
  section:   string
  sub_type:  string | null
  rank:      number
  rationale: string | null
}

export interface ReportInput {
  portfolio:     Portfolio
  holdings:      Holding[]
  sleeveDefs:    SleeveTarget[]
  reportType:    ReportType
  dateFrom?:     string
  dateTo?:       string
  fxRate?:       number
  transactions?: any[]
  navHistory?:   any[]
  watchlist?:    WatchlistItem[]
}

function periodLabel(type: ReportType, from?: string, to?: string): string {
  const fmtD = (d: string) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
  if (from && to) return `${fmtD(from)} — ${fmtD(to)}`
  const today = new Date()
  if (type === 'daily')     return today.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  if (type === 'weekly')    { const w = new Date(today); w.setDate(today.getDate() - 7); return `${fmtD(w.toISOString().slice(0,10))} — ${fmtD(today.toISOString().slice(0,10))}` }
  if (type === 'monthly')   return today.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
  if (type === 'quarterly') { const q = Math.floor(today.getMonth() / 3) + 1; return `Q${q} ${today.getFullYear()}` }
  if (type === 'annual')    return `Full Year ${today.getFullYear()}`
  return today.toLocaleDateString('en-GB')
}

// ─── Cash-flow adjusted performance metrics ───────────────────────────────────
// Computes IRR, absolute return, and inflow/outflow summary from the full
// transaction history. This is the same logic as computePeriodMetrics in
// analytics.ts but run server-side for the report prompt.
function computePerformanceMetrics(portfolio: Portfolio, transactions: any[], currentNAV: number): {
  itdIRR:         number | null
  absoluteReturn: number | null
  totalInflows:   number
  totalOutflows:  number
  netCashFlows:   number
  rawHPR:         number | null
  hprIsDistorted: boolean
  hprDistortionNote: string
} {
  const starting = portfolio.starting_nav ?? 0
  const allTx    = transactions ?? []

  // Inflows and outflows (capital movements, not trades)
  const transfers = allTx.filter((t: any) => ['TRANSFER_IN', 'TRANSFER_OUT'].includes(t.action))
  const totalInflows  = transfers
    .filter((t: any) => t.action === 'TRANSFER_IN')
    .reduce((s: number, t: any) => s + Math.abs(Number(t.amount ?? t.gross_value ?? 0)), 0)
  const totalOutflows = transfers
    .filter((t: any) => t.action === 'TRANSFER_OUT')
    .reduce((s: number, t: any) => s + Math.abs(Number(t.amount ?? t.gross_value ?? 0)), 0)
  const netCashFlows = totalInflows - totalOutflows

  // Absolute P&L = (end NAV − start NAV) − net new capital added
  const absoluteReturn = starting > 0
    ? (currentNAV - starting) - netCashFlows
    : null

  // Raw HPR — (currentNAV − startingNAV) / startingNAV — unadjusted
  const rawHPR = starting > 0 ? (currentNAV - starting) / starting : null

  // Is HPR distorted by large capital additions?
  // Heuristic: if totalInflows > 2× startingNAV AND rawHPR > 200%, it's misleading
  const inflowRatio     = starting > 0 ? totalInflows / starting : 0
  const hprIsDistorted  = rawHPR !== null && Math.abs(rawHPR) > 2 && inflowRatio > 1
  const hprDistortionNote = hprIsDistorted
    ? `Raw HPR is distorted because ₦${(totalInflows/1e6).toFixed(2)}M was added as capital (${inflowRatio.toFixed(1)}× the starting NAV of ₦${(starting/1e6).toFixed(2)}M). This capital growth inflates the simple ratio. DO NOT cite ${(rawHPR! * 100).toFixed(0)}% as the portfolio return.`
    : ''

  // ITD IRR via Newton-Raphson — accounts for timing and size of all flows
  let itdIRR: number | null = null
  if (starting > 0 && portfolio.start_date) {
    try {
      const cashFlows = buildCashFlows(starting, portfolio.start_date, allTx, currentNAV)
      const solved    = solveIRR(cashFlows)
      itdIRR = (solved !== null && isFinite(solved) && solved > -0.9999 && solved < 500)
        ? solved
        : null
    } catch {
      itdIRR = null
    }
  }

  return {
    itdIRR, absoluteReturn, totalInflows, totalOutflows, netCashFlows,
    rawHPR, hprIsDistorted, hprDistortionNote,
  }
}

function buildWatchlistContext(
  holdings: Holding[],
  watchlist: WatchlistItem[],
  reportType: string
): string {
  if (!watchlist || watchlist.length === 0) return ''

  const heldTickers     = new Set(holdings.map(h => h.instrument_id))
  const watchEquities   = watchlist.filter(w => w.section === 'equity')
  const watchFI         = watchlist.filter(w => w.section === 'fixed_income')
  const watchEagle      = watchlist.filter(w => w.section === 'watch')
  const notHeld         = watchEquities.filter(w => w.ticker && !heldTickers.has(w.ticker))
  const heldAndWatched  = watchEquities.filter(w => w.ticker && heldTickers.has(w.ticker))
  const heldNotOnList   = holdings
    .filter(h => h.instrument?.type === 'Stock' && !watchEquities.find(w => w.ticker === h.instrument_id))
    .map(h => h.instrument_id)

  const isLong = reportType === 'annual' || reportType === 'quarterly'

  const lines: string[] = [
    '',
    '═══════════════════════════════════════════════════════',
    'TRANSWORLD NGX MASTER WATCHLIST CONTEXT',
    '',
    `WATCHLIST UNIVERSE: ${watchEquities.length} equities | ${watchFI.length} fixed income | ${watchlist.filter(w => w.section === 'other').length} other`,
    '',
    '── TOP WATCHLIST EQUITIES (by rank) ─────────────────',
    ...watchEquities.slice(0, isLong ? 8 : 15).map(w =>
      `  #${w.rank} ${w.ticker || '—'} — ${w.name}${heldTickers.has(w.ticker) ? ' [IN PORTFOLIO]' : ''}${w.sub_type ? ' (' + w.sub_type + ')' : ''}`
    ),
    '',
    '── PORTFOLIO vs WATCHLIST ANALYSIS ─────────────────',
    `Holdings CONFIRMED on watchlist (${heldAndWatched.length}):`,
    ...heldAndWatched.map(w => `  ✓ ${w.ticker} (#${w.rank} on watchlist) — ${w.rationale?.slice(0, 80) ?? ''}`),
    '',
    `Top watchlist equities NOT in portfolio (${Math.min(notHeld.length, 10)} of ${notHeld.length}):`,
    ...notHeld.slice(0, isLong ? 5 : 8).map(w => `  → #${w.rank} ${w.ticker} — ${w.name}: ${w.rationale?.slice(0, 100) ?? ''}`),
    '',
    heldNotOnList.length > 0
      ? `Holdings NOT on master watchlist (review warranted): ${heldNotOnList.join(', ')}`
      : 'All portfolio equity holdings are on the master watchlist.',
    '',
    '── TOP 10 FIXED INCOME ON WATCHLIST ────────────────',
    ...watchFI.slice(0, 10).map(w =>
      `  #${w.rank} ${w.ticker || '—'} — ${w.name} [${w.sub_type ?? ''}]: ${w.rationale?.slice(0, 80) ?? ''}`
    ),
    '',
    '── EAGLE-EYE WATCH ITEMS ───────────────────────────',
    ...watchEagle.map(w => `  ⚡ ${w.name}: ${w.rationale?.slice(0, 120) ?? ''}`),
    '',
    'INSTRUCTIONS FOR AI REPORT:',
    '1. In your equity analysis, for each holding confirm its watchlist rank and whether the rationale still holds.',
    '2. In your opportunity section, identify the TOP 3 watchlist names not in the portfolio most relevant to this mandate.',
    '3. Flag any portfolio holding not on the watchlist and explain why it may or may not be concerning.',
    '4. Reference the eagle-eye items in your macro/forward guidance section.',
    '5. For fixed income: cross-reference the FI watchlist with any fixed income gaps in the portfolio.',
    '═══════════════════════════════════════════════════════',
  ]

  return lines.join('\n')
}

export async function generateAIReport(input: ReportInput): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const {
    portfolio, holdings, sleeveDefs, reportType,
    dateFrom, dateTo, fxRate, transactions, navHistory, watchlist,
  } = input

  const tot    = computeNAV(holdings)
  const sv     = computeSleeveData(holdings, sleeveDefs, tot)
  const period = periodLabel(reportType, dateFrom, dateTo)
  const today  = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

  const equities = holdings.filter(h => h.instrument?.type === 'Stock')
  const fixedInc = holdings.filter(h => h.instrument?.type !== 'Stock')
  const tickers  = equities.map(h => h.instrument_id).join(', ')

  // ── v21n: Compute proper cash-flow-adjusted performance metrics ────────────
  const perf = computePerformanceMetrics(portfolio as any, transactions ?? [], tot)

  // NAV history summary (now populated since route fetches nav_log)
  const navSummary = navHistory && navHistory.length > 0
    ? '\nNAV HISTORY:\n' + navHistory.map((n: any) =>
        `  ${n.nav_date}: ₦${(n.nav_value/1e6).toFixed(2)}M${n.notes ? ' — ' + n.notes : ''}`
      ).join('\n')
    : ''

  // Recent transactions summary (now populated since route fetches transactions)
  const recentTx = (transactions ?? [])
    .filter((t: any) => ['BUY', 'SELL', 'TRANSFER_IN', 'TRANSFER_OUT'].includes(t.action))
    .slice(-20)
  const txSummary = recentTx.length > 0
    ? '\nRECENT TRANSACTIONS (last 20 buy/sell/transfer events):\n' + recentTx.map((t: any) =>
        `  ${t.trade_date} | ${t.action} | ${t.instrument_id || '—'} | ${t.quantity ? Number(t.quantity).toLocaleString() + ' @ ₦' + Number(t.price || 0).toFixed(2) : '₦' + Number(t.amount || 0).toLocaleString()} | fees: ₦${Number(t.fees || 0).toLocaleString()}`
      ).join('\n')
    : ''

  // Watchlist context
  const watchlistContext = buildWatchlistContext(holdings, watchlist ?? [], reportType)

  // ── v21n: Performance section for the prompt ──────────────────────────────
  // IRR is the headline. Raw HPR is shown for context with explicit warnings
  // when it is distorted by capital additions. The AI is instructed not to
  // anchor on HPR.
  const performanceSection = `
═══════════════════════════════════════════════════════
PORTFOLIO PERFORMANCE — CRITICAL: READ CAREFULLY BEFORE ANALYSING
═══════════════════════════════════════════════════════

STARTING POINT:
  Starting NAV:    ₦${(portfolio.starting_nav/1e6).toFixed(2)}M  (inception ${portfolio.start_date})
  Current NAV:     ₦${(tot/1e6).toFixed(2)}M

HEADLINE RETURN METRIC — USE THIS IN YOUR ANALYSIS:
  ITD IRR (p.a.):  ${perf.itdIRR !== null ? ((perf.itdIRR * 100).toFixed(2) + '% per annum') : 'N/A (insufficient cash flow data)'}
  Definition: Money-Weighted Return (IRR), annualised via Newton-Raphson.
  This accounts for the TIMING and SIZE of every capital flow since inception.
  This is the correct metric to cite when discussing portfolio performance.

ABSOLUTE P&L (net of external flows):
  ₦${perf.absoluteReturn !== null ? ((perf.absoluteReturn >= 0 ? '+' : '') + (perf.absoluteReturn/1e6).toFixed(2) + 'M') : 'N/A'}
  = (Current NAV − Starting NAV) − Net capital additions
  This is the investment gain attributable to portfolio management decisions.

EXTERNAL CAPITAL FLOWS SINCE INCEPTION:
  Total inflows (TRANSFER_IN):  ₦${(perf.totalInflows/1e6).toFixed(2)}M
  Total outflows (TRANSFER_OUT): ₦${(perf.totalOutflows/1e6).toFixed(2)}M
  Net capital added:             ₦${(perf.netCashFlows >= 0 ? '+' : '') + (perf.netCashFlows/1e6).toFixed(2)}M

RAW HPR — CONTEXT ONLY, DO NOT USE AS PRIMARY RETURN METRIC:
  Raw HPR: ${perf.rawHPR !== null ? ((perf.rawHPR * 100).toFixed(2) + '%') : 'N/A'}
  = (Current NAV − Starting NAV) / Starting NAV
  This is NOT adjusted for the timing or size of capital additions.
${perf.hprIsDistorted ? `  ⚠️  WARNING: ${perf.hprDistortionNote}` : '  This metric is reasonable for this portfolio — capital flows were not large enough to significantly distort it.'}

INSTRUCTION TO AI: When writing this report, always cite the ITD IRR as the portfolio's return.
Never present the Raw HPR as the portfolio's performance. If you reference any return percentage,
it must be the IRR figure above.`

  const prompt = `You are a senior investment analyst and portfolio strategist at Transworld Investment and Securities, Lagos, Nigeria. You have deep expertise in Nigerian capital markets — NGX equities, FGN bonds, NTBs, CBN monetary policy, and discretionary portfolio management.

${REPORT_TONE_INSTRUCTION}

Generate a rigorous, insightful ${reportType.toUpperCase()} portfolio intelligence report for the period: ${period}
Generated: ${today}

═══════════════════════════════════════════════════════
PORTFOLIO DATA
═══════════════════════════════════════════════════════

CLIENT: ${(portfolio as any).client?.name ?? 'N/A'}
PORTFOLIO: ${portfolio.name}
CURRENCY: ${portfolio.currency}
FX RATE: ${fxRate ? `₦${Math.round(fxRate).toLocaleString()}/USD` : 'N/A'}
${performanceSection}

MANDATE:
  Income target:  ${fmt.pct(portfolio.income_target)} p.a.
  Cap target:     ${fmt.pct(portfolio.cap_target)} p.a.
  Max single eq:  ${fmt.pct(portfolio.max_eq_single)}
  Max eq sleeve:  ${fmt.pct(portfolio.max_eq_sleeve)}
  DD alert:       ${fmt.pct(portfolio.dd_alert)}
  DD action:      ${fmt.pct(portfolio.dd_action)}

SLEEVE ALLOCATION:
${sv.map((s: any) => `  ${s.name}: ${fmt.pct(s.act)} actual vs ${fmt.pct(s.target_pct)} target | ₦${(s.val/1e6).toFixed(2)}M | ${s.status} | diff: ${(s.diff>=0?'+':'')}₦${(Math.abs(s.diff)/1e6).toFixed(2)}M`).join('\n')}

EQUITY HOLDINGS:
${equities.map(h => {
  const p = h.latest_price ?? h.avg_cost
  const v = h.quantity * p
  const pnl = h.quantity * (p - h.avg_cost)
  return `  ${h.instrument_id} (${h.instrument?.name}):
    ${Math.round(h.quantity).toLocaleString()} shares | avg cost ₦${h.avg_cost.toFixed(2)} | price ₦${p.toFixed(2)}
    value ₦${(v/1e6).toFixed(2)}M | weight ${(v/tot*100).toFixed(1)}% | unrealised P&L ${pnl>=0?'+':''}₦${(pnl/1e6).toFixed(2)}M (${((p-h.avg_cost)/h.avg_cost*100).toFixed(1)}%)`
}).join('\n\n')}

FIXED INCOME / CASH:
${fixedInc.length > 0 ? fixedInc.map(h => `  ${h.instrument?.name}: ₦${(h.quantity/1e6).toFixed(2)}M face | yield ${h.instrument?.coupon_pct ?? 0}%`).join('\n') : '  None held — cash only'}
${navSummary}
${txSummary}
${watchlistContext}

═══════════════════════════════════════════════════════
REPORT STRUCTURE (write in clean markdown with ## headers)
═══════════════════════════════════════════════════════

## EXECUTIVE SUMMARY
3–4 sentences max. Most important insight first. Final sentence bold = single most urgent action.
When citing the portfolio's return, use the ITD IRR (${perf.itdIRR !== null ? (perf.itdIRR * 100).toFixed(1) + '% p.a.' : 'see above'}).

## PORTFOLIO PERFORMANCE REVIEW
Lead with the ITD IRR as the headline return metric.
Then discuss absolute ₦ P&L (net of external flows).
Provide context on why the portfolio's Raw HPR looks the way it does (capital flows).
Analyse returns vs mandate targets. NAV trajectory from history (if available). Income target tracking.

## MARKET CONTEXT: NIGERIA — ${period}

### Monetary Policy & Rates
CBN MPR at 26.5% (cut 50bps Feb 2026). Inflation at 15.1% (Jan 2026, declining 11 months).
Real yield, next cut timing, what it means for equities vs fixed income.

### NGX Equity Market
Your knowledge of NGX YTD performance, sector dynamics, banking recapitalisation.
How does this portfolio's equity positioning fit the current backdrop?

### Fixed Income Opportunity
NTB 364D at ~18.47%, FGN 10yr at ~16.06%. Real yields. Duration positioning.
For this portfolio specifically — what is the income foregone by being underweight fixed income?

### FX & Macro Risks
USD/NGN stability, Brent implications (name ARADEL/WAPCO specifically if held).
Top 3 macro risks over 90 days. Eagle-eye pipeline items from watchlist if relevant.

## EQUITY HOLDINGS DEEP-DIVE
For each stock in the portfolio (${tickers}):
- Watchlist rank (from context above) and whether it still belongs at that rank
- Valuation estimates: P/E, P/B, dividend yield (state as estimates from your knowledge)
- Recent earnings quality and revenue trend
- Business-specific risk/opportunity right now
- Technical level: where is price vs 52-week range?
- **Signal: ACCUMULATE / HOLD / REDUCE / WATCH** — clear rationale
- Price target range and key catalyst

## WATCHLIST OPPORTUNITY ANALYSIS
**This section uses the Transworld NGX Master Watchlist.**

### Top Watchlist Names Not in Portfolio
Identify the 3–5 most compelling watchlist equities NOT currently held. For each:
- Why it's ranked where it is on the watchlist
- Why it might be relevant to THIS portfolio's mandate specifically
- What needs to happen (price level, catalyst, or capacity) before it becomes actionable

### Portfolio vs Watchlist Quality Check
- Are all current holdings confirmed quality names per the watchlist?
- Any holdings NOT on the watchlist? If so, why are they still held?
- Does the fixed income allocation align with the FI watchlist? What's missing?

### Eagle-Eye Pipeline Items
Which of the eagle-eye watch items (if any) from the watchlist are most relevant to monitor for this portfolio over the next quarter?

## FIXED INCOME & CASH ANALYSIS
Assess against mandate. Quantify income foregone. Recommend specific instruments from the FI watchlist.
If the FI watchlist has relevant state or corporate bonds not in portfolio, mention them.

## RISK & COMPLIANCE REVIEW
Each risk limit — is it breached? By how much? What action does it require?
Specific ₦ amounts for any breach.

## REBALANCING RECOMMENDATIONS
Concrete trades with approximate ₦ sizes.
Prioritise by urgency. Cross-reference watchlist for the buys.

## PORTFOLIO MANAGER ACTION LIST
1–5 actions ranked by urgency. Format:
**[IMMEDIATE/THIS WEEK/THIS MONTH]** — Action title
- Instrument, size, rationale, expected impact

## OUTLOOK & FORWARD GUIDANCE
3-month view. Key decisions needed. Events and data to watch.
Include any eagle-eye watchlist items approaching a trigger point.

---
*Report generated ${today} | Transworld Investment and Securities — Discretionary Account Management*
*Performance: ITD IRR ${perf.itdIRR !== null ? (perf.itdIRR * 100).toFixed(2) + '% p.a.' : 'N/A'} (Money-Weighted Return, Newton-Raphson). Valuations are analytical estimates.*
*Watchlist: Transworld NGX Master Watchlist (${watchlist?.length ?? 0} securities).*
*All investment decisions remain at the discretion of the portfolio manager.*`

  const response = await client.messages.create({
    model:      'claude-sonnet-4-20250514',
    max_tokens: (reportType === 'annual' ? 3500 : reportType === 'quarterly' ? 4500 : reportType === 'monthly' ? 3500 : 2500),
    messages:   [{ role: 'user', content: prompt }],
  } as any)

  const text = (response.content as any[])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text as string)
    .join('\n')
    .trim()

  return text || 'Report generation failed — no content returned.'
}
