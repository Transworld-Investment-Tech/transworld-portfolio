/**
 * lib/variance-engine.ts — v27p
 *
 * v27p change: per-row date picker support for held-orphan transfers.
 *
 * Adds two new VarianceRow fields:
 *   - suggestedTransferDate: smart default picked by bucket
 *   - availablePriceDates:   the dates this ticker has a market_prices row
 *
 * Smart-default rules (suggestedTransferDate):
 *   - cscs_only         → portfolio.start_date (operator can override)
 *                         Falls back to latest priced date if start_date
 *                         predates the ticker's first market_price.
 *   - top_up_needed     → latest priced date for this ticker
 *   - portfolio_only    → latest priced date for this ticker
 *   - portfolio_overshoot → latest priced date for this ticker
 *
 * The pricesByTicker map is the full price history per ticker, sorted
 * ascending. The panel uses this to constrain the date picker via
 * <datalist> — operator only sees dates where the ticker actually has
 * a price, eliminating the "I picked 2018-06-15 but FBNH has no price
 * that day" class of bug.
 *
 * v27p also collapses the "TRANSFER_IN price = canonical CLOSINGPRICE"
 * branch — with a per-row date picker, the price is always derived
 * server-side from market_prices for the chosen date. The proposedPrice
 * field stays for backward compatibility with the panel's amount preview,
 * but the apply route now ignores it and re-resolves price by date lookup.
 *
 * Pricing convention (v27p):
 *   proposedPrice = market_prices.price for (ticker, suggestedTransferDate)
 *                   if available, else canonical CLOSINGPRICE, else 0.
 *   This is just a UI-side amount estimate — the server is authoritative.
 */

export type VarianceBucket =
  | 'match'
  | 'cscs_only'
  | 'top_up_needed'
  | 'portfolio_only'
  | 'portfolio_overshoot'
  | 'cash_out_of_scope'

export type ProposedAction = 'TRANSFER_IN' | 'TRANSFER_OUT' | null

export interface VarianceRow {
  ticker: string
  bucket: VarianceBucket
  proposedAction: ProposedAction
  canonicalUnits: number
  portfolioUnits: number
  unitDelta: number          // canonical - portfolio
  canonicalPrice: number
  proposedPrice: number      // amount preview only — server re-resolves
  symbolName: string
  autoApply: boolean
  note: string

  // v27p: per-row date picker support
  suggestedTransferDate: string | null   // ISO YYYY-MM-DD or null if no priced dates
  availablePriceDates:   string[]        // sorted ascending; subset of market_prices.price_date for this ticker
}

export interface CanonicalPosition {
  ticker: string
  units: number
  closingPrice: number
  symbolName: string
}

export interface PortfolioPosition {
  instrument_id: string
  quantity: number
}

export interface VarianceSummary {
  matchCount: number
  cscsOnlyCount: number
  topUpCount: number
  portfolioOnlyCount: number
  overshootCount: number
  cashCount: number
  totalAutoApply: number
  totalReview: number
}

export interface VarianceResult {
  rows: VarianceRow[]
  summary: VarianceSummary
}

// v27p: extended price history input
export interface PriceEntry {
  date:  string   // ISO YYYY-MM-DD
  price: number
}

const UNITS_TOLERANCE = 0.01

/**
 * Pick smart default transfer date for a row.
 * Returns null if the ticker has no priced dates at all.
 */
function pickSuggestedDate(
  bucket: VarianceBucket,
  priceHistory: PriceEntry[],
  portfolioStartDate: string | null
): string | null {
  if (priceHistory.length === 0) return null

  const latest = priceHistory[priceHistory.length - 1].date

  if (bucket === 'cscs_only') {
    // Held orphan — likely arrived at portfolio inception.
    if (portfolioStartDate) {
      // If portfolio.start_date predates this ticker's first priced date,
      // fall back to the earliest priced date (we can't price an instrument
      // before market_prices has data for it).
      const earliest = priceHistory[0].date
      if (portfolioStartDate < earliest) return earliest

      // Find the priced date closest to portfolioStartDate (prefer on-or-after).
      // Operator can change in the picker.
      for (const p of priceHistory) {
        if (p.date >= portfolioStartDate) return p.date
      }
      return latest
    }
    return latest
  }

  // top_up_needed / portfolio_only / portfolio_overshoot → latest priced date
  return latest
}

function priceAt(history: PriceEntry[], date: string): number {
  for (const p of history) {
    if (p.date === date) return p.price
  }
  return 0
}

