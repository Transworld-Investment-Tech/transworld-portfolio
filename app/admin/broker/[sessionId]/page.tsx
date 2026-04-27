/**
 * app/admin/broker/[sessionId]/page.tsx — v27p
 *
 * v27p change: commit gate releases on parse_warning and audit_warning.
 *
 * The previous gate (v27g) was strict on parse_failed and treated it as
 * a binary block. v27p separates three concerns:
 *
 *   - parse_failed   → blocks commit (truly no usable rows)
 *   - parse_warning  → banner only, commit enabled (header metadata
 *                       missing but rows extracted; e.g. CN with no CSCS
 *                       number but 290+ trades)
 *   - audit_warning  → banner only, commit enabled (statement closing
 *                       balance off; operator can deselect affected
 *                       rows and commit the rest)
 *
 * The CSCSVariancePanel now also receives portfolioStartDate to power
 * the smart-default for cscs_only (held-orphan) date pickers.
 *
 * Inherits Sidebar from app/admin/layout.tsx (pitfall #38).
 */

'use client'

import { use, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import CSCSVariancePanel from '@/components/admin/CSCSVariancePanel'
import type { ParsedCSCS } from '@/lib/cscs-parser'
import type { VarianceResult } from '@/lib/variance-engine'

type StagedRow = {
  id: string
  broker_file_id: string
  trade_date: string | null
  settlement_date: string | null
  action: string
  instrument_id: string | null
  quantity: number | null
  price: number | null
  gross_value: number | null
  amount: number | null
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
  cn_number: string | null
  external_ref: string | null
  narration: string | null
  recon_kind: string
  recon_note: string | null
  dedup_status: string
  include_in_commit: boolean
  created_at: string
}

type FileRow = {
  id: string
  kind: 'contract_notes' | 'statement' | 'canonical_positions'
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

type CanonicalSection = {
  brokerFileId: string
  filename: string
  parsed: ParsedCSCS | null
  variance: VarianceResult | null
  latestMarketPriceDate: string | null
  portfolioStartDate: string | null
  error?: string
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
    status: 'parsed' | 'committed' | 'rolled_back' | 'parse_failed' | 'mixed'
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
  canonical?: CanonicalSection | null
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
    case 'BUY':           return 'pill pill-buy'
    case 'SELL':          return 'pill pill-sell'
    case 'FEE':           return 'pill pill-warn'
    case 'TRANSFER_IN':   return 'pill pill-ok'
    case 'TRANSFER_OUT':  return 'pill pill-breach'
    case 'INCOME':        return 'pill pill-ok'
    default:              return 'pill'
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
  if (nonNull.length === 0) return null
  return nonNull.reduce((a, b) => a + b, 0)
}

// ─── Inline confirm button ──────────────────────────────────────
type ConfirmState = 'idle' | 'confirming' | 'running'

function ConfirmButton({
  label,
  confirmLabel,
  runningLabel,
  onConfirm,
  disabled,
  disabledHint,
  variant = 'primary',
}: {
  label: string
  confirmLabel: string
  runningLabel: string
  onConfirm: () => Promise<void>
  disabled?: boolean
  disabledHint?: string
  variant?: 'primary' | 'secondary' | 'danger'
}) {
  const [state, setState] = useState<ConfirmState>('idle')
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  function handleClick() {
    if (disabled || state === 'running') return
    if (state === 'idle') {
      setState('confirming')
      timerRef.current = setTimeout(() => setState('idle'), 4000)
      return
    }
    if (state === 'confirming') {
      if (timerRef.current) clearTimeout(timerRef.current)
      setState('running')
      onConfirm().finally(() => setState('idle'))
    }
  }

  const baseClass =
    variant === 'primary'
      ? 'btn-h btn-h-primary'
      : 'btn-h'

  const bg =
    state === 'confirming'
      ? variant === 'danger'
        ? 'var(--neg)'
        : 'var(--gold)'
      : undefined
  const color = state === 'confirming' ? '#fff' : undefined
  const borderColor = state === 'confirming' ? 'transparent' : undefined

  const text =
    state === 'running' ? runningLabel : state === 'confirming' ? confirmLabel : label

  return (
    <button
      className={baseClass}
      onClick={handleClick}
      disabled={disabled || state === 'running'}
      title={disabled && disabledHint ? disabledHint : undefined}
      style={{
        background: bg,
        color,
        borderColor,
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? 'not-allowed' : state === 'running' ? 'wait' : 'pointer',
        transition: 'background 0.15s, color 0.15s',
      }}
    >
      {text}
    </button>
  )
}

type Notice =
  | { kind: 'ok'; text: string }
  | { kind: 'error'; text: string; missingInstruments?: string[]; hint?: string }

export default function BrokerSessionDetailPage(props: {
  params: Promise<{ sessionId: string }>
}) {
  const { sessionId } = use(props.params)
  const [data, setData] = useState<SessionDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filterKind, setFilterKind] = useState<string | 'all'>('all')
  const [notice, setNotice] = useState<Notice | null>(null)

  async function load() {
    try {
      const res = await fetch(`/api/broker/sessions/${sessionId}`, {
        cache: 'no-store',
      })
      const j = await res.json()
      if (!res.ok) {
        setError(j.error || `HTTP ${res.status}`)
        return
      }
      setData(j as SessionDetail)
      setError(null)
    } catch (err: any) {
      setError(err.message || 'Network error')
    }
  }

  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId])

  const filteredStaged = useMemo(() => {
    if (!data) return []
    if (filterKind === 'all') return data.staged
    return data.staged.filter((s) => s.recon_kind === filterKind)
  }, [data, filterKind])

  async function toggleRow(rowId: string, next: boolean) {
    if (!data) return
    const snapshot = data.staged
    setData({
      ...data,
      staged: data.staged.map((s) =>
        s.id === rowId ? { ...s, include_in_commit: next } : s
      ),
    })
    try {
      const res = await fetch(`/api/broker/staged/${rowId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ include_in_commit: next }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error || `HTTP ${res.status}`)
      }
    } catch (err: any) {
      setData((prev) => (prev ? { ...prev, staged: snapshot } : prev))
      setNotice({ kind: 'error', text: `Toggle failed: ${err.message}` })
      setTimeout(() => setNotice(null), 6000)
    }
  }

  async function handleCommit() {
    setNotice(null)
    try {
      const res = await fetch(`/api/broker/sessions/${sessionId}/commit`, {
        method: 'POST',
      })
      const j = await res.json()
      if (!res.ok) {
        if (Array.isArray(j.missing_instruments) && j.missing_instruments.length > 0) {
          setNotice({
            kind: 'error',
            text: j.error || 'Commit blocked — missing instruments',
            missingInstruments: j.missing_instruments,
            hint: j.hint,
          })
          return
        }
        setNotice({ kind: 'error', text: j.error || `HTTP ${res.status}` })
        setTimeout(() => setNotice(null), 8000)
        return
      }
      setNotice({
        kind: 'ok',
        text: `Committed ${j.committed} transaction${j.committed === 1 ? '' : 's'}${
          j.skipped > 0 ? ` · ${j.skipped} skipped` : ''
        }${
          j.nav_reconstruction?.navEntriesAdded > 0
            ? ` · ${j.nav_reconstruction.navEntriesAdded} NAV entries added`
            : ''
        }${
          j.recovery_synthesis?.applied && j.recovery_synthesis?.inserted > 0
            ? ` · ${j.recovery_synthesis.inserted} recovery synth row${j.recovery_synthesis.inserted === 1 ? '' : 's'} (₦${j.recovery_synthesis.totalAmount?.toLocaleString?.() ?? '?'})`
            : ''
        }`,
      })
      await load()
      setTimeout(() => setNotice(null), 10000)
    } catch (err: any) {
      setNotice({ kind: 'error', text: err.message || 'Network error' })
      setTimeout(() => setNotice(null), 8000)
    }
  }

  async function handleRollback() {
    setNotice(null)
    try {
      const res = await fetch(`/api/broker/sessions/${sessionId}/rollback`, {
        method: 'POST',
      })
      const j = await res.json()
      if (!res.ok) {
        setNotice({ kind: 'error', text: j.error || `HTTP ${res.status}` })
        setTimeout(() => setNotice(null), 8000)
        return
      }
      setNotice({
        kind: 'ok',
        text: `Rolled back — ${j.transactions_deleted} transaction${j.transactions_deleted === 1 ? '' : 's'} deleted`,
      })
      await load()
      setTimeout(() => setNotice(null), 6000)
    } catch (err: any) {
      setNotice({ kind: 'error', text: err.message || 'Network error' })
      setTimeout(() => setNotice(null), 8000)
    }
  }

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

  const sessionStatus = data.session.status

  // v27p: gate strict on 'parse_failed' only. parse_warning and audit_warning
  // are non-blocking (banners only).
  const anyTradeParseFailed = data.files.some(
    (f) => f.kind !== 'canonical_positions' && f.parse_status === 'parse_failed'
  )

  // v27p: surface parse_warning and audit_warning files for banner display
  const tradeFilesWithWarnings = data.files.filter(
    (f) => f.kind !== 'canonical_positions' &&
           (f.parse_status === 'parse_warning' || f.parse_status === 'audit_warning')
  )
  const auditWarningFiles = tradeFilesWithWarnings.filter(f => f.parse_status === 'audit_warning')
  const parseWarningFiles = tradeFilesWithWarnings.filter(f => f.parse_status === 'parse_warning')

  const isCommitted = sessionStatus === 'committed'
  const canCommit =
    !isCommitted &&
    !anyTradeParseFailed &&
    data.summary.staged_count > 0 &&
    data.staged.some((s) => s.include_in_commit)
  const canRollback = isCommitted

  const commitDisabledHint = isCommitted
    ? 'Already committed — rollback first to re-commit'
    : anyTradeParseFailed
      ? 'At least one trade file failed to parse with no usable rows — fix the upload before committing'
      : data.summary.staged_count === 0
        ? 'No staged rows to commit'
        : !data.staged.some((s) => s.include_in_commit)
          ? 'No rows are marked for commit'
          : undefined

  const rollbackDisabledHint = !isCommitted
    ? 'Nothing to roll back — session is not committed'
    : undefined

  const includedCount = data.staged.filter((s) => s.include_in_commit).length

  const canonicalSection = data.canonical
  const showVariancePanel =
    isCommitted &&
    canonicalSection &&
    canonicalSection.parsed &&
    canonicalSection.variance &&
    !canonicalSection.error

  return (
    <div className="hybrid-page">
      <div
        className="page-head"
        style={{ alignItems: 'flex-end', gap: 16 }}
      >
        <div style={{ flex: 1 }}>
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
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          <ConfirmButton
            label="Roll back"
            confirmLabel="Click again to roll back"
            runningLabel="Rolling back…"
            onConfirm={handleRollback}
            disabled={!canRollback}
            disabledHint={rollbackDisabledHint}
            variant="danger"
          />
          <ConfirmButton
            label={`Commit ${includedCount || ''} to transactions`.trim()}
            confirmLabel="Click again to commit"
            runningLabel="Committing…"
            onConfirm={handleCommit}
            disabled={!canCommit}
            disabledHint={commitDisabledHint}
            variant="primary"
          />
        </div>
      </div>

      {notice && (
        <div
          className={
            notice.kind === 'ok'
              ? 'alert-h alert-h-info'
              : 'alert-h alert-h-critical'
          }
          style={{
            marginBottom: 20,
            position: 'relative',
            paddingRight: notice.kind === 'error' ? 40 : undefined,
          }}
        >
          <div>{notice.text}</div>

          {notice.kind === 'error' && notice.missingInstruments && notice.missingInstruments.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 11, fontWeight: 600, marginBottom: 6, color: 'var(--text-2)' }}>
                Missing tickers:
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {notice.missingInstruments.map((t) => (
                  <span
                    key={t}
                    className="pill pill-breach"
                    style={{ fontFamily: 'monospace' }}
                  >
                    {t}
                  </span>
                ))}
              </div>
              {notice.hint && (
                <div style={{ fontSize: 11, marginTop: 8, color: 'var(--text-2)', fontStyle: 'italic' }}>
                  {notice.hint}
                </div>
              )}
            </div>
          )}

          {notice.kind === 'error' && (
            <button
              onClick={() => setNotice(null)}
              aria-label="Dismiss"
              style={{
                position: 'absolute',
                top: 10,
                right: 12,
                background: 'transparent',
                border: 'none',
                color: 'inherit',
                cursor: 'pointer',
                fontSize: 16,
                lineHeight: 1,
                opacity: 0.6,
              }}
            >
              ×
            </button>
          )}
        </div>
      )}

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
            {data.files.filter((f) => f.kind === 'canonical_positions').length > 0 &&
              ` · ${data.files.filter((f) => f.kind === 'canonical_positions').length} canon`}
          </div>
        </div>
        <div className="h-kpi">
          <div className="h-kpi-label">Staged rows</div>
          <div className="h-kpi-value">
            {data.summary.staged_count.toLocaleString()}
          </div>
          <div className="h-kpi-sub">
            {includedCount.toLocaleString()} marked for commit
          </div>
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
          <div className="h-kpi-label">Status</div>
          <div className="h-kpi-value" style={{ textTransform: 'capitalize' }}>
            {sessionStatus.replace('_', ' ')}
          </div>
          <div className="h-kpi-sub">
            {isCommitted
              ? 'Transactions live'
              : anyTradeParseFailed
                ? 'Parse errors — review'
                : tradeFilesWithWarnings.length > 0
                  ? 'Warnings — review and commit'
                  : 'Preview only'}
          </div>
        </div>
      </div>

      {/* v27p: audit_warning banner — non-blocking */}
      {!isCommitted && auditWarningFiles.length > 0 && (
        <div className="alert-h alert-h-warn" style={{ marginBottom: 20 }}>
          <strong>Statement audit imbalance.</strong>{' '}
          {auditWarningFiles.length === 1
            ? `${auditWarningFiles[0].filename}'s computed closing balance does not match its asserted closing balance.`
            : `${auditWarningFiles.length} statement files have computed closing balances that do not match their asserted closing balance.`
          }{' '}
          Trade rows extracted successfully — commit is enabled. Review the affected file(s) below; if the diff
          is from missing transactions you can deselect the closest related staged rows, commit the rest,
          and add corrections later.
        </div>
      )}

      {/* v27p: parse_warning banner — informational */}
      {!isCommitted && parseWarningFiles.length > 0 && (
        <div className="alert-h alert-h-info" style={{ marginBottom: 20 }}>
          <strong>Header metadata incomplete.</strong>{' '}
          {parseWarningFiles.length === 1
            ? `${parseWarningFiles[0].filename}: ${parseWarningFiles[0].parse_error}`
            : `${parseWarningFiles.length} files have weak header extraction (account holder or CSCS number missing).`
          }{' '}
          Trade rows extracted normally — this is informational only and does not block commit.
        </div>
      )}

      {/* legacy unbalanced warning kept for compat with audit_passes=false but parse_status=parsed */}
      {auditedStatements.length > 0 && !data.summary.all_balanced && auditWarningFiles.length === 0 && (
        <div className="alert-h alert-h-warn" style={{ marginBottom: 20 }}>
          <strong>Audit unbalanced.</strong> At least one statement's computed
          closing balance does not match its asserted closing balance. Review
          the Files panel below before committing.
        </div>
      )}

      {/* canonical present but errored */}
      {isCommitted && canonicalSection && canonicalSection.error && (
        <div className="alert-h alert-h-warn" style={{ marginBottom: 20 }}>
          <strong>Canonical reconciliation unavailable.</strong> {canonicalSection.error}
        </div>
      )}

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
                  ) : f.kind === 'statement' ? (
                    <span className="pill pill-buy">STMT</span>
                  ) : f.kind === 'canonical_positions' ? (
                    <span
                      className="pill"
                      style={{
                        background: 'rgba(166,124,42,0.15)',
                        color: 'var(--gold)',
                        borderColor: 'rgba(166,124,42,0.35)',
                      }}
                    >
                      CANON
                    </span>
                  ) : (
                    <span className="pill">{f.kind}</span>
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
                  {f.parse_status === 'parse_warning' && (
                    <span
                      className="pill pill-warn"
                      title={f.parse_error || 'parse warning'}
                    >
                      Warning
                    </span>
                  )}
                  {f.parse_status === 'audit_warning' && (
                    <span
                      className="pill pill-warn"
                      title={f.parse_error || 'audit imbalance'}
                    >
                      Audit warn
                    </span>
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

      {/* CSCS variance panel — post-commit only */}
      {showVariancePanel && (
        <CSCSVariancePanel
          sessionId={sessionId}
          canonical={canonicalSection!.parsed!}
          variance={canonicalSection!.variance!}
          latestMarketPriceDate={canonicalSection!.latestMarketPriceDate}
          portfolioStartDate={canonicalSection!.portfolioStartDate}
          onApplied={load}
        />
      )}

      {/* Staged transactions */}
      <div className="panel">
        <div className="panel-header">
          <div className="panel-title">Staged transactions</div>
          <div className="panel-meta">
            {filteredStaged.length.toLocaleString()} of{' '}
            {data.summary.staged_count.toLocaleString()} shown
            {isCommitted && ' · read-only (committed)'}
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
                  <th style={{ width: 36 }}>
                    <span
                      style={{ fontSize: 10, color: 'var(--text-3)' }}
                      title="Include in commit"
                    >
                      ✓
                    </span>
                  </th>
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
                  <tr
                    key={s.id}
                    style={{
                      opacity: s.include_in_commit ? 1 : 0.55,
                    }}
                  >
                    <td style={{ textAlign: 'center' }}>
                      <input
                        type="checkbox"
                        checked={s.include_in_commit}
                        disabled={isCommitted}
                        onChange={(e) => toggleRow(s.id, e.target.checked)}
                        style={{
                          cursor: isCommitted ? 'not-allowed' : 'pointer',
                          accentColor: 'var(--gold)',
                        }}
                        title={
                          isCommitted
                            ? 'Session already committed'
                            : s.include_in_commit
                              ? 'Included — click to exclude'
                              : 'Excluded — click to include'
                        }
                      />
                    </td>
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
                    <td className="num num-serif">{fmtNum(totalFee(s))}</td>
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
