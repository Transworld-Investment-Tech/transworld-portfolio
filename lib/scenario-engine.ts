import { REPORT_TONE_INSTRUCTION } from './report-tone'

// v21y: Portfolio Scenario Analysis engine.
//
// Ephemeral, interactive, client-facing analysis triggered from the Portfolio
// Overview. First real use case is for Kenneth Okafor — how a ₦20M addition
// could address issues in his portfolio. Output must match the quality bar
// of per-portfolio AI reports (so REPORT_TONE_INSTRUCTION is imported) because
// it will be copy-pasted into client-facing emails.
//
// Web search is ON because scenarios like "how should ₦20M be deployed" or
// "CBN cuts MPR 200bps" are meaningless without current market context.
// That means this engine needs the shape-aware text-block join (pitfall #68)
// and heading-end check (pitfall #69) — copied from cio-brief-engine.ts.
//
// Unlike the CIO brief, the scenario engine is called from a streaming
// route, so generateScenarioStream below is async-generator-shaped, not
// return-a-string-shaped. The post-stream shape-aware join runs server-side
// on the accumulated blocks and the FINAL joined content is emitted as a
// separate NDJSON message so the client can replace its accumulated raw
// stream with the cleaned-up version.

export interface ScenarioPortfolio {
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
  max_eq_single: number | null
  max_eq_sleeve: number | null
  liq_min:       number | null
  cap_target:    number | null
}

export interface ScenarioHolding {
  instrument_id: string
  name:          string
  type:          string
  sector:        string | null
  quantity:      number
  avg_cost:      number
  latest_price:  number
  market_value:  number
  weight:        number
}

export interface ScenarioSleeve {
  sleeve_id:  string
  name:       string
  target_pct: number
  actual_pct: number
  min_pct:    number
  max_pct:    number
  value:      number
  status:     string
}

export interface ScenarioWatchItem {
  ticker:    string
  name:      string
  section:   string
  sub_type:  string | null
  rank:      number
  rationale: string | null
}

export interface ScenarioInput {
  portfolio:   ScenarioPortfolio
  holdings:    ScenarioHolding[]
  sleeves:     ScenarioSleeve[]
  watchlist:   ScenarioWatchItem[]
  fxRate:      number | null
  scenario:    string
}

function fmtM(n: number): string {
  return '\u20a6' + (n / 1e6).toFixed(2) + 'M'
}

function fmtPct(n: number, digits = 1): string {
  return (n * 100).toFixed(digits) + '%'
}

