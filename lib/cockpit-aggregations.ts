// ═══════════════════════════════════════════════════════════════
// COCKPIT AGGREGATIONS (v27 → v27c → v27d)
// ═══════════════════════════════════════════════════════════════
//
// Pure aggregation helpers for the cockpit. Cross-portfolio reading,
// no business logic. Consumers: /api/cockpit/* routes.
//
// All numeric coercion at every Supabase boundary (pitfall #72).
// All large queries cap at 50000 rows (pitfall #59).
//
// v27b — fetchYTDReturns denominator fix (returns null when no Jan 1
//   nav_log entry, instead of falling back to starting_nav cost basis).
//
// v27c — three new helpers for the cockpit Phase-1 build-out:
//   - buildSectorExposureGrid: firm × portfolios heatmap (equity sleeve)
//   - buildTopMovers: top 5 gainers / losers across the firm book today,
//     weighted by aggregate NGN exposure
//   - buildFirmFIHoldings: aggregated FI holdings across all active
//     portfolios for the YieldCurvePanel firm overlay
//
// v27d — Cockpit Analytics Phase 2:
//   - fetchWatchlistTickers: equity-section watchlist as a Set, used by
//     mandate-health for the alignment check input
//   - buildHouseViews: tickers held by ≥2 portfolios, ranked by mandate
//     count then firm exposure (firm-wide conviction surface)
//   - buildWatchlistPulse: equity-section watchlist tickers moving today
//     (|day_change| ≥ threshold) but unheld by any active portfolio
//     (missed-opportunity surface)
// ═══════════════════════════════════════════════════════════════

import type { SupabaseClient } from '@supabase/supabase-js'

const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return isFinite(n) ? n : null
}
const num = (v: unknown, fallback = 0): number => numOrNull(v) ?? fallback

// ─── Types ─────────────────────────────────────────────────────
export interface PortfolioWithMeta {
  id:            string
  name:          string
  label:         string
  client_id:     string
  starting_nav:  number
  start_date:    string
  status:        string
  income_target: number
  liq_min:       number
  liq_max:       number | null   // derived from sleeve_targets
  dd_alert:      number
  dd_action:     number
  max_eq_single: number
  max_eq_sleeve: number
  client_name:   string
  client_code:   string
  client_type:   string         // 'discretionary' | 'advisory' | 'internal'
  is_internal:   boolean
  // v27ao: fee architecture pass-through. Optional so consumers
  // that don't need them stay unchanged.
  fee_model?:              'none' | 'performance_excess' | 'performance_hwm' | 'performance_combined' | 'fixed_annual' | null
  fixed_annual_fee_ngn?:   number | null
  target_return?:          number | null
  performance_fee_split?:  number | null
}

export interface AUMTrendPoint {
  date:     string  // ISO yyyy-mm-dd (month-end snapshots)
  aum_ngn:  number
}

export interface SleeveRollup {
  sleeve_id: string
  name:      string
  ngn:       number
  pct:       number
}

export interface IdleCashFlag {
  portfolio_id:   string
  portfolio_name: string
  client_name:    string
  cash_pct:       number   // actual liq sleeve %
  liq_max:        number | null   // upper band from sleeve_targets
  excess_ngn:     number   // (cash_pct - liq_max) × totalNAV
}

export interface StaleReportFlag {
  portfolio_id:   string
  portfolio_name: string
  client_name:    string
  last_report_date: string | null
  last_report_type: string | null
  days_overdue:     number     // 0 if within window
}

// v27c — Sector exposure grid types
export interface SectorExposureRow {
  portfolio_id:     string
  portfolio_name:   string
  client_code:      string
  client_name:      string
  is_internal:      boolean
  total_equity_nav: number      // total NGN in equity sleeve
  total_nav:        number      // total NGN across all sleeves
  sectors:          Record<string, number>  // ngn per sector
}

export interface SectorExposureData {
  sectors:      string[]                    // sorted desc by firm exposure
  firm_totals:  Record<string, number>      // ngn per sector firm-wide
  firm_total:   number                      // sum across all sectors
  portfolios:   SectorExposureRow[]         // sorted desc by total_equity_nav
}

// v27c → v27ap — Top movers types (windowed)
//
// MoverRow: one instrument's price change over a window.
//   change_pct = (latest_price - lookback_price) / lookback_price × 100
// For the 'day' window, lookback equals latest and change_pct is sourced
// from market_prices.day_change directly (preserving feed semantics).
// For week/month/quarter, lookback = closest price ≤ today − N days.
// Instruments with no usable lookback price are skipped from that window.
export interface MoverRow {
  instrument_id:     string
  name:              string
  sector:            string | null
  change_pct:        number     // signed percent over the window
  latest_price:      number
  latest_date:       string
  lookback_price:    number     // for 'day' window equals latest_price
  lookback_date:     string     // for 'day' window equals latest_date
  firm_exposure_ngn: number
  mandate_count:     number
  ngn_impact:        number     // signed = firm_exposure × change_pct/100
}

// One window's worth of mover analysis
export interface WindowMovers {
  gainers:                MoverRow[]
  losers:                 MoverRow[]
  as_of_date:             string | null   // max latest_date observed
  lookback_target_days:   number          // 0 (day) | 7 (week) | 30 (month) | 90 (quarter)
  instruments_with_data:  number          // held equities that produced a row
  total_held_instruments: number          // total equities held firm-wide
}

// Top movers across all four rolling windows (v27ap)
export interface TopMoversData {
  day:     WindowMovers
  week:    WindowMovers
  month:   WindowMovers
  quarter: WindowMovers
}

// v27c — Firm-wide FI holdings (for YieldCurvePanel firm overlay)
export interface FirmFIHolding {
  instrument_id:    string
  name:             string
  total_quantity:   number       // sum of face values
  mandate_count:    number       // distinct portfolios holding
  portfolio_codes:  string[]     // for tooltip display
}

// v27d — House Views types
export interface HouseViewMandatePosition {
  portfolio_id:    string
  portfolio_name:  string
  // v27ap: portfolio_label disambiguates clients with multiple mandates
  // (e.g., CKNET-A vs CKNET-B). Chip renders as client_code-portfolio_label.
  portfolio_label: string
  client_code:     string
  is_internal:     boolean
  ngn:             number
}

export interface HouseViewRow {
  instrument_id:            string
  name:                     string
  sector:                   string | null
  mandate_count:            number
  firm_exposure_ngn:        number
  share_of_firm_equity_pct: number     // decimal, e.g. 0.124 = 12.4%
  mandates:                 HouseViewMandatePosition[]   // sorted ngn desc
}

export interface HouseViewsData {
  rows:              HouseViewRow[]
  firm_equity_total: number   // total NGN across firm equity book
  total_unique:      number   // distinct equity tickers held firm-wide (incl. ≥1 mandate)
}

// v27d — Watchlist Pulse types
export interface WatchlistPulseRow {
  ticker:         string
  name:           string
  section:        string
  sector:         string | null
  day_change_pct: number     // signed
  latest_price:   number
  price_date:     string
}

