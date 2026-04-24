import Anthropic from '@anthropic-ai/sdk'

// v21r-hotfix-2: Fix text extraction.
// Root cause: taking the last text block only captures the final chunk
// when the model searches mid-response and emits the brief in pieces.
// Fix: join all text blocks, then find the first ## header and strip
// any self-talk preamble before it.

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

Write in flowing, authoritative prose. Your audience expects clear views, specific numbers, and actionable forward guidance. Use narrative paragraphs throughout. Take clear positions.

CRITICAL INSTRUCTION: Your response must begin IMMEDIATELY with "## Market Overview" as the very first text. Do not write any preamble, commentary about your research, or meta-text. Start directly with the section header.

\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
STEP 1 \u2014 SEARCH (do silently, write nothing until Step 3)
\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

Search for: NGX All-Share Index ${weekEnd} performance, CBN MPR current ${yr}, Nigeria CPI inflation latest ${yr}, USD NGN exchange rate today, Brent crude price today, recent news for ${allTickers.slice(0, 6).join(' ')}

\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
STEP 2 \u2014 PORTFOLIO CONTEXT
\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

COMBINED BOOK \u2014 WEEK ENDING ${weekEnd}
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

COMBINED EQUITY BOOK (ranked by combined value):
${combinedPositions || '  No equity positions.'}

WATCHLIST:
  Held + on watchlist: ${heldOnList.slice(0, 10).map(w => w.ticker + '(#' + w.rank + ')').join(', ') || 'none'}
  Top unowned:         ${notHeldTop.map(w => '#' + w.rank + ' ' + w.ticker + ' \u2014 ' + w.name).join(' | ') || 'none'}
  FI watchlist (top 5): ${watchFI.slice(0, 5).map(w => (w.ticker || w.name) + ' [' + (w.sub_type ?? '') + ']').join(', ')}
  Eagle-eye:           ${watchEagle.map(w => w.name).join(', ') || 'none'}

\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
STEP 3 \u2014 WRITE (start with ## Market Overview, no preamble)
\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

FORMATTING REQUIREMENTS:
1. Start IMMEDIATELY with "## Market Overview" \u2014 no preamble whatsoever.
2. After the ## Market Overview header, add 5 blockquote lines (> text) for key metrics:
   > **NGX All-Share Index:** [level] | [weekly change] | YTD: [change]
   > **CBN Policy Rate:** [rate] | [last action and date]
   > **USD/NGN:** [\u20a6 rate] | [monthly trend]
   > **Brent Crude:** [$price/bbl] | [weekly change]
   > **Nigeria CPI:** [latest %] | [trend direction]
3. Use markdown tables (| col | col |) in:
   - Portfolio Performance: mandate performance table (Mandate | Client | NAV | Return)
   - Key Holdings: holdings snapshot table (Ticker | Combined Value | Weight | Cost | Price | P&L%)
4. Use ### for sub-section headers, #### for individual stock analysis headers
5. Write all body text as flowing narrative paragraphs. No bullet point lists.

SECTIONS TO WRITE:

## Market Overview
[5 blockquote metric lines, then 3\u20134 narrative paragraphs on the week's market environment]

## Portfolio Performance and Positioning
[Mandate performance table, then narrative on combined book performance and key movers]

## Key Holdings Intelligence
[Holdings snapshot table, then individual stock analysis using #### TICKER \u2014 Name headers]

## Macro and Sector Themes
[2\u20133 themed ### sub-sections covering the dominant macro themes for our holdings]

## Watchlist Signals
[Narrative on most compelling watchlist opportunities and eagle-eye items this week]

## Outlook and Forward Positioning
[3\u20134 paragraphs on forward view, key risks, opportunities, and portfolio actions]

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

  // --- TEXT EXTRACTION FIX (v21r-hotfix-2) ---
  // Root cause of hotfix-1 regression: "take last text block" was wrong.
  // The model may do additional searches mid-response, splitting the brief
  // across multiple text blocks. Taking only the last block gives just the
  // closing paragraph.
  //
  // Correct approach:
  //   1. Join ALL text blocks (captures the full brief regardless of splits)
  //   2. Strip any self-talk preamble before the first ## section header
  //
  const textBlocks = (response.content as any[])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => (b.text as string).trim())
    .filter(t => t.length > 0)

  const allText = textBlocks.join('\n\n').trim()

  // Find the first ## header and strip everything before it
  const startsWithH2  = allText.startsWith('## ')
  const firstH2Index  = allText.indexOf('\n## ')
  const text = startsWithH2
    ? allText
    : firstH2Index >= 0
      ? allText.slice(firstH2Index + 1)
      : allText

  return text || 'Brief generation failed \u2014 no content returned.'
}
