// ─── Period-aware Portfolio Analytics ────────────────────────────────────────
//
// KEY PRINCIPLE on IRR:
// Newton-Raphson IRR with time measured in YEARS produces an ANNUAL rate
// by definition — always. A 3-year IRR of 25% means 25% p.a. compounded.
// A 3-month IRR of 40% means 40% p.a. (the annual rate that explains the
// observed 3-month return). NO further annualisation is ever applied to IRR.
//
// What we DO show separately:
//   - simpleReturn: actual period ₦ gain ÷ startNAV (raw, not annualised)
//   - irr: annual rate from Newton-Raphson (always p.a.)
// ─────────────────────────────────────────────────────────────────────────────

export interface CashFlow {
  date: Date
  amount: number  // negative = outflow (money deployed), positive = inflow (money returned)
}

export type PeriodKey = '1W' | '1M' | '3M' | '6M' | '1Y' | '2Y' | '3Y' | '5Y' | 'ITD'

export interface PeriodDef {
  key: PeriodKey
  label: string
  days: number | null  // null = ITD
}

export const PERIODS: PeriodDef[] = [
  { key: '1W',  label: '1 Week',    days: 7    },
  { key: '1M',  label: '1 Month',   days: 30   },
  { key: '3M',  label: '3 Months',  days: 91   },
  { key: '6M',  label: '6 Months',  days: 182  },
  { key: '1Y',  label: '1 Year',    days: 365  },
  { key: '2Y',  label: '2 Years',   days: 730  },
  { key: '3Y',  label: '3 Years',   days: 1095 },
  { key: '5Y',  label: '5 Years',   days: 1825 },
  { key: 'ITD', label: 'Inception', days: null },
]

export interface PeriodMetrics {
  period:      PeriodKey
  periodLabel: string
  startDate:   string
  endDate:     string
  startNAV:    number | null
  endNAV:      number
  daysHeld:    number
  yearsHeld:   number

  // IRR — ALWAYS an annual rate (Newton-Raphson with time in years).
  // For a 3-month period this is still p.a.; for a 5-year period it is still p.a.
  // Never annualise or de-annualise this value.
  irr:         number | null

  // Simple period return = (endNAV − startNAV + outflows − inflows) / startNAV
  // This is the raw un-annualised return for the period as a decimal.
  // e.g. +0.15 = 15% actual gain over the period (could be 3 months or 3 years)
  simplePeriodReturn: number | null

  // Absolute ₦ P&L adjusted for external cash flows
  absoluteReturn: number | null

  // TWR (approx from NAV log sub-periods) — also expressed as actual period return
  twr:              number | null
  twrAnnualised:    number | null   // only computed when daysHeld > 365 for display

  // Cash flow detail
  inflows:       number   // new money added during period
  outflows:      number   // withdrawals + fees during period
  netCashFlows:  number   // inflows − outflows

  // Benchmark returns (period return as decimal + annual rate)
  benchmarks: BenchmarkResult[]
}

export interface BenchmarkResult {
  name:            string
  shortName:       string
  type:            'equity' | 'fixedIncome' | 'inflation'
  periodReturn:    number   // actual period return as decimal (un-annualised)
  annualRate:      number   // annual equivalent rate
  source:          string
  note?:           string
}

// ─── Newton-Raphson IRR solver ────────────────────────────────────────────────
// Time is measured in YEARS so the returned rate IS already annual.
export function solveIRR(cashFlows: CashFlow[], maxIter = 2000, tol = 1e-7): number | null {
  if (cashFlows.length < 2) return null
  const hasNeg = cashFlows.some(cf => cf.amount < 0)
  const hasPos = cashFlows.some(cf => cf.amount > 0)
  if (!hasNeg || !hasPos) return null

  const t0 = cashFlows[0].date.getTime()
  // TIME IN YEARS — this is what makes the result an annual rate
  const times   = cashFlows.map(cf => (cf.date.getTime() - t0) / (365.25 * 24 * 3600 * 1000))
  const amounts = cashFlows.map(cf => cf.amount)

  for (const seed of [0.1, 0.5, 1.5, 2.5, -0.05, 0.01]) {
    let r = seed
    for (let i = 0; i < maxIter; i++) {
      let npv = 0, dnpv = 0
      for (let j = 0; j < amounts.length; j++) {
        const t = times[j]
        if (t === 0) { npv += amounts[j]; continue }
        const d = Math.pow(1 + r, t)
        npv  += amounts[j] / d
        dnpv -= t * amounts[j] / (d * (1 + r))
      }
      if (Math.abs(npv) < tol) {
        if (!isNaN(r) && r > -0.9999 && r < 500) return r
        break
      }
      if (Math.abs(dnpv) < 1e-14) break
      const nr = r - npv / dnpv
      r = Math.max(-0.9999, Math.min(500, nr))
    }
  }
  return null
}

