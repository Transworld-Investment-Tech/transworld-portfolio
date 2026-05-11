// ═══════════════════════════════════════════════════════════════
// /api/instrument/[ticker] (v27ba)
// ═══════════════════════════════════════════════════════════════
//
// GET /api/instrument/<TICKER>
//
// v27ba changes — Per-instrument fundamentals research surface:
//   Adds the following new response blocks:
//     • market_cap         — current_price × shares_outstanding (equity)
//     • liquidity          — windowed AVG(value_ngn) + AVG(volume) for
//                            day/week/month/quarter, sourced from NGX-
//                            reported value_ngn on market_prices
//     • dividend_snapshot  — latest declared div fields from instruments
//                            (kept fresh weekly via /api/dividends/refresh)
//     • income_history     — firm-wide INCOME transactions aggregated by
//                            trade_date with per-date totals + mandate list
//     • fi_metadata        — coupon_pct, coupon_freq, maturity_date,
//                            yield_pct (conditional on FI sleeve)
//
//   Schema reads expand:
//     • instruments SELECT adds shares_outstanding, div_notes,
//       div_last_refreshed_at
//     • market_prices SELECT adds volume, value_ngn (needed for ADTV)
//     • market_prices LIMIT bumped from 150 to 200 (covers 12mo + buffer)
//
//   Everything from v27az-fix5 preserved:
//     - holdings SELECT without latest_price (the empty-holders fix)
//     - sleeve concentration via market_prices join
//     - quantity > 0 client-side filter
//     - _debug envelope with captured Supabase errors
//     - movement block (windowed pct + NGN impact) + sparkline
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
  narration:    string | null
}

type IncomeRow = {
  trade_date:      string
  portfolio_id:    string
  amount:          number | string | null
  income_category: string | null
  narration:       string | null
}

type PMeta = {
  id:           string
  label?:       string
  client_code?: string
  client_name?: string
}

type DebugEntry = { stage: string; message: string; hint?: string }

// v27az-fix5: movement window shape (preserved)
type MoveWindow = {
  pct:           number
  ngn_impact:    number
  anchor_date:   string
  anchor_price:  number
}

// v27ba: liquidity window shape — windowed averages from value_ngn + volume
type LiquidityWindow = {
  avg_value_ngn: number
  avg_volume:    number
  trading_days:  number   // count of contributing days (out of window size)
}

