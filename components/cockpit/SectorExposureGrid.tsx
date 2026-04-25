'use client'

import Link from 'next/link'
import type { ReactElement } from 'react'
import type { SectorExposureData } from '@/lib/cockpit-aggregations'

// v27c — Sector Exposure Grid
//
// Firm × portfolios heatmap. Equity sleeve only.
//   - Rows: portfolios sorted desc by total equity NAV (internal at bottom)
//   - Columns: sectors sorted desc by firm-wide exposure
//   - Cell value: % of that portfolio's equity NAV in that sector
//   - Cell background: gold ramp by % (0-30% range, capped at 30%)
//   - Click portfolio name → drill into overview
//   - Hover any cell → tooltip with NGN + portfolio share
//
// Numeric formatting via render helpers — bulletproof for unknown inputs (pitfall #73).

interface Props {
  loading: boolean
  data: SectorExposureData | null
}

// ─── Render helpers ────────────────────────────────────────────
function fmtNgnM(v: number | null | undefined): string {
  if (v === null || v === undefined || !isFinite(v)) return '—'
  if (Math.abs(v) >= 1e9) return '\u20a6' + (v / 1e9).toFixed(2) + 'B'
  return '\u20a6' + (v / 1e6).toFixed(2) + 'M'
}

function fmtPctOfPortfolio(ngn: number, totalEquityNav: number): string {
  if (totalEquityNav <= 0 || !isFinite(ngn)) return '—'
  const pct = (ngn / totalEquityNav) * 100
  return pct.toFixed(1) + '%'
}

// Map % concentration → background color intensity.
// 0% → white, 30%+ → full gold. Linear ramp in between.
function cellStyle(ngn: number, totalEquityNav: number): { bg: string; color: string; weight: number } {
  if (totalEquityNav <= 0 || ngn <= 0) {
    return { bg: 'transparent', color: 'var(--text-3)', weight: 400 }
  }
  const pct = ngn / totalEquityNav
  const ratio = Math.min(1, pct / 0.30)   // cap at 30%
  // Interpolate from transparent → soft gold → deep gold
  // Using rgba on the gold base (#b08b3e = 176, 139, 62)
  const alpha = 0.04 + ratio * 0.55       // 0.04 baseline, up to ~0.59
  const bg = `rgba(176, 139, 62, ${alpha.toFixed(3)})`
  // Text color: dark when alpha is low, slightly bolder/darker as ratio grows
  return {
    bg,
    color: ratio > 0.5 ? 'var(--text)' : 'var(--text-2)',
    weight: ratio > 0.4 ? 600 : 500,
  }
}

// Sector header tooltip: firm exposure + share of firm equity book
function fmtFirmTooltip(sector: string, ngn: number | undefined, firmTotal: number): string {
  if (ngn === undefined || ngn <= 0) return sector + ' — no firm exposure'
  const shareOfFirm = firmTotal > 0 ? (ngn / firmTotal) * 100 : 0
  return `${sector}: ${fmtNgnM(ngn)} firm-wide · ${shareOfFirm.toFixed(1)}% of firm equity book`
}

export default function SectorExposureGrid({ loading, data }: Props): ReactElement {
  if (loading) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)', fontSize: 12 }}>
        Loading sector exposure…
      </div>
    )
  }
  if (!data || data.sectors.length === 0 || data.portfolios.length === 0) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)', fontSize: 12 }}>
        No equity holdings across active portfolios
      </div>
    )
  }

  const { sectors, firm_totals, firm_total, portfolios } = data

  // Top sector for headline (largest firm-wide concentration)
  const topSector = sectors[0]
  const topSectorNgn = firm_totals[topSector] ?? 0
  const topSectorPct = firm_total > 0 ? (topSectorNgn / firm_total) * 100 : 0

  return (
    <div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{
          width: '100%',
          borderCollapse: 'collapse',
          fontSize: 12,
          minWidth: Math.max(720, 280 + sectors.length * 96),
        }}>
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
                minWidth: 220,
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
                minWidth: 92,
              }}>
                Equity NAV
              </th>
              {sectors.map(s => (
                <th
                  key={s}
                  title={fmtFirmTooltip(s, firm_totals[s], firm_total)}
                  style={{
                    textAlign: 'right',
                    padding: '10px 8px',
                    fontSize: 9,
                    letterSpacing: '0.08em',
                    fontWeight: 600,
                    color: 'var(--text-3)',
                    textTransform: 'uppercase',
                    borderBottom: '1px solid var(--border)',
                    minWidth: 88,
                    cursor: 'help',
                  }}
                >
                  {s}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {portfolios.map(row => {
              const opacity = row.is_internal ? 0.6 : 1
              return (
                <tr key={row.portfolio_id} style={{ opacity }}>
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
                    color: row.total_equity_nav > 0 ? 'var(--text)' : 'var(--text-3)',
                  }}>
                    {row.total_equity_nav > 0 ? fmtNgnM(row.total_equity_nav) : '—'}
                  </td>
                  {sectors.map(s => {
                    const ngn = row.sectors[s] ?? 0
                    const sty = cellStyle(ngn, row.total_equity_nav)
                    const tooltip = ngn > 0
                      ? `${row.client_code} ${row.portfolio_name} · ${s}\n${fmtNgnM(ngn)} · ${fmtPctOfPortfolio(ngn, row.total_equity_nav)} of equity NAV`
                      : `${row.client_code} ${row.portfolio_name} · ${s}\nNo holdings`
                    return (
                      <td
                        key={s}
                        title={tooltip}
                        style={{
                          padding: '10px 8px',
                          textAlign: 'right',
                          borderBottom: '1px solid var(--border-soft)',
                          background: sty.bg,
                          color: sty.color,
                          fontFamily: 'var(--font-mono)',
                          fontSize: 11,
                          fontWeight: sty.weight,
                          cursor: 'help',
                        }}
                      >
                        {ngn > 0 ? fmtPctOfPortfolio(ngn, row.total_equity_nav) : '—'}
                      </td>
                    )
                  })}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div style={{
        marginTop: 12,
        fontSize: 10,
        color: 'var(--text-3)',
        display: 'flex',
        gap: 18,
        flexWrap: 'wrap',
        alignItems: 'center',
      }}>
        <span>
          Firm equity book: <strong style={{ color: 'var(--text)', fontFamily: 'var(--font-serif)', fontSize: 13 }}>
            {fmtNgnM(firm_total)}
          </strong>
        </span>
        <span>
          Largest sector: <strong style={{ color: 'var(--text)' }}>{topSector}</strong>
          {' '}
          <span style={{ color: 'var(--gold)', fontWeight: 600 }}>{topSectorPct.toFixed(1)}%</span>
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ display: 'inline-block', width: 14, height: 10, background: 'rgba(176, 139, 62, 0.04)', border: '1px solid var(--border)' }} />
          low
          <span style={{ display: 'inline-block', width: 14, height: 10, background: 'rgba(176, 139, 62, 0.30)', border: '1px solid var(--border)', marginLeft: 4 }} />
          mid
          <span style={{ display: 'inline-block', width: 14, height: 10, background: 'rgba(176, 139, 62, 0.59)', border: '1px solid var(--border)', marginLeft: 4 }} />
          ≥30% concentration
        </span>
        <span style={{ marginLeft: 'auto' }}>
          Hover any cell for detail · click mandate to drill in
        </span>
      </div>
    </div>
  )
}
