// v27cb-a-fix5 — Fundamentals editor (interactive client component)
//
// Adds vs v27cb-a-fix2/fix3:
//   • Top "Instrument data" panel above period cards:
//       - editable "Current shares outstanding" (writes to instruments.shares_outstanding)
//       - read-only "Implied shares (PAT × 1M ÷ EPS basic)" cross-check (from latest period)
//       - Saves via POST /api/fundamentals-edit?action=update-shares-current
//   • Each period card gets a new "Share data" group with editable
//     "Shares outstanding" field (per-period, in actual share count)
//   • BVPS moves from Balance Sheet (editable) to Derived block (read-only,
//     auto-computed from total_equity × 1M ÷ shares with fallback to current shares).
//     Displayed unit ₦/share. A small label indicates whether the basis was
//     "per-period" (preferred) or "current-fallback" (when period shares is null).
//   • Auto-sync: when saving the MOST RECENT period with shares set, the
//     server also updates instruments.shares_outstanding. UI shows a small
//     "auto-synced current shares" flash.

'use client'

import Link from 'next/link'
import { useMemo, useState } from 'react'

interface InstrumentInfo {
  instrument_id: string
  name: string
  sector: string | null
  isin: string | null
  type: string
  shares_outstanding: number | null
  shares_outstanding_last_refreshed_at: string | null
}

interface DerivedRatios {
  roe_pct: number | null
  roa_pct: number | null
  net_margin_pct: number | null
  cash_conversion_pct: number | null
  book_value_per_share: number | null
  bvps_basis: 'per_period_shares' | 'current_shares_fallback' | 'no_shares' | 'no_equity'
}

type PeriodRow = {
  id?: string
  instrument_id: string
  period_end: string
  period_type: 'annual' | 'quarterly'
  pdf_source_url?: string | null
  pdf_filename?: string | null
  revenue_ngn_m: number | null
  gross_profit_ngn_m: number | null
  operating_profit_ngn_m: number | null
  profit_before_tax_ngn_m: number | null
  profit_after_tax_ngn_m: number | null
  eps_basic: number | null
  eps_diluted: number | null
  book_value_per_share: number | null
  total_assets_ngn_m: number | null
  total_equity_ngn_m: number | null
  total_debt_ngn_m: number | null
  cash_and_equivalents_ngn_m: number | null
  cash_from_operations_ngn_m: number | null
  shares_outstanding: number | null
  currency: string | null
  source?: string | null
  extraction_notes?: string | null
  verified_status: 'unverified' | 'verified' | 'flagged'
  verified_at?: string | null
  verified_by?: string | null
  operator_notes?: string | null
  derived_ratios?: DerivedRatios
}

interface Props {
  ticker: string
  instrument: InstrumentInfo
  initialPeriods: Array<Record<string, unknown>>
}

const FIELD_GROUPS: Array<{
  group_label: string
  fields: Array<{ key: keyof PeriodRow; label: string; unit: string }>
}> = [
  {
    group_label: 'Income statement',
    fields: [
      { key: 'revenue_ngn_m', label: 'Revenue', unit: '₦M' },
      { key: 'gross_profit_ngn_m', label: 'Gross profit', unit: '₦M' },
      { key: 'operating_profit_ngn_m', label: 'Operating profit', unit: '₦M' },
      { key: 'profit_before_tax_ngn_m', label: 'Profit before tax', unit: '₦M' },
      { key: 'profit_after_tax_ngn_m', label: 'Net income (PAT)', unit: '₦M' },
      { key: 'eps_basic', label: 'EPS basic', unit: '₦' },
      { key: 'eps_diluted', label: 'EPS diluted', unit: '₦' },
    ],
  },
  {
    group_label: 'Balance sheet',
    fields: [
      { key: 'total_assets_ngn_m', label: 'Total assets', unit: '₦M' },
      { key: 'total_equity_ngn_m', label: 'Total equity', unit: '₦M' },
      { key: 'total_debt_ngn_m', label: 'Total debt', unit: '₦M' },
      { key: 'cash_and_equivalents_ngn_m', label: 'Cash & equivalents', unit: '₦M' },
    ],
  },
  {
    group_label: 'Cash flow',
    fields: [{ key: 'cash_from_operations_ngn_m', label: 'Cash from operations', unit: '₦M' }],
  },
  {
    group_label: 'Share data',
    fields: [{ key: 'shares_outstanding', label: 'Shares outstanding', unit: 'shares' }],
  },
]

function fmtRatio(v: number | null): string {
  if (v === null || v === undefined || !isFinite(v)) return '—'
  return `${v.toFixed(2)}%`
}

