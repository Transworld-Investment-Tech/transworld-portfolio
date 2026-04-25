'use client'

import Link from 'next/link'
import type { ReactElement } from 'react'

// v27 — Stale Reports: portfolios past 100-day quarterly window

interface StaleRow {
  portfolio_id:   string
  portfolio_name: string
  client_name:    string
  last_report_date: string | null
  last_report_type: string | null
  days_overdue:   number
}

interface Props {
  loading: boolean
  data: StaleRow[]
}

function fmtDate(iso: string | null): string {
  if (!iso) return 'never'
  const d = new Date(iso + 'T00:00:00Z')
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
}

export default function StaleReportsPanel({ loading, data }: Props): ReactElement {
  if (loading) {
    return (
      <div style={{ padding: 16, textAlign: 'center', color: 'var(--text-3)', fontSize: 11 }}>
        Loading stale reports…
      </div>
    )
  }
  if (data.length === 0) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)', fontSize: 12, fontStyle: 'italic' }}>
        All mandates have reports within the 100-day window
      </div>
    )
  }

  return (
    <table className="h-table" style={{ fontSize: 12 }}>
      <thead>
        <tr>
          <th>Mandate</th>
          <th>Last report</th>
          <th>Type</th>
          <th className="num">Days overdue</th>
          <th></th>
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
            <td style={{ fontSize: 11, color: 'var(--text-2)' }}>{fmtDate(row.last_report_date)}</td>
            <td style={{ fontSize: 11, color: 'var(--text-3)' }}>
              {row.last_report_type ?? '—'}
            </td>
            <td className="num" style={{ fontFamily: 'var(--font-mono)', color: row.days_overdue > 30 ? 'var(--neg)' : 'var(--warn)' }}>
              +{row.days_overdue}d
            </td>
            <td>
              <Link
                href={`/portfolio/${row.portfolio_id}/reports`}
                style={{
                  fontSize: 11,
                  color: 'var(--gold)',
                  textDecoration: 'none',
                  fontWeight: 500,
                }}
              >
                Run report →
              </Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
