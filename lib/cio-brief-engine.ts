import Anthropic from '@anthropic-ai/sdk'
import { REPORT_TONE_INSTRUCTION } from './report-tone'

// v21s-hotfix-1: CIO Brief prompt redesign.
//   1. Pure flowing narrative throughout — NO markdown tables in body sections
//   2. ONE summary table at the very top (Portfolio at a Glance)
//   3. New "Corporate Intelligence" section — earnings, dividends, corporate
//      actions, volumes, director dealings: things an investment professional
//      catches that a casual observer misses
//   4. Tone instruction from v21s remains

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
      '  ' + ticker + ' (' + d.name + '): ' + fmtM(d.totalValue) +
      ' | price \u20a6' + d.price.toFixed(2) +
      ' | cost \u20a6' + d.avgCost.toFixed(2) +
      ' | ' + d.mandates.join(', '))
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
You are preparing the weekly CIO Intelligence Brief for the week ending ${weekEnd},
for distribution to all clients, investors, and the weekly CIO conference call.

${REPORT_TONE_INSTRUCTION}

CRITICAL FORMATTING RULES (follow precisely):
- Start your response IMMEDIATELY with "## Market Snapshot" — no preamble, no research commentary.
- The brief must be PURE FLOWING NARRATIVE throughout. No markdown tables in any section
  EXCEPT the single "Portfolio at a Glance" table described under ## Market Snapshot.
- Do NOT create tables for holdings, stock analysis, or macro data. Write these as prose.
- Use blockquotes (lines starting with "> ") ONLY for the 5 market metrics under Market Snapshot.
- Use ### for sub-section headers within sections where helpful.
- Write every section as connected paragraphs — like a well-crafted weekly letter.

══════════════════════════════════════
STEP 1 — SEARCH SILENTLY. Do not write anything until Step 3.
══════════════════════════════════════

Search for the following topics now. Write nothing yet.

MARKET DATA: NGX All-Share Index ${weekEnd} performance level, CBN MPR current rate ${yr},
Nigeria inflation CPI latest ${yr}, USD NGN exchange rate today, Brent crude price today

COMPANY INTELLIGENCE for each held stock (${allTickers.join(', ')}):
- Recent earnings results or profit announcements
- Dividend declarations, increases, cuts, or suspensions
- Corporate actions: rights issues, mergers, acquisitions, delistings, new listings
- Unusual trading volumes or price movements
- Director and insider dealings: board member share purchases or sales
- Any regulatory actions from CBN, SEC, or NGX affecting the company
- Any analyst upgrades, downgrades, or target price changes
- Any major management changes, contract wins, or operational news

BROADER MARKET INTELLIGENCE:
- Any significant corporate actions on the NGX this week beyond our holdings
- Any Nigerian macro news: FX policy, inflation data, CBN decisions, NBS releases
- Any global events affecting Nigerian equities (commodity prices, emerging market flows)

══════════════════════════════════════
STEP 2 — PORTFOLIO CONTEXT
══════════════════════════════════════

Week ending ${weekEnd} | Generated: ${dateStr}
FX: ${fxRate ? '\u20a6' + Math.round(fxRate).toLocaleString() + '/USD' : 'check search'}

COMBINED BOOK:
  Active mandates:   ${portfolios.length}
  Combined NAV:      ${fmtM(totalNAV)}
  Starting capital:  ${fmtM(totalStarting)}
  Combined P&L:      ${fmtM(totalPnL)} since inception

PER-MANDATE DATA:
${portfolios.map(p => {
  const pnl    = p.current_nav - p.starting_nav
  const pnlPct = p.starting_nav > 0 ? (pnl / p.starting_nav * 100).toFixed(1) + '%' : 'N/A'
  const topHoldings = p.holdings.filter(h => h.type === 'Stock').slice(0, 5)
    .map(h => h.instrument_id + ' (' + (h.weight * 100).toFixed(0) + '%)').join(', ')
  return '  [' + p.clientCode + '] ' + p.clientName + ' | ' + p.name + '\n' +
    '  NAV: ' + fmtM(p.current_nav) + ' | starting: ' + fmtM(p.starting_nav) + ' | return: ' + pnlPct + '\n' +
    '  income target: ' + (p.income_target * 100).toFixed(0) + '% p.a. | top holdings: ' + (topHoldings || 'none')
}).join('\n\n')}

COMBINED EQUITY BOOK:
${combinedPositions || '  No equity positions found.'}

WATCHLIST CONTEXT:
  Held names on watchlist: ${heldOnList.slice(0, 10).map(w => w.ticker + ' (#' + w.rank + ')').join(', ') || 'none'}
  Top unowned watchlist names: ${notHeldTop.map(w => '#' + w.rank + ' ' + w.ticker + ' — ' + w.name).join(' | ') || 'none'}
  Fixed income watchlist: ${watchFI.slice(0, 5).map(w => (w.ticker || w.name) + ' [' + (w.sub_type ?? '') + ']').join(', ')}
  Eagle-eye pipeline items: ${watchEagle.map(w => w.name).join(', ') || 'none'}

══════════════════════════════════════
STEP 3 — WRITE THE BRIEF. Start immediately with ## Market Snapshot.
══════════════════════════════════════

Write the following seven sections in sequence. Each section is flowing narrative prose
— connected paragraphs, no bullet points, no tables (except the single one below).
The whole brief should read like one coherent, intelligent letter to an investor.

