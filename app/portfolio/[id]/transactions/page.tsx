'use client'
import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { fmt } from '@/lib/portfolio'
import { ArrowLeft, Plus, Search, ChevronDown, ChevronRight } from 'lucide-react'
import PageActions from '@/components/shared/PageActions'

const ACTION_COLORS: Record<string, string> = {
  BUY: 'badge-buy', SELL: 'badge-sell', INCOME: 'badge-ntb',
  FEE: 'badge-hold', TRANSFER_IN: 'badge-ok', TRANSFER_OUT: 'badge-breach',
}

type FeeView = 'total' | 'breakdown'

export default function TransactionsPage() {
  const { id: portfolioId } = useParams() as { id: string }
  const [portfolio,    setPortfolio]    = useState<any>(null)
  const [txns,         setTxns]         = useState<any[]>([])
  const [instruments,  setInstruments]  = useState<any[]>([])
  const [loading,      setLoading]      = useState(true)
  const [showForm,     setShowForm]     = useState(false)
  const [saving,       setSaving]       = useState(false)
  const [filter,       setFilter]       = useState({ action: '', search: '' })
  const [feeView,      setFeeView]      = useState<FeeView>('total')
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

  const filtered = txns.filter(t => {
    if (filter.action && t.action !== filter.action) return false
    if (filter.search && !t.instrument_id?.toLowerCase().includes(filter.search.toLowerCase()) && !t.notes?.toLowerCase().includes(filter.search.toLowerCase())) return false
    return true
  })

  // Fee summary totals
  const feeTotals = {
    commission:    txns.reduce((s, t) => s + (t.fee_commission    ?? 0), 0),
    vat:           txns.reduce((s, t) => s + (t.fee_vat           ?? 0), 0),
    stamp:         txns.reduce((s, t) => s + (t.fee_contract_stamp?? 0), 0),
    exchange:      txns.reduce((s, t) => s + (t.fee_exchange      ?? 0), 0),
    clearing:      txns.reduce((s, t) => s + (t.fee_clearing      ?? 0), 0),
    sms:           txns.reduce((s, t) => s + (t.fee_sms           ?? 0), 0),
    management:    txns.reduce((s, t) => s + (t.fee_management    ?? 0), 0),
    total:         txns.reduce((s, t) => s + (t.fees              ?? 0), 0),
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
    lines.push(`Brokerage commission:  ₦${feeTotals.commission.toLocaleString()}`)
    lines.push(`VAT on commission:     ₦${feeTotals.vat.toLocaleString()}`)
    lines.push(`Contract stamp duty:   ₦${feeTotals.stamp.toLocaleString()}`)
    lines.push(`NGX exchange levy:     ₦${feeTotals.exchange.toLocaleString()}`)
    lines.push(`CSCS clearing fee:     ₦${feeTotals.clearing.toLocaleString()}`)
    lines.push(`SMS charges:           ₦${feeTotals.sms.toLocaleString()}`)
    lines.push(`Management fees:       ₦${feeTotals.management.toLocaleString()}`)
    lines.push(`TOTAL FEES:            ₦${feeTotals.total.toLocaleString()}`)
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

  if (loading) return <div className="flex items-center justify-center h-64 text-[#555d72] text-xs">Loading…</div>

  return (
    <div>
      {/* Header */}
      <div className="px-8 py-5 border-b border-white/[0.07] bg-[#13161d] flex items-center gap-4">
        <Link href={`/portfolio/${portfolioId}`} className="flex items-center gap-1.5 text-xs text-[#8a91a8] hover:text-[#e8eaf0] transition-colors">
          <ArrowLeft size={13} /> {portfolio?.name}
        </Link>
        <div className="w-px h-4 bg-white/10" />
        <h1 className="text-base font-semibold">Transactions</h1>
        <div className="ml-auto flex items-center gap-3">
          <PageActions pageTitle="Transaction History" portfolioName={portfolio?.name ?? ''} getText={getTxnsText} />
          <button onClick={() => setShowForm(!showForm)} className="flex items-center gap-2 bg-[#a78bfa] text-white px-4 py-2 rounded-lg text-xs font-medium hover:bg-[#9b87e8] transition-colors">
            <Plus size={13} /> Enter trade
          </button>
        </div>
      </div>

      <div className="px-8 py-6 max-w-7xl">

        {/* Fee summary cards */}
        <div className="grid grid-cols-4 gap-3 mb-5">
          {[
            { label: 'Brokerage commission', value: feeTotals.commission, color: '#a78bfa' },
            { label: 'Statutory charges',   value: feeTotals.stamp + feeTotals.exchange + feeTotals.clearing + feeTotals.vat + feeTotals.sms, color: '#fb923c' },
            { label: 'Management fees',     value: feeTotals.management, color: '#60a5fa' },
            { label: 'Total fees paid',      value: feeTotals.total, color: '#ff5c7a' },
          ].map(item => (
            <div key={item.label} className="tw-card py-3 px-4" style={{ borderTop: `2px solid ${item.color}` }}>
              <div className="text-[10px] text-[#555d72] uppercase tracking-wider mb-1">{item.label}</div>
              <div className="text-lg font-bold font-mono" style={{ color: item.color }}>
                ₦{item.value.toLocaleString()}
              </div>
            </div>
          ))}
        </div>

        {/* Fee breakdown detail */}
        <div className="tw-card mb-5 py-3">
          <div className="flex items-center justify-between mb-3">
            <div className="text-xs font-semibold uppercase tracking-widest text-[#555d72]">Statutory charge breakdown</div>
          </div>
          <div className="grid grid-cols-6 gap-3">
            {[
              { label: 'VAT (7.5% of commission)', value: feeTotals.vat },
              { label: 'Contract stamp (0.08%)',    value: feeTotals.stamp },
              { label: 'NGX exchange levy (0.3%)',  value: feeTotals.exchange },
              { label: 'CSCS clearing (0.3%)',      value: feeTotals.clearing },
              { label: 'SMS charges',               value: feeTotals.sms },
              { label: 'Subtotal statutory',        value: feeTotals.vat + feeTotals.stamp + feeTotals.exchange + feeTotals.clearing + feeTotals.sms },
            ].map(item => (
              <div key={item.label} className="text-center">
                <div className="text-[10px] text-[#555d72] mb-1 leading-tight">{item.label}</div>
                <div className="text-sm font-mono font-semibold text-[#8a91a8]">₦{item.value.toLocaleString()}</div>
              </div>
            ))}
          </div>
        </div>

        {/* Trade entry form */}
        {showForm && (
          <form onSubmit={submitTrade} className="tw-card mb-5 border-[#a78bfa]/20">
            <div className="text-xs font-semibold uppercase tracking-widest text-[#555d72] mb-4">New trade entry</div>
            <div className="grid grid-cols-3 gap-4 mb-4">
              <div>
                <label className="block text-xs text-[#8a91a8] mb-1.5">Trade date <span className="text-[#ff5c7a]">*</span></label>
                <input type="date" value={form.trade_date} onChange={set('trade_date')} required className="tw-input" />
              </div>
              <div>
                <label className="block text-xs text-[#8a91a8] mb-1.5">Action <span className="text-[#ff5c7a]">*</span></label>
                <select value={form.action} onChange={set('action')} className="tw-select">
                  {['BUY','SELL','INCOME','FEE','TRANSFER_IN','TRANSFER_OUT'].map(a => <option key={a}>{a}</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-[#8a91a8] mb-1.5">Instrument</label>
                <select value={form.instrument_id} onChange={set('instrument_id')} className="tw-select">
                  <option value="">Select instrument…</option>
                  {instruments.map(i => <option key={i.instrument_id} value={i.instrument_id}>{i.name}</option>)}
                </select>
              </div>
            </div>
            <div className="grid grid-cols-4 gap-4 mb-4">
              {['BUY','SELL'].includes(form.action) && <>
                <div>
                  <label className="block text-xs text-[#8a91a8] mb-1.5">Quantity</label>
                  <input type="number" value={form.quantity} onChange={set('quantity')} placeholder="0" className="tw-input font-mono" step="any" />
                </div>
                <div>
                  <label className="block text-xs text-[#8a91a8] mb-1.5">Price (₦)</label>
                  <input type="number" value={form.price} onChange={set('price')} placeholder="0.00" className="tw-input font-mono" step="0.0001" />
                </div>
              </>}
              {['INCOME','FEE'].includes(form.action) && (
                <div>
                  <label className="block text-xs text-[#8a91a8] mb-1.5">Amount (₦)</label>
                  <input type="number" value={form.amount} onChange={set('amount')} placeholder="0" className="tw-input font-mono" />
                </div>
              )}
              <div>
                <label className="block text-xs text-[#8a91a8] mb-1.5">Total fees (₦)</label>
                <input type="number" value={form.fees} onChange={set('fees')} placeholder="0" className="tw-input font-mono" />
              </div>
              {form.action === 'INCOME' && (
                <div>
                  <label className="block text-xs text-[#8a91a8] mb-1.5">Income category</label>
                  <select value={form.income_category} onChange={set('income_category')} className="tw-select">
                    <option value="">Select…</option>
                    {['Interest','Coupon','Dividend','Other'].map(c => <option key={c}>{c}</option>)}
                  </select>
                </div>
              )}
            </div>
            <div className="grid grid-cols-3 gap-4 mb-4">
              <div><label className="block text-xs text-[#8a91a8] mb-1.5">Broker</label><input value={form.broker} onChange={set('broker')} className="tw-input" /></div>
              <div><label className="block text-xs text-[#8a91a8] mb-1.5">Counterparty</label><input value={form.counterparty} onChange={set('counterparty')} className="tw-input" /></div>
              <div><label className="block text-xs text-[#8a91a8] mb-1.5">Maturity date</label><input type="date" value={form.maturity_date} onChange={set('maturity_date')} className="tw-input" /></div>
            </div>
            <div className="mb-4"><label className="block text-xs text-[#8a91a8] mb-1.5">Notes</label><input value={form.notes} onChange={set('notes')} className="tw-input" /></div>
            {form.action === 'BUY' && form.quantity && form.price && (
              <div className="mb-4 px-3 py-2 bg-[#a78bfa]/10 rounded-lg text-xs text-[#a78bfa]">
                Gross value: ₦{(Number(form.quantity) * Number(form.price)).toLocaleString()}
              </div>
            )}
            <div className="flex gap-3">
              <button type="submit" disabled={saving} className="flex items-center gap-2 bg-[#a78bfa] text-white px-5 py-2 rounded-lg text-xs font-medium hover:bg-[#9b87e8] disabled:opacity-50 transition-colors">
                {saving ? 'Saving…' : 'Submit trade'}
              </button>
              <button type="button" onClick={() => setShowForm(false)} className="px-4 py-2 border border-white/10 rounded-lg text-xs text-[#8a91a8] hover:text-[#e8eaf0] transition-colors">Cancel</button>
            </div>
          </form>
        )}

        {/* Filters + fee view toggle */}
        <div className="flex gap-3 mb-4 items-center">
          <div className="relative flex-1 max-w-xs">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#555d72]" />
            <input value={filter.search} onChange={e => setFilter(f => ({ ...f, search: e.target.value }))} placeholder="Search by instrument…" className="tw-input pl-8 py-1.5 text-xs" />
          </div>
          <select value={filter.action} onChange={e => setFilter(f => ({ ...f, action: e.target.value }))} className="tw-select py-1.5 text-xs w-36">
            <option value="">All actions</option>
            {['BUY','SELL','INCOME','FEE','TRANSFER_IN','TRANSFER_OUT'].map(a => <option key={a}>{a}</option>)}
          </select>
          <div className="flex items-center gap-1 ml-auto">
            <span className="text-[10px] text-[#555d72] mr-1">Fee columns:</span>
            {(['total', 'breakdown'] as FeeView[]).map(v => (
              <button key={v} onClick={() => setFeeView(v)}
                className="px-2.5 py-1 rounded text-[11px] font-medium transition-all capitalize"
                style={feeView === v
                  ? { background: '#a78bfa20', color: '#a78bfa', border: '1px solid #a78bfa40' }
                  : { background: 'transparent', color: '#555d72', border: '1px solid rgba(255,255,255,0.07)' }}>
                {v}
              </button>
            ))}
          </div>
          <span className="text-xs text-[#555d72]">{filtered.length} records</span>
        </div>

        {/* Transaction table */}
        <div className="tw-card p-0 overflow-x-auto">
          {filtered.length === 0 ? (
            <div className="text-center py-10 text-xs text-[#555d72]">No transactions yet.</div>
          ) : (
            <table className="tw-table w-full" style={{ minWidth: feeView === 'breakdown' ? 1100 : 800 }}>
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Action</th>
                  <th>Instrument</th>
                  <th>Qty / Amount</th>
                  <th>Price (₦)</th>
                  <th>Gross value</th>
                  {feeView === 'total' ? (
                    <th>Total fees</th>
                  ) : (
                    <>
                      <th className="text-[#a78bfa]">Commission</th>
                      <th className="text-[#fb923c]">VAT</th>
                      <th className="text-[#fb923c]">Stamp</th>
                      <th className="text-[#fb923c]">Exch fee</th>
                      <th className="text-[#fb923c]">Clearing</th>
                      <th className="text-[#60a5fa]">Mgmt fee</th>
                      <th>Total</th>
                    </>
                  )}
                  <th>Notes</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(t => (
                  <tr key={t.id}>
                    <td className="font-mono text-[11px]">{t.trade_date}</td>
                    <td><span className={`badge ${ACTION_COLORS[t.action] ?? 'badge-hold'}`}>{t.action}</span></td>
                    <td>
                      <div className="font-medium">{t.instrument_id || '—'}</div>
                      {t.income_category && <div className="text-[10px] text-[#555d72]">{t.income_category}</div>}
                    </td>
                    <td className="font-mono text-xs">
                      {t.quantity ? Number(t.quantity).toLocaleString() : t.amount ? fmt.ngnM(t.amount) : '—'}
                    </td>
                    <td className="font-mono text-xs">{t.price ? `₦${Number(t.price).toFixed(2)}` : '—'}</td>
                    <td className="font-mono text-xs">
                      {t.gross_value ? fmt.ngnM(t.gross_value) : t.amount ? fmt.ngnM(t.amount) : '—'}
                    </td>
                    {feeView === 'total' ? (
                      <td className="font-mono text-xs text-[#555d72]">
                        {t.fees ? `₦${Number(t.fees).toLocaleString()}` : '—'}
                      </td>
                    ) : (
                      <>
                        <td className="font-mono text-xs text-[#a78bfa]">{t.fee_commission ? `₦${Number(t.fee_commission).toLocaleString()}` : '—'}</td>
                        <td className="font-mono text-xs text-[#fb923c]">{t.fee_vat ? `₦${Number(t.fee_vat).toFixed(0)}` : '—'}</td>
                        <td className="font-mono text-xs text-[#fb923c]">{t.fee_contract_stamp ? `₦${Number(t.fee_contract_stamp).toFixed(0)}` : '—'}</td>
                        <td className="font-mono text-xs text-[#fb923c]">{t.fee_exchange ? `₦${Number(t.fee_exchange).toFixed(0)}` : '—'}</td>
                        <td className="font-mono text-xs text-[#fb923c]">{t.fee_clearing ? `₦${Number(t.fee_clearing).toFixed(0)}` : '—'}</td>
                        <td className="font-mono text-xs text-[#60a5fa]">{t.fee_management ? `₦${Number(t.fee_management).toLocaleString()}` : '—'}</td>
                        <td className="font-mono text-xs text-[#ff5c7a]">{t.fees ? `₦${Number(t.fees).toLocaleString()}` : '—'}</td>
                      </>
                    )}
                    <td className="text-[11px] text-[#555d72] max-w-[160px] truncate">{t.notes || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
