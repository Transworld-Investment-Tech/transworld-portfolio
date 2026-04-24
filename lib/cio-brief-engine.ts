import Anthropic from '@anthropic-ai/sdk'
import { REPORT_TONE_INSTRUCTION } from './report-tone'

// v21u: Market Snapshot converted from 5 blockquote metric lines to pure prose.
// The five key numbers (NGX, CBN MPR, USD/NGN, Brent, CPI) are now woven into
// the opening narrative paragraphs, not listed. User feedback after 7 attempts
// at the metric-strip layout: prose sidesteps the rendering question entirely.
//
// Prior (v21s-hotfix-2 through v21t): intermediate metric-strip experiments.
// The bq_group renderer shipped in v21t is left in place as a defensive
// fallback for any future brief that emits a stray `>` line, but is no longer
// exercised by the standard brief output.

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
      ' | held by: ' + d.mandates.join(', '))
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
for distribution to all clients and investors and to anchor the weekly CIO conference call.

${REPORT_TONE_INSTRUCTION}

══════════════════════════════════════
ABSOLUTE FORMATTING RULES — NO EXCEPTIONS
══════════════════════════════════════

1. Start IMMEDIATELY with "## Market Snapshot" — no preamble of any kind.
2. NO bullet points anywhere. Every idea must be in a sentence.
3. NO markdown tables anywhere.
4. NO numbered lists. No dashes or asterisks used as list markers.
5. NO blockquotes (> lines) anywhere. None — not even for metrics at the top.
6. NO "**Label:** value" patterns. A bold phrase followed by a colon and a
   number reads as a metric line even when it sits inside a paragraph. Numbers
   appear INSIDE sentences as ordinary nouns with verbs and context around
   them — never as data points with captions.
7. Use ## for section headers and ### for sub-section headers only.
8. The entire brief is PURE FLOWING PROSE from the first sentence of Market
   Snapshot to the final sentence of the outlook. Read like a well-written
   magazine article or a letter from a thoughtful investment manager.

══════════════════════════════════════
STEP 1 — SEARCH SILENTLY. Write nothing until Step 3.
══════════════════════════════════════

Search for: NGX All-Share Index performance ${weekEnd}, CBN policy rate ${yr},
Nigeria CPI inflation ${yr}, USD NGN rate today, Brent crude price today,
and for each holding (${allTickers.join(', ')}): recent earnings, dividends,
corporate actions, unusual volumes, director dealings, regulatory news.

══════════════════════════════════════
STEP 2 — PORTFOLIO CONTEXT
══════════════════════════════════════

Week ending ${weekEnd} | Generated: ${dateStr}
FX: ${fxRate ? '\u20a6' + Math.round(fxRate).toLocaleString() + '/USD' : 'check search'}

COMBINED BOOK:
  Mandates: ${portfolios.length} | Combined NAV: ${fmtM(totalNAV)}
  Starting capital: ${fmtM(totalStarting)} | Combined P&L: ${fmtM(totalPnL)}

PER-MANDATE:
${portfolios.map(p => {
  const pnl    = p.current_nav - p.starting_nav
  const pnlPct = p.starting_nav > 0 ? (pnl / p.starting_nav * 100).toFixed(1) + '%' : 'N/A'
  const top5   = p.holdings.filter(h => h.type === 'Stock').slice(0, 5)
    .map(h => h.instrument_id + ' (' + (h.weight * 100).toFixed(0) + '%)').join(', ')
  return '  [' + p.clientCode + '] ' + p.clientName + ' \u2014 ' + p.name + ': NAV ' +
    fmtM(p.current_nav) + ' | starting ' + fmtM(p.starting_nav) + ' | return ' + pnlPct +
    ' | top holdings: ' + (top5 || 'none')
}).join('\n')}

COMBINED EQUITY BOOK (for your reference when writing):
${combinedPositions || '  No equity positions.'}

WATCHLIST CONTEXT:
  Held + on watchlist: ${heldOnList.slice(0,10).map(w => w.ticker + ' (#' + w.rank + ')').join(', ') || 'none'}
  Top unowned: ${notHeldTop.map(w => '#' + w.rank + ' ' + w.ticker + ' \u2014 ' + w.name).join(' | ') || 'none'}
  FI watchlist (top 5): ${watchFI.slice(0,5).map(w => (w.ticker||w.name) + ' [' + (w.sub_type??'') + ']').join(', ')}
  Eagle-eye: ${watchEagle.map(w => w.name).join(', ') || 'none'}

══════════════════════════════════════
STEP 3 — WRITE. Begin with ## Market Snapshot.
══════════════════════════════════════

## Market Snapshot

