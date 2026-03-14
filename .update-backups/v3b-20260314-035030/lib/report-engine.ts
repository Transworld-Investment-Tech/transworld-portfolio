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
  const { portfolio, holdings, sleeveDefs, reportType, dateFrom, dateTo, fxRate } = input

  const tot    = computeNAV(holdings)
  const pl     = tot - portfolio.starting_nav
  const ret    = pl / portfolio.starting_nav
  const sv     = computeSleeveData(holdings, sleeveDefs, tot)
  const period = periodLabel(reportType, dateFrom, dateTo)
  const today  = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

  const equities   = holdings.filter(h => h.instrument?.type === 'Stock')
  const fixedInc   = holdings.filter(h => h.instrument?.type !== 'Stock')
  const tickers    = equities.map(h => h.instrument_id).join(', ')

  // Compact portfolio summary for prompt efficiency
  const summary = {
    name:       portfolio.name,
    client:     (portfolio as any).client?.name ?? 'N/A',
    period,
    nav:        fmt.ngnM(tot),
    startNav:   fmt.ngnM(portfolio.starting_nav),
    pl:         fmt.ngnM(pl),
    ret:        fmt.pct(ret),
    fx:         fxRate ? `₦${Math.round(fxRate)}/USD` : 'N/A',
    targets:    { income: fmt.pct(portfolio.income_target), cap: fmt.pct(portfolio.cap_target) },
    thresholds: { liq: fmt.pct(portfolio.liq_min), ddAlert: fmt.pct(portfolio.dd_alert), maxEq: fmt.pct(portfolio.max_eq_single) },
    sleeves:    sv.map(s => `${s.name}: target=${fmt.pct(s.target_pct)} actual=${fmt.pct(s.act)} value=${fmt.ngnM(s.val)} status=${s.status} diff=${(s.diff>=0?'+':'')+fmt.ngnM(s.diff)}`),
    equities:   equities.map(h => { const p=h.latest_price??h.avg_cost; const v=h.quantity*p; return `${h.instrument_id} ${h.instrument?.name}: ${Math.round(h.quantity).toLocaleString()} shares @ ₦${p.toFixed(2)} avg_cost=₦${h.avg_cost.toFixed(2)} value=${fmt.ngnM(v)} weight=${fmt.pct(v/tot)} chg=${fmt.chg(h.day_change??0)} divYield=${h.instrument?.coupon_pct??0}%`}),
    fixedInc:   fixedInc.map(h => `${h.instrument?.name}: face=${fmt.ngnM(h.quantity)} mktVal=${fmt.ngnM(h.quantity*(h.latest_price??h.avg_cost))} yield=${h.instrument?.coupon_pct??0}%`),
    mandate:    sleeveDefs.map(s => `${s.name}: ${fmt.pct(s.target_pct)} (${fmt.pct(s.min_pct)}-${fmt.pct(s.max_pct)})`).join(' | '),
  }

  const prompt = `You are a senior investment analyst at Transworld Asset Management, Lagos.
Generate a ${reportType.toUpperCase()} portfolio report for: ${period}

STEP 1 — Search the web for this data (search each item):
1. CBN MPR current rate, last MPC decision, rate direction
2. Nigeria CPI inflation latest (NBS)
3. USD/NGN rate (NAFEM), Brent crude price
4. NGX All-Share Index: level, day change, YTD return
5. NTB auction stop rates: 91-day, 182-day, 364-day
6. FGN bond yields: 5yr, 7yr, 10yr
7. For each stock — ${tickers} — search individually: price, P/E ratio, P/B ratio, dividend yield, ex-div date, last earnings (beat/miss), 52-week range, any corporate news

STEP 2 — Output ONLY a complete HTML document. Start with <!DOCTYPE html>. No text before it. No markdown.

Portfolio: ${JSON.stringify(summary, null, 1)}

HTML SPEC (inline styles only, one <style> reset block allowed):
Colors: navy #0f1923, gold #c9a84c, bg #f0f2f5, green #22c55e, red #ef4444, amber #f59e0b, purple #8b5cf6, blue #3b82f6
Font: Segoe UI/Arial. Max-width 960px centered. Printable A4.

Build these sections:

1. HEADER — navy band, "TRANSWORLD ASSET MANAGEMENT" gold small-caps left, portfolio name white 26px bold, period grey. Right: date + CONFIDENTIAL gold badge. 4px gold bottom border.

2. EXECUTIVE SUMMARY — white card, 4px gold left border. 4-5 sentences. Bold key number. Last sentence bold = most urgent action.

3. KPI ROW — 5 flex cards: NAV (gold border) | P&L (green/red) | Return% (green/red) | Drawdown status (green/amber/red) | Income progress (purple). Large monospace numbers.

4. ALLOCATION TABLE — per sleeve: CSS progress bar (actual filled, target marker line), columns: Sleeve|Target%|Actual%|Value|Diff|Status badge|Action. Green=OK, red=BREACH, amber=OVER.

5. MARKET COMMENTARY — 2×2 card grid:
   A. MONETARY POLICY (blue left border): MPR, inflation, rate outlook table
   B. NGX MARKET (green): ASI, YTD, notable movers
   C. FIXED INCOME (purple): NTB rates table, FGN yields table, roll/extend view
   D. FX & MACRO (amber): USD/NGN, Brent, top 3 risks

6. EQUITY DEEP-DIVE — one card per stock:
   Header: ticker badge (dark/gold) | name | price | day-change pill
   Table: shares | avg cost | unrl P&L | weight%
   Table row 2: P/E | P/B | div yield | ex-div date | earnings (BEAT/MISS/IN-LINE badge) | 52wk range
   SIGNAL BANNER (full width): ACCUMULATE(green)/HOLD(blue)/REDUCE(red)/WATCH(amber)
   2-3 sentence rationale citing data. Italic: "Analytical suggestion — portfolio manager discretion applies."

7. FIXED INCOME TABLE — Instrument|Type|Face|Market Value|Yield|Recommendation (ROLL/EXTEND/HOLD)

8. RISK DASHBOARD — table: Check|Current|Threshold|Status(badge)|Action

9. REBALANCING TABLE — Sleeve|Target₦M|Actual₦M|Gap₦M|Action|Priority(IMMEDIATE/THIS WEEK/THIS MONTH badge)

10. PRIORITY ACTIONS 1-5 — numbered, each: bold title | instrument+size | rationale | impact | urgency badge

11. FOOTER — grey bg, small disclaimer text about AI-assisted suggestions and manager discretion.

Rules: Only valid HTML output. Cite data sources. N/A if unavailable. Signals are suggestions not advice. Make it beautiful and printable.`

  const response = await (client.messages.create as Function)({
    model:      'claude-sonnet-4-20250514',
    max_tokens: 8000,
    tools:      [{ type: 'web_search_20250305', name: 'web_search' }],
    messages:   [{ role: 'user', content: prompt }],
  })

  const text: string = (response.content as any[])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text as string)
    .join('\n')

  return text
    .replace(/^```html\n?/i, '')
    .replace(/\n?```$/i, '')
    .trim() || '<p style="color:red;padding:20px;">Report generation failed — no content returned.</p>'
}
