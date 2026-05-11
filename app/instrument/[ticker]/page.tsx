'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { RefreshCw, ArrowLeft, Star } from 'lucide-react'

// ═══════════════════════════════════════════════════════════════
// app/instrument/[ticker]/page.tsx (v27ba)
// ═══════════════════════════════════════════════════════════════
//
// Per-instrument fundamentals research surface. Click-through target
// from cockpit, watchlist, portfolio holdings, and portfolio txns.
//
// v27ba additions — Per-instrument fundamentals research surface:
//   • KPI strip card 4 is now sleeve-aware:
//       - Equity: Market Cap (with % of firm AUM as subtext)
//       - FI:     Maturity / YTM (with % of firm AUM as subtext)
//   • New panel: FI Metadata (conditional on FI sleeve)
//       - Coupon %, frequency, maturity, YTM
//   • New panel: Trading Liquidity
//       - 4-cell windowed Avg Daily Value + Avg Daily Volume
//         (1D / 1W / 1M / 1Q trading days, sourced from NGX value_ngn)
//   • New panel: Dividend Snapshot (conditional on equity sleeve)
//       - Current declared DPS, frequency, yield, status, dates, notes
//   • New panel: Income History (firm-wide)
//       - INCOME transactions aggregated by trade_date with totals
//   • New panels render between Movement and Holders.
//
// v27az-fix5 functionality preserved:
//   • Movement panel (4 windowed pct moves + sparkline)
//   • Signals badge row (from localStorage cockpit cache)
//   • Holders + Recent Transactions panels
//   • Loading / not-found states
// ═══════════════════════════════════════════════════════════════

// ─── Type definitions ─────────────────────────────────────────

interface MoveWindow {
  pct:           number
  ngn_impact:    number
  anchor_date:   string
  anchor_price:  number
}

interface SparklinePoint {
  date:  string
  price: number
}

// v27ba: liquidity window shape
interface LiquidityWindow {
  avg_value_ngn: number
  avg_volume:    number
  trading_days:  number
}

// v27ba: income event aggregated firm-wide by trade_date
interface IncomeEvent {
  trade_date:       string
  income_category:  string | null
  total_amount_ngn: number
  mandate_count:    number
  mandates:         string[]
}

// v27ba: market cap block (null for FI / unrefreshed)
interface MarketCapBlock {
  ngn:                  number
  shares_outstanding:   number
  as_of_price_date:     string | null
  last_refreshed_at:    string | null
}

// v27ba: FI metadata block (null for equity)
interface FiMetadataBlock {
  coupon_pct:    number
  coupon_freq:   number | null
  maturity_date: string | null
  yield_pct:     number
}

interface InstrumentResp {
  instrument?: {
    instrument_id:                          string
    name:                                   string
    sleeve_id:                              string | null
    asset_class:                            string | null
    type:                                   string | null
    sector:                                 string | null
    ngx_symbol:                             string | null
    ngx_market:                             string | null
    approved:                               boolean | null
    currency:                               string | null
    last_div_date:                          string | null
    next_div_date:                          string | null
    div_per_share:                          number | null
    div_yield_pct:                          number | null
    div_status:                             string | null
    shares_outstanding:                     number | null
    shares_outstanding_last_refreshed_at:   string | null
  }
  price?: {
    current_price:  number | null
    price_date:     string | null
    day_change_pct: number | null
    day_change_ngn: number | null
  }
  watchlist?: {
    is_watchlisted: boolean
    section:        string | null
    sub_type:       string | null
  }
  holders?: Array<{
    portfolio_id:         string
    mandate_label:        string
    client_name:          string
    client_code:          string
    qty:                  number
    avg_cost:             number
    latest_price:         number
    market_value_ngn:     number
    cost_basis_ngn:       number
    unrealised_pl_ngn:    number
    unrealised_pl_pct:    number | null
    pct_of_portfolio_nav: number | null
  }>
  concentration?: {
    total_qty:                   number
    firm_value_ngn:              number
    mandate_count:               number
    pct_of_firm_aum:             number
    pct_of_firm_sleeve_exposure: number
    sleeve_label:                string
  }
  movement?: {
    day:       MoveWindow | null
    week:      MoveWindow | null
    month:     MoveWindow | null
    quarter:   MoveWindow | null
    sparkline: SparklinePoint[]
  }
  // v27ba additions
  market_cap?: MarketCapBlock | null
  liquidity?: {
    day:     LiquidityWindow | null
    week:    LiquidityWindow | null
    month:   LiquidityWindow | null
    quarter: LiquidityWindow | null
  }
  dividend_snapshot?: {
    div_per_share:         number
    div_yield_pct:         number
    div_frequency:         string | null
    div_status:            string | null
    last_div_date:         string | null
    next_div_date:         string | null
    div_notes:             string | null
    div_last_refreshed_at: string | null
  }
  income_history?: IncomeEvent[]
  fi_metadata?: FiMetadataBlock | null
  recent_transactions?: Array<{
    trade_date:    string
    action:        string
    portfolio_id:  string
    mandate_label: string
    client_code:   string
    qty:           number
    price:         number
    amount:        number
    narration:     string
  }>
  firm_context?: {
    firm_aum_ngn:          number
    firm_sleeve_total_ngn: number
  }
  error?:  string
  ticker?: string
}

// v27az-fix5: signals cache shape (preserved)
type CachedSignal = {
  id:                   string
  type:                 string
  severity:             'red' | 'amber' | 'gold'
  primary_subject:      string
  primary_subject_kind: 'ticker' | 'portfolio' | 'mandate'
  suggested_action?:    string
  narration?:           { headline?: string; body?: string }
  narrated?:            { headline?: string; body?: string }
}

// ─── Formatting helpers ─────────────────────────────────────────

