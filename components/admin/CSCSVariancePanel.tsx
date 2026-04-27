/**
 * components/admin/CSCSVariancePanel.tsx — v27q-fix5
 *
 * v27q-fix5: reactive PRICE + AMOUNT columns + Force-Zero toggle.
 *
 * (1) chosenPrice now derives from VarianceRow.availablePrices
 *     (added in v27q-fix5 lib/variance-engine.ts), looked up by the
 *     row's currently-selected date. Recomputes on date change.
 *
 * (2) New per-row Force-Zero checkbox alongside the date picker.
 *     When checked, the row writes a TRANSFER at price=0, amount=0
 *     regardless of market_prices for the picked date. The picker
 *     date is still recorded as trade_date, capturing when the
 *     corporate action occurred. Use case: license revocation,
 *     share consolidation phantom-unit retirement.
 *
 * (3) Apply payload includes forceZero per row. Server tags
 *     external_ref distinctly so the retired-shares report can
 *     surface zero-recovery vs delisting writeoffs separately.
 *
 * v27p baseline:
 * v27p change: per-row date picker for held-orphan transfers.
 *
 * For each actionable row, operator picks a transfer date from a
 * <select> populated with that ticker's available market_prices dates
 * (passed in via VarianceRow.availablePriceDates from the variance
 * engine). Server re-resolves the price from market_prices for the
 * chosen (ticker, date) pair on apply — the panel's amount column is
 * a UI estimate only.
 *
 * Smart default: VarianceRow.suggestedTransferDate is preselected.
 *   - cscs_only         → portfolio.start_date (held orphan default)
 *   - top_up_needed     → latest priced date
 *   - portfolio_only    → latest priced date
 *   - portfolio_overshoot → latest priced date
 *
 * If a row has no available price dates (rare — would mean the ticker
 * has zero entries in market_prices), the row is non-actionable and the
 * checkbox is disabled.
 *
 * v27g baseline preserved otherwise (filters, KPI summary, ConfirmButton).
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
  latestMarketPriceDate: string | null     // backward-compat fallback for display only
  portfolioStartDate: string | null        // v27p
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

// ─── Inline ConfirmButton ─────────────────────────────────────
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
  portfolioStartDate,
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
  // v27p: per-row date selection. Initialized from suggestedTransferDate.
  const [transferDates, setTransferDates] = useState<Record<string, string>>(() => {
    const m: Record<string, string> = {}
    for (const r of variance.rows) {
      if (r.suggestedTransferDate) m[r.ticker] = r.suggestedTransferDate
    }
    return m
  })
  // v27q-fix5: per-row force-zero toggle (corporate-action zero-recovery writeoff)
  const [forceZero, setForceZero] = useState<Record<string, boolean>>({})
  const [notice, setNotice] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null)

  // Reset selection + dates if variance changes
  useEffect(() => {
    const sel: Record<string, boolean> = {}
    const dts: Record<string, string>  = {}
    for (const r of variance.rows) {
      sel[r.ticker] = r.autoApply
      if (r.suggestedTransferDate) dts[r.ticker] = r.suggestedTransferDate
    }
    setSelected(sel)
    setTransferDates(dts)
  }, [variance])

  function toggle(ticker: string) {
    setSelected(prev => ({ ...prev, [ticker]: !prev[ticker] }))
  }

  function setDate(ticker: string, date: string) {
    setTransferDates(prev => ({ ...prev, [ticker]: date }))
  }

  // v27q-fix5: toggle force-zero (price=0) for a row
  function toggleForceZero(ticker: string) {
    setForceZero(prev => ({ ...prev, [ticker]: !prev[ticker] }))
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

  // v27p: validate every selected row has both a ticker AND a chosen date
  const selectedRowsWithDates = selectedRows.filter(r => transferDates[r.ticker])
  const selectedRowsMissingDate = selectedRows.filter(r => !transferDates[r.ticker])

  // v27p: rows where the ticker has zero priced dates can never be applied
  const unpriceableSelected = selectedRows.filter(r => r.availablePriceDates.length === 0)

  const canApply =
    selectedRows.length > 0 &&
    selectedRowsMissingDate.length === 0 &&
    unpriceableSelected.length === 0

  const applyDisabledHint =
    selectedRows.length === 0
      ? 'Select at least one row to apply'
      : unpriceableSelected.length > 0
        ? `${unpriceableSelected.length} selected row${unpriceableSelected.length === 1 ? '' : 's'} have no market price history — cannot apply`
        : selectedRowsMissingDate.length > 0
          ? `${selectedRowsMissingDate.length} selected row${selectedRowsMissingDate.length === 1 ? '' : 's'} need a transfer date`
          : undefined

  async function handleApply() {
    setNotice(null)
    try {
      // v27q-fix5: include transferDate AND forceZero per row
      const transfers = selectedRowsWithDates.map(r => ({
        ticker:       r.ticker,
        action:       r.proposedAction,
        quantity:     Math.abs(r.unitDelta),
        transferDate: transferDates[r.ticker],
        reason:       r.bucket,
        forceZero:    forceZero[r.ticker] === true,
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
        // v27p: surface per-row missing-price errors structurally
        if (Array.isArray(j.missing_price_dates) && j.missing_price_dates.length > 0) {
          const detail = j.missing_price_dates
            .slice(0, 3)
            .map((p: any) => `${p.ticker}@${p.date}`)
            .join(', ')
          setNotice({
            kind: 'error',
            text: `${j.error} ${detail}${j.missing_price_dates.length > 3 ? '…' : ''}`,
          })
          return
        }
        setNotice({ kind: 'error', text: j.error || `HTTP ${res.status}` })
        return
      }
      setNotice({
        kind: 'ok',
        text: `Applied ${j.transferred ?? transfers.length} transfer${(j.transferred ?? transfers.length) === 1 ? '' : 's'}` +
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
            {portfolioStartDate && ` · portfolio start ${fmtDate(portfolioStartDate)}`}
          </div>
        </div>
        <div className="panel-meta">
          {totalActionable === 0
            ? `${s.matchCount} matched · 0 actionable`
            : `${s.totalAutoApply} auto · ${s.totalReview} review · ${s.matchCount} matched`}
          {s.cashCount > 0 && ` · ${s.cashCount} cash`}
        </div>
      </div>

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
          <div className="h-kpi-label">Date picker</div>
          <div className="h-kpi-value" style={{ fontSize: 14 }}>
            per row
          </div>
          <div className="h-kpi-sub">priced dates only</div>
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
                <th>Transfer date</th>
                <th style={{ textAlign: 'center' }}>₦0</th>
                <th className="num">Price</th>
                <th className="num">Amount</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((r: VarianceRow) => {
                const isActionable    = r.proposedAction !== null
                const isSelected      = selected[r.ticker] || false
                const chosenDate      = transferDates[r.ticker] || ''
                const isForceZero     = forceZero[r.ticker] === true
                // v27q-fix5: reactive price lookup from availablePrices
                const matchedPrice    = chosenDate
                  ? (r.availablePrices.find(p => p.date === chosenDate)?.price ?? 0)
                  : (r.availablePrices.length > 0
                      ? r.availablePrices[r.availablePrices.length - 1].price
                      : r.proposedPrice)
                const chosenPrice     = isForceZero ? 0 : matchedPrice
                const transferAmount  = Math.abs(r.unitDelta) * chosenPrice
                const hasPricedDates  = r.availablePriceDates.length > 0
                const cantApply       = isActionable && !hasPricedDates
                return (
                  <tr
                    key={r.ticker}
                    style={{
                      opacity: isActionable ? (cantApply ? 0.6 : 1) : 0.55,
                    }}
                  >
                    <td style={{ textAlign: 'center' }}>
                      {isActionable && hasPricedDates ? (
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
                        <span
                          style={{ fontSize: 10, color: 'var(--text-3)' }}
                          title={cantApply ? 'No market_prices history for this ticker' : undefined}
                        >
                          —
                        </span>
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
                    {/* v27p: per-row date picker */}
                    <td>
                      {isActionable && hasPricedDates ? (
                        <select
                          className="select-h"
                          value={chosenDate}
                          onChange={(e) => setDate(r.ticker, e.target.value)}
                          style={{
                            fontSize: 11,
                            padding: '2px 6px',
                            minWidth: 130,
                            fontFamily: 'monospace',
                          }}
                          title={`${r.availablePriceDates.length} priced dates available for ${r.ticker}`}
                        >
                          {r.availablePriceDates.map(d => (
                            <option key={d} value={d}>{d}</option>
                          ))}
                        </select>
                      ) : isActionable ? (
                        <span style={{ fontSize: 11, color: 'var(--neg)' }} title="No market_prices entries for this ticker">
                          no priced dates
                        </span>
                      ) : (
                        <span style={{ fontSize: 10, color: 'var(--text-3)' }}>—</span>
                      )}
                    </td>
                    {/* v27q-fix5: Force-Zero toggle */}
                    <td style={{ textAlign: 'center' }}>
                      {isActionable && r.proposedAction === 'TRANSFER_OUT' ? (
                        <input
                          type="checkbox"
                          checked={isForceZero}
                          onChange={() => toggleForceZero(r.ticker)}
                          style={{
                            cursor: 'pointer',
                            accentColor: 'var(--neg)',
                          }}
                          title="Force write at price=0 (corporate action with no recovery, e.g. license revocation, consolidation phantom retirement)"
                        />
                      ) : (
                        <span style={{ fontSize: 10, color: 'var(--text-3)' }}>—</span>
                      )}
                    </td>
                    <td className="num num-serif">
                      {isForceZero
                        ? <span style={{ color: 'var(--neg)', fontWeight: 600 }}>0.00</span>
                        : (chosenPrice > 0 ? fmtNum(chosenPrice, 2) : '—')}
                    </td>
                    <td className="num num-serif">
                      {isForceZero
                        ? <span style={{ color: 'var(--neg)', fontWeight: 600 }}>₦0.00</span>
                        : (isActionable && transferAmount > 0
                            ? fmtNaira(transferAmount)
                            : '—')}
                    </td>
                    <td
                      style={{
                        fontSize: 11,
                        color: 'var(--text-2)',
                        maxWidth: 240,
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
            ? `Will write ${selectedRows.length} TRANSFER row${selectedRows.length === 1 ? '' : 's'}, each dated per the picker above. Server resolves price from market_prices for the chosen (ticker, date). Then rebuild holdings and reconstruct NAV.`
            : 'No rows selected. Tick at least one row above to apply.'}
        </div>
      </div>
    </div>
  )
}