export interface WatchlistPulseData {
  rows:           WatchlistPulseRow[]
  threshold_pct:  number       // |day_change| threshold used (e.g. 2.0)
  as_of_date:     string | null
  watchlist_size: number       // active equity watchlist universe size
  unheld_count:   number       // unheld active equity watchlist size (denom for pulse)
  below_threshold_count: number // unheld watchlist movers that didn't clear threshold
}

// ═══════════════════════════════════════════════════════════════
// 1. fetchAllActivePortfolios
//    Returns active portfolios with their client metadata.
// ═══════════════════════════════════════════════════════════════
export async function fetchAllActivePortfolios(
  db: SupabaseClient
): Promise<PortfolioWithMeta[]> {
  const { data, error } = await db
    .from('portfolios')
    .select(`
      id, name, label, client_id, starting_nav, start_date, status,
      income_target, liq_min, dd_alert, dd_action, max_eq_single, max_eq_sleeve,
      fee_model, fixed_annual_fee_ngn, target_return, performance_fee_split,
      client:clients(name, code, type)
    `)
    .eq('status', 'active')
    .order('name')
    .limit(2000)

  if (error || !data) return []

  // Fetch sleeve_targets liq max for each portfolio
  const portfolioIds = data.map((p: any) => p.id)
  const { data: liqRows } = await db
    .from('sleeve_targets')
    .select('portfolio_id, sleeve_id, max_pct')
    .in('portfolio_id', portfolioIds)
    .eq('sleeve_id', 'liq')
    .limit(50000)

  const liqMaxMap = new Map<string, number>()
  for (const r of (liqRows ?? []) as any[]) {
    const m = numOrNull(r.max_pct)
    if (m !== null) liqMaxMap.set(r.portfolio_id, m)
  }

  return (data as any[]).map((p: any) => ({
    id:            p.id,
    name:          p.name,
    label:         p.label,
    client_id:     p.client_id,
    starting_nav:  num(p.starting_nav),
    start_date:    p.start_date ?? '',
    status:        p.status,
    income_target: num(p.income_target),
    liq_min:       num(p.liq_min),
    liq_max:       liqMaxMap.get(p.id) ?? null,
    dd_alert:      num(p.dd_alert, -0.10),
    dd_action:     num(p.dd_action, -0.15),
    max_eq_single: num(p.max_eq_single, 0.10),
    max_eq_sleeve: num(p.max_eq_sleeve, 1.0),
    client_name:   p.client?.name ?? '—',
    client_code:   p.client?.code ?? '—',
    client_type:   p.client?.type ?? 'discretionary',
    // v27ao: is_internal honors both legacy client.type and new fee_model='none'
    is_internal:   p.client?.type === 'internal' || p.fee_model === 'none',
    fee_model:              p.fee_model ?? null,
    fixed_annual_fee_ngn:   numOrNull(p.fixed_annual_fee_ngn),
    target_return:          numOrNull(p.target_return),
    performance_fee_split:  numOrNull(p.performance_fee_split),
  }))
}

// ═══════════════════════════════════════════════════════════════
// 2. computePortfolioNAV — current market value
// ═══════════════════════════════════════════════════════════════
export async function computeAllPortfolioNAVs(
  db: SupabaseClient,
  portfolioIds: string[]
): Promise<Map<string, number>> {
  if (portfolioIds.length === 0) return new Map()

  const { data: holds } = await db
    .from('holdings')
    .select('portfolio_id, instrument_id, quantity, avg_cost')
    .in('portfolio_id', portfolioIds)
    .limit(50000)

  const allInstr = Array.from(new Set((holds ?? []).map((h: any) => h.instrument_id)))

  const priceMap = new Map<string, number>()
  if (allInstr.length > 0) {
    const { data: prices } = await db
      .from('market_prices')
      .select('instrument_id, price, price_date')
      .in('instrument_id', allInstr)
      .order('price_date', { ascending: false })
      .limit(50000)
    for (const p of (prices ?? []) as any[]) {
      if (!priceMap.has(p.instrument_id)) {
        const v = numOrNull(p.price)
        if (v !== null) priceMap.set(p.instrument_id, v)
      }
    }
  }

  const navByPortfolio = new Map<string, number>()
  for (const h of (holds ?? []) as any[]) {
    const qty = num(h.quantity)
    const px = priceMap.get(h.instrument_id) ?? num(h.avg_cost)
    const v = qty * px
    navByPortfolio.set(h.portfolio_id, (navByPortfolio.get(h.portfolio_id) ?? 0) + v)
  }
  return navByPortfolio
}

// ═══════════════════════════════════════════════════════════════
// 3. buildFirmAUMTrend — month-end snapshots over the last N months
// ═══════════════════════════════════════════════════════════════
export async function buildFirmAUMTrend(
  db: SupabaseClient,
  monthsBack: number = 12
): Promise<AUMTrendPoint[]> {
  const { data: portfolios } = await db
    .from('portfolios')
    .select('id')
    .eq('status', 'active')
    .limit(2000)
  if (!portfolios || portfolios.length === 0) return []
  const pids = (portfolios as any[]).map(p => p.id)

  const { data: navRows } = await db
    .from('nav_log')
    .select('portfolio_id, nav_date, nav_value')
    .in('portfolio_id', pids)
    .order('nav_date', { ascending: true })
    .limit(50000)
  if (!navRows || navRows.length === 0) return []

  const byPortfolio = new Map<string, { date: Date; value: number }[]>()
  for (const r of navRows as any[]) {
    const v = numOrNull(r.nav_value)
    if (v === null) continue
    const arr = byPortfolio.get(r.portfolio_id) ?? []
    arr.push({ date: new Date(r.nav_date), value: v })
    byPortfolio.set(r.portfolio_id, arr)
  }

  const today = new Date()
  const sampleDates: Date[] = []
  for (let i = monthsBack; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i + 1, 0)
    if (d > today) {
      sampleDates.push(today)
    } else {
      sampleDates.push(d)
    }
  }

  const trend: AUMTrendPoint[] = []
  for (const sample of sampleDates) {
    let total = 0
    for (const [, navs] of byPortfolio) {
      let lastValue = 0
      for (let i = navs.length - 1; i >= 0; i--) {
        if (navs[i].date <= sample) { lastValue = navs[i].value; break }
      }
      total += lastValue
    }
    trend.push({
      date:    sample.toISOString().slice(0, 10),
      aum_ngn: total,
    })
  }
  return trend
}