function fmtNgnM(v: number | null | undefined): string {
  if (v === null || v === undefined || !isFinite(v)) return '—'
  const sign = v < 0 ? '−' : ''
  const abs = Math.abs(v)
  if (abs >= 1e9) return sign + '\u20a6' + (abs / 1e9).toFixed(2) + 'B'
  if (abs >= 1e6) return sign + '\u20a6' + (abs / 1e6).toFixed(2) + 'M'
  if (abs >= 1e3) return sign + '\u20a6' + (abs / 1e3).toFixed(1) + 'K'
  return sign + '\u20a6' + abs.toFixed(0)
}

function fmtNgnImpactSigned(v: number | null | undefined): string {
  if (v === null || v === undefined || !isFinite(v) || v === 0) return ''
  const sign = v < 0 ? '−' : '+'
  const abs = Math.abs(v)
  if (abs >= 1e9) return sign + '\u20a6' + (abs / 1e9).toFixed(2) + 'B'
  if (abs >= 1e6) return sign + '\u20a6' + (abs / 1e6).toFixed(2) + 'M'
  if (abs >= 1e3) return sign + '\u20a6' + (abs / 1e3).toFixed(1) + 'K'
  return sign + '\u20a6' + abs.toFixed(0)
}

function fmtNgn(v: number | null | undefined): string {
  if (v === null || v === undefined || !isFinite(v)) return '—'
  const sign = v < 0 ? '−' : ''
  return sign + '\u20a6' + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2 })
}

function fmtPct(v: number | null | undefined, dp = 2): string {
  if (v === null || v === undefined || !isFinite(v)) return '—'
  return (v * 100).toFixed(dp) + '%'
}

function fmtPctSigned(v: number | null | undefined, dp = 2): string {
  if (v === null || v === undefined || !isFinite(v)) return '—'
  return (v >= 0 ? '+' : '') + (v * 100).toFixed(dp) + '%'
}

// v27ba: format raw % (already in % units, e.g. coupon_pct=8.5 means 8.5%)
function fmtRawPct(v: number | null | undefined, dp = 2): string {
  if (v === null || v === undefined || !isFinite(v) || v === 0) return '—'
  return v.toFixed(dp) + '%'
}

function fmtQty(v: number | null | undefined): string {
  if (v === null || v === undefined || !isFinite(v)) return '—'
  return Math.round(v).toLocaleString('en-US')
}

// v27ba: short-form quantity for share counts (B/M/K suffix)
function fmtShares(v: number | null | undefined): string {
  if (v === null || v === undefined || !isFinite(v) || v === 0) return '—'
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B'
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M'
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K'
  return v.toFixed(0)
}

function fmtPrice(v: number | null | undefined): string {
  if (v === null || v === undefined || !isFinite(v)) return '—'
  return '\u20a6' + v.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return '—'
  try {
    const d = new Date(s + 'T00:00:00')
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
  } catch {
    return s
  }
}

function fmtDateShort(s: string | null | undefined): string {
  if (!s) return '—'
  try {
    const d = new Date(s + 'T00:00:00')
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
  } catch {
    return s
  }
}

