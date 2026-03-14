'use client'
import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { fmt } from '@/lib/portfolio'
import { ArrowLeft, Plus, Search } from 'lucide-react'
import PageActions from '@/components/shared/PageActions'

const ACTION_COLORS: Record<string, string> = {
  BUY: 'badge-buy', SELL: 'badge-sell', INCOME: 'badge-ntb',
  FEE: 'badge-hold', TRANSFER_IN: 'badge-ok', TRANSFER_OUT: 'badge-breach',
}

export default function TransactionsPage() {
  const { id: portfolioId } = useParams() as { id: string }
  const [portfolio, setPortfolio] = useState<any>(null)
  const [txns, setTxns] = useState<any[]>([])
  const [instruments, setInstruments] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [showForm, setShowForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [filter, setFilter] = useState({ action: '', search: '' })
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
        supabase.from('transactions').select('*').eq('portfolio_id', portfolioId).order('trade_date', { ascending: false }).limit(200),
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
    const { error } = await supabase.from('transactions').insert({
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
    if (!error) {
      setShowForm(false)
      setForm(f => ({ ...f, instrument_id: '', quantity: '', price: '', amount: '', fees: '0', income_category: '', maturity_date: '', broker: '', counterparty: '', notes: '' }))
      const { data } = await supabase.from('transactions').select('*').eq('portfolio_id', portfolioId).order('trade_date', { ascending: false }).limit(200)
      setTxns(data ?? [])
    }
    setSaving(false)
  }

  function getTxnsText(): string {
    const lines: string[] = []
    const totalBuys  = txns.filter(t => t.action === 'BUY').reduce((s, t) => s + (t.gross_value || 0), 0)
    const totalSells = txns.filter(t => t.action === 'SELL').reduce((s, t) => s + (t.gross_value || 0), 0)
    const totalFees  = txns.reduce((s, t) => s + (t.fees || 0), 0)
    lines.push(`Total transactions: ${txns.length}`)
    lines.push(`Buys: ${txns.filter(t=>t.action==='BUY').length} (₦${(totalBuys/1e6).toFixed(2)}M gross)`)
    lines.push(`Sells: ${txns.filter(t=>t.action==='SELL').length} (₦${(totalSells/1e6).toFixed(2)}M gross)`)
    lines.push(`Income entries: ${txns.filter(t=>t.action==='INCOME').length}`)
    lines.push(`Fee entries: ${txns.filter(t=>t.action==='FEE').length}`)
    lines.push(`Total fees paid: ₦${totalFees.toLocaleString()}`)
    lines.push('')
    lines.push('Date       | Action         | Instrument      | Quantity        | Price       | Gross Value | Fees')
    lines.push('─'.repeat(100))
    filtered.forEach(t => {
      lines.push(
        `${t.trade_date} | ${(t.action).padEnd(14)} | ${(t.instrument_id || '—').padEnd(15)} | ${(t.quantity ? Number(t.quantity).toLocaleString() : t.amount ? fmt.ngnM(t.amount) : '—').padEnd(15)} | ${t.price ? '₦' + Number(t.price).toFixed(2) : '—'.padEnd(10)} | ${t.gross_value ? '₦' + (t.gross_value/1e6).toFixed(2) + 'M' : '—'.padEnd(10)} | ${t.fees ? '₦' + Number(t.fees).toLocaleString() : '—'}`
      )
    })
    return lines.join('\n')
  }

  const filtered = txns.filter(t => {
    if (filter.action && t.action !== filter.action) return false
    if (filter.search && !t.instrument_id?.toLowerCase().includes(filter.search.toLowerCase()) && !t.notes?.toLowerCase().includes(filter.search.toLowerCase())) return false
    return true
  })

  if (loading) return <div className="flex items-center justify-center h-64 text-[#555d72] text-xs">Loading…</div>

  return (
    <div>
      <div className="px-8 py-5 border-b border-white/[0.07] bg-[#13161d] flex items-center gap-4">
        <Link href={`/portfolio/${portfolioId}`} className="flex items-center gap-1.5 text-xs text-[#8a91a8] hover:text-[#e8eaf0] transition-colors">
          <ArrowLeft size={13} /> {portfolio?.name}
        </Link>
        <div className="w-px h-4 bg-white/10" />
        <h1 className="text-base font-semibold">Transactions</h1>
        <div className="ml-auto flex items-center gap-3">
          <PageActions
            pageTitle="Transaction History"
            portfolioName={portfolio?.name ?? ''}
            getText={getTxnsText}
          />
          <button onClick={() => setShowForm(!showForm)} className="flex items-center gap-2 bg-[#a78bfa] text-white px-4 py-2 rounded-lg text-xs font-medium hover:bg-[#9b87e8] transition-colors">
            <Plus size={13} /> Enter trade
          </button>
        </div>
      </div>

      <div className="px-8 py-6 max-w-5xl">
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
                <label className="block text-xs text-[#8a91a8] mb-1.5">Fees (₦)</label>
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
              <div>
                <label className="block text-xs text-[#8a91a8] mb-1.5">Broker</label>
                <input value={form.broker} onChange={set('broker')} placeholder="e.g. Stanbic IBTC" className="tw-input" />
              </div>
              <div>
                <label className="block text-xs text-[#8a91a8] mb-1.5">Counterparty</label>
                <input value={form.counterparty} onChange={set('counterparty')} placeholder="e.g. CBN" className="tw-input" />
              </div>
              <div>
                <label className="block text-xs text-[#8a91a8] mb-1.5">Maturity date</label>
                <input type="date" value={form.maturity_date} onChange={set('maturity_date')} className="tw-input" />
              </div>
            </div>
            <div className="mb-4">
              <label className="block text-xs text-[#8a91a8] mb-1.5">Notes</label>
              <input value={form.notes} onChange={set('notes')} placeholder="Optional notes" className="tw-input" />
            </div>
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

        <div className="flex gap-3 mb-4">
          <div className="relative flex-1 max-w-xs">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#555d72]" />
            <input value={filter.search} onChange={e => setFilter(f => ({ ...f, search: e.target.value }))} placeholder="Search by instrument…" className="tw-input pl-8 py-1.5 text-xs" />
          </div>
          <select value={filter.action} onChange={e => setFilter(f => ({ ...f, action: e.target.value }))} className="tw-select py-1.5 text-xs w-36">
            <option value="">All actions</option>
            {['BUY','SELL','INCOME','FEE','TRANSFER_IN','TRANSFER_OUT'].map(a => <option key={a}>{a}</option>)}
          </select>
          <span className="text-xs text-[#555d72] flex items-center">{filtered.length} record{filtered.length !== 1 ? 's' : ''}</span>
        </div>

        <div className="tw-card p-0 overflow-hidden">
          {filtered.length === 0 ? (
            <div className="text-center py-10 text-xs text-[#555d72]">No transactions yet. Click "Enter trade" to add the first one.</div>
          ) : (
            <table className="tw-table w-full">
              <thead><tr><th>Date</th><th>Action</th><th>Instrument</th><th>Qty</th><th>Price (₦)</th><th>Gross value</th><th>Fees</th><th>Notes</th></tr></thead>
              <tbody>
                {filtered.map(t => (
                  <tr key={t.id}>
                    <td className="font-mono text-[11px]">{t.trade_date}</td>
                    <td><span className={`badge ${ACTION_COLORS[t.action] ?? 'badge-hold'}`}>{t.action}</span></td>
                    <td>
                      <div className="font-medium">{t.instrument_id || '—'}</div>
                      {t.income_category && <div className="text-[10px] text-[#555d72]">{t.income_category}</div>}
                    </td>
                    <td className="font-mono">{t.quantity ? Number(t.quantity).toLocaleString() : t.amount ? fmt.ngnM(t.amount) : '—'}</td>
                    <td className="font-mono">{t.price ? `₦${Number(t.price).toFixed(4)}` : '—'}</td>
                    <td className="font-mono">{t.gross_value ? fmt.ngnM(t.gross_value) : t.amount ? fmt.ngnM(t.amount) : '—'}</td>
                    <td className="font-mono text-[#555d72]">{t.fees ? `₦${Number(t.fees).toLocaleString()}` : '—'}</td>
                    <td className="text-[11px] text-[#555d72] max-w-[140px] truncate">{t.notes || '—'}</td>
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