// ═══════════════════════════════════════════════════════════════
// 4. buildFirmAllocationRollup
// ═══════════════════════════════════════════════════════════════
export async function buildFirmAllocationRollup(
  db: SupabaseClient,
  portfolioIds: string[]
): Promise<SleeveRollup[]> {
  if (portfolioIds.length === 0) return []

  const { data: holds } = await db
    .from('holdings')
    .select('portfolio_id, instrument_id, quantity, avg_cost, sleeve_id, instrument:instruments(sleeve_id, type)')
    .in('portfolio_id', portfolioIds)
    .limit(50000)

  const allInstr = Array.from(new Set((holds ?? []).map((h: any) => h.instrument_id)))
  const priceMap = new Map<string, number>()
  if (allInstr.length > 0) {
    const { data: prices } = await db
      .from('market_prices')
      .select('instrument_id, price, price_date')
      .in('instrument_id', allInstr)
      .order('price_date', { ascending: false })
      .limit(50000)
    for (const p of (prices ?? []) as any[]) {
      if (!priceMap.has(p.instrument_id)) {
        const v = numOrNull(p.price)
        if (v !== null) priceMap.set(p.instrument_id, v)
      }
    }
  }

  const sleeveTotals = new Map<string, number>()
  for (const h of (holds ?? []) as any[]) {
    const qty = num(h.quantity)
    const px = priceMap.get(h.instrument_id) ?? num(h.avg_cost)
    const v = qty * px
    const sleeve = h.sleeve_id ?? h.instrument?.sleeve_id ?? 'other'
    sleeveTotals.set(sleeve, (sleeveTotals.get(sleeve) ?? 0) + v)
  }

  const total = Array.from(sleeveTotals.values()).reduce((s, v) => s + v, 0)

  const sleeveNameMap: Record<string, string> = {
    liq: 'Cash & Liquidity',
    eq:  'Equities (NGX)',
    fi:  'Fixed Income',
  }

  return Array.from(sleeveTotals.entries())
    .map(([sleeve_id, ngn]) => ({
      sleeve_id,
      name: sleeveNameMap[sleeve_id] ?? sleeve_id,
      ngn,
      pct: total > 0 ? ngn / total : 0,
    }))
    .sort((a, b) => b.ngn - a.ngn)
}

// ═══════════════════════════════════════════════════════════════
// 5. buildIdleCashFlags
// ═══════════════════════════════════════════════════════════════
export async function buildIdleCashFlags(
  db: SupabaseClient,
  portfolios: PortfolioWithMeta[],
  navMap: Map<string, number>
): Promise<IdleCashFlag[]> {
  if (portfolios.length === 0) return []

  const portfolioIds = portfolios.map(p => p.id)

  const { data: holds } = await db
    .from('holdings')
    .select('portfolio_id, instrument_id, quantity, avg_cost, sleeve_id')
    .in('portfolio_id', portfolioIds)
    .eq('sleeve_id', 'liq')
    .limit(50000)

  const cashByPortfolio = new Map<string, number>()
  const allInstr = Array.from(new Set((holds ?? []).map((h: any) => h.instrument_id)))
  const priceMap = new Map<string, number>()
  if (allInstr.length > 0) {
    const { data: prices } = await db
      .from('market_prices')
      .select('instrument_id, price, price_date')
      .in('instrument_id', allInstr)
      .order('price_date', { ascending: false })
      .limit(50000)
    for (const p of (prices ?? []) as any[]) {
      if (!priceMap.has(p.instrument_id)) {
        const v = numOrNull(p.price)
        if (v !== null) priceMap.set(p.instrument_id, v)
      }
    }
  }
  for (const h of (holds ?? []) as any[]) {
    const qty = num(h.quantity)
    const px = priceMap.get(h.instrument_id) ?? num(h.avg_cost, 1)
    cashByPortfolio.set(h.portfolio_id, (cashByPortfolio.get(h.portfolio_id) ?? 0) + qty * px)
  }

  const flags: IdleCashFlag[] = []
  for (const p of portfolios) {
    const cash = cashByPortfolio.get(p.id) ?? 0
    const totalNAV = navMap.get(p.id) ?? 0
    if (totalNAV <= 0) continue
    const cashPct = cash / totalNAV
    const liqMax = p.liq_max
    if (liqMax === null) continue
    if (cashPct <= liqMax) continue

    flags.push({
      portfolio_id:   p.id,
      portfolio_name: p.name,
      client_name:    p.client_name,
      cash_pct:       cashPct,
      liq_max:        liqMax,
      excess_ngn:     (cashPct - liqMax) * totalNAV,
    })
  }

  return flags.sort((a, b) => b.excess_ngn - a.excess_ngn)
}

// ═══════════════════════════════════════════════════════════════
// 6. buildStaleReports
// ═══════════════════════════════════════════════════════════════
export async function buildStaleReports(
  db: SupabaseClient,
  portfolios: PortfolioWithMeta[],
  daysThreshold: number = 100
): Promise<StaleReportFlag[]> {
  if (portfolios.length === 0) return []

  const portfolioIds = portfolios.map(p => p.id)
  const { data: reports } = await db
    .from('reports')
    .select('portfolio_id, report_date, report_type, created_at')
    .in('portfolio_id', portfolioIds)
    .order('report_date', { ascending: false })
    .limit(50000)

  const lastByPortfolio = new Map<string, { date: string; type: string }>()
  for (const r of (reports ?? []) as any[]) {
    if (!lastByPortfolio.has(r.portfolio_id)) {
      lastByPortfolio.set(r.portfolio_id, { date: r.report_date, type: r.report_type })
    }
  }

  const flags: StaleReportFlag[] = []
  const today = new Date()
  for (const p of portfolios) {
    const last = lastByPortfolio.get(p.id)
    if (!last) {
      flags.push({
        portfolio_id:     p.id,
        portfolio_name:   p.name,
        client_name:      p.client_name,
        last_report_date: null,
        last_report_type: null,
        days_overdue:     999,
      })
      continue
    }
    const lastDate = new Date(last.date)
    const daysSince = Math.round((today.getTime() - lastDate.getTime()) / 86_400_000)
    if (daysSince > daysThreshold) {
      flags.push({
        portfolio_id:     p.id,
        portfolio_name:   p.name,
        client_name:      p.client_name,
        last_report_date: last.date,
        last_report_type: last.type,
        days_overdue:     daysSince - daysThreshold,
      })
    }
  }
  return flags.sort((a, b) => b.days_overdue - a.days_overdue)
}

