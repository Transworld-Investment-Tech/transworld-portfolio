'use client'

import type { ReactElement, CSSProperties } from 'react'
import type { WatchlistPulseData } from '@/lib/cockpit-aggregations'

// v27d — Watchlist Pulse Panel
//
// Equity-section watchlist tickers that are unheld by any active portfolio
// AND moved more than ±2.0% today. Surfaces "missed opportunities" — names
// the firm has researched but isn't currently expressing in any mandate.

interface Props {
  loading: boolean
  data: WatchlistPulseData | null
}

const fmtPctSigned = (v: number): string => {
  if (!isFinite(v)) return '—'
  const sign = v >= 0 ? '+' : ''
  return sign + v.toFixed(2) + '%'
}

const fmtNaira = (v: number | null | undefined): string => {
  if (v === null || v === undefined || !isFinite(v)) return '—'
  return '\u20a6' + v.toFixed(2)
}

const fmtAsOf = (iso: string | null): string => {
  if (!iso) return '—'
  // ISO yyyy-mm-dd → 'DD MMM YY'
  const d = new Date(iso + 'T00:00:00')
  if (isNaN(d.getTime())) return iso
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
}

export default function WatchlistPulsePanel({ loading, data }: Props): ReactElement {
  if (loading) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)', fontSize: 12 }}>
        Loading watchlist pulse…
      </div>
    )
  }

  if (!data || data.watchlist_size === 0) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)', fontSize: 12 }}>
        No active equity watchlist
      </div>
    )
  }

  if (data.unheld_count === 0) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)', fontSize: 12 }}>
        Every active equity-watchlist ticker is held by ≥1 mandate. No pulse signal.
      </div>
    )
  }

  if (data.rows.length === 0) {
    return (
      <div>
        <div style={{ padding: 18, textAlign: 'center', color: 'var(--text-3)', fontSize: 12 }}>
          No unheld watchlist tickers moved more than ±{data.threshold_pct.toFixed(1)}% today.
        </div>
        <div style={{
          marginTop: 4,
          fontSize: 10,
          color: 'var(--text-3)',
          display: 'flex',
          gap: 16,
          flexWrap: 'wrap',
          letterSpacing: '0.04em',
          padding: '0 8px',
        }}>
          <span>{data.unheld_count} unheld watchlist ticker{data.unheld_count === 1 ? '' : 's'}</span>
          <span>·</span>
          <span>{data.below_threshold_count} moved below threshold</span>
          <span>·</span>
          <span>Prices as of {fmtAsOf(data.as_of_date)}</span>
        </div>
      </div>
    )
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            <th style={thLeft}>Ticker</th>
            <th style={thLeft}>Name</th>
            <th style={thLeft}>Sector</th>
            <th style={thRight}>Day change</th>
            <th style={thRight}>Last price</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map(row => {
            const isPos = row.day_change_pct >= 0
            const moveColor = isPos ? 'var(--pos)' : 'var(--neg)'
            return (
              <tr key={row.ticker}>
                <td style={tdLeft}>
                  <span style={{
                    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                    color: 'var(--gold)',
                    fontWeight: 600,
                    fontSize: 12,
                    letterSpacing: '0.02em',
                  }}>
                    {row.ticker}
                  </span>
                </td>
                <td style={tdLeft}>
                  <span style={{ color: 'var(--text)' }}>{row.name}</span>
                </td>
                <td style={tdLeft}>
                  <span style={{ color: 'var(--text-2)', fontSize: 12 }}>
                    {row.sector ?? '—'}
                  </span>
                </td>
                <td style={tdRight}>
                  <span style={{
                    fontFamily: 'var(--font-serif)',
                    fontSize: 16,
                    fontWeight: 500,
                    color: moveColor,
                    letterSpacing: '-0.005em',
                  }}>
                    {fmtPctSigned(row.day_change_pct)}
                  </span>
                </td>
                <td style={tdRight}>
                  <span style={{ color: 'var(--text)', fontVariantNumeric: 'tabular-nums' }}>
                    {fmtNaira(row.latest_price)}
                  </span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      <div style={{
        marginTop: 12,
        fontSize: 10,
        color: 'var(--text-3)',
        display: 'flex',
        gap: 16,
        flexWrap: 'wrap',
        letterSpacing: '0.04em',
      }}>
        <span>{data.rows.length} above ±{data.threshold_pct.toFixed(1)}% threshold</span>
        <span>·</span>
        <span>{data.unheld_count} unheld watchlist ticker{data.unheld_count === 1 ? '' : 's'}</span>
        <span>·</span>
        <span>{data.below_threshold_count} moved below threshold</span>
        <span style={{ marginLeft: 'auto' }}>Prices as of {fmtAsOf(data.as_of_date)}</span>
      </div>
    </div>
  )
}

const thLeft: CSSProperties = {
  textAlign: 'left',
  padding: '10px 12px',
  fontSize: 10,
  letterSpacing: '0.14em',
  fontWeight: 600,
  color: 'var(--text-3)',
  textTransform: 'uppercase',
  borderBottom: '1px solid var(--border)',
}

const thRight: CSSProperties = {
  ...thLeft,
  textAlign: 'right',
}

const tdLeft: CSSProperties = {
  padding: '12px 12px',
  borderBottom: '1px solid var(--border-soft)',
  fontSize: 13,
  textAlign: 'left',
  verticalAlign: 'middle',
}

const tdRight: CSSProperties = {
  ...tdLeft,
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
}
