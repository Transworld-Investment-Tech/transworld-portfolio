/**
 * components/admin/CSCSVariancePanel.tsx — v27g
 *
 * Post-commit variance panel rendered on the staging UI when a session
 * contains a parsed canonical_positions file. Shows per-ticker variance
 * between CSCS canonical positions and current portfolio holdings, with
 * checkboxes for selecting which transfers to apply.
 *
 * Buckets:
 *   - cscs_only / top_up_needed → checked by default (auto-apply safe)
 *   - portfolio_only / portfolio_overshoot → unchecked by default (review)
 *   - match / cash_out_of_scope → no action (no checkbox, no apply)
 *
 * On Apply: POSTs to /api/broker/sessions/[id]/apply-reconciliation
 * with the selected rows. The route writes TRANSFER_IN/OUT transactions
 * dated to MAX(market_prices.price_date), rebuilds holdings, and
 * reconstructs NAV. Parent then re-fetches via onApplied callback.
 */

'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  VarianceResult,
  VarianceRow,
  VarianceBucket,
} from '@/lib/variance-engine'
import type { ParsedCSCS } from '@/lib/cscs-parser'

interface Props {
  sessionId: string
  canonical: ParsedCSCS
  variance: VarianceResult
  latestMarketPriceDate: string | null
  onApplied: () => void
}

const BUCKET_LABEL: Record<VarianceBucket, string> = {
  cscs_only:           'CSCS only',
  top_up_needed:       'Top-up',
  portfolio_only:      'Portfolio only',
  portfolio_overshoot: 'Overshoot',
  match:               'Match',
  cash_out_of_scope:   'Cash (out of scope)',
}

function bucketPillClass(b: VarianceBucket): string {
  switch (b) {
    case 'match':               return 'pill pill-ok'
    case 'cscs_only':           return 'pill pill-buy'
    case 'top_up_needed':       return 'pill pill-buy'
    case 'portfolio_only':      return 'pill pill-warn'
    case 'portfolio_overshoot': return 'pill pill-warn'
    case 'cash_out_of_scope':   return 'pill pill-hold'
  }
}

function actionPillClass(action: string | null): string {
  if (action === 'TRANSFER_IN')  return 'pill pill-ok'
  if (action === 'TRANSFER_OUT') return 'pill pill-breach'
  return 'pill'
}

