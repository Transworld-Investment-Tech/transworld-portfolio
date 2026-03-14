// ─── Period-aware Portfolio Analytics ────────────────────────────────────────

export interface CashFlow {
  date: Date
  amount: number  // negative = outflow (investment in), positive = inflow (withdrawal/terminal)
}

export type PeriodKey = '1W' | '1M' | '3M' | '6M' | '1Y' | '2Y' | '3Y' | '5Y' | 'ITD'

export interface PeriodDef {
  key: PeriodKey
  label: string
  days: number | null  // null = ITD
}

export const PERIODS: PeriodDef[] = [
  { key: '1W',  label: '1 Week',    days: 7   },
  { key: '1M',  label: '1 Month',   days: 30  },
  { key: '3M',  label: '3 Months',  days: 91  },
  { key: '6M',  label: '6 Months',  days: 182 },
  { key: '1Y',  label: '1 Year',    days: 365 },
  { key: '2Y',  label: '2 Years',   days: 730 },
  { key: '3Y',  label: '3 Years',   days: 1095},
  { key: '5Y',  label: '5 Years',   days: 1825},
  { key: 'ITD', label: 'Inception', days: null},
]

export interface PeriodMetrics {
  period: PeriodKey
  periodLabel: string
  startDate: string
  endDate: string
  startNAV: number | null
  endNAV: number
  daysHeld: number

  // Returns
  absoluteReturn: number | null      // ₦ gain/loss
  simpleReturn: number | null        // (endNAV - startNAV + outflows - inflows) / startNAV
  mwr: number | null                 // Money-weighted return (IRR)
  twr: number | null                 // Time-weighted return (approx from NAV log)
  annualisedMwr: number | null       // IRR annualised
  annualisedTwr: number | null       // TWR annualised

  // Cash flow detail
  netCashFlows: number               // net external cash in/out during period
  inflows: number
  outflows: number

  // Benchmark returns for same period (annualised)
  benchmarks: BenchmarkResult[]
}

export interface BenchmarkResult {
  name: string
  shortName: string
  type: 'equity' | 'fixedIncome' | 'inflation'
  periodReturn: number        // actual period return (not annualised)
  annualisedReturn: number
  source: string
  note?: string
}

// ─── Newton-Raphson IRR solver ────────────────────────────────────────────────
export function solveIRR(cashFlows: CashFlow[], maxIter = 1000, tol = 0.000001): number | null {
  if (cashFlows.length < 2) return null
  const hasNeg = cashFlows.some(cf => cf.amount < 0)
  const hasPos = cashFlows.some(cf => cf.amount > 0)
  if (!hasNeg || !hasPos) return null

  const t0 = cashFlows[0].date.getTime()
  const times = cashFlows.map(cf => (cf.date.getTime() - t0) / (365.25 * 24 * 3600 * 1000))
  const amounts = cashFlows.map(cf => cf.amount)

  // Try multiple starting points to avoid local minima
  for (const guess of [0.1, 0.5, 1.0, 2.0, -0.1, 0.01]) {
    let r = guess
    for (let i = 0; i < maxIter; i++) {
      let npv = 0, dnpv = 0
      for (let j = 0; j < amounts.length; j++) {
        const t = times[j]
        const disc = Math.pow(1 + r, t)
        npv  += amounts[j] / disc
        if (t !== 0) dnpv -= t * amounts[j] / Math.pow(1 + r, t + 1)
      }
      if (Math.abs(npv) < tol) {
        if (r > -0.9999 && r < 100 && !isNaN(r)) return r
        break
      }
      if (Math.abs(dnpv) < 1e-12) break
      const nr = r - npv / dnpv
      if (nr < -0.9999) { r = -0.5; continue }
      if (nr > 100)     { r = 50;   continue }
      r = nr
    }
  }
  return null
}

// ─── Annualise a period return ────────────────────────────────────────────────
function annualise(r: number, days: number): number {
  if (days <= 0) return r
  if (days < 365) return r  // don't annualise short periods — show actual
  return Math.pow(1 + r, 365 / days) - 1
}