// v27ba: relative time ("3 days ago", "12 weeks ago") — used for refresh
// timestamps on Dividend Snapshot + Market Cap so the operator can see
// how fresh each piece of fundamental data is.
function fmtRelativeTime(iso: string | null | undefined): string {
  if (!iso) return 'never'
  try {
    const then = new Date(iso).getTime()
    const now  = Date.now()
    const diffMs = now - then
    if (diffMs < 0) return 'in the future'
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24))
    if (days === 0) return 'today'
    if (days === 1) return 'yesterday'
    if (days < 7)  return `${days} days ago`
    const weeks = Math.floor(days / 7)
    if (weeks < 5) return `${weeks} week${weeks === 1 ? '' : 's'} ago`
    const months = Math.floor(days / 30)
    if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`
    const years = Math.floor(days / 365)
    return `${years} year${years === 1 ? '' : 's'} ago`
  } catch {
    return 'unknown'
  }
}

// v27ba: coupon frequency code → human label
function fmtCouponFreq(freq: number | null | undefined): string {
  if (freq === null || freq === undefined || freq === 0) return '—'
  if (freq === 1) return 'Annual'
  if (freq === 2) return 'Semi-annual'
  if (freq === 4) return 'Quarterly'
  if (freq === 12) return 'Monthly'
  return `${freq}× / year`
}

// v27ba: days between today and a future date (positive integer or null)
function daysUntil(s: string | null | undefined): number | null {
  if (!s) return null
  try {
    const target = new Date(s + 'T00:00:00').getTime()
    const today  = Date.now()
    const diff   = Math.floor((target - today) / (1000 * 60 * 60 * 24))
    return diff
  } catch {
    return null
  }
}

const ACTION_COLOR: Record<string, string> = {
  BUY:          'var(--pos)',
  SELL:         'var(--neg)',
  TRANSFER_IN:  'var(--gold)',
  TRANSFER_OUT: 'var(--warn)',
  INCOME:       'var(--pos)',
}

const SEVERITY_TIERS: Record<string, { label: string; bg: string; border: string; fg: string }> = {
  red:   { label: 'BREACH',      bg: 'rgba(166,59,59,0.10)',   border: 'rgba(166,59,59,0.30)',   fg: 'var(--neg)'  },
  amber: { label: 'ATTENTION',   bg: 'rgba(166,124,42,0.12)',  border: 'rgba(166,124,42,0.30)',  fg: 'var(--warn)' },
  gold:  { label: 'OPPORTUNITY', bg: 'rgba(176,139,62,0.10)',  border: 'rgba(176,139,62,0.30)',  fg: 'var(--gold)' },
}

// v27ba: status pill colors for dividend status
const DIV_STATUS_STYLE: Record<string, { bg: string; fg: string; label: string }> = {
  paying:    { bg: 'rgba(45, 110, 78, 0.12)',  fg: 'var(--pos)',  label: 'Paying'    },
  suspended: { bg: 'rgba(166, 59, 59, 0.12)',  fg: 'var(--neg)',  label: 'Suspended' },
  none:      { bg: 'rgba(15, 41, 71, 0.06)',   fg: 'var(--text-3)', label: 'None'    },
  variable:  { bg: 'rgba(166, 124, 42, 0.12)', fg: 'var(--warn)', label: 'Variable'  },
  unknown:   { bg: 'rgba(15, 41, 71, 0.06)',   fg: 'var(--text-3)', label: 'Unknown' },
}

// ─── Page ───────────────────────────────────────────────────────

export default function InstrumentPage() {
  const params = useParams<{ ticker: string }>()
  const ticker = (params?.ticker ?? '').toUpperCase()

  const [data, setData] = useState<InstrumentResp | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [signals, setSignals] = useState<CachedSignal[]>([])

  const load = useCallback(async () => {
    if (!ticker) return
    setRefreshing(true)
    try {
      const r = await fetch('/api/instrument/' + encodeURIComponent(ticker))
      const json = await r.json()
      setData(json)
    } catch {
      setData({ error: 'fetch_failed' })
    }
    setLoading(false)
    setRefreshing(false)
  }, [ticker])

  useEffect(() => { load() }, [load])

  // v27az-fix5: read cockpit signals cache; filter to this ticker (preserved)
  useEffect(() => {
    if (!ticker) return
    try {
      const cached = typeof window !== 'undefined'
        ? window.localStorage.getItem('cockpit-signals-cache-v1')
        : null
      if (!cached) return
      const parsed = JSON.parse(cached) as { as_of_date?: string; signals?: CachedSignal[] }
      if (!parsed || !Array.isArray(parsed.signals)) return
      const today = new Date().toISOString().slice(0, 10)
      if (parsed.as_of_date && parsed.as_of_date !== today) return
      const filtered = parsed.signals.filter(s =>
        s.primary_subject_kind === 'ticker'
        && typeof s.primary_subject === 'string'
        && s.primary_subject.toUpperCase() === ticker
      )
      setSignals(filtered)
    } catch {
      // Silent fail — empty signals
    }
  }, [ticker])

  // ─── Loading state ────────────────────────────────────────────
  if (loading) {
    return (
      <main style={mainStyle}>
        <div style={{ color: 'var(--text-3)', fontSize: 12 }}>Loading {ticker}…</div>
      </main>
    )
  }

  // ─── Not-found state ──────────────────────────────────────────
  if (data?.error === 'not_found' || !data?.instrument) {
    return (
      <main style={mainStyle}>
        <div style={crumbStyle}>Transworld Investment and Securities</div>
        <h1 style={{
          fontFamily: '"Cormorant Garamond", Georgia, serif',
          fontWeight: 500,
          fontSize: 36,
          letterSpacing: '-0.005em',
          lineHeight: 1,
          color: 'var(--text)',
          marginBottom: 24,
        }}>
          {ticker}
        </h1>
        <div style={{
          padding: 32,
          background: 'var(--card)',
          border: '1px solid var(--border)',
          borderRadius: 5,
          textAlign: 'center',
          color: 'var(--text-2)',
        }}>
          <div style={{ marginBottom: 12 }}>
            <strong>{ticker}</strong> isn&apos;t in your instrument universe.
          </div>
          <Link href="/watchlist" style={{ color: 'var(--gold)', textDecoration: 'none' }}>
            <ArrowLeft size={12} style={{ display: 'inline', marginRight: 4 }} />
            Back to watchlist
          </Link>
        </div>
      </main>
    )
  }

  // ─── Main render ──────────────────────────────────────────────
  const inst         = data.instrument
  const price        = data.price ?? {} as NonNullable<InstrumentResp['price']>
  const wl           = data.watchlist ?? { is_watchlisted: false, section: null, sub_type: null }
  const holders      = data.holders ?? []
  const concentration = data.concentration ?? {
    total_qty: 0, firm_value_ngn: 0, mandate_count: 0,
    pct_of_firm_aum: 0, pct_of_firm_sleeve_exposure: 0, sleeve_label: '',
  }
  const movement     = data.movement
  const transactions = data.recent_transactions ?? []

  // v27ba: new data blocks
  const marketCap        = data.market_cap        ?? null
  const liquidity        = data.liquidity         ?? null
  const dividendSnapshot = data.dividend_snapshot ?? null
  const incomeHistory    = data.income_history    ?? []
  const fiMetadata       = data.fi_metadata       ?? null

  const sleeveId       = inst.sleeve_id ?? ''
  const isEquity       = sleeveId === 'eq'
  const isFi           = sleeveId === 'ntb' || sleeveId === 'fi'

  const dayChangePct = price.day_change_pct
  const dayChangeNgn = price.day_change_ngn
  const dayChangeColor: string =
    dayChangePct === null || dayChangePct === undefined
      ? 'var(--text-3)'
      : (dayChangePct >= 0 ? 'var(--pos)' : 'var(--neg)')

  const totalCostBasis = holders.reduce((s, h) => s + (h.cost_basis_ngn ?? 0), 0)
  const firmValueNgn = concentration.firm_value_ngn ?? 0

  return (
    <main style={mainStyle}>

      {/* ─── Page header ─────────────────────────────────────── */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-end',
        paddingBottom: 22,
        borderBottom: '1px solid var(--border)',
        marginBottom: 28,
      }}>
        <div>
          <div style={crumbStyle}>Transworld Investment and Securities</div>
          <h1 style={{
            fontFamily: '"Cormorant Garamond", Georgia, serif',
            fontSize: 36,
            fontWeight: 500,
            letterSpacing: '-0.005em',
            lineHeight: 1,
            color: 'var(--text)',
            marginBottom: 6,
          }}>
            {inst.name}
          </h1>
          <div style={{ fontSize: 12, color: 'var(--text-2)', letterSpacing: '0.04em' }}>
            <span style={{
              fontFamily: 'var(--font-mono, ui-monospace, monospace)',
              color: 'var(--gold)',
              fontWeight: 600,
            }}>
              {inst.instrument_id}
            </span>
            {' · '}{inst.type ?? 'Stock'}
            {' · '}{inst.sector ?? 'Unclassified'}
            {inst.ngx_market ? ' · ' + inst.ngx_market : ''}
            {inst.approved === false ? (
              <span style={{ marginLeft: 8, color: 'var(--warn)', fontWeight: 500 }}>
                · UNAPPROVED
              </span>
            ) : null}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            onClick={() => load()}
            disabled={refreshing}
            style={{
              padding: '8px 14px',
              fontSize: 12,
              fontWeight: 500,
              background: 'transparent',
              border: '1px solid var(--border-strong, rgba(15,41,71,0.22))',
              color: 'var(--text)',
              borderRadius: 3,
              cursor: refreshing ? 'wait' : 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontFamily: '"DM Sans", system-ui, sans-serif',
            }}
          >
            <RefreshCw
              size={12}
              style={refreshing ? { animation: 'spin-instrument 1s linear infinite' } : undefined}
            />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* ─── KPI strip (v27ba: card 4 sleeve-aware) ──────────── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 14,
        marginBottom: 28,
      }}>
        <KpiCard label="Current Price" value={fmtPrice(price.current_price)}>
          <div style={{ fontSize: 11, color: dayChangeColor, marginTop: 4 }}>
            {fmtPctSigned(dayChangePct)} ({fmtNgn(dayChangeNgn)})
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>
            as of {fmtDate(price.price_date)}
          </div>
        </KpiCard>

        <KpiCard
          label="Held By"
          value={
            <>
              {concentration.mandate_count}
              <span style={{ fontSize: 14, color: 'var(--text-2)', marginLeft: 6 }}>
                {concentration.mandate_count === 1 ? 'mandate' : 'mandates'}
              </span>
            </>
          }
        >
          <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 4 }}>
            {fmtQty(concentration.total_qty)} shares firm-wide
          </div>
        </KpiCard>

        <KpiCard label="Firm NGN Exposure" value={fmtNgnM(firmValueNgn)}>
          <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 4 }}>
            cost {fmtNgnM(totalCostBasis)}
          </div>
        </KpiCard>

        {/* v27ba: sleeve-aware KPI4 */}
        {isFi && fiMetadata ? (
          <KpiCard label="Maturity / YTM" value={
            fiMetadata.maturity_date
              ? <span style={{ fontSize: 28 }}>{fmtDate(fiMetadata.maturity_date)}</span>
              : '—'
          }>
            <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 4 }}>
              YTM: <strong style={{ color: 'var(--text)' }}>{fmtRawPct(fiMetadata.yield_pct)}</strong>
              {(() => {
                const d = daysUntil(fiMetadata.maturity_date)
                if (d === null) return null
                if (d < 0) return <span style={{ color: 'var(--neg)', marginLeft: 6 }}>· matured</span>
                return <span style={{ color: 'var(--text-3)', marginLeft: 6 }}>· {d}d to mat.</span>
              })()}
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>
              {fmtPct(concentration.pct_of_firm_aum)} of firm AUM
            </div>
          </KpiCard>
        ) : (
          <KpiCard label="Market Cap" value={marketCap ? fmtNgnM(marketCap.ngn) : '—'}>
            <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 4 }}>
              {fmtPct(concentration.pct_of_firm_aum)} of firm AUM
            </div>
            <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>
              {marketCap
                ? <>{fmtShares(marketCap.shares_outstanding)} shares O/S · refreshed {fmtRelativeTime(marketCap.last_refreshed_at)}</>
                : isEquity
                  ? <span style={{ color: 'var(--warn)' }}>Shares O/S not yet refreshed</span>
                  : <>—</>}
            </div>
          </KpiCard>
        )}
      </div>

      {/* ─── Watchlist chip ──────────────────────────────────── */}
      <div style={{ marginBottom: 16 }}>
        {wl.is_watchlisted ? (
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            padding: '4px 10px',
            background: 'rgba(45, 110, 78, 0.12)',
            color: 'var(--pos)',
            borderRadius: 2,
            fontSize: 9,
            fontWeight: 600,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
          }}>
            <Star size={9} fill="currentColor" stroke="currentColor" style={{ marginRight: 6 }} />
            On watchlist
            {wl.section ? ' · ' + wl.section : ''}
            {wl.sub_type ? ' / ' + wl.sub_type : ''}
          </span>
        ) : (
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            padding: '4px 10px',
            background: 'rgba(15, 41, 71, 0.04)',
            color: 'var(--text-3)',
            borderRadius: 2,
            fontSize: 9,
            fontWeight: 600,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
          }}>
            Not on watchlist
          </span>
        )}
      </div>

      {/* ─── Signals badge row (v27az-fix5, preserved) ──────── */}
      {signals.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 20 }}>
          {signals.map(s => (
            <SignalBadge key={s.id} signal={s} />
          ))}
        </div>
      )}

      {/* ─── Movement panel (v27az-fix5, preserved) ─────────── */}
      {movement && (
        <div style={{ marginBottom: 20 }}>
          <Panel
            title="Movement"
            meta={movement.sparkline.length > 0 ? `${movement.sparkline.length}-day trend` : null}
          >
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: 16,
              marginBottom: 22,
            }}>
              <MoveCell label="Today"   data={movement.day}     firmValue={firmValueNgn} />
              <MoveCell label="Week"    data={movement.week}    firmValue={firmValueNgn} />
              <MoveCell label="Month"   data={movement.month}   firmValue={firmValueNgn} />
              <MoveCell label="Quarter" data={movement.quarter} firmValue={firmValueNgn} />
            </div>
            <Sparkline points={movement.sparkline} />
          </Panel>
        </div>
      )}

      {/* ─── v27ba: FI Metadata panel (conditional on FI sleeve) ─ */}
      {isFi && fiMetadata && (
        <div style={{ marginBottom: 20 }}>
          <Panel title="Fixed Income Profile" meta="Bond / NTB fundamentals">
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: 16,
            }}>
              <FiCell label="Coupon" value={fmtRawPct(fiMetadata.coupon_pct)}
                sub={fmtCouponFreq(fiMetadata.coupon_freq)} />
              <FiCell label="Maturity" value={fmtDate(fiMetadata.maturity_date)}
                sub={(() => {
                  const d = daysUntil(fiMetadata.maturity_date)
                  if (d === null) return ''
                  if (d < 0) return 'Matured'
                  return `${d} days`
                })()} />
              <FiCell label="YTM" value={fmtRawPct(fiMetadata.yield_pct)}
                sub="Yield to maturity" />
              <FiCell label="Frequency" value={fmtCouponFreq(fiMetadata.coupon_freq)}
                sub={fiMetadata.coupon_freq ? `${fiMetadata.coupon_freq}× per year` : ''} />
            </div>
          </Panel>
        </div>
      )}

      {/* ─── v27ba: Trading Liquidity panel ──────────────────── */}
      {liquidity && (
        <div style={{ marginBottom: 20 }}>
          <Panel title="Trading Liquidity" meta="NGX-reported value & volume">
            <div style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(4, 1fr)',
              gap: 16,
            }}>
              <LiquidityCell label="Today"   window={liquidity.day}     windowSize={1} />
              <LiquidityCell label="Week"    window={liquidity.week}    windowSize={5} />
              <LiquidityCell label="Month"   window={liquidity.month}   windowSize={21} />
              <LiquidityCell label="Quarter" window={liquidity.quarter} windowSize={63} />
            </div>
            <div style={{
              marginTop: 16,
              paddingTop: 12,
              borderTop: '1px solid var(--border-soft, rgba(15,41,71,0.06))',
              fontSize: 11,
              color: 'var(--text-3)',
              lineHeight: 1.5,
            }}>
              Average daily ₦ value traded and share volume across active trading days only. Non-trading days excluded so the mean reflects real liquidity. <em>Trading days</em> = sessions with non-zero NGX print in the window.
            </div>
          </Panel>
        </div>
      )}

      {/* ─── v27ba: Dividend Snapshot panel (conditional on equity) ─ */}
      {isEquity && dividendSnapshot && (
        <div style={{ marginBottom: 20 }}>
          <Panel
            title="Dividend Snapshot"
            meta={
              dividendSnapshot.div_last_refreshed_at
                ? `Refreshed ${fmtRelativeTime(dividendSnapshot.div_last_refreshed_at)}`
                : 'Not yet refreshed'
            }
          >
            <DividendSnapshotBody snapshot={dividendSnapshot} />
          </Panel>
        </div>
      )}

      {/* ─── v27ba: Income History panel (firm-wide) ─────────── */}
      <div style={{ marginBottom: 20 }}>
        <Panel
          title={`Income History (${incomeHistory.length})`}
          meta="Firm-wide · last 12 events"
        >
          {incomeHistory.length === 0 ? (
            <div style={{ color: 'var(--text-3)', fontSize: 12, padding: '4px 0' }}>
              No income received yet for {inst.instrument_id}.
            </div>
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thLeft}>Date</th>
                  <th style={thLeft}>Category</th>
                  <th style={thRight}>Total Received</th>
                  <th style={thRight}>Mandates</th>
                  <th style={thLeft}>Mandate List</th>
                </tr>
              </thead>
              <tbody>
                {incomeHistory.map((e, idx) => (
                  <tr key={idx}>
                    <td style={tdLeft}>{fmtDate(e.trade_date)}</td>
                    <td style={tdLeft}>
                      <span style={{
                        fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                        fontSize: 10,
                        fontWeight: 600,
                        letterSpacing: '0.04em',
                        color: 'var(--gold)',
                        padding: '2px 6px',
                        background: 'rgba(176,139,62,0.08)',
                        borderRadius: 2,
                      }}>
                        {e.income_category ?? 'Other'}
                      </span>
                    </td>
                    <td style={{
                      ...tdRight,
                      fontFamily: '"Cormorant Garamond", Georgia, serif',
                      fontSize: 16,
                      fontWeight: 500,
                      letterSpacing: '-0.005em',
                      color: 'var(--pos)',
                    }}>
                      {fmtNgnM(e.total_amount_ngn)}
                    </td>
                    <td style={tdRight}>{e.mandate_count}</td>
                    <td style={{
                      ...tdLeft,
                      color: 'var(--text-2)',
                      fontSize: 11,
                      maxWidth: 320,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }} title={e.mandates.join(', ')}>
                      {e.mandates.join(', ')}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      {/* ─── Holders panel (preserved) ───────────────────────── */}
      <Panel
        title={`Holders (${holders.length})`}
        meta={holders.length > 0
          ? `${fmtQty(concentration.total_qty)} shares · ${fmtNgnM(firmValueNgn)}`
          : null
        }
      >
        {holders.length === 0 ? (
          <div style={{ color: 'var(--text-3)', fontSize: 12, padding: '4px 0' }}>
            No active mandates currently hold {inst.instrument_id}.
          </div>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thLeft}>Mandate</th>
                <th style={thLeft}>Client</th>
                <th style={thRight}>Qty</th>
                <th style={thRight}>Avg Cost</th>
                <th style={thRight}>Price</th>
                <th style={thRight}>Value</th>
                <th style={thRight}>Unrealised</th>
                <th style={thRight}>% NAV</th>
              </tr>
            </thead>
            <tbody>
              {holders.map((h, idx) => {
                const plColor = h.unrealised_pl_ngn >= 0 ? 'var(--pos)' : 'var(--neg)'
                return (
                  <tr key={idx}>
                    <td style={tdLeft}>
                      <Link
                        href={`/portfolio/${h.portfolio_id}`}
                        style={{ color: 'var(--gold)', textDecoration: 'none', fontWeight: 600 }}
                      >
                        {h.mandate_label}
                      </Link>
                    </td>
                    <td style={tdLeft}>{h.client_name}</td>
                    <td style={tdRight}>{fmtQty(h.qty)}</td>
                    <td style={tdRight}>{fmtPrice(h.avg_cost)}</td>
                    <td style={tdRight}>{fmtPrice(h.latest_price)}</td>
                    <td style={{
                      ...tdRight,
                      fontFamily: '"Cormorant Garamond", Georgia, serif',
                      fontSize: 16,
                      fontWeight: 500,
                      letterSpacing: '-0.005em',
                    }}>
                      {fmtNgnM(h.market_value_ngn)}
                    </td>
                    <td style={{ ...tdRight, color: plColor }}>
                      {fmtNgnM(h.unrealised_pl_ngn)}
                      <span style={{ fontSize: 10, marginLeft: 4 }}>
                        ({fmtPctSigned(h.unrealised_pl_pct)})
                      </span>
                    </td>
                    <td style={tdRight}>{fmtPct(h.pct_of_portfolio_nav)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </Panel>

      {/* ─── Recent transactions panel (preserved) ───────────── */}
      <div style={{ marginTop: 20 }}>
        <Panel
          title={`Recent Transactions (${transactions.length})`}
          meta="Last 20 firm-wide · excludes fees"
        >
          {transactions.length === 0 ? (
            <div style={{ color: 'var(--text-3)', fontSize: 12, padding: '4px 0' }}>
              No transactions on record for {inst.instrument_id}.
            </div>
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thLeft}>Date</th>
                  <th style={thLeft}>Action</th>
                  <th style={thLeft}>Mandate</th>
                  <th style={thRight}>Qty</th>
                  <th style={thRight}>Price</th>
                  <th style={thRight}>NGN Value</th>
                  <th style={thLeft}>Narration</th>
                </tr>
              </thead>
              <tbody>
                {transactions.map((t, idx) => (
                  <tr key={idx}>
                    <td style={tdLeft}>{fmtDate(t.trade_date)}</td>
                    <td style={tdLeft}>
                      <span style={{
                        fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                        fontSize: 10,
                        fontWeight: 600,
                        letterSpacing: '0.04em',
                        color: ACTION_COLOR[t.action] ?? 'var(--text-2)',
                        padding: '2px 6px',
                        background: 'rgba(15,41,71,0.04)',
                        borderRadius: 2,
                      }}>
                        {t.action}
                      </span>
                    </td>
                    <td style={tdLeft}>
                      <Link
                        href={`/portfolio/${t.portfolio_id}`}
                        style={{ color: 'var(--gold)', textDecoration: 'none' }}
                      >
                        {t.mandate_label}
                      </Link>
                    </td>
                    <td style={tdRight}>{fmtQty(t.qty)}</td>
                    <td style={tdRight}>{fmtPrice(t.price)}</td>
                    <td style={tdRight}>{fmtNgn(t.amount)}</td>
                    <td style={{
                      ...tdLeft,
                      color: 'var(--text-2)',
                      fontSize: 11,
                      maxWidth: 300,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }} title={t.narration}>
                      {t.narration || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>
      </div>

      <style jsx>{`
        @keyframes spin-instrument {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </main>
  )
}