## Market Snapshot
Write five blockquote lines with the week's key market metrics:
  > **NGX All-Share Index:** [level] | [weekly change] | YTD: [change]
  > **CBN Policy Rate (MPR):** [rate] — [one-line plain-English context]
  > **USD/NGN Exchange Rate:** [₦ per dollar] | [weekly trend]
  > **Brent Crude Oil:** [$price per barrel] | [weekly change]
  > **Nigeria Inflation (CPI):** [latest %] | [trend direction]

Then write ONE markdown table — the Portfolio at a Glance. This is the ONLY table in
the entire brief. No other tables anywhere.
| Portfolio | Client | Current Value | Gain Since We Started | This Week |
|---|---|---|---|---|
[Fill in from the portfolio data above. "Current Value" in ₦M. "Gain Since We Started"
as ₦M and %. "This Week" as brief qualitative: "Strong / Steady / Watching".]

## Market Overview
Three to four narrative paragraphs on the week's dominant market theme. What drove the
NGX this week? What was the mood — cautious, euphoric, selective? Use the specific
index level and movement you found. Bring in CBN stance, FX stability, and the global
backdrop. Make the reader feel the texture of the market, not just the statistics.
Use analogies and plain language as instructed in the tone rules.

## How Our Portfolios Are Performing
Three to four paragraphs discussing the combined book in plain terms. Do not mention
"NAV" without explaining it. Which mandates had a strong week and why? Which positions
moved most? What worked, and what are we watching? Name specific companies and explain
what they do in one line. Write as if explaining at a family dinner, not a board meeting.

## What's Happening With Our Key Investments
One solid paragraph per major holding (${allTickers.slice(0, 8).join(', ')}). For each
company: what do they do (briefly), how did the stock move this week, what does the
business momentum look like, and what are we thinking about the position. Use the tone
of a well-informed friend who owns shares in that company and wants to explain its story.

## Corporate Intelligence: Under the Radar This Week
This is the section where our investment team brings you the corporate developments that
could easily slip past a busy investor but matter enormously to how stocks move.
An investment professional reads between the lines — this section is that reading.

Write a flowing narrative — NOT a list — covering the following from your research.
Group related items naturally as the narrative develops. Explain to the reader WHY each
item matters, not just what happened.

WHAT TO COVER (include everything you found that is relevant):

Earnings and Results: Were any quarterly or annual results published for our holdings
or significant NGX names this week? What were the headline numbers, and more importantly,
what did they reveal about the business that the headline might obscure? A company can
post "record profit" while its margins are quietly shrinking — that's the kind of
nuance to surface here.

Dividend Signals: Any dividend declarations, increases, cuts, or suspensions? A dividend
cut is management telling you they expect hard times ahead. A special dividend is
management saying they have more cash than they know what to do with. Explain the signal.

Corporate Actions: Rights issues (where a company asks existing shareholders for more
money), mergers, acquisitions, name changes, delistings, new listings, or regulatory
approvals. These often move stocks significantly but receive minimal mainstream coverage.

Volume Intelligence: Were there any unusual trading volumes in our holdings or watchlist
names this week? When a stock trades three times its normal daily volume for no obvious
reason, something is usually happening behind the scenes. Flag it.

Director and Insider Dealings: Did any company directors, board members, or major
shareholders buy or sell significant amounts of their own company's shares this week?
Insider buying is one of the strongest signals in investing — explain why.

Regulatory and Compliance Developments: Any CBN, SEC, or NGX regulatory actions
affecting our holdings or sectors? Any disclosures that companies were required to make?
Were there any investigations, sanctions, or compliance notices worth noting?

Analyst and Institutional Movements: Any significant analyst rating changes, price target
revisions, or large institutional shareholding disclosures?

If any of these categories had nothing notable this week, skip it naturally and move on.
The goal is an honest, professional intelligence briefing — not padding.

## What the Watchlist Is Telling Us
Two to three paragraphs on the most compelling signals from the Transworld watchlist this
week. Are any top-ranked companies we do not yet own showing catalysts — price moves,
positive results, or sector tailwinds — that make them more actionable? Are any eagle-eye
pipeline items approaching a trigger? Write this as a narrative, not a list of names.

## Our Outlook and What We Are Doing About It
Three to four closing paragraphs. Be honest about the principal risk to the combined
book over the next two to four weeks. Be specific and direct about the opportunity
you see. Signal any portfolio actions under consideration. Close with one or two
sentences that give clients genuine confidence in our direction — or an honest
acknowledgment of the key uncertainties we are navigating. Do not be vague.

---
*CIO Weekly Intelligence Brief — week ending ${weekEnd} | Transworld Investment and Securities*
*Discretionary Account Management. For distribution to clients and investors.*
*All investment decisions remain at the discretion of the portfolio manager.*`
}

export async function generateCIOBrief(input: CIOBriefInput): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const response = await (client.messages.create as any)({
    model:      'claude-sonnet-4-20250514',
    max_tokens: 6000,
    tools:      [{ type: 'web_search_20250305', name: 'web_search' }],
    messages:   [{ role: 'user', content: buildPrompt(input) }],
  })
  // Join all text blocks, strip self-talk before first ## header
  const blocks = (response.content as any[])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => (b.text as string).trim())
    .filter(t => t.length > 0)
  const all       = blocks.join('\n\n').trim()
  const startsH2  = all.startsWith('## ')
  const firstH2   = all.indexOf('\n## ')
  return startsH2 ? all : firstH2 >= 0 ? all.slice(firstH2 + 1) : all
}
