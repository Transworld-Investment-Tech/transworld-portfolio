'use client'

import Link from 'next/link'
import type { ReactElement } from 'react'
import type { FeeOutlook, FeeStatus } from '@/lib/fee-outlook'

// v27aw — Fee Outlook table
//
// Sorted by excess_ngn ASC (most-at-risk-of-zero-fee first). Internal
// portfolios sink to the bottom and are visually de-emphasised.
//
// Year-end fee column shows TWO numbers stacked:
//   - Primary (gold):  projected_year_end_fee  → what fee crystallises at
//                      fee_year_end if NAV is held flat from today
//   - Secondary (gray): "of ₦X crystallised"   → engine ground truth from
//                      fee_periods.fee_earned (latest pending row)
//
// The CIO sees "fee tracking to be billed Dec 31" alongside "fee that would be
// billable today if billed today". Gap between them tells the threshold-vs-NAV
// dynamic — if projection > crystallised, NAV is racing the threshold; if
// crystallised > projection, the threshold is catching up faster than NAV.

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
    case 'fixed_annual':  return { label: 'Fixed fee',   cls: 'pill-ok' }
    case 'no_fee':        return { label: 'No fee',      cls: 'pill-hold' }
    // v27aw: unanchored fee-bearing portfolios
    case 'unanchored':    return { label: 'Unanchored',  cls: 'pill-hold' }
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
          <th className="num">Starting NAV</th>
          <th className="num">Current NAV</th>
          <th className="num">Target NAV</th>
          <th className="num">Excess</th>
          <th className="num">Excess %</th>
          <th className="num">
            Year-end fee
            <br />
            <span style={{ fontWeight: 400, color: 'var(--text-3)', fontSize: 10 }}>
              (NAV held flat)
            </span>
          </th>
          <th>Status</th>
          <th className="num">Days left</th>
        </tr>
      </thead>
      <tbody>
        {data.map(row => {
          const sp = statusPill(row.status)
          const excessColor = row.excess_ngn >= 0 ? 'var(--pos)' : 'var(--neg)'
          const opacity = row.is_internal ? 0.5 : 1
          // noMath = true when no performance metrics apply to this row
          const noMath = !!row.is_fixed_annual
            || row.status === 'no_fee'
            || row.status === 'unanchored'

          // Year-end fee column rendering: stacked display
          let yearEndFeeCell: ReactElement
          if (row.is_fixed_annual) {
            yearEndFeeCell = (
              <div>
                <div style={{ color: 'var(--gold)' }}>{fmtNgnM(row.projected_year_end_fee)}</div>
                <div style={{ fontSize: 10, color: 'var(--text-3)' }}>
                  YTD {fmtNgnM(row.crystallised_ytd_fee)}
                </div>
              </div>
            )
          } else if (row.status === 'no_fee' || row.status === 'unanchored') {
            yearEndFeeCell = <span style={{ color: 'var(--text-3)' }}>—</span>
          } else if (row.projected_year_end_fee > 0 || row.crystallised_ytd_fee > 0) {
            yearEndFeeCell = (
              <div>
                <div style={{ color: 'var(--gold)' }}>{fmtNgnM(row.projected_year_end_fee)}</div>
                <div style={{ fontSize: 10, color: 'var(--text-3)' }}>
                  {row.crystallised_ytd_fee > 0
                    ? `of ${fmtNgnM(row.crystallised_ytd_fee)} crystallised`
                    : 'no crystallised'}
                </div>
              </div>
            )
          } else {
            yearEndFeeCell = <span style={{ color: 'var(--text-3)' }}>—</span>
          }

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
                        fontSize: 9, color: 'var(--gold)', fontWeight: 600,
                        letterSpacing: '0.1em', marginLeft: 6, textTransform: 'uppercase',
                      }}>Internal</span>
                    )}
                    {row.is_unanchored && (
                      <span style={{
                        fontSize: 9, color: 'var(--text-3)', fontWeight: 600,
                        letterSpacing: '0.1em', marginLeft: 6, textTransform: 'uppercase',
                      }}>Unanchored</span>
                    )}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-3)' }}>
                    {row.client_name} · basis {row.year_start_basis === 'jan_1' ? 'Jan 1' : 'mandate start'}
                  </div>
                </Link>
              </td>
              <td className="num num-serif" style={{ color: 'var(--text-2)' }}>
                {row.starting_nav_at_anchor != null ? fmtNgnM(row.starting_nav_at_anchor) : '—'}
              </td>
              <td className="num num-serif">{fmtNgnM(row.current_nav)}</td>
              <td className="num num-serif" style={{ color: 'var(--text-2)' }}>
                {noMath ? '—' : fmtNgnM(row.target_nav)}
              </td>
              <td className="num num-serif" style={{ color: noMath ? 'var(--text-3)' : excessColor }}>
                {noMath ? '—' : fmtNgnM(row.excess_ngn)}
              </td>
              <td className="num" style={{ fontFamily: 'var(--font-mono)', color: noMath ? 'var(--text-3)' : excessColor }}>
                {noMath ? '—' : fmtPct(row.excess_pct)}
              </td>
              <td className="num num-serif">{yearEndFeeCell}</td>
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