Open the brief with three to four flowing paragraphs that tell the story of the
week's Nigerian market. This is the first thing a client reads — it is not a
data dump. Five facts must appear in the prose, woven into sentences with
context around them, never listed or stacked or prefixed with bold labels:
the NGX All-Share Index's closing level together with its weekly change in
points and percent and year-to-date performance; the CBN's current Monetary
Policy Rate and what it signals about the central bank's stance; where USD/NGN
is trading and the recent trend; where Brent crude is trading and what is
driving it; and the latest Nigeria CPI inflation print with its trend.

Open with a vivid analogy or image that gives the reader the market's mood
immediately. Then weave the macro picture — CBN policy, FX, oil, global
backdrop — through connected prose, using specific numbers but always wrapped
in plain English. End the section with a sentence that bridges to what this
macro backdrop means for Nigerian investors going into the week ahead.

## How Our Portfolios Are Performing

Write three to four paragraphs discussing the combined book as if you are a proud but
clear-eyed manager reporting back to the people who trusted you with their savings.
Open by putting the combined figures in plain, human terms — not "NAV" jargon but
"here is what your investments are worth and here is what we built together." Then
discuss which mandates had the strongest week and why. Name specific companies and
explain in one sentence what each company does. Discuss what worked well and be honest
about anything you are watching carefully. This section should feel warm, direct, and
like a personal update from someone who genuinely cares about the outcomes.
Do NOT include any table, any list, or any structured data format. Pure prose only.

## What's Happening With Our Key Investments

Write one generous paragraph per major holding (${allTickers.slice(0, 8).join(', ')}).
For each company: what does it do in plain terms, how did the stock perform this week,
what is the business story behind the price move, and what is our thinking on the
position. Write as if explaining to a smart friend who doesn't follow the stock market
daily but wants to understand why we own what we own.
No bullet points. No tables. No sub-lists. One paragraph flows into the next.

## Corporate Intelligence: Under the Radar This Week

This section is where our investment professionals surface the corporate developments
that matter but can easily get lost in the daily noise. Write it as one continuous
narrative — not a categorised list. Let the intelligence flow naturally from one
company or theme to the next, as a thoughtful analyst would explain it in conversation.

Draw on your research to surface any of the following that are relevant this week,
woven into the narrative wherever they appear:

Recent earnings results and what they reveal beyond the headline numbers. Dividend
announcements and what they signal about management confidence. Corporate actions such
as rights issues, mergers, acquisitions, or new listings. Unusual trading volumes and
what institutional behaviour they might suggest. Director and insider share dealings and
what they imply. Regulatory actions or compliance developments from CBN, SEC, or NGX.
Analyst rating changes or institutional shareholding shifts. Anything else an experienced
investment professional would flag that a casual observer would miss.

Explain to the reader not just what happened, but why it matters and what it might mean
for the stock or for our position. Bring your professional eye to what others overlook.
Skip any category that had nothing notable this week — do not pad.

## What the Watchlist Is Telling Us

Write two to three paragraphs as flowing narrative on the signals coming from the
Transworld watchlist this week. Which unowned names are showing catalysts that make
them more compelling? Which eagle-eye pipeline items are approaching a trigger point?
What does the combined watchlist intelligence tell us about where the next opportunities
are? Write with the forward-looking energy of someone who is excited about what they
are seeing, grounded in the specific names and rationale.

## Our Outlook and What We Are Doing About It

Write three to four honest, direct paragraphs closing the brief. Name the principal risk
to our combined book plainly and specifically. Name the opportunity you see with equal
clarity. Signal any portfolio actions under active consideration. End with a paragraph
that gives clients genuine confidence in the direction of the combined mandate — or
acknowledges honestly the key uncertainties we are navigating together. Do not be vague.
This closing should feel like a CIO who respects their clients enough to be straight
with them.

---
*CIO Weekly Intelligence Brief — week ending ${weekEnd} | Transworld Investment and Securities*
*Discretionary Account Management. For distribution to clients and investors.*`
}

export async function generateCIOBrief(input: CIOBriefInput): Promise<string> {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const response = await (client.messages.create as any)({
    model:      'claude-sonnet-4-20250514',
    max_tokens: 6000,
    tools:      [{ type: 'web_search_20250305', name: 'web_search' }],
    messages:   [{ role: 'user', content: buildPrompt(input) }],
  })
  // Join all text blocks (model may split across searches), strip self-talk preamble
  const blocks = (response.content as any[])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => (b.text as string).trim())
    .filter(t => t.length > 0)
  const all      = blocks.join('\n\n').trim()
  const startsH2 = all.startsWith('## ')
  const firstH2  = all.indexOf('\n## ')
  return startsH2 ? all : firstH2 >= 0 ? all.slice(firstH2 + 1) : all
}
