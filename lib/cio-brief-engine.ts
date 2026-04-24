import Anthropic from '@anthropic-ai/sdk'
import { REPORT_TONE_INSTRUCTION } from './report-tone'

// v21s: CIO Weekly Intelligence Brief engine.
// Combines v21r-hotfix-2 (join all text blocks + strip preamble) with
// v21s (plain-language tone instruction, investor-friendly voice).

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

  return `You are the Chief Investment Officer at Transworld Investment and Securities, Lagos, Nigeria.
You are preparing the weekly CIO Intelligence Brief for the week ending ${weekEnd}.

${REPORT_TONE_INSTRUCTION}

CRITICAL: Your response must begin IMMEDIATELY with "## Market Overview". No preamble.
Start with the ## header as the very first characters of your response.

STEP 1 — SEARCH SILENTLY (do not write anything yet):
NGX All-Share Index ${weekEnd}, CBN MPR current ${yr}, Nigeria CPI ${yr},
USD NGN rate today, Brent crude today, news for: ${allTickers.slice(0, 6).join(' ')}

STEP 2 — PORTFOLIO CONTEXT:
Week ending ${weekEnd} | Generated ${dateStr}
FX: ${fxRate ? '\u20a6' + Math.round(fxRate).toLocaleString() + '/USD' : 'see search'}
Active mandates: ${portfolios.length} | Combined NAV: ${fmtM(totalNAV)}
Starting capital: ${fmtM(totalStarting)} | Combined P&L: ${fmtM(totalPnL)} since inception

${portfolios.map(p => {
  const pnl    = p.current_nav - p.starting_nav
  const pnlPct = p.starting_nav > 0 ? (pnl / p.starting_nav * 100).toFixed(1) + '%' : 'N/A'
  return '[' + p.clientCode + '] ' + p.clientName + ' \u2014 ' + p.name + ': ' +
    fmtM(p.current_nav) + ' | return ' + pnlPct + ' | income target ' + (p.income_target*100).toFixed(0) + '%'
}).join('\n')}

Combined equity book: ${combinedPositions || 'none'}
Held on watchlist: ${heldOnList.slice(0,10).map(w=>w.ticker+'(#'+w.rank+')').join(', ')||'none'}
Top unowned: ${notHeldTop.map(w=>'#'+w.rank+' '+w.ticker).join(', ')||'none'}
FI watchlist: ${watchFI.slice(0,5).map(w=>(w.ticker||w.name)+'['+w.sub_type+']').join(', ')}
Eagle-eye: ${watchEagle.map(w=>w.name).join(', ')||'none'}

STEP 3 — WRITE (start immediately with ## Market Overview, no preamble):

## Market Overview
[5 blockquote lines: > **NGX All-Share:** level | weekly change | YTD]
[> **CBN Rate:** rate — plain-English description]
[> **USD/NGN:** rate | trend]  [> **Brent Crude:** price | change]  [> **Nigeria CPI:** % | trend]
[Then 3–4 narrative paragraphs using plain language and analogies per tone rules]

## How Our Portfolios Are Performing This Week
[Table: | Mandate | Client | Current Value | Gain Since We Started | Annual Return |]
[Narrative: combined book in plain terms — what worked, what to watch, explained simply]

## What's Happening With Our Key Investments
[Table: | Company | Ticker | Combined Value | Our Share | Bought At | Today’s Price | Gain/Loss |]
[Per-stock analysis using #### Company (TICKER) headers — written for a non-specialist with analogies]

## The Bigger Picture: What’s Moving Markets
[2–3 themed ### sub-sections on macro themes, each with a plain-language analogy]

## Our Watchlist: What We’re Watching to Buy Next
[Plain narrative on watchlist signals, opportunities, eagle-eye items]

## Our Outlook: What Comes Next
[3–4 honest, plain-language paragraphs on risks and opportunities ahead]

---
*CIO Weekly Intelligence Brief — week ending ${weekEnd} | Transworld Investment and Securities*`
}

export async function generateCIOBrief(input: CIOBriefInput): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const response = await (client.messages.create as any)({
    model:      'claude-sonnet-4-20250514',
    max_tokens: 5000,
    tools:      [{ type: 'web_search_20250305', name: 'web_search' }],
    messages:   [{ role: 'user', content: buildPrompt(input) }],
  })
  // Join ALL text blocks, then strip self-talk before first ## header
  const textBlocks = (response.content as any[])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => (b.text as string).trim())
    .filter(t => t.length > 0)
  const allText      = textBlocks.join('\n\n').trim()
  const startsWithH2 = allText.startsWith('## ')
  const firstH2      = allText.indexOf('\n## ')
  return startsWithH2 ? allText : firstH2 >= 0 ? allText.slice(firstH2 + 1) : allText
}