// ─── Sub-components ─────────────────────────────────────────────

function KpiCard({
  label,
  value,
  children,
}: {
  label:    string
  value:    React.ReactNode
  children?: React.ReactNode
}) {
  return (
    <div style={{
      background: 'var(--card)',
      border: '1px solid var(--border)',
      borderRadius: 5,
      padding: '20px 22px',
      position: 'relative',
      overflow: 'hidden',
    }}>
      <div style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: 32,
        height: 2,
        background: 'var(--gold)',
      }} />
      <div style={{
        fontSize: 10,
        letterSpacing: '0.16em',
        fontWeight: 600,
        color: 'var(--text-3)',
        textTransform: 'uppercase',
        marginBottom: 14,
      }}>
        {label}
      </div>
      <div style={{
        fontFamily: '"Cormorant Garamond", Georgia, serif',
        fontSize: 36,
        fontWeight: 500,
        letterSpacing: '-0.015em',
        lineHeight: 1,
        color: 'var(--text)',
        marginBottom: 10,
      }}>
        {value}
      </div>
      {children}
    </div>
  )
}

function Panel({
  title,
  meta,
  children,
}: {
  title:    string
  meta?:    string | null
  children?: React.ReactNode
}) {
  return (
    <div style={{
      background: 'var(--card)',
      border: '1px solid var(--border)',
      borderRadius: 5,
      padding: '24px 26px',
    }}>
      <div style={{
        display: 'flex',
        alignItems: 'baseline',
        justifyContent: 'space-between',
        paddingBottom: 14,
        marginBottom: 18,
        borderBottom: '1px solid var(--border-soft, rgba(15,41,71,0.06))',
      }}>
        <div style={{
          fontFamily: '"Cormorant Garamond", Georgia, serif',
          fontStyle: 'italic',
          fontSize: 18,
          fontWeight: 500,
          color: 'var(--text)',
        }}>
          {title}
        </div>
        {meta ? (
          <div style={{
            fontSize: 10,
            letterSpacing: '0.12em',
            color: 'var(--text-3)',
            textTransform: 'uppercase',
            fontWeight: 600,
          }}>
            {meta}
          </div>
        ) : null}
      </div>
      {children}
    </div>
  )
}

