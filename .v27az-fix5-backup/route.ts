// ═══════════════════════════════════════════════════════════════
// /api/instrument/[ticker] (v27az-fix4)
// ═══════════════════════════════════════════════════════════════
//
// GET /api/instrument/<TICKER>
//
// v27az-fix4 changes (the empty-holders bug):
//   1. holdings SELECT no longer requests `latest_price` — that
//      column doesn't exist on the holdings table. Asking for a
//      non-existent column made PostgREST return null+error and
//      my `data ?? []` swallowed it silently → 0 holders for every
//      ticker even when SQL `WHERE instrument_id = 'X'` returned
//      rows. Valuation now uses the market_prices `current_price`
//      uniformly (which is the correct authoritative figure anyway).
//   2. `.gt('quantity', 0)` moved client-side as defensive belt — if
//      PostgREST filter behavior on a numeric col were ever an issue,
//      this removes that path entirely.
//   3. Sleeve concentration query gets the same treatment (no
//      latest_price, client-side filter, captured errors).
//   4. recent_transactions query identically defensive.
//   5. New _debug envelope in the response — any Supabase error
//      objects bubble up as { stage, message, hint } entries.
//      Operators can see them via curl; UI ignores. Plus a
//      console.error for Vercel function logs.
//
// Same scope, same API, same UI rendering — just correct data.
// ═══════════════════════════════════════════════════════════════

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import {
  fetchAllActivePortfolios,
  computeAllPortfolioNAVs,
} from '@/lib/cockpit-aggregations'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

// ─── Explicit row types (decouples from Supabase typegen) ───────

type InstrumentRow = {
  instrument_id: string
  name:          string
  sleeve_id:     string | null
  asset_class:   string | null
  type:          string | null
  currency:      string | null
  ngx_symbol:    string | null
  ngx_market:    string | null
  sector:        string | null
  approved:      boolean | null
  div_per_share: number | null
  div_yield_pct: number | null
  div_frequency: string | null
  last_div_date: string | null
  next_div_date: string | null
  div_status:    string | null
  coupon_pct:    number | null
  coupon_freq:   string | null
  maturity_date: string | null
  yield_pct:     number | null
}

type PriceRow = {
  price:      number | string | null
  price_date: string | null
}

type WatchlistRow = {
  ticker:   string
  section:  string | null
  sub_type: string | null
  active:   boolean | null
}

// v27az-fix4: no latest_price — that column doesn't exist on holdings.
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

type PMeta = {
  id:           string
  label?:       string
  client_code?: string
  client_name?: string
}

type DebugEntry = { stage: string; message: string; hint?: string }

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

// v27az-fix4: capture Supabase error shape for visibility
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
    .select('instrument_id, name, sleeve_id, asset_class, type, currency, ngx_symbol, ngx_market, sector, approved, div_per_share, div_yield_pct, div_frequency, last_div_date, next_div_date, div_status, coupon_pct, coupon_freq, maturity_date, yield_pct')
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

  // ─── 2. Latest 2 prices ─────────────────────────────────────
  const { data: priceRowsRaw, error: priceErr } = await db
    .from('market_prices')
    .select('price, price_date')
    .eq('instrument_id', ticker)
    .order('price_date', { ascending: false })
    .limit(2)
  captureErr('market-prices', priceErr, debug)
  const priceRows = (priceRowsRaw ?? []) as unknown as PriceRow[]

  const current_price = priceRows.length > 0 ? num(priceRows[0].price) : null
  const prev_price    = priceRows.length > 1 ? num(priceRows[1].price) : null
  const price_date    = priceRows.length > 0 ? priceRows[0].price_date : null

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
  // v27az-fix4: removed `latest_price` from SELECT (column doesn't
  // exist on holdings — the silent error here caused empty result).
  // Quantity > 0 filter moved client-side.
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
      // v27az-fix4: latest_price comes uniformly from market_prices;
      // fall back to avg_cost only if no current price exists at all.
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
      // v27az-fix4: same fixes — drop latest_price column, filter qty client-side.
      // Use a per-instrument-id price map from market_prices for valuation.
      const { data: rawSleeveHold, error: sleeveHoldErr } = await db
        .from('holdings')
        .select('instrument_id, quantity, avg_cost')
        .in('instrument_id', sleeveTickers)
      captureErr('sleeve-holdings', sleeveHoldErr, debug)
      const sleeveHoldRows = (rawSleeveHold ?? []) as unknown as Array<HoldingRow & { instrument_id: string }>

      // Fetch latest market price for each sleeve ticker in one query
      const { data: rawSleevePrices, error: sleevePricesErr } = await db
        .from('market_prices')
        .select('instrument_id, price, price_date')
        .in('instrument_id', sleeveTickers)
        .order('price_date', { ascending: false })
      captureErr('sleeve-prices', sleevePricesErr, debug)
      const sleevePriceRows = (rawSleevePrices ?? []) as unknown as Array<{ instrument_id: string; price: number | string | null; price_date: string }>

      // Latest-per-instrument: first occurrence (sorted desc by date)
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

  // ─── 7. Recent transactions (FEE excluded, INCOME included) ─
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

  // v27az-fix4: include _debug only if any errors occurred (keep
  // healthy responses lean)
  const response: Record<string, unknown> = {
    instrument,
    price: { current_price, price_date, day_change_pct, day_change_ngn },
    watchlist,
    holders,
    concentration,
    recent_transactions,
    firm_context: { firm_aum_ngn, firm_sleeve_total_ngn },
  }
  if (debug.length > 0) {
    response._debug = debug
  }

  return NextResponse.json(response)
}