// v27ba: income history per-event entry (aggregated firm-wide by trade_date)
type IncomeEvent = {
  trade_date:       string
  income_category:  string | null
  total_amount_ngn: number
  mandate_count:    number
  mandates:         string[]  // mandate_label strings for transparency
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

// v27ba: compute liquidity window from N most-recent price rows.
// Excludes zero-value sessions from the average so non-trading days
// don't drag the mean down. trading_days reports the actual contributor
// count for operator awareness (low count = thin liquidity signal).
function computeLiquidityWindow(rows: PriceRow[], n: number): LiquidityWindow | null {
  const slice = rows.slice(0, n)
  let valSum = 0
  let volSum = 0
  let count  = 0
  for (const r of slice) {
    const v   = num(r.value_ngn)
    const vol = num(r.volume)
    // Count a day as "traded" if EITHER metric is positive. NGX sometimes
    // reports volume without value (or vice versa) for low-print sessions.
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

  // ─── 1. Instrument metadata ─────────────────────────────────
  // v27ba: SELECT extended with shares_outstanding,
  // shares_outstanding_last_refreshed_at, div_notes, div_last_refreshed_at.
  const { data: rawInstrument, error: instErr } = await db
    .from('instruments')
    .select('instrument_id, name, sleeve_id, asset_class, type, currency, ngx_symbol, ngx_market, sector, approved, div_per_share, div_yield_pct, div_frequency, last_div_date, next_div_date, div_status, div_notes, div_last_refreshed_at, coupon_pct, coupon_freq, maturity_date, yield_pct, shares_outstanding, shares_outstanding_last_refreshed_at')
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
  // v27ba: SELECT extended with volume, value_ngn (ADTV math).
  // Limit bumped to 200 (covers 12mo trading days ~250 with margin,
  // and the existing movement quarter lookback at 90 calendar days).
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

  // ─── 5. Holders (v27az-fix4: no latest_price in SELECT) ─────
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

  // ─── 7. Movement (v27az-fix5, preserved) ────────────────────
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

  // ─── 8. v27ba: Market Cap ───────────────────────────────────
  // Only meaningful for equities. FI instruments return null; page
  // substitutes a Maturity/YTM card from fi_metadata instead.
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

  // ─── 9. v27ba: Liquidity (windowed ADV/ADTV) ────────────────
  // Trading-day windows: 1D / 5D / 21D / 63D. Computed from
  // NGX-reported value_ngn (more accurate than volume × close).
  const liquidity = {
    day:     computeLiquidityWindow(priceHistory, 1),
    week:    computeLiquidityWindow(priceHistory, 5),
    month:   computeLiquidityWindow(priceHistory, 21),
    quarter: computeLiquidityWindow(priceHistory, 63),
  }

  // ─── 10. v27ba: Dividend Snapshot ───────────────────────────
  // Latest declared values from instruments table (refreshed weekly
  // via /api/dividends/refresh cron). Pass-through with numeric coercion.
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

  // ─── 11. v27ba: Income History (firm-wide aggregation) ──────
  // Query all INCOME transactions for this ticker across all portfolios.
  // Aggregate by trade_date. Output the last 12 events sorted DESC.
  const { data: rawIncome, error: incomeErr } = await db
    .from('transactions')
    .select('trade_date, portfolio_id, amount, income_category, narration')
    .eq('instrument_id', ticker)
    .eq('action', 'INCOME')
    .order('trade_date', { ascending: false })
    .limit(200)  // generous cap; we aggregate down to ~12 events
  captureErr('income-history', incomeErr, debug)
  const incomeRows = (rawIncome ?? []) as unknown as IncomeRow[]

  const incomeByDate = new Map<string, IncomeEvent>()
  for (const r of incomeRows) {
    const key = r.trade_date
    if (!incomeByDate.has(key)) {
      incomeByDate.set(key, {
        trade_date:       r.trade_date,
        income_category:  r.income_category,
        total_amount_ngn: 0,
        mandate_count:    0,
        mandates:         [],
      })
    }
    const entry = incomeByDate.get(key)!
    entry.total_amount_ngn += num(r.amount)
    entry.mandate_count    += 1
    entry.mandates.push(mandateLabel(r.portfolio_id))
    // First non-null income_category wins (defensive — events should be consistent)
    if (!entry.income_category && r.income_category) {
      entry.income_category = r.income_category
    }
  }

  const income_history = Array.from(incomeByDate.values())
    .sort((a, b) => b.trade_date.localeCompare(a.trade_date))
    .slice(0, 12)

  // ─── 12. v27ba: FI Metadata ─────────────────────────────────
  // Only included when the instrument is fixed-income. Page conditionally
  // renders the FI metadata panel + swaps KPI4 (mcap → maturity/YTM).
  const fi_metadata = (sleeve_id === 'ntb' || sleeve_id === 'fi')
    ? {
        coupon_pct:    num(instrument.coupon_pct),
        coupon_freq:   instrument.coupon_freq,
        maturity_date: instrument.maturity_date,
        yield_pct:     num(instrument.yield_pct),
      }
    : null

  // ─── 13. Recent transactions (v27az-fix5, preserved) ────────
  const { data: rawTxn, error: txnErr } = await db
    .from('transactions')
    .select('trade_date, action, portfolio_id, quantity, price, amount, narration')
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
      narration:     t.narration ?? '',
    }
  })

  // ─── 14. Response assembly ──────────────────────────────────
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
    income_history,
    fi_metadata,
    recent_transactions,
    firm_context: { firm_aum_ngn, firm_sleeve_total_ngn },
  }
  if (debug.length > 0) {
    response._debug = debug
  }

  return NextResponse.json(response)
}
