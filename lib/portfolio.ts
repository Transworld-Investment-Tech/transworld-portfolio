// ============================================================
// PORTFOLIO CALCULATION ENGINE
// ============================================================
// v20g: Portfolio + Instrument interfaces refreshed against live
// Supabase schema; hybrid chart palette centralised here.
// v20h: Instrument gains `sector` and `ngx_market` optional fields to
// match the schema migration that adds those columns on `instruments`.
// Populated by /api/prices on every refresh (derived from NGX's
// Sector / Market fields).
// ============================================================

// ─── Instrument ─────────────────────────────────────────────────
// Mirrors the `instruments` table in Supabase. Dividend fields are
// intentionally omitted — they're consumed only on the dividend refresh
// path, not in core NAV / sleeve calculations.
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
  // v20h additions — per-security classification from NGX
  sector?: string | null
  ngx_market?: string | null
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
  // v21b-1: portfolio-level CSCS identifier. Display-only — not
  // used for auto-matching (a client can have multiple portfolios,
  // each with its own CSCS account).
  cscs_number?: string | null
  created_at?: string
  updated_at?: string
  client?: {
    name: string
    code: string
    type?: string              // 'discretionary' | 'advisory' | 'internal'
  }
}

// ─── Transaction ────────────────────────────────────────────────
// Mirrors the `transactions` table per 03_schema.md. Most fields
// are optional because different action types populate different
// subsets:
//   BUY / SELL:    trade-fee columns, cn_number, settlement_date
//   TRANSFER_IN:   amount, external_ref, notes
//   TRANSFER_OUT:  amount, external_ref, notes (also used for
//                  refunds — narration in `notes` preserves context)
//   FEE:           amount + exactly one of fee_management,
//                  fee_demat, fee_other, plus notes
//   INCOME:        amount, instrument_id (dividends), notes
// v21b-1 adds: cn_number, settlement_date, fee_sec, fee_management,
// fee_demat, fee_other, external_ref, source_file_id.
export interface Transaction {
  id: string
  portfolio_id: string
  trade_date: string
  action: 'BUY' | 'SELL' | 'INCOME' | 'FEE' | 'TRANSFER_IN' | 'TRANSFER_OUT'
  instrument_id?: string | null
  quantity?: number | null
  price?: number | null
  gross_value?: number | null
  amount?: number | null

  // Trade fees (from contract notes — populated on BUY / SELL)
  fees?: number | null
  fee_commission?: number | null
  fee_vat?: number | null
  fee_exchange?: number | null
  fee_clearing?: number | null
  fee_sec?: number | null
  fee_contract_stamp?: number | null
  fee_sms?: number | null

  // Non-trade fee breakdown (populated on FEE — exactly one)
  fee_management?: number | null
  fee_demat?: number | null
  fee_other?: number | null

  // Broker metadata
  cn_number?: string | null
  settlement_date?: string | null
  external_ref?: string | null
  broker?: string | null
  notes?: string | null

  // Traceability — which uploaded broker file this row came from.
  // NULL for historical rows imported pre-v21.
  source_file_id?: string | null

  created_at?: string
}

// ─── BrokerFile ─────────────────────────────────────────────────
// Mirrors the `broker_files` table. One row per uploaded PDF —
// either a contract-notes export or a statement-of-account export.
// PDF bytes live in Supabase Storage; this row is the catalog
// entry that ties staged_transactions and committed transactions
// back to their source. v21b-1.
export interface BrokerFile {
  id: string
  portfolio_id: string
  file_kind: 'contract_notes' | 'statement'
  original_filename: string
  storage_path: string
  size_bytes?: number | null

  // Parse metadata
  parsed_at?: string | null
  parse_status: 'pending' | 'parsed' | 'parse_failed' | 'committed' | 'rolled_back'
  parse_error?: string | null

  // Content metadata (filled by parser)
  account_holder?: string | null
  cscs_number?: string | null
  period_from?: string | null
  period_to?: string | null

  // Statement-only: running-balance audit result
  audit_opening?: number | null
  audit_closing?: number | null
  audit_computed?: number | null
  audit_passes?: boolean | null

  uploaded_by?: string | null
  created_at: string
  updated_at: string
}

// ─── StagedTransaction ──────────────────────────────────────────
// Mirrors `staged_transactions` — parsed-but-not-yet-committed
// rows from a broker file. Promoted to `transactions` by the
// commit flow in v21c. recon_* fields carry the reconciliation
// status from the parser so the inbox UI can preview what would
// be imported. v21b-1.
export interface StagedTransaction {
  id: string
  broker_file_id: string
  portfolio_id: string

  trade_date: string
  settlement_date?: string | null
  action: string
  instrument_id?: string | null
  quantity?: number | null
  price?: number | null
  gross_value?: number | null
  amount?: number | null

  // Trade fees
  fee_commission?: number | null
  fee_vat?: number | null
  fee_exchange?: number | null
  fee_clearing?: number | null
  fee_sec?: number | null
  fee_contract_stamp?: number | null
  fee_sms?: number | null

  // Non-trade fee breakdown
  fee_management?: number | null
  fee_demat?: number | null
  fee_other?: number | null

  // Broker metadata
  cn_number?: string | null
  external_ref?: string | null
  narration?: string | null

  // Reconciliation state from the parser
  recon_kind?:
    | 'matched_exact'
    | 'matched_split'
    | 'partial_mismatch'
    | 'unmatched'
    | 'cash_event_auto'
    | 'cash_event_unknown'
    | null
  recon_note?: string | null

  // Dedup flags set by ingestion at upload time
  dedup_status: 'new' | 'duplicate_cn' | 'duplicate_fingerprint'
  duplicate_of?: string | null

  // User-driven staging flow
  include_in_commit: boolean

  created_at: string
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