function fmtCurrency(v: number | null, decimals = 2): string {
  if (v === null || v === undefined || !isFinite(v)) return '—'
  return v.toLocaleString('en-NG', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

function fmtInt(v: number | null): string {
  if (v === null || v === undefined || !isFinite(v)) return '—'
  return Math.round(v).toLocaleString('en-NG')
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return '—'
  const d = new Date(s)
  if (isNaN(d.getTime())) return s
  return d.toISOString().slice(0, 10)
}

function deriveRatios(r: PeriodRow, currentShares: number | null): DerivedRatios {
  const pat = r.profit_after_tax_ngn_m
  const eq = r.total_equity_ngn_m
  const assets = r.total_assets_ngn_m
  const rev = r.revenue_ngn_m
  const cfo = r.cash_from_operations_ngn_m
  const periodShares = r.shares_outstanding

  let bvps: number | null = null
  let basis: DerivedRatios['bvps_basis'] = 'no_equity'
  if (eq === null || eq <= 0) {
    basis = 'no_equity'
  } else if (periodShares !== null && periodShares > 0) {
    bvps = (eq * 1_000_000) / periodShares
    basis = 'per_period_shares'
  } else if (currentShares !== null && currentShares > 0) {
    bvps = (eq * 1_000_000) / currentShares
    basis = 'current_shares_fallback'
  } else {
    basis = 'no_shares'
  }

  return {
    roe_pct: pat !== null && eq !== null && eq > 0 ? (pat / eq) * 100 : null,
    roa_pct: pat !== null && assets !== null && assets > 0 ? (pat / assets) * 100 : null,
    net_margin_pct: pat !== null && rev !== null && rev > 0 ? (pat / rev) * 100 : null,
    cash_conversion_pct: pat !== null && pat !== 0 && cfo !== null ? (cfo / pat) * 100 : null,
    book_value_per_share: bvps,
    bvps_basis: basis,
  }
}

function safeEvalExpression(expr: string): number | null {
  const cleaned = expr.replace(/,/g, '').replace(/\s+/g, '')
  if (!/^[\d+\-*/().]+$/.test(cleaned)) return null
  if (cleaned.length === 0 || cleaned.length > 200) return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
    const fn = new Function(`"use strict"; return (${cleaned})`)
    const v = fn()
    return typeof v === 'number' && isFinite(v) ? v : null
  } catch {
    return null
  }
}

function parseFieldInput(raw: string): number | null {
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed === '-' || trimmed === '—') return null
  if (trimmed.startsWith('=')) {
    return safeEvalExpression(trimmed.slice(1))
  }
  const num = parseFloat(trimmed.replace(/,/g, ''))
  return isFinite(num) ? num : null
}

function normalizePeriod(raw: Record<string, unknown>): PeriodRow {
  const num = (v: unknown): number | null => {
    if (v === null || v === undefined) return null
    const n = typeof v === 'string' ? parseFloat(v) : (v as number)
    return typeof n === 'number' && isFinite(n) ? n : null
  }
  return {
    id: raw.id as string | undefined,
    instrument_id: raw.instrument_id as string,
    period_end: raw.period_end as string,
    period_type: raw.period_type as 'annual' | 'quarterly',
    pdf_source_url: (raw.pdf_source_url as string | null) ?? null,
    pdf_filename: (raw.pdf_filename as string | null) ?? null,
    revenue_ngn_m: num(raw.revenue_ngn_m),
    gross_profit_ngn_m: num(raw.gross_profit_ngn_m),
    operating_profit_ngn_m: num(raw.operating_profit_ngn_m),
    profit_before_tax_ngn_m: num(raw.profit_before_tax_ngn_m),
    profit_after_tax_ngn_m: num(raw.profit_after_tax_ngn_m),
    eps_basic: num(raw.eps_basic),
    eps_diluted: num(raw.eps_diluted),
    book_value_per_share: num(raw.book_value_per_share),
    total_assets_ngn_m: num(raw.total_assets_ngn_m),
    total_equity_ngn_m: num(raw.total_equity_ngn_m),
    total_debt_ngn_m: num(raw.total_debt_ngn_m),
    cash_and_equivalents_ngn_m: num(raw.cash_and_equivalents_ngn_m),
    cash_from_operations_ngn_m: num(raw.cash_from_operations_ngn_m),
    shares_outstanding: num(raw.shares_outstanding),
    currency: (raw.currency as string | null) ?? 'NGN',
    source: (raw.source as string | null) ?? null,
    extraction_notes: (raw.extraction_notes as string | null) ?? null,
    verified_status: ((raw.verified_status as string | undefined) ?? 'unverified') as
      | 'unverified'
      | 'verified'
      | 'flagged',
    verified_at: (raw.verified_at as string | null) ?? null,
    verified_by: (raw.verified_by as string | null) ?? null,
    operator_notes: (raw.operator_notes as string | null) ?? null,
    derived_ratios: (raw.derived_ratios as DerivedRatios | undefined) ?? undefined,
  }
}

