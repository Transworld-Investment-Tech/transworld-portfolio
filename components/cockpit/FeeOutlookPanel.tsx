'use client'

import Link from 'next/link'
import type { ReactElement } from 'react'
import type { FeeOutlook, FeeStatus } from '@/lib/fee-outlook'

// v27 — Fee Outlook table
//
// Sorted by excess_ngn ASC (most-at-risk-of-zero-fee first). Internal
// portfolios sink to the bottom and are visually de-emphasised.

interface Props {
  loading: boolean
  data: FeeOutlook[]
}

function fmtNgnM(v: number): string {
  if (v === 0) return '\u20a60.00M'
  const sign = v < 0 ? '−' : ''
  const abs = Math.abs(v)
  if (abs >= 1e9) return sign + '\u20a6' + (abs / 1e9).toFixed(2) + 'B'
  return sign + '\u20a6' + (abs / 1e6).toFixed(2) + 'M'
}

function fmtPct(v: number, dp = 1): string {
  if (!isFinite(v)) return '—'
  return (v >= 0 ? '+' : '') + (v * 100).toFixed(dp) + '%'
}

function statusPill(status: FeeStatus): { label: string; cls: string } {
  switch (status) {
    case 'beating':       return { label: 'Beating',     cls: 'pill-ok' }
    case 'on_track':      return { label: 'On track',    cls: 'pill-ok' }
    case 'at_risk':       return { label: 'At risk',     cls: 'pill-warn' }
    case 'below':         return { label: 'Below',       cls: 'pill-breach' }
    case 'no_basis':      return { label: 'No basis',    cls: 'pill-hold' }
    // v27ao: fee-architecture-aware statuses
    case 'fixed_annual':  return { label: 'Fixed fee',   cls: 'pill-ok' }
    case 'no_fee':        return { label: 'No fee',      cls: 'pill-hold' }
  }
}

export default function FeeOutlookPanel({ loading, data }: Props): ReactElement {
  if (loading) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)', fontSize: 12 }}>
        Loading fee outlook…
      </div>
    )
  }
  if (data.length === 0) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)', fontSize: 12 }}>
        No active mandates
      </div>
    )
  }

  return (
    <table className="h-table" style={{ fontSize: 12 }}>
      <thead>
        <tr>
          <th>Mandate</th>
          <th className="num">Current NAV</th>
          <th className="num">Target NAV</th>
          <th className="num">Excess</th>
          <th className="num">Excess %</th>
          <th className="num">Projected fee</th>
          <th>Status</th>
          <th className="num">Days left</th>
        </tr>
      </thead>
      <tbody>
        {data.map(row => {
          const sp = statusPill(row.status)
          const excessColor = row.excess_ngn >= 0 ? 'var(--pos)' : 'var(--neg)'
          const opacity = row.is_internal ? 0.5 : 1
          // v27ao: noMath = true when no performance math applies to this row
          const noMath = !!row.is_fixed_annual || row.status === 'no_fee'
          return (
            <tr key={row.portfolio_id} style={{ opacity }}>
              <td>
                <Link
                  href={`/portfolio/${row.portfolio_id}`}
                  style={{ textDecoration: 'none', color: 'inherit' }}
                >
                  <div style={{ fontWeight: 500 }}>
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
                    {row.client_name} · basis {row.year_start_basis === 'jan_1' ? 'Jan 1' : 'mandate start'}
                  </div>
                </Link>
              </td>
              <td className="num num-serif">{fmtNgnM(row.current_nav)}</td>
              {/* v27ao: target/excess/excess% are meaningless for fixed-annual and no-fee */}
              <td className="num num-serif" style={{ color: 'var(--text-2)' }}>
                {noMath ? '—' : fmtNgnM(row.target_nav)}
              </td>
              <td className="num num-serif" style={{ color: noMath ? 'var(--text-3)' : excessColor }}>
                {noMath ? '—' : fmtNgnM(row.excess_ngn)}
              </td>
              <td className="num" style={{ fontFamily: 'var(--font-mono)', color: noMath ? 'var(--text-3)' : excessColor }}>
                {noMath ? '—' : fmtPct(row.excess_pct)}
              </td>
              <td className="num num-serif">
                {row.is_fixed_annual ? (
                  <div>
                    <div style={{ color: 'var(--gold)' }}>{fmtNgnM(row.projected_annual_fee)}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-3)' }}>
                      YTD {fmtNgnM(row.pro_rata_ytd_fee ?? 0)}
                    </div>
                  </div>
                ) : row.status === 'no_fee' ? (
                  <span style={{ color: 'var(--text-3)' }}>—</span>
                ) : row.projected_annual_fee > 0 ? (
                  <span style={{ color: 'var(--gold)' }}>{fmtNgnM(row.projected_annual_fee)}</span>
                ) : (
                  <span style={{ color: 'var(--text-3)' }}>—</span>
                )}
              </td>
              <td>
                <span className={'pill ' + sp.cls}>{sp.label}</span>
              </td>
              <td className="num" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-3)' }}>
                {row.days_remaining}
              </td>
            </tr>
          )
        })}
      </tbody>
    </table>
  )
}