// v27az-fix5: MoveCell (preserved)
function MoveCell({
  label,
  data,
  firmValue,
}: {
  label:     string
  data:      MoveWindow | null
  firmValue: number
}) {
  if (!data) {
    return (
      <div style={{ borderLeft: '2px solid var(--border-soft, rgba(15,41,71,0.06))', paddingLeft: 14 }}>
        <div style={{
          fontSize: 10,
          letterSpacing: '0.14em',
          fontWeight: 600,
          color: 'var(--text-3)',
          textTransform: 'uppercase',
          marginBottom: 8,
        }}>
          {label}
        </div>
        <div style={{
          fontFamily: '"Cormorant Garamond", Georgia, serif',
          fontSize: 22,
          fontWeight: 500,
          color: 'var(--text-3)',
        }}>
          —
        </div>
      </div>
    )
  }
  const color = data.pct >= 0 ? 'var(--pos)' : 'var(--neg)'
  return (
    <div style={{ borderLeft: '2px solid var(--border-soft, rgba(15,41,71,0.06))', paddingLeft: 14 }}>
      <div style={{
        fontSize: 10,
        letterSpacing: '0.14em',
        fontWeight: 600,
        color: 'var(--text-3)',
        textTransform: 'uppercase',
        marginBottom: 8,
      }}>
        {label}
      </div>
      <div style={{
        fontFamily: '"Cormorant Garamond", Georgia, serif',
        fontSize: 22,
        fontWeight: 500,
        color,
        letterSpacing: '-0.01em',
        marginBottom: 3,
      }}>
        {fmtPctSigned(data.pct)}
      </div>
      {firmValue > 0 ? (
        <div style={{ fontSize: 11, color, fontVariantNumeric: 'tabular-nums' }}>
          {fmtNgnImpactSigned(data.ngn_impact)}
          <span style={{ color: 'var(--text-3)' }}> firm impact</span>
        </div>
      ) : (
        <div style={{ fontSize: 10, color: 'var(--text-3)' }}>
          from {fmtPrice(data.anchor_price)}
        </div>
      )}
    </div>
  )
}

