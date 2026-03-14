'use client'
import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { ArrowLeft, Save, Info } from 'lucide-react'

const DEFAULT_SLEEVES = [
  { sleeve_id: 'liq', name: 'Liquidity (≤7 days)',        target_pct: 5,  min_pct: 5,  max_pct: 10, sort_order: 0 },
  { sleeve_id: 'ntb', name: 'NTB ladder (income core)',    target_pct: 40, min_pct: 30, max_pct: 55, sort_order: 1 },
  { sleeve_id: 'fgn', name: 'FGN bonds (rate-cut upside)', target_pct: 25, min_pct: 15, max_pct: 35, sort_order: 2 },
  { sleeve_id: 'eq',  name: 'Equities (total return)',     target_pct: 30, min_pct: 20, max_pct: 35, sort_order: 3 },
]

export default function NewPortfolioPage() {
  const router = useRouter()
  const params = useSearchParams()
  const preselectedClient = params.get('client') ?? ''

  const [clients, setClients] = useState<any[]>([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [sleeves, setSleeves] = useState(DEFAULT_SLEEVES)
  const [form, setForm] = useState({
    client_id: preselectedClient,
    label: 'A',
    name: '',
    starting_nav: '',
    start_date: new Date().toISOString().slice(0, 10),
    currency: 'NGN',
    income_target: '15',
    cap_target: '30',
    liq_min: '5',
    dd_alert: '7',
    dd_action: '10',
    max_eq_single: '7',
    max_eq_sleeve: '35',
    notes: '',
    seedHoldings: true,
  })

  useEffect(() => {
    supabase.from('clients').select('id, name, code').eq('status', 'active').then(({ data }) => setClients(data ?? []))
  }, [])

  // Auto-generate portfolio name
  useEffect(() => {
    const client = clients.find(c => c.id === form.client_id)
    if (client && form.label) setForm(f => ({ ...f, name: `${client.name} Portfolio ${f.label}` }))
  }, [form.client_id, form.label, clients])

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  function updateSleeve(idx: number, key: string, val: string) {
    setSleeves(prev => prev.map((s, i) => i === idx ? { ...s, [key]: Number(val) } : s))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError('')

    const total = sleeves.reduce((s, sl) => s + sl.target_pct, 0)
    if (Math.abs(total - 100) > 0.01) {
      setError(`Sleeve targets must sum to 100%. Currently: ${total}%`)
      setSaving(false)
      return
    }

    const res = await fetch('/api/portfolios', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...form,
        starting_nav: Number(form.starting_nav),
        income_target: Number(form.income_target) / 100,
        cap_target: Number(form.cap_target) / 100,
        liq_min: Number(form.liq_min) / 100,
        dd_alert: -Number(form.dd_alert) / 100,
        dd_action: -Number(form.dd_action) / 100,
        max_eq_single: Number(form.max_eq_single) / 100,
        max_eq_sleeve: Number(form.max_eq_sleeve) / 100,
        sleeves: sleeves.map(s => ({ ...s, target_pct: s.target_pct / 100, min_pct: s.min_pct / 100, max_pct: s.max_pct / 100 })),
        seedHoldings: form.seedHoldings,
      })
    })
    const d = await res.json()
    if (!res.ok) { setError(d.error); setSaving(false) }
    else router.push(`/portfolio/${d.portfolio.id}`)
  }

  const sleeveTotal = sleeves.reduce((s, sl) => s + sl.target_pct, 0)

  return (
    <div>
      <div className="px-8 py-5 border-b border-white/[0.07] bg-[#13161d] flex items-center gap-4">
        <Link href="/" className="flex items-center gap-1.5 text-xs text-[#8a91a8] hover:text-[#e8eaf0] transition-colors">
          <ArrowLeft size={13} /> Back
        </Link>
        <div className="w-px h-4 bg-white/10" />
        <h1 className="text-base font-semibold">Create portfolio</h1>
      </div>

      <div className="px-8 py-6 max-w-2xl">
        <form onSubmit={handleSubmit} className="space-y-5">

          {/* Core details */}
          <div className="tw-card space-y-4">
            <div className="text-xs font-semibold uppercase tracking-widest text-[#555d72] pb-2 border-b border-white/[0.07]">Portfolio details</div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-[#8a91a8] mb-1.5">Client <span className="text-[#ff5c7a]">*</span></label>
                <select value={form.client_id} onChange={set('client_id')} required className="tw-select">
                  <option value="">Select client…</option>
                  {clients.map(c => <option key={c.id} value={c.id}>{c.name} ({c.code})</option>)}
                </select>
              </div>
              <div>
                <label className="block text-xs text-[#8a91a8] mb-1.5">Portfolio label <span className="text-[#ff5c7a]">*</span></label>
                <select value={form.label} onChange={set('label')} className="tw-select">
                  {['A','B','C','D','E','F','G','H','I','J'].map(l => <option key={l} value={l}>{l}</option>)}
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs text-[#8a91a8] mb-1.5">Portfolio name</label>
              <input value={form.name} onChange={set('name')} placeholder="Auto-generated from client + label" className="tw-input" />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-[#8a91a8] mb-1.5">Starting NAV (₦) <span className="text-[#ff5c7a]">*</span></label>
                <input type="number" value={form.starting_nav} onChange={set('starting_nav')} placeholder="300000000" required min="1" className="tw-input font-mono" />
              </div>
              <div>
                <label className="block text-xs text-[#8a91a8] mb-1.5">Start date <span className="text-[#ff5c7a]">*</span></label>
                <input type="date" value={form.start_date} onChange={set('start_date')} required className="tw-input" />
              </div>
            </div>
          </div>

          {/* Targets */}
          <div className="tw-card space-y-4">
            <div className="text-xs font-semibold uppercase tracking-widest text-[#555d72] pb-2 border-b border-white/[0.07]">Return targets & risk thresholds</div>
            <div className="grid grid-cols-2 gap-4">
              {[
                ['Income target (%)', 'income_target', '15'],
                ['Cap. appreciation target (%)', 'cap_target', '30'],
                ['Max single equity (% NAV)', 'max_eq_single', '7'],
                ['Max equity sleeve (%)', 'max_eq_sleeve', '35'],
                ['Drawdown alert (%)', 'dd_alert', '7'],
                ['Drawdown action threshold (%)', 'dd_action', '10'],
              ].map(([label, key, placeholder]) => (
                <div key={key}>
                  <label className="block text-xs text-[#8a91a8] mb-1.5">{label}</label>
                  <input type="number" value={(form as any)[key]} onChange={set(key)} placeholder={placeholder} step="0.1" min="0" max="100" className="tw-input" />
                </div>
              ))}
            </div>
          </div>

          {/* Sleeve targets */}
          <div className="tw-card space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-white/[0.07]">
              <div className="text-xs font-semibold uppercase tracking-widest text-[#555d72]">Sleeve allocation targets</div>
              <span className={`text-xs font-mono ${Math.abs(sleeveTotal - 100) < 0.01 ? 'text-[#00d4a4]' : 'text-[#ff5c7a]'}`}>
                Total: {sleeveTotal}%
              </span>
            </div>
            {sleeves.map((s, i) => (
              <div key={s.sleeve_id} className="grid grid-cols-4 gap-3 items-end">
                <div>
                  <div className="text-xs text-[#8a91a8] mb-1.5">{s.name}</div>
                  <div className="text-[10px] text-[#555d72]">sleeve: {s.sleeve_id}</div>
                </div>
                {[['Target %', 'target_pct'], ['Min %', 'min_pct'], ['Max %', 'max_pct']].map(([lbl, key]) => (
                  <div key={key}>
                    <label className="block text-[10px] text-[#555d72] mb-1">{lbl}</label>
                    <input type="number" value={(s as any)[key]} onChange={e => updateSleeve(i, key, e.target.value)}
                      step="1" min="0" max="100" className="tw-input py-1.5 text-xs font-mono" />
                  </div>
                ))}
              </div>
            ))}
          </div>

          {/* Seed holdings */}
          <div className="tw-card">
            <label className="flex items-start gap-3 cursor-pointer">
              <input type="checkbox" checked={form.seedHoldings} onChange={e => setForm(f => ({ ...f, seedHoldings: e.target.checked }))}
                className="mt-0.5 accent-[#a78bfa]" />
              <div>
                <div className="text-sm font-medium">Seed default holdings from Portfolio A template</div>
                <div className="text-xs text-[#555d72] mt-0.5 leading-relaxed">
                  Pre-populates all 12 instruments (CASH_NGN, NTB_91/182/364, FGN_5_7/10, UBA, GTCO, ZENITH, DANGCEM, STANBIC, SEPLAT) at the correct NAV-proportional sizes. You can edit individual positions after creation.
                </div>
              </div>
            </label>
          </div>

          {error && <div className="alert alert-critical">{error}</div>}

          <div className="flex gap-3">
            <button type="submit" disabled={saving}
              className="flex items-center gap-2 bg-[#a78bfa] text-white px-5 py-2.5 rounded-lg text-sm font-medium hover:bg-[#9b87e8] disabled:opacity-50 transition-colors">
              <Save size={14} /> {saving ? 'Creating…' : 'Create portfolio'}
            </button>
            <Link href="/" className="flex items-center gap-2 border border-white/10 px-5 py-2.5 rounded-lg text-sm text-[#8a91a8] hover:text-[#e8eaf0] transition-colors">
              Cancel
            </Link>
          </div>
        </form>
      </div>
    </div>
  )
}
