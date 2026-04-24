import Anthropic from '@anthropic-ai/sdk'

// v21r: CIO Weekly Intelligence Brief engine.
// Cross-portfolio, investor-facing weekly brief powered by live web search.
// Used to anchor the weekly CIO conference call.

export interface CIOBriefPortfolio {
  id:            string
  name:          string
  label:         string
  clientName:    string
  clientCode:    string
  currency:      string
  starting_nav:  number
  start_date:    string | null
  current_nav:   number
  income_target: number
  holdings: Array<{
    instrument_id: string
    name:          string
    type:          string
    quantity:      number
    avg_cost:      number
    latest_price:  number
    market_value:  number
    weight:        number
  }>
}

export interface CIOBriefInput {
  portfolios:  CIOBriefPortfolio[]
  watchlist: Array<{
    ticker:    string
    name:      string
    section:   string
    sub_type:  string | null
    rank:      number
    rationale: string | null
  }>
  fxRate?:     number
  generatedBy?: string
}

function fmtM(n: number): string {
  return `\u20a6${(n / 1e6).toFixed(2)}M`
}

function buildCombinedPositions(portfolios: CIOBriefPortfolio[]): string {
  const combined: Record<string, {
    name: string; totalValue: number; price: number; avgCost: number; mandates: string[]
  }> = {}
  portfolios.forEach(p => {
    p.holdings.filter(h => h.type === 'Stock').forEach(h => {
      if (!combined[h.instrument_id]) {
        combined[h.instrument_id] = {
          name: h.name, totalValue: 0,
          price: h.latest_price, avgCost: h.avg_cost, mandates: [],
        }
      }
      combined[h.instrument_id].totalValue += h.market_value
      combined[h.instrument_id].mandates.push(`${p.clientCode}/${p.label}`)
    })
  })
  return Object.entries(combined)
    .sort(([, a], [, b]) => b.totalValue - a.totalValue)
    .map(([ticker, d]) =>
      `  ${ticker} (${d.name}): combined ${fmtM(d.totalValue)} | \u20a6${d.price.toFixed(2)}/share | avg cost \u20a6${d.avgCost.toFixed(2)} | held in: ${d.mandates.join(', ')}`)
    .join('\n')
}

