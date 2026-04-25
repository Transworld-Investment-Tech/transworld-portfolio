'use client'

import Link from 'next/link'
import type { ReactElement } from 'react'
import type { MandateHealth, HealthLevel } from '@/lib/mandate-health'

// v27 — Mandate Health Grid
// v27d — Watchlist alignment column header now reads 'Watchlist alignment'
//        without a version suffix (the check is real as of v27d).
//
// Rows = portfolios, columns = 11 best-practice checks. Cells colored
// green/amber/red/grey. Click a portfolio name to drill into that
// portfolio's overview.

interface Props {
  loading: boolean
  data: MandateHealth[]
}

const CHECK_COLUMNS: { key: keyof MandateHealth; label: string; short: string }[] = [
  { key: 'allocation_in_band',        label: 'Allocation in band',          short: 'Alloc' },
  { key: 'single_name_concentration', label: 'Single-name concentration',   short: 'Single' },
  { key: 'sleeve_concentration',      label: 'Sleeve concentration',        short: 'Sleeve' },
  { key: 'drawdown_clean',            label: 'Drawdown clean',              short: 'DD' },
  { key: 'income_on_track',           label: 'Income on track',             short: 'Inc' },
  { key: 'cash_in_band',              label: 'Cash in band',                short: 'Cash' },
  { key: 'fi_duration_sane',          label: 'FI duration sane',            short: 'FI dur' },
  { key: 'recent_activity',           label: 'Recent activity (90d)',       short: 'Active' },
  { key: 'report_current',            label: 'Report current',              short: 'Report' },
  { key: 'watchlist_alignment',       label: 'Watchlist alignment',         short: 'WL' },
  { key: 'beating_benchmark',         label: 'Beating benchmark',           short: 'Bench' },
]

function levelStyle(level: HealthLevel): { bg: string; color: string; symbol: string } {
  switch (level) {
    case 'green': return { bg: 'rgba(45, 110, 78, 0.18)',  color: '#2d6e4e', symbol: '●' }
    case 'amber': return { bg: 'rgba(166, 124, 42, 0.20)', color: '#a67c2a', symbol: '●' }
    case 'red':   return { bg: 'rgba(166, 59, 59, 0.18)',  color: '#a63b3b', symbol: '●' }
    case 'na':    return { bg: 'rgba(15, 41, 71, 0.04)',   color: '#b8bcc5', symbol: '–' }
  }
}

function fmtNgnM(v: number): string {
  return '\u20a6' + (v / 1e6).toFixed(2) + 'M'
}