// ─── Benchmark data (annual returns by calendar year) ────────────────────────
const NGX_ASI_ANNUAL:    Record<number, number> = { 2019:0.115, 2020:0.503, 2021:0.060, 2022:-0.199, 2023:0.459, 2024:0.377, 2025:0.265 }
const NGX_30_ANNUAL:     Record<number, number> = { 2019:0.095, 2020:0.521, 2021:0.048, 2022:-0.142, 2023:0.442, 2024:0.391, 2025:0.248 }
const INFLATION_ANNUAL:  Record<number, number> = { 2019:0.115, 2020:0.133, 2021:0.170, 2022:0.186,  2023:0.245, 2024:0.325, 2025:0.235 }
const NTB_364_ANNUAL:    Record<number, number> = { 2019:0.126, 2020:0.047, 2021:0.052, 2022:0.093,  2023:0.158, 2024:0.212, 2025:0.198 }
const FGN_10Y_ANNUAL:    Record<number, number> = { 2019:0.138, 2020:0.092, 2021:0.118, 2022:0.132,  2023:0.158, 2024:0.185, 2025:0.172 }

function latestRate(data: Record<number, number>, year: number): number {
  const keys = Object.keys(data).map(Number).sort((a,b) => a-b)
  const match = [...keys].reverse().find(y => y <= year)
  return data[match ?? keys[keys.length-1]] ?? 0
}

// Compound period return from annual rates, day by day across year boundaries
function compoundPeriodReturn(data: Record<number, number>, from: Date, to: Date): number {
  if (to <= from) return 0
  let compound = 1.0
  let cursor   = new Date(from)
  while (cursor < to) {
    const year    = cursor.getFullYear()
    const yearEnd = new Date(year + 1, 0, 1)
    const segEnd  = yearEnd < to ? yearEnd : to
    const segYrs  = (segEnd.getTime() - cursor.getTime()) / (365.25 * 24 * 3600 * 1000)
    compound     *= Math.pow(1 + latestRate(data, year), segYrs)
    cursor        = segEnd
  }
  return compound - 1
}

// Annual equivalent of a period return given actual days
function toAnnualRate(periodReturn: number, days: number): number {
  if (days <= 0) return periodReturn
  return Math.pow(1 + periodReturn, 365.25 / days) - 1
}

function buildBenchmarks(from: Date, to: Date, days: number): BenchmarkResult[] {
  const benchDefs = [
    { name: 'NGX All-Share Index', shortName: 'NGX ASI', type: 'equity'      as const, data: NGX_ASI_ANNUAL,   source: 'NGX Group (est.)', note: '2025 partial estimate' },
    { name: 'NGX 30 Index',        shortName: 'NGX 30',  type: 'equity'      as const, data: NGX_30_ANNUAL,    source: 'NGX Group (est.)', note: 'Large-cap 30' },
    { name: 'NTB 364-Day',         shortName: 'NTB 364D',type: 'fixedIncome' as const, data: NTB_364_ANNUAL,   source: 'CBN (avg rate)'  },
    { name: 'FGN Bond 10-Year',    shortName: 'FGN 10yr',type: 'fixedIncome' as const, data: FGN_10Y_ANNUAL,   source: 'FMDQ (avg yield)'},
    { name: 'Nigeria CPI',         shortName: 'Inflation',type:'inflation'   as const, data: INFLATION_ANNUAL, source: 'NBS (avg CPI)'   },
  ]
  return benchDefs.map(b => {
    const periodReturn = compoundPeriodReturn(b.data, from, to)
    return {
      name: b.name, shortName: b.shortName, type: b.type,
      periodReturn,
      annualRate: days >= 365
        ? toAnnualRate(periodReturn, days)   // multi-year: convert compound to annual
        : toAnnualRate(periodReturn, days),  // sub-year: still show annual equivalent for fair comparison
      source: b.source,
      note: b.note,
    }
  })
}