// ═══════════════════════════════════════════════════════════════
// 7. fetchYTDReturns — v27b denominator fix preserved
// ═══════════════════════════════════════════════════════════════
export async function fetchYTDReturns(
  db: SupabaseClient,
  portfolios: PortfolioWithMeta[],
  navMap: Map<string, number>
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>()
  if (portfolios.length === 0) return out

  const today = new Date()
  const yStart = new Date(today.getFullYear(), 0, 1)
  const yStartIso = yStart.toISOString().slice(0, 10)

  const portfolioIds = portfolios.map(p => p.id)
  const { data: navRows } = await db
    .from('nav_log')
    .select('portfolio_id, nav_date, nav_value')
    .in('portfolio_id', portfolioIds)
    .lte('nav_date', yStartIso)
    .order('nav_date', { ascending: false })
    .limit(50000)

  const navAtYearStartMap = new Map<string, number>()
  for (const r of (navRows ?? []) as any[]) {
    if (!navAtYearStartMap.has(r.portfolio_id)) {
      const v = numOrNull(r.nav_value)
      if (v !== null) navAtYearStartMap.set(r.portfolio_id, v)
    }
  }

  const { data: txns } = await db
    .from('transactions')
    .select('portfolio_id, trade_date, action, amount, gross_value')
    .in('portfolio_id', portfolioIds)
    .gte('trade_date', yStartIso)
    .in('action', ['TRANSFER_IN', 'TRANSFER_OUT', 'FEE'])
    .limit(50000)

  const flowsByPortfolio = new Map<string, { inflow: number; outflow: number }>()
  for (const t of (txns ?? []) as any[]) {
    const amt = Math.abs(num(t.amount, num(t.gross_value, 0)))
    const cur = flowsByPortfolio.get(t.portfolio_id) ?? { inflow: 0, outflow: 0 }
    if (t.action === 'TRANSFER_IN') cur.inflow += amt
    else cur.outflow += amt
    flowsByPortfolio.set(t.portfolio_id, cur)
  }

  for (const p of portfolios) {
    const startedThisYear = p.start_date ? new Date(p.start_date) >= yStart : false

    let nav0: number | null
    if (startedThisYear) {
      nav0 = p.starting_nav > 0 ? p.starting_nav : null
    } else {
      const janNav = navAtYearStartMap.get(p.id)
      nav0 = (janNav !== undefined && janNav > 0) ? janNav : null
    }

    if (nav0 === null) {
      out.set(p.id, null)
      continue
    }

    const navN = navMap.get(p.id) ?? 0
    const flows = flowsByPortfolio.get(p.id) ?? { inflow: 0, outflow: 0 }
    const ytdReturn = (navN - nav0 - flows.inflow + flows.outflow) / nav0
    out.set(p.id, ytdReturn)
  }
  return out
}

// ═══════════════════════════════════════════════════════════════
// 8. Recent transactions count per portfolio
// ═══════════════════════════════════════════════════════════════
export async function fetchRecentTxnCounts(
  db: SupabaseClient,
  portfolioIds: string[],
  days: number = 90
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (portfolioIds.length === 0) return out

  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)
  const cutoffIso = cutoff.toISOString().slice(0, 10)

  const { data: txns } = await db
    .from('transactions')
    .select('portfolio_id, action, trade_date')
    .in('portfolio_id', portfolioIds)
    .gte('trade_date', cutoffIso)
    .neq('action', 'FEE')
    .limit(50000)

  for (const t of (txns ?? []) as any[]) {
    out.set(t.portfolio_id, (out.get(t.portfolio_id) ?? 0) + 1)
  }
  return out
}

// ═══════════════════════════════════════════════════════════════
// 9. Days since last report per portfolio
// ═══════════════════════════════════════════════════════════════
export async function fetchDaysSinceLastReport(
  db: SupabaseClient,
  portfolioIds: string[]
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>()
  if (portfolioIds.length === 0) return out

  const { data: reports } = await db
    .from('reports')
    .select('portfolio_id, report_date')
    .in('portfolio_id', portfolioIds)
    .order('report_date', { ascending: false })
    .limit(50000)

  const today = new Date()
  for (const r of (reports ?? []) as any[]) {
    if (!out.has(r.portfolio_id)) {
      const d = new Date(r.report_date)
      const days = Math.round((today.getTime() - d.getTime()) / 86_400_000)
      out.set(r.portfolio_id, days)
    }
  }
  for (const pid of portfolioIds) {
    if (!out.has(pid)) out.set(pid, null)
  }
  return out
}

// ═══════════════════════════════════════════════════════════════
// 10. Year-start NAVs and yearly cashflows for fee-outlook engine
// ═══════════════════════════════════════════════════════════════
export async function fetchFeeOutlookInputs(
  db: SupabaseClient,
  portfolios: PortfolioWithMeta[]
): Promise<Map<string, { navAtYearStart: number | null; yearlyCashflows: { date: string; amount: number; action: string }[] }>> {
  const out = new Map<string, { navAtYearStart: number | null; yearlyCashflows: any[] }>()
  if (portfolios.length === 0) return out

  const today = new Date()
  const yStart = new Date(today.getFullYear(), 0, 1)
  const yStartIso = yStart.toISOString().slice(0, 10)

  const portfolioIds = portfolios.map(p => p.id)

  const { data: navRows } = await db
    .from('nav_log')
    .select('portfolio_id, nav_date, nav_value')
    .in('portfolio_id', portfolioIds)
    .lte('nav_date', yStartIso)
    .order('nav_date', { ascending: false })
    .limit(50000)
  const navAtMap = new Map<string, number>()
  for (const r of (navRows ?? []) as any[]) {
    if (!navAtMap.has(r.portfolio_id)) {
      const v = numOrNull(r.nav_value)
      if (v !== null) navAtMap.set(r.portfolio_id, v)
    }
  }

  const { data: txns } = await db
    .from('transactions')
    .select('portfolio_id, trade_date, action, amount, gross_value')
    .in('portfolio_id', portfolioIds)
    .gte('trade_date', yStartIso)
    .in('action', ['TRANSFER_IN', 'TRANSFER_OUT'])
    .limit(50000)
  const flowsByPortfolio = new Map<string, { date: string; amount: number; action: string }[]>()
  for (const t of (txns ?? []) as any[]) {
    const amt = num(t.amount, num(t.gross_value, 0))
    if (amt === 0) continue
    const arr = flowsByPortfolio.get(t.portfolio_id) ?? []
    arr.push({
      date:   t.trade_date,
      amount: amt,
      action: t.action,
    })
    flowsByPortfolio.set(t.portfolio_id, arr)
  }

  for (const p of portfolios) {
    out.set(p.id, {
      navAtYearStart: navAtMap.get(p.id) ?? null,
      yearlyCashflows: flowsByPortfolio.get(p.id) ?? [],
    })
  }
  return out
}

// ═══════════════════════════════════════════════════════════════
// 11. fetchHoldingsForPortfolios — bulk holdings hydration
// ═══════════════════════════════════════════════════════════════
export async function fetchHoldingsForPortfolios(
  db: SupabaseClient,
  portfolioIds: string[]
): Promise<Map<string, any[]>> {
  const out = new Map<string, any[]>()
  if (portfolioIds.length === 0) return out

  const { data: holds } = await db
    .from('holdings')
    .select('*, instrument:instruments(*)')
    .in('portfolio_id', portfolioIds)
    .limit(50000)

  const allInstr = Array.from(new Set((holds ?? []).map((h: any) => h.instrument_id)))
  const priceMap = new Map<string, number>()
  if (allInstr.length > 0) {
    const { data: prices } = await db
      .from('market_prices')
      .select('instrument_id, price, price_date')
      .in('instrument_id', allInstr)
      .order('price_date', { ascending: false })
      .limit(50000)
    for (const p of (prices ?? []) as any[]) {
      if (!priceMap.has(p.instrument_id)) {
        const v = numOrNull(p.price)
        if (v !== null) priceMap.set(p.instrument_id, v)
      }
    }
  }

  for (const h of (holds ?? []) as any[]) {
    const qty = num(h.quantity)
    const avgCost = num(h.avg_cost)
    const latest = priceMap.get(h.instrument_id) ?? avgCost
    const hydrated = {
      ...h,
      quantity:    qty,
      avg_cost:    avgCost,
      latest_price: latest,
    }
    const arr = out.get(h.portfolio_id) ?? []
    arr.push(hydrated)
    out.set(h.portfolio_id, arr)
  }

  return out
}

