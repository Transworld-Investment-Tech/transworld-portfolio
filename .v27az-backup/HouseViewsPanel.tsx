'use client'

import Link from 'next/link'
import type { ReactElement, CSSProperties } from 'react'
import type { HouseViewsData } from '@/lib/cockpit-aggregations'

// v27d — House Views Panel
//
// Tickers held by ≥2 portfolios across the firm — surfaces firm-wide
// conviction. Sorted by mandate count desc, tie-break by firm exposure.

interface Props {
  loading: boolean
  data: HouseViewsData | null
}

const fmtNgnM = (v: number | null | undefined): string => {
  if (v === null || v === undefined || !isFinite(v)) return '—'
  if (Math.abs(v) >= 1e6) return '\u20a6' + (v / 1e6).toFixed(2) + 'M'
  if (Math.abs(v) >= 1e3) return '\u20a6' + (v / 1e3).toFixed(0) + 'K'
  return '\u20a6' + v.toFixed(0)
}

const fmtPct = (v: number | null | undefined, dp = 1): string => {
  if (v === null || v === undefined || !isFinite(v)) return '—'
  return (v * 100).toFixed(dp) + '%'
}

export default function HouseViewsPanel({ loading, data }: Props): ReactElement {
  if (loading) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)', fontSize: 12 }}>
        Loading house views…
      </div>
    )
  }
  if (!data || data.rows.length === 0) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)', fontSize: 12 }}>
        {data && data.total_unique > 0
          ? `No tickers held by ≥2 mandates yet (${data.total_unique} distinct equity position${data.total_unique === 1 ? '' : 's'} across the firm)`
          : 'No equity holdings across active portfolios'}
      </div>
    )
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr>
            <th style={thStyleLeft}>Ticker</th>
            <th style={thStyleLeft}>Name</th>
            <th style={thStyleLeft}>Sector</th>
            <th style={thStyleRight}>Mandates</th>
            <th style={thStyleRight}>Firm exposure</th>
            <th style={thStyleRight}>Share of equity book</th>
            <th style={thStyleLeft}>Held by</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.map(row => (
            <tr key={row.instrument_id}>
              <td style={tdLeft}>
                <span style={{
                  fontFamily: 'var(--font-mono, ui-monospace, monospace)',
                  color: 'var(--gold)',
                  fontWeight: 600,
                  fontSize: 12,
                  letterSpacing: '0.02em',
                }}>
                  {row.instrument_id}
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
                  color: 'var(--text)',
                  letterSpacing: '-0.005em',
                }}>
                  {row.mandate_count}
                </span>
              </td>
              <td style={tdRight}>
                <span style={{
                  fontFamily: 'var(--font-serif)',
                  fontSize: 14,
                  fontWeight: 500,
                  color: 'var(--text)',
                  letterSpacing: '-0.005em',
                }}>
                  {fmtNgnM(row.firm_exposure_ngn)}
                </span>
              </td>
              <td style={tdRight}>
                <span style={{ color: 'var(--text-2)' }}>
                  {fmtPct(row.share_of_firm_equity_pct)}
                </span>
              </td>
              <td style={{ ...tdLeft, maxWidth: 280 }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {row.mandates.map(m => (
                    <Link
                      key={m.portfolio_id}
                      href={`/portfolio/${m.portfolio_id}`}
                      title={`${m.portfolio_name} · ${fmtNgnM(m.ngn)}`}
                      style={{
                        display: 'inline-block',
                        padding: '2px 7px',
                        fontSize: 10,
                        letterSpacing: '0.06em',
                        fontWeight: 600,
                        color: m.is_internal ? 'var(--text-3)' : 'var(--gold)',
                        background: m.is_internal
                          ? 'rgba(15, 41, 71, 0.04)'
                          : 'rgba(176, 139, 62, 0.10)',
                        borderRadius: 3,
                        textDecoration: 'none',
                        textTransform: 'uppercase',
                        opacity: m.is_internal ? 0.7 : 1,
                      }}
                    >
                      {/* v27ap: chip = client_code-portfolio_label so A/B/C/D are distinguishable */}
                      {m.client_code}{m.portfolio_label ? `-${m.portfolio_label}` : ''}
                    </Link>
                  ))}
                </div>
              </td>
            </tr>
          ))}
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
        <span>{data.rows.length} ticker{data.rows.length === 1 ? '' : 's'} held by ≥2 mandates</span>
        <span>·</span>
        <span>{data.total_unique} distinct equity position{data.total_unique === 1 ? '' : 's'} firm-wide</span>
        <span>·</span>
        <span>Firm equity book {fmtNgnM(data.firm_equity_total)}</span>
        <span style={{ marginLeft: 'auto' }}>Click any mandate code to drill in</span>
      </div>
    </div>
  )
}

// ─── Cell styles ────────────────────────────────────────────────
const thStyleLeft: CSSProperties = {
  textAlign: 'left',
  padding: '10px 12px',
  fontSize: 10,
  letterSpacing: '0.14em',
  fontWeight: 600,
  color: 'var(--text-3)',
  textTransform: 'uppercase',
  borderBottom: '1px solid var(--border)',
}

const thStyleRight: CSSProperties = {
  ...thStyleLeft,
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
