'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { RefreshCw, ArrowLeft, Star } from 'lucide-react'

// ═══════════════════════════════════════════════════════════════
// app/instrument/[ticker]/page.tsx (v27az)
// ═══════════════════════════════════════════════════════════════
//
// Per-instrument detail page. Canonical landing target for any
// ticker click-through in the app (cockpit panels, holdings tables,
// transactions tables, future searches, etc.).
//
// Surfaces:
//   • Instrument metadata + latest price + day change
//   • Watchlist status badge (positive/neutral chip)
//   • 4-card KPI strip
//   • Holders table (every active portfolio holding this instrument)
//   • Recent transactions firm-wide (last 20 non-FEE)
//
// Deferred to v27ba:
//   12mo price chart, dividend history, FI metadata block, peer
//   sector context, yield curve placement, watchlist row + portfolio
//   Holdings/Transactions row rewires.
//
// Deferred to v27bb:
//   Claude-powered commentary panel, sidebar "Focus list" nav addition.
// ═══════════════════════════════════════════════════════════════

interface InstrumentResp {
  instrument?: {
    instrument_id: string
    name:          string
    sleeve_id:     string
    asset_class:   string
    type:          string
    sector:        string | null
    ngx_symbol:    string | null
    ngx_market:    string | null
    approved:      boolean | null
    currency:      string | null
    last_div_date: string | null
    next_div_date: string | null
    div_per_share: number | null
    div_yield_pct: number | null
    div_status:    string | null
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

// ─── Formatting helpers (pitfall #73) ───────────────────────────

function fmtNgnM(v: number | null | undefined): string {
  if (v === null || v === undefined || !isFinite(v)) return '—'
  const sign = v < 0 ? '−' : ''
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

function fmtQty(v: number | null | undefined): string {
  if (v === null || v === undefined || !isFinite(v)) return '—'
  return Math.round(v).toLocaleString('en-US')
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

const ACTION_COLOR: Record<string, string> = {
  BUY:          'var(--pos)',
  SELL:         'var(--neg)',
  TRANSFER_IN:  'var(--gold)',
  TRANSFER_OUT: 'var(--warn)',
  INCOME:       'var(--pos)',
}

// ─── Page ───────────────────────────────────────────────────────

export default function InstrumentPage() {
  const params = useParams<{ ticker: string }>()
  const ticker = (params?.ticker ?? '').toUpperCase()

  const [data, setData] = useState<InstrumentResp | null>(null)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)

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

  // ─── Loading state ────────────────────────────────────────────
  if (loading) {
    return (
      <main style={{ padding: '32px 44px 64px', maxWidth: '100%' }}>
        <div style={{ color: 'var(--text-3)', fontSize: 12 }}>Loading {ticker}…</div>
      </main>
    )
  }

  // ─── Not-found state ──────────────────────────────────────────
  if (data?.error === 'not_found' || !data?.instrument) {
    return (
      <main style={{ padding: '32px 44px 64px', maxWidth: '100%' }}>
        <div className="eyebrow" style={{
          marginBottom: 10,
          fontSize: 10,
          letterSpacing: '0.18em',
          textTransform: 'uppercase',
          color: 'var(--gold)',
          fontWeight: 600,
        }}>
          Transworld Investment and Securities
        </div>
        <h1 style={{
          fontFamily: 'var(--font-serif, "Cormorant Garamond", Georgia, serif)',
          fontWeight: 500,
          fontSize: 36,
          marginBottom: 24,
        }}>
          {ticker}
        </h1>
        <div style={{
          padding: 32,
          background: 'var(--panel-bg, #fcfaf5)',
          border: '1px solid var(--border, rgba(0,0,0,0.08))',
          borderRadius: 6,
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
  const transactions = data.recent_transactions ?? []

  const dayChangePct = price.day_change_pct
  const dayChangeNgn = price.day_change_ngn
  const dayChangeColor: string =
    dayChangePct === null || dayChangePct === undefined
      ? 'var(--text-3)'
      : (dayChangePct >= 0 ? 'var(--pos)' : 'var(--neg)')

  const totalCostBasis = holders.reduce((s, h) => s + (h.cost_basis_ngn ?? 0), 0)

  return (
    <main style={{ padding: '32px 44px 64px', maxWidth: '100%' }}>

      {/* ─── Page header ──────────────────────────────────────── */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'flex-end',
        paddingBottom: 24,
        borderBottom: '1px solid var(--border, rgba(0,0,0,0.08))',
        marginBottom: 24,
      }}>
        <div>
          <div style={{
            marginBottom: 10,
            fontSize: 10,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'var(--gold)',
            fontWeight: 600,
          }}>
            Transworld Investment and Securities
          </div>
          <h1 style={{
            fontFamily: 'var(--font-serif, "Cormorant Garamond", Georgia, serif)',
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
              padding: '7px 12px',
              fontSize: 11,
              fontWeight: 500,
              background: 'transparent',
              border: '1px solid var(--border, rgba(0,0,0,0.15))',
              color: 'var(--text)',
              borderRadius: 4,
              cursor: refreshing ? 'wait' : 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <RefreshCw
              size={12}
              style={refreshing ? { animation: 'spin 1s linear infinite' } : undefined}
            />
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* ─── KPI strip ────────────────────────────────────────── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(4, 1fr)',
        gap: 12,
        marginBottom: 20,
      }}>
        <div style={kpiCardStyle}>
          <div style={kpiLabelStyle}>Current Price</div>
          <div style={kpiValueStyle}>{fmtPrice(price.current_price)}</div>
          <div style={{ fontSize: 11, color: dayChangeColor, marginTop: 4 }}>
            {fmtPctSigned(dayChangePct)} ({fmtNgn(dayChangeNgn)})
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>
            as of {fmtDate(price.price_date)}
          </div>
        </div>

        <div style={kpiCardStyle}>
          <div style={kpiLabelStyle}>Held By</div>
          <div style={kpiValueStyle}>
            {concentration.mandate_count}
            <span style={{ fontSize: 14, color: 'var(--text-2)', marginLeft: 6 }}>
              {concentration.mandate_count === 1 ? 'mandate' : 'mandates'}
            </span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 4 }}>
            {fmtQty(concentration.total_qty)} shares firm-wide
          </div>
        </div>

        <div style={kpiCardStyle}>
          <div style={kpiLabelStyle}>Firm NGN Exposure</div>
          <div style={kpiValueStyle}>{fmtNgnM(concentration.firm_value_ngn)}</div>
          <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 4 }}>
            cost {fmtNgnM(totalCostBasis)}
          </div>
        </div>

        <div style={kpiCardStyle}>
          <div style={kpiLabelStyle}>% of Firm AUM</div>
          <div style={kpiValueStyle}>{fmtPct(concentration.pct_of_firm_aum)}</div>
          <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 4 }}>
            {fmtPct(concentration.pct_of_firm_sleeve_exposure)} of firm {concentration.sleeve_label}
          </div>
        </div>
      </div>

      {/* ─── Watchlist chip ──────────────────────────────────── */}
      <div style={{ marginBottom: 24 }}>
        {wl.is_watchlisted ? (
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            padding: '6px 12px',
            background: 'rgba(45, 110, 78, 0.10)',
            color: 'var(--pos)',
            border: '1px solid rgba(45, 110, 78, 0.25)',
            borderRadius: 4,
            fontSize: 12,
            fontWeight: 500,
            letterSpacing: '0.04em',
          }}>
            <Star size={11} fill="currentColor" stroke="currentColor" style={{ marginRight: 6 }} />
            On watchlist
            {wl.section ? ' · ' + wl.section : ''}
            {wl.sub_type ? ' / ' + wl.sub_type : ''}
          </span>
        ) : (
          <span style={{
            display: 'inline-flex',
            alignItems: 'center',
            padding: '6px 12px',
            background: 'rgba(0,0,0,0.04)',
            color: 'var(--text-3)',
            border: '1px solid var(--border, rgba(0,0,0,0.08))',
            borderRadius: 4,
            fontSize: 12,
            fontWeight: 500,
            letterSpacing: '0.04em',
          }}>
            Not on watchlist
          </span>
        )}
      </div>

      {/* ─── Holders panel ───────────────────────────────────── */}
      <div style={panelStyle}>
        <div style={panelHeaderStyle}>
          <div style={panelTitleStyle}>Holders ({holders.length})</div>
          {holders.length > 0 ? (
            <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
              {fmtQty(concentration.total_qty)} shares · {fmtNgnM(concentration.firm_value_ngn)}
            </div>
          ) : null}
        </div>
        {holders.length === 0 ? (
          <div style={{ padding: 18, color: 'var(--text-3)', fontSize: 12 }}>
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
                      fontFamily: 'var(--font-serif, "Cormorant Garamond", Georgia, serif)',
                      fontSize: 14,
                      fontWeight: 500,
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
      </div>

      {/* ─── Recent transactions panel ───────────────────────── */}
      <div style={{ ...panelStyle, marginTop: 16 }}>
        <div style={panelHeaderStyle}>
          <div style={panelTitleStyle}>Recent Transactions ({transactions.length})</div>
          <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
            Last 20 firm-wide · excludes fees
          </div>
        </div>
        {transactions.length === 0 ? (
          <div style={{ padding: 18, color: 'var(--text-3)', fontSize: 12 }}>
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
                      background: 'rgba(0,0,0,0.03)',
                      borderRadius: 3,
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
      </div>

      <style jsx>{`
        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </main>
  )
}

// ─── Style constants ────────────────────────────────────────────

const kpiCardStyle: React.CSSProperties = {
  background: 'var(--panel-bg, #fcfaf5)',
  border: '1px solid var(--border, rgba(0,0,0,0.08))',
  borderRadius: 6,
  padding: 18,
}
const kpiLabelStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  letterSpacing: '0.12em',
  textTransform: 'uppercase',
  color: 'var(--text-3)',
  marginBottom: 6,
}
const kpiValueStyle: React.CSSProperties = {
  fontFamily: 'var(--font-serif, "Cormorant Garamond", Georgia, serif)',
  fontSize: 28,
  fontWeight: 500,
  letterSpacing: '-0.01em',
  color: 'var(--text)',
}

const panelStyle: React.CSSProperties = {
  background: 'var(--panel-bg, #fcfaf5)',
  border: '1px solid var(--border, rgba(0,0,0,0.08))',
  borderRadius: 6,
  overflow: 'hidden',
}
const panelHeaderStyle: React.CSSProperties = {
  padding: '14px 18px',
  borderBottom: '1px solid var(--border, rgba(0,0,0,0.08))',
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'baseline',
}
const panelTitleStyle: React.CSSProperties = {
  fontFamily: 'var(--font-serif, "Cormorant Garamond", Georgia, serif)',
  fontSize: 18,
  fontWeight: 500,
  letterSpacing: '-0.005em',
  color: 'var(--text)',
}

const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
}
const thLeft: React.CSSProperties = {
  padding: '10px 14px',
  textAlign: 'left',
  fontSize: 9,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: '0.12em',
  color: 'var(--text-3)',
  borderBottom: '1px solid var(--border, rgba(0,0,0,0.08))',
}
const thRight: React.CSSProperties = { ...thLeft, textAlign: 'right' }
const tdLeft: React.CSSProperties = {
  padding: '10px 14px',
  textAlign: 'left',
  fontSize: 13,
  color: 'var(--text)',
  borderBottom: '1px solid var(--border, rgba(0,0,0,0.04))',
}
const tdRight: React.CSSProperties = { ...tdLeft, textAlign: 'right' }