export default function MandateHealthGrid({ loading, data }: Props): ReactElement {
  if (loading) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)', fontSize: 12 }}>
        Loading mandate health…
      </div>
    )
  }
  if (data.length === 0) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)', fontSize: 12 }}>
        No active portfolios
      </div>
    )
  }

  // Sort: red worst_level first, amber next, green/na last
  const sorted = [...data].sort((a, b) => {
    const order = { red: 0, amber: 1, green: 2, na: 3 }
    return order[a.worst_level] - order[b.worst_level]
  })

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
        <thead>
          <tr>
            <th style={{
              textAlign: 'left',
              padding: '10px 8px',
              fontSize: 10,
              letterSpacing: '0.14em',
              fontWeight: 600,
              color: 'var(--text-3)',
              textTransform: 'uppercase',
              borderBottom: '1px solid var(--border)',
              position: 'sticky',
              left: 0,
              background: 'var(--card)',
              zIndex: 1,
              minWidth: 200,
            }}>
              Mandate
            </th>
            <th style={{
              textAlign: 'right',
              padding: '10px 8px',
              fontSize: 10,
              letterSpacing: '0.14em',
              fontWeight: 600,
              color: 'var(--text-3)',
              textTransform: 'uppercase',
              borderBottom: '1px solid var(--border)',
              minWidth: 80,
            }}>
              NAV
            </th>
            <th style={{
              textAlign: 'right',
              padding: '10px 8px',
              fontSize: 10,
              letterSpacing: '0.14em',
              fontWeight: 600,
              color: 'var(--text-3)',
              textTransform: 'uppercase',
              borderBottom: '1px solid var(--border)',
              minWidth: 60,
            }}>
              YTD
            </th>
            {CHECK_COLUMNS.map(col => (
              <th
                key={String(col.key)}
                title={col.label}
                style={{
                  padding: '10px 6px',
                  fontSize: 9,
                  letterSpacing: '0.10em',
                  fontWeight: 600,
                  color: 'var(--text-3)',
                  textTransform: 'uppercase',
                  borderBottom: '1px solid var(--border)',
                  textAlign: 'center',
                  minWidth: 60,
                }}
              >
                {col.short}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map(row => {
            const ytdLabel = row.ytd_return_pct === null
              ? '—'
              : (row.ytd_return_pct >= 0 ? '+' : '') + (row.ytd_return_pct * 100).toFixed(1) + '%'
            const ytdColor = row.ytd_return_pct === null
              ? 'var(--text-3)'
              : row.ytd_return_pct >= 0 ? 'var(--pos)' : 'var(--neg)'

            return (
              <tr key={row.portfolio_id}>
                <td style={{
                  padding: '10px 8px',
                  borderBottom: '1px solid var(--border-soft)',
                  position: 'sticky',
                  left: 0,
                  background: 'var(--card)',
                  zIndex: 1,
                }}>
                  <Link
                    href={`/portfolio/${row.portfolio_id}`}
                    style={{ textDecoration: 'none', color: 'inherit' }}
                  >
                    <div style={{ fontWeight: 500, color: 'var(--text)' }}>
                      {row.client_code} — {row.portfolio_name}
                      {row.is_internal && (
                        <span style={{
                          fontSize: 9,
                          color: 'var(--gold)',
                          fontWeight: 600,
                          letterSpacing: '0.1em',
                          marginLeft: 6,
                          textTransform: 'uppercase',
                        }}>
                          Internal
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-3)' }}>
                      {row.client_name}
                    </div>
                  </Link>
                </td>
                <td className="num-serif" style={{
                  padding: '10px 8px',
                  textAlign: 'right',
                  borderBottom: '1px solid var(--border-soft)',
                  fontFamily: 'var(--font-serif)',
                  fontSize: 14,
                  color: 'var(--text)',
                }}>
                  {fmtNgnM(row.current_nav)}
                </td>
                <td style={{
                  padding: '10px 8px',
                  textAlign: 'right',
                  borderBottom: '1px solid var(--border-soft)',
                  fontFamily: 'var(--font-mono)',
                  color: ytdColor,
                  fontSize: 12,
                }}>
                  {ytdLabel}
                </td>
                {CHECK_COLUMNS.map(col => {
                  const check = row[col.key] as any
                  const lvl = check?.level as HealthLevel
                  const s = levelStyle(lvl)
                  return (
                    <td
                      key={String(col.key)}
                      title={check?.message ?? ''}
                      style={{
                        padding: '10px 6px',
                        textAlign: 'center',
                        borderBottom: '1px solid var(--border-soft)',
                      }}
                    >
                      <div
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          width: 26,
                          height: 22,
                          borderRadius: 3,
                          background: s.bg,
                          color: s.color,
                          fontSize: 14,
                          fontWeight: 700,
                          cursor: 'help',
                        }}
                      >
                        {s.symbol}
                      </div>
                    </td>
                  )
                })}
              </tr>
            )
          })}
        </tbody>
      </table>
      <div style={{ marginTop: 12, fontSize: 10, color: 'var(--text-3)', display: 'flex', gap: 18, flexWrap: 'wrap' }}>
        <span><span style={{ color: '#2d6e4e' }}>●</span> Green — within tolerance</span>
        <span><span style={{ color: '#a67c2a' }}>●</span> Amber — needs attention</span>
        <span><span style={{ color: '#a63b3b' }}>●</span> Red — breach or overdue</span>
        <span><span style={{ color: '#b8bcc5' }}>–</span> N/A</span>
        <span style={{ marginLeft: 'auto' }}>Hover any cell for detail · click mandate to drill in</span>
      </div>
    </div>
  )
}
