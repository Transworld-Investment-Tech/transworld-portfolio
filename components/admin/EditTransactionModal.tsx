'use client'

// ============================================================
// EditTransactionModal — v27v: Transaction CRUD UI
// ============================================================
// Full-edit modal for any transaction row. All operator-editable fields
// surfaced; UI greys out fields that don't apply to the chosen action.
//
// Features per v27v scope (Scope B):
//   - All 25+ editable fields exposed (action, dates, instrument, qty,
//     price, amount, all 9 fee buckets, broker meta, notes, etc.)
//   - Auto-diff audit trail (built server-side from request body)
//   - Optional reason textarea
//   - external_ref preservation + warning banner for synth/corp-action rows
//   - Per-action validation (greyed fields when not applicable)
//   - "Lookup market price" button on TRANSFER_IN price field
//     (defense-in-depth for v27w, pulls from market_prices for the date)
//   - Sign convention: amount always coerced positive on save
//   - Delete button with second confirmation step
//
// Design conventions matched to existing transactions page:
//   - hybrid-page styling (panel, btn-h, input-h, select-h, alert-h)
//   - FormField wrapper component
//   - var(--gold), var(--neg), var(--warn), var(--text-2) etc.
// ============================================================

import { useState, useMemo, useEffect } from 'react'
import { supabase } from '@/lib/supabase'
import { X, AlertTriangle, Trash2, Search, Loader2 } from 'lucide-react'

type AnyTxn = Record<string, any>

interface Instrument {
  instrument_id: string
  name: string
  type?: string
  sleeve_id?: string
}

interface Props {
  transaction: AnyTxn          // The row being edited
  instruments: Instrument[]    // Passed from parent (Scope B option A)
  onClose: () => void
  onSaved: () => void          // Parent refreshes txns list after save
  onDeleted: () => void        // Parent refreshes txns list after delete
}

// Which fields apply to which action. Ungreyed = applicable.
const FIELD_RELEVANCE: Record<string, Set<string>> = {
  BUY:           new Set(['instrument_id', 'quantity', 'price', 'gross_value', 'fees',
                          'fee_commission', 'fee_vat', 'fee_exchange', 'fee_clearing',
                          'fee_sec', 'fee_contract_stamp', 'fee_sms',
                          'cn_number', 'settlement_date', 'broker', 'counterparty', 'notes']),
  SELL:          new Set(['instrument_id', 'quantity', 'price', 'gross_value', 'fees',
                          'fee_commission', 'fee_vat', 'fee_exchange', 'fee_clearing',
                          'fee_sec', 'fee_contract_stamp', 'fee_sms',
                          'cn_number', 'settlement_date', 'broker', 'counterparty', 'notes']),
  INCOME:        new Set(['instrument_id', 'amount', 'income_category', 'broker', 'notes']),
  FEE:           new Set(['amount', 'fees', 'fee_management', 'fee_demat', 'fee_other',
                          'broker', 'notes']),
  TRANSFER_IN:   new Set(['instrument_id', 'quantity', 'price', 'amount',
                          'broker', 'counterparty', 'notes', 'external_ref']),
  TRANSFER_OUT:  new Set(['instrument_id', 'quantity', 'price', 'amount',
                          'broker', 'counterparty', 'notes', 'external_ref']),
}

const ACTIONS = ['BUY', 'SELL', 'INCOME', 'FEE', 'TRANSFER_IN', 'TRANSFER_OUT']

function isMachineGenerated(externalRef: string | null | undefined): { yes: boolean; kind: string | null } {
  if (!externalRef) return { yes: false, kind: null }
  if (externalRef.startsWith('synthetic-recovery-')) return { yes: true, kind: 'recovery synthesis' }
  if (externalRef.startsWith('corp-action-zero-recovery-')) return { yes: true, kind: 'corp action (zero recovery)' }
  if (externalRef.startsWith('corp-action-delisting-')) return { yes: true, kind: 'corp action (delisting)' }
  return { yes: false, kind: null }
}

// Format value for input field display.
function fmtForInput(v: any): string {
  if (v === null || v === undefined) return ''
  return String(v)
}