// ═══════════════════════════════════════════════════════════════
// 12. fetchSleeveTargetsForPortfolios — bulk sleeve targets
// ═══════════════════════════════════════════════════════════════
export async function fetchSleeveTargetsForPortfolios(
  db: SupabaseClient,
  portfolioIds: string[]
): Promise<Map<string, any[]>> {
  const out = new Map<string, any[]>()
  if (portfolioIds.length === 0) return out

  const { data } = await db
    .from('sleeve_targets')
    .select('*')
    .in('portfolio_id', portfolioIds)
    .order('sort_order')
    .limit(50000)

  for (const r of (data ?? []) as any[]) {
    const hydrated = {
      ...r,
      target_pct: num(r.target_pct),
      min_pct:    num(r.min_pct),
      max_pct:    num(r.max_pct, 1),
    }
    const arr = out.get(r.portfolio_id) ?? []
    arr.push(hydrated)
    out.set(r.portfolio_id, arr)
  }
  return out
}

// ═══════════════════════════════════════════════════════════════
// 13. fetchNavHistoryForPortfolios — for drawdown computation
// ═══════════════════════════════════════════════════════════════
export async function fetchNavHistoryForPortfolios(
  db: SupabaseClient,
  portfolioIds: string[]
): Promise<Map<string, { nav_date: string; nav_value: number }[]>> {
  const out = new Map<string, { nav_date: string; nav_value: number }[]>()
  if (portfolioIds.length === 0) return out

  const { data } = await db
    .from('nav_log')
    .select('portfolio_id, nav_date, nav_value')
    .in('portfolio_id', portfolioIds)
    .order('nav_date', { ascending: true })
    .limit(50000)

  for (const r of (data ?? []) as any[]) {
    const v = numOrNull(r.nav_value)
    if (v === null) continue
    const arr = out.get(r.portfolio_id) ?? []
    arr.push({ nav_date: r.nav_date, nav_value: v })
    out.set(r.portfolio_id, arr)
  }
  return out
}

// ═══════════════════════════════════════════════════════════════
// 14. v27c — buildSectorExposureGrid
//
// Firm × portfolios sector heatmap (equity sleeve only).
// For each active portfolio: sum equity holdings NGN by NGX sector.
// Sectors are sorted by firm-wide NGN exposure descending.
// Portfolios are sorted by total equity NAV descending.
// NULL sector → 'Unclassified'.
// Internal portfolios are included (caller decides whether to dim them).
// ═══════════════════════════════════════════════════════════════
export async function buildSectorExposureGrid(
  db: SupabaseClient,
  portfolios: PortfolioWithMeta[],
  navMap: Map<string, number>
): Promise<SectorExposureData> {
  if (portfolios.length === 0) {
    return { sectors: [], firm_totals: {}, firm_total: 0, portfolios: [] }
  }

  const portfolioIds = portfolios.map(p => p.id)

  // Pull equity holdings only — instrument.sleeve_id = 'eq' OR holding.sleeve_id = 'eq'
  const { data: holds } = await db
    .from('holdings')
    .select('portfolio_id, instrument_id, quantity, avg_cost, sleeve_id, instrument:instruments(sleeve_id, type, sector)')
    .in('portfolio_id', portfolioIds)
    .limit(50000)

  // Latest market price per instrument
  const allInstr = Array.from(new Set((holds ?? []).map((h: any) => h.instrument_id)))
  const priceMap = new Map<string, number>()
  if (allInstr.length > 0) {
    const { data: prices } = await db
      .from('market_prices')
      .select('instrument_id, price, price_date')
      .in('instrument_id', allInstr)
      .order('price_date', { ascending: false })
      .limit(50000)
    for (const p of (prices ?? []) as any[]) {
      if (!priceMap.has(p.instrument_id)) {
        const v = numOrNull(p.price)
        if (v !== null) priceMap.set(p.instrument_id, v)
      }
    }
  }

  // Walk holdings, accumulate NGN per (portfolio, sector)
  const portfolioSectorMap = new Map<string, Map<string, number>>()  // pid → sector → ngn
  const portfolioEquityNav = new Map<string, number>()
  const firmTotalsByeSector = new Map<string, number>()

  for (const h of (holds ?? []) as any[]) {
    const sleeve = h.sleeve_id ?? h.instrument?.sleeve_id ?? 'other'
    if (sleeve !== 'eq' && h.instrument?.type !== 'Stock') continue
    const qty = num(h.quantity)
    if (qty <= 0) continue
    const px = priceMap.get(h.instrument_id) ?? num(h.avg_cost)
    const ngn = qty * px
    if (ngn <= 0) continue

    const sector = (h.instrument?.sector ?? '').trim() || 'Unclassified'

    let sectorMap = portfolioSectorMap.get(h.portfolio_id)
    if (!sectorMap) { sectorMap = new Map(); portfolioSectorMap.set(h.portfolio_id, sectorMap) }
    sectorMap.set(sector, (sectorMap.get(sector) ?? 0) + ngn)

    portfolioEquityNav.set(h.portfolio_id, (portfolioEquityNav.get(h.portfolio_id) ?? 0) + ngn)
    firmTotalsByeSector.set(sector, (firmTotalsByeSector.get(sector) ?? 0) + ngn)
  }

  // Sort sectors by firm exposure desc
  const sortedSectors = Array.from(firmTotalsByeSector.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([s]) => s)

  const firmTotal = Array.from(firmTotalsByeSector.values()).reduce((s, v) => s + v, 0)

  // Build per-portfolio rows
  const rows: SectorExposureRow[] = []
  for (const p of portfolios) {
    const sectorMap = portfolioSectorMap.get(p.id) ?? new Map()
    const sectors: Record<string, number> = {}
    for (const [s, n] of sectorMap) sectors[s] = n
    const totalEquityNav = portfolioEquityNav.get(p.id) ?? 0
    rows.push({
      portfolio_id:     p.id,
      portfolio_name:   p.name,
      client_code:      p.client_code,
      client_name:      p.client_name,
      is_internal:      p.is_internal,
      total_equity_nav: totalEquityNav,
      total_nav:        navMap.get(p.id) ?? 0,
      sectors,
    })
  }

  // Sort portfolios by total equity NAV desc, internal sinks to bottom
  rows.sort((a, b) => {
    if (a.is_internal !== b.is_internal) return a.is_internal ? 1 : -1
    return b.total_equity_nav - a.total_equity_nav
  })

  const firm_totals: Record<string, number> = {}
  for (const [s, n] of firmTotalsByeSector) firm_totals[s] = n

  return {
    sectors:    sortedSectors,
    firm_totals,
    firm_total: firmTotal,
    portfolios: rows,
  }
}