// ─── Find closest NAV entry on or before a date ──────────────────────────────
function navAtDate(navHistory: any[], targetDate: Date): { nav: number; date: string } | null {
  const sorted = [...navHistory]
    .filter(n => new Date(n.nav_date) <= targetDate)
    .sort((a, b) => new Date(b.nav_date).getTime() - new Date(a.nav_date).getTime())
  if (!sorted.length) return null
  return { nav: sorted[0].nav_value, date: sorted[0].nav_date }
}

// ─── Benchmark data (known annual returns by calendar year) ──────────────────
// Sources: NGX Group, CBN, NBS, FMDQ
// NGX ASI annual total returns
const NGX_ASI_ANNUAL: Record<number, number> = {
  2019: 0.115,   // +11.5%
  2020: 0.503,   // +50.3%
  2021: 0.060,   // +6.0%
  2022: -0.199,  // -19.9%
  2023: 0.459,   // +45.9%
  2024: 0.377,   // +37.7%
  2025: 0.265,   // ~+26.5% estimate
}

// NGX 30 (large cap) annual returns — broadly similar to ASI but different
const NGX_30_ANNUAL: Record<number, number> = {
  2019: 0.095,
  2020: 0.521,
  2021: 0.048,
  2022: -0.142,
  2023: 0.442,
  2024: 0.391,
  2025: 0.248,
}

// CBN inflation (headline CPI year-on-year average) by year
const INFLATION_ANNUAL: Record<number, number> = {
  2019: 0.115,
  2020: 0.133,
  2021: 0.170,
  2022: 0.186,
  2023: 0.245,
  2024: 0.325,
  2025: 0.235,  // declining from 34.8% peak to ~15% by end
}

// NTB 364-day rate by year (average)
const NTB_364_ANNUAL: Record<number, number> = {
  2019: 0.126,
  2020: 0.047,
  2021: 0.052,
  2022: 0.093,
  2023: 0.158,
  2024: 0.212,
  2025: 0.198,
}

// FGN Bond 10-year yield by year (average)
const FGN_10Y_ANNUAL: Record<number, number> = {
  2019: 0.138,
  2020: 0.092,
  2021: 0.118,
  2022: 0.132,
  2023: 0.158,
  2024: 0.185,
  2025: 0.172,
}

function interpolateBenchmark(
  data: Record<number, number>,
  fromDate: Date,
  toDate: Date
): number {
  const totalMs = toDate.getTime() - fromDate.getTime()
  if (totalMs <= 0) return 0

  let compound = 1.0
  let cursor = new Date(fromDate)

  while (cursor < toDate) {
    const year = cursor.getFullYear()
    const yearEnd = new Date(year + 1, 0, 1)
    const segEnd = yearEnd < toDate ? yearEnd : toDate
    const segMs = segEnd.getTime() - cursor.getTime()
    const yearFrac = segMs / (365.25 * 24 * 3600 * 1000)
    const annualRate = data[year] ?? data[Math.max(...Object.keys(data).map(Number).filter(y => y <= year))] ?? 0
    compound *= Math.pow(1 + annualRate, yearFrac)
    cursor = segEnd
  }

  return compound - 1
}

// ─── Build benchmarks for a period ───────────────────────────────────────────
function buildBenchmarks(fromDate: Date, toDate: Date, days: number): BenchmarkResult[] {
  const ngxAsi   = interpolateBenchmark(NGX_ASI_ANNUAL,   fromDate, toDate)
  const ngx30    = interpolateBenchmark(NGX_30_ANNUAL,    fromDate, toDate)
  const ntb364   = interpolateBenchmark(NTB_364_ANNUAL,   fromDate, toDate)
  const fgn10    = interpolateBenchmark(FGN_10Y_ANNUAL,   fromDate, toDate)
  const infl     = interpolateBenchmark(INFLATION_ANNUAL, fromDate, toDate)
  const isShort  = days < 365

  return [
    {
      name: 'NGX All-Share Index',
      shortName: 'NGX ASI',
      type: 'equity',
      periodReturn: ngxAsi,
      annualisedReturn: isShort ? ngxAsi : annualise(ngxAsi, days),
      source: 'NGX Group (estimated)',
      note: 'Total return index; 2025 estimate',
    },
    {
      name: 'NGX 30 Index',
      shortName: 'NGX 30',
      type: 'equity',
      periodReturn: ngx30,
      annualisedReturn: isShort ? ngx30 : annualise(ngx30, days),
      source: 'NGX Group (estimated)',
      note: 'Large-cap 30; 2025 estimate',
    },
    {
      name: 'NTB 364-Day',
      shortName: 'NTB 364D',
      type: 'fixedIncome',
      periodReturn: ntb364,
      annualisedReturn: isShort ? ntb364 : annualise(ntb364, days),
      source: 'CBN (period average)',
    },
    {
      name: 'FGN Bond 10-Year',
      shortName: 'FGN 10yr',
      type: 'fixedIncome',
      periodReturn: fgn10,
      annualisedReturn: isShort ? fgn10 : annualise(fgn10, days),
      source: 'FMDQ (period average)',
    },
    {
      name: 'Nigeria CPI (Inflation)',
      shortName: 'Inflation',
      type: 'inflation',
      periodReturn: infl,
      annualisedReturn: isShort ? infl : annualise(infl, days),
      source: 'NBS (period average)',
    },
  ]
}

