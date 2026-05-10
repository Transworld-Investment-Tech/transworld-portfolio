'use client'

import { useState } from 'react'
import type { ReactElement, CSSProperties } from 'react'
import type { WatchlistPulseData, WindowPulse } from '@/lib/cockpit-aggregations'

// v27d → v27aq — Watchlist Pulse Panel (windowed)
//
// Tabs: Day / Week / Month / Quarter. Each tab renders unheld
// equity-watchlist tickers that cleared the per-window threshold:
//   ±2% day, ±5% week, ±10% month, ±20% quarter.
//
// Per-window data sufficiency banners surface "insufficient" or "limited"
// states honestly — month/quarter empty until ≥30/≥90 days of NGX price
// history accumulate, then populate as backfill catches up.

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

// v27aq — Window keys & metadata
type WPKey = 'day' | 'week' | 'month' | 'quarter'

const WP_META: Record<WPKey, { label: string; sub: string; window_label: string }> = {
  day:     { label: 'Day',     sub: 'today',         window_label: 'today' },
  week:    { label: 'Week',    sub: '7-day',         window_label: 'this week' },
  month:   { label: 'Month',   sub: '30-day',        window_label: 'this month' },
  quarter: { label: 'Quarter', sub: '90-day',        window_label: 'this quarter' },
}

export default function WatchlistPulsePanel({ loading, data }: Props): ReactElement {
  const [activeWindow, setActiveWindow] = useState<WPKey>('day')

  if (loading) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)', fontSize: 12 }}>
        Loading watchlist pulse…
      </div>
    )
  }

  // Top-level empties — same regardless of active window (read off day window
  // since watchlist_size and unheld_count are window-invariant)
  if (!data || data.day.watchlist_size === 0) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)', fontSize: 12 }}>
        No active equity watchlist
      </div>
    )
  }

  if (data.day.unheld_count === 0) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)', fontSize: 12 }}>
        Every active equity-watchlist ticker is held by ≥1 mandate. No pulse signal.
      </div>
    )
  }

  const w: WindowPulse = data[activeWindow]
  const meta = WP_META[activeWindow]

  // Sufficiency dot indicators (parallel to TopMoversPanel)
  const sufficiency = (key: WPKey): 'full' | 'partial' | 'empty' => {
    const win = data[key]
    if (win.unheld_count === 0) return 'empty'
    if (win.instruments_with_data === 0) return 'empty'
    if (win.instruments_with_data < win.unheld_count * 0.5) return 'partial'
    return 'full'
  }

  // ─── Tab strip ─────────────────────────────────────────────
  const tabStrip = (
    <div style={{
      display: 'flex',
      gap: 0,
      marginBottom: 14,
      borderBottom: '1px solid var(--border-soft)',
    }}>
      {(Object.keys(WP_META) as WPKey[]).map(key => {
        const isActive = activeWindow === key
        const suff = sufficiency(key)
        return (
          <button
            key={key}
            onClick={() => setActiveWindow(key)}
            style={{
              background: 'transparent',
              border: 'none',
              borderBottom: isActive ? '2px solid var(--gold)' : '2px solid transparent',
              padding: '8px 16px',
              cursor: 'pointer',
              color: isActive ? 'var(--text)' : 'var(--text-3)',
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.08em',
              textTransform: 'uppercase',
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              position: 'relative',
              top: 1,
            }}
          >
            {WP_META[key].label}
            {suff === 'empty' && (
              <span title="Insufficient history" style={{
                width: 5, height: 5, borderRadius: '50%',
                background: 'var(--text-3)', opacity: 0.6,
              }} />
            )}
            {suff === 'partial' && (
              <span title="Limited data" style={{
                width: 5, height: 5, borderRadius: '50%',
                background: 'var(--gold)', opacity: 0.7,
              }} />
            )}
          </button>
        )
      })}
    </div>
  )

  // ─── Per-window empties ────────────────────────────────────
  // (a) Insufficient history — backfilling
  if (w.instruments_with_data === 0) {
    return (
      <div>
        {tabStrip}
        <div style={{
          padding: '14px 16px',
          background: 'rgba(176, 139, 62, 0.06)',
          border: '1px solid rgba(176, 139, 62, 0.20)',
          borderRadius: 4,
          fontSize: 11,
          color: 'var(--text-2)',
          lineHeight: 1.5,
        }}>
          <strong style={{ color: 'var(--text)' }}>Insufficient history.</strong>
          {' '}Backfilling — none of the {w.unheld_count} unheld watchlist tickers have NGX price data ≥ {meta.sub} old yet. This window will populate as price history accumulates.
        </div>
      </div>
    )
  }

  // (b) Has data but no rows above threshold
  if (w.rows.length === 0) {
    return (
      <div>
        {tabStrip}
        <div style={{ padding: 18, textAlign: 'center', color: 'var(--text-3)', fontSize: 12 }}>
          No unheld watchlist tickers moved more than ±{w.threshold_pct.toFixed(1)}% {meta.window_label}.
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
          <span>{w.unheld_count} unheld watchlist ticker{w.unheld_count === 1 ? '' : 's'}</span>
          <span>·</span>
          <span>{w.instruments_with_data} with {meta.sub} history</span>
          <span>·</span>
          <span>{w.below_threshold_count} moved below threshold</span>
          <span>·</span>
          <span>Prices as of {fmtAsOf(w.as_of_date)}</span>
        </div>
      </div>
    )
  }

  // (c) Partial-data warning banner (if shown alongside table)
  const partialBanner = (
    w.instruments_with_data > 0 && w.instruments_with_data < w.unheld_count * 0.5 && (
      <div style={{
        padding: '10px 12px',
        background: 'rgba(176, 139, 62, 0.04)',
        borderRadius: 4,
        fontSize: 10,
        color: 'var(--text-2)',
        marginBottom: 12,
      }}>
        Limited data: {w.instruments_with_data} of {w.unheld_count} unheld tickers have {meta.sub} history.
      </div>
    )
  )

  return (
    <div>
      {tabStrip}
      {partialBanner}
      <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            <th style={thLeft}>Ticker</th>
            <th style={thLeft}>Name</th>
            <th style={thLeft}>Sector</th>
            <th style={thRight}>Change ({meta.sub})</th>
            <th style={thRight}>Last price</th>
          </tr>
        </thead>
        <tbody>
          {w.rows.map(row => {
            const isPos = row.change_pct >= 0
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
                    {fmtPctSigned(row.change_pct)}
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
        <span>{w.rows.length} above ±{w.threshold_pct.toFixed(1)}% ({meta.sub})</span>
        <span>·</span>
        <span>{w.unheld_count} unheld watchlist ticker{w.unheld_count === 1 ? '' : 's'}</span>
        <span>·</span>
        <span>{w.instruments_with_data} with {meta.sub} history</span>
        <span>·</span>
        <span>{w.below_threshold_count} moved below threshold</span>
        <span style={{ marginLeft: 'auto' }}>Latest as of {fmtAsOf(w.as_of_date)}</span>
      </div>
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