export default function InstrumentFundamentalsClient({ ticker, instrument, initialPeriods }: Props) {
  const [periods, setPeriods] = useState<PeriodRow[]>(() => initialPeriods.map(normalizePeriod))
  const [currentShares, setCurrentShares] = useState<number | null>(instrument.shares_outstanding)
  const [currentSharesLastUpdated, setCurrentSharesLastUpdated] = useState<string | null>(
    instrument.shares_outstanding_last_refreshed_at,
  )
  const [currentSharesDraft, setCurrentSharesDraft] = useState<string>('')
  const [busy, setBusy] = useState<Record<string, boolean>>({})
  const [flash, setFlash] = useState<{ key: string; kind: 'ok' | 'err'; msg: string } | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>({})

  const periodKey = (r: PeriodRow) => `${r.period_end}|${r.period_type}`
  const draftKey = (k: string, field: string) => `${k}::${field}`

  // Latest period for implied-shares cross-check (most recent period_end first)
  const latest = periods[0] ?? null
  const impliedShares = useMemo((): { value: number | null; reason: string } => {
    if (!latest) return { value: null, reason: 'no period data' }
    const pat = latest.profit_after_tax_ngn_m
    const eps = latest.eps_basic
    if (pat === null || pat <= 0) return { value: null, reason: 'PAT missing/zero' }
    if (eps === null || eps <= 0) return { value: null, reason: 'EPS basic missing/zero' }
    return { value: (pat * 1_000_000) / eps, reason: 'computed' }
  }, [latest])

  const onDraftChange = (key: string, field: keyof PeriodRow, value: string) => {
    setDrafts((d) => ({ ...d, [draftKey(key, field as string)]: value }))
  }

  const onFieldCommit = (key: string, field: keyof PeriodRow) => {
    const dk = draftKey(key, field as string)
    const raw = drafts[dk]
    if (raw === undefined) return
    const parsed = parseFieldInput(raw)
    setPeriods((prev) =>
      prev.map((r) => {
        if (periodKey(r) !== key) return r
        const next: PeriodRow = { ...r, [field]: parsed }
        next.derived_ratios = deriveRatios(next, currentShares)
        return next
      }),
    )
    setDrafts((d) => {
      const out = { ...d }
      delete out[dk]
      return out
    })
  }

  const updateNotes = (key: string, value: string) => {
    setPeriods((prev) =>
      prev.map((r) => (periodKey(r) !== key ? r : { ...r, operator_notes: value })),
    )
  }

  const callSave = async (key: string, desiredStatus: 'verified' | 'unverified' | 'flagged') => {
    const row = periods.find((r) => periodKey(r) === key)
    if (!row) return
    setBusy((b) => ({ ...b, [key]: true }))
    setFlash(null)
    try {
      const body = { ...row, verified_status: desiredStatus, verified_by: 'operator' }
      const res = await fetch(`/api/fundamentals-edit?ticker=${encodeURIComponent(ticker)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json()
      if (!json.ok) {
        setFlash({ key, kind: 'err', msg: json.error ?? 'save failed' })
      } else {
        const updated = json.row ? normalizePeriod(json.row) : row
        updated.verified_status = desiredStatus
        // Auto-sync: if server synced current shares, reflect in UI
        if (json.auto_synced_current_shares && updated.shares_outstanding !== null) {
          setCurrentShares(updated.shares_outstanding)
          setCurrentSharesLastUpdated(new Date().toISOString())
        }
        // Re-derive with potentially new currentShares
        updated.derived_ratios = deriveRatios(
          updated,
          json.auto_synced_current_shares ? updated.shares_outstanding : currentShares,
        )
        setPeriods((prev) => prev.map((r) => (periodKey(r) !== key ? r : updated)))
        const note = json.auto_synced_current_shares
          ? `Saved · ${desiredStatus} · auto-synced current shares`
          : `Saved · ${desiredStatus}`
        setFlash({ key, kind: 'ok', msg: note })
      }
    } catch (e) {
      setFlash({ key, kind: 'err', msg: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy((b) => ({ ...b, [key]: false }))
    }
  }

  const callReExtract = async (key: string) => {
    const row = periods.find((r) => periodKey(r) === key)
    if (!row) return
    if (
      !confirm(
        'Re-extract from PDF? This will overwrite current values with a fresh Claude extraction (verified rows are protected).',
      )
    ) {
      return
    }
    setBusy((b) => ({ ...b, [key]: true }))
    setFlash(null)
    try {
      const url = `/api/fundamentals-edit?ticker=${encodeURIComponent(ticker)}&action=re-extract&period_end=${encodeURIComponent(
        row.period_end,
      )}&period_type=${encodeURIComponent(row.period_type)}`
      const res = await fetch(url, { method: 'POST' })
      const json = await res.json()
      if (!json.ok) {
        setFlash({ key, kind: 'err', msg: json.error ?? 're-extract failed' })
      } else if (json.row) {
        const updated = normalizePeriod(json.row)
        updated.derived_ratios = deriveRatios(updated, currentShares)
        setPeriods((prev) => prev.map((r) => (periodKey(r) !== key ? r : updated)))
        setFlash({ key, kind: 'ok', msg: 'Re-extracted from PDF · review' })
      }
    } catch (e) {
      setFlash({ key, kind: 'err', msg: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy((b) => ({ ...b, [key]: false }))
    }
  }

  const refreshFromServer = async () => {
    try {
      const res = await fetch(`/api/fundamentals-edit?ticker=${encodeURIComponent(ticker)}`, {
        cache: 'no-store',
      })
      const json = await res.json()
      if (json.ok && Array.isArray(json.periods)) {
        setPeriods(json.periods.map(normalizePeriod))
        setCurrentShares(json.instrument?.shares_outstanding ?? null)
        setCurrentSharesLastUpdated(json.instrument?.shares_outstanding_last_refreshed_at ?? null)
        setDrafts({})
        setCurrentSharesDraft('')
        setFlash({ key: '_global', kind: 'ok', msg: 'Refreshed from server' })
      }
    } catch (e) {
      setFlash({ key: '_global', kind: 'err', msg: e instanceof Error ? e.message : String(e) })
    }
  }

  const onCurrentSharesCommit = async () => {
    const raw = currentSharesDraft
    if (raw.trim() === '') return
    const parsed = parseFieldInput(raw)
    if (parsed === null || parsed <= 0) {
      setFlash({ key: '_current_shares', kind: 'err', msg: 'must be a positive number' })
      return
    }
    setBusy((b) => ({ ...b, _current_shares: true }))
    setFlash(null)
    try {
      const res = await fetch(
        `/api/fundamentals-edit?ticker=${encodeURIComponent(ticker)}&action=update-shares-current`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ shares_outstanding: parsed }),
        },
      )
      const json = await res.json()
      if (!json.ok) {
        setFlash({ key: '_current_shares', kind: 'err', msg: json.error ?? 'update failed' })
      } else {
        setCurrentShares(parsed)
        setCurrentSharesLastUpdated(new Date().toISOString())
        setCurrentSharesDraft('')
        // Re-derive all periods with new current shares
        setPeriods((prev) =>
          prev.map((r) => {
            const next = { ...r }
            next.derived_ratios = deriveRatios(next, parsed)
            return next
          }),
        )
        setFlash({ key: '_current_shares', kind: 'ok', msg: `Updated · ${fmtInt(parsed)} shares` })
      }
    } catch (e) {
      setFlash({ key: '_current_shares', kind: 'err', msg: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy((b) => ({ ...b, _current_shares: false }))
    }
  }

  const counts = useMemo(() => {
    let verified = 0,
      unverified = 0,
      flagged = 0
    for (const p of periods) {
      if (p.verified_status === 'verified') verified++
      else if (p.verified_status === 'flagged') flagged++
      else unverified++
    }
    return { verified, unverified, flagged, total: periods.length }
  }, [periods])

  const currentSharesDisplay =
    currentSharesDraft !== '' ? currentSharesDraft : currentShares !== null ? String(currentShares) : ''
  const currentSharesIsFormula = currentSharesDisplay.trim().startsWith('=')

  return (
    <div style={{ padding: '32px 44px 64px', maxWidth: 1400 }}>
      {/* Crumb */}
      <div style={{ marginBottom: 12 }}>
        <Link
          href={`/instrument/${ticker}`}
          style={{
            fontSize: 10,
            letterSpacing: '0.18em',
            color: 'var(--gold, #b08b3e)',
            fontWeight: 600,
            textTransform: 'uppercase',
            textDecoration: 'none',
          }}
        >
          ← Back to {ticker}
        </Link>
      </div>

      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          justifyContent: 'space-between',
          paddingBottom: 22,
          marginBottom: 24,
          borderBottom: '1px solid var(--border, rgba(15,41,71,0.12))',
        }}
      >
        <div>
          <div
            style={{
              fontSize: 10,
              letterSpacing: '0.18em',
              color: 'var(--gold, #b08b3e)',
              fontWeight: 600,
              textTransform: 'uppercase',
              marginBottom: 10,
            }}
          >
            Fundamentals editor
          </div>
          <h1
            style={{
              fontFamily: '"Cormorant Garamond", Georgia, serif',
              fontWeight: 500,
              fontSize: 36,
              letterSpacing: '-0.005em',
              lineHeight: 1,
              color: 'var(--text)',
              marginBottom: 6,
            }}
          >
            {ticker}
          </h1>
          <div style={{ fontSize: 13, color: 'var(--text-2, #5c6573)' }}>
            {instrument.name}
            {instrument.sector ? ` · ${instrument.sector}` : ''}
            {instrument.isin ? ` · ${instrument.isin}` : ''}
          </div>
          <div
            style={{
              fontSize: 11,
              color: 'var(--text-3, #8a8f9a)',
              marginTop: 6,
              fontStyle: 'italic',
            }}
          >
            Tip: type <code style={{ fontFamily: 'ui-monospace, monospace' }}>=989630+2402362</code>{' '}
            in any field to compute on blur.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <div style={{ fontSize: 12, color: 'var(--text-2, #5c6573)' }}>
            <span style={{ fontWeight: 600, color: 'var(--pos, #2d6e4e)' }}>{counts.verified}</span>{' '}
            verified ·{' '}
            <span style={{ fontWeight: 600, color: 'var(--text-3, #8a8f9a)' }}>{counts.unverified}</span>{' '}
            unverified
            {counts.flagged > 0 ? (
              <>
                {' '}
                · <span style={{ fontWeight: 600, color: 'var(--warn, #a67c2a)' }}>{counts.flagged}</span>{' '}
                flagged
              </>
            ) : null}{' '}
            · {counts.total} total
          </div>
          <button
            onClick={refreshFromServer}
            style={{
              padding: '8px 14px',
              fontSize: 12,
              fontWeight: 500,
              border: '1px solid var(--border-strong, rgba(15,41,71,0.22))',
              background: 'transparent',
              color: 'var(--text)',
              borderRadius: 3,
              cursor: 'pointer',
            }}
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Instrument data panel (NEW in v27cb-a-fix5) */}
      <div
        style={{
          background: 'var(--card, #fffbf2)',
          border: '1px solid var(--border, rgba(15,41,71,0.12))',
          borderRadius: 5,
          padding: '18px 22px',
          marginBottom: 24,
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 20,
        }}
      >
        <div>
          <div
            style={{
              fontSize: 9,
              letterSpacing: '0.18em',
              color: 'var(--text-3)',
              textTransform: 'uppercase',
              fontWeight: 600,
              marginBottom: 6,
            }}
          >
            Instrument data · current shares outstanding
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <input
              type="text"
              value={currentSharesDisplay}
              onChange={(e) => setCurrentSharesDraft(e.target.value)}
              onBlur={() => { /* don't auto-commit on blur for this field; explicit save */ }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  ;(e.currentTarget as HTMLInputElement).blur()
                  void onCurrentSharesCommit()
                }
              }}
              style={{
                flex: 1,
                padding: '6px 8px',
                fontSize: 13,
                fontFamily: currentSharesIsFormula
                  ? 'ui-monospace, "SF Mono", Menlo, monospace'
                  : '"Cormorant Garamond", Georgia, serif',
                fontVariantNumeric: 'tabular-nums',
                border: currentSharesIsFormula
                  ? '1px solid var(--gold, #b08b3e)'
                  : '1px solid var(--border, rgba(15,41,71,0.12))',
                borderRadius: 3,
                background: '#fff',
                color: 'var(--text)',
                textAlign: 'right',
              }}
              placeholder="54,375,796,458"
            />
            <button
              onClick={() => void onCurrentSharesCommit()}
              disabled={busy._current_shares === true || currentSharesDraft === ''}
              style={{
                padding: '6px 12px',
                fontSize: 11,
                letterSpacing: '0.10em',
                textTransform: 'uppercase',
                fontWeight: 600,
                background: 'var(--sidebar-bg, #0a1f3a)',
                color: 'var(--gold-bright, #c9a556)',
                border: '1px solid var(--sidebar-bg)',
                borderRadius: 3,
                cursor: 'pointer',
                opacity: busy._current_shares === true || currentSharesDraft === '' ? 0.5 : 1,
              }}
            >
              Save
            </button>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-2)' }}>
            Current: <strong style={{ fontFamily: '"Cormorant Garamond", Georgia, serif', fontWeight: 500, fontSize: 14 }}>{fmtInt(currentShares)}</strong>
            {currentSharesLastUpdated ? (
              <span style={{ color: 'var(--text-3)', fontSize: 10, marginLeft: 8 }}>
                · last set {fmtDate(currentSharesLastUpdated)}
              </span>
            ) : null}
          </div>
          {flash && flash.key === '_current_shares' ? (
            <div
              style={{
                marginTop: 8,
                padding: '6px 10px',
                fontSize: 11,
                background: flash.kind === 'ok' ? 'rgba(45,110,78,0.08)' : 'rgba(166,59,59,0.08)',
                border: `1px solid ${flash.kind === 'ok' ? 'rgba(45,110,78,0.3)' : 'rgba(166,59,59,0.3)'}`,
                borderRadius: 3,
                color: flash.kind === 'ok' ? 'var(--pos)' : 'var(--neg)',
              }}
            >
              {flash.msg}
            </div>
          ) : null}
        </div>
        <div>
          <div
            style={{
              fontSize: 9,
              letterSpacing: '0.18em',
              color: 'var(--text-3)',
              textTransform: 'uppercase',
              fontWeight: 600,
              marginBottom: 6,
            }}
          >
            Implied shares cross-check (PAT × 1M ÷ EPS basic)
          </div>
          <div
            style={{
              fontFamily: '"Cormorant Garamond", Georgia, serif',
              fontSize: 18,
              fontWeight: 500,
              color: 'var(--text)',
            }}
          >
            {fmtInt(impliedShares.value)}
            <span style={{ fontSize: 10, color: 'var(--text-3)', marginLeft: 8, fontFamily: 'inherit' }}>
              from latest period
            </span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4, fontStyle: 'italic' }}>
            {impliedShares.reason === 'computed'
              ? 'Use this to sanity-check the current shares outstanding above.'
              : `Cannot compute (${impliedShares.reason}).`}
          </div>
        </div>
      </div>

      {/* Global flash */}
      {flash && flash.key === '_global' ? (
        <div
          style={{
            padding: '10px 14px',
            background: flash.kind === 'ok' ? 'rgba(45,110,78,0.08)' : 'rgba(166,59,59,0.08)',
            border: `1px solid ${flash.kind === 'ok' ? 'rgba(45,110,78,0.3)' : 'rgba(166,59,59,0.3)'}`,
            borderRadius: 3,
            fontSize: 12,
            color: flash.kind === 'ok' ? 'var(--pos)' : 'var(--neg)',
            marginBottom: 16,
          }}
        >
          {flash.msg}
        </div>
      ) : null}

      {periods.length === 0 ? (
        <div
          style={{
            padding: '40px 32px',
            background: 'var(--card, #fffbf2)',
            border: '1px solid var(--border, rgba(15,41,71,0.12))',
            borderRadius: 5,
            textAlign: 'center',
            color: 'var(--text-2)',
            fontSize: 13,
          }}
        >
          No fundamentals data for {ticker} yet. Run:
          <code
            style={{
              display: 'inline-block',
              marginTop: 12,
              padding: '6px 10px',
              background: 'var(--bg-soft, #faf5ea)',
              fontSize: 12,
              fontFamily: 'ui-monospace, monospace',
              borderRadius: 3,
            }}
          >
            curl -X POST &apos;/api/fundamentals/refresh-ngx?ticker={ticker}&apos;
          </code>
        </div>
      ) : null}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))',
          gap: 16,
        }}
      >
        {periods.map((row) => {
          const key = periodKey(row)
          const isVerified = row.verified_status === 'verified'
          const isBusy = busy[key] === true
          const ratios = row.derived_ratios ?? deriveRatios(row, currentShares)
          const localFlash = flash && flash.key === key ? flash : null

          return (
            <div
              key={key}
              style={{
                background: 'var(--card, #fffbf2)',
                border: '1px solid var(--border, rgba(15,41,71,0.12))',
                borderRadius: 5,
                padding: '20px 22px',
                opacity: isBusy ? 0.6 : 1,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'baseline',
                  paddingBottom: 12,
                  marginBottom: 14,
                  borderBottom: '1px solid var(--border-soft, rgba(15,41,71,0.06))',
                }}
              >
                <div>
                  <div
                    style={{
                      fontFamily: '"Cormorant Garamond", Georgia, serif',
                      fontStyle: 'italic',
                      fontSize: 17,
                      fontWeight: 500,
                      color: 'var(--text)',
                    }}
                  >
                    {fmtDate(row.period_end)}
                  </div>
                  <div
                    style={{
                      fontSize: 10,
                      letterSpacing: '0.14em',
                      color: 'var(--text-3, #8a8f9a)',
                      textTransform: 'uppercase',
                      fontWeight: 600,
                      marginTop: 2,
                    }}
                  >
                    {row.period_type}
                  </div>
                </div>
                <StatusPill status={row.verified_status} />
              </div>

              <div
                style={{
                  fontSize: 11,
                  color: 'var(--text-2, #5c6573)',
                  marginBottom: 12,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                }}
              >
                {row.pdf_source_url ? (
                  <a
                    href={row.pdf_source_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{
                      color: 'var(--gold, #b08b3e)',
                      textDecoration: 'none',
                      fontWeight: 500,
                      lineHeight: 1.4,
                    }}
                  >
                    📄 {row.pdf_filename ?? 'Source PDF'} →
                  </a>
                ) : (
                  <span style={{ color: 'var(--text-3)' }}>No PDF source linked</span>
                )}
                <button
                  onClick={() => callReExtract(key)}
                  disabled={isBusy || isVerified}
                  style={{
                    alignSelf: 'flex-start',
                    padding: '4px 10px',
                    fontSize: 10,
                    letterSpacing: '0.10em',
                    textTransform: 'uppercase',
                    fontWeight: 600,
                    border: '1px solid var(--border-strong, rgba(15,41,71,0.22))',
                    background: 'transparent',
                    color: isVerified ? 'var(--text-3)' : 'var(--text)',
                    borderRadius: 3,
                    cursor: isBusy || isVerified ? 'not-allowed' : 'pointer',
                  }}
                  title={isVerified ? 'Unverify the row first' : 'Re-run Claude extraction on this PDF'}
                >
                  Re-extract from PDF
                </button>
              </div>

              {FIELD_GROUPS.map((g) => (
                <div key={g.group_label} style={{ marginBottom: 14 }}>
                  <div
                    style={{
                      fontSize: 9,
                      letterSpacing: '0.18em',
                      color: 'var(--text-3)',
                      textTransform: 'uppercase',
                      fontWeight: 600,
                      marginBottom: 6,
                    }}
                  >
                    {g.group_label}
                  </div>
                  {g.fields.map((f) => {
                    const v = row[f.key]
                    const dk = draftKey(key, f.key as string)
                    const draftVal = drafts[dk]
                    const display =
                      draftVal !== undefined
                        ? draftVal
                        : v === null || v === undefined
                          ? ''
                          : String(v)
                    const isFormula = display.trim().startsWith('=')
                    return (
                      <div
                        key={f.key as string}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          padding: '5px 0',
                          gap: 8,
                        }}
                      >
                        <div
                          style={{
                            flex: '0 0 160px',
                            fontSize: 12,
                            color: 'var(--text-2, #5c6573)',
                          }}
                        >
                          {f.label}
                        </div>
                        <input
                          type="text"
                          value={display}
                          disabled={isVerified || isBusy}
                          onChange={(e) => onDraftChange(key, f.key, e.target.value)}
                          onBlur={() => onFieldCommit(key, f.key)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              ;(e.currentTarget as HTMLInputElement).blur()
                            }
                          }}
                          style={{
                            flex: 1,
                            padding: '4px 8px',
                            fontSize: 13,
                            fontFamily: isFormula
                              ? 'ui-monospace, "SF Mono", Menlo, monospace'
                              : '"Cormorant Garamond", Georgia, serif',
                            fontVariantNumeric: 'tabular-nums',
                            border: isFormula
                              ? '1px solid var(--gold, #b08b3e)'
                              : '1px solid var(--border, rgba(15,41,71,0.12))',
                            borderRadius: 3,
                            background: isVerified ? 'var(--bg-soft, #faf5ea)' : '#fff',
                            color: 'var(--text)',
                            textAlign: 'right',
                          }}
                          placeholder="—"
                        />
                        <div
                          style={{
                            flex: '0 0 36px',
                            fontSize: 10,
                            color: 'var(--text-3)',
                            letterSpacing: '0.06em',
                          }}
                        >
                          {f.unit}
                        </div>
                      </div>
                    )
                  })}
                </div>
              ))}

              <div style={{ marginBottom: 14 }}>
                <div
                  style={{
                    fontSize: 9,
                    letterSpacing: '0.18em',
                    color: 'var(--text-3)',
                    textTransform: 'uppercase',
                    fontWeight: 600,
                    marginBottom: 6,
                  }}
                >
                  Derived (auto from inputs)
                </div>
                {[
                  { label: 'ROE', value: ratios.roe_pct, fmt: 'pct' as const },
                  { label: 'ROA', value: ratios.roa_pct, fmt: 'pct' as const },
                  { label: 'Net margin', value: ratios.net_margin_pct, fmt: 'pct' as const },
                  { label: 'Cash conversion', value: ratios.cash_conversion_pct, fmt: 'pct' as const },
                  {
                    label: 'Book value / share',
                    value: ratios.book_value_per_share,
                    fmt: 'currency' as const,
                    suffix:
                      ratios.bvps_basis === 'current_shares_fallback'
                        ? ' (current shares)'
                        : ratios.bvps_basis === 'per_period_shares'
                          ? ''
                          : '',
                  },
                ].map((r) => (
                  <div
                    key={r.label}
                    style={{ display: 'flex', padding: '4px 0', gap: 8, alignItems: 'center' }}
                  >
                    <div style={{ flex: '0 0 160px', fontSize: 12, color: 'var(--text-2)' }}>
                      {r.label}
                      {('suffix' in r && r.suffix) ? (
                        <span style={{ fontSize: 9, color: 'var(--text-3)', fontStyle: 'italic', marginLeft: 4 }}>
                          {r.suffix}
                        </span>
                      ) : null}
                    </div>
                    <div
                      style={{
                        flex: 1,
                        textAlign: 'right',
                        fontSize: 13,
                        fontFamily: '"Cormorant Garamond", Georgia, serif',
                        fontVariantNumeric: 'tabular-nums',
                        color: 'var(--text)',
                      }}
                    >
                      {r.fmt === 'pct' ? fmtRatio(r.value) : r.value !== null ? `₦${fmtCurrency(r.value, 2)}` : '—'}
                    </div>
                    <div style={{ flex: '0 0 36px' }} />
                  </div>
                ))}
              </div>

              {row.extraction_notes ? (
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--text-3)',
                    fontStyle: 'italic',
                    background: 'var(--bg-soft, #faf5ea)',
                    padding: '8px 10px',
                    borderRadius: 3,
                    borderLeft: '2px solid var(--gold-soft, rgba(176,139,62,0.5))',
                    marginBottom: 12,
                    lineHeight: 1.4,
                  }}
                >
                  <strong style={{ letterSpacing: '0.10em', fontStyle: 'normal' }}>AI NOTES:</strong>{' '}
                  {row.extraction_notes}
                </div>
              ) : null}

              <div style={{ marginBottom: 12 }}>
                <div
                  style={{
                    fontSize: 9,
                    letterSpacing: '0.18em',
                    color: 'var(--text-3)',
                    textTransform: 'uppercase',
                    fontWeight: 600,
                    marginBottom: 4,
                  }}
                >
                  Operator notes
                </div>
                <textarea
                  rows={2}
                  value={row.operator_notes ?? ''}
                  disabled={isBusy}
                  onChange={(e) => updateNotes(key, e.target.value)}
                  style={{
                    width: '100%',
                    padding: '6px 8px',
                    fontSize: 12,
                    fontFamily: 'inherit',
                    border: '1px solid var(--border, rgba(15,41,71,0.12))',
                    borderRadius: 3,
                    background: '#fff',
                    color: 'var(--text)',
                    resize: 'vertical',
                  }}
                  placeholder="e.g. share count change from rights issue — adjusted manually"
                />
              </div>

              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {isVerified ? (
                  <button
                    onClick={() => callSave(key, 'unverified')}
                    disabled={isBusy}
                    style={{
                      padding: '6px 12px',
                      fontSize: 11,
                      letterSpacing: '0.10em',
                      textTransform: 'uppercase',
                      fontWeight: 600,
                      border: '1px solid var(--border-strong)',
                      background: 'transparent',
                      color: 'var(--text)',
                      borderRadius: 3,
                      cursor: 'pointer',
                    }}
                  >
                    Unverify to edit
                  </button>
                ) : (
                  <>
                    <button
                      onClick={() => callSave(key, 'verified')}
                      disabled={isBusy}
                      style={{
                        padding: '6px 12px',
                        fontSize: 11,
                        letterSpacing: '0.10em',
                        textTransform: 'uppercase',
                        fontWeight: 600,
                        background: 'var(--sidebar-bg, #0a1f3a)',
                        color: 'var(--gold-bright, #c9a556)',
                        border: '1px solid var(--sidebar-bg)',
                        borderRadius: 3,
                        cursor: 'pointer',
                      }}
                    >
                      Save & verify
                    </button>
                    <button
                      onClick={() => callSave(key, 'unverified')}
                      disabled={isBusy}
                      style={{
                        padding: '6px 12px',
                        fontSize: 11,
                        letterSpacing: '0.10em',
                        textTransform: 'uppercase',
                        fontWeight: 600,
                        border: '1px solid var(--border-strong)',
                        background: 'transparent',
                        color: 'var(--text)',
                        borderRadius: 3,
                        cursor: 'pointer',
                      }}
                    >
                      Save draft
                    </button>
                    <button
                      onClick={() => callSave(key, 'flagged')}
                      disabled={isBusy}
                      style={{
                        padding: '6px 12px',
                        fontSize: 11,
                        letterSpacing: '0.10em',
                        textTransform: 'uppercase',
                        fontWeight: 600,
                        border: '1px solid rgba(166,124,42,0.3)',
                        background: 'rgba(166,124,42,0.08)',
                        color: 'var(--warn, #a67c2a)',
                        borderRadius: 3,
                        cursor: 'pointer',
                      }}
                    >
                      Flag
                    </button>
                  </>
                )}
              </div>

              {localFlash ? (
                <div
                  style={{
                    marginTop: 10,
                    padding: '6px 10px',
                    fontSize: 11,
                    background: localFlash.kind === 'ok' ? 'rgba(45,110,78,0.08)' : 'rgba(166,59,59,0.08)',
                    border: `1px solid ${localFlash.kind === 'ok' ? 'rgba(45,110,78,0.3)' : 'rgba(166,59,59,0.3)'}`,
                    borderRadius: 3,
                    color: localFlash.kind === 'ok' ? 'var(--pos)' : 'var(--neg)',
                  }}
                >
                  {localFlash.msg}
                </div>
              ) : null}

              {row.verified_at ? (
                <div
                  style={{
                    marginTop: 8,
                    fontSize: 10,
                    letterSpacing: '0.08em',
                    color: 'var(--text-3)',
                    textTransform: 'uppercase',
                  }}
                >
                  Verified {fmtDate(row.verified_at)}
                  {row.verified_by ? ` · ${row.verified_by}` : ''}
                </div>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function StatusPill({ status }: { status: 'unverified' | 'verified' | 'flagged' }) {
  const styles =
    status === 'verified'
      ? { bg: 'rgba(45,110,78,0.12)', color: 'var(--pos, #2d6e4e)' }
      : status === 'flagged'
        ? { bg: 'rgba(166,124,42,0.14)', color: 'var(--warn, #a67c2a)' }
        : { bg: 'rgba(15,41,71,0.06)', color: 'var(--text-3, #8a8f9a)' }
  return (
    <span
      style={{
        padding: '3px 9px',
        borderRadius: 2,
        fontSize: 9,
        letterSpacing: '0.14em',
        fontWeight: 600,
        textTransform: 'uppercase',
        background: styles.bg,
        color: styles.color,
      }}
    >
      {status}
    </span>
  )
}