// ═══════════════════════════════════════════════════════════════
// 15. v27c → v27ap — buildTopMovers (windowed)
//
// Returns top 5 gainers / losers across firm equity holdings in each of
// four rolling windows: day (0d), week (7d), month (30d), quarter (90d).
//
// Lookback math: latest price minus closest available price ≤ N days ago,
// over latest. Handles weekend gaps and NGX trading-day sparsity by
// taking the most-recent price_date that is still at-or-before the
// target lookback date. Instruments with no usable baseline are skipped
// from that window only — other windows continue unaffected.
//
// Each window self-reports instruments_with_data + total_held_instruments
// so the panel can render data-sufficiency banners ("insufficient",
// "limited", or fully populated) honestly without code-side suppression.
//
// Equity-only — NGX bonds aren't priced daily.
// ═══════════════════════════════════════════════════════════════

const WINDOW_DAYS = { day: 0, week: 7, month: 30, quarter: 90 } as const
type WindowKey = keyof typeof WINDOW_DAYS

function emptyWindow(targetDays: number, totalHeld: number): WindowMovers {
  return {
    gainers: [],
    losers: [],
    as_of_date: null,
    lookback_target_days: targetDays,
    instruments_with_data: 0,
    total_held_instruments: totalHeld,
  }
}

export async function buildTopMovers(
  db: SupabaseClient,
  portfolios: PortfolioWithMeta[],
): Promise<TopMoversData> {
  const empty: TopMoversData = {
    day:     emptyWindow(WINDOW_DAYS.day,     0),
    week:    emptyWindow(WINDOW_DAYS.week,    0),
    month:   emptyWindow(WINDOW_DAYS.month,   0),
    quarter: emptyWindow(WINDOW_DAYS.quarter, 0),
  }
  if (portfolios.length === 0) return empty

  const portfolioIds = portfolios.map(p => p.id)

  // Pull equity holdings only
  const { data: holds } = await db
    .from('holdings')
    .select('portfolio_id, instrument_id, quantity, avg_cost, instrument:instruments(name, type, sector, sleeve_id)')
    .in('portfolio_id', portfolioIds)
    .limit(50000)

  // Aggregate qty/portfolios/meta per instrument across firm
  const qtyByInstr        = new Map<string, number>()
  const portfoliosByInstr = new Map<string, Set<string>>()
  const metaByInstr       = new Map<string, { name: string; sector: string | null }>()

  for (const h of (holds ?? []) as any[]) {
    const sleeve = h.instrument?.sleeve_id
    const itype  = h.instrument?.type
    if (sleeve !== 'eq' && itype !== 'Stock') continue
    const qty = num(h.quantity)
    if (qty <= 0) continue
    qtyByInstr.set(h.instrument_id, (qtyByInstr.get(h.instrument_id) ?? 0) + qty)
    let pset = portfoliosByInstr.get(h.instrument_id)
    if (!pset) { pset = new Set(); portfoliosByInstr.set(h.instrument_id, pset) }
    pset.add(h.portfolio_id)
    if (!metaByInstr.has(h.instrument_id)) {
      metaByInstr.set(h.instrument_id, {
        name:   h.instrument?.name ?? h.instrument_id,
        sector: h.instrument?.sector ?? null,
      })
    }
  }

  const totalHeld = qtyByInstr.size
  if (totalHeld === 0) return empty

  // Fetch prices over the longest window we need (90 days back, plus a 14-day
  // buffer for non-trading-day baseline lookups).
  const today = new Date()
  const oldestNeededMs = today.getTime() - (WINDOW_DAYS.quarter + 14) * 86_400_000
  const oldestIso = new Date(oldestNeededMs).toISOString().slice(0, 10)

  const instrIds = Array.from(qtyByInstr.keys())
  const { data: prices } = await db
    .from('market_prices')
    .select('instrument_id, price, price_date, day_change')
    .in('instrument_id', instrIds)
    .gte('price_date', oldestIso)
    .order('price_date', { ascending: false })
    .limit(50000)

  // Group prices by instrument (already date-desc sorted from query)
  const priceHistByInstr = new Map<string, Array<{ price: number; price_date: string; day_change: number | null }>>()
  for (const p of (prices ?? []) as any[]) {
    const px = numOrNull(p.price)
    if (px === null) continue
    const arr = priceHistByInstr.get(p.instrument_id) ?? []
    arr.push({
      price:      px,
      price_date: p.price_date,
      day_change: numOrNull(p.day_change),
    })
    priceHistByInstr.set(p.instrument_id, arr)
  }

  const cutoffIso = (days: number): string => {
    const d = new Date(today.getTime() - days * 86_400_000)
    return d.toISOString().slice(0, 10)
  }

  const moversByWindow: Record<WindowKey, MoverRow[]> = {
    day: [], week: [], month: [], quarter: [],
  }

  for (const [instrId, qty] of qtyByInstr) {
    const hist = priceHistByInstr.get(instrId)
    if (!hist || hist.length === 0) continue

    const meta     = metaByInstr.get(instrId)!
    const latest   = hist[0]
    const exposure = qty * latest.price
    if (exposure <= 0) continue

    // Day window: use feed-supplied day_change column directly
    if (latest.day_change !== null && latest.day_change !== 0) {
      const ngnImpact = exposure * (latest.day_change / 100)
      moversByWindow.day.push({
        instrument_id:     instrId,
        name:              meta.name,
        sector:            meta.sector,
        change_pct:        latest.day_change,
        latest_price:      latest.price,
        latest_date:       latest.price_date,
        lookback_price:    latest.price,
        lookback_date:     latest.price_date,
        firm_exposure_ngn: exposure,
        mandate_count:     portfoliosByInstr.get(instrId)?.size ?? 0,
        ngn_impact:        ngnImpact,
      })
    }

    // Week / month / quarter: find lookback = first row with date ≤ cutoff
    for (const [wkey, days] of Object.entries(WINDOW_DAYS) as [WindowKey, number][]) {
      if (wkey === 'day') continue
      const cutoff = cutoffIso(days)
      const lookback = hist.find(p => p.price_date <= cutoff)
      if (!lookback) continue   // not enough history for this window
      if (lookback.price <= 0) continue
      const changePct = ((latest.price - lookback.price) / lookback.price) * 100
      if (changePct === 0) continue
      const ngnImpact = exposure * (changePct / 100)
      moversByWindow[wkey].push({
        instrument_id:     instrId,
        name:              meta.name,
        sector:            meta.sector,
        change_pct:        changePct,
        latest_price:      latest.price,
        latest_date:       latest.price_date,
        lookback_price:    lookback.price,
        lookback_date:     lookback.price_date,
        firm_exposure_ngn: exposure,
        mandate_count:     portfoliosByInstr.get(instrId)?.size ?? 0,
        ngn_impact:        ngnImpact,
      })
    }
  }

  // Build each window's result with sort, slice, and as_of_date
  const result: TopMoversData = {
    day:     emptyWindow(WINDOW_DAYS.day,     totalHeld),
    week:    emptyWindow(WINDOW_DAYS.week,    totalHeld),
    month:   emptyWindow(WINDOW_DAYS.month,   totalHeld),
    quarter: emptyWindow(WINDOW_DAYS.quarter, totalHeld),
  }

  for (const wkey of Object.keys(WINDOW_DAYS) as WindowKey[]) {
    const movers = moversByWindow[wkey]
    if (movers.length === 0) continue
    const gainers = movers
      .filter(m => m.change_pct > 0)
      .sort((a, b) => b.ngn_impact - a.ngn_impact)
      .slice(0, 5)
    const losers = movers
      .filter(m => m.change_pct < 0)
      .sort((a, b) => a.ngn_impact - b.ngn_impact)
      .slice(0, 5)
    const asOfDate = movers.reduce<string | null>((acc, m) => {
      if (!acc || m.latest_date > acc) return m.latest_date
      return acc
    }, null)
    result[wkey] = {
      gainers,
      losers,
      as_of_date:             asOfDate,
      lookback_target_days:   WINDOW_DAYS[wkey],
      instruments_with_data:  movers.length,
      total_held_instruments: totalHeld,
    }
  }

  return result
}

