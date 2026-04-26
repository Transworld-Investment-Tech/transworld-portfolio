/**
 * lib/variance-engine.ts — v27g
 *
 * Pure variance engine. Compares CSCS canonical positions to current
 * portfolio holdings and classifies each ticker into one of six buckets
 * with a suggested reconciliation action.
 *
 * Buckets:
 *   match              — units agree within tolerance; no action
 *   cscs_only          — canonical has it, portfolio doesn't → TRANSFER_IN (auto)
 *   top_up_needed      — both have it, canonical has more → TRANSFER_IN delta (auto)
 *   portfolio_only     — portfolio has it, canonical doesn't → TRANSFER_OUT (review)
 *   portfolio_overshoot— both have it, portfolio has more → TRANSFER_OUT delta (review)
 *   cash_out_of_scope  — CASH_NGN; CSCS does not track cash; ignore
 *
 * The "auto" buckets are checked-by-default in the apply UI. The "review"
 * buckets are unchecked-by-default — operator must opt in. CASH is info-only.
 *
 * Pricing convention (matches Reconciliation Playbook with the Unit Cost
 * branch collapsed because the actual CSCS export carries CLOSINGPRICE
 * but no Unit Cost):
 *   - TRANSFER_IN: canonical CLOSINGPRICE if > 0, else latest market price
 *   - TRANSFER_OUT: latest market price (operator can refine for delisted
 *     in v27h once Delisted_shares.xlsx ingestion ships)
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
  proposedPrice: number      // price for the suggested transfer
  symbolName: string
  autoApply: boolean         // checked-by-default in the apply UI
  note: string               // explanation for review buckets
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

const UNITS_TOLERANCE = 0.01

function transferInPrice(
  canonicalPrice: number,
  marketPrice: number
): number {
  if (canonicalPrice > 0) return canonicalPrice
  if (marketPrice > 0) return marketPrice
  return 0
}

function transferOutPrice(
  canonicalPrice: number,
  marketPrice: number
): number {
  if (marketPrice > 0) return marketPrice
  if (canonicalPrice > 0) return canonicalPrice
  return 0
}

export function computeVariance(
  canonical: CanonicalPosition[],
  portfolio: PortfolioPosition[],
  latestMarketPrices: Record<string, number>
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
    const portUnits = portfolioMap.get(c.ticker) ?? 0
    const delta = c.units - portUnits
    const marketPrice = latestMarketPrices[c.ticker] ?? 0

    if (Math.abs(delta) < UNITS_TOLERANCE) {
      rows.push({
        ticker: c.ticker,
        bucket: 'match',
        proposedAction: null,
        canonicalUnits: c.units,
        portfolioUnits: portUnits,
        unitDelta: 0,
        canonicalPrice: c.closingPrice,
        proposedPrice: 0,
        symbolName: c.symbolName,
        autoApply: false,
        note: '',
      })
    } else if (portUnits === 0) {
      rows.push({
        ticker: c.ticker,
        bucket: 'cscs_only',
        proposedAction: 'TRANSFER_IN',
        canonicalUnits: c.units,
        portfolioUnits: 0,
        unitDelta: delta,
        canonicalPrice: c.closingPrice,
        proposedPrice: transferInPrice(c.closingPrice, marketPrice),
        symbolName: c.symbolName,
        autoApply: true,
        note: 'CSCS holds this position; portfolio history does not show it. Likely inception transfer or recovery shares.',
      })
    } else if (delta > 0) {
      rows.push({
        ticker: c.ticker,
        bucket: 'top_up_needed',
        proposedAction: 'TRANSFER_IN',
        canonicalUnits: c.units,
        portfolioUnits: portUnits,
        unitDelta: delta,
        canonicalPrice: c.closingPrice,
        proposedPrice: transferInPrice(c.closingPrice, marketPrice),
        symbolName: c.symbolName,
        autoApply: true,
        note: `Canonical has ${delta.toLocaleString()} more units than portfolio.`,
      })
    } else {
      rows.push({
        ticker: c.ticker,
        bucket: 'portfolio_overshoot',
        proposedAction: 'TRANSFER_OUT',
        canonicalUnits: c.units,
        portfolioUnits: portUnits,
        unitDelta: delta,
        canonicalPrice: c.closingPrice,
        proposedPrice: transferOutPrice(c.closingPrice, marketPrice),
        symbolName: c.symbolName,
        autoApply: false,
        note: `Portfolio has ${Math.abs(delta).toLocaleString()} more units than canonical. Review — likely a unit typo or unrecorded SELL.`,
      })
    }
  }

  // Walk portfolio for tickers not in canonical.
  for (const [ticker, units] of portfolioMap) {
    if (seen.has(ticker)) continue

    if (ticker === 'CASH_NGN') {
      rows.push({
        ticker,
        bucket: 'cash_out_of_scope',
        proposedAction: null,
        canonicalUnits: 0,
        portfolioUnits: units,
        unitDelta: -units,
        canonicalPrice: 0,
        proposedPrice: 0,
        symbolName: 'Cash (NGN)',
        autoApply: false,
        note: 'CSCS does not track operational cash — variance here is expected and should be ignored.',
      })
      continue
    }

    const marketPrice = latestMarketPrices[ticker] ?? 0
    rows.push({
      ticker,
      bucket: 'portfolio_only',
      proposedAction: 'TRANSFER_OUT',
      canonicalUnits: 0,
      portfolioUnits: units,
      unitDelta: -units,
      canonicalPrice: 0,
      proposedPrice: transferOutPrice(0, marketPrice),
      symbolName: '',
      autoApply: false,
      note: 'Portfolio holds shares not in canonical. Could be delisted (TRANSFER_OUT at delisting price) or sold elsewhere (offset trade). Review before applying.',
    })
  }

  // Sort: review rows first (need attention), then auto-apply, then matches, then cash.
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
