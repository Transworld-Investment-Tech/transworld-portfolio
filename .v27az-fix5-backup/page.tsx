'use client'

import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { RefreshCw, ArrowLeft, Star } from 'lucide-react'

// ═══════════════════════════════════════════════════════════════
// app/instrument/[ticker]/page.tsx (v27az-fix3)
// ═══════════════════════════════════════════════════════════════
//
// Per-instrument detail page. Canonical landing target for any
// ticker click-through (cockpit panels, holdings tables, etc.).
//
// v27az-fix3 visual fixes:
//   1. <main> now explicitly sets `background: var(--bg)` — v27az
//      page rendered on a dark navy bg in production because the
//      route inherited body bg and never painted cream over it.
//   2. Panel/KPI cards now use the real hybrid-design CSS vars
//      ('--card' for fill, '--border' for outline). v27az-fix1 used
//      a non-existent var name whose fallback color was close-but-wrong.
//   3. KPI cards now have the 32px × 2px gold accent bar at top-left
//      that the hybrid design v3 reference specifies.
//   4. Panel titles now italic Cormorant, matching design v3.
//   5. Border-radius standardised to 5px (design v3 spec).
//   6. Panel header pattern aligned: 14px bottom padding on header,
//      18px margin-bottom, border-bottom var(--border-soft).
//
// Surfaces unchanged:
//   • Instrument metadata + price + day change in header
//   • Watchlist status chip
//   • 4-card KPI strip
//   • Holders table
//   • Recent Transactions table
//   • Friendly empty state for unknown tickers
//
// Deferred to v27ba/v27bb unchanged.
// ═══════════════════════════════════════════════════════════════

interface InstrumentResp {
  instrument?: {
    instrument_id: string
    name:          string
    sleeve_id:     string | null
    asset_class:   string | null
    type:          string | null
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
  const transactions = data.recent_transactions ?? []

  const dayChangePct = price.day_change_pct
  const dayChangeNgn = price.day_change_ngn
  const dayChangeColor: string =
    dayChangePct === null || dayChangePct === undefined
      ? 'var(--text-3)'
      : (dayChangePct >= 0 ? 'var(--pos)' : 'var(--neg)')

  const totalCostBasis = holders.reduce((s, h) => s + (h.cost_basis_ngn ?? 0), 0)

  return (
    <main style={mainStyle}>

      {/* ─── Page header (matches hybrid design v3 portfolio header) ── */}
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

      {/* ─── KPI strip with gold accent bars ────────────────────── */}
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

        <KpiCard label="Firm NGN Exposure" value={fmtNgnM(concentration.firm_value_ngn)}>
          <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 4 }}>
            cost {fmtNgnM(totalCostBasis)}
          </div>
        </KpiCard>

        <KpiCard label="% of Firm AUM" value={fmtPct(concentration.pct_of_firm_aum)}>
          <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 4 }}>
            {fmtPct(concentration.pct_of_firm_sleeve_exposure)} of firm {concentration.sleeve_label}
          </div>
        </KpiCard>
      </div>

      {/* ─── Watchlist chip ──────────────────────────────────── */}
      <div style={{ marginBottom: 20 }}>
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

      {/* ─── Holders panel ───────────────────────────────────── */}
      <Panel
        title={`Holders (${holders.length})`}
        meta={holders.length > 0
          ? `${fmtQty(concentration.total_qty)} shares · ${fmtNgnM(concentration.firm_value_ngn)}`
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

      {/* ─── Recent transactions panel ───────────────────────── */}
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
      {/* 32px × 2px gold accent bar at top-left — design v3 hallmark */}
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
