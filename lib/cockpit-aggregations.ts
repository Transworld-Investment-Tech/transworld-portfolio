// ═══════════════════════════════════════════════════════════════
// COCKPIT AGGREGATIONS (v27)
// ═══════════════════════════════════════════════════════════════
//
// Pure aggregation helpers for the cockpit. Cross-portfolio reading,
// no business logic. Consumers: /api/cockpit/* routes.
//
// All numeric coercion at every Supabase boundary (pitfall #72).
// All large queries cap at 50000 rows (pitfall #59).
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
    is_internal:   p.client?.type === 'internal',
  }))
}

// ═══════════════════════════════════════════════════════════════
// 2. computePortfolioNAV — current market value
//    Used to compute current totalNAV for each portfolio.
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

  // Latest market price per instrument
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
//    Forward-fills last-known NAV per portfolio across the date axis
//    before summing (handles density-varies-by-portfolio).
// ═══════════════════════════════════════════════════════════════
export async function buildFirmAUMTrend(
  db: SupabaseClient,
  monthsBack: number = 12
): Promise<AUMTrendPoint[]> {
  // Fetch all nav_log entries for active portfolios
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

  // Group by portfolio for forward-fill lookup
  const byPortfolio = new Map<string, { date: Date; value: number }[]>()
  for (const r of navRows as any[]) {
    const v = numOrNull(r.nav_value)
    if (v === null) continue
    const arr = byPortfolio.get(r.portfolio_id) ?? []
    arr.push({ date: new Date(r.nav_date), value: v })
    byPortfolio.set(r.portfolio_id, arr)
  }

  // Build month-end sample dates
  const today = new Date()
  const sampleDates: Date[] = []
  for (let i = monthsBack; i >= 0; i--) {
    const d = new Date(today.getFullYear(), today.getMonth() - i + 1, 0)  // last day of month
    if (d > today) {
      sampleDates.push(today)
    } else {
      sampleDates.push(d)
    }
  }

  // Last-known NAV at or before each sample date, summed
  const trend: AUMTrendPoint[] = []
  for (const sample of sampleDates) {
    let total = 0
    for (const [, navs] of byPortfolio) {
      // Find latest entry with date <= sample
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
//    Sum of NGN by sleeve across all active portfolios.
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
// 5. buildIdleCashFlags — portfolios over liq_max
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

  // Build cash totals per portfolio. Cash holdings are typically valued at avg_cost
  // (or 1 for CASH_NGN) — no market price.
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
    if (liqMax === null) continue   // no max defined
    if (cashPct <= liqMax) continue  // within band

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
// 6. buildStaleReports — portfolios with no recent quarterly report
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

  // Last report per portfolio (any type)
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
// 7. fetchYTDReturns — simple YTD return per portfolio
//    Used by mandate-health benchmark check.
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

  // Bulk fetch all nav_log rows for these portfolios near year start
  const portfolioIds = portfolios.map(p => p.id)
  const { data: navRows } = await db
    .from('nav_log')
    .select('portfolio_id, nav_date, nav_value')
    .in('portfolio_id', portfolioIds)
    .lte('nav_date', yStartIso)
    .order('nav_date', { ascending: false })
    .limit(50000)

  // Latest nav at or before Jan 1 per portfolio
  const navAtYearStartMap = new Map<string, number>()
  for (const r of (navRows ?? []) as any[]) {
    if (!navAtYearStartMap.has(r.portfolio_id)) {
      const v = numOrNull(r.nav_value)
      if (v !== null) navAtYearStartMap.set(r.portfolio_id, v)
    }
  }

  // Year-to-date cashflows
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
    const nav0 = startedThisYear ? p.starting_nav : (navAtYearStartMap.get(p.id) ?? p.starting_nav)
    const navN = navMap.get(p.id) ?? 0

    if (nav0 <= 0) {
      out.set(p.id, null)
      continue
    }

    const flows = flowsByPortfolio.get(p.id) ?? { inflow: 0, outflow: 0 }
    // Simple YTD return = (endNAV - startNAV - inflows + outflows) / startNAV
    const ytdReturn = (navN - nav0 - flows.inflow + flows.outflow) / nav0
    out.set(p.id, ytdReturn)
  }
  return out
}

// ═══════════════════════════════════════════════════════════════
// 8. Recent transactions count per portfolio (last 90 days, non-FEE)
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
  // Null for portfolios with no reports
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

  // NAV at or just before Jan 1
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

  // Yearly cashflows (TRANSFER_IN / TRANSFER_OUT only — FEE excluded per design)
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
