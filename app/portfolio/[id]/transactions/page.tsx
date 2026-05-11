'use client'
import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import * as XLSX from 'xlsx'
import { supabase } from '@/lib/supabase'
import Link from 'next/link'
import { fmt } from '@/lib/portfolio'
import { Plus, Search, Copy, Check, Info, FileSpreadsheet, Edit2 } from 'lucide-react'
// v27v: Transaction CRUD modal
import EditTransactionModal from '@/components/admin/EditTransactionModal'

// v20d: Hybrid rewrite.
// Sidebar rendered by app/portfolio/[id]/layout.tsx — do NOT render here.
// v21j: Excel export via SheetJS. "Export Excel" button added to header.
//   Two-sheet workbook: "Summary" (fee totals + transaction counts) and
//   "Transactions" (full transaction history with all fee columns).

const ACTION_PILL: Record<string, string> = {
  BUY:           'pill-buy',
  SELL:          'pill-sell',
  INCOME:        'pill-warn',
  FEE:           'pill-hold',
  TRANSFER_IN:   'pill-ok',
  TRANSFER_OUT:  'pill-breach',
}

type FeeView = 'total' | 'breakdown'

function buildFeeRows(txns: any[]): any[] {
  const rows: any[] = []
  txns.filter(t => t.action === 'BUY' || t.action === 'SELL').forEach(t => {
    if (t.fee_commission && t.fee_commission > 0)
      rows.push({ ...t, _virtual: true, _feeType: 'Brokerage Commission', _feeAmount: t.fee_commission, action: 'FEE', income_category: 'Brokerage Commission' })
    if (t.fee_contract_stamp && t.fee_contract_stamp > 0)
      rows.push({ ...t, _virtual: true, _feeType: 'Stamp Duty', _feeAmount: t.fee_contract_stamp, action: 'FEE', income_category: 'Stamp Duty' })
    if (t.fee_vat && t.fee_vat > 0)
      rows.push({ ...t, _virtual: true, _feeType: 'VAT', _feeAmount: t.fee_vat, action: 'FEE', income_category: 'VAT' })
    if (t.fee_exchange && t.fee_exchange > 0)
      rows.push({ ...t, _virtual: true, _feeType: 'Exchange Levy', _feeAmount: t.fee_exchange, action: 'FEE', income_category: 'Exchange Levy' })
    if (t.fee_clearing && t.fee_clearing > 0)
      rows.push({ ...t, _virtual: true, _feeType: 'Clearing Fee', _feeAmount: t.fee_clearing, action: 'FEE', income_category: 'Clearing Fee' })
    if (t.fee_sms && t.fee_sms > 0)
      rows.push({ ...t, _virtual: true, _feeType: 'SMS Charge', _feeAmount: t.fee_sms, action: 'FEE', income_category: 'SMS Charge' })
  })
  return rows
}

// v27e: per-row fee decomposition. The two new buckets capture residuals
// that previously sat silently inside t.fees with no column attribution
// (e.g. NGX 0.30% regulatory charge on BUY rows, demat / verification fees
// on standalone FEE rows). By construction:
//   namedSum + otherRegulatory + otherStandalone === totalFees.
// FEE rows: residual → otherStandalone. Non-FEE rows: residual → otherRegulatory.
function decomposeFees(t: any) {
  const commission = Number(t.fee_commission ?? 0)
  const vat        = Number(t.fee_vat ?? 0)
  const stamp      = Number(t.fee_contract_stamp ?? 0)
  const exchange   = Number(t.fee_exchange ?? 0)
  const clearing   = Number(t.fee_clearing ?? 0)
  const sms        = Number(t.fee_sms ?? 0)
  const management = Number(t.fee_management ?? 0)
  const totalFees  = Number(t.fees ?? 0)
  const namedSum   = commission + vat + stamp + exchange + clearing + sms + management
  const residual   = totalFees - namedSum
  const isFee      = t.action === 'FEE'
  return {
    commission, vat, stamp, exchange, clearing, sms, management,
    otherRegulatory: isFee ? 0 : residual,
    otherStandalone: isFee ? residual : 0,
    totalFees,
    namedSum,
    residual,
  }
}

const FEE_TYPES = [
  'Management Fee', 'Brokerage Commission', 'Stamp Duty',
  'VAT', 'Exchange Levy', 'Clearing Fee', 'SMS Charge',
]

