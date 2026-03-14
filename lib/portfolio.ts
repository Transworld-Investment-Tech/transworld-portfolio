// ============================================================
// PORTFOLIO CALCULATION ENGINE
// ============================================================

export interface Instrument {
  instrument_id: string
  name: string
  sleeve_id: string
  asset_class: string
  type: string
  coupon_pct: number
  ngx_symbol?: string
  latest_price?: number
  day_change?: number
}

export interface Holding {
  instrument_id: string
  quantity: number
  avg_cost: number
  sleeve_id: string
  instrument?: Instrument
  latest_price?: number
  day_change?: number
}

export interface SleeveTarget {
  sleeve_id: string
  name: string
  target_pct: number
  min_pct: number
  max_pct: number
}

export interface Portfolio {
  id: string
  label: string
  name: string
  currency: string
  starting_nav: number
  start_date: string
  income_target: number
  cap_target: number
  liq_min: number
  dd_alert: number
  dd_action: number
  max_eq_single: number
  max_eq_sleeve: number
  client?: { name: string; code: string }
}

// ---- Compute NAV ----
export function computeNAV(holdings: Holding[]): number {
  return holdings.reduce((sum, h) => {
    const price = h.latest_price ?? h.avg_cost
    return sum + h.quantity * price
  }, 0)
}

// ---- Sleeve roll-up ----
export function computeSleeveData(
  holdings: Holding[],
  sleeveDefs: SleeveTarget[],
  totalNAV: number
) {
  return sleeveDefs.map(sl => {
    const items = holdings.filter(h => h.sleeve_id === sl.sleeve_id)
    const val = items.reduce((s, h) => {
      const price = h.latest_price ?? h.avg_cost
      return s + h.quantity * price
    }, 0)
    const act = totalNAV > 0 ? val / totalNAV : 0
    const status: 'OK' | 'BREACH' | 'OVER' =
      act < sl.min_pct ? 'BREACH' : act > sl.max_pct ? 'OVER' : 'OK'
    return {
      ...sl,
      val,
      act,
      status,
      diff: val - totalNAV * sl.target_pct,
      items,
    }
  })
}

// ---- Unrealized P&L per holding ----
export function holdingPnL(h: Holding): number {
  const price = h.latest_price ?? h.avg_cost
  return h.quantity * (price - h.avg_cost)
}

// ---- Total unrealized P&L ----
export function totalUnrealizedPnL(holdings: Holding[]): number {
  return holdings.reduce((s, h) => s + holdingPnL(h), 0)
}

// ---- Estimated annualised income from fixed income ----
export function estimatedIncomePA(holdings: Holding[]): number {
  return holdings.reduce((s, h) => {
    const price = h.latest_price ?? h.avg_cost
    if (h.instrument?.type !== 'Stock' && (h.instrument?.coupon_pct ?? 0) > 0) {
      return s + h.quantity * price * (h.instrument!.coupon_pct / 100)
    }
    return s
  }, 0)
}

// ---- Rebalancing suggestions ----
export function rebalancingSuggestions(
  sleeveData: ReturnType<typeof computeSleeveData>
) {
  return sleeveData.map(s => {
    const diff = s.diff
    const action = diff > 50000 ? 'BUY' : diff < -50000 ? 'SELL' : 'HOLD'
    return { ...s, action }
  })
}

// ---- Format helpers ----
export const fmt = {
  ngn: (v: number, dp = 0) =>
    '₦' + new Intl.NumberFormat('en-NG', { minimumFractionDigits: dp, maximumFractionDigits: dp }).format(v),
  ngnM: (v: number) =>
    '₦' + (v / 1e6).toFixed(2) + 'M',
  ngnB: (v: number) =>
    Math.abs(v) >= 1e9
      ? '₦' + (v / 1e9).toFixed(2) + 'B'
      : '₦' + (v / 1e6).toFixed(2) + 'M',
  pct: (v: number) => (v * 100).toFixed(1) + '%',
  chg: (v: number) => (v >= 0 ? '+' : '') + v.toFixed(2) + '%',
  date: (d: string) => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }),
}

// ---- Sleeve colour map ----
export const SLEEVE_COLOURS: Record<string, { hex: string; bg: string; text: string }> = {
  liq: { hex: '#2dd4bf', bg: 'rgba(45,212,191,0.12)', text: '#2dd4bf' },
  ntb: { hex: '#a78bfa', bg: 'rgba(167,139,250,0.12)', text: '#a78bfa' },
  fgn: { hex: '#fb923c', bg: 'rgba(251,146,60,0.12)',  text: '#fb923c' },
  eq:  { hex: '#60a5fa', bg: 'rgba(96,165,250,0.12)',  text: '#60a5fa' },
}

// ---- Compliance check ----
export function complianceAlerts(
  portfolio: Portfolio,
  holdings: Holding[],
  sleeveData: ReturnType<typeof computeSleeveData>,
  totalNAV: number
): { level: 'critical' | 'warn' | 'info'; message: string }[] {
  const alerts: { level: 'critical' | 'warn' | 'info'; message: string }[] = []

  sleeveData.forEach(s => {
    if (s.status === 'BREACH') {
      alerts.push({ level: 'critical', message: `${s.name}: ${fmt.pct(s.act)} is BELOW minimum ${fmt.pct(s.min_pct)}. Rebalance required immediately.` })
    } else if (s.status === 'OVER') {
      alerts.push({ level: 'warn', message: `${s.name}: ${fmt.pct(s.act)} exceeds maximum ${fmt.pct(s.max_pct)}.` })
    }
  })

  holdings
    .filter(h => h.instrument?.type === 'Stock')
    .forEach(h => {
      const price = h.latest_price ?? h.avg_cost
      const w = (h.quantity * price) / totalNAV
      if (w > portfolio.max_eq_single) {
        alerts.push({ level: 'warn', message: `${h.instrument?.name}: ${fmt.pct(w)} of NAV exceeds ${fmt.pct(portfolio.max_eq_single)} single-name limit.` })
      }
    })

  return alerts
}
