import Anthropic from '@anthropic-ai/sdk'

// v21x: Fix for missing "Market Overview" heading. When the API splits the
// first `## Heading` and the body into two adjacent text blocks, v21w's
// shape-aware join glued them with a single space — the whole first
// paragraph then parsed as one giant h2. Fix: if the current accumulated
// content ends with a `## xxx` / `### xxx` / `#### xxx` line, force a
// paragraph break before appending the next block.
//
// v21w: Fix for "disordered, scattered" brief formatting. Root cause was in
// text-block joining, not in the prompt. When web_search is used, the
// Anthropic API splits a single prose sentence into multiple adjacent text
// blocks (typically [claim-with-citation, ".", continuation]). The prior
// ".join('\\n\\n')" turned each split into a paragraph break, producing the
// "floating period on its own line" artifact in the rendered PDF. Fix:
// shape-aware join — glue punctuation closers directly, glue alphabetic
// continuations with a space, only paragraph-break when the next block
// starts with a markdown block marker. See generateCIOBrief below.
//
// v21v: Prompt revert. Strips accreted constraints back toward the v21r original
// that produced the cleanest output. See 02_app_state.md for the full drift log.
//
// Dropped from this engine:
//   - the tone-instruction import (kept on report-engine and consolidated-report
//     where plain-language is the right register)
//   - the eight-rule formatting block (8 rules -> 2 sentences)
//   - per-section paragraph-by-paragraph instructions
//   - the vivid-opening-analogy requirement
//   - corporate-intel as a separately mandated section (the Original handled
//     this implicitly inside Key Holdings Intelligence and Macro themes)
//
// Restored to Original form:
//   - Section titles: six analytical headers matching the v21r output
//   - Terse, trust-the-model instructions for each section
//
// Kept (genuine fixes):
//   - search-silently-then-write structure (suppresses self-talk preamble)
//   - text-block-join + first-H2 strip in generateCIOBrief (belt and braces
//     against residual preamble)
//
// v21t's bq_group renderer stays in place as a defensive no-op - not exercised
// by standard output, harmless if the model ever emits a stray blockquote line.

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
You are preparing the weekly CIO Intelligence Brief for the week ending ${weekEnd}, for
distribution to clients, investors, and the internal investment committee, and to anchor
the weekly CIO conference call.

FORMAT: Pure flowing prose throughout. No bullet points, no markdown tables, no
blockquotes, no "Label: value" patterns anywhere in the body. Use ## for section
headers only. Begin IMMEDIATELY with "## Market Overview" — no preamble, no meta
commentary, no narration of your research process.

STEP 1 — RESEARCH SILENTLY. Before writing anything, search the web for: NGX
All-Share Index performance this week, CBN Monetary Policy Rate, Nigeria CPI
inflation ${yr}, USD/NGN rate, Brent crude price, and for each of our key
holdings (${allTickers.join(', ')}) — recent earnings, dividends, corporate
actions, unusual volumes, insider dealings, regulatory news. Do not narrate
this research.

STEP 2 — PORTFOLIO CONTEXT

Week ending ${weekEnd} | Generated: ${dateStr}
FX: ${fxRate ? '\u20a6' + Math.round(fxRate).toLocaleString() + '/USD' : 'confirm via search'}

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

COMBINED EQUITY BOOK:
${combinedPositions || '  No equity positions.'}

WATCHLIST CONTEXT:
  Held + on watchlist: ${heldOnList.slice(0,10).map(w => w.ticker + ' (#' + w.rank + ')').join(', ') || 'none'}
  Top unowned: ${notHeldTop.map(w => '#' + w.rank + ' ' + w.ticker + ' \u2014 ' + w.name).join(' | ') || 'none'}
  FI watchlist (top 5): ${watchFI.slice(0,5).map(w => (w.ticker||w.name) + ' [' + (w.sub_type??'') + ']').join(', ')}
  Eagle-eye: ${watchEagle.map(w => w.name).join(', ') || 'none'}

STEP 3 — WRITE THE BRIEF with these six sections, in this order:

## Market Overview
The week's dominant themes in Nigerian equities and the macro backdrop — NGX
performance, CBN stance, FX, inflation, oil, global context. Weave specific numbers
naturally into the prose; they are facts inside sentences, not data points with
captions. Write as an informed CIO would frame the week for a capital allocator.

## Portfolio Performance and Positioning
How the combined book performed this week, which mandates led and why, and what
this says about our positioning. Discuss concentration, sector tilts, and any
positions that warrant closer attention.

## Key Holdings Intelligence
Company by company on our top positions (${allTickers.slice(0, 8).join(', ')}) —
what moved this week, what the operational or earnings story is, and our current
view on each. Roughly one paragraph per name. Weave in any material corporate
developments — dividends, earnings, insider dealings, regulatory actions, unusual
volumes — where they belong in each company's narrative.

## Macro and Sector Themes
The broader themes shaping our exposures — banking recapitalisation, energy
dynamics, FX stability, the rate cycle, anything flowing through multiple holdings
at once. Connect these themes to portfolio-level implications.

## Watchlist Signals
What the Transworld watchlist is telling us this week — unowned equities showing
catalysts, fixed income opportunities worth evaluating, eagle-eye pipeline items
approaching triggers. Specific names, specific reasons.

## Outlook and Forward Positioning
Principal risk to the combined book. The opportunity we see with equal clarity.
Any portfolio actions under active consideration. Direct, named, and honest — no
hedged language, no vague promises.

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

  // v21w: Extract text blocks and join them SHAPE-AWARE, not with naive '\n\n'.
  //
  // Why: web_search causes the API to split a single prose sentence across
  // multiple adjacent text blocks — typically [claim, ".", continuation].
  // Prior '\n\n' joining turned every split into a paragraph break, producing
  // floating periods and orphaned fragments in the rendered brief.
  //
  // Rules:
  //   - Next block starts with a markdown block marker (## / --- / | / > / -)
  //       → paragraph break '\n\n'
  //   - Next block starts with punctuation (. , ; : ! ? ) ] " ')
  //       → concatenate with NO separator (it is a citation closer)
  //   - Otherwise → single space (mid-sentence or same-paragraph continuation)
  //
  // Within-block paragraph structure (explicit '\n\n' inside one block) is
  // preserved untouched.
  const blocks = (response.content as any[])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => (b.text as string).trim())
    .filter((t: string) => t.length > 0)

  let all = blocks[0] ?? ''
  for (let i = 1; i < blocks.length; i++) {
    const next      = blocks[i]
    const firstChar = next[0] || ''

    // v21x: If `all` ends with a markdown heading line, force a paragraph
    // break — otherwise body text gets appended to the heading with a space
    // and the whole run parses as one giant h2.
    const lastLine = all.split('\n').pop() || ''
    const allEndsWithHeading = /^#{2,4}\s/.test(lastLine)

    if (/^(#{2,4}\s|---|\||-\s|\u2022\s|>\s)/.test(next)) {
      all = all + '\n\n' + next
    } else if (allEndsWithHeading) {
      all = all + '\n\n' + next
    } else if (/[.,;:!?)\]"'\u2019\u201d]/.test(firstChar)) {
      all = all + next
    } else {
      all = all + ' ' + next
    }
  }
  all = all.trim()

  // Strip self-talk preamble — find first '## ' header and drop anything before.
  const startsH2 = all.startsWith('## ')
  const firstH2  = all.indexOf('\n## ')
  return startsH2 ? all : firstH2 >= 0 ? all.slice(firstH2 + 1) : all
}
