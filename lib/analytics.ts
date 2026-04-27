// ─── Period-aware Portfolio Analytics ────────────────────────────────────────
//
// v27j: Period set overhauled for fee-calculation alignment.
// v27m: endNAV symmetry fix — for closed historical periods (LY), the period's
//       ending value is the NAV as of endDate, not today's currentNAV. Without
//       this fix, LY's cash-flow series ended with today's NAV (e.g., ₦55.30M)
//       instead of NAV at 2025-12-31 (e.g., ₦25.49M), inflating LY IRR by ~50x.
//
// New period set (replaces 1W/1M/3M/6M/1Y/2Y/3Y/5Y as the user-facing tabs):
//   YTD  — Jan 1 of current year → today  (fee tracker for current calendar year)
//   LY   — Jan 1 → Dec 31 of previous calendar year  (last year's fee result)
//   L3Y  — trailing 3 years from today
//   L5Y  — trailing 5 years from today
//   ITD  — inception → today  (always available, fallback for short histories)
//
// Old keys (1W/1M/3M/6M/1Y/2Y/3Y/5Y) are kept in the union for backward
// compatibility with report engines that may pass them programmatically.
// They're not surfaced in the page UI. Old behaviour preserved for those.
//
// KEY PRINCIPLE on IRR (unchanged from v21g):
// Newton-Raphson IRR with time measured in YEARS produces an ANNUAL rate
// by definition — always. NO further annualisation is ever applied.
//
// KEY PRINCIPLE on endNAV (v27m):
// The ending value of a period is the NAV at endDate, NOT necessarily currentNAV.
// For periods ending today (endDate ≈ now), endNAV = currentNAV by definition.
// For closed historical periods (endDate < now, i.e., LY), endNAV is read from
// nav_log via navAtDate(navHistory, endDate). Falls back to currentNAV only if
// no nav_log row exists at-or-before endDate.
// ─────────────────────────────────────────────────────────────────────────────

export interface CashFlow {
  date: Date
  amount: number
}

export type PeriodKey =
  | 'YTD' | 'LY' | 'L3Y' | 'L5Y' | 'ITD'
  | '1W' | '1M' | '3M' | '6M' | '1Y' | '2Y' | '3Y' | '5Y'

export type PeriodKind = 'calendar' | 'trailing' | 'inception'

export interface PeriodDef {
  key:   PeriodKey
  label: string
  days:  number | null
  kind:  PeriodKind
}

export const PERIODS: PeriodDef[] = [
  { key: 'YTD', label: 'YTD',          days: null, kind: 'calendar'  },
  { key: 'LY',  label: 'Last Year',    days: null, kind: 'calendar'  },
  { key: 'L3Y', label: 'Last 3 Years', days: 1095, kind: 'trailing'  },
  { key: 'L5Y', label: 'Last 5 Years', days: 1825, kind: 'trailing'  },
  { key: 'ITD', label: 'Inception',    days: null, kind: 'inception' },
  { key: '1W',  label: '1 Week',    days: 7,    kind: 'trailing' },
  { key: '1M',  label: '1 Month',   days: 30,   kind: 'trailing' },
  { key: '3M',  label: '3 Months',  days: 91,   kind: 'trailing' },
  { key: '6M',  label: '6 Months',  days: 182,  kind: 'trailing' },
  { key: '1Y',  label: '1 Year',    days: 365,  kind: 'trailing' },
  { key: '2Y',  label: '2 Years',   days: 730,  kind: 'trailing' },
  { key: '3Y',  label: '3 Years',   days: 1095, kind: 'trailing' },
  { key: '5Y',  label: '5 Years',   days: 1825, kind: 'trailing' },
]

export interface PeriodWindow {
  startDate:    Date
  endDate:      Date
  available:    boolean
  unavailableReason?: string
  dynamicLabel?: string
}

const ONE_DAY_MS = 24 * 3600 * 1000