// ─── Main: compute period metrics ────────────────────────────────────────────
export function computePeriodMetrics(
  periodKey: PeriodKey,
  portfolio: any,
  currentNAV: number,
  navHistory: any[],
  transactions: any[],
): PeriodMetrics {
  const now   = new Date()
  const today = now.toISOString().slice(0, 10)
  const pdef  = PERIODS.find(p => p.key === periodKey)!

  // Determine start date
  let startDate: Date
  if (periodKey === 'ITD') {
    startDate = new Date(portfolio.start_date)
  } else {
    startDate = new Date(now)
    startDate.setDate(startDate.getDate() - pdef.days!)
  }

  const daysHeld = Math.round((now.getTime() - startDate.getTime()) / (24 * 3600 * 1000))

  // Find start NAV
  const startEntry = navAtDate(navHistory, startDate)
  const startNAV   = startEntry?.nav ?? (periodKey === 'ITD' ? portfolio.starting_nav : null)

  // External cash flows during period
  const periodTxns = transactions.filter(t => {
    const d = new Date(t.trade_date)
    return d >= startDate && d <= now &&
      (t.action === 'TRANSFER_IN' || t.action === 'TRANSFER_OUT' || t.action === 'FEE')
  })

  let inflows  = 0
  let outflows = 0
  periodTxns.forEach(t => {
    const amt = t.amount ?? t.gross_value ?? 0
    if (t.action === 'TRANSFER_IN')  inflows  += amt
    if (t.action === 'TRANSFER_OUT') outflows += amt
    if (t.action === 'FEE')          outflows += amt  // fees are cash leaving
  })
  const netCashFlows = inflows - outflows

  // Absolute return (adjusted for cash flows)
  const absoluteReturn = startNAV !== null
    ? currentNAV - startNAV - inflows + outflows
    : null

  // Simple return
  const simpleReturn = startNAV !== null && startNAV > 0
    ? absoluteReturn! / startNAV
    : null

  // MWR (IRR) using cash flows
  let mwr: number | null = null
  let annualisedMwr: number | null = null

  if (startNAV !== null) {
    const cashFlows: CashFlow[] = [
      { date: startDate,  amount: -startNAV },  // initial investment = outflow
      ...periodTxns
        .filter(t => t.action === 'TRANSFER_IN' || t.action === 'TRANSFER_OUT')
        .map(t => ({
          date:   new Date(t.trade_date),
          amount: t.action === 'TRANSFER_IN'
            ? -(t.amount ?? 0)    // new money in = outflow (investor perspective)
            : +(t.amount ?? 0),   // money out = inflow (investor gets it back)
        })),
      { date: now, amount: +currentNAV },  // terminal value = inflow
    ]
    mwr = solveIRR(cashFlows)
    annualisedMwr = mwr !== null && daysHeld >= 365
      ? annualise(mwr, daysHeld)
      : mwr
  }

  // TWR from NAV history (approximate)
  // Link sub-period returns between nav log entries within the period
  let twr: number | null = null
  let annualisedTwr: number | null = null

  if (startNAV !== null) {
    const navInPeriod = [
      { nav_date: startDate.toISOString().slice(0, 10), nav_value: startNAV },
      ...navHistory.filter(n => {
        const d = new Date(n.nav_date)
        return d > startDate && d <= now
      }).sort((a, b) => new Date(a.nav_date).getTime() - new Date(b.nav_date).getTime()),
      { nav_date: today, nav_value: currentNAV },
    ]

    if (navInPeriod.length >= 2) {
      let twrCompound = 1.0
      for (let i = 1; i < navInPeriod.length; i++) {
        const prev = navInPeriod[i - 1].nav_value
        const curr = navInPeriod[i].nav_value
        if (prev > 0) twrCompound *= (curr / prev)
      }
      twr = twrCompound - 1
      annualisedTwr = daysHeld >= 365 ? annualise(twr, daysHeld) : twr
    }
  }

  const benchmarks = buildBenchmarks(startDate, now, daysHeld)

  return {
    period: periodKey,
    periodLabel: pdef.label,
    startDate: startDate.toISOString().slice(0, 10),
    endDate: today,
    startNAV,
    endNAV: currentNAV,
    daysHeld,
    absoluteReturn,
    simpleReturn,
    mwr,
    twr,
    annualisedMwr,
    annualisedTwr,
    netCashFlows,
    inflows,
    outflows,
    benchmarks,
  }
}

