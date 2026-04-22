'use client'
import { useEffect, useState, useRef } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import {
  Upload, FileSpreadsheet, CheckCircle2, AlertTriangle,
  X, ArrowRight, RefreshCw, Download, ArrowLeft,
} from 'lucide-react'
import * as XLSX from 'xlsx'

// v20e: Hybrid rewrite. Preserves all parsing logic, auto-detection,
// field mapping, validation, and the 4-step flow. Only chrome changes.

const FIELD_DEFS = [
  { key: 'trade_date',         label: 'Trade Date',       required: true,  type: 'date'   },
  { key: 'action',             label: 'Action',           required: true,  type: 'action' },
  { key: 'instrument_id',      label: 'Instrument/Ticker',required: false, type: 'text'   },
  { key: 'quantity',           label: 'Quantity',         required: false, type: 'number' },
  { key: 'price',              label: 'Price (₦)',         required: false, type: 'number' },
  { key: 'gross_value',        label: 'Gross Value (₦)',  required: false, type: 'number' },
  { key: 'fees',               label: 'Total Fees (₦)',   required: false, type: 'number' },
  { key: 'fee_commission',     label: 'Commission (₦)',   required: false, type: 'number' },
  { key: 'fee_vat',            label: 'VAT (₦)',           required: false, type: 'number' },
  { key: 'fee_contract_stamp', label: 'Stamp Duty (₦)',   required: false, type: 'number' },
  { key: 'fee_exchange',       label: 'Exchange Fee (₦)', required: false, type: 'number' },
  { key: 'fee_clearing',       label: 'Clearing Fee (₦)', required: false, type: 'number' },
  { key: 'broker',             label: 'Broker',           required: false, type: 'text'   },
  { key: 'notes',              label: 'Notes',            required: false, type: 'text'   },
] as const

type FieldKey = typeof FIELD_DEFS[number]['key']

const AUTO_MAP: Record<string, FieldKey> = {
  'date': 'trade_date', 'trade date': 'trade_date', 'value date': 'trade_date',
  'settlement date': 'trade_date', 'transaction date': 'trade_date',
  'action': 'action', 'type': 'action', 'transaction type': 'action',
  'side': 'action', 'buy/sell': 'action', 'deal type': 'action',
  'stock': 'instrument_id', 'symbol': 'instrument_id', 'ticker': 'instrument_id',
  'instrument': 'instrument_id', 'security': 'instrument_id', 'scrip': 'instrument_id',
  'quantity': 'quantity', 'qty': 'quantity', 'units': 'quantity', 'shares': 'quantity',
  'volume': 'quantity', 'number of units': 'quantity',
  'price': 'price', 'unit price': 'price', 'deal price': 'price', 'rate': 'price',
  'gross': 'gross_value', 'gross value': 'gross_value', 'gross amount': 'gross_value',
  'consideration': 'gross_value', 'deal value': 'gross_value',
  'total fees': 'fees', 'total charges': 'fees', 'total cost': 'fees', 'net fees': 'fees',
  'commission': 'fee_commission', 'brokerage': 'fee_commission', 'broker fee': 'fee_commission',
  'vat': 'fee_vat', 'vat on commission': 'fee_vat',
  'stamp': 'fee_contract_stamp', 'stamp duty': 'fee_contract_stamp', 'contract stamp': 'fee_contract_stamp',
  'exchange levy': 'fee_exchange', 'ngx levy': 'fee_exchange', 'exchange fee': 'fee_exchange',
  'clearing': 'fee_clearing', 'cscs': 'fee_clearing', 'clearing fee': 'fee_clearing',
  'broker': 'broker', 'broker name': 'broker', 'dealer': 'broker',
  'notes': 'notes', 'remarks': 'notes', 'description': 'notes', 'narration': 'notes',
}

