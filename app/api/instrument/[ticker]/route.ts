// ═══════════════════════════════════════════════════════════════
// /api/instrument/[ticker] (v27cb-a-fix7g)
// ═══════════════════════════════════════════════════════════════
//
// GET /api/instrument/<TICKER>
//
// v27cb-a-fix7g — data flow rewire from instruments columns to
// the three normalized tables built across v27ca → v27cb-a-fix7f:
//
//   • fundamentals → fundamentals_history (most recent row,
//     verified > unverified, derived ratios computed live)
//   • valuation    → computed from fundamentals_history (EPS, BVPS)
//                    + PEG 3yr/5yr from annual EPS CAGR
//   • market_cap   → fundamentals_history.shares_outstanding
//                    × current_price (fallback: instruments.shares_outstanding)
//   • disclosures  → NEW block from instrument_disclosures (top 25)
//   • dealings     → NEW block from instrument_director_dealings (top 25)
//
// All other blocks unchanged from v27bc:
//   • Movement panel + sparkline
//   • Trading Liquidity
//   • Dividend Snapshot (still from instruments columns; fix7h
//     scope will pull from disclosures)
//   • FI Metadata
//   • AI Summary pass-through (engine rewritten in fix7g
//     ai-summaries/refresh/route.ts; UI schema unchanged)
//   • Holders + Recent Transactions
//
// PEG architecture:
//   • 3yr CAGR: requires annualRows.length ≥ 4 (latest + 3yr ago)
//   • 5yr CAGR: requires annualRows.length ≥ 6
//   • CAGR null if either endpoint EPS ≤ 0
//   • peg_warning fires when 5yr period straddles NGN unification
//     (2023-06-01) — FX distortion explanation
// ═══════════════════════════════════════════════════════════════

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import {
  fetchAllActivePortfolios,
  computeAllPortfolioNAVs,
} from '@/lib/cockpit-aggregations'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

// ─── Explicit row types ─────────────────────────────────────────

type InstrumentRow = {
  instrument_id:                        string
  name:                                 string
  sleeve_id:                            string | null
  asset_class:                          string | null
  type:                                 string | null
  currency:                             string | null
  ngx_symbol:                           string | null
  ngx_market:                           string | null
  sector:                               string | null
  approved:                             boolean | null
  div_per_share:                        number | null
  div_yield_pct:                        number | null
  div_frequency:                        string | null
  last_div_date:                        string | null
  next_div_date:                        string | null
  div_status:                           string | null
  div_notes:                            string | null
  div_last_refreshed_at:                string | null
  coupon_pct:                           number | null
  coupon_freq:                          number | null
  maturity_date:                        string | null
  yield_pct:                            number | null
  shares_outstanding:                   number | null
  shares_outstanding_last_refreshed_at: string | null
  ai_summary_json:                      unknown | null
  ai_summary_refreshed_at:              string | null
}

type AISummaryShape = {
  tilt:         'bullish' | 'neutral' | 'bearish'
  tilt_reason:  string
  strength:     string
  concern:      string
  watch_for:    string
  confidence:   'high' | 'medium' | 'low'
  generated_at: string
}

// v27cb-a-fix7g: fundamentals_history row shape (subset we read)
type FundamentalsHistoryRow = {
  id:                           string
  instrument_id:                string
  period_end:                   string
  period_type:                  'annual' | 'quarterly'
  verified_status:              'unverified' | 'verified' | 'flagged'
  pdf_source_url:               string | null
  pdf_filename:                 string | null
  revenue_ngn_m:                number | string | null
  gross_profit_ngn_m:           number | string | null
  operating_profit_ngn_m:       number | string | null
  profit_before_tax_ngn_m:      number | string | null
  profit_after_tax_ngn_m:       number | string | null
  eps_basic:                    number | string | null
  eps_diluted:                  number | string | null
  total_assets_ngn_m:           number | string | null
  total_equity_ngn_m:           number | string | null
  total_debt_ngn_m:             number | string | null
  cash_and_equivalents_ngn_m:   number | string | null
  cash_from_operations_ngn_m:   number | string | null
  shares_outstanding:           number | string | null
  currency:                     string | null
  source:                       string | null
  extraction_notes:             string | null
  operator_notes:               string | null
  imported_at:                  string
}

// v27cb-a-fix7g: disclosure / dealings row shapes
type DisclosureRow = {
  id:                     string
  ngx_item_id:            string
  title:                  string | null
  category:               string
  raw_type_of_submission: string | null
  pdf_source_url:         string | null
  pdf_filename:           string | null
  modified_at:            string
}

type DealingRow = {
  id:             string
  ngx_item_id:    string
  title:          string | null
  pdf_source_url: string | null
  pdf_filename:   string | null
  modified_at:    string
}