// Old exports kept for backward compatibility
export function calculateIRR(cashFlows: CashFlow[]): number | null { return solveIRR(cashFlows) }
export function buildCashFlows(startingNav: number, startDate: string, transactions: any[], currentNAV: number): CashFlow[] {
  const flows: CashFlow[] = [{ date: new Date(startDate), amount: -startingNav }]
  transactions.filter(t => t.action === 'TRANSFER_IN' || t.action === 'TRANSFER_OUT').forEach(t => {
    const amount = t.amount || t.gross_value || 0
    flows.push({ date: new Date(t.trade_date), amount: t.action === 'TRANSFER_IN' ? -amount : +amount })
  })
  flows.push({ date: new Date(), amount: +currentNAV })
  return flows.sort((a, b) => a.date.getTime() - b.date.getTime())
}
export function calcPeriodReturn(currentNAV: number, navHistory: any[], daysBack: number, label: string): any {
  const now = new Date(), target = new Date(now)
  target.setDate(now.getDate() - daysBack)
  const sorted = [...navHistory].sort((a, b) => new Date(a.nav_date).getTime() - new Date(b.nav_date).getTime())
  const prior = sorted.filter(n => new Date(n.nav_date) <= target).pop()
  if (!prior) return { label, startDate: '', startNAV: null, endNAV: currentNAV, absoluteReturn: null, percentReturn: null, annualisedReturn: null, daysHeld: null }
  const days = Math.round((now.getTime() - new Date(prior.nav_date).getTime()) / 86400000)
  const pct  = (currentNAV - prior.nav_value) / prior.nav_value
  return { label, startDate: prior.nav_date, startNAV: prior.nav_value, endNAV: currentNAV, absoluteReturn: currentNAV - prior.nav_value, percentReturn: pct, annualisedReturn: days >= 365 ? Math.pow(1 + pct, 365 / days) - 1 : pct, daysHeld: days }
}
export const BENCHMARKS = [
  { name: 'NGX All-Share Index', shortName: 'NGX ASI', annualised: 0.265, type: 'equity', source: 'NGX Group, Mar 2026' },
  { name: 'NTB 364-Day',         shortName: 'NTB 364D',annualised: 0.1847,type: 'fixedIncome', source: 'CBN, Mar 2026' },
  { name: 'FGN Bond 10-Year',    shortName: 'FGN 10yr', annualised: 0.1606,type: 'fixedIncome', source: 'FMDQ, Mar 2026' },
  { name: 'NTB 91-Day',          shortName: 'NTB 91D',  annualised: 0.158, type: 'fixedIncome', source: 'CBN, Mar 2026' },
  { name: 'Nigeria CPI',         shortName: 'Inflation',annualised: 0.151, type: 'inflation',   source: 'NBS, Jan 2026' },
]
export function fmtPct(v: number | null, d = 1): string {
  if (v === null || isNaN(v as number)) return 'N/A'
  return (v >= 0 ? '+' : '') + ((v as number) * 100).toFixed(d) + '%'
}
export function fmtPctAbs(v: number | null, d = 1): string {
  if (v === null || isNaN(v as number)) return 'N/A'
  return ((v as number) * 100).toFixed(d) + '%'
}
