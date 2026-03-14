import Anthropic from '@anthropic-ai/sdk'
import { Portfolio, Holding, SleeveTarget, computeNAV, computeSleeveData, fmt } from './portfolio'

export type ReportType = 'daily' | 'weekly' | 'monthly' | 'quarterly' | 'annual'

export interface ReportInput {
  portfolio: Portfolio
  holdings: Holding[]
  sleeveDefs: SleeveTarget[]
  reportType: ReportType
  dateFrom?: string
  dateTo?: string
  fxRate?: number
  transactions?: any[]
  navHistory?: any[]
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

export async function generateAIReport(input: ReportInput): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const { portfolio, holdings, sleeveDefs, reportType, dateFrom, dateTo, fxRate, transactions, navHistory } = input

  const tot   = computeNAV(holdings)
  const pl    = tot - portfolio.starting_nav
  const ret   = pl / portfolio.starting_nav
  const sv    = computeSleeveData(holdings, sleeveDefs, tot)
  const period = periodLabel(reportType, dateFrom, dateTo)
  const today  = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

  const equities = holdings.filter(h => h.instrument?.type === 'Stock')
  const fixedInc = holdings.filter(h => h.instrument?.type !== 'Stock')
  const tickers  = equities.map(h => h.instrument_id).join(', ')

  // Build rich portfolio context
  const holdingLines = equities.map(h => {
    const p   = h.latest_price ?? h.avg_cost
    const v   = h.quantity * p
    const pnl = v - (h.quantity * h.avg_cost)
    const pnlPct = ((p - h.avg_cost) / h.avg_cost) * 100
    return `  ${h.instrument_id} (${h.instrument?.name ?? ''}):
    Shares: ${Math.round(h.quantity).toLocaleString()} | Avg cost: ₦${h.avg_cost.toFixed(2)} | Current: ₦${p.toFixed(2)}
    Value: ${fmt.ngnM(v)} | Weight: ${fmt.pct(v/tot)} | Unrealized P&L: ${fmt.ngnM(pnl)} (${pnlPct>=0?'+':''}${pnlPct.toFixed(1)}%)
    Day change: ${fmt.chg(h.day_change ?? 0)} | Div yield on file: ${h.instrument?.coupon_pct ?? 0}%`
  }).join('\n\n')

  const fiLines = fixedInc.map(h => {
    const mv = h.quantity * (h.latest_price ?? h.avg_cost)
    return `  ${h.instrument?.name ?? h.instrument_id}: Face ₦${fmt.ngnM(h.quantity)} | Mkt val ${fmt.ngnM(mv)} | Yield ${h.instrument?.coupon_pct ?? 0}%`
  }).join('\n')

  const sleeveLines = sv.map(s =>
    `  ${s.name}: Target ${fmt.pct(s.target_pct)} | Actual ${fmt.pct(s.act)} | Value ${fmt.ngnM(s.val)} | Status: ${s.status} | Diff: ${(s.diff>=0?'+':'')+fmt.ngnM(s.diff)}`
  ).join('\n')

  // Transaction history summary
  const txSummary = transactions && transactions.length > 0
    ? `\nRECENT TRANSACTIONS (last 20):\n${transactions.slice(0,20).map(t =>
        `  ${t.trade_date} | ${t.action} | ${t.instrument_id} | ${Math.round(t.quantity||0).toLocaleString()} shares @ ₦${Number(t.price||0).toFixed(2)} | Gross: ${fmt.ngnM(t.gross_value||0)} | Fees: ₦${Number(t.fees||0).toLocaleString()}`
      ).join('\n')}`
    : ''