function autoDetectMapping(headers: string[]): Record<FieldKey, string> {
  const map: Partial<Record<FieldKey, string>> = {}
  for (const h of headers) {
    const norm = h.toLowerCase().trim().replace(/[\(\)₦#]/g, '').trim()
    const matched = AUTO_MAP[norm]
    if (matched && !map[matched]) map[matched] = h
  }
  return map as Record<FieldKey, string>
}

function normaliseAction(raw: string): string {
  const s = raw.toLowerCase().trim()
  if (s === 'buy'  || s === 'b' || s === 'purchase') return 'BUY'
  if (s === 'sell' || s === 's' || s === 'sale')     return 'SELL'
  if (s.includes('income') || s.includes('dividend') || s.includes('coupon') || s.includes('interest')) return 'INCOME'
  if (s.includes('fee') || s.includes('charge') || s.includes('management')) return 'FEE'
  if (s.includes('transfer in')  || s === 'tin')  return 'TRANSFER_IN'
  if (s.includes('transfer out') || s === 'tout') return 'TRANSFER_OUT'
  return raw.toUpperCase()
}

function parseDate(raw: any): string {
  if (!raw) return ''
  if (typeof raw === 'number') {
    const d = new Date((raw - 25569) * 86400 * 1000)
    return d.toISOString().slice(0, 10)
  }
  const s = String(raw).trim()
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/)
  if (dmy) {
    const y = dmy[3].length === 2 ? '20' + dmy[3] : dmy[3]
    return `${y}-${dmy[2].padStart(2,'0')}-${dmy[1].padStart(2,'0')}`
  }
  const d = new Date(s)
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10)
  return s
}

function parseNum(raw: any): number | null {
  if (raw === null || raw === undefined || raw === '') return null
  const n = parseFloat(String(raw).replace(/[,₦\s]/g, ''))
  return isNaN(n) ? null : n
}

function applyMapping(rows: Record<string, any>[], mapping: Record<FieldKey, string>): any[] {
  return rows.map(row => {
    const out: any = {}
    for (const fd of FIELD_DEFS) {
      const col = (mapping as any)[fd.key]
      const val = col ? row[col] : undefined
      if (fd.type === 'date')   out[fd.key] = parseDate(val)
      else if (fd.type === 'number') out[fd.key] = parseNum(val)
      else if (fd.type === 'action') out[fd.key] = val ? normaliseAction(String(val)) : ''
      else out[fd.key] = val ? String(val).trim() : null
    }
    return out
  })
}

function actionPill(action: string): string {
  if (action === 'BUY') return 'pill-buy'
  if (action === 'SELL') return 'pill-sell'
  if (action === 'INCOME') return 'pill-warn'
  if (action === 'FEE') return 'pill-hold'
  if (action === 'TRANSFER_IN') return 'pill-ok'
  if (action === 'TRANSFER_OUT') return 'pill-breach'
  return 'pill-hold'
}

