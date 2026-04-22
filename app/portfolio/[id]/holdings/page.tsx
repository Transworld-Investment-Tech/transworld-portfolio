'use client'
import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { fmt } from '@/lib/portfolio'
import { ArrowLeft, Save, Plus, Trash2, LineChart } from 'lucide-react'
import PageActions from '@/components/shared/PageActions'

// v17: prices now display an "As of" date with a stale indicator.
// Staleness threshold matches the Market Prices admin page.
const STALE_DAYS = 3

function stalenessOf(priceDate?: string): 'fresh' | 'stale' | 'none' {
  if (!priceDate) return 'none'
  const d = new Date(priceDate + 'T00:00:00Z')
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  const diffDays = Math.floor((today.getTime() - d.getTime()) / 86_400_000)
  return diffDays > STALE_DAYS ? 'stale' : 'fresh'
}

function formatShortDate(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso + 'T00:00:00Z')
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })
}

export default function HoldingsPage() {
  const { id: portfolioId } = useParams() as { id: string }
  const [portfolio, setPortfolio] = useState<any>(null)
  const [holdings, setHoldings] = useState<any[]>([])
  const [instruments, setInstruments] = useState<any[]>([])
  const [prices, setPrices] = useState<Record<string, number>>({})
  const [priceDates, setPriceDates] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [adding, setAdding] = useState(false)
  const [newHolding, setNewHolding] = useState({ instrument_id: '', quantity: '', avg_cost: '' })
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState('')

  useEffect(() => { load() }, [portfolioId])

  async function load() {
    const [portRes, holdRes, instrRes, priceRes] = await Promise.all([
      supabase.from('portfolios').select('*, client:clients(name)').eq('id', portfolioId).single(),
      supabase.from('holdings').select('*, instrument:instruments(*)').eq('portfolio_id', portfolioId).order('sleeve_id'),
      supabase.from('instruments').select('*').eq('approved', true).order('name'),
      // v17: also pull price_date so the holdings table can show staleness
      supabase.from('market_prices').select('instrument_id, price, price_date').order('price_date', { ascending: false }),
    ])
    setPortfolio(portRes.data)
    setHoldings(holdRes.data ?? [])
    setInstruments(instrRes.data ?? [])
    const pm: Record<string, number> = {}
    const pd: Record<string, string> = {}
    priceRes.data?.forEach((p: any) => {
      // First occurrence wins after DESC sort — that's the latest row per instrument.
      if (!(p.instrument_id in pm)) {
        pm[p.instrument_id] = p.price
        pd[p.instrument_id] = p.price_date
      }
    })
    setPrices(pm)
    setPriceDates(pd)
    setLoading(false)
  }

  async function saveHolding(holding: any) {
    setSaving(s => ({ ...s, [holding.instrument_id]: true }))
    await supabase.from('holdings').update({
      quantity: Number(holding.quantity),
      avg_cost: Number(holding.avg_cost),
      updated_at: new Date().toISOString(),
    }).match({ portfolio_id: portfolioId, instrument_id: holding.instrument_id })
    setSaving(s => ({ ...s, [holding.instrument_id]: false }))
    flashMsg('Saved ✓')
  }

  async function addHolding() {
    if (!newHolding.instrument_id || !newHolding.quantity) return
    const instr = instruments.find(i => i.instrument_id === newHolding.instrument_id)
    await supabase.from('holdings').upsert({
      portfolio_id: portfolioId,
      instrument_id: newHolding.instrument_id,
      sleeve_id: instr?.sleeve_id,
      quantity: Number(newHolding.quantity),
      avg_cost: Number(newHolding.avg_cost) || prices[newHolding.instrument_id] || 1,
      as_of_date: new Date().toISOString().slice(0, 10),
    }, { onConflict: 'portfolio_id,instrument_id' })
    setAdding(false)
    setNewHolding({ instrument_id: '', quantity: '', avg_cost: '' })
    load()
    flashMsg('Position added ✓')
  }

  async function deleteHolding(instrumentId: string) {
    if (!confirm('Remove this position?')) return
    await supabase.from('holdings').delete().match({ portfolio_id: portfolioId, instrument_id: instrumentId })
    load()
  }

  function flashMsg(m: string) { setMsg(m); setTimeout(() => setMsg(''), 2500) }

  const updateLocal = (instrId: string, key: string, val: string) => {
    setHoldings(h => h.map(hold => hold.instrument_id === instrId ? { ...hold, [key]: val } : hold))
  }

  function getHoldingsText(): string {
    const lines: string[] = []
    const totalNav = holdings.reduce((sum, h) => {
      const p = prices[h.instrument_id] ?? h.avg_cost ?? 1
      return sum + Number(h.quantity) * p
    }, 0)
    lines.push(`Total portfolio value: ₦${(totalNav / 1e6).toFixed(2)}M`)
    lines.push(`Holdings as at: ${new Date().toLocaleDateString('en-GB')}`)
    lines.push('')
    lines.push('Instrument       | Sleeve | Quantity        | Avg Cost  | Mkt Price | Mkt Value  | Unrl P&L   | Weight')
    lines.push('─'.repeat(110))
    holdings.forEach(h => {
      const p   = prices[h.instrument_id] ?? h.avg_cost ?? 1
      const v   = Number(h.quantity) * p
      const pnl = Number(h.quantity) * (p - Number(h.avg_cost))
      const wt  = totalNav > 0 ? (v / totalNav * 100).toFixed(1) + '%' : '0%'
      lines.push(
        `${(h.instrument?.name ?? h.instrument_id).padEnd(16)} | ${(h.sleeve_id ?? '').padEnd(6)} | ${Number(h.quantity).toLocaleString().padEnd(15)} | ₦${Number(h.avg_cost).toFixed(2).padEnd(8)} | ₦${p.toFixed(2).padEnd(8)} | ₦${(v/1e6).toFixed(2)}M${' '.repeat(3)} | ${pnl >= 0 ? '+' : ''}₦${(pnl/1e6).toFixed(2)}M | ${wt}`
      )
    })
    return lines.join('\n')
  }

  const sleeveOrder = { liq: 0, ntb: 1, fgn: 2, eq: 3 }
  const grouped = holdings.reduce((acc, h) => {
    const k = h.sleeve_id || 'other'
    if (!acc[k]) acc[k] = []
    acc[k].push(h)
    return acc
  }, {} as Record<string, any[]>)

  // Count held positions with stale/missing prices — surfaced as a yellow hint badge
  const staleHeldCount = holdings.filter(h => stalenessOf(priceDates[h.instrument_id]) !== 'fresh').length

  if (loading) return <div className="flex items-center justify-center h-64 text-[#555d72] text-xs">Loading…</div>

  return (
    <div>
      <div className="px-8 py-5 border-b border-white/[0.07] bg-[#13161d] flex items-center gap-4">
        <Link href={`/portfolio/${portfolioId}`} className="flex items-center gap-1.5 text-xs text-[#8a91a8] hover:text-[#e8eaf0] transition-colors">
          <ArrowLeft size={13} /> {portfolio?.name}
        </Link>
        <div className="w-px h-4 bg-white/10" />
        <h1 className="text-base font-semibold">Edit holdings</h1>
        {staleHeldCount > 0 && (
          <Link
            href="/admin/prices?stale=1"
            className="flex items-center gap-1.5 text-[10px] text-[#eab308] bg-[#eab308]/10 border border-[#eab308]/20 rounded-full px-2.5 py-0.5 hover:bg-[#eab308]/15 transition-colors"
            title="Click to open Market prices filtered to stale entries">
            <span className="w-1.5 h-1.5 rounded-full bg-[#eab308] inline-block" />
            {staleHeldCount} stale price{staleHeldCount === 1 ? '' : 's'}
          </Link>
        )}
        <div className="ml-auto flex items-center gap-3">
          {msg && <span className="text-xs text-[#00d4a4]">{msg}</span>}
          <Link
            href="/admin/prices"
            className="flex items-center gap-1.5 text-xs text-[#8a91a8] hover:text-[#e8eaf0] border border-white/10 rounded-lg px-3 py-2 transition-colors"
            title="Open the central Market Prices page">
            <LineChart size={13} /> Manage prices
          </Link>
          <PageActions
            pageTitle="Holdings"
            portfolioName={portfolio?.name ?? ''}
            getText={getHoldingsText}
          />
          <button onClick={() => setAdding(true)} className="flex items-center gap-2 bg-[#a78bfa] text-white px-4 py-2 rounded-lg text-xs font-medium hover:bg-[#9b87e8] transition-colors">
            <Plus size={13} /> Add position
          </button>
        </div>
      </div>

      <div className="px-8 py-6 max-w-5xl">
        {adding && (
          <div className="tw-card mb-5 border-[#a78bfa]/20">
            <div className="text-xs font-semibold uppercase tracking-widest text-[#555d72] mb-4">Add new position</div>
            <div className="grid grid-cols-4 gap-3 items-end">
              <div>
                <label className="block text-xs text-[#8a91a8] mb-1.5">Instrument</label>
                <select value={newHolding.instrument_id} onChange={e => setNewHolding(n => ({ ...n, instrument_id: e.target.value }))} className="tw-select">
                  <option value="">Select…</option>
                  {instruments.filter(i => !holdings.find(h => h.instrument_id === i.instrument_id)).map(i => (
                    <option key={i.instrument_id} value={i.instrument_id}>{i.name} ({i.instrument_id})</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-[#8a91a8] mb-1.5">Quantity / Face (₦)</label>
                <input type="number" value={newHolding.quantity} onChange={e => setNewHolding(n => ({ ...n, quantity: e.target.value }))} placeholder="0" className="tw-input font-mono" />
              </div>
              <div>
                <label className="block text-xs text-[#8a91a8] mb-1.5">Avg cost</label>
                <input type="number" value={newHolding.avg_cost} onChange={e => setNewHolding(n => ({ ...n, avg_cost: e.target.value }))} placeholder={prices[newHolding.instrument_id]?.toString() || '1'} className="tw-input font-mono" step="0.01" />
              </div>
              <div className="flex gap-2">
                <button onClick={addHolding} className="flex-1 py-2 bg-[#a78bfa] text-white rounded-lg text-xs font-medium hover:bg-[#9b87e8] transition-colors">Add</button>
                <button onClick={() => setAdding(false)} className="px-3 py-2 border border-white/10 rounded-lg text-xs text-[#8a91a8] hover:text-[#e8eaf0] transition-colors">✕</button>
              </div>
            </div>
          </div>
        )}

        {Object.entries(grouped)
          .sort(([a], [b]) => (sleeveOrder[a as keyof typeof sleeveOrder] ?? 99) - (sleeveOrder[b as keyof typeof sleeveOrder] ?? 99))
          .map(([sleeveId, items]) => (
          <div key={sleeveId} className="tw-card mb-4">
            <div className="text-xs font-semibold uppercase tracking-widest text-[#555d72] mb-4 capitalize">{sleeveId} sleeve</div>
            <table className="tw-table w-full">
              <thead>
                <tr>
                  <th>Instrument</th>
                  <th>Type</th>
                  <th>Quantity / Face (₦)</th>
                  <th>Avg cost</th>
                  <th>Current price</th>
                  <th>As of</th>
                  <th>Market value</th>
                  <th>Unreal. P&L</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {(items as any[]).map(h => {
                  const mktPrice = prices[h.instrument_id] ?? h.avg_cost ?? 1
                  const priceDate = priceDates[h.instrument_id]
                  const stale = stalenessOf(priceDate)
                  const dotColor =
                    stale === 'fresh' ? '#22c55e' :
                    stale === 'stale' ? '#eab308' : '#6b7280'
                  const dotTitle =
                    stale === 'fresh' ? `Fresh price (within ${STALE_DAYS} days)` :
                    stale === 'stale' ? `Stale price — older than ${STALE_DAYS} days. Click Manage prices to override.` :
                    'No market price on record — displaying average cost. Click Manage prices to set one.'
                  const mktVal = Number(h.quantity) * mktPrice
                  const pnl = Number(h.quantity) * (mktPrice - Number(h.avg_cost))
                  return (
                    <tr key={h.instrument_id}>
                      <td>
                        <div className="text-sm font-medium">{h.instrument?.name}</div>
                        <div className="text-[10px] text-[#555d72] font-mono">{h.instrument_id}</div>
                      </td>
                      <td><span className={`badge badge-${h.instrument?.type === 'NTB' ? 'ntb' : h.instrument?.type === 'Bond' ? 'bond' : h.instrument?.type === 'Stock' ? 'stock' : 'cash'}`}>{h.instrument?.type}</span></td>
                      <td>
                        <input type="number" value={h.quantity} onChange={e => updateLocal(h.instrument_id, 'quantity', e.target.value)}
                          className="tw-input py-1 text-xs font-mono text-right w-32" />
                      </td>
                      <td>
                        <input type="number" value={h.avg_cost} onChange={e => updateLocal(h.instrument_id, 'avg_cost', e.target.value)}
                          step="0.01" className="tw-input py-1 text-xs font-mono text-right w-28" />
                      </td>
                      <td className="font-mono">₦{mktPrice.toFixed(h.instrument?.type === 'Stock' ? 2 : 4)}</td>
                      <td>
                        <span className="inline-flex items-center gap-1.5 text-[11px]" title={dotTitle}>
                          <span style={{ background: dotColor }} className="w-2 h-2 rounded-full inline-block flex-shrink-0" />
                          <span className={
                            stale === 'stale' ? 'text-[#eab308]' :
                            stale === 'none'  ? 'text-[#555d72]' : 'text-[#8a91a8]'
                          }>{formatShortDate(priceDate)}</span>
                        </span>
                      </td>
                      <td className="font-mono">{fmt.ngnM(mktVal)}</td>
                      <td className={`font-mono text-xs ${pnl >= 0 ? 'text-[#00d4a4]' : 'text-[#ff5c7a]'}`}>{pnl >= 0 ? '+' : ''}{fmt.ngnM(pnl)}</td>
                      <td>
                        <div className="flex gap-1.5">
                          <button onClick={() => saveHolding(h)} disabled={saving[h.instrument_id]}
                            className="flex items-center gap-1 text-[11px] text-[#555d72] hover:text-[#a78bfa] transition-colors px-2 py-1 border border-white/10 rounded">
                            <Save size={11} /> {saving[h.instrument_id] ? '…' : 'Save'}
                          </button>
                          <button onClick={() => deleteHolding(h.instrument_id)}
                            className="flex items-center gap-1 text-[11px] text-[#555d72] hover:text-[#ff5c7a] transition-colors px-2 py-1 border border-white/10 rounded">
                            <Trash2 size={11} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  )
}
