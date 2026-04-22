/**
 * app/admin/broker/[sessionId]/page.tsx — v21b-3a
 *
 * Full detail view for one upload session. Shows:
 *   - KPI tiles: file count, staged rows, audit status, parse status
 *   - Files panel: every broker_file in the session with audit stats
 *   - Staged transactions table with recon_kind filter pills
 *
 * Read-only in v21b-3a. Interactive controls (include_in_commit
 * toggle, commit, rollback) ship in v21b-3b.
 *
 * Inherits Sidebar from app/admin/layout.tsx — this page does NOT
 * render its own (pitfall #38).
 *
 * Next.js 15: params is a Promise — client components unwrap via
 * React.use() on the passed-in promise.
 */

'use client'

import { use, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'

type StagedRow = {
  id: string
  source_file_id: string
  trade_date: string | null
  settlement_date: string | null
  action: string
  instrument_id: string | null
  quantity: number | null
  price: number | null
  gross_value: number | null
  amount: number | null
  fees: number | null
  fee_commission: number | null
  fee_vat: number | null
  fee_contract_stamp: number | null
  fee_exchange: number | null
  fee_clearing: number | null
  fee_sec: number | null
  fee_sms: number | null
  fee_management: number | null
  fee_demat: number | null
  fee_other: number | null
  broker: string | null
  cn_number: string | null
  external_ref: string | null
  narration: string | null
  recon_kind: string
  recon_note: string | null
  dedup_status: string
  include_in_commit: boolean
  notes: string | null
  created_at: string
}

type FileRow = {
  id: string
  kind: 'contract_notes' | 'statement'
  filename: string
  storage_path: string
  size_bytes: number | null
  parse_status: string
  parse_error: string | null
  account_holder: string | null
  cscs_number: string | null
  period_from: string | null
  period_to: string | null
  audit: {
    opening: number | null
    closing: number | null
    computed: number | null
    passes: boolean | null
  } | null
  uploaded_by: string | null
  created_at: string
  parsed_at: string | null
}

type SessionDetail = {
  session: {
    session_id: string
    portfolio: {
      id: string
      name: string
      label: string
      client: { code: string; name: string } | null
    } | null
    upload_time: string
    uploaded_by: string | null
  }
  files: FileRow[]
  staged: StagedRow[]
  summary: {
    file_count: number
    staged_count: number
    by_recon_kind: Record<string, number>
    by_action: Record<string, number>
    all_balanced: boolean
  }
}

const RECON_KIND_ORDER = [
  'matched_exact',
  'matched_split',
  'partial_mismatch',
  'unmatched',
  'cash_event_auto',
  'cash_event_unknown',
]

const RECON_KIND_LABELS: Record<string, string> = {
  matched_exact: 'Matched (exact)',
  matched_split: 'Matched (split)',
  partial_mismatch: 'Partial mismatch',
  unmatched: 'Unmatched',
  cash_event_auto: 'Cash event',
  cash_event_unknown: 'Cash event (?)',
}

function reconKindPillClass(kind: string): string {
  switch (kind) {
    case 'matched_exact':
      return 'pill pill-ok'
    case 'matched_split':
      return 'pill pill-ok'
    case 'partial_mismatch':
      return 'pill pill-warn'
    case 'unmatched':
      return 'pill pill-breach'
    case 'cash_event_auto':
      return 'pill pill-hold'
    case 'cash_event_unknown':
      return 'pill pill-warn'
    default:
      return 'pill'
  }
}

function actionPillClass(action: string): string {
  switch (action) {
    case 'BUY':
      return 'pill pill-buy'
    case 'SELL':
      return 'pill pill-sell'
    case 'FEE':
      return 'pill pill-warn'
    case 'TRANSFER_IN':
      return 'pill pill-ok'
    case 'TRANSFER_OUT':
      return 'pill pill-breach'
    case 'INCOME':
      return 'pill pill-ok'
    default:
      return 'pill'
  }
}

function fmtNum(n: number | null, digits = 2): string {
  if (n === null || n === undefined) return '—'
  return n.toLocaleString('en-GB', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

function fmtNaira(n: number | null): string {
  if (n === null || n === undefined) return '—'
  return `₦${n.toLocaleString('en-GB', { maximumFractionDigits: 2 })}`
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  })
}

function totalFee(row: StagedRow): number | null {
  const parts = [
    row.fee_commission,
    row.fee_vat,
    row.fee_contract_stamp,
    row.fee_exchange,
    row.fee_clearing,
    row.fee_sec,
    row.fee_sms,
    row.fee_management,
    row.fee_demat,
    row.fee_other,
  ]
  const nonNull = parts.filter((p): p is number => p !== null && p !== undefined)
  if (nonNull.length === 0) return row.fees
  return nonNull.reduce((a, b) => a + b, 0)
}

export default function BrokerSessionDetailPage(props: {
  params: Promise<{ sessionId: string }>
}) {
  const { sessionId } = use(props.params)
  const [data, setData] = useState<SessionDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filterKind, setFilterKind] = useState<string | 'all'>('all')

  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const res = await fetch(`/api/broker/sessions/${sessionId}`)
        const j = await res.json()
        if (cancelled) return
        if (!res.ok) {
          setError(j.error || `HTTP ${res.status}`)
          return
        }
        setData(j as SessionDetail)
      } catch (err: any) {
        if (cancelled) return
        setError(err.message || 'Network error')
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [sessionId])

  const filteredStaged = useMemo(() => {
    if (!data) return []
    if (filterKind === 'all') return data.staged
    return data.staged.filter((s) => s.recon_kind === filterKind)
  }, [data, filterKind])

  if (error) {
    return (
      <div className="hybrid-page">
        <div className="page-head">
          <div>
            <div className="eyebrow">
              <Link href="/admin/broker" style={{ color: 'inherit', textDecoration: 'none' }}>
                Admin / Broker files
              </Link>
            </div>
            <h1 className="hybrid-serif">Session not found</h1>
          </div>
        </div>
        <div className="alert-h alert-h-critical">
          <strong>Error.</strong> {error}
        </div>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="hybrid-page">
        <div className="page-head">
          <div>
            <div className="eyebrow">Admin / Broker files</div>
            <h1 className="hybrid-serif">Loading…</h1>
          </div>
        </div>
      </div>
    )
  }

  const auditedStatements = data.files.filter(
    (f) => f.kind === 'statement' && f.audit
  )

  return (
    <div className="hybrid-page">
      <div className="page-head">
        <div>
          <div className="eyebrow">
            <Link
              href="/admin/broker"
              style={{ color: 'inherit', textDecoration: 'none' }}
            >
              Admin / Broker files
            </Link>
          </div>
          <h1 className="hybrid-serif">
            {data.session.portfolio
              ? `${data.session.portfolio.client?.name || 'Portfolio'} — ${data.session.portfolio.name}`
              : 'Upload session'}
          </h1>
          <div
            style={{
              marginTop: 6,
              fontSize: 12,
              color: 'var(--text-3)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            Uploaded {fmtDateTime(data.session.upload_time)}
            {data.session.uploaded_by && ` · by ${data.session.uploaded_by}`}
            {' · '}
            <span style={{ fontFamily: 'monospace', fontSize: 11 }}>
              {data.session.session_id}
            </span>
          </div>
        </div>
      </div>

      {/* KPI row */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          gap: 14,
          marginBottom: 28,
        }}
      >
        <div className="h-kpi">
          <div className="h-kpi-label">Files</div>
          <div className="h-kpi-value">{data.summary.file_count}</div>
          <div className="h-kpi-sub">
            {data.files.filter((f) => f.kind === 'contract_notes').length} CN ·{' '}
            {data.files.filter((f) => f.kind === 'statement').length} statement
          </div>
        </div>
        <div className="h-kpi">
          <div className="h-kpi-label">Staged rows</div>
          <div className="h-kpi-value">
            {data.summary.staged_count.toLocaleString()}
          </div>
          <div className="h-kpi-sub">Read-only preview</div>
        </div>
        <div className="h-kpi">
          <div className="h-kpi-label">Audit</div>
          <div className="h-kpi-value">
            {auditedStatements.length === 0
              ? '—'
              : data.summary.all_balanced
                ? 'Balanced'
                : 'Unbalanced'}
          </div>
          <div className="h-kpi-sub">
            {auditedStatements.length} statement
            {auditedStatements.length === 1 ? '' : 's'} audited
          </div>
        </div>
        <div className="h-kpi">
          <div className="h-kpi-label">Parse status</div>
          <div className="h-kpi-value">
            {data.files.every((f) => f.parse_status === 'parsed')
              ? 'All parsed'
              : 'Mixed'}
          </div>
          <div className="h-kpi-sub">
            {data.files.filter((f) => f.parse_status === 'parse_failed').length}{' '}
            failed
          </div>
        </div>
      </div>

      {/* Files panel */}
      <div className="panel" style={{ marginBottom: 20 }}>
        <div className="panel-header">
          <div className="panel-title">Files in this session</div>
          <div className="panel-meta">
            {data.files.length} file{data.files.length === 1 ? '' : 's'}
          </div>
        </div>
        <table className="h-table">
          <thead>
            <tr>
              <th>Kind</th>
              <th>Filename</th>
              <th>Period</th>
              <th className="num">Opening</th>
              <th className="num">Closing</th>
              <th className="num">Computed</th>
              <th>Audit</th>
              <th>Parse</th>
            </tr>
          </thead>
          <tbody>
            {data.files.map((f) => (
              <tr key={f.id}>
                <td>
                  {f.kind === 'contract_notes' ? (
                    <span className="pill pill-hold">CN</span>
                  ) : (
                    <span className="pill pill-buy">STMT</span>
                  )}
                </td>
                <td>
                  <div style={{ fontSize: 13 }}>{f.filename}</div>
                  {f.account_holder && (
                    <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
                      {f.account_holder}
                      {f.cscs_number && ` · ${f.cscs_number}`}
                    </div>
                  )}
                </td>
                <td style={{ fontSize: 12 }}>
                  {f.period_from || f.period_to ? (
                    <>
                      {fmtDate(f.period_from)} → {fmtDate(f.period_to)}
                    </>
                  ) : (
                    <span style={{ color: 'var(--text-3)' }}>—</span>
                  )}
                </td>
                <td className="num num-serif">
                  {f.audit ? fmtNaira(f.audit.opening) : '—'}
                </td>
                <td className="num num-serif">
                  {f.audit ? fmtNaira(f.audit.closing) : '—'}
                </td>
                <td className="num num-serif">
                  {f.audit ? fmtNaira(f.audit.computed) : '—'}
                </td>
                <td>
                  {f.audit?.passes === true && (
                    <span className="pill pill-ok">Balanced</span>
                  )}
                  {f.audit?.passes === false && (
                    <span className="pill pill-breach">Unbalanced</span>
                  )}
                  {(!f.audit || f.audit.passes === null) && (
                    <span style={{ fontSize: 11, color: 'var(--text-3)' }}>—</span>
                  )}
                </td>
                <td>
                  {f.parse_status === 'parsed' && (
                    <span className="pill pill-ok">Parsed</span>
                  )}
                  {f.parse_status === 'parse_failed' && (
                    <span
                      className="pill pill-breach"
                      title={f.parse_error || 'parse failed'}
                    >
                      Failed
                    </span>
                  )}
                  {f.parse_status === 'pending' && (
                    <span className="pill pill-warn">Pending</span>
                  )}
                  {f.parse_status === 'committed' && (
                    <span className="pill pill-buy">Committed</span>
                  )}
                  {f.parse_status === 'rolled_back' && (
                    <span className="pill pill-hold">Rolled back</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Staged transactions */}
      <div className="panel">
        <div className="panel-header">
          <div className="panel-title">Staged transactions</div>
          <div className="panel-meta">
            {filteredStaged.length.toLocaleString()} of{' '}
            {data.summary.staged_count.toLocaleString()} shown
          </div>
        </div>

        {/* Filter pills */}
        <div
          style={{
            display: 'flex',
            gap: 8,
            marginBottom: 16,
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          <button
            onClick={() => setFilterKind('all')}
            className={filterKind === 'all' ? 'btn-h btn-h-primary' : 'btn-h'}
            style={{ fontSize: 11, padding: '4px 10px' }}
          >
            All ({data.summary.staged_count})
          </button>
          {RECON_KIND_ORDER.filter(
            (k) => (data.summary.by_recon_kind[k] || 0) > 0
          ).map((k) => (
            <button
              key={k}
              onClick={() => setFilterKind(k)}
              className={filterKind === k ? 'btn-h btn-h-primary' : 'btn-h'}
              style={{ fontSize: 11, padding: '4px 10px' }}
            >
              {RECON_KIND_LABELS[k] || k} ({data.summary.by_recon_kind[k] || 0})
            </button>
          ))}
        </div>

        {filteredStaged.length === 0 && (
          <div
            style={{
              padding: '24px 12px',
              textAlign: 'center',
              color: 'var(--text-3)',
              fontSize: 13,
            }}
          >
            No staged rows match this filter.
          </div>
        )}

        {filteredStaged.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <table className="h-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>CN #</th>
                  <th>Action</th>
                  <th>Instrument</th>
                  <th className="num">Qty</th>
                  <th className="num">Price</th>
                  <th className="num">Fees</th>
                  <th className="num">Amount</th>
                  <th>Narration</th>
                  <th>Recon</th>
                </tr>
              </thead>
              <tbody>
                {filteredStaged.map((s) => (
                  <tr key={s.id}>
                    <td style={{ whiteSpace: 'nowrap' }}>{fmtDate(s.trade_date)}</td>
                    <td style={{ fontSize: 11, fontFamily: 'monospace' }}>
                      {s.cn_number ? (
                        s.cn_number.length > 20 ? (
                          <span title={s.cn_number}>
                            {s.cn_number.slice(0, 18)}…
                          </span>
                        ) : (
                          s.cn_number
                        )
                      ) : (
                        <span style={{ color: 'var(--text-3)' }}>—</span>
                      )}
                    </td>
                    <td>
                      <span className={actionPillClass(s.action)}>{s.action}</span>
                    </td>
                    <td style={{ fontSize: 13 }}>
                      {s.instrument_id || (
                        <span style={{ color: 'var(--text-3)' }}>—</span>
                      )}
                    </td>
                    <td className="num num-serif">
                      {s.quantity !== null ? fmtNum(s.quantity, 0) : '—'}
                    </td>
                    <td className="num num-serif">
                      {s.price !== null ? fmtNum(s.price) : '—'}
                    </td>
                    <td className="num num-serif">
                      {fmtNum(totalFee(s))}
                    </td>
                    <td className="num num-serif">
                      {s.amount !== null
                        ? fmtNaira(s.amount)
                        : s.gross_value !== null
                          ? fmtNaira(s.gross_value)
                          : '—'}
                    </td>
                    <td
                      style={{
                        fontSize: 11,
                        color: 'var(--text-2)',
                        maxWidth: 280,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                      title={s.narration || undefined}
                    >
                      {s.narration || '—'}
                    </td>
                    <td>
                      <span
                        className={reconKindPillClass(s.recon_kind)}
                        title={s.recon_note || undefined}
                      >
                        {RECON_KIND_LABELS[s.recon_kind] || s.recon_kind}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
