// ═══════════════════════════════════════════════════════════════
// /api/instrument/[ticker] (v27bb)
// ═══════════════════════════════════════════════════════════════
//
// GET /api/instrument/<TICKER>
//
// v27bb changes vs v27ba:
//   • REMOVED: income_history block (operator workflow doesn't track
//     dividends as INCOME transactions — divs paid direct to client
//     bank accounts; firm has no visibility). The associated row type,
//     aggregation map, and SELECT are all gone.
//   • FIXED: recent transactions SELECT was reading 'narration' which
//     doesn't exist on transactions; the real column is 'notes'.
//     Pitfall #93 sixth recurrence. Caused Recent Transactions panel
//     to silently fail (pitfall #152). Response field renamed
//     'narration' → 'notes' for end-to-end honesty.
//   • ADDED: fundamentals block — pass-through of 18 fields from
//     instruments (newly-populated by /api/fundamentals/refresh):
//     EPS basic/diluted, BVPS, income statement (revenue/gross/
//     operating/PBT/PAT), balance sheet (assets/equity/debt),
//     ratios (ROE/ROA/net margin), period, source.
//   • ADDED: valuation block — server-computed:
//       pe_ratio = current_price / EPS (prefer diluted, fall back basic)
//       pb_ratio = current_price / BVPS
//       graham_number = √(22.5 × EPS × BVPS)  [Benjamin Graham's intrinsic value]
//       graham_test_passes = (P/E × P/B) ≤ 22.5
//       intrinsic_value_gap_pct = (graham_number - current_price) / current_price
//     Each metric independently nullable; eps_meaningful flag is false
//     when EPS ≤ 0 (P/E exists arithmetically but is not interpretable).
//
// All v27ba functionality preserved:
//   • market_cap, liquidity, dividend_snapshot, fi_metadata blocks
//   • Movement panel + sparkline
//   • Concentration / holders / firm_context
//   • _debug envelope on PostgREST errors
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
  // v27ba-era
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

  // v27bb additions — fundamentals (all 18 fields)
  eps_basic:                            number | null
  eps_diluted:                          number | null
  book_value_per_share:                 number | null
  revenue_ngn_m:                        number | null
  gross_profit_ngn_m:                   number | null
  operating_profit_ngn_m:               number | null
  profit_before_tax_ngn_m:              number | null
  profit_after_tax_ngn_m:               number | null
  total_assets_ngn_m:                   number | null
  total_equity_ngn_m:                   number | null
  total_debt_ngn_m:                     number | null
  roe_pct:                              number | null
  roa_pct:                              number | null
  net_margin_pct:                       number | null
  fundamentals_period_end:              string | null
  fundamentals_period_type:             string | null
  fundamentals_currency:                string | null
  fundamentals_source:                  string | null
  fundamentals_notes:                   string | null
  fundamentals_last_refreshed_at:       string | null
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

// v27bb FIX: transactions table column is 'notes', not 'narration'.
// v27ba's SELECT silently returned null+error (pitfall #152) so Recent
// Transactions panel was empty for every ticker. Now uses real column.
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

