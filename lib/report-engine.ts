import Anthropic from '@anthropic-ai/sdk'
import { Portfolio, Holding, SleeveTarget, computeNAV, computeSleeveData, fmt } from './portfolio'

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
  portfolio:    Portfolio
  holdings:     Holding[]
  sleeveDefs:   SleeveTarget[]
  reportType:   ReportType
  dateFrom?:    string
  dateTo?:      string
  fxRate?:      number
  transactions?: any[]
  navHistory?:   any[]
  watchlist?:    WatchlistItem[]   // ← NEW
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

function buildWatchlistContext(
  holdings: Holding[],
  watchlist: WatchlistItem[],
  tot: number,
  reportType: string
): string {
  if (!watchlist || watchlist.length === 0) return ''

  const heldTickers = new Set(holdings.map(h => h.instrument_id))

  const watchEquities = watchlist.filter(w => w.section === 'equity')
  const watchFI       = watchlist.filter(w => w.section === 'fixed_income')
  const watchOther    = watchlist.filter(w => w.section === 'other')
  const watchEagle    = watchlist.filter(w => w.section === 'watch')

  // Which watchlist equities are NOT in the portfolio?
  const notHeld = watchEquities.filter(w => w.ticker && !heldTickers.has(w.ticker))
  // Which portfolio holdings ARE on the watchlist?
  const heldAndWatched = watchEquities.filter(w => w.ticker && heldTickers.has(w.ticker))
  // Which portfolio holdings are NOT on the watchlist? (potential concern)
  const heldNotOnWatchlist = holdings
    .filter(h => h.instrument?.type === 'Stock' && !watchEquities.find(w => w.ticker === h.instrument_id))
    .map(h => h.instrument_id)

  const lines: string[] = [
    '',
    '═══════════════════════════════════════════════════════',
    'TRANSWORLD NGX MASTER WATCHLIST CONTEXT',
    '',
    '',
    `WATCHLIST UNIVERSE: ${watchEquities.length} equities | ${watchFI.length} fixed income | ${watchOther.length} other`,
    '',
    '── TOP 20 WATCHLIST EQUITIES (by rank) ─────────────────',
    ...watchEquities.slice(0, (reportType === 'annual' || reportType === 'quarterly') ? 8 : 15).map(w =>
      `  #${w.rank} ${w.ticker || '—'} — ${w.name}${heldTickers.has(w.ticker) ? ' [IN PORTFOLIO]' : ''}${w.sub_type ? ' (' + w.sub_type + ')' : ''}`
    ),
    '',
    '── PORTFOLIO vs WATCHLIST ANALYSIS ─────────────────────',
    `Portfolio holdings CONFIRMED on watchlist (${heldAndWatched.length}):`,
    ...heldAndWatched.map(w => `  ✓ ${w.ticker} (#${w.rank} on watchlist) — ${w.rationale?.slice(0, 80) ?? ''}`),
    '',
    `Top watchlist equities NOT yet in portfolio (${Math.min(notHeld.length, 10)} of ${notHeld.length}):`,
    ...notHeld.slice(0, (reportType === 'annual' || reportType === 'quarterly') ? 5 : 8).map(w => `  → #${w.rank} ${w.ticker} — ${w.name}: ${w.rationale?.slice(0, 100) ?? ''}`),
    '',
    heldNotOnWatchlist.length > 0
      ? `Portfolio positions NOT on master watchlist (review warranted): ${heldNotOnWatchlist.join(', ')}`
      : 'All portfolio equity holdings are on the master watchlist.',
    '',
    '── TOP 10 FIXED INCOME ON WATCHLIST ────────────────────',
    ...watchFI.slice(0, 10).map(w =>
      `  #${w.rank} ${w.ticker || '—'} — ${w.name} [${w.sub_type ?? ''}]: ${w.rationale?.slice(0, 80) ?? ''}`
    ),
    '',
    '── EAGLE-EYE WATCH ITEMS ───────────────────────────────',
    ...watchEagle.map(w => `  ⚡ ${w.name}: ${w.rationale?.slice(0, 120) ?? ''}`),
    '',
    'INSTRUCTIONS FOR AI REPORT:',
    '1. In your equity analysis, for each holding confirm its watchlist rank and whether the rationale still holds.',
    '2. In your opportunity section, identify the TOP 3 watchlist names not in the portfolio most relevant to this portfolio\'s mandate.',
    '3. Flag any portfolio holding not on the watchlist and explain why it may or may not be concerning.',
    '4. Reference the eagle-eye items in your macro/forward guidance section.',
    '5. For fixed income: cross-reference the FI watchlist with any fixed income gaps in the portfolio.',
    '═══════════════════════════════════════════════════════',
  ]

  return lines.join('\n')
}