// ═══════════════════════════════════════════════════════════════
// 16. v27c — buildFirmFIHoldings
//
// Aggregated FI holdings across all active portfolios.
// One row per FI instrument actually held by ≥1 active portfolio.
// Used by YieldCurvePanel firm overlay.
// ═══════════════════════════════════════════════════════════════
export async function buildFirmFIHoldings(
  db: SupabaseClient,
  portfolios: PortfolioWithMeta[]
): Promise<FirmFIHolding[]> {
  if (portfolios.length === 0) return []

  const portfolioIds = portfolios.map(p => p.id)
  const portfolioCodeMap = new Map(portfolios.map(p => [p.id, p.client_code]))

  const { data: holds } = await db
    .from('holdings')
    .select('portfolio_id, instrument_id, quantity, instrument:instruments(name, sleeve_id)')
    .in('portfolio_id', portfolioIds)
    .limit(50000)

  const qtyByInstr      = new Map<string, number>()
  const namesByInstr    = new Map<string, string>()
  const codesByInstr    = new Map<string, Set<string>>()

  for (const h of (holds ?? []) as any[]) {
    const sleeve = h.instrument?.sleeve_id
    if (sleeve !== 'fi') continue
    const qty = num(h.quantity)
    if (qty <= 0) continue
    qtyByInstr.set(h.instrument_id, (qtyByInstr.get(h.instrument_id) ?? 0) + qty)
    if (!namesByInstr.has(h.instrument_id)) {
      namesByInstr.set(h.instrument_id, h.instrument?.name ?? h.instrument_id)
    }
    let codes = codesByInstr.get(h.instrument_id)
    if (!codes) { codes = new Set(); codesByInstr.set(h.instrument_id, codes) }
    const code = portfolioCodeMap.get(h.portfolio_id)
    if (code) codes.add(code)
  }

  const out: FirmFIHolding[] = []
  for (const [id, q] of qtyByInstr) {
    const codes = Array.from(codesByInstr.get(id) ?? []).sort()
    out.push({
      instrument_id:   id,
      name:            namesByInstr.get(id) ?? id,
      total_quantity:  q,
      mandate_count:   codes.length,
      portfolio_codes: codes,
    })
  }

  return out.sort((a, b) => b.total_quantity - a.total_quantity)
}

// ═══════════════════════════════════════════════════════════════
// 17. v27d — fetchWatchlistTickers
//
// Returns the active equity-section watchlist as a Set of tickers.
// Used by mandate-health for the watchlist alignment check input,
// and by buildWatchlistPulse as the pulse universe.
//
// Schema: watchlist.ticker (nullable text), watchlist.section,
// watchlist.active. Section values: 'equity' | 'fixed_income' |
// 'other' | 'watch'. The 'equity' section IS the firm's research
// universe for active mandate-fit scoring.
//
// Called once per cockpit health request.
// ═══════════════════════════════════════════════════════════════
export async function fetchWatchlistTickers(
  db: SupabaseClient,
  sections: string[] = ['equity']
): Promise<Set<string>> {
  const out = new Set<string>()
  const { data } = await db
    .from('watchlist')
    .select('ticker, section, active')
    .in('section', sections)
    .eq('active', true)
    .limit(2000)

  for (const r of (data ?? []) as any[]) {
    const t = r.ticker ? String(r.ticker).trim() : ''
    if (t.length > 0) out.add(t)
  }
  return out
}

// ═══════════════════════════════════════════════════════════════
// 18. v27d — buildHouseViews
//
// Tickers held by ≥2 active portfolios across the firm. Surfaces the
// firm's "high-conviction" positions concentrated across mandates.
//
// Equity-only (FI bonds are usually mandate-specific, not house views).
// Sort: mandate_count desc, then firm_exposure_ngn desc.
// Per row: ticker, name, sector, mandate count, firm exposure NGN,
// share of firm equity book %, and per-mandate breakdown.
//
// share_of_firm_equity_pct denominator = sum across firm of equity
// holdings NGN. Match the same definition used by buildSectorExposureGrid
// for the firm equity book.
// ═══════════════════════════════════════════════════════════════
export async function buildHouseViews(
  db: SupabaseClient,
  portfolios: PortfolioWithMeta[]
): Promise<HouseViewsData> {
  const empty: HouseViewsData = { rows: [], firm_equity_total: 0, total_unique: 0 }
  if (portfolios.length === 0) return empty

  const portfolioIds = portfolios.map(p => p.id)
  const portfolioMeta = new Map(portfolios.map(p => [p.id, p]))

  const { data: holds } = await db
    .from('holdings')
    .select('portfolio_id, instrument_id, quantity, avg_cost, instrument:instruments(name, type, sector, sleeve_id)')
    .in('portfolio_id', portfolioIds)
    .limit(50000)

  // Latest price per instrument
  const allInstr = Array.from(new Set((holds ?? []).map((h: any) => h.instrument_id)))
  const priceMap = new Map<string, number>()
  if (allInstr.length > 0) {
    const { data: prices } = await db
      .from('market_prices')
      .select('instrument_id, price, price_date')
      .in('instrument_id', allInstr)
      .order('price_date', { ascending: false })
      .limit(50000)
    for (const p of (prices ?? []) as any[]) {
      if (!priceMap.has(p.instrument_id)) {
        const v = numOrNull(p.price)
        if (v !== null) priceMap.set(p.instrument_id, v)
      }
    }
  }

  // Group: instrument → list of mandate positions
  type Entry = {
    name:      string
    sector:    string | null
    positions: HouseViewMandatePosition[]
  }
  const byInstr = new Map<string, Entry>()
  let firmEquityTotal = 0

  for (const h of (holds ?? []) as any[]) {
    const sleeve = h.instrument?.sleeve_id
    const itype  = h.instrument?.type
    if (sleeve !== 'eq' && itype !== 'Stock') continue
    const qty = num(h.quantity)
    if (qty <= 0) continue
    const px = priceMap.get(h.instrument_id) ?? num(h.avg_cost)
    const ngn = qty * px
    if (ngn <= 0) continue

    const meta = portfolioMeta.get(h.portfolio_id)
    if (!meta) continue

    let entry = byInstr.get(h.instrument_id)
    if (!entry) {
      entry = {
        name:      h.instrument?.name ?? h.instrument_id,
        sector:    (h.instrument?.sector ?? '').trim() || null,
        positions: [],
      }
      byInstr.set(h.instrument_id, entry)
    }
    entry.positions.push({
      portfolio_id:    meta.id,
      portfolio_name:  meta.name,
      portfolio_label: meta.label,   // v27ap: chip disambiguation
      client_code:     meta.client_code,
      is_internal:     meta.is_internal,
      ngn,
    })
    firmEquityTotal += ngn
  }

  const totalUnique = byInstr.size

  const rows: HouseViewRow[] = []
  for (const [id, entry] of byInstr) {
    if (entry.positions.length < 2) continue   // ≥2 mandate threshold
    const exposureNgn = entry.positions.reduce((s, p) => s + p.ngn, 0)
    rows.push({
      instrument_id:            id,
      name:                     entry.name,
      sector:                   entry.sector,
      mandate_count:            entry.positions.length,
      firm_exposure_ngn:        exposureNgn,
      share_of_firm_equity_pct: firmEquityTotal > 0 ? exposureNgn / firmEquityTotal : 0,
      mandates:                 entry.positions.slice().sort((a, b) => b.ngn - a.ngn),
    })
  }

  rows.sort((a, b) => {
    if (b.mandate_count !== a.mandate_count) return b.mandate_count - a.mandate_count
    return b.firm_exposure_ngn - a.firm_exposure_ngn
  })

  return {
    rows,
    firm_equity_total: firmEquityTotal,
    total_unique:      totalUnique,
  }
}