function fmtClampSuffix(d: Date): string {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

export function resolvePeriodWindow(
  pdef:        PeriodDef,
  inception:   Date,
  now:         Date = new Date()
): PeriodWindow {
  const todayUTC = new Date(now.getTime())
  todayUTC.setUTCHours(0, 0, 0, 0)

  if (pdef.kind === 'inception') {
    if (inception > now) {
      return {
        startDate: inception, endDate: now,
        available: false,
        unavailableReason: 'Inception is in the future',
      }
    }
    return { startDate: inception, endDate: now, available: true }
  }

  if (pdef.key === 'YTD') {
    const jan1 = new Date(now.getFullYear(), 0, 1)
    if (inception > now) {
      return {
        startDate: inception, endDate: now,
        available: false,
        unavailableReason: 'Inception is in the future',
      }
    }
    if (inception >= jan1) {
      return {
        startDate: inception, endDate: now,
        available: false,
        unavailableReason: `Inception ${fmtClampSuffix(inception)} ${inception.getFullYear()} \u2014 YTD == ITD`,
      }
    }
    return { startDate: jan1, endDate: now, available: true }
  }

  if (pdef.key === 'LY') {
    const lyJan1   = new Date(now.getFullYear() - 1, 0, 1)
    const lyDec31  = new Date(now.getFullYear() - 1, 11, 31, 23, 59, 59, 999)
    if (inception > lyDec31) {
      return {
        startDate: lyJan1, endDate: lyDec31,
        available: false,
        unavailableReason: `Inception ${fmtClampSuffix(inception)} ${inception.getFullYear()} \u2014 no prior calendar year`,
      }
    }
    if (inception > lyJan1) {
      return {
        startDate:    inception,
        endDate:      lyDec31,
        available:    true,
        dynamicLabel: `LY (since ${fmtClampSuffix(inception)})`,
      }
    }
    return { startDate: lyJan1, endDate: lyDec31, available: true }
  }

  if (pdef.kind === 'trailing' && pdef.days !== null) {
    const trailingStart = new Date(now.getTime() - pdef.days * ONE_DAY_MS)
    const isHeadlinePeriod = pdef.key === 'L3Y' || pdef.key === 'L5Y'
    if (inception > trailingStart && isHeadlinePeriod) {
      return {
        startDate: inception, endDate: now,
        available: false,
        unavailableReason: `Inception ${fmtClampSuffix(inception)} ${inception.getFullYear()} \u2014 less than ${pdef.label.toLowerCase()} of history`,
      }
    }
    const start = trailingStart < inception ? inception : trailingStart
    return { startDate: start, endDate: now, available: true }
  }

  return {
    startDate: inception, endDate: now,
    available: false,
    unavailableReason: 'Unknown period kind',
  }
}

export interface PeriodMetrics {
  period:      PeriodKey
  periodLabel: string
  startDate:   string
  endDate:     string
  startNAV:    number | null
  endNAV:      number    // v27m: now correctly reflects period-end NAV, not always currentNAV
  daysHeld:    number
  yearsHeld:   number
  available:   boolean
  unavailableReason?: string
  dynamicLabel?: string
  irr:         number | null
  simplePeriodReturn: number | null
  absoluteReturn:     number | null
  twr:               number | null
  twrAnnualised:     number | null
  inflows:       number
  outflows:      number
  netCashFlows:  number
  benchmarks:    BenchmarkResult[]
}

export interface BenchmarkResult {
  name:         string
  shortName:    string
  type:         'equity' | 'fixedIncome' | 'inflation'
  periodReturn: number
  annualRate:   number
  source:       string
  note?:        string
}

export function solveIRR(cashFlows: CashFlow[], maxIter = 2000, tol = 1e-7): number | null {
  if (cashFlows.length < 2) return null
  const hasNeg = cashFlows.some(cf => cf.amount < 0)
  const hasPos = cashFlows.some(cf => cf.amount > 0)
  if (!hasNeg || !hasPos) return null

  const t0      = cashFlows[0].date.getTime()
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
      annualRate: toAnnualRate(periodReturn, days),
      source: b.source,
      note: b.note,
    }
  })
}

function navAtDate(navHistory: any[], target: Date): number | null {
  const entry = [...navHistory]
    .filter(n => new Date(n.nav_date) <= target)
    .sort((a,b) => new Date(b.nav_date).getTime() - new Date(a.nav_date).getTime())[0]
  return entry?.nav_value ?? null
}

