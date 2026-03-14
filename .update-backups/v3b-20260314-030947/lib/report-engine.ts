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
  const fmtD = (d: string) =>
    new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
  if (from && to) return `${fmtD(from)} — ${fmtD(to)}`
  const today = new Date()
  if (type === 'daily')
    return today.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  if (type === 'weekly') {
    const w = new Date(today)
    w.setDate(today.getDate() - 7)
    return `${fmtD(w.toISOString().slice(0, 10))} — ${fmtD(today.toISOString().slice(0, 10))}`
  }
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
  const today  = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })

  const equities    = holdings.filter(h => h.instrument?.type === 'Stock')
  const fixedInc    = holdings.filter(h => h.instrument?.type !== 'Stock')
  const ngxTickers  = equities.map(h => h.instrument_id).join(', ')

  const portfolioJSON = {
    reportDate:    today,
    period,
    reportType:    reportType.toUpperCase(),
    portfolioName: portfolio.name,
    clientName:    (portfolio as any).client?.name ?? 'N/A',
    currency:      portfolio.currency,
    currentNAV:    fmt.ngnM(tot),
    startingNAV:   fmt.ngnM(portfolio.starting_nav),
    unrealizedPL:  fmt.ngnM(pl),
    totalReturn:   fmt.pct(ret),
    fxRate:        fxRate ? `₦${Math.round(fxRate)}/USD` : 'N/A',
    incomeTarget:  fmt.pct(portfolio.income_target),
    capTarget:     fmt.pct(portfolio.cap_target),
    sleeves: sv.map(s => ({
      name:   s.name,
      target: fmt.pct(s.target_pct),
      actual: fmt.pct(s.act),
      value:  fmt.ngnM(s.val),
      status: s.status,
      diff:   (s.diff >= 0 ? '+' : '') + fmt.ngnM(s.diff),
    })),
    equities: equities.map(h => {
      const price = h.latest_price ?? h.avg_cost
      const val   = h.quantity * price
      return {
        ticker:    h.instrument_id,
        name:      h.instrument?.name,
        shares:    Math.round(h.quantity).toLocaleString(),
        price:     `₦${price.toFixed(2)}`,
        avgCost:   `₦${h.avg_cost.toFixed(2)}`,
        dayChange: fmt.chg(h.day_change ?? 0),
        value:     fmt.ngnM(val),
        weight:    fmt.pct(val / tot),
        unrlPL:    fmt.ngnM(val - h.quantity * h.avg_cost),
        divYield:  h.instrument?.coupon_pct ? `${h.instrument.coupon_pct}%` : 'N/A',
      }
    }),
    fixedIncome: fixedInc.map(h => ({
      name:        h.instrument?.name,
      type:        h.instrument?.type,
      faceValue:   fmt.ngnM(h.quantity),
      marketValue: fmt.ngnM(h.quantity * (h.latest_price ?? h.avg_cost)),
      yield:       h.instrument?.coupon_pct ? `${h.instrument.coupon_pct}%` : 'N/A',
    })),
  }

  const prompt = `You are a senior investment analyst at Transworld Asset Management, Lagos.
Generate a ${reportType.toUpperCase()} portfolio intelligence report for the period: ${period}.

STEP 1 — MARKET RESEARCH. Use web_search to find the following. Search each item separately:

A. NIGERIAN MACRO & RATES:
- CBN Monetary Policy Rate (MPR), last MPC decision date, and rate direction outlook
- Nigeria headline CPI (latest NBS figure) and food inflation
- USD/NGN exchange rate (NAFEM official and street)
- Brent crude oil price
- NGX All-Share Index: latest level, day change %, YTD return %, market capitalisation
- Latest NTB auction stop rates: 91-day, 182-day, 364-day
- FGN bond secondary market yields: 5yr, 7yr, 10yr benchmark

B. FOR EACH NGX STOCK — search individually for: ${ngxTickers}
For each stock find:
- Current share price, day % change, YTD % change
- Trailing P/E ratio and forward P/E if available
- Price-to-Book (P/B) ratio
- Dividend yield, most recent dividend declared, next ex-dividend date
- Most recent quarterly/half-year earnings: EPS actual vs consensus (beat/miss/in-line), revenue growth YoY
- 52-week high and low
- 30-day price volatility or beta vs NGX ASI
- Any recent analyst upgrades, downgrades, or price target changes
- Any corporate actions: rights issues, share buybacks, M&A news, management changes, AGM notices
- Valuation comparison to Nigerian sector peers

C. MACRO RISKS & UPCOMING CATALYSTS:
- Top 3 macro risks to Nigerian equities over next 30-90 days
- Upcoming events: MPC meeting dates, budget cycle, earnings season, elections
- Global context: US Fed rate outlook, emerging market capital flows, commodity prices

STEP 2 — Generate the report as a complete, standalone HTML document.
Output ONLY the HTML. Do not include any markdown, explanation, or text before <!DOCTYPE html>.

Portfolio data for the report:
${JSON.stringify(portfolioJSON, null, 2)}

Portfolio mandate:
${sleeveDefs.map(s => `${s.name}: ${fmt.pct(s.target_pct)} target (${fmt.pct(s.min_pct)}–${fmt.pct(s.max_pct)})`).join(' | ')}
Income target: ${fmt.pct(portfolio.income_target)} p.a. | Cap appreciation target: ${fmt.pct(portfolio.cap_target)} p.a.
Max single equity: ${fmt.pct(portfolio.max_eq_single)} of NAV | Max equity sleeve: ${fmt.pct(portfolio.max_eq_sleeve)}
Drawdown alert: ${fmt.pct(portfolio.dd_alert)} | Action threshold: ${fmt.pct(portfolio.dd_action)}

HTML DESIGN REQUIREMENTS:
- Use inline styles only (one small <style> block in <head> for reset + print is acceptable)
- Color palette: header #0f1923 (dark navy), gold #c9a84c, body bg #f0f2f5, card bg white,
  green #22c55e, red #ef4444, amber #f59e0b, blue #3b82f6, purple #8b5cf6
- Font: 'Segoe UI', Arial, sans-serif
- Max width 960px, centered, 40px side padding, fully printable (A4)
- Professional financial report aesthetic

REQUIRED SECTIONS:

SECTION 1 — HEADER BAND
Full-width dark navy (#0f1923) banner.
Left side: "TRANSWORLD ASSET MANAGEMENT" in gold (#c9a84c) uppercase 11px letter-spaced,
then portfolio name in white 26px bold, then report type + period in #8a91a8.
Right side: generation date, "CONFIDENTIAL" badge in gold border.
4px gold bottom border.

SECTION 2 — EXECUTIVE SUMMARY
White card with 4px gold left border, "EXECUTIVE SUMMARY" label in gold uppercase.
4–5 sentences. Bold the single most important number. 
Final sentence in bold: the one most urgent action for the portfolio manager.

SECTION 3 — KPI STRIP
Five cards side by side (flexbox, equal width):
1. Current NAV — gold top border
2. Unrealized P&L — green or red top border depending on sign
3. Total Return % — green or red
4. Drawdown Status — green/amber/red based on thresholds
5. Income Target Progress — purple top border
Each card: small grey label, large bold monospace number (24px), small grey sub-label.

SECTION 4 — ALLOCATION vs TARGETS
Heading "PORTFOLIO ALLOCATION". Table with columns:
Sleeve | Target % | Actual % | Value (₦) | Diff from Target | Status | Suggested Action
For each sleeve show a CSS progress bar (actual % filled, thin vertical line at target %).
Green bar = OK, red = BREACH, amber = OVER.
Status = colored pill badge.

SECTION 5 — MARKET COMMENTARY
2×2 grid of cards with colored left-border accents:
5a. MONETARY POLICY & RATES (blue #3b82f6)
    — MPR level, last decision, direction, inflation, real yield mini-table
5b. NGX EQUITY MARKET (green #22c55e)
    — ASI level & YTD, sector breakdown, notable movers relevant to portfolio
5c. FIXED INCOME MARKET (purple #8b5cf6)
    — NTB rates by tenor (table), FGN bond yields (table), roll/extend recommendation
5d. FX & MACRO OUTLOOK (amber #f59e0b)
    — USD/NGN, Brent crude, top 3 risks with brief note each

SECTION 6 — EQUITY HOLDINGS INTELLIGENCE
One card per equity holding. Layout:
  TOP ROW: Dark ticker badge (gold text) | Full company name bold | Current price 20px | Day change pill green/red
  DATA TABLE (2 rows × 4 columns):
    Row 1: Shares held | Avg cost | Unrealized P&L (green/red) | Portfolio weight %
    Row 2: P/E ratio | P/B ratio | Dividend yield | Next ex-div date
  EARNINGS ROW: Last result | EPS vs estimate badge (BEAT green / MISS red / IN-LINE grey) | Revenue growth | 52-wk range
  VOLATILITY ROW: 30-day volatility | Beta vs ASI | Analyst consensus | Price target
  SIGNAL BOX (full-width colored footer on card):
    ACCUMULATE (green bg) / HOLD (blue bg) / REDUCE (red bg) / WATCH (amber bg)
    Bold signal word | 2–3 sentence rationale citing specific data from your research
    Small italic text: "Analytical suggestion only — portfolio manager discretion applies."

SECTION 7 — FIXED INCOME ANALYSIS
Table: Instrument | Type | Face Value | Market Value | Yield p.a. | Duration view | Recommendation
NTBs: recommend ROLL or EXTEND with one-line rationale.
FGN Bonds: comment on mark-to-market given rate outlook.

SECTION 8 — RISK DASHBOARD
Title "RISK & COMPLIANCE MONITOR". Table:
Risk Check | Current | Threshold | Status (GREEN/AMBER/RED badge) | Required Action
Rows: Liquidity %, Largest single equity %, Equity sleeve total %, Drawdown vs peak %, Income on track

SECTION 9 — REBALANCING GUIDE
Table: Sleeve | Target (₦M) | Actual (₦M) | Gap (₦M) | Action | Instrument(s) | Priority
Priority badges: IMMEDIATE (red) | THIS WEEK (amber) | THIS MONTH (blue) | ON TRACK (grey)

SECTION 10 — PRIORITY ACTIONS FOR PORTFOLIO MANAGER
Numbered list 1–5. Each item:
  Bold action title (e.g. "Sell 20,000 ZENITHBANK shares")
  Instrument and estimated size in ₦M
  Rationale: 1–2 sentences citing specific research data you found
  Expected impact on portfolio
  Urgency badge: IMMEDIATE / THIS WEEK / THIS MONTH

SECTION 11 — FOOTER
Light grey background. Small text.
Disclaimer: "This report is prepared by Transworld Asset Management for informational purposes only.
Analytical signals and suggestions are AI-assisted and do not constitute investment advice.
The portfolio manager retains full discretion over all investment decisions.
Market data sourced from public sources as at the report generation date."

STRICT RULES:
1. Output ONLY valid HTML starting with <!DOCTYPE html>
2. All styling must be inline style attributes (except one <style> block in <head> for body reset and @media print)
3. Cite data source next to every market number, e.g. "NGX close, 14 Mar 2026" or "NBS Dec 2025"
4. If a data point is unavailable write "N/A — not found" — never guess or fabricate numbers
5. Investment signals (ACCUMULATE/HOLD/REDUCE/WATCH) must be clearly labelled as analytical suggestions
6. The report must be genuinely beautiful, professional, and printable to A4 PDF`

  // @ts-ignore
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 8000,
    // @ts-ignore
    tools: [{ type: "web_search_20250305", name: "web_search" }] as any,
    messages: [{ role: 'user', content: prompt }],
  })

  const text = response.content
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('\n')

  return text
    .replace(/^```html\n?/i, '')
    .replace(/\n?```$/i, '')
    .trim() || '<p style="color:red;padding:20px;">Report generation failed — no content returned.</p>'
}
