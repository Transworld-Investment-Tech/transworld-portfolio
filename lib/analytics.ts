// ─── IRR & Performance Analytics ─────────────────────────────────────────────

export interface CashFlow {
  date: Date
  amount: number   // negative = outflow (investment), positive = inflow (return/withdrawal)
}

export interface PeriodReturn {
  label: string
  startDate: string
  startNAV: number | null
  endNAV: number
  absoluteReturn: number | null
  percentReturn: number | null
  annualisedReturn: number | null
  daysHeld: number | null
}

export interface BenchmarkComparison {
  name: string
  shortName: string
  periodReturn: number   // as decimal e.g. 0.2654 for 26.54%
  annualised: number
  type: 'equity' | 'fixedIncome' | 'inflation'
  source: string
}

// Newton-Raphson IRR solver
export function calculateIRR(cashFlows: CashFlow[], maxIterations = 1000, tolerance = 0.0001): number | null {
  if (cashFlows.length < 2) return null

  const t0 = cashFlows[0].date.getTime()
  const times = cashFlows.map(cf => (cf.date.getTime() - t0) / (365.25 * 24 * 60 * 60 * 1000))
  const amounts = cashFlows.map(cf => cf.amount)

  // Check we have both positive and negative flows
  const hasNeg = amounts.some(a => a < 0)
  const hasPos = amounts.some(a => a > 0)
  if (!hasNeg || !hasPos) return null

  let rate = 0.15 // initial guess 15%

  for (let i = 0; i < maxIterations; i++) {
    let npv  = 0
    let dnpv = 0

    for (let j = 0; j < amounts.length; j++) {
      const t = times[j]
      const discounted = amounts[j] / Math.pow(1 + rate, t)
      npv  += discounted
      if (t !== 0) dnpv -= t * amounts[j] / Math.pow(1 + rate, t + 1)
    }

    if (Math.abs(npv) < tolerance) break

    // Avoid division by zero
    if (Math.abs(dnpv) < 1e-10) break

    const newRate = rate - npv / dnpv

    // Clamp to prevent divergence
    if (newRate < -0.9999) rate = -0.9999
    else rate = newRate
  }

  // Sanity check: reject implausible results
  if (rate < -0.9999 || rate > 100 || isNaN(rate)) return null
  return rate
}

// Build cash flows from portfolio data
export function buildCashFlows(
  startingNav: number,
  startDate: string,
  transactions: any[],
  currentNAV: number,
): CashFlow[] {
  const flows: CashFlow[] = []

  // t=0: initial investment is an outflow
  flows.push({
    date: new Date(startDate),
    amount: -startingNav,
  })

  // External cash flows from transactions (TRANSFER_IN = more investment, TRANSFER_OUT = withdrawal)
  transactions
    .filter(t => t.action === 'TRANSFER_IN' || t.action === 'TRANSFER_OUT')
    .forEach(t => {
      const amount = t.amount || t.gross_value || 0
      flows.push({
        date: new Date(t.trade_date),
        amount: t.action === 'TRANSFER_IN' ? -amount : +amount,
      })
    })

  // Terminal value: current NAV is a positive inflow (as if we liquidated today)
  flows.push({
    date: new Date(),
    amount: +currentNAV,
  })

  // Sort by date
  return flows.sort((a, b) => a.date.getTime() - b.date.getTime())
}

// Calculate period return given NAV history
export function calcPeriodReturn(
  currentNAV: number,
  navHistory: any[],
  daysBack: number,
  label: string,
): PeriodReturn {
  const now = new Date()
  const targetDate = new Date(now)
  targetDate.setDate(now.getDate() - daysBack)

  // Find the closest NAV entry on or before the target date
  const sorted = [...navHistory].sort((a, b) =>
    new Date(a.nav_date).getTime() - new Date(b.nav_date).getTime()
  )

  const priorEntry = sorted
    .filter(n => new Date(n.nav_date) <= targetDate)
    .pop()

  if (!priorEntry) {
    return { label, startDate: '', startNAV: null, endNAV: currentNAV, absoluteReturn: null, percentReturn: null, annualisedReturn: null, daysHeld: null }
  }

  const startNAV = priorEntry.nav_value
  const startDate = priorEntry.nav_date
  const daysHeld = Math.round((now.getTime() - new Date(startDate).getTime()) / (1000 * 60 * 60 * 24))
  const absoluteReturn = currentNAV - startNAV
  const percentReturn = (absoluteReturn / startNAV)
  const annualisedReturn = daysHeld > 0 ? Math.pow(1 + percentReturn, 365 / daysHeld) - 1 : null

  return { label, startDate, startNAV, endNAV: currentNAV, absoluteReturn, percentReturn, annualisedReturn, daysHeld }
}

// Static benchmark data — updated periodically
// Sources: NGX Group, CBN, NBS, FMDQ
export const BENCHMARKS: BenchmarkComparison[] = [
  {
    name: 'NGX All-Share Index',
    shortName: 'NGX ASI',
    periodReturn: 0.2654,   // YTD as at Mar 2026
    annualised:   0.2654,
    type: 'equity',
    source: 'NGX Group, Mar 2026',
  },
  {
    name: 'NTB 364-Day',
    shortName: 'NTB 364D',
    periodReturn: 0.1847,
    annualised:   0.1847,
    type: 'fixedIncome',
    source: 'CBN auction, Mar 2026',
  },
  {
    name: 'FGN Bond 10-Year',
    shortName: 'FGN 10yr',
    periodReturn: 0.1606,
    annualised:   0.1606,
    type: 'fixedIncome',
    source: 'FMDQ secondary, Mar 2026',
  },
  {
    name: 'NTB 91-Day',
    shortName: 'NTB 91D',
    periodReturn: 0.158,
    annualised:   0.158,
    type: 'fixedIncome',
    source: 'CBN auction, Mar 2026',
  },
  {
    name: 'Nigeria CPI (Inflation)',
    shortName: 'Inflation',
    periodReturn: 0.151,   // 15.1% headline Jan 2026
    annualised:   0.151,
    type: 'inflation',
    source: 'NBS, Jan 2026',
  },
]

// Format helpers
export function fmtPct(v: number | null, decimals = 1): string {
  if (v === null || isNaN(v)) return 'N/A'
  return `${v >= 0 ? '+' : ''}${(v * 100).toFixed(decimals)}%`
}

export function fmtPctAbs(v: number | null, decimals = 1): string {
  if (v === null || isNaN(v)) return 'N/A'
  return `${(v * 100).toFixed(decimals)}%`
}