// ═══════════════════════════════════════════════════════════════
// 19. v27d — buildWatchlistPulse
//
// Tickers in the active equity watchlist that:
//   - are NOT held by any active portfolio
//   - have |day_change_pct| ≥ thresholdPct today
//
// Surfaces "missed opportunities" — names the firm has researched
// but isn't currently expressing in any client mandate, that moved
// today.
//
// Sort: |day_change_pct| descending, capped at maxRows.
// thresholdPct default 2.0% (NGX equity meaningful-move threshold).
// as_of_date = max price_date observed across the unheld watchlist.
//
// Returns metadata fields (watchlist_size, unheld_count,
// below_threshold_count) for the panel footer to give context on
// what fraction of the universe is moving.
// ═══════════════════════════════════════════════════════════════
export async function buildWatchlistPulse(
  db: SupabaseClient,
  portfolios: PortfolioWithMeta[],
  thresholdPct: number = 2.0,
  maxRows: number = 10
): Promise<WatchlistPulseData> {
  const empty: WatchlistPulseData = {
    rows:                  [],
    threshold_pct:         thresholdPct,
    as_of_date:            null,
    watchlist_size:        0,
    unheld_count:          0,
    below_threshold_count: 0,
  }

  // Pull active equity-section watchlist
  const { data: watchData } = await db
    .from('watchlist')
    .select('ticker, name, section, active')
    .eq('section', 'equity')
    .eq('active', true)
    .limit(2000)

  const watchTickers = (watchData ?? [])
    .filter((w: any) => w.ticker && String(w.ticker).trim().length > 0)
    .map((w: any) => ({
      ticker:  String(w.ticker).trim(),
      name:    String(w.name ?? ''),
      section: String(w.section ?? 'equity'),
    }))

  const watchlistSize = watchTickers.length
  if (watchlistSize === 0) return empty

  // Build set of held instrument_ids across all active portfolios
  const portfolioIds = portfolios.map(p => p.id)
  const heldSet = new Set<string>()
  if (portfolioIds.length > 0) {
    const { data: holds } = await db
      .from('holdings')
      .select('instrument_id, quantity')
      .in('portfolio_id', portfolioIds)
      .limit(50000)
    for (const h of (holds ?? []) as any[]) {
      if (num(h.quantity) > 0) heldSet.add(h.instrument_id)
    }
  }

  const unheldTickers = watchTickers.filter(w => !heldSet.has(w.ticker))
  const unheldCount = unheldTickers.length
  if (unheldCount === 0) {
    return { ...empty, watchlist_size: watchlistSize, unheld_count: 0 }
  }

  const tickerIds = unheldTickers.map(w => w.ticker)

  // Latest price per ticker (with day_change)
  const { data: prices } = await db
    .from('market_prices')
    .select('instrument_id, price, price_date, day_change')
    .in('instrument_id', tickerIds)
    .order('price_date', { ascending: false })
    .limit(50000)

  const latestByInstr = new Map<string, { price: number; day_change: number; price_date: string }>()
  let maxPriceDate: string | null = null
  for (const p of (prices ?? []) as any[]) {
    if (latestByInstr.has(p.instrument_id)) continue
    const px  = numOrNull(p.price)
    const chg = numOrNull(p.day_change)
    if (px === null || chg === null) continue
    latestByInstr.set(p.instrument_id, {
      price: px,
      day_change: chg,
      price_date: p.price_date,
    })
    if (!maxPriceDate || p.price_date > maxPriceDate) maxPriceDate = p.price_date
  }

  // Sector lookup from instruments
  const { data: instrs } = await db
    .from('instruments')
    .select('instrument_id, sector')
    .in('instrument_id', tickerIds)
    .limit(2000)
  const sectorMap = new Map<string, string | null>()
  for (const i of (instrs ?? []) as any[]) {
    sectorMap.set(i.instrument_id, (i.sector ?? '').trim() || null)
  }

  // Walk unheld tickers, classify above / below threshold
  const aboveThreshold: WatchlistPulseRow[] = []
  let belowThresholdCount = 0
  for (const w of unheldTickers) {
    const latest = latestByInstr.get(w.ticker)
    if (!latest) continue   // no price data — neither above nor below; just skip
    const absChange = Math.abs(latest.day_change)
    if (absChange < thresholdPct) {
      if (absChange > 0) belowThresholdCount++
      continue
    }
    aboveThreshold.push({
      ticker:         w.ticker,
      name:           w.name,
      section:        w.section,
      sector:         sectorMap.get(w.ticker) ?? null,
      day_change_pct: latest.day_change,
      latest_price:   latest.price,
      price_date:     latest.price_date,
    })
  }

  aboveThreshold.sort((a, b) => Math.abs(b.day_change_pct) - Math.abs(a.day_change_pct))

  return {
    rows:                  aboveThreshold.slice(0, maxRows),
    threshold_pct:         thresholdPct,
    as_of_date:            maxPriceDate,
    watchlist_size:        watchlistSize,
    unheld_count:          unheldCount,
    below_threshold_count: belowThresholdCount,
  }
}