type PriceRow = {
  price:      number | string | null
  price_date: string | null
  volume:     number | string | null
  value_ngn:  number | string | null
}

type WatchlistRow = {
  ticker:   string
  section:  string | null
  sub_type: string | null
  active:   boolean | null
}

type HoldingRow = {
  portfolio_id: string
  quantity:     number | string | null
  avg_cost:     number | string | null
}

type TxnRow = {
  trade_date:   string
  action:       string
  portfolio_id: string
  quantity:     number | string | null
  price:        number | string | null
  amount:       number | string | null
  notes:        string | null
}

type PMeta = {
  id:           string
  label?:       string
  client_code?: string
  client_name?: string
}

type DebugEntry = { stage: string; message: string; hint?: string }

type MoveWindow = {
  pct:           number
  ngn_impact:    number
  anchor_date:   string
  anchor_price:  number
}

type LiquidityWindow = {
  avg_value_ngn: number
  avg_volume:    number
  trading_days:  number
}

// ─── Helpers ────────────────────────────────────────────────────

function client() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
            ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!url || !key) return null
  return createClient(url, key)
}

function num(v: unknown, fallback = 0): number {
  if (v === null || v === undefined) return fallback
  if (typeof v === 'number') return isFinite(v) ? v : fallback
  if (typeof v === 'string') {
    const n = Number(v)
    return isFinite(n) ? n : fallback
  }
  return fallback
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') return isFinite(v) ? v : null
  if (typeof v === 'string') {
    if (v.trim() === '') return null
    const n = Number(v)
    return isFinite(n) ? n : null
  }
  return null
}

const SLEEVE_LABELS: Record<string, string> = {
  eq:  'Equity',
  liq: 'Cash & Liquidity',
  ntb: 'Treasury Bills',
  fi:  'Fixed Income',
}

// v27cb-a-fix7g: NGN unification cutoff for FX-distortion PEG warning
const NGN_UNIFICATION_CUTOFF = '2023-06-01'

function captureErr(stage: string, err: unknown, debug: DebugEntry[]) {
  if (!err) return
  const e = err as { message?: string; hint?: string; code?: string; details?: string }
  const entry: DebugEntry = {
    stage,
    message: e.message ?? String(err),
    hint:    e.hint ?? e.details ?? e.code,
  }
  debug.push(entry)
  // eslint-disable-next-line no-console
  console.error('[instrument-route]', stage, entry.message, entry.hint ?? '')
}

function computeLiquidityWindow(rows: PriceRow[], n: number): LiquidityWindow | null {
  const slice = rows.slice(0, n)
  let valSum = 0
  let volSum = 0
  let count  = 0
  for (const r of slice) {
    const v   = num(r.value_ngn)
    const vol = num(r.volume)
    if (v > 0 || vol > 0) {
      valSum += v
      volSum += vol
      count  += 1
    }
  }
  if (count === 0) return null
  return {
    avg_value_ngn: valSum / count,
    avg_volume:    volSum / count,
    trading_days:  count,
  }
}

function validateAISummary(raw: unknown): AISummaryShape | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.tilt !== 'string' || !['bullish','neutral','bearish'].includes(r.tilt)) return null
  if (typeof r.tilt_reason !== 'string') return null
  if (typeof r.strength !== 'string')    return null
  if (typeof r.concern !== 'string')     return null
  if (typeof r.watch_for !== 'string')   return null
  if (typeof r.confidence !== 'string' || !['high','medium','low'].includes(r.confidence)) return null
  return {
    tilt:         r.tilt as 'bullish' | 'neutral' | 'bearish',
    tilt_reason:  r.tilt_reason,
    strength:     r.strength,
    concern:      r.concern,
    watch_for:    r.watch_for,
    confidence:   r.confidence as 'high' | 'medium' | 'low',
    generated_at: typeof r.generated_at === 'string' ? r.generated_at : '',
  }
}

// v27cb-a-fix7g: pick EPS for a fundamentals_history row (prefer diluted)
function pickEpsFromRow(row: FundamentalsHistoryRow): number | null {
  const d = numOrNull(row.eps_diluted)
  if (d !== null) return d
  return numOrNull(row.eps_basic)
}

// v27cb-a-fix7g: derive BVPS from total_equity + shares
function deriveBvps(equityNgnM: number | null, shares: number | null): number | null {
  if (equityNgnM === null || equityNgnM <= 0) return null
  if (shares === null || shares <= 0) return null
  return (equityNgnM * 1_000_000) / shares
}