export function computeVariance(
  canonical: CanonicalPosition[],
  portfolio: PortfolioPosition[],
  pricesByTicker: Record<string, PriceEntry[]>,
  portfolioStartDate: string | null
): VarianceResult {
  const portfolioMap = new Map<string, number>()
  for (const p of portfolio) {
    if (p.quantity > 0) portfolioMap.set(p.instrument_id, p.quantity)
  }

  const rows: VarianceRow[] = []
  const seen = new Set<string>()

  // Walk canonical first.
  for (const c of canonical) {
    seen.add(c.ticker)
    const portUnits   = portfolioMap.get(c.ticker) ?? 0
    const delta       = c.units - portUnits
    const history     = pricesByTicker[c.ticker] ?? []
    const datesList   = history.map(p => p.date)

    if (Math.abs(delta) < UNITS_TOLERANCE) {
      rows.push({
        ticker: c.ticker, bucket: 'match', proposedAction: null,
        canonicalUnits: c.units, portfolioUnits: portUnits, unitDelta: 0,
        canonicalPrice: c.closingPrice, proposedPrice: 0,
        symbolName: c.symbolName, autoApply: false, note: '',
        suggestedTransferDate: null, availablePriceDates: datesList,
      })
      continue
    }

    const suggested = pickSuggestedDate(
      delta > 0 && portUnits === 0 ? 'cscs_only'
        : delta > 0                ? 'top_up_needed'
                                   : 'portfolio_overshoot',
      history,
      portfolioStartDate
    )
    const suggestedPrice = suggested
      ? priceAt(history, suggested)
      : (c.closingPrice > 0 ? c.closingPrice : 0)

    if (portUnits === 0) {
      rows.push({
        ticker: c.ticker, bucket: 'cscs_only', proposedAction: 'TRANSFER_IN',
        canonicalUnits: c.units, portfolioUnits: 0, unitDelta: delta,
        canonicalPrice: c.closingPrice,
        proposedPrice: suggestedPrice > 0 ? suggestedPrice : c.closingPrice,
        symbolName: c.symbolName, autoApply: true,
        note: 'CSCS holds this position; portfolio history does not show it. Likely inception transfer or recovery shares.',
        suggestedTransferDate: suggested,
        availablePriceDates:   datesList,
      })
    } else if (delta > 0) {
      rows.push({
        ticker: c.ticker, bucket: 'top_up_needed', proposedAction: 'TRANSFER_IN',
        canonicalUnits: c.units, portfolioUnits: portUnits, unitDelta: delta,
        canonicalPrice: c.closingPrice,
        proposedPrice: suggestedPrice > 0 ? suggestedPrice : c.closingPrice,
        symbolName: c.symbolName, autoApply: true,
        note: `Canonical has ${delta.toLocaleString()} more units than portfolio.`,
        suggestedTransferDate: suggested,
        availablePriceDates:   datesList,
      })
    } else {
      rows.push({
        ticker: c.ticker, bucket: 'portfolio_overshoot', proposedAction: 'TRANSFER_OUT',
        canonicalUnits: c.units, portfolioUnits: portUnits, unitDelta: delta,
        canonicalPrice: c.closingPrice,
        proposedPrice: suggestedPrice > 0 ? suggestedPrice : c.closingPrice,
        symbolName: c.symbolName, autoApply: false,
        note: `Portfolio has ${Math.abs(delta).toLocaleString()} more units than canonical. Review — likely a unit typo or unrecorded SELL.`,
        suggestedTransferDate: suggested,
        availablePriceDates:   datesList,
      })
    }
  }

  // Walk portfolio for tickers not in canonical.
  for (const [ticker, units] of portfolioMap) {
    if (seen.has(ticker)) continue

    if (ticker === 'CASH_NGN') {
      rows.push({
        ticker, bucket: 'cash_out_of_scope', proposedAction: null,
        canonicalUnits: 0, portfolioUnits: units, unitDelta: -units,
        canonicalPrice: 0, proposedPrice: 0,
        symbolName: 'Cash (NGN)', autoApply: false,
        note: 'CSCS does not track operational cash — variance here is expected and should be ignored.',
        suggestedTransferDate: null, availablePriceDates: [],
      })
      continue
    }

    const history   = pricesByTicker[ticker] ?? []
    const datesList = history.map(p => p.date)
    const suggested = pickSuggestedDate('portfolio_only', history, portfolioStartDate)
    const suggestedPrice = suggested ? priceAt(history, suggested) : 0

    rows.push({
      ticker, bucket: 'portfolio_only', proposedAction: 'TRANSFER_OUT',
      canonicalUnits: 0, portfolioUnits: units, unitDelta: -units,
      canonicalPrice: 0, proposedPrice: suggestedPrice,
      symbolName: '', autoApply: false,
      note: 'Portfolio holds shares not in canonical. Could be delisted (TRANSFER_OUT at delisting price) or sold elsewhere (offset trade). Review before applying.',
      suggestedTransferDate: suggested,
      availablePriceDates:   datesList,
    })
  }

  // Sort: review rows first, then auto-apply, then matches, then cash.
  const order: Record<VarianceBucket, number> = {
    portfolio_only: 0,
    portfolio_overshoot: 1,
    cscs_only: 2,
    top_up_needed: 3,
    match: 4,
    cash_out_of_scope: 5,
  }
  rows.sort((a, b) => {
    const o = order[a.bucket] - order[b.bucket]
    if (o !== 0) return o
    return a.ticker.localeCompare(b.ticker)
  })

  const summary: VarianceSummary = {
    matchCount:         rows.filter(r => r.bucket === 'match').length,
    cscsOnlyCount:      rows.filter(r => r.bucket === 'cscs_only').length,
    topUpCount:         rows.filter(r => r.bucket === 'top_up_needed').length,
    portfolioOnlyCount: rows.filter(r => r.bucket === 'portfolio_only').length,
    overshootCount:     rows.filter(r => r.bucket === 'portfolio_overshoot').length,
    cashCount:          rows.filter(r => r.bucket === 'cash_out_of_scope').length,
    totalAutoApply:     rows.filter(r => r.autoApply).length,
    totalReview:        rows.filter(r => !r.autoApply && r.proposedAction !== null).length,
  }

  return { rows, summary }
}
