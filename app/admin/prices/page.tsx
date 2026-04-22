'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { ArrowLeft, RefreshCw, Edit2, Search, AlertCircle, X, Save, Info } from 'lucide-react'

// Staleness threshold. Any price older than this many days shows a yellow
// indicator. Kept as a module constant for easy tuning.
const STALE_DAYS = 3

interface Row {
  instrument_id: string
  name: string
  type: string
  sleeve_id: string
  approved: boolean
  price?: number
  day_change?: number
  price_date?: string
  source?: string
  holdingsCount: number
}

function stalenessOf(priceDate?: string): 'fresh' | 'stale' | 'none' {
  if (!priceDate) return 'none'
  const d = new Date(priceDate + 'T00:00:00Z')
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  const diffDays = Math.floor((today.getTime() - d.getTime()) / 86_400_000)
  return diffDays > STALE_DAYS ? 'stale' : 'fresh'
}

function formatDate(iso?: string): string {
  if (!iso) return '—'
  const d = new Date(iso + 'T00:00:00Z')
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
}

export default function MarketPricesPage() {
  const [rows, setRows] = useState<Row[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshMsg, setRefreshMsg] = useState('')
  const [search, setSearch] = useState('')
  const [staleOnly, setStaleOnly] = useState(false)
  const [heldOnly, setHeldOnly] = useState(false)
  const [sourceFilter, setSourceFilter] = useState<string>('all')

  const [editing, setEditing] = useState<Row | null>(null)
  const [editPrice, setEditPrice] = useState('')
  const [editDate, setEditDate] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  const [editError, setEditError] = useState('')

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    const [instrRes, priceRes, holdRes] = await Promise.all([
      supabase.from('instruments').select('*').order('instrument_id'),
      supabase.from('market_prices').select('instrument_id, price, day_change, price_date, source').order('price_date', { ascending: false }),
      supabase.from('holdings').select('instrument_id'),
    ])

    // Latest price per instrument (first occurrence after the DESC sort)
    const priceMap = new Map<string, any>()
    priceRes.data?.forEach((p: any) => {
      if (!priceMap.has(p.instrument_id)) priceMap.set(p.instrument_id, p)
    })

    const holdingCounts = new Map<string, number>()
    holdRes.data?.forEach((h: any) => {
      holdingCounts.set(h.instrument_id, (holdingCounts.get(h.instrument_id) ?? 0) + 1)
    })

    const merged: Row[] = (instrRes.data ?? []).map((i: any) => {
      const p = priceMap.get(i.instrument_id)
      return {
        instrument_id: i.instrument_id,
        name: i.name,
        type: i.type,
        sleeve_id: i.sleeve_id,
        approved: i.approved,
        price: p?.price !== undefined ? Number(p.price) : undefined,
        day_change: p?.day_change !== undefined && p?.day_change !== null ? Number(p.day_change) : undefined,
        price_date: p?.price_date,
        source: p?.source,
        holdingsCount: holdingCounts.get(i.instrument_id) ?? 0,
      }
    })

    setRows(merged)
    setLoading(false)
  }

  async function refreshFromNGX() {
    setRefreshing(true)
    setRefreshMsg('')
    try {
      const res = await fetch('/api/prices', { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setRefreshMsg(`✗ ${data.error || 'Refresh failed'}`)
      } else {
        setRefreshMsg(`✓ Updated ${data.updated || 0} prices from NGX`)
        await load()
      }
    } catch (e) {
      setRefreshMsg(`✗ ${(e as Error).message}`)
    } finally {
      setRefreshing(false)
      setTimeout(() => setRefreshMsg(''), 8000)
    }
  }

  function openEdit(row: Row) {
    setEditing(row)
    setEditPrice(row.price !== undefined ? row.price.toString() : '')
    setEditDate(new Date().toISOString().slice(0, 10))
    setEditError('')
  }

  async function saveManualPrice() {
    if (!editing) return
    setEditSaving(true)
    setEditError('')
    try {
      const res = await fetch('/api/prices/manual', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          instrument_id: editing.instrument_id,
          price: Number(editPrice),
          price_date: editDate,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setEditError(data.error || 'Save failed')
      } else {
        setEditing(null)
        await load()
      }
    } catch (e) {
      setEditError((e as Error).message)
    } finally {
      setEditSaving(false)
    }
  }

  const filtered = rows.filter(r => {
    if (search) {
      const q = search.toLowerCase()
      if (!r.instrument_id.toLowerCase().includes(q) && !r.name.toLowerCase().includes(q)) return false
    }
    if (heldOnly && r.holdingsCount === 0) return false
    const stale = stalenessOf(r.price_date)
    if (staleOnly && stale === 'fresh') return false
    if (sourceFilter !== 'all') {
      if (sourceFilter === 'none' && r.source) return false
      if (sourceFilter !== 'none' && r.source !== sourceFilter) return false
    }
    return true
  })

  // Summary counts over the held subset (most operationally useful)
  const held = rows.filter(r => r.holdingsCount > 0)
  const heldStaleCount = held.filter(r => stalenessOf(r.price_date) !== 'fresh').length

  return (
    <div>
      {/* Header */}
      <div className="px-8 py-6 border-b border-white/[0.07] bg-[#13161d]">
        <div className="flex items-center gap-3">
          <Link href="/admin" className="flex items-center gap-1.5 text-xs text-[#8a91a8] hover:text-[#e8eaf0] transition-colors">
            <ArrowLeft size={13} /> Admin panel
          </Link>
          <div className="w-px h-4 bg-white/10" />
          <h1 className="text-xl font-semibold">Market prices</h1>

          <div className="ml-auto flex items-center gap-3">
            {refreshMsg && (
              <span className={`text-xs ${refreshMsg.startsWith('✓') ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>
                {refreshMsg}
              </span>
            )}
            <button
              onClick={refreshFromNGX}
              disabled={refreshing}
              className="flex items-center gap-1.5 text-xs text-[#8a91a8] hover:text-[#e8eaf0] border border-white/10 rounded-lg px-3 py-1.5 transition-colors disabled:opacity-50">
              <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} /> {refreshing ? 'Fetching…' : 'Refresh from NGX'}
            </button>
          </div>
        </div>
        <p className="text-xs text-[#555d72] mt-2">
          {rows.length} instruments in master · {held.length} currently held ·{' '}
          {heldStaleCount > 0 ? (
            <span className="text-[#eab308]">{heldStaleCount} held position{heldStaleCount === 1 ? '' : 's'} with stale / missing price</span>
          ) : (
            <span className="text-[#22c55e]">All held prices fresh</span>
          )}. Updates flow automatically to every portfolio.
        </p>
      </div>

      <div className="px-8 py-5 max-w-6xl">
        {/* Filters */}
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <div className="relative flex-1 min-w-[200px] max-w-sm">
            <Search size={12} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#555d72]" />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by ticker or name…"
              className="tw-input pl-9 text-xs w-full"
            />
          </div>
          <select
            value={sourceFilter}
            onChange={e => setSourceFilter(e.target.value)}
            className="tw-select text-xs">
            <option value="all">All sources</option>
            <option value="ngx">NGX (auto)</option>
            <option value="manual">Manual override</option>
            <option value="seed-import">Seed import</option>
            <option value="none">No price yet</option>
          </select>
          <label className="flex items-center gap-1.5 text-xs text-[#8a91a8] cursor-pointer select-none">
            <input type="checkbox" checked={heldOnly} onChange={e => setHeldOnly(e.target.checked)} className="accent-[#a78bfa]" />
            Held only
          </label>
          <label className="flex items-center gap-1.5 text-xs text-[#8a91a8] cursor-pointer select-none">
            <input type="checkbox" checked={staleOnly} onChange={e => setStaleOnly(e.target.checked)} className="accent-[#eab308]" />
            Stale / missing only
          </label>
          <div className="text-[11px] text-[#555d72] ml-auto">{filtered.length} shown</div>
        </div>

        {/* Table */}
        <div className="tw-card p-0 overflow-hidden">
          {loading ? (
            <div className="px-5 py-8 text-center text-xs text-[#555d72]">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="px-5 py-8 text-center text-xs text-[#555d72]">No instruments match your filters</div>
          ) : (
            <table className="tw-table w-full">
              <thead>
                <tr>
                  <th>Instrument</th>
                  <th>Type</th>
                  <th className="text-right">Price</th>
                  <th className="text-right">Day chg</th>
                  <th>Source</th>
                  <th>As of</th>
                  <th className="text-right">Holdings</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(r => {
                  const stale = stalenessOf(r.price_date)
                  const dotColor =
                    stale === 'fresh' ? '#22c55e' :
                    stale === 'stale' ? '#eab308' : '#6b7280'
                  const dotTitle =
                    stale === 'fresh' ? `Fresh (within ${STALE_DAYS} days)` :
                    stale === 'stale' ? `Stale (older than ${STALE_DAYS} days)` :
                    'No price recorded'
                  const isHeld = r.holdingsCount > 0
                  return (
                    <tr key={r.instrument_id} className={isHeld ? '' : 'opacity-60'}>
                      <td>
                        <div className="text-sm font-medium">{r.name}</div>
                        <div className="text-[10px] text-[#555d72] font-mono">{r.instrument_id}</div>
                      </td>
                      <td>
                        <span className="text-[10px] text-[#8a91a8] uppercase tracking-wide">{r.type}</span>
                      </td>
                      <td className="font-mono text-right">
                        {r.price !== undefined ? (
                          `₦${r.price.toFixed(r.type === 'Stock' ? 2 : 4)}`
                        ) : (
                          <span className="text-[#555d72]">—</span>
                        )}
                      </td>
                      <td className={`font-mono text-right text-xs ${
                        (r.day_change ?? 0) > 0 ? 'text-[#22c55e]' :
                        (r.day_change ?? 0) < 0 ? 'text-[#ef4444]' : 'text-[#555d72]'
                      }`}>
                        {r.day_change !== undefined ? (
                          <>{r.day_change > 0 ? '+' : ''}{r.day_change.toFixed(2)}</>
                        ) : '—'}
                      </td>
                      <td>
                        {r.source ? (
                          <span className="text-[10px] font-mono text-[#8a91a8] uppercase">{r.source}</span>
                        ) : (
                          <span className="text-[10px] text-[#555d72]">—</span>
                        )}
                      </td>
                      <td className="text-xs">
                        <span className="inline-flex items-center gap-2" title={dotTitle}>
                          <span
                            style={{ background: dotColor }}
                            className="w-2 h-2 rounded-full inline-block flex-shrink-0"
                          />
                          <span className={stale === 'stale' ? 'text-[#eab308]' : stale === 'none' ? 'text-[#555d72]' : ''}>
                            {formatDate(r.price_date)}
                          </span>
                        </span>
                      </td>
                      <td className="text-right text-xs font-mono text-[#8a91a8]">
                        {r.holdingsCount > 0 ? r.holdingsCount : <span className="text-[#555d72]">0</span>}
                      </td>
                      <td>
                        <button
                          onClick={() => openEdit(r)}
                          className="flex items-center gap-1 text-[11px] text-[#555d72] hover:text-[#a78bfa] transition-colors px-2 py-1 border border-white/10 rounded">
                          <Edit2 size={11} /> Override
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="mt-4 text-[11px] text-[#555d72] flex items-start gap-2 max-w-2xl">
          <Info size={11} className="mt-0.5 flex-shrink-0" />
          <span>
            Manual overrides write a row with <span className="font-mono">source=&lsquo;manual&rsquo;</span>.
            A later &ldquo;Refresh from NGX&rdquo; will overwrite the same (instrument, date) row if NGX publishes a price for that instrument.
            Use overrides for suspended tickers, transferred-in holdings, or securities NGX doesn&rsquo;t list under the ticker our records use.
          </span>
        </div>
      </div>

      {/* Edit modal */}
      {editing && (
        <div
          className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-50 px-4"
          onClick={() => setEditing(null)}>
          <div className="tw-card max-w-md w-full" onClick={e => e.stopPropagation()}>
            <div className="flex items-start justify-between mb-4">
              <div>
                <div className="text-[10px] font-bold tracking-widest text-[#555d72] uppercase">Manual price override</div>
                <div className="text-base font-semibold mt-1">{editing.name}</div>
                <div className="text-[11px] text-[#555d72] font-mono">{editing.instrument_id} · {editing.type}</div>
              </div>
              <button onClick={() => setEditing(null)} className="text-[#555d72] hover:text-[#e8eaf0] transition-colors">
                <X size={16} />
              </button>
            </div>

            <div className="space-y-3">
              {editing.price !== undefined ? (
                <div className="text-[11px] text-[#8a91a8] bg-white/[0.03] rounded-lg px-3 py-2 border border-white/[0.05]">
                  <div className="text-[#555d72] text-[10px] uppercase tracking-wide mb-0.5">Current</div>
                  ₦{editing.price.toFixed(editing.type === 'Stock' ? 2 : 4)} ·{' '}
                  <span className="font-mono uppercase text-[10px]">{editing.source}</span> ·{' '}
                  as of {formatDate(editing.price_date)}
                </div>
              ) : (
                <div className="text-[11px] text-[#eab308] bg-[#eab308]/10 rounded-lg px-3 py-2 border border-[#eab308]/20">
                  No price recorded yet for this instrument.
                </div>
              )}
              <div>
                <label className="block text-xs text-[#8a91a8] mb-1.5">New price (₦)</label>
                <input
                  type="number"
                  value={editPrice}
                  onChange={e => setEditPrice(e.target.value)}
                  step="0.01"
                  className="tw-input font-mono"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-xs text-[#8a91a8] mb-1.5">As of date</label>
                <input
                  type="date"
                  value={editDate}
                  onChange={e => setEditDate(e.target.value)}
                  className="tw-input font-mono"
                />
              </div>
              {editError && (
                <div className="text-xs text-[#ef4444] bg-[#ef4444]/10 rounded-lg px-3 py-2 border border-[#ef4444]/20">
                  <AlertCircle size={11} className="inline mr-1 -mt-0.5" />
                  {editError}
                </div>
              )}
              <div className="flex gap-2 pt-2">
                <button
                  onClick={saveManualPrice}
                  disabled={editSaving || !editPrice || Number(editPrice) <= 0}
                  className="flex-1 flex items-center justify-center gap-2 bg-[#a78bfa] text-white px-4 py-2 rounded-lg text-xs font-medium hover:bg-[#9b87e8] transition-colors disabled:opacity-50">
                  <Save size={12} /> {editSaving ? 'Saving…' : 'Save override'}
                </button>
                <button
                  onClick={() => setEditing(null)}
                  className="px-4 py-2 border border-white/10 rounded-lg text-xs text-[#8a91a8] hover:text-[#e8eaf0] transition-colors">
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
