// ============================================================
// PORTFOLIO CALCULATION ENGINE
// ============================================================
// v20g: Two changes vs prior:
//   1. Portfolio and Instrument interfaces refreshed to match the
//      live Supabase schema (pitfall #36). Several (portfolio as any)
//      casts elsewhere in the codebase become superfluous after this;
//      they remain harmless until opportunistically removed.
//   2. Hybrid chart palette (HYBRID_SLEEVE_COLORS, HYBRID_PALETTE,
//      colorForSleeve) is now exported from here rather than
//      duplicated in AllocationDonut.tsx and AUMBarChart.tsx.
//
// Legacy SLEEVE_COLOURS is preserved unchanged because phase-2 pages
// (Holdings, Transactions, Reports, Settings, Admin, Import) still
// use the dark-theme palette. Delete only after every page migrates.
// ============================================================

// ─── Instrument ─────────────────────────────────────────────────
// Mirrors the `instruments` table in Supabase. Dividend fields are
// intentionally omitted from this interface — they're only consumed
// on the dividend refresh path, not in core NAV / sleeve calculations.
export interface Instrument {
  instrument_id: string
  name: string
  type: string                 // 'Stock' | 'Bond' | 'Cash' | 'ETF'
  sleeve_id: string            // 'eq' | 'liq' | 'fi'
  asset_class: string
  currency?: string            // 'NGN' (always, in practice)
  coupon_pct: number
  approved?: boolean
  ngx_symbol?: string
  // Computed / joined at query time:
  latest_price?: number
  day_change?: number
}

// ─── Holding ────────────────────────────────────────────────────
// Mirrors `holdings`. Instrument and price fields are hydrated by
// the loader (Supabase embedded relations + market_prices lookup).
export interface Holding {
  instrument_id: string
  quantity: number
  avg_cost: number
  sleeve_id: string
  instrument?: Instrument
  latest_price?: number
  day_change?: number
}

// ─── SleeveTarget ───────────────────────────────────────────────
// Mirrors `sleeve_targets`.
export interface SleeveTarget {
  sleeve_id: string
  name: string
  target_pct: number
  min_pct: number
  max_pct: number
}

// ─── Portfolio ──────────────────────────────────────────────────
// Mirrors `portfolios` table per 03_schema.md.
// `client?` is the result of Supabase's embedded relation
// select('*, client:clients(name, code, type)'); it's optional
// because some callers don't request the embed.
export interface Portfolio {
  id: string
  client_id?: string
  label: string
  name: string
  currency: string
  starting_nav: number
  start_date: string
  valuation_date?: string
  income_target: number
  cap_target: number
  liq_min: number
  dd_alert: number
  dd_action: number
  max_eq_single: number
  max_eq_sleeve: number
  status?: string              // 'active' | 'archived'
  notes?: string | null
  created_at?: string
  updated_at?: string
  client?: {
    name: string
    code: string
    type?: string              // 'discretionary' | 'advisory' | 'internal'
  }
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

// ═══════════════════════════════════════════════════════════════
// COLOUR PALETTES
// ═══════════════════════════════════════════════════════════════

// ─── Legacy dark-theme palette ─────────────────────────────────
// Still consumed by phase-2 pages (Holdings, Transactions, Reports,
// Settings, Admin, Import, Create Client, Create Portfolio).
// Delete when all pages migrate to hybrid.
export const SLEEVE_COLOURS: Record<string, { hex: string; bg: string; text: string }> = {
  liq: { hex: '#2dd4bf', bg: 'rgba(45,212,191,0.12)', text: '#2dd4bf' },
  ntb: { hex: '#a78bfa', bg: 'rgba(167,139,250,0.12)', text: '#a78bfa' },
  fgn: { hex: '#fb923c', bg: 'rgba(251,146,60,0.12)',  text: '#fb923c' },
  eq:  { hex: '#60a5fa', bg: 'rgba(96,165,250,0.12)',  text: '#60a5fa' },
}

// ─── Hybrid (v20+) palette ─────────────────────────────────────
// Single source of truth for all v20+ chart components. Mirrors
// the CSS custom properties in globals.css.
//
// HYBRID_SLEEVE_COLORS maps a sleeve_id to its brand colour.
// HYBRID_PALETTE is an ordered list used for positional assignment
// when rendering charts that aren't sleeve-specific (e.g. AUM bar
// chart per portfolio).
export const HYBRID_SLEEVE_COLORS: Record<string, string> = {
  liq: '#0a1f3a', // navy        (--sidebar-bg)
  eq:  '#b08b3e', // muted gold  (--gold)
  fi:  '#2d6e4e', // muted green (--pos)
}

export const HYBRID_PALETTE: string[] = [
  '#b08b3e', // gold      (--gold, primary brand)
  '#0a1f3a', // navy      (--sidebar-bg)
  '#2d6e4e', // green     (--pos)
  '#c9a556', // gold-bright  (--gold-bright)
  '#a67c2a', // warn gold    (--warn)
  '#5c6573', // slate        (--text-2)
]

// Resolve a sleeve colour with a positional fallback for unmapped IDs.
export function colorForSleeve(id: string, idx: number = 0): string {
  return HYBRID_SLEEVE_COLORS[id] ?? HYBRID_PALETTE[idx % HYBRID_PALETTE.length]
}

// ═══════════════════════════════════════════════════════════════
// COMPLIANCE
// ═══════════════════════════════════════════════════════════════
// Note argument order — this has been a bug magnet (pitfall #37):
//   (portfolio, holdings, sleeveData, totalNAV)
//    NOT       (portfolio, sleeveData, holdings, ...)
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
      const w = totalNAV > 0 ? (h.quantity * price) / totalNAV : 0
      if (w > portfolio.max_eq_single) {
        alerts.push({ level: 'warn', message: `${h.instrument?.name}: ${fmt.pct(w)} of NAV exceeds ${fmt.pct(portfolio.max_eq_single)} single-name limit.` })
      }
    })

  return alerts
}