// v27az-fix5: Sparkline (preserved)
function Sparkline({ points }: { points: SparklinePoint[] }) {
  if (points.length < 2) {
    return (
      <div style={{ fontSize: 11, color: 'var(--text-3)', padding: '8px 0', textAlign: 'center' }}>
        Insufficient price history for sparkline.
      </div>
    )
  }
  const W = 1000
  const H = 60
  const PAD = 4
  const prices = points.map(p => p.price)
  let min = prices[0]
  let max = prices[0]
  for (const p of prices) {
    if (p < min) min = p
    if (p > max) max = p
  }
  const range = max - min || 1
  const polylinePoints = points.map((p, i) => {
    const x = PAD + (i / (points.length - 1)) * (W - 2 * PAD)
    const y = H - PAD - ((p.price - min) / range) * (H - 2 * PAD)
    return `${x.toFixed(2)},${y.toFixed(2)}`
  }).join(' ')
  const last = points[points.length - 1]
  const first = points[0]
  const isUp = last.price >= first.price
  const strokeColor = isUp ? 'var(--pos)' : 'var(--neg)'
  const fillColor   = isUp ? 'rgba(45,110,78,0.06)' : 'rgba(166,59,59,0.06)'

  const lastX = (PAD + (points.length - 1) / (points.length - 1) * (W - 2 * PAD)).toFixed(2)
  const fillPath = `M ${PAD},${H - PAD} L ${polylinePoints.split(' ').join(' L ')} L ${lastX},${H - PAD} Z`

  const endX = PAD + (W - 2 * PAD)
  const endY = H - PAD - ((last.price - min) / range) * (H - 2 * PAD)

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ width: '100%', height: 60, display: 'block' }}
      >
        <path d={fillPath} fill={fillColor} stroke="none" />
        <polyline points={polylinePoints} fill="none" stroke={strokeColor} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
        <circle cx={endX} cy={endY} r="2.5" fill={strokeColor} />
      </svg>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        marginTop: 6,
        fontSize: 10,
        color: 'var(--text-3)',
        letterSpacing: '0.04em',
      }}>
        <span>
          <span style={{ color: 'var(--text-2)' }}>{fmtPrice(first.price)}</span>
          {' · '}{fmtDateShort(first.date)}
        </span>
        <span>
          <span style={{ color: 'var(--text-2)' }}>{fmtPrice(last.price)}</span>
          {' · '}{fmtDateShort(last.date)}
        </span>
      </div>
    </div>
  )
}

