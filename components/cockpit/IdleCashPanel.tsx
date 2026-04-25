'use client'

import Link from 'next/link'
import type { ReactElement } from 'react'

// v27 — Idle Cash flags: portfolios over their liq sleeve max

interface IdleCashRow {
  portfolio_id:   string
  portfolio_name: string
  client_name:    string
  cash_pct:       number
  liq_max:        number | null
  excess_ngn:     number
}

interface Props {
  loading: boolean
  data: IdleCashRow[]
}

function fmtNgnM(v: number): string {
  return '\u20a6' + (v / 1e6).toFixed(2) + 'M'
}

export default function IdleCashPanel({ loading, data }: Props): ReactElement {
  if (loading) {
    return (
      <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-3)', fontSize: 11 }}>
        Loading idle cash flags…
      </div>
    )
  }
  if (data.length === 0) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)', fontSize: 12, fontStyle: 'italic' }}>
        No portfolios over liquidity max — all cash deployed within target band
      </div>
    )
  }

  return (
    <table className="h-table" style={{ fontSize: 12 }}>
      <thead>
        <tr>
          <th>Portfolio</th>
          <th className="num">Cash %</th>
          <th className="num">Max</th>
          <th className="num">Excess (₦)</th>
        </tr>
      </thead>
      <tbody>
        {data.map(row => (
          <tr key={row.portfolio_id}>
            <td>
              <Link
                href={`/portfolio/${row.portfolio_id}`}
                style={{ textDecoration: 'none', color: 'inherit' }}
              >
                <div style={{ fontWeight: 500 }}>{row.portfolio_name}</div>
                <div style={{ fontSize: 10, color: 'var(--text-3)' }}>{row.client_name}</div>
              </Link>
            </td>
            <td className="num" style={{ fontFamily: 'var(--font-mono)', color: 'var(--warn)' }}>
              {(row.cash_pct * 100).toFixed(1)}%
            </td>
            <td className="num" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-3)' }}>
              {row.liq_max !== null ? (row.liq_max * 100).toFixed(1) + '%' : '—'}
            </td>
            <td className="num num-serif" style={{ color: 'var(--warn)' }}>
              {fmtNgnM(row.excess_ngn)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