// v27bb: nullable numeric coercion — returns null when the value is
// genuinely null/undefined/non-numeric, preserving the distinction
// between "missing data" (null) and "data is zero" (0). Used for
// fundamentals so the page can render '—' for unrefreshed tickers.
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

  // ─── 1. Instrument metadata (v27bb: SELECT extended w/ 18 fundamentals fields) ──
  const { data: rawInstrument, error: instErr } = await db
    .from('instruments')
    .select('instrument_id, name, sleeve_id, asset_class, type, currency, ngx_symbol, ngx_market, sector, approved, div_per_share, div_yield_pct, div_frequency, last_div_date, next_div_date, div_status, div_notes, div_last_refreshed_at, coupon_pct, coupon_freq, maturity_date, yield_pct, shares_outstanding, shares_outstanding_last_refreshed_at, eps_basic, eps_diluted, book_value_per_share, revenue_ngn_m, gross_profit_ngn_m, operating_profit_ngn_m, profit_before_tax_ngn_m, profit_after_tax_ngn_m, total_assets_ngn_m, total_equity_ngn_m, total_debt_ngn_m, roe_pct, roa_pct, net_margin_pct, fundamentals_period_end, fundamentals_period_type, fundamentals_currency, fundamentals_source, fundamentals_notes, fundamentals_last_refreshed_at')
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

  // ─── 3. Watchlist status ────────────────────────────────────
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

  // ─── 4. Active portfolios + NAVs ────────────────────────────
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

  // ─── 5. Holders ─────────────────────────────────────────────
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

  // ─── 6. Concentration ───────────────────────────────────────
  const total_qty      = holders.reduce((s, h) => s + h.qty, 0)
  const firm_value_ngn = holders.reduce((s, h) => s + h.market_value_ngn, 0)
  const mandate_count  = holders.length
  const pct_of_firm_aum = firm_aum_ngn > 0 ? firm_value_ngn / firm_aum_ngn : 0

  const sleeve_id = instrument.sleeve_id ?? 'unknown'
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

  // ─── 7. Movement ────────────────────────────────────────────
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

  // ─── 8. Market Cap ──────────────────────────────────────────
  let market_cap: {
    ngn: number
    shares_outstanding: number
    as_of_price_date: string | null
    last_refreshed_at: string | null
  } | null = null

  if (sleeve_id === 'eq' && current_price !== null) {
    const so = num(instrument.shares_outstanding)
    if (so > 0) {
      market_cap = {
        ngn: current_price * so,
        shares_outstanding: so,
        as_of_price_date: price_date,
        last_refreshed_at: instrument.shares_outstanding_last_refreshed_at,
      }
    }
  }

  // ─── 9. Liquidity ───────────────────────────────────────────
  const liquidity = {
    day:     computeLiquidityWindow(priceHistory, 1),
    week:    computeLiquidityWindow(priceHistory, 5),
    month:   computeLiquidityWindow(priceHistory, 21),
    quarter: computeLiquidityWindow(priceHistory, 63),
  }

  // ─── 10. Dividend Snapshot ──────────────────────────────────
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

  // ─── 11. v27bb: Fundamentals (pass-through from instruments) ─
  // Equity only. FI instruments report null block — they have their
  // own FI Metadata panel via fi_metadata.
  const fundamentals = (sleeve_id === 'eq')
    ? {
        eps_basic:               numOrNull(instrument.eps_basic),
        eps_diluted:             numOrNull(instrument.eps_diluted),
        book_value_per_share:    numOrNull(instrument.book_value_per_share),
        revenue_ngn_m:           numOrNull(instrument.revenue_ngn_m),
        gross_profit_ngn_m:      numOrNull(instrument.gross_profit_ngn_m),
        operating_profit_ngn_m:  numOrNull(instrument.operating_profit_ngn_m),
        profit_before_tax_ngn_m: numOrNull(instrument.profit_before_tax_ngn_m),
        profit_after_tax_ngn_m:  numOrNull(instrument.profit_after_tax_ngn_m),
        total_assets_ngn_m:      numOrNull(instrument.total_assets_ngn_m),
        total_equity_ngn_m:      numOrNull(instrument.total_equity_ngn_m),
        total_debt_ngn_m:        numOrNull(instrument.total_debt_ngn_m),
        roe_pct:                 numOrNull(instrument.roe_pct),
        roa_pct:                 numOrNull(instrument.roa_pct),
        net_margin_pct:          numOrNull(instrument.net_margin_pct),
        period_end:              instrument.fundamentals_period_end,
        period_type:             instrument.fundamentals_period_type,
        currency:                instrument.fundamentals_currency,
        source:                  instrument.fundamentals_source,
        notes:                   instrument.fundamentals_notes,
        last_refreshed_at:       instrument.fundamentals_last_refreshed_at,
      }
    : null

  // ─── 12. v27bb: Valuation (server-computed from fundamentals + price) ─
  // Each metric independently nullable based on input availability.
  // Diluted EPS preferred; falls back to basic when diluted is null.
  // Graham Number = √(22.5 × EPS × BVPS) — Benjamin Graham's intrinsic value.
  // Graham 22.5 test = (P/E × P/B) ≤ 22.5  — equivalent passing condition.
  let valuation: {
    pe_ratio:                number | null
    pb_ratio:                number | null
    graham_number:           number | null
    graham_test_passes:      boolean | null
    intrinsic_value_gap_pct: number | null
    intrinsic_value_gap_ngn: number | null
    eps_used:                number | null      // which EPS we used (diluted or basic)
    eps_used_kind:           'diluted' | 'basic' | null
    eps_meaningful:          boolean            // false when EPS ≤ 0
  } | null = null

  if (sleeve_id === 'eq' && current_price !== null && current_price > 0) {
    const epsDiluted = numOrNull(instrument.eps_diluted)
    const epsBasic   = numOrNull(instrument.eps_basic)
    const bvps       = numOrNull(instrument.book_value_per_share)

    // Preference: diluted > basic
    const epsUsed: number | null = epsDiluted !== null ? epsDiluted
                                  : epsBasic !== null ? epsBasic
                                  : null
    const epsKind: 'diluted' | 'basic' | null = epsDiluted !== null ? 'diluted'
                                                : epsBasic !== null ? 'basic'
                                                : null

    const pe = epsUsed !== null && epsUsed !== 0 ? current_price / epsUsed : null
    const pb = bvps !== null && bvps > 0          ? current_price / bvps    : null

    // Graham Number: requires positive EPS AND positive BVPS
    // (negative EPS would make 22.5 × EPS × BVPS negative; sqrt of negative is NaN)
    let graham: number | null = null
    let grahamTest: boolean | null = null
    let gapPct:     number | null = null
    let gapNgn:     number | null = null
    if (epsUsed !== null && epsUsed > 0 && bvps !== null && bvps > 0) {
      graham   = Math.sqrt(22.5 * epsUsed * bvps)
      gapNgn   = graham - current_price
      gapPct   = gapNgn / current_price
    }
    // Graham 22.5 test (P/E × P/B ≤ 22.5) is meaningful even when EPS is
    // positive but the Graham Number itself was computable; otherwise null.
    if (pe !== null && pe > 0 && pb !== null && pb > 0) {
      grahamTest = (pe * pb) <= 22.5
    }

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
    }
  }

  // ─── 13. FI Metadata ────────────────────────────────────────
  const fi_metadata = (sleeve_id === 'ntb' || sleeve_id === 'fi')
    ? {
        coupon_pct:    num(instrument.coupon_pct),
        coupon_freq:   instrument.coupon_freq,
        maturity_date: instrument.maturity_date,
        yield_pct:     num(instrument.yield_pct),
      }
    : null

  // ─── 14. Recent transactions (v27bb FIX: notes column) ─────
  // The bug: v27ba's SELECT requested 'narration' which doesn't exist
  // on transactions (column is 'notes'). PostgREST silently returned
  // null+error, the `data ?? []` fallback swallowed it, and Recent
  // Transactions rendered "No transactions on record" for every ticker.
  // Pitfall #152 (silent PostgREST column-mismatch) + pitfall #93
  // (schema doc drift). Response field is also 'notes' for honesty —
  // matches the underlying column name.
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

  // ─── 15. Response assembly ──────────────────────────────────
  // NOTE: income_history block removed in v27bb. The operator workflow
  // doesn't record dividends as INCOME transactions (divs paid direct
  // to client bank accounts; firm has no visibility). Replacing with
  // fundamentals + valuation surface what operator actually wants.
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
    fundamentals,     // v27bb NEW
    valuation,        // v27bb NEW
    fi_metadata,
    recent_transactions,
    firm_context: { firm_aum_ngn, firm_sleeve_total_ngn },
  }
  if (debug.length > 0) {
    response._debug = debug
  }

  return NextResponse.json(response)
}