// v27cb-a-fix7g: derived ratios (ROE, ROA, Net Margin) from raw row
function deriveRatios(row: FundamentalsHistoryRow): {
  roe_pct:        number | null
  roa_pct:        number | null
  net_margin_pct: number | null
} {
  const pat     = numOrNull(row.profit_after_tax_ngn_m)
  const equity  = numOrNull(row.total_equity_ngn_m)
  const assets  = numOrNull(row.total_assets_ngn_m)
  const revenue = numOrNull(row.revenue_ngn_m)
  return {
    roe_pct:        (pat !== null && equity  !== null && equity  > 0) ? (pat / equity)  * 100 : null,
    roa_pct:        (pat !== null && assets  !== null && assets  > 0) ? (pat / assets)  * 100 : null,
    net_margin_pct: (pat !== null && revenue !== null && revenue > 0) ? (pat / revenue) * 100 : null,
  }
}

// v27cb-a-fix7g: CAGR helper. Returns null when:
//   - either endpoint EPS is null
//   - either endpoint EPS ≤ 0 (loss-period; CAGR undefined)
//   - years ≤ 0
function computeCagr(
  epsLatest: number | null,
  epsStart:  number | null,
  years:     number,
): number | null {
  if (epsLatest === null || epsStart === null) return null
  if (epsLatest <= 0 || epsStart <= 0) return null
  if (years <= 0) return null
  return Math.pow(epsLatest / epsStart, 1 / years) - 1
}

// v27cb-a-fix7g: PEG helper. cagr_pct is the CAGR expressed as a
// percentage (e.g. 0.15 → 15 → PEG = PE / 15). Standard Lynch PEG.
function computePeg(pe: number | null, cagrPct: number | null): number | null {
  if (pe === null || pe <= 0) return null
  if (cagrPct === null || cagrPct <= 0) return null
  return pe / cagrPct
}

// v27cb-a-fix7g: FX-distortion warning for 5yr PEG
function buildPegWarning(periodEndLatest: string | null, periodEnd5yrAgo: string | null): string | null {
  if (!periodEndLatest || !periodEnd5yrAgo) return null
  if (periodEnd5yrAgo < NGN_UNIFICATION_CUTOFF && periodEndLatest >= NGN_UNIFICATION_CUTOFF) {
    return '5yr period spans NGN unification (Jun 2023) — likely FX-distorted'
  }
  return null
}

// ─── GET ────────────────────────────────────────────────────────