// ─── Find closest NAV at or before a date ────────────────────────────────────
function navAtDate(navHistory: any[], target: Date): number | null {
  const entry = [...navHistory]
    .filter(n => new Date(n.nav_date) <= target)
    .sort((a,b) => new Date(b.nav_date).getTime() - new Date(a.nav_date).getTime())[0]
  return entry?.nav_value ?? null
}

// ─── Main: compute all metrics for a period ───────────────────────────────────
export function computePeriodMetrics(
  periodKey:   PeriodKey,
  portfolio:   any,
  currentNAV:  number,
  navHistory:  any[],
  transactions: any[],
): PeriodMetrics {
  const now   = new Date()
  const today = now.toISOString().slice(0, 10)
  const pdef  = PERIODS.find(p => p.key === periodKey)!

  const startDate: Date = periodKey === 'ITD'
    ? new Date(portfolio.start_date)
    : (() => { const d = new Date(now); d.setDate(d.getDate() - pdef.days!); return d })()

  const daysHeld  = Math.round((now.getTime() - startDate.getTime()) / (24 * 3600 * 1000))
  const yearsHeld = daysHeld / 365.25

  // Start NAV: use NAV log for historical periods, starting_nav for ITD
  const startNAV: number | null = periodKey === 'ITD'
    ? portfolio.starting_nav
    : navAtDate(navHistory, startDate)

  // External cash flows within the period
  const periodTxns = transactions.filter(t => {
    const d = new Date(t.trade_date)
    return d >= startDate && d <= now &&
      ['TRANSFER_IN', 'TRANSFER_OUT', 'FEE'].includes(t.action)
  })

  let inflows = 0, outflows = 0
  periodTxns.forEach(t => {
    const amt = Math.abs(t.amount ?? t.gross_value ?? 0)
    if (t.action === 'TRANSFER_IN')  inflows  += amt
    if (t.action === 'TRANSFER_OUT') outflows += amt
    if (t.action === 'FEE')          outflows += amt
  })

  // Absolute ₦ return: gain after adjusting for external flows
  // = (End NAV − Start NAV) − net new money added
  const absoluteReturn: number | null = startNAV !== null
    ? (currentNAV - startNAV) - (inflows - outflows)
    : null

  // Simple period return (un-annualised fraction)
  const simplePeriodReturn: number | null = startNAV !== null && startNAV > 0 && absoluteReturn !== null
    ? absoluteReturn / startNAV
    : null

  // ── IRR (Money-Weighted Return) ──────────────────────────────────────────
  // Cash flows:
  //   t=0:          −startNAV    (investor deploys capital)
  //   intermediate: ±TRANSFER    (TRANSFER_IN = more capital in = negative; OUT = positive)
  //   t=end:        +currentNAV  (terminal value returned to investor)
  //
  // With time in YEARS → result is ANNUAL RATE. Period length is irrelevant.
  let irr: number | null = null
  if (startNAV !== null) {
    const cashFlows: CashFlow[] = [
      { date: startDate, amount: -startNAV },
      ...periodTxns
        .filter(t => t.action === 'TRANSFER_IN' || t.action === 'TRANSFER_OUT')
        .map(t => ({
          date:   new Date(t.trade_date),
          amount: t.action === 'TRANSFER_IN'
            ? -(Math.abs(t.amount ?? 0))   // more money in = negative (outflow from investor)
            : +(Math.abs(t.amount ?? 0)),  // money back = positive (inflow to investor)
        })),
      { date: now, amount: +currentNAV },
    ]
    irr = solveIRR(cashFlows)
    // IRR is already annual — DO NOT annualise further
  }

  // ── TWR (Time-Weighted Return) ───────────────────────────────────────────
  // Link sub-period returns between NAV log entries
  let twr: number | null = null
  let twrAnnualised: number | null = null
  if (startNAV !== null) {
    const subNAVs = [
      { nav_date: startDate.toISOString().slice(0, 10), nav_value: startNAV },
      ...navHistory
        .filter(n => { const d = new Date(n.nav_date); return d > startDate && d < now })
        .sort((a,b) => new Date(a.nav_date).getTime() - new Date(b.nav_date).getTime()),
      { nav_date: today, nav_value: currentNAV },
    ]
    if (subNAVs.length >= 2) {
      let compound = 1.0
      for (let i = 1; i < subNAVs.length; i++) {
        const prev = subNAVs[i-1].nav_value
        if (prev > 0) compound *= subNAVs[i].nav_value / prev
      }
      twr = compound - 1  // actual period return
      twrAnnualised = daysHeld > 365 ? toAnnualRate(twr, daysHeld) : null
    }
  }

  const benchmarks = buildBenchmarks(startDate, now, daysHeld)

  return {
    period: periodKey, periodLabel: pdef.label,
    startDate: startDate.toISOString().slice(0, 10), endDate: today,
    startNAV, endNAV: currentNAV, daysHeld, yearsHeld,
    irr,                     // ← already annual, always
    simplePeriodReturn,      // ← actual un-annualised period return
    absoluteReturn,
    twr, twrAnnualised,
    inflows, outflows, netCashFlows: inflows - outflows,
    benchmarks,
  }
}