// v27az-fix5: SignalBadge (preserved)
function SignalBadge({ signal }: { signal: CachedSignal }) {
  const tier = SEVERITY_TIERS[signal.severity] ?? SEVERITY_TIERS.gold
  const headline =
    signal.narration?.headline
    ?? signal.narrated?.headline
    ?? signal.suggested_action
    ?? signal.type.replace(/_/g, ' ')
  return (
    <div style={{
      display: 'inline-flex',
      alignItems: 'center',
      padding: '7px 12px',
      background: tier.bg,
      border: `1px solid ${tier.border}`,
      borderRadius: 3,
      fontSize: 11,
      fontWeight: 500,
      letterSpacing: '0.01em',
      maxWidth: 520,
      lineHeight: 1.4,
    }}>
      <span style={{
        fontSize: 9,
        fontWeight: 700,
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        marginRight: 10,
        color: tier.fg,
        flexShrink: 0,
      }}>
        ● {tier.label}
      </span>
      <span style={{
        color: 'var(--text)',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }} title={headline}>
        {headline}
      </span>
    </div>
  )
}

// v27ba: FiCell — one cell in the FI Metadata grid
function FiCell({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div style={{ borderLeft: '2px solid var(--border-soft, rgba(15,41,71,0.06))', paddingLeft: 14 }}>
      <div style={{
        fontSize: 10,
        letterSpacing: '0.14em',
        fontWeight: 600,
        color: 'var(--text-3)',
        textTransform: 'uppercase',
        marginBottom: 8,
      }}>
        {label}
      </div>
      <div style={{
        fontFamily: '"Cormorant Garamond", Georgia, serif',
        fontSize: 22,
        fontWeight: 500,
        color: 'var(--text)',
        letterSpacing: '-0.01em',
        marginBottom: 3,
      }}>
        {value}
      </div>
      {sub ? (
        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
          {sub}
        </div>
      ) : null}
    </div>
  )
}

