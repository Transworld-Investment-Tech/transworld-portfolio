import Anthropic from '@anthropic-ai/sdk'
import { Portfolio, Holding, SleeveTarget, computeNAV, computeSleeveData, fmt } from './portfolio'

export type ReportType = 'daily' | 'weekly' | 'monthly' | 'quarterly'

interface ReportInput {
  portfolio: Portfolio
  holdings: Holding[]
  sleeveDefs: SleeveTarget[]
  reportType: ReportType
  fxRate?: number
}

export async function generateAIReport(input: ReportInput): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const { portfolio, holdings, sleeveDefs, reportType, fxRate } = input
  const tot = computeNAV(holdings)
  const pl = tot - portfolio.starting_nav
  const ret = pl / portfolio.starting_nav
  const sv = computeSleeveData(holdings, sleeveDefs, tot)

  const today = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric'
  })

  const portfolioJSON = {
    reportDate: today,
    portfolioName: portfolio.name,
    clientName: portfolio.client?.name ?? 'N/A',
    nav: fmt.ngnM(tot),
    startingNAV: fmt.ngnM(portfolio.starting_nav),
    unrealizedPL: fmt.ngnM(pl),
    totalReturn: fmt.pct(ret),
    fxRate: fxRate ? `₦${Math.round(fxRate)}/USD` : 'N/A',
    sleeves: sv.map(s => ({
      name: s.name,
      target: fmt.pct(s.target_pct),
      actual: fmt.pct(s.act),
      value: fmt.ngnM(s.val),
      status: s.status,
      diff: (s.diff >= 0 ? '+' : '') + fmt.ngnM(s.diff),
    })),
    equities: holdings
      .filter(h => h.instrument?.type === 'Stock')
      .map(h => {
        const price = h.latest_price ?? h.avg_cost
        const val = h.quantity * price
        return {
          ticker: h.instrument_id,
          name: h.instrument?.name,
          shares: Math.round(h.quantity).toLocaleString(),
          price: `₦${price.toFixed(2)}`,
          dayChange: fmt.chg(h.day_change ?? 0),
          value: fmt.ngnM(val),
          weight: fmt.pct(val / tot),
          divYield: h.instrument?.coupon_pct ? `${h.instrument.coupon_pct}%` : 'N/A',
        }
      }),
    fixedIncome: holdings
      .filter(h => h.instrument?.type !== 'Stock')
      .map(h => {
        const price = h.latest_price ?? h.avg_cost
        return {
          name: h.instrument?.name,
          type: h.instrument?.type,
          faceValue: fmt.ngnM(h.quantity),
          marketValue: fmt.ngnM(h.quantity * price),
          yield: h.instrument?.coupon_pct ? `${h.instrument.coupon_pct}%` : 'N/A',
        }
      }),
  }

  const prompt = `You are a senior investment analyst at Transworld Asset Management, Lagos, Nigeria. Write a professional ${reportType.toUpperCase()} PORTFOLIO REPORT.

STEP 1 — MARKET RESEARCH: Use web_search to find the latest real data on:
1. CBN monetary policy rate (MPR), last MPC decision date and direction of travel
2. Latest Nigerian NTB auction results: 91-day, 182-day, 364-day stop rates
3. FGN Bond secondary market yields: benchmark 5yr, 7yr, 10yr
4. NGX All-Share Index (ASI) latest close, day change, YTD return, market capitalisation
5. Individual NGX stock prices: UBA, GTCO, Zenith Bank (ZENITHBANK), Dangote Cement (DANGCEM), Stanbic IBTC (STANBIC), Seplat Energy (SEPLAT)
6. USD/NGN exchange rate (NAFEM official and street rate if available)
7. Latest Nigeria headline CPI inflation (NBS data)
8. Key Nigerian macroeconomic and market news this week
9. Global context: US Fed rate expectations, oil price (Brent crude)

STEP 2 — WRITE THE REPORT using the structure below. Cite actual figures from your search. Be direct and specific — this is a professional document read by the portfolio manager before trading.

=== PORTFOLIO DATA ===
${JSON.stringify(portfolioJSON, null, 2)}

=== MANDATE ===
${sleeveDefs.map(s => `${s.name}: ${fmt.pct(s.target_pct)} target (${fmt.pct(s.min_pct)}–${fmt.pct(s.max_pct)} range)`).join('\n')}
Income target: ${fmt.pct(portfolio.income_target)} p.a. blended
Capital appreciation: ${fmt.pct(portfolio.cap_target)} p.a.
Max single equity: ${fmt.pct(portfolio.max_eq_single)} of NAV | Max equity sleeve: ${fmt.pct(portfolio.max_eq_sleeve)}
Drawdown alert: ${fmt.pct(portfolio.dd_alert)} | Action: ${fmt.pct(portfolio.dd_action)}

===

## ${portfolio.name.toUpperCase()} — ${reportType.toUpperCase()} REPORT
### ${today}

## 1. EXECUTIVE SUMMARY
[4–5 crisp sentences. Lead with the most important development. State the portfolio's headline performance. Call out the single most urgent action.]

## 2. PORTFOLIO PERFORMANCE SNAPSHOT
| Metric | Value |
[NAV, P&L vs starting NAV, total return %, estimated income YTD, income vs target, unrealized P&L by sleeve]

## 3. NIGERIAN MARKET COMMENTARY
### 3a. Monetary policy & rates
[CBN MPR level, last MPC decision, direction, OMO operations, inflation — what it means for NTBs and bonds]

### 3b. NGX equity market
[ASI level, YTD performance, banking sector tone, volume, notable movers relevant to this portfolio]

### 3c. Fixed income market
[NTB stop rates by tenor, FGN bond yields, duration view — is the yield curve attractive? Rate cut timing?]

### 3d. Foreign exchange & macro
[NAFEM rate, NGN stability vs USD, Brent oil price, FX outlook and impact on Seplat, importers]

## 4. SLEEVE-BY-SLEEVE ANALYSIS

### 4a. Liquidity (target ${fmt.pct(sleeveDefs.find(s=>s.sleeve_id==='liq')?.target_pct??0.05)})
[Status, sufficiency for ops buffer, any immediate needs]

### 4b. NTB ladder — income core (target ${fmt.pct(sleeveDefs.find(s=>s.sleeve_id==='ntb')?.target_pct??0.40)})
[91D, 182D, 364D rates vs current holdings. Should we roll, extend, or shift tenor? Expected income contribution.]

### 4c. FGN bonds — rate-cut upside (target ${fmt.pct(sleeveDefs.find(s=>s.sleeve_id==='fgn')?.target_pct??0.25)})
[Mark-to-market on 5–7yr and 10yr buckets. Duration view. Expected capital gain if CBN cuts 100–200bps.]

### 4d. Equities — total return (target ${fmt.pct(sleeveDefs.find(s=>s.sleeve_id==='eq')?.target_pct??0.30)})
[Comment on each stock individually: UBA, GTCO, Zenith Bank, Dangote Cement, Stanbic IBTC, Seplat Energy. 
For each: price action, valuation, dividend outlook, position sizing vs limit]

## 5. RISK & COMPLIANCE REVIEW
| Check | Status | Detail |
[Sleeve allocation breaches, concentration limits, drawdown status, top 3 risks to portfolio over next 30 days]

## 6. REBALANCING RECOMMENDATIONS
[Specific proposed trades: Instrument | Direction | Estimated size (₦M) | Rationale | Priority]

## 7. PRIORITY ACTION LIST FOR PORTFOLIO MANAGER
1. [Most urgent — specific instrument, action, size, rationale]
2.
3.
4.
5.

---
*Report generated ${today} by Transworld Portfolio Intelligence Platform.*
*Data sources: CBN, DMO, FMDQ, NGX Group, NBS. Prices from Apify/TradingView. AI-assisted analysis: Anthropic Claude.*`

  // @ts-ignore — web_search tool type
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 4000,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: [{ role: 'user', content: prompt }],
  })

  return response.content
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('\n') || 'Report generation failed — no content returned.'
}