export default function ImportPage() {
  const [portfolios,  setPortfolios]  = useState<any[]>([])
  const [portfolioId, setPortfolioId] = useState('')
  const [file,        setFile]        = useState<File | null>(null)
  const [headers,     setHeaders]     = useState<string[]>([])
  const [rawRows,     setRawRows]     = useState<Record<string,any>[]>([])
  const [mapping,     setMapping]     = useState<Partial<Record<FieldKey,string>>>({})
  const [preview,     setPreview]     = useState<any[]>([])
  const [step,        setStep]        = useState<1|2|3|4>(1)
  const [importing,   setImporting]   = useState(false)
  const [result,      setResult]      = useState<any>(null)
  const [skipDupes,   setSkipDupes]   = useState(true)
  const [dragging,    setDragging]    = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    supabase.from('portfolios')
      .select('id, name, label, client:clients(name)')
      .eq('status', 'active')
      .order('name')
      .then(({ data }) => setPortfolios(data ?? []))
  }, [])

  useEffect(() => {
    if (rawRows.length && Object.keys(mapping).length) {
      setPreview(applyMapping(rawRows.slice(0, 8), mapping as Record<FieldKey,string>))
    }
  }, [mapping, rawRows])

  function parseFile(f: File) {
    setFile(f)
    const reader = new FileReader()
    reader.onload = e => {
      const data = e.target?.result
      let wb: XLSX.WorkBook
      if (f.name.endsWith('.csv')) {
        wb = XLSX.read(data as string, { type: 'string', raw: false })
      } else {
        wb = XLSX.read(data as ArrayBuffer, { type: 'array' })
      }
      const ws   = wb.Sheets[wb.SheetNames[0]]
      const json = XLSX.utils.sheet_to_json<Record<string,any>>(ws, { defval: '' })
      if (!json.length) return
      const hdrs = Object.keys(json[0])
      setHeaders(hdrs)
      setRawRows(json)
      const auto = autoDetectMapping(hdrs)
      setMapping(auto)
      setStep(2)
    }
    if (f.name.endsWith('.csv')) reader.readAsText(f)
    else reader.readAsArrayBuffer(f)
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault(); setDragging(false)
    const f = e.dataTransfer.files[0]
    if (f) parseFile(f)
  }

  async function runImport() {
    if (!portfolioId || !preview.length) return
    setImporting(true)
    const allMapped = applyMapping(rawRows, mapping as Record<FieldKey,string>)
    const res = await fetch('/api/import', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ portfolioId, rows: allMapped, skipDupes }),
    })
    setResult(await res.json())
    setStep(4)
    setImporting(false)
  }

  function downloadTemplate() {
    const ws = XLSX.utils.aoa_to_sheet([
      ['Date', 'Action', 'Stock', 'Quantity', 'Price', 'Gross Value', 'Commission', 'Stamp Duty', 'Exchange Fee', 'VAT', 'Clearing Fee', 'Total Fees', 'Broker', 'Notes'],
      ['2026-01-15', 'BUY', 'ACCESSCORP', 50000, 24.90, 1245000, 18675, 996, 3735, 1400.63, 3735, 28541.63, 'Stanbic IBTC', ''],
      ['2026-01-20', 'SELL', 'ARADEL', 1000, 1340, 1340000, 20100, 1072, 4020, 1507.5, 4020, 30719.5, 'Stanbic IBTC', ''],
      ['2026-01-31', 'FEE', 'CASH_NGN', '', '', '', '', '', '', '', '', 295625, '', 'Quarterly management fee'],
    ])
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Transactions')
    XLSX.writeFile(wb, 'Transworld_Transaction_Template.xlsx')
  }

  const progress = ((step - 1) / 3) * 100

  return (
    <main className="hybrid-page" style={{ padding: '32px 44px 64px', minHeight: '100vh' }}>
      <div className="page-head">
        <div>
          <Link
            href="/admin"
            className="eyebrow"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 10, textDecoration: 'none' }}
          >
            <ArrowLeft size={11} /> Admin panel
          </Link>
          <h1 className="hybrid-serif" style={{ fontSize: 36, fontWeight: 500, letterSpacing: '-0.005em', lineHeight: 1, color: 'var(--text)' }}>
            Import transactions
          </h1>
          <p style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 8 }}>
            Upload CSV or Excel from your brokerage system · Monthly reconciliation
          </p>
        </div>
        <button className="btn-h" onClick={downloadTemplate}>
          <Download size={12} /> Download template
        </button>
      </div>

      {/* Progress bar */}
      <div style={{ height: 2, background: 'var(--border-soft)', borderRadius: 1, overflow: 'hidden', marginBottom: 28 }}>
        <div
          style={{
            height: '100%',
            width: `${progress}%`,
            background: 'var(--gold)',
            transition: 'width 0.5s',
          }}
        />
      </div>

      {/* Step indicators */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 0, marginBottom: 32 }}>
        {[
          { n: 1, label: 'Upload file' },
          { n: 2, label: 'Map columns' },
          { n: 3, label: 'Preview & import' },
          { n: 4, label: 'Done' },
        ].map(({ n, label }, i) => (
          <div key={n} style={{ display: 'flex', alignItems: 'center' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: '50%',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: 11,
                  fontWeight: 600,
                  flexShrink: 0,
                  transition: 'all 0.2s',
                  background: step > n ? 'var(--pos)' : step === n ? 'var(--gold)' : 'var(--bg-soft)',
                  color: step >= n ? '#fff' : 'var(--text-3)',
                  border: step < n ? '1px solid var(--border)' : 'none',
                }}
              >
                {step > n ? <CheckCircle2 size={13} /> : n}
              </div>
              <span
                style={{
                  fontSize: 12,
                  fontWeight: 500,
                  color: step >= n ? 'var(--text)' : 'var(--text-3)',
                }}
              >
                {label}
              </span>
            </div>
            {i < 3 && <div style={{ width: 40, height: 1, margin: '0 12px', background: 'var(--border)' }} />}
          </div>
        ))}
      </div>

      <div style={{ maxWidth: 900 }}>
        {/* ── STEP 1: Upload ─────────────────────────────────── */}
        {step === 1 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div className="panel">
              <label style={{ display: 'block', fontSize: 10, fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase' as const, letterSpacing: '0.14em', marginBottom: 12 }}>
                1. Select portfolio to import into
              </label>
              <select value={portfolioId} onChange={e => setPortfolioId(e.target.value)} className="select-h">
                <option value="">Choose portfolio…</option>
                {portfolios.map(p => (
                  <option key={p.id} value={p.id}>
                    {(p.client as any)?.name} — {p.name}
                  </option>
                ))}
              </select>
            </div>

            <div
              onDragOver={e => { e.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              onClick={() => portfolioId && fileRef.current?.click()}
              className="panel"
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '56px 24px',
                transition: 'all 0.2s',
                border: dragging ? '2px dashed var(--gold)' : '2px dashed var(--border)',
                background: dragging ? 'var(--gold-soft)' : undefined,
                opacity: portfolioId ? 1 : 0.55,
                cursor: portfolioId ? 'pointer' : 'not-allowed',
              }}
            >
              <FileSpreadsheet size={44} style={{ color: 'var(--text-3)', marginBottom: 14 }} />
              <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text)', marginBottom: 6 }}>
                {portfolioId ? 'Drop your file here or click to browse' : 'Select a portfolio first'}
              </div>
              <div style={{ fontSize: 12, color: 'var(--text-3)' }}>
                Supports .xlsx, .xls, .csv · Any broker format
              </div>
              <input
                ref={fileRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                style={{ display: 'none' }}
                onChange={e => { const f = e.target.files?.[0]; if (f) parseFile(f) }}
              />
            </div>

            <div className="alert-h alert-h-info" style={{ fontSize: 12, lineHeight: 1.6 }}>
              <div>
                <strong style={{ color: 'var(--gold)' }}>Tip:</strong> Any column order works — you'll map columns in the next step.
                For Stanbic IBTC broker statements, the auto-detection handles most columns automatically.
                Download the template above to see the expected format.
              </div>
            </div>
          </div>
        )}

        {/* ── STEP 2: Column mapping ────────────────────────── */}
        {step === 2 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div>
                <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text)' }}>{file?.name}</div>
                <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 3 }}>
                  {rawRows.length} rows detected · {headers.length} columns
                </div>
              </div>
              <button
                onClick={() => { setStep(1); setFile(null); setRawRows([]) }}
                className="btn-h"
              >
                <X size={12} /> Change file
              </button>
            </div>

            <div className="panel">
              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase' as const, letterSpacing: '0.14em', marginBottom: 16 }}>
                Map your columns → our fields
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
                {FIELD_DEFS.map(fd => {
                  const isMapped = Boolean((mapping as any)[fd.key])
                  const requiredUnmapped = fd.required && !isMapped
                  return (
                    <div key={fd.key} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <div style={{ width: 170, flexShrink: 0 }}>
                        <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--text-2)' }}>
                          {fd.label}
                          {fd.required && <span style={{ color: 'var(--neg)', marginLeft: 3 }}>*</span>}
                        </div>
                      </div>
                      <select
                        value={(mapping as any)[fd.key] ?? ''}
                        onChange={e => setMapping(m => ({ ...m, [fd.key]: e.target.value || undefined }))}
                        className="select-h"
                        style={{
                          flex: 1,
                          padding: '5px 32px 5px 10px',
                          fontSize: 12,
                          borderColor: requiredUnmapped ? 'var(--neg)' : undefined,
                        }}
                      >
                        <option value="">— not mapped —</option>
                        {headers.map(h => <option key={h} value={h}>{h}</option>)}
                      </select>
                      {isMapped && <CheckCircle2 size={13} style={{ color: 'var(--pos)', flexShrink: 0 }} />}
                    </div>
                  )
                })}
              </div>
            </div>

            {preview.length > 0 && (
              <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
                <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border-soft)', fontSize: 10, fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase' as const, letterSpacing: '0.14em' }}>
                  Preview (first 8 rows)
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table className="h-table" style={{ width: '100%', minWidth: 800 }}>
                    <thead>
                      <tr>
                        <th>Date</th><th>Action</th><th>Instrument</th>
                        <th className="num">Qty</th><th className="num">Price</th><th className="num">Gross</th>
                        <th className="num">Total Fees</th><th className="num">Commission</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.map((row, i) => {
                        const badAction = row.action && !['BUY','SELL','INCOME','FEE','TRANSFER_IN','TRANSFER_OUT'].includes(row.action)
                        return (
                          <tr key={i} style={badAction ? { background: 'rgba(166, 59, 59, 0.05)' } : undefined}>
                            <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{row.trade_date || '—'}</td>
                            <td>
                              <span
                                className={`pill ${actionPill(row.action)}`}
                                style={badAction ? { background: 'rgba(166, 59, 59, 0.12)', color: 'var(--neg)' } : undefined}
                              >
                                {row.action || '—'}
                              </span>
                            </td>
                            <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{row.instrument_id || '—'}</td>
                            <td className="num" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                              {row.quantity?.toLocaleString() ?? '—'}
                            </td>
                            <td className="num" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                              {row.price ? `₦${row.price.toFixed(2)}` : '—'}
                            </td>
                            <td className="num" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                              {row.gross_value ? `₦${(row.gross_value/1e6).toFixed(2)}M` : '—'}
                            </td>
                            <td className="num" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                              {row.fees ? `₦${row.fees.toLocaleString()}` : '—'}
                            </td>
                            <td className="num" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                              {row.fee_commission ? `₦${row.fee_commission.toLocaleString()}` : '—'}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
              <button
                onClick={() => setStep(3)}
                disabled={!mapping.trade_date || !mapping.action}
                className="btn-h btn-h-primary"
              >
                Continue to preview <ArrowRight size={12} />
              </button>
              <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
                {rawRows.length} rows will be processed
              </span>
            </div>
          </div>
        )}

        {/* ── STEP 3: Preview & import ──────────────────────── */}
        {step === 3 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
            <div className="panel">
              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase' as const, letterSpacing: '0.14em', marginBottom: 16 }}>
                Import summary
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 16 }}>
                {[
                  { label: 'Portfolio',  value: portfolios.find(p => p.id === portfolioId)?.name ?? '—' },
                  { label: 'Total rows', value: rawRows.length.toLocaleString() },
                  { label: 'File',       value: file?.name ?? '—' },
                ].map(item => (
                  <div key={item.label}>
                    <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase' as const, letterSpacing: '0.14em', marginBottom: 4 }}>
                      {item.label}
                    </div>
                    <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {item.value}
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 10, paddingTop: 14, borderTop: '1px solid var(--border-soft)' }}>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={skipDupes}
                    onChange={e => setSkipDupes(e.target.checked)}
                    style={{ width: 14, height: 14, accentColor: 'var(--gold)' }}
                  />
                  <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
                    Skip duplicate transactions (same date + instrument + action + qty + price)
                  </span>
                </label>
              </div>
            </div>

            <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
              <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase' as const, letterSpacing: '0.14em' }}>
                  All {rawRows.length} rows
                </span>
                <span style={{ fontSize: 10, color: 'var(--text-3)' }}>
                  Scroll to review before importing
                </span>
              </div>
              <div style={{ overflowX: 'auto', maxHeight: 360 }}>
                <table className="h-table" style={{ width: '100%', minWidth: 900 }}>
                  <thead style={{ position: 'sticky', top: 0, background: 'var(--card)' }}>
                    <tr>
                      <th>#</th><th>Date</th><th>Action</th><th>Instrument</th>
                      <th className="num">Qty</th><th className="num">Price</th><th className="num">Gross</th>
                      <th className="num">Fees</th><th>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {applyMapping(rawRows, mapping as Record<FieldKey,string>).map((row, i) => {
                      const bad = row.trade_date === '' || row.action === '' ||
                        !['BUY','SELL','INCOME','FEE','TRANSFER_IN','TRANSFER_OUT'].includes(row.action)
                      return (
                        <tr key={i} style={bad ? { background: 'rgba(166, 59, 59, 0.05)' } : {}}>
                          <td style={{ color: 'var(--text-3)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>{i + 1}</td>
                          <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                            {row.trade_date || <span style={{ color: 'var(--neg)' }}>missing</span>}
                          </td>
                          <td>
                            <span className={`pill ${actionPill(row.action)}`}>
                              {row.action || '?'}
                            </span>
                          </td>
                          <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>{row.instrument_id || '—'}</td>
                          <td className="num" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                            {row.quantity?.toLocaleString() ?? '—'}
                          </td>
                          <td className="num" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                            {row.price ? `₦${row.price.toFixed(2)}` : '—'}
                          </td>
                          <td className="num" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                            {row.gross_value ? `₦${(row.gross_value/1e6).toFixed(3)}M` : '—'}
                          </td>
                          <td className="num" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                            {row.fees ? `₦${row.fees.toLocaleString()}` : '—'}
                          </td>
                          <td style={{ fontSize: 11, color: 'var(--text-3)', maxWidth: 120, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                            {row.notes || '—'}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 12 }}>
              <button onClick={() => setStep(2)} className="btn-h">
                ← Back
              </button>
              <button
                onClick={runImport}
                disabled={importing}
                className="btn-h"
                style={{ background: 'var(--pos)', color: '#fff', borderColor: 'var(--pos)', fontWeight: 600 }}
              >
                {importing ? (
                  <>
                    <RefreshCw size={12} style={{ animation: 'spin 0.7s linear infinite' }} />
                    Importing…
                  </>
                ) : (
                  <>
                    <Upload size={12} /> Import {rawRows.length} transactions
                  </>
                )}
              </button>
            </div>
            <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
          </div>
        )}

        {/* ── STEP 4: Result ────────────────────────────────── */}
        {step === 4 && result && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            <div
              className="panel"
              style={{ borderLeft: `3px solid ${result.ok ? 'var(--pos)' : 'var(--warn)'}` }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 18 }}>
                {result.ok ? (
                  <CheckCircle2 size={26} style={{ color: 'var(--pos)' }} />
                ) : (
                  <AlertTriangle size={26} style={{ color: 'var(--warn)' }} />
                )}
                <div>
                  <div className="hybrid-serif" style={{ fontSize: 18, fontWeight: 500, color: 'var(--text)' }}>
                    {result.ok ? 'Import complete' : 'Import completed with warnings'}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 3 }}>{result.summary}</div>
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 }}>
                {[
                  { label: 'Inserted',        value: result.inserted,              color: 'var(--pos)' },
                  { label: 'Skipped (dupes)', value: result.skipped,               color: 'var(--text-3)' },
                  { label: 'Errors',          value: result.errors?.length ?? 0,   color: 'var(--neg)' },
                ].map(item => (
                  <div
                    key={item.label}
                    style={{ textAlign: 'center', padding: '14px 12px', borderRadius: 4, background: 'var(--bg-soft)', border: '1px solid var(--border-soft)' }}
                  >
                    <div className="hybrid-serif" style={{ fontSize: 28, fontWeight: 500, color: item.color, letterSpacing: '-0.01em', lineHeight: 1 }}>
                      {item.value}
                    </div>
                    <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase' as const, letterSpacing: '0.14em', marginTop: 6 }}>
                      {item.label}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {result.warnings?.length > 0 && (
              <div className="panel" style={{ borderColor: 'rgba(166, 124, 42, 0.3)' }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--warn)', textTransform: 'uppercase' as const, letterSpacing: '0.14em', marginBottom: 10 }}>
                  Warnings
                </div>
                {result.warnings.map((w: string, i: number) => (
                  <div key={i} style={{ fontSize: 11, color: 'var(--text-2)', padding: '6px 0', borderBottom: '1px solid var(--border-soft)' }}>
                    {w}
                  </div>
                ))}
              </div>
            )}

            {result.errors?.length > 0 && (
              <div className="panel" style={{ borderColor: 'rgba(166, 59, 59, 0.3)' }}>
                <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--neg)', textTransform: 'uppercase' as const, letterSpacing: '0.14em', marginBottom: 10 }}>
                  Errors
                </div>
                {result.errors.map((e: string, i: number) => (
                  <div key={i} style={{ fontSize: 11, color: 'var(--text-2)', padding: '6px 0', borderBottom: '1px solid var(--border-soft)', fontFamily: 'var(--font-mono)' }}>
                    {e}
                  </div>
                ))}
              </div>
            )}

            <div style={{ display: 'flex', gap: 12 }}>
              <Link href={`/portfolio/${portfolioId}/transactions`} className="btn-h btn-h-primary" style={{ textDecoration: 'none' }}>
                View transactions →
              </Link>
              <button
                onClick={() => { setStep(1); setFile(null); setRawRows([]); setMapping({}); setResult(null) }}
                className="btn-h"
              >
                Import another file
              </button>
            </div>
          </div>
        )}
      </div>
    </main>
  )
}