// v27ba: LiquidityCell — one cell in the Trading Liquidity grid
function LiquidityCell({
  label,
  window: w,
  windowSize,
}: {
  label:      string
  window:     LiquidityWindow | null
  windowSize: number
}) {
  if (!w) {
    return (
      <div style={{ borderLeft: '2px solid var(--border-soft, rgba(15,41,71,0.06))', paddingLeft: 14 }}>
        <div style={{
          fontSize: 10,
          letterSpacing: '0.14em',
          fontWeight: 600,
          color: 'var(--text-3)',
          textTransform: 'uppercase',
          marginBottom: 8,
        }}>
          {label}
        </div>
        <div style={{
          fontFamily: '"Cormorant Garamond", Georgia, serif',
          fontSize: 22,
          fontWeight: 500,
          color: 'var(--text-3)',
        }}>
          —
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
          no trading
        </div>
      </div>
    )
  }
  return (
    <div style={{ borderLeft: '2px solid var(--border-soft, rgba(15,41,71,0.06))', paddingLeft: 14 }}>
      <div style={{
        fontSize: 10,
        letterSpacing: '0.14em',
        fontWeight: 600,
        color: 'var(--text-3)',
        textTransform: 'uppercase',
        marginBottom: 8,
      }}>
        {label}
      </div>
      <div style={{
        fontFamily: '"Cormorant Garamond", Georgia, serif',
        fontSize: 22,
        fontWeight: 500,
        color: 'var(--text)',
        letterSpacing: '-0.01em',
        marginBottom: 3,
      }}>
        {fmtNgnM(w.avg_value_ngn)}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-2)', fontVariantNumeric: 'tabular-nums' }}>
        {fmtShares(w.avg_volume)} <span style={{ color: 'var(--text-3)' }}>shares</span>
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>
        {w.trading_days}/{windowSize} trading day{windowSize === 1 ? '' : 's'}
      </div>
    </div>
  )
}

// v27ba: DividendSnapshotBody — fields from instrument record
function DividendSnapshotBody({
  snapshot,
}: {
  snapshot: NonNullable<InstrumentResp['dividend_snapshot']>
}) {
  const statusKey = (snapshot.div_status ?? 'unknown').toLowerCase()
  const statusStyle = DIV_STATUS_STYLE[statusKey] ?? DIV_STATUS_STYLE.unknown

  return (
    <div>
      {/* Top row: status + key numbers */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 16,
        marginBottom: 18,
      }}>
        <div style={{ borderLeft: '2px solid var(--border-soft, rgba(15,41,71,0.06))', paddingLeft: 14 }}>
          <div style={dsLabelStyle}>Status</div>
          <span style={{
            display: 'inline-block',
            padding: '4px 10px',
            background: statusStyle.bg,
            color: statusStyle.fg,
            borderRadius: 2,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            marginTop: 4,
          }}>
            {statusStyle.label}
          </span>
        </div>
        <div style={{ borderLeft: '2px solid var(--border-soft, rgba(15,41,71,0.06))', paddingLeft: 14 }}>
          <div style={dsLabelStyle}>DPS</div>
          <div style={dsValueStyle}>{fmtPrice(snapshot.div_per_share)}</div>
        </div>
        <div style={{ borderLeft: '2px solid var(--border-soft, rgba(15,41,71,0.06))', paddingLeft: 14 }}>
          <div style={dsLabelStyle}>Yield</div>
          <div style={dsValueStyle}>{fmtPct(snapshot.div_yield_pct)}</div>
        </div>
        <div style={{ borderLeft: '2px solid var(--border-soft, rgba(15,41,71,0.06))', paddingLeft: 14 }}>
          <div style={dsLabelStyle}>Frequency</div>
          <div style={dsValueStyle}>{snapshot.div_frequency ?? '—'}</div>
        </div>
      </div>

      {/* Dates row */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 16,
        paddingTop: 14,
        borderTop: '1px solid var(--border-soft, rgba(15,41,71,0.06))',
        marginBottom: snapshot.div_notes ? 14 : 0,
      }}>
        <div>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-3)', letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 4 }}>
            Last paid
          </div>
          <div style={{ fontSize: 13, color: 'var(--text)' }}>{fmtDate(snapshot.last_div_date)}</div>
        </div>
        <div>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-3)', letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 4 }}>
            Next expected
          </div>
          <div style={{ fontSize: 13, color: 'var(--text)' }}>{fmtDate(snapshot.next_div_date)}</div>
        </div>
      </div>

      {/* Notes (if present) */}
      {snapshot.div_notes && (
        <div style={{
          paddingTop: 14,
          borderTop: '1px solid var(--border-soft, rgba(15,41,71,0.06))',
        }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-3)', letterSpacing: '0.14em', textTransform: 'uppercase', marginBottom: 6 }}>
            Notes
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.55 }}>
            {snapshot.div_notes}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Shared styles ──────────────────────────────────────────────

const mainStyle: React.CSSProperties = {
  flex: 1,
  padding: '32px 44px 64px',
  maxWidth: '100%',
  overflowX: 'hidden',
  background: 'var(--bg)',
  minHeight: '100vh',
}

const crumbStyle: React.CSSProperties = {
  fontSize: 10,
  letterSpacing: '0.18em',
  fontWeight: 600,
  color: 'var(--gold)',
  textTransform: 'uppercase',
  marginBottom: 10,
}

const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
}
const thLeft: React.CSSProperties = {
  padding: '10px 12px',
  textAlign: 'left',
  fontSize: 10,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.14em',
  color: 'var(--text-3)',
  borderBottom: '1px solid var(--border)',
}
const thRight: React.CSSProperties = { ...thLeft, textAlign: 'right' }
const tdLeft: React.CSSProperties = {
  padding: '12px 12px',
  textAlign: 'left',
  fontSize: 13,
  color: 'var(--text)',
  borderBottom: '1px solid var(--border-soft, rgba(15,41,71,0.06))',
}
const tdRight: React.CSSProperties = { ...tdLeft, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }

// v27ba: shared dividend-snapshot field styles
const dsLabelStyle: React.CSSProperties = {
  fontSize: 10,
  letterSpacing: '0.14em',
  fontWeight: 600,
  color: 'var(--text-3)',
  textTransform: 'uppercase',
  marginBottom: 8,
}
const dsValueStyle: React.CSSProperties = {
  fontFamily: '"Cormorant Garamond", Georgia, serif',
  fontSize: 22,
  fontWeight: 500,
  color: 'var(--text)',
  letterSpacing: '-0.01em',
}