export default function EditTransactionModal({ transaction, instruments, onClose, onSaved, onDeleted }: Props) {
  // Local form state. Initialised from the transaction row.
  const [form, setForm] = useState<AnyTxn>(() => ({
    trade_date:         transaction.trade_date ?? '',
    action:             transaction.action ?? 'BUY',
    instrument_id:      transaction.instrument_id ?? '',
    quantity:           fmtForInput(transaction.quantity),
    price:              fmtForInput(transaction.price),
    gross_value:        fmtForInput(transaction.gross_value),
    amount:             fmtForInput(transaction.amount),
    fees:               fmtForInput(transaction.fees),
    fee_commission:     fmtForInput(transaction.fee_commission),
    fee_vat:            fmtForInput(transaction.fee_vat),
    fee_exchange:       fmtForInput(transaction.fee_exchange),
    fee_clearing:       fmtForInput(transaction.fee_clearing),
    fee_sec:            fmtForInput(transaction.fee_sec),
    fee_contract_stamp: fmtForInput(transaction.fee_contract_stamp),
    fee_sms:            fmtForInput(transaction.fee_sms),
    fee_management:     fmtForInput(transaction.fee_management),
    fee_demat:          fmtForInput(transaction.fee_demat),
    fee_other:          fmtForInput(transaction.fee_other),
    cn_number:          transaction.cn_number ?? '',
    settlement_date:    transaction.settlement_date ?? '',
    external_ref:       transaction.external_ref ?? '',
    broker:             transaction.broker ?? '',
    counterparty:       transaction.counterparty ?? '',
    notes:              transaction.notes ?? '',
    income_category:    transaction.income_category ?? '',
    maturity_date:      transaction.maturity_date ?? '',
  }))
  const [reason,    setReason]    = useState('')
  const [saving,    setSaving]    = useState(false)
  const [deleting,  setDeleting]  = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [err,       setErr]       = useState<string | null>(null)
  const [successMsg, setSuccessMsg] = useState<string | null>(null)
  const [priceLookup, setPriceLookup] = useState<{ loading: boolean; result: string | null }>({ loading: false, result: null })

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  const machineGen = useMemo(() => isMachineGenerated(transaction.external_ref), [transaction.external_ref])
  const relevant = FIELD_RELEVANCE[form.action] ?? new Set()
  const isFieldRelevant = (key: string) => relevant.has(key)

  // Live gross-value preview for BUY/SELL.
  const grossPreview = useMemo(() => {
    if (!['BUY', 'SELL'].includes(form.action)) return null
    const q = Number(form.quantity); const p = Number(form.price)
    if (!Number.isFinite(q) || !Number.isFinite(p) || q === 0 || p === 0) return null
    return q * p
  }, [form.action, form.quantity, form.price])

  // ─── Lookup market price for TRANSFER_IN (v27w prep) ──────────
  async function lookupMarketPrice() {
    if (!form.instrument_id || !form.trade_date) {
      setPriceLookup({ loading: false, result: 'Set instrument and trade date first' })
      return
    }
    setPriceLookup({ loading: true, result: null })
    try {
      // Try exact date first.
      const { data: exact } = await supabase
        .from('market_prices')
        .select('price, price_date')
        .eq('instrument_id', form.instrument_id)
        .eq('price_date', form.trade_date)
        .maybeSingle()
      if (exact?.price != null) {
        setForm(f => ({ ...f, price: String(exact.price) }))
        setPriceLookup({ loading: false, result: `Found exact match: ₦${Number(exact.price).toLocaleString()} on ${exact.price_date}` })
        return
      }
      // Fallback: nearest date <= trade_date.
      const { data: near } = await supabase
        .from('market_prices')
        .select('price, price_date')
        .eq('instrument_id', form.instrument_id)
        .lte('price_date', form.trade_date)
        .order('price_date', { ascending: false })
        .limit(1)
      if (near && near.length > 0 && near[0].price != null) {
        setForm(f => ({ ...f, price: String(near[0].price) }))
        setPriceLookup({ loading: false, result: `Used nearest prior: ₦${Number(near[0].price).toLocaleString()} on ${near[0].price_date}` })
        return
      }
      setPriceLookup({ loading: false, result: 'No market price found for this instrument' })
    } catch (e: any) {
      setPriceLookup({ loading: false, result: `Error: ${e.message || 'unknown'}` })
    }
  }

  // ─── Save ──────────────────────────────────────────────────────
  async function handleSave() {
    setErr(null)
    setSuccessMsg(null)
    setSaving(true)

    // Build updates from form. Only send fields that differ from original.
    const updates: AnyTxn = {}
    const fieldsToSync = [
      'trade_date', 'action', 'instrument_id', 'quantity', 'price',
      'gross_value', 'amount', 'fees',
      'fee_commission', 'fee_vat', 'fee_exchange', 'fee_clearing',
      'fee_sec', 'fee_contract_stamp', 'fee_sms',
      'fee_management', 'fee_demat', 'fee_other',
      'cn_number', 'settlement_date', 'external_ref',
      'broker', 'counterparty', 'notes',
      'income_category', 'maturity_date',
    ]
    for (const k of fieldsToSync) {
      // Always send — server-side diff filters no-ops.
      updates[k] = form[k]
    }

    try {
      const { data: user } = await supabase.auth.getUser()
      const res = await fetch(`/api/admin/transactions/${transaction.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          updates,
          reason: reason || null,
          user_id: user.user?.id ?? null,
        }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) {
        setErr(json.error || `HTTP ${res.status}`)
        setSaving(false)
        return
      }
      setSuccessMsg(
        `Saved. Holdings rebuilt (upserted ${json.holdings_rebuild?.upserted ?? 0}, deleted ${json.holdings_rebuild?.deleted ?? 0}). NAV reconstruct running in background.`
      )
      // Briefly show success, then close + refresh.
      setTimeout(() => {
        onSaved()
        onClose()
      }, 1200)
    } catch (e: any) {
      setErr(e.message || 'unknown error')
      setSaving(false)
    }
  }

  // ─── Delete ────────────────────────────────────────────────────
  async function handleDelete() {
    if (!confirmDel) {
      setConfirmDel(true)
      return
    }
    setErr(null)
    setSuccessMsg(null)
    setDeleting(true)
    try {
      const { data: user } = await supabase.auth.getUser()
      const res = await fetch(`/api/admin/transactions/${transaction.id}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: reason || null,
          user_id: user.user?.id ?? null,
        }),
      })
      const json = await res.json()
      if (!res.ok || !json.ok) {
        setErr(json.error || `HTTP ${res.status}`)
        setDeleting(false)
        return
      }
      setSuccessMsg(`Deleted. NAV reconstruct running in background.`)
      setTimeout(() => {
        onDeleted()
        onClose()
      }, 1000)
    } catch (e: any) {
      setErr(e.message || 'unknown error')
      setDeleting(false)
    }
  }

  // Lock body scroll while modal is open.
  useEffect(() => {
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => { document.body.style.overflow = prev }
  }, [])

  const fieldStyle = (key: string): React.CSSProperties => ({
    opacity: isFieldRelevant(key) ? 1 : 0.4,
    pointerEvents: isFieldRelevant(key) ? 'auto' : 'none',
  })

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(15, 41, 71, 0.45)',
        backdropFilter: 'blur(2px)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '40px 20px', overflowY: 'auto',
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose() }}
    >
      <div
        className="panel"
        style={{
          width: '100%', maxWidth: 920, background: 'var(--card)',
          borderColor: 'rgba(176, 139, 62, 0.3)',
          boxShadow: '0 12px 48px rgba(15, 41, 71, 0.18)',
        }}
      >
        {/* Header */}
        <div className="panel-header">
          <div className="panel-title">
            Edit transaction
            <span style={{ marginLeft: 12, fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
              {transaction.id?.slice(0, 8)}…
            </span>
          </div>
          <button onClick={onClose} className="btn-h" style={{ padding: '4px 8px' }} aria-label="Close">
            <X size={14} />
          </button>
        </div>

        {/* Machine-generated warning */}
        {machineGen.yes && (
          <div className="alert-h alert-h-warn" style={{ marginBottom: 16, fontSize: 12, alignItems: 'flex-start' }}>
            <AlertTriangle size={14} style={{ marginTop: 1, flexShrink: 0, color: 'var(--warn)' }} />
            <div>
              <strong>Machine-generated row</strong> ({machineGen.kind}).
              This row was created by an automated process and tagged with{' '}
              <code style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>{transaction.external_ref}</code>.
              Manual edits will be <strong>destroyed</strong> if recovery synthesis is re-run with{' '}
              <code style={{ fontSize: 11 }}>rerun: true</code>. Edit anyway only if you understand the risk.
            </div>
          </div>
        )}

        {err && (
          <div className="alert-h" style={{
            marginBottom: 16, fontSize: 12,
            background: 'rgba(166, 59, 59, 0.08)', borderColor: 'var(--neg)', color: 'var(--neg)',
          }}>
            {err}
          </div>
        )}

        {successMsg && (
          <div className="alert-h" style={{
            marginBottom: 16, fontSize: 12,
            background: 'rgba(45, 110, 78, 0.08)', borderColor: 'var(--pos)', color: 'var(--pos)',
          }}>
            {successMsg}
          </div>
        )}

        {/* Row 1: Date / Action / Instrument */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 14 }}>
          <FormField label="Trade date" required>
            <input type="date" value={form.trade_date} onChange={set('trade_date')} className="input-h" required />
          </FormField>
          <FormField label="Action" required>
            <select value={form.action} onChange={set('action')} className="select-h">
              {ACTIONS.map(a => <option key={a}>{a}</option>)}
            </select>
          </FormField>
          <FormField label="Instrument">
            <select value={form.instrument_id} onChange={set('instrument_id')} className="select-h" style={fieldStyle('instrument_id')}>
              <option value="">—</option>
              {instruments.map(i => (
                <option key={i.instrument_id} value={i.instrument_id}>
                  {i.instrument_id} — {i.name}
                </option>
              ))}
            </select>
          </FormField>
        </div>

        {/* Row 2: Quantity / Price / Gross / Amount */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 14 }}>
          <FormField label="Quantity">
            <input type="number" step="any" value={form.quantity} onChange={set('quantity')}
                   className="input-h input-h-mono" style={fieldStyle('quantity')} />
          </FormField>
          <FormField label="Price (₦)">
            <div style={{ display: 'flex', gap: 4 }}>
              <input type="number" step="any" value={form.price} onChange={set('price')}
                     className="input-h input-h-mono" style={{ ...fieldStyle('price'), flex: 1 }} />
              {form.action === 'TRANSFER_IN' && (
                <button type="button" onClick={lookupMarketPrice}
                        className="btn-h"
                        title="Look up market price for this instrument on this date"
                        style={{ padding: '4px 8px', flexShrink: 0 }}
                        disabled={priceLookup.loading}>
                  {priceLookup.loading ? <Loader2 size={12} className="spin" /> : <Search size={12} />}
                </button>
              )}
            </div>
            {priceLookup.result && (
              <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 4 }}>
                {priceLookup.result}
              </div>
            )}
          </FormField>
          <FormField label="Gross value (₦)">
            <input type="number" step="any" value={form.gross_value} onChange={set('gross_value')}
                   className="input-h input-h-mono" style={fieldStyle('gross_value')} />
          </FormField>
          <FormField label="Amount (₦)">
            <input type="number" step="any" value={form.amount} onChange={set('amount')}
                   className="input-h input-h-mono" style={fieldStyle('amount')} />
          </FormField>
        </div>

        {grossPreview != null && (
          <div className="alert-h alert-h-info" style={{ marginBottom: 14, fontSize: 11 }}>
            Computed gross (qty × price): <strong style={{ fontFamily: 'var(--font-mono)', marginLeft: 4 }}>
              ₦{grossPreview.toLocaleString()}
            </strong>
          </div>
        )}

        {/* Fees: total + breakdown */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 14 }}>
          <FormField label="Total fees (₦)">
            <input type="number" step="any" value={form.fees} onChange={set('fees')} className="input-h input-h-mono" />
          </FormField>
          <FormField label="Commission (₦)">
            <input type="number" step="any" value={form.fee_commission} onChange={set('fee_commission')}
                   className="input-h input-h-mono" style={fieldStyle('fee_commission')} />
          </FormField>
          <FormField label="VAT (₦)">
            <input type="number" step="any" value={form.fee_vat} onChange={set('fee_vat')}
                   className="input-h input-h-mono" style={fieldStyle('fee_vat')} />
          </FormField>
          <FormField label="Exchange levy (₦)">
            <input type="number" step="any" value={form.fee_exchange} onChange={set('fee_exchange')}
                   className="input-h input-h-mono" style={fieldStyle('fee_exchange')} />
          </FormField>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 14 }}>
          <FormField label="Clearing (₦)">
            <input type="number" step="any" value={form.fee_clearing} onChange={set('fee_clearing')}
                   className="input-h input-h-mono" style={fieldStyle('fee_clearing')} />
          </FormField>
          <FormField label="Stamp duty (₦)">
            <input type="number" step="any" value={form.fee_contract_stamp} onChange={set('fee_contract_stamp')}
                   className="input-h input-h-mono" style={fieldStyle('fee_contract_stamp')} />
          </FormField>
          <FormField label="SEC (₦)">
            <input type="number" step="any" value={form.fee_sec} onChange={set('fee_sec')}
                   className="input-h input-h-mono" style={fieldStyle('fee_sec')} />
          </FormField>
          <FormField label="SMS (₦)">
            <input type="number" step="any" value={form.fee_sms} onChange={set('fee_sms')}
                   className="input-h input-h-mono" style={fieldStyle('fee_sms')} />
          </FormField>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 14 }}>
          <FormField label="Management fee (₦)">
            <input type="number" step="any" value={form.fee_management} onChange={set('fee_management')}
                   className="input-h input-h-mono" style={fieldStyle('fee_management')} />
          </FormField>
          <FormField label="Demat fee (₦)">
            <input type="number" step="any" value={form.fee_demat} onChange={set('fee_demat')}
                   className="input-h input-h-mono" style={fieldStyle('fee_demat')} />
          </FormField>
          <FormField label="Other fee (₦)">
            <input type="number" step="any" value={form.fee_other} onChange={set('fee_other')}
                   className="input-h input-h-mono" style={fieldStyle('fee_other')} />
          </FormField>
        </div>

        {/* Broker meta */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 14 }}>
          <FormField label="CN number">
            <input type="text" value={form.cn_number} onChange={set('cn_number')}
                   className="input-h" style={fieldStyle('cn_number')} />
          </FormField>
          <FormField label="Settlement date">
            <input type="date" value={form.settlement_date} onChange={set('settlement_date')}
                   className="input-h" style={fieldStyle('settlement_date')} />
          </FormField>
          <FormField label="Maturity date">
            <input type="date" value={form.maturity_date} onChange={set('maturity_date')}
                   className="input-h" />
          </FormField>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 14 }}>
          <FormField label="Broker">
            <input type="text" value={form.broker} onChange={set('broker')} className="input-h" />
          </FormField>
          <FormField label="Counterparty">
            <input type="text" value={form.counterparty} onChange={set('counterparty')}
                   className="input-h" style={fieldStyle('counterparty')} />
          </FormField>
          <FormField label="Income category">
            <select value={form.income_category} onChange={set('income_category')}
                    className="select-h" style={fieldStyle('income_category')}>
              <option value="">—</option>
              {['Interest', 'Coupon', 'Dividend', 'Other'].map(c => <option key={c}>{c}</option>)}
            </select>
          </FormField>
        </div>

        {/* External ref (read-mostly) */}
        <div style={{ marginBottom: 14 }}>
          <FormField label="External ref (advanced — only edit if you know what you're doing)">
            <input type="text" value={form.external_ref} onChange={set('external_ref')}
                   className="input-h input-h-mono" style={{ fontSize: 11 }} />
          </FormField>
        </div>

        {/* Notes */}
        <div style={{ marginBottom: 14 }}>
          <FormField label="Notes (audit log will be appended automatically)">
            <textarea value={form.notes} onChange={set('notes')}
                      className="input-h" rows={3}
                      style={{ resize: 'vertical', minHeight: 60, fontFamily: 'var(--font-mono)', fontSize: 11 }} />
          </FormField>
        </div>

        {/* Reason */}
        <div style={{ marginBottom: 18 }}>
          <FormField label="Reason for this edit (optional, appended to audit note)">
            <input type="text" value={reason} onChange={(e) => setReason(e.target.value)}
                   className="input-h" placeholder="e.g. reclass professional charge to FEE" />
          </FormField>
        </div>

        {/* Action buttons */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid var(--border)', paddingTop: 14 }}>
          <button
            type="button"
            onClick={handleDelete}
            disabled={saving || deleting}
            className="btn-h"
            style={{
              color: confirmDel ? 'white' : 'var(--neg)',
              background: confirmDel ? 'var(--neg)' : 'transparent',
              borderColor: 'var(--neg)',
              display: 'flex', alignItems: 'center', gap: 6,
            }}
          >
            <Trash2 size={12} />
            {deleting ? 'Deleting…' : confirmDel ? 'Click again to confirm delete' : 'Delete transaction'}
          </button>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={onClose} className="btn-h" disabled={saving || deleting}>
              Cancel
            </button>
            <button type="button" onClick={handleSave} disabled={saving || deleting} className="btn-h btn-h-primary">
              {saving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
        </div>
      </div>

      <style>{`
        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  )
}

function FormField({ label, required, children }: { label: string; required?: boolean; children: React.ReactNode }) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>
        {label}
        {required && <span style={{ color: 'var(--neg)', marginLeft: 3 }}>*</span>}
      </label>
      {children}
    </div>
  )
}