export default function TransactionsPage() {
  const { id: portfolioId } = useParams() as { id: string }
  const [portfolio,   setPortfolio]   = useState<any>(null)
  const [txns,        setTxns]        = useState<any[]>([])
  const [instruments, setInstruments] = useState<any[]>([])
  const [loading,     setLoading]     = useState(true)
  const [showForm,    setShowForm]    = useState(false)
  const [saving,      setSaving]      = useState(false)
  const [feeView,     setFeeView]     = useState<FeeView>('total')
  const [copied,      setCopied]      = useState(false)
  // v27v: edit modal state — null when closed, txn object when open
  const [editingTxn,  setEditingTxn]  = useState<any>(null)
  const [filter, setFilter] = useState({ action: '', search: '', feeType: '' })
  const [form, setForm] = useState({
    trade_date: new Date().toISOString().slice(0, 10),
    instrument_id: '', action: 'BUY',
    quantity: '', price: '', amount: '', fees: '0',
    income_category: '', maturity_date: '',
    broker: '', counterparty: '', notes: '',
  })
  const set = (k: string) => (e: React.ChangeEvent<any>) => setForm(f => ({ ...f, [k]: e.target.value }))

  useEffect(() => {
    async function load() {
      const [portRes, txnRes, instrRes] = await Promise.all([
        supabase.from('portfolios').select('*, client:clients(name)').eq('id', portfolioId).single(),
        supabase.from('transactions').select('*').eq('portfolio_id', portfolioId).order('trade_date', { ascending: false }).limit(300),
        supabase.from('instruments').select('instrument_id, name, type, sleeve_id').order('name'),
      ])
      setPortfolio(portRes.data)
      setTxns(txnRes.data ?? [])
      setInstruments(instrRes.data ?? [])
      setLoading(false)
    }
    load()
  }, [portfolioId])

  async function submitTrade(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    const { data: user } = await supabase.auth.getUser()
    const qty = Number(form.quantity)
    const price = Number(form.price)
    const grossVal = ['BUY', 'SELL'].includes(form.action) ? qty * price : 0
    await supabase.from('transactions').insert({
      portfolio_id: portfolioId,
      trade_date: form.trade_date,
      instrument_id: form.instrument_id || null,
      action: form.action,
      quantity: qty || null,
      price: price || null,
      amount: Number(form.amount) || null,
      fees: Number(form.fees) || 0,
      gross_value: grossVal || null,
      income_category: form.income_category || null,
      maturity_date: form.maturity_date || null,
      broker: form.broker || null,
      counterparty: form.counterparty || null,
      notes: form.notes || null,
      created_by: user.user?.id,
    })
    setShowForm(false)
    setForm(f => ({ ...f, instrument_id: '', quantity: '', price: '', amount: '', fees: '0', income_category: '', maturity_date: '', broker: '', counterparty: '', notes: '' }))
    const { data } = await supabase.from('transactions').select('*').eq('portfolio_id', portfolioId).order('trade_date', { ascending: false }).limit(300)
    setTxns(data ?? [])
    setSaving(false)
  }

  // v27v: refresh helper used by edit modal callbacks
  async function reloadTxns() {
    const { data } = await supabase
      .from('transactions')
      .select('*')
      .eq('portfolio_id', portfolioId)
      .order('trade_date', { ascending: false })
      .limit(300)
    setTxns(data ?? [])
  }

  const feeRows = buildFeeRows(txns)

  const filtered = (() => {
    if (filter.feeType) {
      return feeRows
        .filter(r => r._feeType === filter.feeType)
        .filter(r => !filter.search || r.instrument_id?.toLowerCase().includes(filter.search.toLowerCase()))
    }
    return txns.filter(t => {
      if (filter.action && t.action !== filter.action) return false
      if (filter.search && !t.instrument_id?.toLowerCase().includes(filter.search.toLowerCase()) && !t.notes?.toLowerCase().includes(filter.search.toLowerCase())) return false
      return true
    })
  })()

  // v27e: feeTotals built from per-row decomposition so the two new buckets
  // (otherRegulatory, otherStandalone) flow naturally. Headline `total` = sum
  // of t.fees = sum of all named + buckets, by construction in decomposeFees.
  const feeTotals = txns.reduce(
    (acc: any, t: any) => {
      const d = decomposeFees(t)
      acc.commission      += d.commission
      acc.vat             += d.vat
      acc.stamp           += d.stamp
      acc.exchange        += d.exchange
      acc.clearing        += d.clearing
      acc.sms             += d.sms
      acc.management      += d.management
      acc.otherRegulatory += d.otherRegulatory
      acc.otherStandalone += d.otherStandalone
      acc.total           += d.totalFees
      return acc
    },
    {
      commission: 0, vat: 0, stamp: 0, exchange: 0, clearing: 0,
      sms: 0, management: 0, otherRegulatory: 0, otherStandalone: 0, total: 0,
    }
  )

  // v21j: Excel export — Sheet 1: Summary, Sheet 2: Full transactions
  function downloadExcel() {
    const wb = XLSX.utils.book_new()

    // Sheet 1: Summary
    // v27e: TOTAL FEES headline is now an Excel formula referencing the
    // component cells (B6:B14). Fallback v= the same number for readers
    // that don't evaluate formulas. Summary fee section runs rows 6–15.
    const totalFromComponents =
      feeTotals.commission + feeTotals.vat + feeTotals.stamp +
      feeTotals.exchange + feeTotals.clearing + feeTotals.sms +
      feeTotals.otherRegulatory + feeTotals.management + feeTotals.otherStandalone
    const summaryData = [
      ['Portfolio', portfolio?.name ?? ''],
      ['Client', portfolio?.client?.name ?? ''],
      ['Export date', new Date().toLocaleDateString('en-GB')],
      [''],
      ['FEE SUMMARY', ''],
      ['Brokerage commission (₦)', feeTotals.commission],
      ['VAT on commission (₦)', feeTotals.vat],
      ['Contract stamp duty (₦)', feeTotals.stamp],
      ['NGX exchange levy (₦)', feeTotals.exchange],
      ['CSCS clearing fee (₦)', feeTotals.clearing],
      ['SMS charges (₦)', feeTotals.sms],
      ['Other regulatory charges (₦)', feeTotals.otherRegulatory],
      ['Management fees (₦)', feeTotals.management],
      ['Other standalone fees (₦)', feeTotals.otherStandalone],
      ['TOTAL FEES (₦)', { t: 'n', f: 'SUM(B6:B14)', v: totalFromComponents }],
      [''],
      ['TRANSACTION COUNTS', ''],
      ['Total transactions', txns.length],
      ['Buys', txns.filter(t => t.action === 'BUY').length],
      ['Sells', txns.filter(t => t.action === 'SELL').length],
      ['Income entries', txns.filter(t => t.action === 'INCOME').length],
      ['Fee entries', txns.filter(t => t.action === 'FEE').length],
      ['Transfers in', txns.filter(t => t.action === 'TRANSFER_IN').length],
      ['Transfers out', txns.filter(t => t.action === 'TRANSFER_OUT').length],
      [''],
      ['VOLUME SUMMARY', ''],
      ['Gross buys (₦)', txns.filter(t => t.action === 'BUY').reduce((s, t) => s + (t.gross_value || 0), 0)],
      ['Gross sells (₦)', txns.filter(t => t.action === 'SELL').reduce((s, t) => s + (t.gross_value || 0), 0)],
    ]
    const summaryWs = XLSX.utils.aoa_to_sheet(summaryData)
    summaryWs['!cols'] = [{ wch: 30 }, { wch: 20 }]
    XLSX.utils.book_append_sheet(wb, summaryWs, 'Summary')

    // Sheet 2: Full transactions
    // v27e: insert Other Regulatory Charges between SMS and Management Fee.
    // Append Other Standalone Fees after Management Fee. Net +2 columns.
    const headers = [
      'Date', 'Settlement Date', 'Action', 'Instrument', 'CN Number',
      'Quantity', 'Price (₦)', 'Gross Value (₦)', 'Amount (₦)',
      'Total Fees (₦)', 'Commission (₦)', 'VAT (₦)', 'Stamp Duty (₦)',
      'Exchange Levy (₦)', 'Clearing (₦)', 'SMS (₦)',
      'Other Regulatory Charges (₦)',
      'Management Fee (₦)',
      'Other Standalone Fees (₦)',
      'Broker', 'Notes',
    ]
    // v27e: pre-flight integrity check. Decompose every row, then assert:
    //   (a) named columns do not overshoot Total Fees (residual >= -0.01)
    //   (b) round-trip: namedSum + otherReg + otherStd === totalFees (within 0.01)
    // If any row fails, abort with a diagnostic alert listing the first 5 offenders.
    const decomposed = txns.map((t: any) => decomposeFees(t))
    const integrityErrors: string[] = []
    txns.forEach((t: any, i: number) => {
      const d = decomposed[i]
      const ref = `Row ${i + 1} ${t.trade_date} ${t.action} ${t.instrument_id ?? '—'}` +
                  ` (gross ₦${(t.gross_value ?? 0).toLocaleString()})`
      if (d.residual < -0.01) {
        integrityErrors.push(
          `${ref}: named fee columns sum to ₦${d.namedSum.toFixed(2)} ` +
          `but Total Fees is only ₦${d.totalFees.toFixed(2)}`
        )
      }
      const roundTrip = d.namedSum + d.otherRegulatory + d.otherStandalone
      if (Math.abs(roundTrip - d.totalFees) > 0.01) {
        integrityErrors.push(
          `${ref}: decomposed sum ₦${roundTrip.toFixed(2)} ≠ Total Fees ₦${d.totalFees.toFixed(2)}`
        )
      }
    })
    if (integrityErrors.length > 0) {
      const sample = integrityErrors.slice(0, 5).join('\n\n')
      const more   = integrityErrors.length > 5 ? `\n\n…and ${integrityErrors.length - 5} more.` : ''
      alert(
        `Excel export aborted — fee reconciliation failed on ${integrityErrors.length} row${integrityErrors.length === 1 ? '' : 's'}:\n\n${sample}${more}`
      )
      return
    }

    const txnRows = txns.map((t: any, i: number) => {
      const d = decomposed[i]
      return [
        t.trade_date ?? '',
        t.settlement_date ?? '',
        t.action ?? '',
        t.instrument_id ?? '',
        t.cn_number ?? '',
        t.quantity != null ? Number(t.quantity) : '',
        t.price != null ? Number(t.price) : '',
        t.gross_value != null ? Number(t.gross_value) : '',
        t.amount != null ? Number(t.amount) : '',
        d.totalFees,
        d.commission,
        d.vat,
        d.stamp,
        d.exchange,
        d.clearing,
        d.sms,
        d.otherRegulatory,
        d.management,
        d.otherStandalone,
        t.broker ?? '',
        t.notes ?? '',
      ]
    })
    const txnWs = XLSX.utils.aoa_to_sheet([headers, ...txnRows])
    // v27e: 21 columns total. Other Regulatory Charges + Other Standalone Fees
    // are wider (~26 chars label) than the existing fee columns.
    txnWs['!cols'] = [
      { wch: 12 }, { wch: 14 }, { wch: 12 }, { wch: 16 }, { wch: 14 },
      { wch: 12 }, { wch: 12 }, { wch: 16 }, { wch: 14 },
      { wch: 14 }, { wch: 14 }, { wch: 10 }, { wch: 14 },
      { wch: 14 }, { wch: 12 }, { wch: 10 },
      { wch: 26 },
      { wch: 16 },
      { wch: 24 },
      { wch: 16 }, { wch: 36 },
    ]
    XLSX.utils.book_append_sheet(wb, txnWs, 'Transactions')

    const clientName = portfolio?.client?.name ?? 'Portfolio'
    const portfolioName = portfolio?.name ?? 'Transactions'
    const today = new Date().toISOString().slice(0, 10)
    XLSX.writeFile(wb, `${clientName} - ${portfolioName} Transactions ${today}.xlsx`)
  }

  function getTxnsText(): string {
    const lines: string[] = []
    const totalBuys  = txns.filter(t => t.action === 'BUY').reduce((s, t) => s + (t.gross_value || 0), 0)
    const totalSells = txns.filter(t => t.action === 'SELL').reduce((s, t) => s + (t.gross_value || 0), 0)
    lines.push(`Total transactions: ${txns.length}`)
    lines.push(`Buys:  ${txns.filter(t=>t.action==='BUY').length}  (₦${(totalBuys/1e6).toFixed(2)}M gross)`)
    lines.push(`Sells: ${txns.filter(t=>t.action==='SELL').length}  (₦${(totalSells/1e6).toFixed(2)}M gross)`)
    lines.push(`Income entries: ${txns.filter(t=>t.action==='INCOME').length}`)
    lines.push(`Fee entries:    ${txns.filter(t=>t.action==='FEE').length}`)
    lines.push('')
    lines.push('── FEE SUMMARY ──────────────────────────────────────────')
    lines.push(`Brokerage commission:     ₦${feeTotals.commission.toLocaleString()}`)
    lines.push(`VAT on commission:        ₦${feeTotals.vat.toLocaleString()}`)
    lines.push(`Contract stamp duty:      ₦${feeTotals.stamp.toLocaleString()}`)
    lines.push(`NGX exchange levy:        ₦${feeTotals.exchange.toLocaleString()}`)
    lines.push(`CSCS clearing fee:        ₦${feeTotals.clearing.toLocaleString()}`)
    lines.push(`SMS charges:              ₦${feeTotals.sms.toLocaleString()}`)
    lines.push(`Other regulatory charges: ₦${feeTotals.otherRegulatory.toLocaleString()}`)
    lines.push(`Management fees:          ₦${feeTotals.management.toLocaleString()}`)
    lines.push(`Other standalone fees:    ₦${feeTotals.otherStandalone.toLocaleString()}`)
    lines.push(`TOTAL FEES:               ₦${feeTotals.total.toLocaleString()}`)
    lines.push('')
    lines.push('── TRANSACTION DETAIL ───────────────────────────────────')
    lines.push('Date       | Action | Instrument      | Qty           | Price     | Gross Value | Commission | Stamp    | Exch Fee | VAT     | Total Fees')
    lines.push('─'.repeat(130))
    filtered.forEach(t => {
      lines.push(
        `${t.trade_date} | ${(t.action).padEnd(6)} | ${(t.instrument_id||'—').padEnd(15)} | ${(t.quantity?Number(t.quantity).toLocaleString():'—').padEnd(13)} | ${t.price?'₦'+Number(t.price).toFixed(2):'—'.padEnd(8)} | ${t.gross_value?'₦'+(t.gross_value/1e6).toFixed(2)+'M':'—'.padEnd(10)} | ₦${(t.fee_commission||0).toLocaleString().padEnd(9)} | ₦${(t.fee_contract_stamp||0).toLocaleString().padEnd(7)} | ₦${(t.fee_exchange||0).toLocaleString().padEnd(7)} | ₦${(t.fee_vat||0).toLocaleString().padEnd(6)} | ₦${(t.fees||0).toLocaleString()}`
      )
    })
    return lines.join('\n')
  }

  async function copyText() {
    await navigator.clipboard.writeText(getTxnsText())
    setCopied(true)
    setTimeout(() => setCopied(false), 2500)
  }

  if (loading) {
    return (
      <div className="hybrid-page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', color: 'var(--text-3)', fontSize: 14 }}>
        Loading…
      </div>
    )
  }

  return (
    <main className="hybrid-page" style={{ padding: '32px 44px 64px', minHeight: '100vh' }}>
      {/* Page header */}
      <div className="page-head">
        <div>
          <div className="eyebrow" style={{ marginBottom: 10 }}>
            {portfolio?.client?.name} · {portfolio?.name}
          </div>
          <h1 className="hybrid-serif" style={{ fontSize: 36, fontWeight: 500, letterSpacing: '-0.005em', lineHeight: 1, color: 'var(--text)' }}>
            Transactions
          </h1>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn-h" onClick={copyText}>
            {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
          </button>
          {/* v21j: Excel export */}
          <button className="btn-h" onClick={downloadExcel}>
            <FileSpreadsheet size={12} /> Export Excel
          </button>
          <button className="btn-h btn-h-primary" onClick={() => setShowForm(!showForm)}>
            <Plus size={12} /> Enter trade
          </button>
        </div>
      </div>

      {/* Fee summary cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 18 }}>
        <div className="kpi-mini" style={{ borderTopColor: 'var(--gold)' }}>
          <div className="kpi-mini-label">Brokerage commission</div>
          <div className="kpi-mini-value" style={{ color: 'var(--gold)' }}>₦{feeTotals.commission.toLocaleString()}</div>
        </div>
        <div className="kpi-mini" style={{ borderTopColor: 'var(--warn)' }}>
          <div className="kpi-mini-label">Statutory charges</div>
          <div className="kpi-mini-value" style={{ color: 'var(--warn)' }}>
            ₦{(feeTotals.stamp + feeTotals.exchange + feeTotals.clearing + feeTotals.vat + feeTotals.sms).toLocaleString()}
          </div>
        </div>
        <div className="kpi-mini" style={{ borderTopColor: 'var(--sidebar-bg)' }}>
          <div className="kpi-mini-label">Management fees</div>
          <div className="kpi-mini-value" style={{ color: 'var(--sidebar-bg)' }}>₦{feeTotals.management.toLocaleString()}</div>
        </div>
        <div className="kpi-mini" style={{ borderTopColor: 'var(--neg)' }}>
          <div className="kpi-mini-label">Total fees paid</div>
          <div className="kpi-mini-value" style={{ color: 'var(--neg)' }}>₦{feeTotals.total.toLocaleString()}</div>
        </div>
      </div>

      {/* Statutory breakdown */}
      <div className="panel" style={{ marginBottom: 18 }}>
        <div className="panel-header">
          <div className="panel-title">Statutory charge breakdown</div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 14 }}>
          {[
            { label: 'VAT (7.5% of commission)',  value: feeTotals.vat      },
            { label: 'Contract stamp (0.08%)',    value: feeTotals.stamp    },
            { label: 'NGX exchange levy (0.3%)',  value: feeTotals.exchange },
            { label: 'CSCS clearing (0.3%)',      value: feeTotals.clearing },
            { label: 'SMS charges',               value: feeTotals.sms      },
            { label: 'Subtotal statutory',        value: feeTotals.vat + feeTotals.stamp + feeTotals.exchange + feeTotals.clearing + feeTotals.sms },
          ].map((item, idx, arr) => (
            <div key={item.label} style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 10, color: 'var(--text-3)', marginBottom: 8, lineHeight: 1.35, letterSpacing: '0.02em' }}>
                {item.label}
              </div>
              <div style={{ fontSize: 15, fontFamily: 'var(--font-mono)', fontWeight: 500, color: idx === arr.length - 1 ? 'var(--text)' : 'var(--text-2)' }}>
                ₦{item.value.toLocaleString()}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Trade entry form */}
      {showForm && (
        <form onSubmit={submitTrade} className="panel" style={{ marginBottom: 18, borderColor: 'rgba(176, 139, 62, 0.3)' }}>
          <div className="panel-header">
            <div className="panel-title">New trade entry</div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 16 }}>
            <FormField label="Trade date" required>
              <input type="date" value={form.trade_date} onChange={set('trade_date')} required className="input-h" />
            </FormField>
            <FormField label="Action" required>
              <select value={form.action} onChange={set('action')} className="select-h">
                {['BUY','SELL','INCOME','FEE','TRANSFER_IN','TRANSFER_OUT'].map(a => <option key={a}>{a}</option>)}
              </select>
            </FormField>
            <FormField label="Instrument">
              <select value={form.instrument_id} onChange={set('instrument_id')} className="select-h">
                <option value="">Select instrument…</option>
                {instruments.map(i => <option key={i.instrument_id} value={i.instrument_id}>{i.name}</option>)}
              </select>
            </FormField>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 16, marginBottom: 16 }}>
            {['BUY','SELL'].includes(form.action) && (
              <>
                <FormField label="Quantity">
                  <input type="number" value={form.quantity} onChange={set('quantity')} placeholder="0" className="input-h input-h-mono" step="any" />
                </FormField>
                <FormField label="Price (₦)">
                  <input type="number" value={form.price} onChange={set('price')} placeholder="0.00" className="input-h input-h-mono" step="0.0001" />
                </FormField>
              </>
            )}
            {['INCOME','FEE'].includes(form.action) && (
              <FormField label="Amount (₦)">
                <input type="number" value={form.amount} onChange={set('amount')} placeholder="0" className="input-h input-h-mono" />
              </FormField>
            )}
            <FormField label="Total fees (₦)">
              <input type="number" value={form.fees} onChange={set('fees')} placeholder="0" className="input-h input-h-mono" />
            </FormField>
            {form.action === 'INCOME' && (
              <FormField label="Income category">
                <select value={form.income_category} onChange={set('income_category')} className="select-h">
                  <option value="">Select…</option>
                  {['Interest','Coupon','Dividend','Other'].map(c => <option key={c}>{c}</option>)}
                </select>
              </FormField>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16, marginBottom: 16 }}>
            <FormField label="Broker"><input value={form.broker} onChange={set('broker')} className="input-h" /></FormField>
            <FormField label="Counterparty"><input value={form.counterparty} onChange={set('counterparty')} className="input-h" /></FormField>
            <FormField label="Maturity date"><input type="date" value={form.maturity_date} onChange={set('maturity_date')} className="input-h" /></FormField>
          </div>
          <div style={{ marginBottom: 16 }}>
            <FormField label="Notes"><input value={form.notes} onChange={set('notes')} className="input-h" /></FormField>
          </div>
          {form.action === 'BUY' && form.quantity && form.price && (
            <div className="alert-h alert-h-info" style={{ marginBottom: 16, fontSize: 12 }}>
              Gross value: <strong style={{ fontFamily: 'var(--font-mono)', marginLeft: 4 }}>
                ₦{(Number(form.quantity) * Number(form.price)).toLocaleString()}
              </strong>
            </div>
          )}
          <div style={{ display: 'flex', gap: 10 }}>
            <button type="submit" disabled={saving} className="btn-h btn-h-primary">
              {saving ? 'Saving…' : 'Submit trade'}
            </button>
            <button type="button" onClick={() => setShowForm(false)} className="btn-h">Cancel</button>
          </div>
        </form>
      )}

      {/* Filters row */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', marginBottom: 12 }}>
        <div style={{ position: 'relative', width: 200 }}>
          <Search size={12} style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }} />
          <input
            value={filter.search}
            onChange={e => setFilter(f => ({ ...f, search: e.target.value }))}
            placeholder="Search by instrument…"
            className="input-h input-h-sm"
            style={{ paddingLeft: 30 }}
          />
        </div>
        <select
          value={filter.action}
          onChange={e => setFilter(f => ({ ...f, action: e.target.value, feeType: '' }))}
          className="select-h"
          style={{ width: 160, padding: '5px 32px 5px 9px', fontSize: 12 }}
        >
          <option value="">All actions</option>
          {['BUY','SELL','INCOME','FEE','TRANSFER_IN','TRANSFER_OUT'].map(a => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
        <select
          value={filter.feeType}
          onChange={e => setFilter(f => ({ ...f, feeType: e.target.value, action: '' }))}
          className="select-h"
          style={{ width: 200, padding: '5px 32px 5px 9px', fontSize: 12 }}
        >
          <option value="">All fee types</option>
          {FEE_TYPES.map(ft => <option key={ft} value={ft}>{ft}</option>)}
        </select>
        {(filter.action || filter.feeType || filter.search) && (
          <button onClick={() => setFilter({ action: '', search: '', feeType: '' })} className="btn-h" style={{ fontSize: 11, padding: '4px 10px' }}>
            Clear filters
          </button>
        )}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto' }}>
          <span style={{ fontSize: 10, color: 'var(--text-3)', marginRight: 4 }}>Fee columns:</span>
          {(['total', 'breakdown'] as FeeView[]).map(v => (
            <button
              key={v}
              onClick={() => setFeeView(v)}
              style={{
                padding: '4px 11px', borderRadius: 2, fontSize: 11, fontWeight: 500,
                textTransform: 'capitalize' as const, cursor: 'pointer', transition: 'all 0.15s',
                fontFamily: 'var(--font-sans)',
                ...(feeView === v
                  ? { background: 'var(--gold-soft)', color: 'var(--gold)', border: '1px solid rgba(176, 139, 62, 0.3)' }
                  : { background: 'transparent', color: 'var(--text-3)', border: '1px solid var(--border)' }),
              }}
            >
              {v}
            </button>
          ))}
        </div>
        <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
          {filtered.length} record{filtered.length !== 1 ? 's' : ''}
          {filter.feeType && <span style={{ color: 'var(--gold)', marginLeft: 4 }}>— {filter.feeType}</span>}
        </span>
      </div>

      {filter.feeType && (
        <div className="alert-h alert-h-info" style={{ marginBottom: 12, fontSize: 11 }}>
          <Info size={12} style={{ marginTop: 1, flexShrink: 0 }} />
          <span>
            Showing <strong>{filter.feeType}</strong> charges extracted from BUY/SELL transactions.
            Each row represents the {filter.feeType.toLowerCase()} component of the parent trade.
          </span>
        </div>
      )}

      {/* Transaction table */}
      <div className="panel" style={{ padding: 0, overflowX: 'auto' }}>
        {filtered.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 0', fontSize: 12, color: 'var(--text-3)' }}>
            No records match the current filter.
          </div>
        ) : (
          <table className="h-table" style={{ minWidth: feeView === 'breakdown' ? 1100 : 800 }}>
            <thead>
              <tr>
                <th>Date</th>
                <th>Action</th>
                <th>Instrument</th>
                <th>{filter.feeType ? 'Fee type' : 'Qty / Amount'}</th>
                <th className="num">Price (₦)</th>
                <th className="num">Gross value</th>
                {filter.feeType ? (
                  <th className="num" style={{ color: 'var(--gold)' }}>Fee amount</th>
                ) : feeView === 'total' ? (
                  <th className="num">Total fees</th>
                ) : (
                  <>
                    <th className="num" style={{ color: 'var(--gold)' }}>Commission</th>
                    <th className="num" style={{ color: 'var(--warn)' }}>VAT</th>
                    <th className="num" style={{ color: 'var(--warn)' }}>Stamp</th>
                    <th className="num" style={{ color: 'var(--warn)' }}>Exch fee</th>
                    <th className="num" style={{ color: 'var(--warn)' }}>Clearing</th>
                    <th className="num" style={{ color: 'var(--sidebar-bg)' }}>Mgmt fee</th>
                    <th className="num">Total</th>
                  </>
                )}
                <th>Notes</th>
                {/* v27v */}<th style={{ width: 70 }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(t => (
                <tr key={t._virtual ? `${t.id}-${t._feeType}` : t.id} style={t._virtual ? { background: 'rgba(176, 139, 62, 0.04)' } : {}}>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{t.trade_date}</td>
                  <td><span className={`pill ${ACTION_PILL[t.action] ?? 'pill-hold'}`}>{t.action}</span></td>
                  <td>
                    {/* v27ba: when instrument_id exists, become click-through to fundamentals page.
                        FEE rows with null instrument_id render plain em-dash. */}
                    {t.instrument_id ? (
                      <Link
                        href={`/instrument/${t.instrument_id}`}
                        style={{ textDecoration: 'none', color: 'inherit' }}
                      >
                        <div style={{ fontWeight: 500 }}>{t.instrument_id}</div>
                      </Link>
                    ) : (
                      <div style={{ fontWeight: 500 }}>—</div>
                    )}
                    {t.income_category && <div style={{ fontSize: 10, color: 'var(--text-3)' }}>{t.income_category}</div>}
                  </td>
                  <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                    {filter.feeType
                      ? <span style={{ color: 'var(--gold)', fontSize: 11 }}>{t._feeType}</span>
                      : t.quantity ? Number(t.quantity).toLocaleString() : t.amount ? fmt.ngnM(t.amount) : '—'}
                  </td>
                  <td className="num" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                    {t.price ? `₦${Number(t.price).toFixed(2)}` : '—'}
                  </td>
                  <td className="num" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                    {t.gross_value ? fmt.ngnM(t.gross_value) : t.amount ? fmt.ngnM(t.amount) : '—'}
                  </td>
                  {filter.feeType ? (
                    <td className="num" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--gold)', fontWeight: 500 }}>
                      ₦{Number(t._feeAmount).toLocaleString()}
                    </td>
                  ) : feeView === 'total' ? (
                    <td className="num" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-3)' }}>
                      {t.fees ? `₦${Number(t.fees).toLocaleString()}` : '—'}
                    </td>
                  ) : (
                    <>
                      <td className="num" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--gold)' }}>{t.fee_commission     ? `₦${Number(t.fee_commission).toLocaleString()}`      : '—'}</td>
                      <td className="num" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--warn)' }}>{t.fee_vat            ? `₦${Number(t.fee_vat).toFixed(0)}`                    : '—'}</td>
                      <td className="num" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--warn)' }}>{t.fee_contract_stamp ? `₦${Number(t.fee_contract_stamp).toFixed(0)}`          : '—'}</td>
                      <td className="num" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--warn)' }}>{t.fee_exchange       ? `₦${Number(t.fee_exchange).toFixed(0)}`                : '—'}</td>
                      <td className="num" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--warn)' }}>{t.fee_clearing       ? `₦${Number(t.fee_clearing).toFixed(0)}`                : '—'}</td>
                      <td className="num" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--sidebar-bg)' }}>{t.fee_management ? `₦${Number(t.fee_management).toLocaleString()}`      : '—'}</td>
                      <td className="num" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--neg)', fontWeight: 500 }}>{t.fees ? `₦${Number(t.fees).toLocaleString()}` : '—'}</td>
                    </>
                  )}
                  <td style={{ fontSize: 11, color: 'var(--text-3)', maxWidth: 160, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {t.notes || '—'}
                  </td>
                  {/* v27v: Edit button per row (hidden for virtual fee-decomposition rows) */}
                  <td>
                    {!t._virtual && (
                      <button
                        onClick={() => setEditingTxn(t)}
                        className="btn-h"
                        style={{ padding: '4px 8px', fontSize: 11 }}
                        title="Edit transaction"
                      >
                        <Edit2 size={11} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {/* v27v: Edit transaction modal — rendered when a row is selected */}
      {editingTxn && (
        <EditTransactionModal
          transaction={editingTxn}
          instruments={instruments}
          onClose={() => setEditingTxn(null)}
          onSaved={() => { reloadTxns() }}
          onDeleted={() => { reloadTxns() }}
        />
      )}
    </main>
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