export function buildScenarioPrompt(input: ScenarioInput): string {
  const { portfolio, holdings, sleeves, watchlist, fxRate, scenario } = input

  const today  = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const equities = holdings.filter(h => h.type === 'Stock')
  const fixedInc = holdings.filter(h => h.type !== 'Stock')

  const watchEquities = watchlist.filter(w => w.section === 'equity')
  const watchFI       = watchlist.filter(w => w.section === 'fixed_income')
  const watchEagle    = watchlist.filter(w => w.section === 'watch')
  const heldSet       = new Set(equities.map(h => h.instrument_id))
  const topUnowned    = watchEquities.filter(w => w.ticker && !heldSet.has(w.ticker)).slice(0, 10)

  const holdingsBlock = equities.length > 0
    ? equities.map(h =>
        '  ' + h.instrument_id + ' (' + h.name + ')' +
        (h.sector ? ' [' + h.sector + ']' : '') + ': ' +
        Math.round(h.quantity).toLocaleString() + ' shares at avg cost \u20a6' + h.avg_cost.toFixed(2) +
        ' | current \u20a6' + h.latest_price.toFixed(2) +
        ' | value ' + fmtM(h.market_value) +
        ' | weight ' + fmtPct(h.weight)
      ).join('\n')
    : '  (no equity holdings)'

  const fixedIncBlock = fixedInc.length > 0
    ? fixedInc.map(h => '  ' + h.instrument_id + ' (' + h.name + '): value ' + fmtM(h.market_value) + ' | weight ' + fmtPct(h.weight)).join('\n')
    : '  (no fixed income or cash holdings — fully deployed in equities)'

  const sleeveBlock = sleeves.map(s =>
    '  ' + s.name + ': ' + fmtPct(s.actual_pct) + ' actual vs ' + fmtPct(s.target_pct) +
    ' target (band ' + fmtPct(s.min_pct) + '\u2013' + fmtPct(s.max_pct) + ') | ' + fmtM(s.value) + ' | ' + s.status
  ).join('\n')

  const watchBlock = [
    '  Top watchlist equities NOT currently held:',
    ...topUnowned.map(w => '    #' + w.rank + ' ' + w.ticker + ' \u2014 ' + w.name + (w.rationale ? ': ' + w.rationale.slice(0, 120) : '')),
    '',
    '  Top fixed income on watchlist (top 5):',
    ...watchFI.slice(0, 5).map(w => '    ' + (w.ticker || w.name) + ' [' + (w.sub_type ?? '') + ']' + (w.rationale ? ': ' + w.rationale.slice(0, 100) : '')),
    watchEagle.length > 0 ? '' : '',
    ...(watchEagle.length > 0
      ? ['  Eagle-eye pipeline: ' + watchEagle.map(w => w.name).join(', ')]
      : []),
  ].join('\n')

  return `You are a senior portfolio strategist at Transworld Investment and Securities, Lagos, Nigeria.
You are producing a scenario analysis for a specific client portfolio. The output will be shared
directly with the client, so it must be clear, honest, and concrete — specific tickers, specific
naira amounts, specific rationale. Not abstract.

${REPORT_TONE_INSTRUCTION}

FORMAT: Clean markdown. Use ## for section headers. Write in flowing, readable prose. Tables are
allowed but only for concrete allocation proposals or comparisons (e.g. recommended positions with
ticker, amount, rationale). Bold may be used sparingly for key figures. Begin IMMEDIATELY with
"## Current Portfolio Position" \u2014 no preamble, no meta commentary, no narration of your research.

STEP 1 \u2014 RESEARCH SILENTLY. Before writing, search the web for current NGX conditions: NGX
All-Share Index level and recent trend, CBN MPR, Nigeria inflation, USD/NGN, Brent crude,
recent moves in the portfolio's key holdings (${equities.map(h => h.instrument_id).join(', ')}),
and anything material in the fixed income market (NTB rates, FGN bond yields). Do not narrate
this research — absorb it and write.

STEP 2 \u2014 PORTFOLIO CONTEXT

Today: ${today}
FX: ${fxRate ? '\u20a6' + Math.round(fxRate).toLocaleString() + '/USD' : 'confirm via search'}

CLIENT: ${portfolio.clientName} (${portfolio.clientCode})
PORTFOLIO: ${portfolio.name}
CURRENCY: ${portfolio.currency}

NAV: ${fmtM(portfolio.current_nav)} current | ${fmtM(portfolio.starting_nav)} starting${portfolio.start_date ? ' (inception ' + portfolio.start_date + ')' : ''}

MANDATE LIMITS:
  Income target: ${portfolio.income_target != null ? fmtPct(portfolio.income_target) : 'n/a'} p.a.
  Cap target:    ${portfolio.cap_target    != null ? fmtPct(portfolio.cap_target)    : 'n/a'} p.a.
  Max single eq: ${portfolio.max_eq_single != null ? fmtPct(portfolio.max_eq_single) : 'n/a'}
  Max eq sleeve: ${portfolio.max_eq_sleeve != null ? fmtPct(portfolio.max_eq_sleeve) : 'n/a'}
  Min liquidity: ${portfolio.liq_min       != null ? fmtPct(portfolio.liq_min)       : 'n/a'}

SLEEVE ALLOCATION (actual vs target):
${sleeveBlock}

EQUITY HOLDINGS:
${holdingsBlock}

FIXED INCOME / CASH:
${fixedIncBlock}

WATCHLIST CONTEXT:
${watchBlock}

STEP 3 \u2014 THE SCENARIO

The portfolio manager is asking you to analyse the following scenario for this specific portfolio:

"""
${scenario}
"""

STEP 4 \u2014 WRITE THE ANALYSIS

Structure your response with these four sections, in this order:

## Current Portfolio Position
A plain-English read of where this portfolio stands today. Concentration, sector tilts, what's
working, what isn't, what the mandate limits say about the current state. Keep it tight \u2014
this is context for the scenario, not a full review.

## Scenario Implications
What this scenario would mean for this portfolio specifically. If it's a capital-addition
scenario, name the gaps the new capital could close. If it's a macro-shock scenario, name
the holdings most exposed and the holdings most protected. If it's a forward-projection
scenario, give a realistic range and the drivers. Be specific. Use numbers.

## Recommended Actions
Concrete, actionable proposals. For capital additions, specify tickers and naira amounts
(a compact allocation table is appropriate here). For macro scenarios, specify trades to
consider (buy/trim/hedge) with sizes. Cross-reference the Transworld watchlist \u2014 prefer
names on the watchlist for any new buy recommendations. Every recommendation must have a
one-sentence rationale.

## Risks and Considerations
What could go wrong with the recommended path. Concentration after the moves. Liquidity.
Execution timing. Mandate considerations. Be candid \u2014 this section protects the client.

---
*Portfolio Scenario Analysis \u2014 ${today} | Transworld Investment and Securities*
*Discretionary Account Management. Prepared for the portfolio manager's review.*`
}