export async function generateAIReport(input: ReportInput): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const { portfolio, holdings, sleeveDefs, reportType, dateFrom, dateTo, fxRate, transactions, navHistory, watchlist } = input

  const tot    = computeNAV(holdings)
  const pl     = tot - portfolio.starting_nav
  const ret    = pl / portfolio.starting_nav
  const sv     = computeSleeveData(holdings, sleeveDefs, tot)
  const period = periodLabel(reportType, dateFrom, dateTo)
  const today  = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

  const equities = holdings.filter(h => h.instrument?.type === 'Stock')
  const fixedInc = holdings.filter(h => h.instrument?.type !== 'Stock')
  const tickers  = equities.map(h => h.instrument_id).join(', ')

  // NAV trajectory summary
  const navSummary = navHistory && navHistory.length > 0
    ? '\nNAV HISTORY:\n' + navHistory.map(n => `  ${n.nav_date}: ₦${(n.nav_value/1e6).toFixed(2)}M${n.notes ? ' — ' + n.notes : ''}`).join('\n')
    : ''

  // Recent transactions
  const txSummary = transactions && transactions.length > 0
    ? '\nRECENT TRANSACTIONS (last 20):\n' + transactions.slice(0, 20).map(t =>
        `  ${t.trade_date} | ${t.action} | ${t.instrument_id || '—'} | ${t.quantity ? Number(t.quantity).toLocaleString() + ' @ ₦' + Number(t.price || 0).toFixed(2) : '₦' + Number(t.amount || 0).toLocaleString()} | fees: ₦${Number(t.fees || 0).toLocaleString()}`
      ).join('\n')
    : ''

  // Watchlist context
  const watchlistContext = buildWatchlistContext(holdings, watchlist ?? [], tot, reportType)

  const prompt = `You are a senior investment analyst and portfolio strategist at Transworld Asset Management, Lagos, Nigeria. You have deep expertise in Nigerian capital markets — NGX equities, FGN bonds, NTBs, CBN monetary policy, and discretionary portfolio management.

Generate a rigorous, insightful ${reportType.toUpperCase()} portfolio intelligence report for the period: ${period}
Generated: ${today}

═══════════════════════════════════════════════════════
PORTFOLIO DATA
═══════════════════════════════════════════════════════

CLIENT: ${(portfolio as any).client?.name ?? 'N/A'}
PORTFOLIO: ${portfolio.name}
CURRENCY: ${portfolio.currency}
FX RATE: ${fxRate ? `₦${Math.round(fxRate).toLocaleString()}/USD` : 'N/A'}

PERFORMANCE:
  Starting NAV: ₦${(portfolio.starting_nav/1e6).toFixed(2)}M  (${portfolio.start_date})
  Current NAV:  ₦${(tot/1e6).toFixed(2)}M
  Total P&L:    ₦${(pl/1e6).toFixed(2)}M  (${(ret*100).toFixed(1)}%)

MANDATE:
  Income target:  ${fmt.pct(portfolio.income_target)} p.a.
  Cap target:     ${fmt.pct(portfolio.cap_target)} p.a.
  Max single eq:  ${fmt.pct(portfolio.max_eq_single)}
  Max eq sleeve:  ${fmt.pct(portfolio.max_eq_sleeve)}
  DD alert:       ${fmt.pct(portfolio.dd_alert)}
  DD action:      ${fmt.pct(portfolio.dd_action)}

SLEEVE ALLOCATION:
${sv.map(s => `  ${s.name}: ${fmt.pct(s.act)} actual vs ${fmt.pct(s.target_pct)} target | ₦${(s.val/1e6).toFixed(2)}M | ${s.status} | diff: ${(s.diff>=0?'+':'')}₦${(Math.abs(s.diff)/1e6).toFixed(2)}M`).join('\n')}

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

## PORTFOLIO PERFORMANCE REVIEW
Analyse returns vs mandate. NAV trajectory from history. Income target tracking.
Call out whether total return and the trajectory are healthy given mandate.

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
*Report generated ${today} | Transworld Asset Management Portfolio Intelligence*
*Watchlist: Transworld NGX Master Watchlist (${watchlist?.length ?? 0} securities). Valuations are analytical estimates.*
*All investment decisions remain at the discretion of the portfolio manager.*`

  const response = await client.messages.create({
    model:      'claude-sonnet-4-20250514',
    max_tokens: (reportType === 'annual' ? 5500 : reportType === 'quarterly' ? 4500 : reportType === 'monthly' ? 3500 : 2500),
    messages:   [{ role: 'user', content: prompt }],
  } as any)

  const text = (response.content as any[])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text as string)
    .join('\n')
    .trim()

  return text || 'Report generation failed — no content returned.'
}
