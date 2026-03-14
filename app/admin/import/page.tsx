'use client'
import { useEffect, useState, useCallback, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import {
  Upload, FileSpreadsheet, CheckCircle2, AlertTriangle,
  X, ChevronDown, ArrowRight, RefreshCw, Download
} from 'lucide-react'
import * as XLSX from 'xlsx'

// ── Column mapping ─────────────────────────────────────────────
// Maps our internal field names to common broker column names
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

// Common column name patterns from Nigerian brokers
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
    // Excel serial date
    const d = new Date((raw - 25569) * 86400 * 1000)
    return d.toISOString().slice(0, 10)
  }
  const s = String(raw).trim()
  // Try DD/MM/YYYY
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})$/)
  if (dmy) {
    const y = dmy[3].length === 2 ? '20' + dmy[3] : dmy[3]
    return `${y}-${dmy[2].padStart(2,'0')}-${dmy[1].padStart(2,'0')}`
  }
  // ISO or other
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

  // Rebuild preview when mapping changes
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
    <div>
      <div className="px-8 py-5 border-b border-white/[0.07] bg-[#13161d] flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold">Import Transactions</h1>
          <p className="text-xs text-[#555d72] mt-0.5">Upload CSV or Excel from your brokerage system · Monthly reconciliation</p>
        </div>
        <button onClick={downloadTemplate}
          className="flex items-center gap-1.5 text-xs border border-white/10 text-[#8a91a8] hover:text-[#e8eaf0] rounded-lg px-3 py-1.5 transition-colors">
          <Download size={12} /> Download template
        </button>
      </div>

      {/* Progress bar */}
      <div className="h-0.5 bg-white/[0.05]">
        <div className="h-full bg-[#a78bfa] transition-all duration-500" style={{ width: progress + '%' }} />
      </div>

      <div className="px-8 py-6 max-w-4xl">

        {/* Step indicators */}
        <div className="flex items-center gap-0 mb-8">
          {[
            { n: 1, label: 'Upload file' },
            { n: 2, label: 'Map columns' },
            { n: 3, label: 'Preview & import' },
            { n: 4, label: 'Done' },
          ].map(({ n, label }, i) => (
            <div key={n} className="flex items-center">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 transition-all"
                  style={{
                    background: step > n ? '#22c55e' : step === n ? '#a78bfa' : 'rgba(255,255,255,0.05)',
                    color: step >= n ? 'white' : '#555d72',
                  }}>
                  {step > n ? <CheckCircle2 size={14} /> : n}
                </div>
                <span className="text-xs font-medium" style={{ color: step >= n ? '#e8eaf0' : '#555d72' }}>{label}</span>
              </div>
              {i < 3 && <div className="w-12 h-px mx-3 bg-white/10" />}
            </div>
          ))}
        </div>

        {/* ── STEP 1: Upload ─────────────────────────────────── */}
        {step === 1 && (
          <div className="space-y-5">
            {/* Portfolio selector */}
            <div className="tw-card">
              <label className="block text-xs font-semibold text-[#8a91a8] uppercase tracking-wider mb-3">
                1. Select portfolio to import into
              </label>
              <select value={portfolioId} onChange={e => setPortfolioId(e.target.value)} className="tw-select">
                <option value="">Choose portfolio…</option>
                {portfolios.map(p => (
                  <option key={p.id} value={p.id}>
                    {(p.client as any)?.name} — {p.name}
                  </option>
                ))}
              </select>
            </div>

            {/* Drop zone */}
            <div
              onDragOver={e => { e.preventDefault(); setDragging(true) }}
              onDragLeave={() => setDragging(false)}
              onDrop={handleDrop}
              onClick={() => portfolioId && fileRef.current?.click()}
              className="tw-card flex flex-col items-center justify-center py-14 cursor-pointer transition-all"
              style={{
                border: dragging ? '2px dashed #a78bfa' : '2px dashed rgba(255,255,255,0.1)',
                background: dragging ? '#a78bfa08' : undefined,
                opacity: portfolioId ? 1 : 0.5,
                cursor: portfolioId ? 'pointer' : 'not-allowed',
              }}>
              <FileSpreadsheet size={40} className="text-[#555d72] mb-4" />
              <div className="text-sm font-medium text-[#8a91a8] mb-1">
                {portfolioId ? 'Drop your file here or click to browse' : 'Select a portfolio first'}
              </div>
              <div className="text-xs text-[#555d72]">Supports .xlsx, .xls, .csv · Any broker format</div>
              <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) parseFile(f) }} />
            </div>

            {/* Template note */}
            <div className="px-4 py-3 bg-[#a78bfa]/[0.07] border border-[#a78bfa]/20 rounded-xl text-xs text-[#8a91a8] leading-relaxed">
              <strong className="text-[#a78bfa]">Tip:</strong> Any column order works — you'll map columns in the next step.
              For Stanbic IBTC broker statements, the auto-detection handles most columns automatically.
              Download the template above to see the expected format.
            </div>
          </div>
        )}

        {/* ── STEP 2: Column mapping ────────────────────────── */}
        {step === 2 && (
          <div className="space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold">{file?.name}</div>
                <div className="text-xs text-[#555d72] mt-0.5">{rawRows.length} rows detected · {headers.length} columns</div>
              </div>
              <button onClick={() => { setStep(1); setFile(null); setRawRows([]) }}
                className="text-xs text-[#555d72] hover:text-[#e8eaf0] flex items-center gap-1 transition-colors">
                <X size={12} /> Change file
              </button>
            </div>

            <div className="tw-card">
              <div className="text-xs font-semibold text-[#555d72] uppercase tracking-wider mb-4">
                Map your columns → our fields
              </div>
              <div className="grid grid-cols-2 gap-3">
                {FIELD_DEFS.map(fd => (
                  <div key={fd.key} className="flex items-center gap-3">
                    <div className="w-40 flex-shrink-0">
                      <div className="text-[11px] font-medium text-[#8a91a8]">
                        {fd.label}
                        {fd.required && <span className="text-[#ff5c7a] ml-0.5">*</span>}
                      </div>
                    </div>
                    <select
                      value={(mapping as any)[fd.key] ?? ''}
                      onChange={e => setMapping(m => ({ ...m, [fd.key]: e.target.value || undefined }))}
                      className="tw-select py-1 text-xs flex-1"
                      style={{ borderColor: fd.required && !(mapping as any)[fd.key] ? '#ef4444' : undefined }}>
                      <option value="">— not mapped —</option>
                      {headers.map(h => <option key={h} value={h}>{h}</option>)}
                    </select>
                    {(mapping as any)[fd.key] && <CheckCircle2 size={14} className="text-[#22c55e] flex-shrink-0" />}
                  </div>
                ))}
              </div>
            </div>

            {/* Preview table */}
            {preview.length > 0 && (
              <div className="tw-card p-0 overflow-hidden">
                <div className="px-4 py-2.5 border-b border-white/[0.07] text-xs font-semibold text-[#555d72] uppercase tracking-wider">
                  Preview (first 8 rows)
                </div>
                <div className="overflow-x-auto">
                  <table className="tw-table w-full" style={{ minWidth: 700 }}>
                    <thead>
                      <tr>
                        <th>Date</th><th>Action</th><th>Instrument</th>
                        <th>Qty</th><th>Price</th><th>Gross</th><th>Total Fees</th><th>Commission</th>
                      </tr>
                    </thead>
                    <tbody>
                      {preview.map((row, i) => {
                        const badAction = row.action && !['BUY','SELL','INCOME','FEE','TRANSFER_IN','TRANSFER_OUT'].includes(row.action)
                        return (
                          <tr key={i} style={{ background: badAction ? 'rgba(239,68,68,0.05)' : undefined }}>
                            <td className="font-mono text-[11px]">{row.trade_date || '—'}</td>
                            <td>
                              <span className={`badge badge-${
                                row.action === 'BUY' ? 'buy' : row.action === 'SELL' ? 'sell' :
                                row.action === 'FEE' ? 'hold' : 'ntb'
                              }`} style={badAction ? { background:'#ef444420', color:'#ef4444' } : {}}>
                                {row.action || '—'}
                              </span>
                            </td>
                            <td className="font-mono">{row.instrument_id || '—'}</td>
                            <td className="font-mono">{row.quantity?.toLocaleString() ?? '—'}</td>
                            <td className="font-mono">{row.price ? `₦${row.price.toFixed(2)}` : '—'}</td>
                            <td className="font-mono">{row.gross_value ? `₦${(row.gross_value/1e6).toFixed(2)}M` : '—'}</td>
                            <td className="font-mono">{row.fees ? `₦${row.fees.toLocaleString()}` : '—'}</td>
                            <td className="font-mono">{row.fee_commission ? `₦${row.fee_commission.toLocaleString()}` : '—'}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={() => setStep(3)}
                disabled={!mapping.trade_date || !mapping.action}
                className="flex items-center gap-2 bg-[#a78bfa] text-white px-5 py-2 rounded-lg text-xs font-semibold disabled:opacity-50 transition-colors hover:bg-[#9b87e8]">
                Continue to preview <ArrowRight size={13} />
              </button>
              <span className="text-[11px] text-[#555d72] self-center">
                {rawRows.length} rows will be processed
              </span>
            </div>
          </div>
        )}

        {/* ── STEP 3: Preview & import ──────────────────────── */}
        {step === 3 && (
          <div className="space-y-5">
            <div className="tw-card">
              <div className="text-xs font-semibold text-[#555d72] uppercase tracking-wider mb-4">Import summary</div>
              <div className="grid grid-cols-3 gap-4 mb-4">
                {[
                  { label: 'Portfolio', value: portfolios.find(p => p.id === portfolioId)?.name ?? '—' },
                  { label: 'Total rows', value: rawRows.length.toLocaleString() },
                  { label: 'File', value: file?.name ?? '—' },
                ].map(item => (
                  <div key={item.label}>
                    <div className="text-[10px] text-[#555d72] uppercase tracking-wider mb-1">{item.label}</div>
                    <div className="text-sm font-medium text-[#e8eaf0] truncate">{item.value}</div>
                  </div>
                ))}
              </div>

              {/* Options */}
              <div className="flex items-center gap-3 pt-3 border-t border-white/[0.07]">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={skipDupes} onChange={e => setSkipDupes(e.target.checked)}
                    className="w-3.5 h-3.5 rounded accent-[#a78bfa]" />
                  <span className="text-xs text-[#8a91a8]">Skip duplicate transactions (same date + instrument + action + qty + price)</span>
                </label>
              </div>
            </div>

            {/* Full preview */}
            <div className="tw-card p-0 overflow-hidden">
              <div className="px-4 py-2.5 border-b border-white/[0.07] flex items-center justify-between">
                <span className="text-xs font-semibold text-[#555d72] uppercase tracking-wider">All {rawRows.length} rows</span>
                <span className="text-[10px] text-[#555d72]">Scroll to review before importing</span>
              </div>
              <div className="overflow-x-auto max-h-80">
                <table className="tw-table w-full" style={{ minWidth: 800 }}>
                  <thead className="sticky top-0 bg-[#13161d]">
                    <tr>
                      <th>#</th><th>Date</th><th>Action</th><th>Instrument</th>
                      <th>Qty</th><th>Price</th><th>Gross</th><th>Fees</th><th>Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {applyMapping(rawRows, mapping as Record<FieldKey,string>).map((row, i) => {
                      const bad = row.trade_date === '' || row.action === '' ||
                        !['BUY','SELL','INCOME','FEE','TRANSFER_IN','TRANSFER_OUT'].includes(row.action)
                      return (
                        <tr key={i} style={bad ? { background: 'rgba(239,68,68,0.05)' } : {}}>
                          <td className="text-[#555d72] font-mono">{i + 1}</td>
                          <td className="font-mono text-[11px]">{row.trade_date || <span className="text-[#ef4444]">missing</span>}</td>
                          <td>
                            <span className={`badge badge-${
                              row.action === 'BUY' ? 'buy' : row.action === 'SELL' ? 'sell' :
                              row.action === 'FEE' ? 'hold' : 'ntb'}`}>
                              {row.action || '?'}
                            </span>
                          </td>
                          <td className="font-mono">{row.instrument_id || '—'}</td>
                          <td className="font-mono text-xs">{row.quantity?.toLocaleString() ?? '—'}</td>
                          <td className="font-mono text-xs">{row.price ? `₦${row.price.toFixed(2)}` : '—'}</td>
                          <td className="font-mono text-xs">{row.gross_value ? `₦${(row.gross_value/1e6).toFixed(3)}M` : '—'}</td>
                          <td className="font-mono text-xs">{row.fees ? `₦${row.fees.toLocaleString()}` : '—'}</td>
                          <td className="text-[11px] text-[#555d72] max-w-[120px] truncate">{row.notes || '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="flex gap-3">
              <button onClick={() => setStep(2)}
                className="px-4 py-2 border border-white/10 rounded-lg text-xs text-[#8a91a8] hover:text-[#e8eaf0] transition-colors">
                ← Back
              </button>
              <button onClick={runImport} disabled={importing}
                className="flex items-center gap-2 bg-[#22c55e] text-white px-6 py-2 rounded-lg text-xs font-bold disabled:opacity-60 transition-colors hover:bg-[#16a34a]">
                {importing
                  ? <><RefreshCw size={13} className="animate-spin" /> Importing…</>
                  : <><Upload size={13} /> Import {rawRows.length} transactions</>}
              </button>
            </div>
          </div>
        )}

        {/* ── STEP 4: Result ────────────────────────────────── */}
        {step === 4 && result && (
          <div className="space-y-4">
            {/* Summary card */}
            <div className="tw-card" style={{ borderLeft: `4px solid ${result.ok ? '#22c55e' : '#f59e0b'}` }}>
              <div className="flex items-center gap-3 mb-4">
                {result.ok
                  ? <CheckCircle2 size={24} className="text-[#22c55e]" />
                  : <AlertTriangle size={24} className="text-[#f59e0b]" />}
                <div>
                  <div className="text-sm font-bold text-[#e8eaf0]">
                    {result.ok ? 'Import complete' : 'Import completed with warnings'}
                  </div>
                  <div className="text-xs text-[#555d72]">{result.summary}</div>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-4">
                {[
                  { label: 'Inserted', value: result.inserted, color: '#22c55e' },
                  { label: 'Skipped (dupes)', value: result.skipped, color: '#555d72' },
                  { label: 'Errors', value: result.errors?.length ?? 0, color: '#ef4444' },
                ].map(item => (
                  <div key={item.label} className="text-center p-3 rounded-xl bg-white/[0.03]">
                    <div className="text-2xl font-bold font-mono" style={{ color: item.color }}>{item.value}</div>
                    <div className="text-[10px] text-[#555d72] uppercase tracking-wider mt-1">{item.label}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Warnings */}
            {result.warnings?.length > 0 && (
              <div className="tw-card border-[#f59e0b]/20">
                <div className="text-xs font-semibold text-[#f59e0b] uppercase tracking-wider mb-2">Warnings</div>
                {result.warnings.map((w: string, i: number) => (
                  <div key={i} className="text-xs text-[#8a91a8] py-1 border-b border-white/[0.05]">{w}</div>
                ))}
              </div>
            )}

            {/* Errors */}
            {result.errors?.length > 0 && (
              <div className="tw-card border-[#ef4444]/20">
                <div className="text-xs font-semibold text-[#ef4444] uppercase tracking-wider mb-2">Errors</div>
                {result.errors.map((e: string, i: number) => (
                  <div key={i} className="text-xs text-[#8a91a8] py-1 border-b border-white/[0.05] font-mono">{e}</div>
                ))}
              </div>
            )}

            <div className="flex gap-3">
              <a href={`/portfolio/${portfolioId}/transactions`}
                className="flex items-center gap-2 bg-[#a78bfa] text-white px-5 py-2 rounded-lg text-xs font-semibold hover:bg-[#9b87e8] transition-colors">
                View transactions →
              </a>
              <button onClick={() => { setStep(1); setFile(null); setRawRows([]); setMapping({}); setResult(null) }}
                className="px-4 py-2 border border-white/10 rounded-lg text-xs text-[#8a91a8] hover:text-[#e8eaf0] transition-colors">
                Import another file
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