  // NAV history
  const navLines = navHistory && navHistory.length > 0
    ? `\nNAV HISTORY:\n${navHistory.map(n => `  ${n.nav_date}: ${fmt.ngnM(n.nav_value)}${n.notes ? ' — '+n.notes : ''}`).join('\n')}`
    : ''

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
  Starting NAV: ${fmt.ngnM(portfolio.starting_nav)} (${portfolio.start_date})
  Current NAV:  ${fmt.ngnM(tot)}
  Total P&L:    ${fmt.ngnM(pl)} (${fmt.pct(ret)})

MANDATE:
  Income target:    ${fmt.pct(portfolio.income_target)} p.a.
  Cap target:       ${fmt.pct(portfolio.cap_target)} p.a.
  Max single eq:    ${fmt.pct(portfolio.max_eq_single)}
  Max eq sleeve:    ${fmt.pct(portfolio.max_eq_sleeve)}
  Drawdown alert:   ${fmt.pct(portfolio.dd_alert)}
  Drawdown action:  ${fmt.pct(portfolio.dd_action)}

SLEEVE ALLOCATION:
${sleeveLines}

EQUITY HOLDINGS:
${holdingLines}

FIXED INCOME / CASH:
${fiLines || '  None currently held'}
${txSummary}
${navLines}

═══════════════════════════════════════════════════════
YOUR ANALYSIS TASK
═══════════════════════════════════════════════════════

Write a deeply analytical, forward-looking portfolio report in clean plain text with markdown headers.
Use your knowledge of Nigerian markets, CBN policy, and these specific companies to provide genuine insight.
Every section should give the portfolio manager something actionable and specific — not generic commentary.

FORMAT: Clean markdown. Use ## for sections, ### for subsections, **bold** for key numbers and signals.
No HTML. No bullet-point padding. Write in paragraphs where analysis is needed. Use tables only for data grids.

REPORT STRUCTURE:

## EXECUTIVE SUMMARY
3-4 sentences maximum. Lead with the single most important insight about this portfolio right now.
State the most urgent action in the final sentence, bolded.

## PORTFOLIO PERFORMANCE REVIEW
Analyse performance against mandate targets. Is the ${fmt.pct(portfolio.income_target)} income target being met?
Is the ${fmt.pct(portfolio.cap_target)} cap target on track? What has driven returns?
If NAV history is available, analyse the trajectory — where was growth strong, where was it weak?
What does the ${fmt.pct(ret)} total return since inception tell us about portfolio construction quality?

## MARKET CONTEXT: NIGERIA — ${period}
### Monetary Policy & Rates
Your assessment of where CBN is headed. Use your knowledge of the current MPR (26.5%, cut 50bps Feb 2026),
the inflation trajectory (falling for 11 consecutive months to ~15.1% Jan 2026), and what this means
for fixed income and equity valuations going forward. When do you expect the next cut? What's the real yield?

### NGX Equity Market
Honest assessment of the NGX environment. Your knowledge of YTD performance, sector dynamics,
banking recapitalisation momentum, and what's driving or dragging the index.
How does this portfolio's equity exposure fit the current market backdrop?

### Fixed Income Opportunity
Assess the NTB/FGN opportunity: 364D NTBs at ~18.47%, 10yr FGN bonds at ~16.06%.
What is the real yield after 15.1% inflation? What is the duration risk given CBN easing?
What is the optimal positioning right now — short duration or extend for capital gains?

### FX & Macro Risks
USD/NGN trajectory, oil price implications (this portfolio has Aradel/Seplat exposure — discuss specifically),
and the top 3 macro risks to this portfolio over the next 90 days.

## EQUITY HOLDINGS ANALYSIS
For each stock held (${tickers}), provide a substantive paragraph covering:
- Current valuation (P/E and P/B estimates based on your knowledge — state these are estimates)
- Recent financial performance: last earnings result, revenue trend, dividend history
- Business-specific risks and opportunities right now (be specific to Nigeria, not generic)
- Technical position: where is the stock relative to its 52-week range?
- **Signal: ACCUMULATE / HOLD / REDUCE / WATCH** — state this clearly with your specific rationale
- Price target range (estimate) and key catalyst to watch

Use your deep knowledge of each company. For example:
- ARADEL: oil production volumes, Brent exposure, rights issue history
- NB (Nigerian Breweries): volume trends, excise duty pressures, parent Heineken strategy
- UNILEVER: recent delisting rumors, low float, FX cost pressure vs. naira recovery
- WAPCO (Lafarge Africa): cement demand, infrastructure spend, AfDB pipeline
- UACN: real estate exposure, food segment, conglomerate discount
- NESTLE: premium pricing power, repatriation of dividends, Maggi dominance
- FCMB: recapitalisation status, retail banking growth, asset quality
- ACCESSCORP: tier-1 pan-African expansion, recapitalisation, dividend outlook

## FIXED INCOME & CASH ANALYSIS
Assess the current fixed income and cash positions against the mandate.
If there is a fixed income gap (mandate requires it but none held), quantify the income being foregone.
Recommend specific NTB tenors and FGN bond maturities to target.
Calculate approximate income impact of deploying to mandate targets.

## RISK & COMPLIANCE REVIEW
Work through each risk limit:
- Liquidity (minimum ${fmt.pct(portfolio.liq_min)}): current ${fmt.pct(sv.find(s=>s.sleeve_id==='liq')?.act??0)} — compliant?
- Single equity limit (${fmt.pct(portfolio.max_eq_single)}): list any breaches by name and amount over
- Equity sleeve limit (${fmt.pct(portfolio.max_eq_sleeve)}): current position
- Drawdown status vs ${fmt.pct(portfolio.dd_alert)} alert and ${fmt.pct(portfolio.dd_action)} action thresholds
- Income target tracking: are we on pace for ${fmt.pct(portfolio.income_target)} income?

For each breach or near-breach: state the exact shortfall, the risk it creates, and the specific action required.

## REBALANCING RECOMMENDATIONS
Concrete, specific recommendations with approximate trade sizes in naira.
Prioritise by urgency. For each recommendation state:
- What to buy or sell
- Approximate size (₦M)
- Why now (price level, mandate breach, market timing)
- Expected impact on portfolio metrics

## PORTFOLIO MANAGER ACTION LIST
Number these 1-5, ranked by urgency. Each action:
**[IMMEDIATE/THIS WEEK/THIS MONTH]** — Action title
- Specific instrument and size
- Rationale tied to data above
- Expected portfolio impact

## OUTLOOK & FORWARD GUIDANCE
What should the portfolio look like in 3 months if recommendations are followed?
What are the key decisions the portfolio manager needs to make?
What market events or data releases should they be watching?

---
*Report generated ${today} | Transworld Asset Management Portfolio Intelligence*
*Based on portfolio data as at report date. Valuation estimates and signals are analytical in nature.*
*All investment decisions remain at the discretion of the portfolio manager.*`

  const response = await client.messages.create({
    model:      'claude-sonnet-4-20250514',
    max_tokens: 7000,
    messages:   [{ role: 'user', content: prompt }],
  })

  const text = (response.content as any[])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text as string)
    .join('\n')
    .trim()

  return text || 'Report generation failed — no content returned.'
}