export async function GET(
  _request: Request,
  context: { params: Promise<{ ticker: string }> },
) {
  const debug: DebugEntry[] = []

  const db = client()
  if (!db) {
    return NextResponse.json({ error: 'supabase env missing' }, { status: 500 })
  }

  const { ticker: rawTicker } = await context.params
  const ticker = decodeURIComponent(rawTicker).toUpperCase()

  // ─── 1. Instrument metadata ─────────────────────────────────
  const { data: rawInstrument, error: instErr } = await db
    .from('instruments')
    .select('instrument_id, name, sleeve_id, asset_class, type, currency, ngx_symbol, ngx_market, sector, approved, div_per_share, div_yield_pct, div_frequency, last_div_date, next_div_date, div_status, div_notes, div_last_refreshed_at, coupon_pct, coupon_freq, maturity_date, yield_pct, shares_outstanding, shares_outstanding_last_refreshed_at, ai_summary_json, ai_summary_refreshed_at')
    .eq('instrument_id', ticker)
    .maybeSingle()

  if (instErr) {
    captureErr('instrument-lookup', instErr, debug)
    return NextResponse.json(
      { error: (instErr as { message?: string }).message ?? 'instrument lookup failed', ticker, _debug: debug },
      { status: 500 },
    )
  }
  if (!rawInstrument) {
    return NextResponse.json({ error: 'not_found', ticker }, { status: 404 })
  }
  const instrument = rawInstrument as unknown as InstrumentRow
  const sleeve_id = instrument.sleeve_id ?? 'unknown'

  // ─── 2. Price history ───────────────────────────────────────
  const { data: priceRowsRaw, error: priceErr } = await db
    .from('market_prices')
    .select('price, price_date, volume, value_ngn')
    .eq('instrument_id', ticker)
    .order('price_date', { ascending: false })
    .limit(200)
  captureErr('market-prices', priceErr, debug)
  const priceHistory = (priceRowsRaw ?? []) as unknown as PriceRow[]

  const current_price = priceHistory.length > 0 ? num(priceHistory[0].price) : null
  const prev_price    = priceHistory.length > 1 ? num(priceHistory[1].price) : null
  const price_date    = priceHistory.length > 0 ? priceHistory[0].price_date : null

  let day_change_pct: number | null = null
  let day_change_ngn: number | null = null
  if (current_price !== null && prev_price !== null && prev_price > 0) {
    day_change_pct = (current_price - prev_price) / prev_price
    day_change_ngn = current_price - prev_price
  }

  // ─── 3. v27cb-a-fix7g: Fundamentals history (equity only) ───
  // Pull ALL rows for this ticker, sorted DESC by period_end. We use:
  //   • histRows[0]                    — for "most recent" panel display
  //   • histRows.filter(annual)        — for CAGR / PEG (annual only)
  //   • first row with shares_outstanding — for market cap
  let histRows: FundamentalsHistoryRow[] = []
  if (sleeve_id === 'eq') {
    const { data: rawHist, error: histErr } = await db
      .from('fundamentals_history')
      .select('id, instrument_id, period_end, period_type, verified_status, pdf_source_url, pdf_filename, revenue_ngn_m, gross_profit_ngn_m, operating_profit_ngn_m, profit_before_tax_ngn_m, profit_after_tax_ngn_m, eps_basic, eps_diluted, total_assets_ngn_m, total_equity_ngn_m, total_debt_ngn_m, cash_and_equivalents_ngn_m, cash_from_operations_ngn_m, shares_outstanding, currency, source, extraction_notes, operator_notes, imported_at')
      .eq('instrument_id', ticker)
      .order('period_end', { ascending: false })
    captureErr('fundamentals-history', histErr, debug)
    histRows = (rawHist ?? []) as unknown as FundamentalsHistoryRow[]
  }
  const annualRows = histRows.filter(r => r.period_type === 'annual')
  const mostRecentFundamentalRow = histRows[0] ?? null
  const periodWithShares = histRows.find(r => {
    const s = numOrNull(r.shares_outstanding)
    return s !== null && s > 0
  }) ?? null

  // ─── 4. v27cb-a-fix7g: Disclosures + Director Dealings ──────
  let disclosureRows: DisclosureRow[] = []
  let dealingRows:    DealingRow[]    = []
  if (sleeve_id === 'eq') {
    const { data: rawDisc, error: discErr } = await db
      .from('instrument_disclosures')
      .select('id, ngx_item_id, title, category, raw_type_of_submission, pdf_source_url, pdf_filename, modified_at')
      .eq('instrument_id', ticker)
      .order('modified_at', { ascending: false })
      .limit(25)
    captureErr('disclosures', discErr, debug)
    disclosureRows = (rawDisc ?? []) as unknown as DisclosureRow[]

    const { data: rawDeal, error: dealErr } = await db
      .from('instrument_director_dealings')
      .select('id, ngx_item_id, title, pdf_source_url, pdf_filename, modified_at')
      .eq('instrument_id', ticker)
      .order('modified_at', { ascending: false })
      .limit(25)
    captureErr('dealings', dealErr, debug)
    dealingRows = (rawDeal ?? []) as unknown as DealingRow[]
  }

  // ─── 5. Watchlist status ────────────────────────────────────
  const { data: rawWl, error: wlErr } = await db
    .from('watchlist')
    .select('ticker, section, sub_type, active')
    .eq('ticker', ticker)
    .maybeSingle()
  captureErr('watchlist', wlErr, debug)
  const wlRow = rawWl as unknown as WatchlistRow | null

  const watchlist = {
    is_watchlisted: !!(wlRow && wlRow.active),
    section:        wlRow ? wlRow.section : null,
    sub_type:       wlRow ? wlRow.sub_type : null,
  }

  // ─── 6. Active portfolios + NAVs ────────────────────────────
  const portfolios = await fetchAllActivePortfolios(db) as unknown as PMeta[]
  const portfolioIds = portfolios.map(p => p.id)
  const navMap = await computeAllPortfolioNAVs(db, portfolioIds)
  let firm_aum_ngn = 0
  navMap.forEach(v => { firm_aum_ngn += num(v) })

  const pIndex = new Map<string, PMeta>()
  for (const p of portfolios) pIndex.set(p.id, p)

  function mandateLabel(pid: string): string {
    const p = pIndex.get(pid)
    if (!p) return pid.slice(0, 8)
    const code = p.client_code ?? '?'
    const lab  = p.label ?? '?'
    return code + '-' + lab
  }

  // ─── 7. Holders ─────────────────────────────────────────────
  const { data: rawHoldings, error: holdErr } = await db
    .from('holdings')
    .select('portfolio_id, quantity, avg_cost')
    .eq('instrument_id', ticker)
  captureErr('holdings-for-ticker', holdErr, debug)
  const holdingRows = (rawHoldings ?? []) as unknown as HoldingRow[]

  const holders = holdingRows
    .filter(h => num(h.quantity) > 0)
    .map(h => {
      const p = pIndex.get(h.portfolio_id)
      if (!p) return null
      const qty           = num(h.quantity)
      const avg_cost      = num(h.avg_cost)
      const latest_price  = current_price ?? avg_cost
      const market_value  = qty * latest_price
      const cost_basis    = qty * avg_cost
      const unrealised    = market_value - cost_basis
      const port_nav      = num(navMap.get(p.id))
      return {
        portfolio_id:         p.id,
        mandate_label:        mandateLabel(p.id),
        client_name:          p.client_name ?? '—',
        client_code:          p.client_code ?? '?',
        qty,
        avg_cost,
        latest_price,
        market_value_ngn:     market_value,
        cost_basis_ngn:       cost_basis,
        unrealised_pl_ngn:    unrealised,
        unrealised_pl_pct:    cost_basis > 0 ? unrealised / cost_basis : null,
        pct_of_portfolio_nav: port_nav > 0 ? market_value / port_nav : null,
      }
    })
    .filter((x): x is NonNullable<typeof x> => x !== null)
    .sort((a, b) => b.market_value_ngn - a.market_value_ngn)

  // ─── 8. Concentration ───────────────────────────────────────
  const total_qty      = holders.reduce((s, h) => s + h.qty, 0)
  const firm_value_ngn = holders.reduce((s, h) => s + h.market_value_ngn, 0)
  const mandate_count  = holders.length
  const pct_of_firm_aum = firm_aum_ngn > 0 ? firm_value_ngn / firm_aum_ngn : 0

  let firm_sleeve_total_ngn = 0
  if (sleeve_id && sleeve_id !== 'unknown') {
    const { data: rawSleeveInst, error: sleeveInstErr } = await db
      .from('instruments')
      .select('instrument_id')
      .eq('sleeve_id', sleeve_id)
    captureErr('sleeve-instruments', sleeveInstErr, debug)
    const sleeveInstRows = (rawSleeveInst ?? []) as unknown as Array<{ instrument_id: string }>
    const sleeveTickers = sleeveInstRows
      .map(r => r.instrument_id)
      .filter(Boolean)

    if (sleeveTickers.length > 0) {
      const { data: rawSleeveHold, error: sleeveHoldErr } = await db
        .from('holdings')
        .select('instrument_id, quantity, avg_cost')
        .in('instrument_id', sleeveTickers)
      captureErr('sleeve-holdings', sleeveHoldErr, debug)
      const sleeveHoldRows = (rawSleeveHold ?? []) as unknown as Array<HoldingRow & { instrument_id: string }>

      const { data: rawSleevePrices, error: sleevePricesErr } = await db
        .from('market_prices')
        .select('instrument_id, price, price_date')
        .in('instrument_id', sleeveTickers)
        .order('price_date', { ascending: false })
      captureErr('sleeve-prices', sleevePricesErr, debug)
      const sleevePriceRows = (rawSleevePrices ?? []) as unknown as Array<{ instrument_id: string; price: number | string | null; price_date: string }>

      const sleevePriceMap = new Map<string, number>()
      for (const r of sleevePriceRows) {
        if (!sleevePriceMap.has(r.instrument_id)) {
          sleevePriceMap.set(r.instrument_id, num(r.price))
        }
      }

      for (const r of sleeveHoldRows) {
        const q = num(r.quantity)
        if (q <= 0) continue
        const p = sleevePriceMap.get(r.instrument_id) ?? num(r.avg_cost)
        firm_sleeve_total_ngn += q * p
      }
    }
  }
  const pct_of_firm_sleeve_exposure = firm_sleeve_total_ngn > 0
    ? firm_value_ngn / firm_sleeve_total_ngn
    : 0

  const concentration = {
    total_qty,
    firm_value_ngn,
    mandate_count,
    pct_of_firm_aum,
    pct_of_firm_sleeve_exposure,
    sleeve_label: SLEEVE_LABELS[sleeve_id] ?? sleeve_id,
  }

  // ─── 9. Movement ────────────────────────────────────────────
  function findAnchorByLookback(daysBack: number): PriceRow | null {
    if (priceHistory.length === 0 || !priceHistory[0].price_date) return null
    const todayIso = priceHistory[0].price_date as string
    const target = new Date(todayIso + 'T00:00:00')
    target.setDate(target.getDate() - daysBack)
    const targetIso = target.toISOString().slice(0, 10)
    for (const r of priceHistory) {
      if (r.price_date && (r.price_date as string) <= targetIso) {
        if (r.price_date === todayIso && daysBack > 0) continue
        return r
      }
    }
    return null
  }

  function moveFromAnchor(anchor: PriceRow | null): MoveWindow | null {
    if (!anchor || current_price === null) return null
    const anchorPrice = num(anchor.price)
    if (anchorPrice <= 0) return null
    const pct = (current_price - anchorPrice) / anchorPrice
    return {
      pct,
      ngn_impact:   firm_value_ngn * pct,
      anchor_date:  (anchor.price_date as string) ?? '',
      anchor_price: anchorPrice,
    }
  }

  const day_window: MoveWindow | null = (day_change_pct !== null && prev_price !== null)
    ? {
        pct:          day_change_pct,
        ngn_impact:   firm_value_ngn * day_change_pct,
        anchor_date:  (priceHistory[1]?.price_date as string) ?? '',
        anchor_price: prev_price,
      }
    : null

  const movement = {
    day:       day_window,
    week:      moveFromAnchor(findAnchorByLookback(7)),
    month:     moveFromAnchor(findAnchorByLookback(30)),
    quarter:   moveFromAnchor(findAnchorByLookback(90)),
    sparkline: priceHistory
      .slice(0, 30)
      .reverse()
      .map(r => ({
        date:  (r.price_date as string) ?? '',
        price: num(r.price),
      }))
      .filter(p => p.date && p.price > 0),
  }

  // ─── 10. v27cb-a-fix7g: Market Cap from fundamentals_history ─
  // Priority: fundamentals_history.shares_outstanding (most recent
  // period with non-null shares) > instruments.shares_outstanding
  let market_cap: {
    ngn:                  number
    shares_outstanding:   number
    shares_basis:         'per_period' | 'instruments_fallback'
    as_of_period_end:     string | null
    as_of_price_date:     string | null
    last_refreshed_at:    string | null
  } | null = null

  if (sleeve_id === 'eq' && current_price !== null && current_price > 0) {
    const perPeriodShares = periodWithShares ? numOrNull(periodWithShares.shares_outstanding) : null
    const instrumentShares = numOrNull(instrument.shares_outstanding)
    const shares = perPeriodShares ?? instrumentShares
    if (shares !== null && shares > 0) {
      market_cap = {
        ngn:                current_price * shares,
        shares_outstanding: shares,
        shares_basis:       perPeriodShares !== null ? 'per_period' : 'instruments_fallback',
        as_of_period_end:   perPeriodShares !== null ? (periodWithShares?.period_end ?? null) : null,
        as_of_price_date:   price_date,
        last_refreshed_at:  perPeriodShares !== null
                              ? (periodWithShares?.imported_at ?? null)
                              : instrument.shares_outstanding_last_refreshed_at,
      }
    }
  }

  // ─── 11. Liquidity ──────────────────────────────────────────
  const liquidity = {
    day:     computeLiquidityWindow(priceHistory, 1),
    week:    computeLiquidityWindow(priceHistory, 5),
    month:   computeLiquidityWindow(priceHistory, 21),
    quarter: computeLiquidityWindow(priceHistory, 63),
  }

  // ─── 12. Dividend Snapshot (still from instruments columns) ─
  const dividend_snapshot = {
    div_per_share:         num(instrument.div_per_share),
    div_yield_pct:         num(instrument.div_yield_pct),
    div_frequency:         instrument.div_frequency,
    div_status:            instrument.div_status,
    last_div_date:         instrument.last_div_date,
    next_div_date:         instrument.next_div_date,
    div_notes:             instrument.div_notes,
    div_last_refreshed_at: instrument.div_last_refreshed_at,
  }

  // ─── 13. v27cb-a-fix7g: Fundamentals from fundamentals_history ─
  // Most recent row (any period_type) drives the display. Derived
  // ratios computed live from raw values, NOT from deprecated
  // pre-computed roe_pct / roa_pct / net_margin_pct columns.
  let fundamentals: {
    eps_basic:                  number | null
    eps_diluted:                number | null
    book_value_per_share:       number | null
    revenue_ngn_m:              number | null
    gross_profit_ngn_m:         number | null
    operating_profit_ngn_m:     number | null
    profit_before_tax_ngn_m:    number | null
    profit_after_tax_ngn_m:     number | null
    total_assets_ngn_m:         number | null
    total_equity_ngn_m:         number | null
    total_debt_ngn_m:           number | null
    cash_and_equivalents_ngn_m: number | null
    cash_from_operations_ngn_m: number | null
    roe_pct:                    number | null
    roa_pct:                    number | null
    net_margin_pct:             number | null
    period_end:                 string | null
    period_type:                string | null
    verified_status:            string | null
    currency:                   string | null
    source:                     string | null
    notes:                      string | null
    operator_notes:             string | null
    last_refreshed_at:          string | null
  } | null = null

  if (sleeve_id === 'eq' && mostRecentFundamentalRow) {
    const row    = mostRecentFundamentalRow
    const ratios = deriveRatios(row)
    // BVPS: prefer per-period shares, fallback to instruments.shares_outstanding
    const sharesForBvps = numOrNull(row.shares_outstanding)
                       ?? numOrNull(instrument.shares_outstanding)
    const bvps = deriveBvps(numOrNull(row.total_equity_ngn_m), sharesForBvps)
    fundamentals = {
      eps_basic:                  numOrNull(row.eps_basic),
      eps_diluted:                numOrNull(row.eps_diluted),
      book_value_per_share:       bvps,
      revenue_ngn_m:              numOrNull(row.revenue_ngn_m),
      gross_profit_ngn_m:         numOrNull(row.gross_profit_ngn_m),
      operating_profit_ngn_m:     numOrNull(row.operating_profit_ngn_m),
      profit_before_tax_ngn_m:    numOrNull(row.profit_before_tax_ngn_m),
      profit_after_tax_ngn_m:     numOrNull(row.profit_after_tax_ngn_m),
      total_assets_ngn_m:         numOrNull(row.total_assets_ngn_m),
      total_equity_ngn_m:         numOrNull(row.total_equity_ngn_m),
      total_debt_ngn_m:           numOrNull(row.total_debt_ngn_m),
      cash_and_equivalents_ngn_m: numOrNull(row.cash_and_equivalents_ngn_m),
      cash_from_operations_ngn_m: numOrNull(row.cash_from_operations_ngn_m),
      roe_pct:                    ratios.roe_pct,
      roa_pct:                    ratios.roa_pct,
      net_margin_pct:             ratios.net_margin_pct,
      period_end:                 row.period_end,
      period_type:                row.period_type,
      verified_status:            row.verified_status,
      currency:                   row.currency,
      source:                     row.source,
      notes:                      row.extraction_notes,
      operator_notes:             row.operator_notes,
      last_refreshed_at:          row.imported_at,
    }
  }

  // ─── 14. v27cb-a-fix7g: Valuation (with PEG 3yr + 5yr) ──────
  let valuation: {
    pe_ratio:                number | null
    pb_ratio:                number | null
    graham_number:           number | null
    graham_test_passes:      boolean | null
    intrinsic_value_gap_pct: number | null
    intrinsic_value_gap_ngn: number | null
    eps_used:                number | null
    eps_used_kind:           'diluted' | 'basic' | null
    eps_meaningful:          boolean
    peg_3yr:                 number | null
    peg_5yr:                 number | null
    eps_cagr_3yr_pct:        number | null
    eps_cagr_5yr_pct:        number | null
    peg_warning:             string | null
  } | null = null

  if (sleeve_id === 'eq' && current_price !== null && current_price > 0 && mostRecentFundamentalRow) {
    const row = mostRecentFundamentalRow
    const epsDiluted = numOrNull(row.eps_diluted)
    const epsBasic   = numOrNull(row.eps_basic)
    const sharesForBvps = numOrNull(row.shares_outstanding)
                       ?? numOrNull(instrument.shares_outstanding)
    const bvps       = deriveBvps(numOrNull(row.total_equity_ngn_m), sharesForBvps)

    const epsUsed: number | null = epsDiluted !== null ? epsDiluted
                                  : epsBasic !== null ? epsBasic
                                  : null
    const epsKind: 'diluted' | 'basic' | null = epsDiluted !== null ? 'diluted'
                                                : epsBasic !== null ? 'basic'
                                                : null

    const pe = epsUsed !== null && epsUsed !== 0 ? current_price / epsUsed : null
    const pb = bvps !== null && bvps > 0          ? current_price / bvps    : null

    let graham:     number | null = null
    let grahamTest: boolean | null = null
    let gapPct:     number | null = null
    let gapNgn:     number | null = null
    if (epsUsed !== null && epsUsed > 0 && bvps !== null && bvps > 0) {
      graham   = Math.sqrt(22.5 * epsUsed * bvps)
      gapNgn   = graham - current_price
      gapPct   = gapNgn / current_price
    }
    if (pe !== null && pe > 0 && pb !== null && pb > 0) {
      grahamTest = (pe * pb) <= 22.5
    }

    // v27cb-a-fix7g: PEG 3yr + 5yr from ANNUAL EPS CAGR
    // 3yr: requires annualRows index 0 + index 3 (latest + 3yr ago)
    // 5yr: requires annualRows index 0 + index 5 (latest + 5yr ago)
    const epsLatest        = annualRows.length > 0 ? pickEpsFromRow(annualRows[0]) : null
    const periodEndLatest  = annualRows[0]?.period_end ?? null
    const eps3yrAgo        = annualRows.length > 3 ? pickEpsFromRow(annualRows[3]) : null
    const eps5yrAgo        = annualRows.length > 5 ? pickEpsFromRow(annualRows[5]) : null
    const periodEnd5yrAgo  = annualRows[5]?.period_end ?? null

    const cagr3yr = computeCagr(epsLatest, eps3yrAgo, 3)
    const cagr5yr = computeCagr(epsLatest, eps5yrAgo, 5)

    const peg3yr = computePeg(pe, cagr3yr !== null ? cagr3yr * 100 : null)
    const peg5yr = computePeg(pe, cagr5yr !== null ? cagr5yr * 100 : null)

    const pegWarning = buildPegWarning(periodEndLatest, periodEnd5yrAgo)

    valuation = {
      pe_ratio:                pe,
      pb_ratio:                pb,
      graham_number:           graham,
      graham_test_passes:      grahamTest,
      intrinsic_value_gap_pct: gapPct,
      intrinsic_value_gap_ngn: gapNgn,
      eps_used:                epsUsed,
      eps_used_kind:           epsKind,
      eps_meaningful:          epsUsed !== null && epsUsed > 0,
      peg_3yr:                 peg3yr,
      peg_5yr:                 peg5yr,
      eps_cagr_3yr_pct:        cagr3yr !== null ? cagr3yr * 100 : null,
      eps_cagr_5yr_pct:        cagr5yr !== null ? cagr5yr * 100 : null,
      peg_warning:             pegWarning,
    }
  }

  // ─── 15. AI Summary (pass-through) ──────────────────────────
  const ai_summary_data = sleeve_id === 'eq'
    ? validateAISummary(instrument.ai_summary_json)
    : null

  const ai_summary = ai_summary_data
    ? {
        ...ai_summary_data,
        last_refreshed_at: instrument.ai_summary_refreshed_at,
      }
    : (sleeve_id === 'eq'
        ? {
            tilt:               null,
            tilt_reason:        null,
            strength:           null,
            concern:            null,
            watch_for:          null,
            confidence:         null,
            generated_at:       null,
            last_refreshed_at:  instrument.ai_summary_refreshed_at,
          }
        : null)

  // ─── 16. FI Metadata ────────────────────────────────────────
  const fi_metadata = (sleeve_id === 'ntb' || sleeve_id === 'fi')
    ? {
        coupon_pct:    num(instrument.coupon_pct),
        coupon_freq:   instrument.coupon_freq,
        maturity_date: instrument.maturity_date,
        yield_pct:     num(instrument.yield_pct),
      }
    : null

  // ─── 17. v27cb-a-fix7g: Disclosures + Director Dealings ─────
  const disclosures = disclosureRows.map(r => ({
    id:             r.id,
    title:          r.title ?? r.pdf_filename ?? '(untitled)',
    category:       r.category,
    pdf_source_url: r.pdf_source_url,
    pdf_filename:   r.pdf_filename,
    modified_at:    r.modified_at,
  }))

  const director_dealings = dealingRows.map(r => ({
    id:             r.id,
    title:          r.title ?? r.pdf_filename ?? '(untitled)',
    pdf_source_url: r.pdf_source_url,
    pdf_filename:   r.pdf_filename,
    modified_at:    r.modified_at,
  }))

  // ─── 18. Recent transactions ────────────────────────────────
  const { data: rawTxn, error: txnErr } = await db
    .from('transactions')
    .select('trade_date, action, portfolio_id, quantity, price, amount, notes')
    .eq('instrument_id', ticker)
    .neq('action', 'FEE')
    .order('trade_date', { ascending: false })
    .limit(20)
  captureErr('transactions', txnErr, debug)
  const txnRows = (rawTxn ?? []) as unknown as TxnRow[]

  const recent_transactions = txnRows.map(t => {
    const p = pIndex.get(t.portfolio_id)
    return {
      trade_date:    t.trade_date,
      action:        t.action,
      portfolio_id:  t.portfolio_id,
      mandate_label: mandateLabel(t.portfolio_id),
      client_code:   p ? (p.client_code ?? '?') : '?',
      qty:           num(t.quantity),
      price:         num(t.price),
      amount:        num(t.amount),
      notes:         t.notes ?? '',
    }
  })

  // ─── 19. Response assembly ──────────────────────────────────
  const response: Record<string, unknown> = {
    instrument,
    price:               { current_price, price_date, day_change_pct, day_change_ngn },
    watchlist,
    holders,
    concentration,
    movement,
    market_cap,
    liquidity,
    dividend_snapshot,
    fundamentals,
    valuation,
    ai_summary,
    fi_metadata,
    disclosures,            // v27cb-a-fix7g NEW
    director_dealings,      // v27cb-a-fix7g NEW
    recent_transactions,
    firm_context: { firm_aum_ngn, firm_sleeve_total_ngn },
  }
  if (debug.length > 0) {
    response._debug = debug
  }

  return NextResponse.json(response)
}