// ─── Backward-compat exports ─────────────────────────────────────────────────
export function calculateIRR(cashFlows: CashFlow[]): number | null { return solveIRR(cashFlows) }
export function buildCashFlows(startingNav: number, startDate: string, transactions: any[], currentNAV: number): CashFlow[] {
  const flows: CashFlow[] = [{ date: new Date(startDate), amount: -startingNav }]
  transactions.filter(t => ['TRANSFER_IN','TRANSFER_OUT'].includes(t.action)).forEach(t => {
    const amt = Math.abs(t.amount || t.gross_value || 0)
    flows.push({ date: new Date(t.trade_date), amount: t.action === 'TRANSFER_IN' ? -amt : +amt })
  })
  flows.push({ date: new Date(), amount: +currentNAV })
  return flows.sort((a,b) => a.date.getTime() - b.date.getTime())
}
export function calcPeriodReturn(currentNAV: number, navHistory: any[], daysBack: number, label: string): any {
  const now = new Date(), target = new Date(now)
  target.setDate(now.getDate() - daysBack)
  const prior = [...navHistory].filter(n => new Date(n.nav_date) <= target).sort((a,b) => new Date(b.nav_date).getTime() - new Date(a.nav_date).getTime())[0]
  if (!prior) return { label, startDate:'', startNAV:null, endNAV:currentNAV, absoluteReturn:null, percentReturn:null, annualisedReturn:null, daysHeld:null }
  const days = Math.round((now.getTime() - new Date(prior.nav_date).getTime()) / 86400000)
  const pct  = (currentNAV - prior.nav_value) / prior.nav_value
  return { label, startDate: prior.nav_date, startNAV: prior.nav_value, endNAV: currentNAV, absoluteReturn: currentNAV - prior.nav_value, percentReturn: pct, annualisedReturn: days >= 365 ? Math.pow(1+pct, 365/days)-1 : pct, daysHeld: days }
}
export const BENCHMARKS = [
  { name:'NGX All-Share Index', shortName:'NGX ASI',  annualised:0.265,  type:'equity',      source:'NGX Group, Mar 2026' },
  { name:'NTB 364-Day',         shortName:'NTB 364D', annualised:0.1847, type:'fixedIncome', source:'CBN, Mar 2026' },
  { name:'FGN Bond 10-Year',    shortName:'FGN 10yr', annualised:0.1606, type:'fixedIncome', source:'FMDQ, Mar 2026' },
  { name:'NTB 91-Day',          shortName:'NTB 91D',  annualised:0.158,  type:'fixedIncome', source:'CBN, Mar 2026' },
  { name:'Nigeria CPI',         shortName:'Inflation',annualised:0.151,  type:'inflation',   source:'NBS, Jan 2026' },
]
export function fmtPct(v: number | null, d = 1): string {
  if (v === null || isNaN(v as number)) return 'N/A'
  return (v >= 0 ? '+' : '') + ((v as number)*100).toFixed(d) + '%'
}
export function fmtPctAbs(v: number | null, d = 1): string {
  if (v === null || isNaN(v as number)) return 'N/A'
  return ((v as number)*100).toFixed(d) + '%'
}
