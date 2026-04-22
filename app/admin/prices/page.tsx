'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { ArrowLeft, RefreshCw, Edit2, Search, AlertCircle, X, Save, Info } from 'lucide-react'

// v20e: Hybrid rewrite of the v17 Market Prices admin page.
// Preserves the 3-day staleness threshold, source filter, held-only
// toggle, and the manual-override modal which writes source='manual'.

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

  const held = rows.filter(r => r.holdingsCount > 0)
  const heldStaleCount = held.filter(r => stalenessOf(r.price_date) !== 'fresh').length

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
            Market prices
          </h1>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {refreshMsg && (
            <span style={{ fontSize: 11, color: refreshMsg.startsWith('✓') ? 'var(--pos)' : 'var(--neg)' }}>
              {refreshMsg}
            </span>
          )}
          <button
            className="btn-h btn-h-primary"
            onClick={refreshFromNGX}
            disabled={refreshing}
          >
            <RefreshCw size={12} style={refreshing ? { animation: 'spin 0.7s linear infinite' } : undefined} />
            {refreshing ? 'Fetching…' : 'Refresh from NGX'}
          </button>
        </div>
      </div>

      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>

      {/* Status line */}
      <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 18, lineHeight: 1.6 }}>
        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{rows.length}</span> instruments in master ·{' '}
        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{held.length}</span> currently held ·{' '}
        {heldStaleCount > 0 ? (
          <span style={{ color: 'var(--warn)' }}>
            {heldStaleCount} held position{heldStaleCount === 1 ? '' : 's'} with stale / missing price
          </span>
        ) : (
          <span style={{ color: 'var(--pos)' }}>All held prices fresh</span>
        )}
        . Updates flow automatically to every portfolio.
      </div>

      <div style={{ maxWidth: 1200 }}>
        {/* Filters */}
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 14 }}>
          <div style={{ position: 'relative', flex: 1, minWidth: 200, maxWidth: 320 }}>
            <Search
              size={12}
              style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }}
            />
            <input
              type="text"
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search by ticker or name…"
              className="input-h input-h-sm"
              style={{ paddingLeft: 32 }}
            />
          </div>
          <select
            value={sourceFilter}
            onChange={e => setSourceFilter(e.target.value)}
            className="select-h"
            style={{ width: 180, padding: '5px 32px 5px 10px', fontSize: 12 }}
          >
            <option value="all">All sources</option>
            <option value="ngx">NGX (auto)</option>
            <option value="manual">Manual override</option>
            <option value="seed-import">Seed import</option>
            <option value="trade-history">Trade history</option>
            <option value="none">No price yet</option>
          </select>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-2)', cursor: 'pointer', userSelect: 'none' as const }}>
            <input
              type="checkbox"
              checked={heldOnly}
              onChange={e => setHeldOnly(e.target.checked)}
              style={{ accentColor: 'var(--gold)' }}
            />
            Held only
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-2)', cursor: 'pointer', userSelect: 'none' as const }}>
            <input
              type="checkbox"
              checked={staleOnly}
              onChange={e => setStaleOnly(e.target.checked)}
              style={{ accentColor: 'var(--warn)' }}
            />
            Stale / missing only
          </label>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginLeft: 'auto' }}>
            {filtered.length} shown
          </div>
        </div>

        {/* Table */}
        <div className="panel" style={{ padding: 0, overflowX: 'auto' }}>
          {loading ? (
            <div style={{ padding: '32px 20px', textAlign: 'center', fontSize: 12, color: 'var(--text-3)' }}>
              Loading…
            </div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: '32px 20px', textAlign: 'center', fontSize: 12, color: 'var(--text-3)' }}>
              No instruments match your filters
            </div>
          ) : (
            <table className="h-table" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th>Instrument</th>
                  <th>Type</th>
                  <th className="num">Price</th>
                  <th className="num">Day chg</th>
                  <th>Source</th>
                  <th>As of</th>
                  <th className="num">Holdings</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(r => {
                  const stale = stalenessOf(r.price_date)
                  const dotColor =
                    stale === 'fresh' ? 'var(--pos)' :
                    stale === 'stale' ? 'var(--warn)' : 'var(--text-4)'
                  const dotTitle =
                    stale === 'fresh' ? `Fresh (within ${STALE_DAYS} days)` :
                    stale === 'stale' ? `Stale (older than ${STALE_DAYS} days)` :
                    'No price recorded'
                  const isHeld = r.holdingsCount > 0
                  return (
                    <tr key={r.instrument_id} style={isHeld ? {} : { opacity: 0.55 }}>
                      <td>
                        <div style={{ fontWeight: 500 }}>{r.name}</div>
                        <div style={{ fontSize: 10, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
                          {r.instrument_id}
                        </div>
                      </td>
                      <td>
                        <span style={{ fontSize: 10, color: 'var(--text-2)', textTransform: 'uppercase' as const, letterSpacing: '0.08em' }}>
                          {r.type}
                        </span>
                      </td>
                      <td className="num" style={{ fontFamily: 'var(--font-mono)' }}>
                        {r.price !== undefined ? (
                          `₦${r.price.toFixed(r.type === 'Stock' ? 2 : 4)}`
                        ) : (
                          <span style={{ color: 'var(--text-4)' }}>—</span>
                        )}
                      </td>
                      <td
                        className="num"
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 12,
                          color:
                            (r.day_change ?? 0) > 0 ? 'var(--pos)' :
                            (r.day_change ?? 0) < 0 ? 'var(--neg)' : 'var(--text-3)',
                        }}
                      >
                        {r.day_change !== undefined ? (
                          <>{r.day_change > 0 ? '+' : ''}{r.day_change.toFixed(2)}</>
                        ) : '—'}
                      </td>
                      <td>
                        {r.source ? (
                          <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-2)', textTransform: 'uppercase' as const, letterSpacing: '0.06em' }}>
                            {r.source}
                          </span>
                        ) : (
                          <span style={{ fontSize: 10, color: 'var(--text-4)' }}>—</span>
                        )}
                      </td>
                      <td style={{ fontSize: 12 }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} title={dotTitle}>
                          <span
                            style={{
                              width: 7,
                              height: 7,
                              borderRadius: '50%',
                              background: dotColor,
                              display: 'inline-block',
                              flexShrink: 0,
                            }}
                          />
                          <span
                            style={{
                              color:
                                stale === 'stale' ? 'var(--warn)' :
                                stale === 'none' ? 'var(--text-3)' : 'var(--text-2)',
                            }}
                          >
                            {formatDate(r.price_date)}
                          </span>
                        </span>
                      </td>
                      <td className="num" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                        {r.holdingsCount > 0 ? (
                          <span style={{ color: 'var(--text-2)' }}>{r.holdingsCount}</span>
                        ) : (
                          <span style={{ color: 'var(--text-4)' }}>0</span>
                        )}
                      </td>
                      <td>
                        <button
                          onClick={() => openEdit(r)}
                          className="btn-h"
                          style={{ fontSize: 11, padding: '4px 10px' }}
                          title="Manual override"
                        >
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

        <div style={{ marginTop: 16, fontSize: 11, color: 'var(--text-3)', display: 'flex', alignItems: 'flex-start', gap: 6, lineHeight: 1.6, maxWidth: 700 }}>
          <Info size={11} style={{ marginTop: 2, flexShrink: 0 }} />
          <span>
            Manual overrides write a row with <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-2)' }}>source='manual'</span>.
            A later "Refresh from NGX" will overwrite the same (instrument, date) row if NGX publishes a price.
            Use overrides for suspended tickers, transferred-in holdings, or securities NGX doesn't list under the ticker our records use.
          </span>
        </div>
      </div>

      {/* Edit modal */}
      {editing && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(10, 31, 58, 0.55)',
            backdropFilter: 'blur(3px)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 50,
            padding: '0 16px',
          }}
          onClick={() => setEditing(null)}
        >
          <div
            className="panel"
            style={{ maxWidth: 440, width: '100%', margin: 0 }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 18 }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.18em', color: 'var(--gold)', textTransform: 'uppercase' as const }}>
                  Manual price override
                </div>
                <div className="hybrid-serif" style={{ fontSize: 20, fontWeight: 500, marginTop: 4, color: 'var(--text)' }}>
                  {editing.name}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>
                  {editing.instrument_id} · {editing.type}
                </div>
              </div>
              <button
                onClick={() => setEditing(null)}
                style={{ color: 'var(--text-3)', background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}
              >
                <X size={16} />
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
              {editing.price !== undefined ? (
                <div
                  style={{
                    fontSize: 11,
                    color: 'var(--text-2)',
                    background: 'var(--bg-soft)',
                    borderRadius: 3,
                    padding: '8px 12px',
                    border: '1px solid var(--border-soft)',
                  }}
                >
                  <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase' as const, letterSpacing: '0.1em', marginBottom: 3 }}>
                    Current
                  </div>
                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>
                    ₦{editing.price.toFixed(editing.type === 'Stock' ? 2 : 4)}
                  </span>{' '}
                  ·{' '}
                  <span style={{ fontFamily: 'var(--font-mono)', textTransform: 'uppercase' as const, fontSize: 10 }}>
                    {editing.source}
                  </span>{' '}
                  · as of {formatDate(editing.price_date)}
                </div>
              ) : (
                <div className="alert-h alert-h-warn" style={{ fontSize: 11 }}>
                  No price recorded yet for this instrument.
                </div>
              )}
              <div>
                <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>New price (₦)</label>
                <input
                  type="number"
                  value={editPrice}
                  onChange={e => setEditPrice(e.target.value)}
                  step="0.01"
                  className="input-h input-h-mono"
                  autoFocus
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>As of date</label>
                <input
                  type="date"
                  value={editDate}
                  onChange={e => setEditDate(e.target.value)}
                  className="input-h input-h-mono"
                />
              </div>
              {editError && (
                <div className="alert-h alert-h-critical" style={{ fontSize: 11 }}>
                  <AlertCircle size={11} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span>{editError}</span>
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, paddingTop: 4 }}>
                <button
                  onClick={saveManualPrice}
                  disabled={editSaving || !editPrice || Number(editPrice) <= 0}
                  className="btn-h btn-h-primary"
                  style={{ flex: 1, justifyContent: 'center' }}
                >
                  <Save size={12} /> {editSaving ? 'Saving…' : 'Save override'}
                </button>
                <button onClick={() => setEditing(null)} className="btn-h">
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
