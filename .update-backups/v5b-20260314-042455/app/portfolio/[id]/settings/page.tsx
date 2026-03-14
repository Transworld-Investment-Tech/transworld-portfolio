'use client'
import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { fmt } from '@/lib/portfolio'
import { Save, Plus, Trash2, AlertTriangle } from 'lucide-react'

export default function PortfolioSettingsPage() {
  const { id: portfolioId } = useParams() as { id: string }
  const router = useRouter()
  const [portfolio, setPortfolio] = useState<any>(null)
  const [sleeves, setSleeves] = useState<any[]>([])
  const [navLog, setNavLog] = useState<any[]>([])
  const [newNav, setNewNav] = useState({ nav_date: new Date().toISOString().slice(0, 10), nav_value: '', notes: '' })
  const [saving, setSaving] = useState(false)
  const [savingNav, setSavingNav] = useState(false)
  const [msg, setMsg] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const [portRes, slRes, navRes] = await Promise.all([
        supabase.from('portfolios').select('*, client:clients(name, code)').eq('id', portfolioId).single(),
        supabase.from('sleeve_targets').select('*').eq('portfolio_id', portfolioId).order('sort_order'),
        supabase.from('nav_log').select('*').eq('portfolio_id', portfolioId).order('nav_date', { ascending: false }).limit(20),
      ])
      setPortfolio(portRes.data)
      setSleeves(slRes.data ?? [])
      setNavLog(navRes.data ?? [])
      setLoading(false)
    }
    load()
  }, [portfolioId])

  function updateField(key: string, val: any) {
    setPortfolio((p: any) => ({ ...p, [key]: val }))
  }

  function updateSleeve(id: string, key: string, val: string) {
    setSleeves(s => s.map(sl => sl.sleeve_id === id ? { ...sl, [key]: Number(val) } : sl))
  }

  async function savePortfolio() {
    setSaving(true)
    const sleeveTotal = sleeves.reduce((s, sl) => s + sl.target_pct * 100, 0)
    if (Math.abs(sleeveTotal - 100) > 0.5) {
      flash(`Sleeve targets must sum to 100%. Currently: ${sleeveTotal.toFixed(1)}%`, true)
      setSaving(false); return
    }
    const { error: pe } = await supabase.from('portfolios').update({
      name: portfolio.name,
      income_target: Number(portfolio.income_target),
      cap_target: Number(portfolio.cap_target),
      liq_min: Number(portfolio.liq_min),
      dd_alert: Number(portfolio.dd_alert),
      dd_action: Number(portfolio.dd_action),
      max_eq_single: Number(portfolio.max_eq_single),
      max_eq_sleeve: Number(portfolio.max_eq_sleeve),
      valuation_date: portfolio.valuation_date,
      notes: portfolio.notes,
    }).eq('id', portfolioId)
    if (!pe) {
      for (const sl of sleeves) {
        await supabase.from('sleeve_targets').update({
          target_pct: sl.target_pct,
          min_pct: sl.min_pct,
          max_pct: sl.max_pct,
        }).match({ portfolio_id: portfolioId, sleeve_id: sl.sleeve_id })
      }
      flash('Settings saved ✓')
    }
    setSaving(false)
  }

  async function addNavEntry() {
    if (!newNav.nav_value) return
    setSavingNav(true)
    await supabase.from('nav_log').upsert({
      portfolio_id: portfolioId,
      nav_date: newNav.nav_date,
      nav_value: Number(newNav.nav_value),
      notes: newNav.notes || null,
    }, { onConflict: 'portfolio_id,nav_date' })
    const { data } = await supabase.from('nav_log').select('*').eq('portfolio_id', portfolioId).order('nav_date', { ascending: false }).limit(20)
    setNavLog(data ?? [])
    setNewNav(n => ({ ...n, nav_value: '', notes: '' }))
    setSavingNav(false)
    flash('NAV entry logged ✓')
  }

  async function deleteNavEntry(id: string) {
    await supabase.from('nav_log').delete().eq('id', id)
    setNavLog(n => n.filter(e => e.id !== id))
  }

  function flash(m: string, isErr = false) {
    setMsg(m)
    setTimeout(() => setMsg(''), 3000)
  }

  const pct = (v: number) => (v * 100).toFixed(1)
  const sleeveTotal = sleeves.reduce((s, sl) => s + sl.target_pct * 100, 0)

  if (loading || !portfolio) return <div className="flex items-center justify-center h-64 text-[#555d72] text-xs">Loading…</div>

  return (
    <div>
      <div className="px-8 py-5 border-b border-white/[0.07] bg-[#13161d] flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold">Portfolio settings</h1>
          <p className="text-xs text-[#555d72] mt-0.5">{portfolio.client?.name} · {portfolio.name}</p>
        </div>
        <div className="flex items-center gap-3">
          {msg && <span className={`text-xs ${msg.includes('✓') ? 'text-[#00d4a4]' : 'text-[#ff5c7a]'}`}>{msg}</span>}
          <button onClick={savePortfolio} disabled={saving}
            className="flex items-center gap-2 bg-[#a78bfa] text-white px-4 py-2 rounded-lg text-xs font-medium hover:bg-[#9b87e8] disabled:opacity-50 transition-colors">
            <Save size={13} /> {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>

      <div className="px-8 py-6 max-w-2xl space-y-5">

        {/* Portfolio details */}
        <div className="tw-card space-y-4">
          <div className="text-xs font-semibold uppercase tracking-widest text-[#555d72] pb-2 border-b border-white/[0.07]">Portfolio details</div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-[#8a91a8] mb-1.5">Portfolio name</label>
              <input value={portfolio.name || ''} onChange={e => updateField('name', e.target.value)} className="tw-input" />
            </div>
            <div>
              <label className="block text-xs text-[#8a91a8] mb-1.5">Valuation date</label>
              <input type="date" value={portfolio.valuation_date || ''} onChange={e => updateField('valuation_date', e.target.value)} className="tw-input" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4 text-xs text-[#555d72]">
            <div>Starting NAV: <span className="font-mono text-[#8a91a8]">{fmt.ngn(portfolio.starting_nav)}</span></div>
            <div>Start date: <span className="font-mono text-[#8a91a8]">{portfolio.start_date}</span></div>
            <div>Currency: <span className="font-mono text-[#8a91a8]">{portfolio.currency}</span></div>
            <div>Label: <span className="font-mono text-[#8a91a8]">Portfolio {portfolio.label}</span></div>
          </div>
          <div>
            <label className="block text-xs text-[#8a91a8] mb-1.5">Notes</label>
            <textarea value={portfolio.notes || ''} onChange={e => updateField('notes', e.target.value)} rows={2} className="tw-input resize-none" />
          </div>
        </div>

        {/* Return targets */}
        <div className="tw-card space-y-4">
          <div className="text-xs font-semibold uppercase tracking-widest text-[#555d72] pb-2 border-b border-white/[0.07]">Return targets & risk thresholds</div>
          <div className="grid grid-cols-2 gap-4">
            {[
              ['Income target (%)', 'income_target'],
              ['Cap. appreciation target (%)', 'cap_target'],
              ['Max single equity (% NAV)', 'max_eq_single'],
              ['Max equity sleeve (%)', 'max_eq_sleeve'],
              ['Drawdown alert (%)', 'dd_alert'],
              ['Drawdown action threshold (%)', 'dd_action'],
            ].map(([label, key]) => (
              <div key={key}>
                <label className="block text-xs text-[#8a91a8] mb-1.5">{label}</label>
                <div className="relative">
                  <input type="number" step="0.1" min="0" max="100"
                    value={portfolio[key] !== undefined ? (Math.abs(portfolio[key]) * 100).toFixed(1) : ''}
                    onChange={e => {
                      const raw = Number(e.target.value) / 100
                      updateField(key, key.startsWith('dd_') ? -Math.abs(raw) : raw)
                    }}
                    className="tw-input pr-6" />
                  <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-[#555d72]">%</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Sleeve targets */}
        <div className="tw-card space-y-4">
          <div className="flex items-center justify-between pb-2 border-b border-white/[0.07]">
            <div className="text-xs font-semibold uppercase tracking-widest text-[#555d72]">Sleeve allocation targets</div>
            <span className={`text-xs font-mono ${Math.abs(sleeveTotal - 100) < 0.5 ? 'text-[#00d4a4]' : 'text-[#ff5c7a]'}`}>
              Total: {sleeveTotal.toFixed(1)}%
            </span>
          </div>
          {sleeves.map(s => (
            <div key={s.sleeve_id} className="grid grid-cols-4 gap-3 items-end">
              <div className="text-xs text-[#8a91a8] pt-4">{s.name}</div>
              {[['Target %', 'target_pct'], ['Min %', 'min_pct'], ['Max %', 'max_pct']].map(([lbl, key]) => (
                <div key={key}>
                  <label className="block text-[10px] text-[#555d72] mb-1">{lbl}</label>
                  <input type="number" step="1" min="0" max="100"
                    value={(s[key] * 100).toFixed(0)}
                    onChange={e => updateSleeve(s.sleeve_id, key, String(Number(e.target.value) / 100))}
                    className="tw-input py-1.5 text-xs font-mono text-right" />
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* NAV log */}
        <div className="tw-card">
          <div className="text-xs font-semibold uppercase tracking-widest text-[#555d72] pb-3 border-b border-white/[0.07] mb-4">NAV log</div>
          <div className="grid grid-cols-3 gap-3 mb-4 items-end">
            <div>
              <label className="block text-xs text-[#8a91a8] mb-1.5">Date</label>
              <input type="date" value={newNav.nav_date} onChange={e => setNewNav(n => ({ ...n, nav_date: e.target.value }))} className="tw-input" />
            </div>
            <div>
              <label className="block text-xs text-[#8a91a8] mb-1.5">NAV (₦)</label>
              <input type="number" value={newNav.nav_value} onChange={e => setNewNav(n => ({ ...n, nav_value: e.target.value }))} placeholder="300000000" className="tw-input font-mono" />
            </div>
            <button onClick={addNavEntry} disabled={savingNav || !newNav.nav_value}
              className="flex items-center justify-center gap-1.5 py-2 bg-[#a78bfa] text-white rounded-lg text-xs font-medium hover:bg-[#9b87e8] disabled:opacity-50 transition-colors">
              <Plus size={13} /> {savingNav ? 'Logging…' : 'Log NAV'}
            </button>
          </div>
          {navLog.length > 0 && (
            <table className="tw-table w-full">
              <thead><tr><th>Date</th><th>NAV (₦)</th><th>Notes</th><th></th></tr></thead>
              <tbody>
                {navLog.map(n => (
                  <tr key={n.id}>
                    <td className="font-mono">{n.nav_date}</td>
                    <td className="font-mono">{fmt.ngnM(n.nav_value)}</td>
                    <td className="text-[#555d72] text-xs">{n.notes || '—'}</td>
                    <td>
                      <button onClick={() => deleteNavEntry(n.id)} className="text-[#555d72] hover:text-[#ff5c7a] transition-colors">
                        <Trash2 size={12} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/* Danger zone */}
        <div className="tw-card border-[#ff5c7a]/20">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-[#ff5c7a] pb-2 border-b border-[#ff5c7a]/20 mb-4">
            <AlertTriangle size={13} /> Danger zone
          </div>
          <div className="flex items-center justify-between">
            <div>
              <div className="text-xs font-medium">Close portfolio</div>
              <div className="text-[11px] text-[#555d72] mt-0.5">Marks this portfolio as closed. Holdings and history are preserved.</div>
            </div>
            <button onClick={async () => {
              if (!confirm('Close this portfolio? This cannot be undone easily.')) return
              await supabase.from('portfolios').update({ status: 'closed' }).eq('id', portfolioId)
              router.push('/')
            }} className="px-4 py-2 border border-[#ff5c7a]/30 text-[#ff5c7a] rounded-lg text-xs hover:bg-[#ff5c7a]/10 transition-colors flex-shrink-0 ml-4">
              Close portfolio
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
