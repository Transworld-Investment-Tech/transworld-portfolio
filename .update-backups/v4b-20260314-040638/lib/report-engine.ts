import Anthropic from '@anthropic-ai/sdk'
import { Portfolio, Holding, SleeveTarget, computeNAV, computeSleeveData, fmt } from './portfolio'
import { fetchMarketSnapshot } from './market-snapshot'

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
  const { portfolio, holdings, sleeveDefs, reportType, dateFrom, dateTo } = input

  const tot    = computeNAV(holdings)
  const pl     = tot - portfolio.starting_nav
  const ret    = pl / portfolio.starting_nav
  const sv     = computeSleeveData(holdings, sleeveDefs, tot)
  const period = periodLabel(reportType, dateFrom, dateTo)
  const today  = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })

  const equities  = holdings.filter(h => h.instrument?.type === 'Stock')
  const fixedInc  = holdings.filter(h => h.instrument?.type !== 'Stock')
  const tickers   = equities.map(h => h.instrument_id)

  // Pre-fetch market data (no web_search tool needed)
  const market = await fetchMarketSnapshot(tickers, process.env.APIFY_API_KEY)

  // Build compact portfolio summary
  const portfolioData = {
    name:      portfolio.name,
    client:    (portfolio as any).client?.name ?? 'N/A',
    period,
    nav:       fmt.ngnM(tot),
    startNav:  fmt.ngnM(portfolio.starting_nav),
    pl:        fmt.ngnM(pl),
    plSign:    pl >= 0 ? 'positive' : 'negative',
    ret:       fmt.pct(ret),
    targets:   { income: fmt.pct(portfolio.income_target), cap: fmt.pct(portfolio.cap_target) },
    limits:    { maxEqSingle: fmt.pct(portfolio.max_eq_single), maxEqSleeve: fmt.pct(portfolio.max_eq_sleeve), ddAlert: fmt.pct(portfolio.dd_alert), ddAction: fmt.pct(portfolio.dd_action) },
    sleeves:   sv.map(s => ({ name: s.name, target: fmt.pct(s.target_pct), actual: fmt.pct(s.act), value: fmt.ngnM(s.val), status: s.status, diff: (s.diff >= 0 ? '+' : '') + fmt.ngnM(s.diff) })),
    equities:  equities.map(h => {
      const p = h.latest_price ?? h.avg_cost
      const v = h.quantity * p
      const mkt = market.stocks[h.instrument_id]
      return {
        ticker:   h.instrument_id,
        name:     h.instrument?.name ?? h.instrument_id,
        shares:   Math.round(h.quantity).toLocaleString(),
        avgCost:  `₦${h.avg_cost.toFixed(2)}`,
        mktPrice: mkt?.price ?? `₦${p.toFixed(2)}`,
        dayChg:   mkt?.change ?? fmt.chg(h.day_change ?? 0),
        value:    fmt.ngnM(v),
        weight:   fmt.pct(v / tot),
        unrlPL:   fmt.ngnM(v - h.quantity * h.avg_cost),
        divYield: h.instrument?.coupon_pct ? `${h.instrument.coupon_pct}%` : 'N/A',
      }
    }),
    fixedInc: fixedInc.map(h => ({
      name:      h.instrument?.name ?? h.instrument_id,
      type:      h.instrument?.type ?? 'Fixed Income',
      face:      fmt.ngnM(h.quantity),
      mktVal:    fmt.ngnM(h.quantity * (h.latest_price ?? h.avg_cost)),
      yield:     h.instrument?.coupon_pct ? `${h.instrument.coupon_pct}%` : 'N/A',
    })),
    mandate:   sleeveDefs.map(s => `${s.name}: ${fmt.pct(s.target_pct)} target (${fmt.pct(s.min_pct)}–${fmt.pct(s.max_pct)})`).join(' | '),
  }

  const prompt = `You are a senior investment analyst at Transworld Asset Management, Lagos.
Generate a professional ${reportType.toUpperCase()} portfolio report for: ${period}
Report generated: ${today}

=== PRE-FETCHED MARKET DATA (use this directly — do not search for it) ===
FX Rate: ${market.fx.usdNgn} (${market.fx.source})
CBN MPR: ${market.cbr.mpr}
Inflation: ${market.cbr.inflation}
Last MPC: ${market.cbr.lastMPC}
NTB Rates — 91D: ${market.ntbRates.d91} | 182D: ${market.ntbRates.d182} | 364D: ${market.ntbRates.d364}
FGN Yields — 5yr: ${market.fgnYields.y5} | 10yr: ${market.fgnYields.y10}
NGX ASI: ${market.ngxASI.level} (Day: ${market.ngxASI.change}, YTD: ${market.ngxASI.ytd})
Brent Crude: ${market.brent.price} (${market.brent.change})
Data fetched: ${market.fetchedAt}

Stock prices from Apify:
${Object.values(market.stocks).map(s => `${s.ticker}: ${s.price} (${s.change}) — ${s.source}`).join('\n')}

=== PORTFOLIO DATA ===
${JSON.stringify(portfolioData, null, 1)}

=== YOUR TASK ===
Using the market data above PLUS your training knowledge about these Nigerian stocks and markets,
generate a complete, beautiful HTML portfolio report.

For each equity holding, use your knowledge to provide:
- P/E ratio estimate and P/B ratio (based on recent data you know)
- Dividend yield and approximate ex-dividend timing
- Recent earnings commentary (beat/miss based on your knowledge)
- Investment signal: ACCUMULATE / HOLD / REDUCE / WATCH with clear rationale
- 52-week price range (approximate based on your knowledge)

For macro commentary, use the pre-fetched data above plus your knowledge of:
- CBN policy trajectory and implications
- NGX sector dynamics (banking recapitalisation, consumer sector, oil & gas)
- Nigeria's fiscal and FX outlook

Output ONLY a complete HTML document starting with <!DOCTYPE html>. No markdown. No text before the doctype.

HTML DESIGN — inline styles only (one <style> reset block in <head> allowed):
Colors: navy #0f1923, gold #c9a84c, bg #f0f2f5, cards white, green #22c55e, red #ef4444, amber #f59e0b, purple #8b5cf6, blue #3b82f6
Font: Segoe UI/Arial. Max-width 960px centered. 40px side padding. Printable A4.

SECTIONS:

1. HEADER — full-width navy band. Left: "TRANSWORLD ASSET MANAGEMENT" gold 11px uppercase tracked, portfolio name white 26px bold, report type + period grey. Right: date + gold "CONFIDENTIAL" badge. 4px gold bottom border.

2. EXECUTIVE SUMMARY — white card, 4px gold left border. "EXECUTIVE SUMMARY" gold uppercase label. 4-5 sentences. Bold key number. Last sentence bold = single most urgent action.

3. KPI STRIP — 5 equal flex cards:
   Current NAV (gold top border) | P&L vs Start (green/red) | Total Return % (green/red) | Drawdown (green/amber/red) | Income Progress (purple)
   Each: 11px grey label top, 24px bold monospace number, 11px grey sub-label.

4. ALLOCATION vs TARGETS — "PORTFOLIO ALLOCATION" heading.
   Table: Sleeve | Target% | Actual% | Value(₦M) | Diff | Status badge | Action
   CSS progress bar per sleeve: filled=actual%, thin vertical line=target%.
   Green bar=OK, red=BREACH, amber=OVER. Colored pill badges.

5. MARKET COMMENTARY — 2×2 card grid, each with colored left border (4px):
   A. MONETARY POLICY & RATES (blue #3b82f6) — MPR table, inflation, rate direction outlook
   B. NGX EQUITY MARKET (green) — ASI data, sector themes, banking recapitalisation update
   C. FIXED INCOME (purple) — NTB rates table by tenor, FGN yields, roll/extend recommendation
   D. FX & MACRO (amber) — USD/NGN, Brent, top 3 risks to portfolio next 30-90 days

6. EQUITY HOLDINGS DEEP-DIVE — one card per equity:
   Header: dark ticker badge (gold text) | company name bold | market price 20px | day change pill green/red
   Row 1: Shares | Avg cost | Unrealized P&L (green/red) | Weight %
   Row 2: P/E | P/B | Div yield | Ex-div date | Earnings badge (BEAT/MISS/IN-LINE)
   Row 3: 52-wk range | Sector | Market cap (est.) | Beta vs ASI
   SIGNAL BANNER — full width colored footer on card:
     ACCUMULATE (green) / HOLD (blue) / REDUCE (red) / WATCH (amber)
     2-3 sentences of rationale citing specific data
     Italic small: "Analytical suggestion — portfolio manager discretion applies."

7. FIXED INCOME ANALYSIS — table: Instrument | Type | Face Val | Mkt Val | Yield | Duration view | Recommendation

8. RISK DASHBOARD — "RISK & COMPLIANCE MONITOR"
   Table: Check | Current | Threshold | Status badge | Action required
   Rows: Liquidity%, Max single equity%, Equity sleeve%, Drawdown status, Income on track

9. REBALANCING GUIDE — table:
   Sleeve | Target(₦M) | Actual(₦M) | Gap(₦M) | Action | Instrument(s) | Priority badge
   Priority: IMMEDIATE(red) | THIS WEEK(amber) | THIS MONTH(blue) | ON TRACK(grey)

10. PRIORITY ACTIONS 1-5 — numbered:
    Bold action title | Instrument + size | Rationale (cite data) | Expected impact | Urgency badge

11. FOOTER — grey bg, 11px.
    "This report is prepared by Transworld Asset Management. AI-assisted analytical suggestions do not constitute investment advice. The portfolio manager retains full discretion over all investment decisions. Market data sourced from public sources as at ${today}."

RULES:
- Output ONLY valid HTML starting with <!DOCTYPE html>
- All CSS inline except one <style> block in <head> for body reset + @media print
- Cite data source next to market numbers (e.g. "exchangerate-api.com" or "Apify/TradingView")
- If a value is unknown write "est." or "N/A" — never fabricate precise numbers
- Signals clearly labelled as analytical suggestions
- Make it genuinely beautiful and printable`

  // No web_search tool — Claude uses pre-fetched data + training knowledge
  const response = await client.messages.create({
    model:      'claude-sonnet-4-20250514',
    max_tokens: 7000,
    messages:   [{ role: 'user', content: prompt }],
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