function fmtNum(n: number, digits = 0): string {
  return n.toLocaleString('en-GB', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

function fmtNaira(n: number): string {
  return `₦${n.toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString('en-GB', {
    day: '2-digit', month: 'short', year: 'numeric',
  })
}

// ─── Inline ConfirmButton (4-second pattern, same as staging page) ──
type ConfirmState = 'idle' | 'confirming' | 'running'

function ConfirmButton({
  label, confirmLabel, runningLabel, onConfirm, disabled, disabledHint,
}: {
  label: string
  confirmLabel: string
  runningLabel: string
  onConfirm: () => Promise<void>
  disabled?: boolean
  disabledHint?: string
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

  const bg          = state === 'confirming' ? 'var(--gold)' : undefined
  const color       = state === 'confirming' ? '#fff' : undefined
  const borderColor = state === 'confirming' ? 'transparent' : undefined
  const text        =
    state === 'running'    ? runningLabel    :
    state === 'confirming' ? confirmLabel    :
                             label

  return (
    <button
      className="btn-h btn-h-primary"
      onClick={handleClick}
      disabled={disabled || state === 'running'}
      title={disabled && disabledHint ? disabledHint : undefined}
      style={{
        background:   bg,
        color,
        borderColor,
        opacity:      disabled ? 0.45 : 1,
        cursor:       disabled ? 'not-allowed' : state === 'running' ? 'wait' : 'pointer',
        transition:   'background 0.15s, color 0.15s',
      }}
    >
      {text}
    </button>
  )
}

// ─── Main component ─────────────────────────────────────────────────
export default function CSCSVariancePanel({
  sessionId,
  canonical,
  variance,
  latestMarketPriceDate,
  onApplied,
}: Props) {
  const [filter, setFilter] = useState<VarianceBucket | 'actionable' | 'all'>('actionable')
  const [selected, setSelected] = useState<Record<string, boolean>>(() => {
    const m: Record<string, boolean> = {}
    for (const r of variance.rows) {
      m[r.ticker] = r.autoApply
    }
    return m
  })
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  // Reset selection if variance changes (e.g., after a successful apply + reload)
  useEffect(() => {
    const m: Record<string, boolean> = {}
    for (const r of variance.rows) {
      m[r.ticker] = r.autoApply
    }
    setSelected(m)
  }, [variance])

  function toggle(ticker: string) {
    setSelected(prev => ({ ...prev, [ticker]: !prev[ticker] }))
  }

  const filteredRows = useMemo(() => {
    if (filter === 'all') return variance.rows
    if (filter === 'actionable') {
      return variance.rows.filter(r => r.proposedAction !== null)
    }
    return variance.rows.filter(r => r.bucket === filter)
  }, [filter, variance.rows])

  const selectedRows = variance.rows.filter(
    r => r.proposedAction !== null && selected[r.ticker]
  )

  const canApply = selectedRows.length > 0 && latestMarketPriceDate !== null
  const applyDisabledHint =
    selectedRows.length === 0
      ? 'Select at least one row to apply'
      : !latestMarketPriceDate
        ? 'No market_prices rows found — cannot date transfers'
        : undefined

  async function handleApply() {
    setNotice(null)
    try {
      const transfers = selectedRows.map(r => ({
        ticker:   r.ticker,
        action:   r.proposedAction,
        quantity: Math.abs(r.unitDelta),
        price:    r.proposedPrice,
        reason:   r.bucket,
      }))
      const res = await fetch(
        `/api/broker/sessions/${sessionId}/apply-reconciliation`,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ transfers }),
        }
      )
      const j = await res.json()
      if (!res.ok) {
        setNotice({ kind: 'error', text: j.error || `HTTP ${res.status}` })
        return
      }
      setNotice({
        kind: 'ok',
        text: `Applied ${j.transferred ?? transfers.length} transfer${(j.transferred ?? transfers.length) === 1 ? '' : 's'} dated ${j.date_used ?? latestMarketPriceDate}` +
              (j.nav_reconstruction?.navEntriesAdded > 0
                ? ` · ${j.nav_reconstruction.navEntriesAdded} NAV entries added`
                : ''),
      })
      onApplied()
    } catch (err: any) {
      setNotice({ kind: 'error', text: err.message || 'Network error' })
    }
  }

  // ─── Render ──────────────────────────────────────────────────────
  const s = variance.summary
  const totalActionable = s.totalAutoApply + s.totalReview

  return (
    <div className="panel" style={{ marginBottom: 20 }}>
      <div className="panel-header">
        <div>
          <div className="panel-title">CSCS reconciliation</div>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
            {canonical.accountName || canonical.houseName || 'CSCS account'}
            {canonical.cscsNumber && ` · ${canonical.cscsNumber}`}
            {canonical.balanceDate && ` · canonical as of ${fmtDate(canonical.balanceDate)}`}
          </div>
        </div>
        <div className="panel-meta">
          {totalActionable === 0
            ? `${s.matchCount} matched · 0 actionable`
            : `${s.totalAutoApply} auto · ${s.totalReview} review · ${s.matchCount} matched`}
          {s.cashCount > 0 && ` · ${s.cashCount} cash`}
        </div>
      </div>

      {/* Notice */}
      {notice && (
        <div
          className={notice.kind === 'ok' ? 'alert-h alert-h-info' : 'alert-h alert-h-critical'}
          style={{ marginBottom: 16, position: 'relative', paddingRight: 40 }}
        >
          <div>{notice.text}</div>
          <button
            onClick={() => setNotice(null)}
            aria-label="Dismiss"
            style={{
              position: 'absolute', top: 10, right: 12,
              background: 'transparent', border: 'none', color: 'inherit',
              cursor: 'pointer', fontSize: 16, lineHeight: 1, opacity: 0.6,
            }}
          >
            ×
          </button>
        </div>
      )}

      {/* KPI summary */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(5, 1fr)',
          gap: 10,
          marginBottom: 16,
        }}
      >
        <div className="h-kpi">
          <div className="h-kpi-label">Auto-apply</div>
          <div className="h-kpi-value" style={{ color: 'var(--pos)' }}>
            {s.totalAutoApply}
          </div>
          <div className="h-kpi-sub">
            {s.cscsOnlyCount} CSCS only · {s.topUpCount} top-up
          </div>
        </div>
        <div className="h-kpi">
          <div className="h-kpi-label">Review</div>
          <div className="h-kpi-value" style={{ color: 'var(--warn)' }}>
            {s.totalReview}
          </div>
          <div className="h-kpi-sub">
            {s.portfolioOnlyCount} portfolio only · {s.overshootCount} overshoot
          </div>
        </div>
        <div className="h-kpi">
          <div className="h-kpi-label">Matched</div>
          <div className="h-kpi-value">{s.matchCount}</div>
          <div className="h-kpi-sub">no action</div>
        </div>
        <div className="h-kpi">
          <div className="h-kpi-label">Cash</div>
          <div className="h-kpi-value">{s.cashCount}</div>
          <div className="h-kpi-sub">out of scope</div>
        </div>
        <div className="h-kpi">
          <div className="h-kpi-label">Transfer date</div>
          <div className="h-kpi-value" style={{ fontSize: 14 }}>
            {fmtDate(latestMarketPriceDate)}
          </div>
          <div className="h-kpi-sub">latest market price</div>
        </div>
      </div>

      {/* Filter pills */}
      <div
        style={{
          display: 'flex',
          gap: 8,
          marginBottom: 14,
          flexWrap: 'wrap',
        }}
      >
        <button
          onClick={() => setFilter('actionable')}
          className={filter === 'actionable' ? 'btn-h btn-h-primary' : 'btn-h'}
          style={{ fontSize: 11, padding: '4px 10px' }}
        >
          Actionable ({totalActionable})
        </button>
        <button
          onClick={() => setFilter('all')}
          className={filter === 'all' ? 'btn-h btn-h-primary' : 'btn-h'}
          style={{ fontSize: 11, padding: '4px 10px' }}
        >
          All ({variance.rows.length})
        </button>
        {(
          ['portfolio_only', 'portfolio_overshoot', 'cscs_only', 'top_up_needed', 'match', 'cash_out_of_scope'] as VarianceBucket[]
        )
          .filter(b => variance.rows.some(r => r.bucket === b))
          .map(b => {
            const count = variance.rows.filter(r => r.bucket === b).length
            return (
              <button
                key={b}
                onClick={() => setFilter(b)}
                className={filter === b ? 'btn-h btn-h-primary' : 'btn-h'}
                style={{ fontSize: 11, padding: '4px 10px' }}
              >
                {BUCKET_LABEL[b]} ({count})
              </button>
            )
          })}
      </div>

      {/* Table */}
      {filteredRows.length === 0 ? (
        <div
          style={{
            padding: '24px 12px',
            textAlign: 'center',
            color: 'var(--text-3)',
            fontSize: 13,
          }}
        >
          No rows match this filter.
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="h-table">
            <thead>
              <tr>
                <th style={{ width: 36 }}>
                  <span style={{ fontSize: 10, color: 'var(--text-3)' }} title="Apply this transfer">
                    ✓
                  </span>
                </th>
                <th>Bucket</th>
                <th>Ticker</th>
                <th>Name</th>
                <th className="num">Canonical</th>
                <th className="num">Portfolio</th>
                <th className="num">Δ units</th>
                <th>Action</th>
                <th className="num">Price</th>
                <th className="num">Amount</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((r: VarianceRow) => {
                const isActionable = r.proposedAction !== null
                const isSelected   = selected[r.ticker] || false
                const transferAmount = Math.abs(r.unitDelta) * r.proposedPrice
                return (
                  <tr
                    key={r.ticker}
                    style={{
                      opacity: isActionable ? 1 : 0.55,
                    }}
                  >
                    <td style={{ textAlign: 'center' }}>
                      {isActionable ? (
                        <input
                          type="checkbox"
                          checked={isSelected}
                          onChange={() => toggle(r.ticker)}
                          style={{
                            cursor: 'pointer',
                            accentColor: 'var(--gold)',
                          }}
                          title={
                            isSelected
                              ? 'Selected — click to exclude'
                              : 'Excluded — click to include'
                          }
                        />
                      ) : (
                        <span style={{ fontSize: 10, color: 'var(--text-3)' }}>—</span>
                      )}
                    </td>
                    <td>
                      <span className={bucketPillClass(r.bucket)}>
                        {BUCKET_LABEL[r.bucket]}
                      </span>
                    </td>
                    <td style={{ fontFamily: 'monospace', fontSize: 12 }}>
                      {r.ticker}
                    </td>
                    <td style={{ fontSize: 11, color: 'var(--text-2)' }}>
                      {r.symbolName || '—'}
                    </td>
                    <td className="num num-serif">
                      {fmtNum(r.canonicalUnits)}
                    </td>
                    <td className="num num-serif">
                      {fmtNum(r.portfolioUnits)}
                    </td>
                    <td
                      className="num num-serif"
                      style={{
                        color:
                          r.unitDelta > 0 ? 'var(--pos)' :
                          r.unitDelta < 0 ? 'var(--neg)' :
                                            'var(--text-3)',
                      }}
                    >
                      {r.unitDelta > 0 ? '+' : ''}{fmtNum(r.unitDelta)}
                    </td>
                    <td>
                      {r.proposedAction ? (
                        <span className={actionPillClass(r.proposedAction)}>
                          {r.proposedAction}
                        </span>
                      ) : (
                        <span style={{ fontSize: 10, color: 'var(--text-3)' }}>—</span>
                      )}
                    </td>
                    <td className="num num-serif">
                      {r.proposedPrice > 0 ? fmtNum(r.proposedPrice, 2) : '—'}
                    </td>
                    <td className="num num-serif">
                      {isActionable && transferAmount > 0
                        ? fmtNaira(transferAmount)
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
                      title={r.note || undefined}
                    >
                      {r.note || '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Apply footer */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          paddingTop: 14,
          marginTop: 16,
          borderTop: '1px solid var(--border-soft)',
        }}
      >
        <ConfirmButton
          label={`Apply ${selectedRows.length} transfer${selectedRows.length === 1 ? '' : 's'}`}
          confirmLabel="Click again to apply"
          runningLabel="Applying…"
          onConfirm={handleApply}
          disabled={!canApply}
          disabledHint={applyDisabledHint}
        />
        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
          {selectedRows.length > 0
            ? `Will write ${selectedRows.length} TRANSFER_IN/OUT row${selectedRows.length === 1 ? '' : 's'} dated ${fmtDate(latestMarketPriceDate)}, then rebuild holdings and reconstruct NAV.`
            : 'No rows selected. Tick at least one row above to apply.'}
        </div>
      </div>
    </div>
  )
}
