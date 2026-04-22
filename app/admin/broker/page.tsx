/**
 * app/admin/broker/page.tsx — v21b-3a
 *
 * Broker upload sessions inbox. Lists all upload sessions (groups
 * of broker_files that were uploaded in a single POST) with summary
 * pills for parse status, audit, and staged row count.
 *
 * Read-only in v21b-3a. Interactive commit/rollback ships in
 * v21b-3b.
 *
 * Inherits Sidebar from app/admin/layout.tsx — this page does NOT
 * render its own (pitfall #38).
 */

'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'

type SessionRow = {
  session_id: string
  portfolio: {
    id: string
    name: string
    label: string
    client: { code: string; name: string } | null
  } | null
  upload_time: string
  uploaded_by: string | null
  file_count: number
  kinds: { contract_notes: number; statement: number }
  parse_status: 'all_parsed' | 'mixed' | 'any_failed'
  all_balanced: boolean
  staged_total: number
  has_failed_audit: boolean
}

function formatDateTime(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function BrokerInboxPage() {
  const [sessions, setSessions] = useState<SessionRow[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch('/api/broker/sessions?limit=100')
        const data = await res.json()
        if (cancelled) return
        if (!res.ok) {
          setError(data.error || `HTTP ${res.status}`)
          setSessions([])
          return
        }
        setSessions(data.sessions || [])
      } catch (err: any) {
        if (cancelled) return
        setError(err.message || 'Network error')
        setSessions([])
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  return (
    <div className="hybrid-page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Admin</div>
          <h1 className="hybrid-serif">Broker files</h1>
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <div className="panel-title">Upload sessions</div>
          <div className="panel-meta">
            {sessions === null
              ? 'Loading…'
              : `${sessions.length} session${sessions.length === 1 ? '' : 's'}`}
          </div>
        </div>

        {error && (
          <div className="alert-h alert-h-critical" style={{ marginBottom: 16 }}>
            <strong>Error loading sessions.</strong> {error}
          </div>
        )}

        {sessions !== null && sessions.length === 0 && !error && (
          <div
            style={{
              padding: '32px 12px',
              textAlign: 'center',
              color: 'var(--text-3)',
              fontSize: 13,
            }}
          >
            No broker files have been uploaded yet. Use the{' '}
            <code
              style={{
                fontFamily: 'DM Sans',
                background: 'var(--bg-soft)',
                padding: '1px 6px',
                borderRadius: 3,
                border: '1px solid var(--border-soft)',
              }}
            >
              /api/broker/upload
            </code>{' '}
            endpoint to ingest files.
          </div>
        )}

        {sessions !== null && sessions.length > 0 && (
          <table className="h-table">
            <thead>
              <tr>
                <th>Upload time</th>
                <th>Portfolio</th>
                <th>Files</th>
                <th className="num">Staged rows</th>
                <th>Parse</th>
                <th>Audit</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((s) => (
                <tr key={s.session_id}>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {formatDateTime(s.upload_time)}
                    {s.uploaded_by && (
                      <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
                        by {s.uploaded_by}
                      </div>
                    )}
                  </td>
                  <td>
                    {s.portfolio ? (
                      <>
                        <div style={{ fontSize: 13 }}>
                          {s.portfolio.client?.name || '—'}
                        </div>
                        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
                          {s.portfolio.name}
                        </div>
                      </>
                    ) : (
                      <span style={{ color: 'var(--text-3)' }}>—</span>
                    )}
                  </td>
                  <td>
                    <span style={{ fontSize: 13 }}>{s.file_count}</span>
                    <span style={{ fontSize: 11, color: 'var(--text-3)', marginLeft: 6 }}>
                      ({s.kinds.contract_notes} CN, {s.kinds.statement} stmt)
                    </span>
                  </td>
                  <td className="num num-serif">{s.staged_total.toLocaleString()}</td>
                  <td>
                    {s.parse_status === 'all_parsed' && (
                      <span className="pill pill-ok">Parsed</span>
                    )}
                    {s.parse_status === 'mixed' && (
                      <span className="pill pill-warn">Mixed</span>
                    )}
                    {s.parse_status === 'any_failed' && (
                      <span className="pill pill-breach">Failed</span>
                    )}
                  </td>
                  <td>
                    {s.has_failed_audit ? (
                      <span className="pill pill-breach">Unbalanced</span>
                    ) : s.all_balanced ? (
                      <span className="pill pill-ok">Balanced</span>
                    ) : (
                      <span style={{ fontSize: 11, color: 'var(--text-3)' }}>—</span>
                    )}
                  </td>
                  <td style={{ textAlign: 'right' }}>
                    <Link
                      href={`/admin/broker/${s.session_id}`}
                      className="btn-h"
                      style={{ fontSize: 12, padding: '4px 10px' }}
                    >
                      View
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