// ─── Main: compute all metrics for a period ────────────────────────────────
// v27m: introduces endNAV symmetric to startNAV.
//   - When endDate is today (within 1 day): endNAV = currentNAV
//   - Otherwise (closed historical period like LY): endNAV = navAtDate(navHistory, endDate),
//     fallback to currentNAV if no nav_log row exists at-or-before endDate.
// Used in: IRR cash flow series final entry, absoluteReturn, TWR final sub-NAV,
// and the returned PeriodMetrics.endNAV field.
export function computePeriodMetrics(
  periodKey:   PeriodKey,
  portfolio:   any,
  currentNAV:  number,
  navHistory:  any[],
  transactions: any[],
): PeriodMetrics {
  const now   = new Date()
  const pdef  = PERIODS.find(p => p.key === periodKey) ?? PERIODS.find(p => p.key === 'ITD')!

  const inception = new Date(portfolio.start_date)
  const window    = resolvePeriodWindow(pdef, inception, now)

  const startDate = window.startDate
  const endDate   = window.endDate

  const daysHeld  = Math.max(0, Math.round((endDate.getTime() - startDate.getTime()) / ONE_DAY_MS))
  const yearsHeld = daysHeld / 365.25

  // v27m: endNAV symmetry. If endDate is at-or-after today, the period ends "now" and
  // currentNAV is correct. If endDate is in the past (LY: 2025-12-31), use the historical
  // NAV at that date from nav_log. Fall back to currentNAV only if nav_log has no row.
  const isEndAtToday = endDate.getTime() >= now.getTime() - ONE_DAY_MS
  const endNAV: number = isEndAtToday
    ? currentNAV
    : (navAtDate(navHistory, endDate) ?? currentNAV)

  if (!window.available) {
    return {
      period: periodKey, periodLabel: pdef.label,
      startDate: startDate.toISOString().slice(0, 10), endDate: endDate.toISOString().slice(0, 10),
      startNAV: null, endNAV, daysHeld, yearsHeld,
      available: false,
      unavailableReason: window.unavailableReason,
      dynamicLabel: window.dynamicLabel,
      irr: null, simplePeriodReturn: null, absoluteReturn: null,
      twr: null, twrAnnualised: null,
      inflows: 0, outflows: 0, netCashFlows: 0,
      benchmarks: [],
    }
  }

  const isStartAtInception =
    Math.abs(startDate.getTime() - inception.getTime()) < ONE_DAY_MS
  const startNAV: number | null = isStartAtInception
    ? portfolio.starting_nav
    : navAtDate(navHistory, startDate)

  const periodTxns = transactions.filter(t => {
    const d = new Date(t.trade_date)
    return d > startDate && d <= endDate &&
      ['TRANSFER_IN', 'TRANSFER_OUT', 'FEE'].includes(t.action)
  })

  let inflows = 0, outflows = 0
  periodTxns.forEach(t => {
    const amt = Math.abs(t.amount ?? t.gross_value ?? 0)
    if (t.action === 'TRANSFER_IN')  inflows  += amt
    if (t.action === 'TRANSFER_OUT') outflows += amt
    if (t.action === 'FEE')          outflows += amt
  })

  // v27m: absoluteReturn uses endNAV (period-end), not currentNAV
  const absoluteReturn: number | null = startNAV !== null
    ? (endNAV - startNAV) - (inflows - outflows)
    : null

  const simplePeriodReturn: number | null = startNAV !== null && startNAV > 0 && absoluteReturn !== null
    ? absoluteReturn / startNAV
    : null

  // ── IRR ─────────────────────────────────────────────────────────────────
  // v27m: cash flow series ends with endNAV (period-end), not currentNAV.
  // For YTD/L3Y/L5Y/ITD where endDate=today, endNAV=currentNAV by definition.
  // For LY where endDate=2025-12-31, endNAV is the historical NAV at that date.
  let irr: number | null = null
  if (startNAV !== null) {
    const cashFlows: CashFlow[] = [
      { date: startDate, amount: -startNAV },
      ...periodTxns
        .filter(t => t.action === 'TRANSFER_IN' || t.action === 'TRANSFER_OUT')
        .map(t => ({
          date:   new Date(t.trade_date),
          amount: t.action === 'TRANSFER_IN'
            ? -(Math.abs(t.amount ?? 0))
            : +(Math.abs(t.amount ?? 0)),
        })),
      { date: endDate, amount: +endNAV },
    ]
    irr = solveIRR(cashFlows)
  }

  // ── TWR ─────────────────────────────────────────────────────────────────
  // v27m: final sub-NAV uses endNAV, not currentNAV.
  let twr: number | null = null
  let twrAnnualised: number | null = null
  if (startNAV !== null) {
    const subNAVs = [
      { nav_date: startDate.toISOString().slice(0, 10), nav_value: startNAV },
      ...navHistory
        .filter(n => { const d = new Date(n.nav_date); return d > startDate && d < endDate })
        .sort((a,b) => new Date(a.nav_date).getTime() - new Date(b.nav_date).getTime()),
      { nav_date: endDate.toISOString().slice(0, 10), nav_value: endNAV },
    ]
    if (subNAVs.length >= 2) {
      let compound = 1.0
      for (let i = 1; i < subNAVs.length; i++) {
        const prev = subNAVs[i-1].nav_value
        if (prev > 0) compound *= subNAVs[i].nav_value / prev
      }
      twr = compound - 1
      twrAnnualised = daysHeld > 365 ? toAnnualRate(twr, daysHeld) : null
    }
  }

  const benchmarks = buildBenchmarks(startDate, endDate, daysHeld)

  return {
    period: periodKey, periodLabel: pdef.label,
    startDate: startDate.toISOString().slice(0, 10), endDate: endDate.toISOString().slice(0, 10),
    startNAV, endNAV, daysHeld, yearsHeld,
    available: true,
    dynamicLabel: window.dynamicLabel,
    irr,
    simplePeriodReturn,
    absoluteReturn,
    twr, twrAnnualised,
    inflows, outflows, netCashFlows: inflows - outflows,
    benchmarks,
  }
}

// ─── Backward-compat exports ───────────────────────────────────────────────
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
