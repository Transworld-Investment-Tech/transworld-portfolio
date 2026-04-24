import Anthropic from '@anthropic-ai/sdk'

// v21r-hotfix-1: Three fixes:
//   1. Self-talk stripped — take LAST text block only; earlier blocks are
//      the model's "I'll research..." preamble emitted before web searches.
//   2. Prompt instructs model to start IMMEDIATELY with ## Market Overview.
//   3. Prompt requests markdown tables + blockquote metric callouts so the
//      renderer can produce proper tables and KPI cards.

export interface CIOBriefPortfolio {
  id: string; name: string; label: string
  clientName: string; clientCode: string; currency: string
  starting_nav: number; start_date: string | null
  current_nav: number; income_target: number
  holdings: Array<{
    instrument_id: string; name: string; type: string
    quantity: number; avg_cost: number; latest_price: number
    market_value: number; weight: number
  }>
}

export interface CIOBriefInput {
  portfolios:   CIOBriefPortfolio[]
  watchlist: Array<{
    ticker: string; name: string; section: string
    sub_type: string | null; rank: number; rationale: string | null
  }>
  fxRate?:      number
  generatedBy?: string
}

function fmtM(n: number): string {
  return '\u20a6' + (n / 1e6).toFixed(2) + 'M'
}

function buildCombinedPositions(portfolios: CIOBriefPortfolio[]): string {
  const combined: Record<string, {
    name: string; totalValue: number; price: number; avgCost: number; mandates: string[]
  }> = {}
  portfolios.forEach(p => {
    p.holdings.filter(h => h.type === 'Stock').forEach(h => {
      if (!combined[h.instrument_id]) combined[h.instrument_id] = {
        name: h.name, totalValue: 0, price: h.latest_price, avgCost: h.avg_cost, mandates: [],
      }
      combined[h.instrument_id].totalValue += h.market_value
      combined[h.instrument_id].mandates.push(p.clientCode + '/' + p.label)
    })
  })
  return Object.entries(combined)
    .sort(([, a], [, b]) => b.totalValue - a.totalValue)
    .map(([ticker, d]) =>
      '  ' + ticker + ' (' + d.name + '): combined ' + fmtM(d.totalValue) +
      ' | \u20a6' + d.price.toFixed(2) + '/share | avg cost \u20a6' + d.avgCost.toFixed(2) +
      ' | held in: ' + d.mandates.join(', '))
    .join('\n')
}