function buildPrompt(input: CIOBriefInput): string {
  const { portfolios, watchlist, fxRate } = input
  const today    = new Date()
  const dateStr  = today.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const weekEnd  = today.toISOString().slice(0, 10)
  const yr       = today.getFullYear()

  const totalNAV      = portfolios.reduce((s, p) => s + p.current_nav, 0)
  const totalStarting = portfolios.reduce((s, p) => s + p.starting_nav, 0)
  const totalPnL      = totalNAV - totalStarting

  const allTickers = [...new Set(portfolios.flatMap(p =>
    p.holdings.filter(h => h.type === 'Stock').map(h => h.instrument_id)
  ))]

  const watchEquities = watchlist.filter(w => w.section === 'equity')
  const watchFI       = watchlist.filter(w => w.section === 'fixed_income')
  const watchEagle    = watchlist.filter(w => w.section === 'watch')
  const heldSet       = new Set(allTickers)
  const heldOnList    = watchEquities.filter(w => w.ticker && heldSet.has(w.ticker))
  const notHeldTop    = watchEquities.filter(w => w.ticker && !heldSet.has(w.ticker)).slice(0, 8)

  const combinedPositions = buildCombinedPositions(portfolios)

  return `You are the Chief Investment Officer at Transworld Investment and Securities, Lagos, Nigeria. You are preparing the weekly CIO Intelligence Brief for the week ending ${weekEnd}, to be read by clients, investors, marketers, and portfolio managers — and to anchor the weekly CIO conference call.

Write in flowing, authoritative prose — like a well-crafted weekly letter from a respected CIO. Your audience expects clear views, specific numbers, and forward guidance they can act on. Use paragraphs, not bullet points. Take clear positions. Be specific about Nigerian market conditions, companies, rates, and data.

\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
STEP 1 \u2014 RESEARCH (use web_search before writing)
\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

Search for current data on each of these topics before drafting:
1. NGX All-Share Index level and performance this week as of ${weekEnd}
2. CBN MPR current rate and any recent monetary policy signals or MPC communiques
3. Nigeria inflation \u2014 latest CPI print and trend direction ${yr}
4. USD/NGN current exchange rate and recent naira movement
5. Recent news for each key holding in our book: ${allTickers.join(', ')}
6. Brent crude oil price current level (relevant to energy sector holdings)
7. Any major Nigeria macroeconomic, regulatory, or political events this week

Use what you find to cite specific numbers throughout the brief. Where live data is unavailable, draw on your market knowledge with appropriate caveats.

\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
STEP 2 \u2014 PORTFOLIO CONTEXT
\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

COMBINED BOOK \u2014 WEEK ENDING ${weekEnd}
Generated: ${dateStr} | FX: ${fxRate ? `\u20a6${Math.round(fxRate).toLocaleString()}/USD` : 'see web search'}

Active mandates:   ${portfolios.length}
Combined NAV:      ${fmtM(totalNAV)}
Starting capital:  ${fmtM(totalStarting)}
Combined P&L:      ${fmtM(totalPnL)} since inception

PER-MANDATE SNAPSHOT:
${portfolios.map(p => {
  const pnl    = p.current_nav - p.starting_nav
  const pnlPct = p.starting_nav > 0 ? (pnl / p.starting_nav * 100).toFixed(1) + '%' : 'N/A'
  const top5   = p.holdings.filter(h => h.type === 'Stock').slice(0, 5).map(h => `${h.instrument_id} (${(h.weight * 100).toFixed(0)}%)`).join(', ')
  return `  [${p.clientCode}] ${p.clientName} \u2014 ${p.name}
    NAV: ${fmtM(p.current_nav)} | Starting: ${fmtM(p.starting_nav)} | Return since inception: ${pnlPct}
    Income target: ${(p.income_target * 100).toFixed(0)}% p.a.
    Holdings: ${top5 || 'none'}`
}).join('\n\n')}

COMBINED EQUITY BOOK (all positions across all mandates, ranked by combined value):
${combinedPositions || '  No equity holdings found.'}

WATCHLIST INTELLIGENCE:
  Held names confirmed on watchlist: ${heldOnList.map(w => `${w.ticker}(#${w.rank})`).join(', ') || 'none'}
  Top unowned watchlist names:       ${notHeldTop.map(w => `#${w.rank} ${w.ticker} \u2014 ${w.name}`).join(' | ') || 'none'}
  Fixed income watchlist (top 5):    ${watchFI.slice(0, 5).map(w => `${w.ticker || w.name} [${w.sub_type ?? ''}]`).join(', ')}
  Eagle-eye pipeline items:          ${watchEagle.map(w => w.name).join(', ') || 'none'}

\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
STEP 3 \u2014 WRITE THE CIO BRIEF
\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

Write each section as flowing narrative prose. Use ## for section headers, ### for sub-topics if needed. No bullet-point lists \u2014 write in complete paragraphs that a CIO can read from on a live call. Take clear views. Cite the data you searched for. Each section should be 3\u20135 paragraphs.

## Market Overview
Open with the dominant theme this week in Nigerian markets. Where did the NGX close and what moved it? Was it a risk-on or risk-off week? Discuss CBN policy stance, where short-term rates are sitting, naira stability, and the global macro backdrop relevant to Nigeria. Set the context authoritatively \u2014 cite the specific index level, MPR rate, and USD/NGN rate from your search. This is the section clients will quote most.

## Portfolio Performance and Positioning
Discuss how the combined book performed relative to the market environment. Which mandates had the strongest week and what drove it? How does the total combined NAV look week-on-week and since inception? Call out 2\u20133 specific positions across the book that are most noteworthy this week \u2014 whether they captured market moves, had fundamental news, or are on watch for action. Be candid about any positions underperforming expectations and explain what the investment thesis still is.

## Key Holdings Intelligence
This is the most important section for clients and portfolio managers on the call. For the key names in our book \u2014 ${allTickers.slice(0, 10).join(', ')} \u2014 provide a current intelligence update on each. What did your research surface? Earnings, management announcements, regulatory news, sector developments, analyst coverage? Be specific about which mandates hold each name in meaningful size. This section should read like an analyst calling in their intelligence brief from the floor.

## Macro and Sector Themes
Identify the 2\u20133 macro or sector themes that most matter for our combined book right now. For each theme \u2014 whether it's the CBN rate trajectory and financial stocks, oil prices and energy sector exposure, FX dynamics and consumer names, banking recapitalisation, or infrastructure spend \u2014 explain what you are observing and what it means for our positioning or the decisions the portfolio team should be considering in the weeks ahead.

## Watchlist Signals
What is the most compelling intelligence from the Transworld NGX Master Watchlist this week? Are any top-ranked names we don\u2019t yet own showing catalysts \u2014 price moves, earnings, sector tailwinds, or improved entry points \u2014 that make them more actionable? Are any positions we already hold starting to show reasons to review size? Comment on eagle-eye pipeline items if any are approaching a trigger. Give clients and the investment team a clear sense of where the next portfolio actions may come from.

## Outlook and Forward Positioning
Close with your 2\u20134 week forward view. What is the principal risk the combined book faces over this horizon? What is the most interesting opportunity? What specific events, data releases, or company announcements should clients and portfolio managers be watching? Signal any portfolio actions under consideration at an appropriate level of specificity. End with one or two sentences that give clients genuine confidence in the direction of the combined mandate \u2014 or an honest assessment of the key uncertainties.

---
*CIO Weekly Intelligence Brief \u2014 week ending ${weekEnd} | Transworld Investment and Securities*
*Discretionary Account Management. Prepared for distribution to clients and investors.*
*For informational purposes only. All investment decisions remain at the discretion of the portfolio manager.*`
}

export async function generateCIOBrief(input: CIOBriefInput): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const response = await (client.messages.create as any)({
    model:      'claude-sonnet-4-20250514',
    max_tokens: 4500,
    tools:      [{ type: 'web_search_20250305', name: 'web_search' }],
    messages:   [{ role: 'user', content: buildPrompt(input) }],
  })

  // Filter to text blocks only — discard tool_use and web_search_tool_result blocks
  const text = (response.content as any[])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text as string)
    .join('\n')
    .trim()

  return text || 'Brief generation failed \u2014 no content returned.'
}