function buildPrompt(input: CIOBriefInput): string {
  const { portfolios, watchlist, fxRate } = input
  const today   = new Date()
  const dateStr = today.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const weekEnd = today.toISOString().slice(0, 10)
  const yr      = today.getFullYear()

  const totalNAV      = portfolios.reduce((s, p) => s + p.current_nav, 0)
  const totalStarting = portfolios.reduce((s, p) => s + p.starting_nav, 0)
  const totalPnL      = totalNAV - totalStarting

  const allTickers = [...new Set(portfolios.flatMap(p =>
    p.holdings.filter(h => h.type === 'Stock').map(h => h.instrument_id)))]

  const watchEquities = watchlist.filter(w => w.section === 'equity')
  const watchFI       = watchlist.filter(w => w.section === 'fixed_income')
  const watchEagle    = watchlist.filter(w => w.section === 'watch')
  const heldSet       = new Set(allTickers)
  const heldOnList    = watchEquities.filter(w => w.ticker && heldSet.has(w.ticker))
  const notHeldTop    = watchEquities.filter(w => w.ticker && !heldSet.has(w.ticker)).slice(0, 8)

  const combinedPositions = buildCombinedPositions(portfolios)

  return `You are the Chief Investment Officer at Transworld Investment and Securities, Lagos, Nigeria. You are preparing the weekly CIO Intelligence Brief for the week ending ${weekEnd}, for distribution to clients, investors, and the weekly CIO conference call.

Write in flowing, authoritative prose — like a well-crafted weekly letter from a respected CIO. Your audience expects clear views, specific numbers, and actionable forward guidance. Use paragraphs, not bullets. Take clear positions.

CRITICAL INSTRUCTION: Begin your response IMMEDIATELY with the section header "## Market Overview" — do not include any text about your research process, no "I'll search", no "let me look up", no preamble of any kind. The very first characters of your response must be "## Market Overview".

\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
STEP 1 — USE WEB SEARCH (do this silently, then write)
\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

Search for: NGX ASI level and weekly performance ${weekEnd}, CBN MPR current rate, Nigeria CPI inflation ${yr}, USD/NGN exchange rate today, Brent crude price today, recent news for: ${allTickers.join(', ')}

\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
STEP 2 — PORTFOLIO CONTEXT
\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

COMBINED BOOK — WEEK ENDING ${weekEnd}
Generated: ${dateStr} | FX: ${fxRate ? '\u20a6' + Math.round(fxRate).toLocaleString() + '/USD' : 'see search'}

Active mandates:   ${portfolios.length}
Combined NAV:      ${fmtM(totalNAV)}
Starting capital:  ${fmtM(totalStarting)}
Combined P&L:      ${fmtM(totalPnL)} since inception

PER-MANDATE SNAPSHOT:
${portfolios.map(p => {
  const pnl    = p.current_nav - p.starting_nav
  const pnlPct = p.starting_nav > 0 ? (pnl / p.starting_nav * 100).toFixed(1) + '%' : 'N/A'
  const top5   = p.holdings.filter(h => h.type === 'Stock').slice(0, 5)
    .map(h => h.instrument_id + ' (' + (h.weight * 100).toFixed(0) + '%)').join(', ')
  return '  [' + p.clientCode + '] ' + p.clientName + ' \u2014 ' + p.name + '\n' +
    '    NAV: ' + fmtM(p.current_nav) + ' | Starting: ' + fmtM(p.starting_nav) + ' | Return: ' + pnlPct + '\n' +
    '    Income target: ' + (p.income_target * 100).toFixed(0) + '% p.a.\n' +
    '    Holdings: ' + (top5 || 'none')
}).join('\n\n')}

COMBINED EQUITY BOOK:
${combinedPositions || '  No equity positions.'}

WATCHLIST:
  Held + on watchlist: ${heldOnList.map(w => w.ticker + '(#' + w.rank + ')').join(', ') || 'none'}
  Top unowned: ${notHeldTop.map(w => '#' + w.rank + ' ' + w.ticker + ' \u2014 ' + w.name).join(' | ') || 'none'}
  FI watchlist (top 5): ${watchFI.slice(0, 5).map(w => (w.ticker || w.name) + ' [' + (w.sub_type ?? '') + ']').join(', ')}
  Eagle-eye: ${watchEagle.map(w => w.name).join(', ') || 'none'}

\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
STEP 3 — WRITE THE BRIEF (start with ## Market Overview)
\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

FORMATTING REQUIREMENTS — follow exactly:

1. Start immediately with "## Market Overview" — no preamble whatsoever.

2. Use blockquote lines (starting with "> ") for key metric callouts at the start of Market Overview:
   > **NGX All-Share Index:** [level] | [weekly change] | YTD: [change]
   > **CBN Policy Rate:** [rate] | [last action]
   > **USD/NGN:** [rate] | [trend]
   > **Brent Crude:** [price] | [weekly change]
   > **Nigeria CPI:** [latest print] | [trend]

3. Use markdown tables for structured data:
   - In "## Portfolio Performance and Positioning": include a mandate performance table:
     | Mandate | Client | Current NAV | P&L Since Inception | Return |
     |---|---|---|---|---|
   - In "## Key Holdings Intelligence": include a holdings snapshot table:
     | Ticker | Name | Combined Value | Weight | Cost | Price | P&L % |
     |---|---|---|---|---|---|---|
   - In "## Macro and Sector Themes": include a macro snapshot table if helpful

4. Use ### for sub-section headers (e.g., ### Banking Sector, ### Energy & Oil)
5. Use #### for individual stock headers within Key Holdings (e.g., #### GTCO — Core Holding)
6. Write all prose in flowing narrative paragraphs with full sentences. No bullet points.

SECTION STRUCTURE:

## Market Overview
[Start with the 5 blockquote metric lines above, then 3-4 narrative paragraphs]

## Portfolio Performance and Positioning
[Mandate performance table, then 3-4 narrative paragraphs on the combined book]

## Key Holdings Intelligence
[Holdings snapshot table, then individual stock coverage using #### headers]

## Macro and Sector Themes
[2-3 themed sub-sections using ### headers, each 2 paragraphs]

## Watchlist Signals
[2-3 paragraphs on watchlist opportunities and eagle-eye items]

## Outlook and Forward Positioning
[3-4 paragraphs closing the brief — risk, opportunity, forward actions]

---
*CIO Weekly Intelligence Brief \u2014 week ending ${weekEnd} | Transworld Investment and Securities*
*Discretionary Account Management. For distribution to clients and investors.*`
}

export async function generateCIOBrief(input: CIOBriefInput): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const response = await (client.messages.create as any)({
    model:      'claude-sonnet-4-20250514',
    max_tokens: 5000,
    tools:      [{ type: 'web_search_20250305', name: 'web_search' }],
    messages:   [{ role: 'user', content: buildPrompt(input) }],
  })

  // Fix for self-talk: take LAST non-empty text block only.
  // The model emits intermediate text blocks ("I'll search...") before
  // each web search call. The actual brief is always the final text block.
  const textBlocks = (response.content as any[])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => (b.text as string).trim())
    .filter(t => t.length > 0)

  const text = textBlocks.length > 0
    ? textBlocks[textBlocks.length - 1]
    : 'Brief generation failed — no content returned.'

  return text
}
