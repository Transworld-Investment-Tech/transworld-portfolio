'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { ArrowLeft, RefreshCw, Edit2, Search, AlertCircle, X, Save, Info, Download } from 'lucide-react'

// v20e: Hybrid rewrite of the v17 Market Prices admin page.
// v21h: Adds Prev close, Volume, and Trades columns to surface v20h data.
// v21j-hotfix-2: HTML export.
// v21l: Add "Display name" field to the price override modal. Saves
//   the instrument name directly to the instruments table via the anon
//   Supabase client (authenticated users have full access per RLS policy).
//   Name is saved in parallel with the manual price override.

const STALE_DAYS = 3

interface Row {
  instrument_id: string
  name: string
  type: string
  sleeve_id: string
  approved: boolean
  sector?: string | null
  ngx_market?: string | null
  price?: number
  day_change?: number
  prev_close?: number | null
  volume?: number | null
  trades?: number | null
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

function formatVolume(v?: number | null): string {
  if (v === undefined || v === null) return '—'
  if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B'
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M'
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K'
  return v.toFixed(0)
}

function titleCase(s: string): string {
  return s.toLowerCase().split(/\s+/).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
}

export default function MarketPricesPage() {
  const [rows, setRows]             = useState<Row[]>([])
  const [loading, setLoading]       = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [refreshMsg, setRefreshMsg] = useState('')
  const [search, setSearch]         = useState('')
  const [staleOnly, setStaleOnly]   = useState(false)
  const [heldOnly, setHeldOnly]     = useState(false)
  const [sourceFilter, setSourceFilter] = useState<string>('all')

  // Override modal state
  const [editing, setEditing]     = useState<Row | null>(null)
  const [editName, setEditName]   = useState('')   // v21l
  const [editPrice, setEditPrice] = useState('')
  const [editDate, setEditDate]   = useState('')
  const [editSaving, setEditSaving] = useState(false)
  const [editError, setEditError]   = useState('')

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    const [instrRes, priceRes, holdRes] = await Promise.all([
      supabase.from('instruments').select('*').order('instrument_id'),
      supabase.from('market_prices')
        .select('instrument_id, price, day_change, prev_close, volume, trades, price_date, source')
        .order('price_date', { ascending: false }),
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
        name:          i.name,
        type:          i.type,
        sleeve_id:     i.sleeve_id,
        approved:      i.approved,
        sector:        i.sector    ?? null,
        ngx_market:    i.ngx_market ?? null,
        price:         p?.price !== undefined ? Number(p.price) : undefined,
        day_change:    p?.day_change !== undefined && p?.day_change !== null ? Number(p.day_change) : undefined,
        prev_close:    p?.prev_close !== undefined && p?.prev_close !== null ? Number(p.prev_close) : null,
        volume:        p?.volume !== undefined && p?.volume !== null ? Number(p.volume) : null,
        trades:        p?.trades !== undefined && p?.trades !== null ? Number(p.trades) : null,
        price_date:    p?.price_date,
        source:        p?.source,
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
      const res  = await fetch('/api/prices', { method: 'POST' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setRefreshMsg(`✗ ${data.error || 'Refresh failed'}`)
      } else {
        setRefreshMsg(`✓ Updated ${data.updated || 0} prices${data.newlyRegistered ? ` · ${data.newlyRegistered} new instruments` : ''}`)
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
    setEditName(row.name)                                           // v21l
    setEditPrice(row.price !== undefined ? row.price.toString() : '')
    setEditDate(new Date().toISOString().slice(0, 10))
    setEditError('')
  }

  // v21l: save name change (to instruments) + price override (to market_prices)
  async function saveOverride() {
    if (!editing) return
    setEditSaving(true)
    setEditError('')
    try {
      const saves: Promise<any>[] = []

      // Save instrument name if changed
      if (editName.trim() && editName.trim() !== editing.name) {
        saves.push(
          (supabase
            .from('instruments')
            .update({ name: editName.trim() })
            .eq('instrument_id', editing.instrument_id) as any as Promise<any>)
        )
      }

      // Save manual price override if a price was entered
      if (editPrice && Number(editPrice) > 0) {
        saves.push(
          fetch('/api/prices/manual', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              instrument_id: editing.instrument_id,
              price:         Number(editPrice),
              price_date:    editDate,
            }),
          }).then(r => r.json())
        )
      }

      if (saves.length === 0) {
        setEditing(null)
        return
      }

      const results = await Promise.all(saves)
      // Check for errors in any of the saves
      for (const r of results) {
        if (r?.error && typeof r.error === 'string') {
          setEditError(r.error)
          return
        }
        // Supabase returns {data, error}; fetch returns parsed JSON
        if (r?.error && r.error?.message) {
          setEditError(r.error.message)
          return
        }
      }

      setEditing(null)
      await load()
    } catch (e) {
      setEditError((e as Error).message)
    } finally {
      setEditSaving(false)
    }
  }

  function downloadHTML() {
    const today    = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
    const fileDate = new Date().toISOString().slice(0, 10)

    const filterDesc = [
      search ? `Search: "${search}"` : null,
      heldOnly  ? 'Held only'          : null,
      staleOnly ? 'Stale/missing only' : null,
      sourceFilter !== 'all' ? `Source: ${sourceFilter}` : null,
    ].filter(Boolean).join(' · ') || 'All instruments'

    const tableRows = filtered.map(r => {
      const stale      = stalenessOf(r.price_date)
      const dotColor   = stale === 'fresh' ? '#2d6e4e' : stale === 'stale' ? '#a67c2a' : '#b8bcc5'
      const dateColor  = stale === 'stale' ? '#a67c2a' : stale === 'none' ? '#8a8f9a' : '#5c6573'
      const rowStyle   = r.holdingsCount > 0 ? '' : 'opacity:0.5'
      const dayChgColor = r.day_change === undefined ? '#b8bcc5'
        : r.day_change > 0 ? '#2d6e4e'
        : r.day_change < 0 ? '#a63b3b'
        : '#5c6573'

      const boardBadge = r.ngx_market
        ? `<span style="font-size:9px;padding:1px 5px;border-radius:2px;margin-left:5px;background:${r.ngx_market === 'Premium Board' ? 'rgba(176,139,62,0.12)' : '#f0ead8'};color:${r.ngx_market === 'Premium Board' ? '#b08b3e' : '#8a8f9a'};border:1px solid #e0d8c8;font-weight:600;letter-spacing:.04em">${r.ngx_market === 'Premium Board' ? 'PREMIUM' : 'MAIN'}</span>`
        : ''

      const sectorText = r.sector
        ? `<span style="color:#b8bcc5;margin-left:5px;font-family:sans-serif"> · ${titleCase(r.sector)}</span>`
        : ''

      return `<tr style="${rowStyle}">
  <td>
    <div style="font-weight:500;display:flex;align-items:center">${r.name}${boardBadge}</div>
    <div style="font-size:10px;color:#8a8f9a;font-family:monospace">${r.instrument_id}${sectorText}</div>
  </td>
  <td style="font-size:10px;color:#5c6573;text-transform:uppercase;letter-spacing:.08em">${r.type}</td>
  <td class="num" style="font-family:monospace;color:${r.prev_close !== null && r.prev_close !== undefined ? '#5c6573' : '#b8bcc5'}">${r.prev_close !== null && r.prev_close !== undefined ? `&#8358;${r.prev_close.toFixed(r.type === 'Stock' ? 2 : 4)}` : '—'}</td>
  <td class="num" style="font-family:monospace;font-weight:500">${r.price !== undefined ? `&#8358;${r.price.toFixed(r.type === 'Stock' ? 2 : 4)}` : '<span style="color:#b8bcc5">—</span>'}</td>
  <td class="num" style="font-family:monospace;font-size:11px;color:${dayChgColor}">${r.day_change !== undefined ? `${r.day_change > 0 ? '+' : ''}${r.day_change.toFixed(2)}%` : '—'}</td>
  <td class="num" style="font-family:monospace;font-size:11px;color:${r.volume !== null && r.volume !== undefined ? '#5c6573' : '#b8bcc5'}" title="${r.volume !== null && r.volume !== undefined ? r.volume.toLocaleString() : ''}">${formatVolume(r.volume)}</td>
  <td class="num" style="font-family:monospace;font-size:11px;color:${r.trades !== null && r.trades !== undefined ? '#5c6573' : '#b8bcc5'}">${r.trades !== null && r.trades !== undefined ? r.trades.toLocaleString() : '—'}</td>
  <td style="font-size:10px;font-family:monospace;color:#5c6573;text-transform:uppercase;letter-spacing:.06em">${r.source || '—'}</td>
  <td>
    <span style="display:inline-flex;align-items:center;gap:5px;font-size:11px">
      <span style="width:7px;height:7px;border-radius:50%;background:${dotColor};display:inline-block;flex-shrink:0"></span>
      <span style="color:${dateColor}">${formatDate(r.price_date)}</span>
    </span>
  </td>
  <td class="num" style="font-family:monospace;font-size:12px;color:${r.holdingsCount > 0 ? '#5c6573' : '#b8bcc5'}">${r.holdingsCount > 0 ? r.holdingsCount : '0'}</td>
</tr>`
    }).join('\n')

    const heldStaleLocal = held.filter(r => stalenessOf(r.price_date) !== 'fresh').length
    const staleNote = heldStaleLocal > 0
      ? `<span style="color:#a67c2a">${heldStaleLocal} held position${heldStaleLocal !== 1 ? 's' : ''} with stale/missing price</span>`
      : `<span style="color:#2d6e4e">All held prices fresh</span>`

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Market Prices — ${today}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'DM Sans',sans-serif;background:#f5efe0;color:#0f2947;font-size:12px;line-height:1.5;padding:40px 48px 64px}
.header{border-bottom:1px solid rgba(15,41,71,.15);padding-bottom:20px;margin-bottom:20px;display:flex;justify-content:space-between;align-items:flex-end}
.eyebrow{font-size:10px;letter-spacing:.18em;font-weight:600;color:#b08b3e;text-transform:uppercase;margin-bottom:8px}
h1{font-family:'Cormorant Garamond',serif;font-size:32px;font-weight:500;letter-spacing:-.005em;color:#0f2947}
.meta{font-size:11px;color:#8a8f9a;text-align:right;line-height:1.8}
.summary{font-size:12px;color:#5c6573;margin-bottom:12px}
.filter-note{font-size:11px;color:#8a8f9a;margin-bottom:16px;padding:7px 12px;background:rgba(15,41,71,.04);border-radius:3px;border:1px solid rgba(15,41,71,.08)}
table{width:100%;border-collapse:collapse;background:#fffbf2;border:1px solid rgba(15,41,71,.12);border-radius:5px;overflow:hidden;font-size:12px}
thead th{text-align:left;padding:10px 12px;font-size:10px;letter-spacing:.14em;font-weight:600;color:#8a8f9a;text-transform:uppercase;border-bottom:1px solid rgba(15,41,71,.12);white-space:nowrap}
thead th.num{text-align:right}
tbody td{padding:10px 12px;border-bottom:1px solid rgba(15,41,71,.05);vertical-align:middle}
tbody tr:last-child td{border-bottom:none}
td.num{text-align:right}
.footer{margin-top:20px;font-size:10px;color:#b8bcc5;text-align:center;line-height:1.8}
@media print{body{background:#fff;padding:16px 20px}.no-print{display:none}table{border:1px solid #ccc}@page{size:A4 landscape;margin:1cm}}
</style>
</head>
<body>
<div class="no-print" style="background:#0a1f3a;color:#c9a556;padding:10px 20px;margin:-40px -48px 32px;font-size:11px;letter-spacing:.08em">
  &#128438; To save as PDF: File → Print → "Save as PDF" → Landscape orientation → Save
</div>
<div class="header">
  <div>
    <div class="eyebrow">Transworld Investment and Securities</div>
    <h1>Market Prices</h1>
  </div>
  <div class="meta">
    Generated ${today}<br>
    ${filtered.length} instrument${filtered.length !== 1 ? 's' : ''} shown · ${held.length} held<br>
    Source: Nigerian Exchange Group (NGX)
  </div>
</div>
<div class="summary">
  <strong style="font-family:monospace;color:#0f2947">${rows.length}</strong> instruments in master &nbsp;·&nbsp;
  <strong style="font-family:monospace;color:#0f2947">${held.length}</strong> currently held &nbsp;·&nbsp;
  ${staleNote}
</div>
<div class="filter-note">Filter active: ${filterDesc} &nbsp;·&nbsp; Showing ${filtered.length} of ${rows.length} instruments</div>
<table>
<thead>
<tr>
  <th>Instrument</th><th>Type</th><th class="num">Prev close</th><th class="num">Price</th>
  <th class="num">Day chg %</th><th class="num">Volume</th><th class="num">Trades</th>
  <th>Source</th><th>As of</th><th class="num">Holdings</th>
</tr>
</thead>
<tbody>${tableRows}</tbody>
</table>
<div class="footer">
  Transworld Investment and Securities &nbsp;·&nbsp; Market Prices &nbsp;·&nbsp; ${today}<br>
  Prices sourced from the Nigerian Exchange Group (NGX). For investment decision-making use only.
</div>
</body>
</html>`

    const blob = new Blob([html], { type: 'text/html;charset=utf-8' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href     = url
    a.download = `Market Prices ${fileDate}.html`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
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

  const held           = rows.filter(r => r.holdingsCount > 0)
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
          <button className="btn-h" onClick={downloadHTML} disabled={loading || filtered.length === 0}>
            <Download size={12} /> Download HTML
          </button>
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

      <div style={{ maxWidth: 1400 }}>
        {/* Filters */}
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 14 }}>
          <div style={{ position: 'relative', flex: 1, minWidth: 200, maxWidth: 320 }}>
            <Search size={12} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }} />
            <input
              type="text" value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search by ticker or name…" className="input-h input-h-sm"
              style={{ paddingLeft: 32 }}
            />
          </div>
          <select value={sourceFilter} onChange={e => setSourceFilter(e.target.value)} className="select-h" style={{ width: 180, padding: '5px 32px 5px 10px', fontSize: 12 }}>
            <option value="all">All sources</option>
            <option value="ngx">NGX (auto)</option>
            <option value="manual">Manual override</option>
            <option value="seed-import">Seed import</option>
            <option value="trade-history">Trade history</option>
            <option value="none">No price yet</option>
          </select>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-2)', cursor: 'pointer', userSelect: 'none' as const }}>
            <input type="checkbox" checked={heldOnly} onChange={e => setHeldOnly(e.target.checked)} style={{ accentColor: 'var(--gold)' }} />
            Held only
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-2)', cursor: 'pointer', userSelect: 'none' as const }}>
            <input type="checkbox" checked={staleOnly} onChange={e => setStaleOnly(e.target.checked)} style={{ accentColor: 'var(--warn)' }} />
            Stale / missing only
          </label>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginLeft: 'auto' }}>
            {filtered.length} shown
          </div>
        </div>

        {/* Table */}
        <div className="panel" style={{ padding: 0, overflowX: 'auto' }}>
          {loading ? (
            <div style={{ padding: '32px 20px', textAlign: 'center', fontSize: 12, color: 'var(--text-3)' }}>Loading…</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: '32px 20px', textAlign: 'center', fontSize: 12, color: 'var(--text-3)' }}>No instruments match your filters</div>
          ) : (
            <table className="h-table" style={{ width: '100%', minWidth: 1200 }}>
              <thead>
                <tr>
                  <th>Instrument</th>
                  <th>Type</th>
                  <th className="num">Prev close</th>
                  <th className="num">Price</th>
                  <th className="num">Day chg %</th>
                  <th className="num">Volume</th>
                  <th className="num">Trades</th>
                  <th>Source</th>
                  <th>As of</th>
                  <th className="num">Holdings</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(r => {
                  const stale    = stalenessOf(r.price_date)
                  const dotColor = stale === 'fresh' ? 'var(--pos)' : stale === 'stale' ? 'var(--warn)' : 'var(--text-4)'
                  const dotTitle = stale === 'fresh' ? `Fresh (within ${STALE_DAYS} days)` : stale === 'stale' ? `Stale (older than ${STALE_DAYS} days)` : 'No price recorded'
                  const isHeld   = r.holdingsCount > 0
                  return (
                    <tr key={r.instrument_id} style={isHeld ? {} : { opacity: 0.55 }}>
                      <td>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ fontWeight: 500 }}>{r.name}</span>
                          {r.ngx_market && (
                            <span
                              style={{ fontSize: 9, padding: '1px 6px', borderRadius: 2, background: r.ngx_market === 'Premium Board' ? 'var(--gold-soft)' : 'var(--bg-soft)', color: r.ngx_market === 'Premium Board' ? 'var(--gold)' : 'var(--text-3)', border: '1px solid var(--border)', fontWeight: 600, letterSpacing: '0.04em', whiteSpace: 'nowrap' as const }}
                              title={`NGX board: ${r.ngx_market}`}
                            >
                              {r.ngx_market === 'Premium Board' ? 'PREMIUM' : r.ngx_market === 'Main Board' ? 'MAIN' : r.ngx_market}
                            </span>
                          )}
                        </div>
                        <div style={{ fontSize: 10, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
                          {r.instrument_id}
                          {r.sector && <span style={{ color: 'var(--text-4)', marginLeft: 6, fontFamily: 'var(--font-sans)' }}>· {titleCase(r.sector)}</span>}
                        </div>
                      </td>
                      <td><span style={{ fontSize: 10, color: 'var(--text-2)', textTransform: 'uppercase' as const, letterSpacing: '0.08em' }}>{r.type}</span></td>
                      <td className="num" style={{ fontFamily: 'var(--font-mono)', color: r.prev_close !== null && r.prev_close !== undefined ? 'var(--text-2)' : 'var(--text-4)' }}>
                        {r.prev_close !== null && r.prev_close !== undefined ? `₦${r.prev_close.toFixed(r.type === 'Stock' ? 2 : 4)}` : '—'}
                      </td>
                      <td className="num" style={{ fontFamily: 'var(--font-mono)' }}>
                        {r.price !== undefined ? `₦${r.price.toFixed(r.type === 'Stock' ? 2 : 4)}` : <span style={{ color: 'var(--text-4)' }}>—</span>}
                      </td>
                      <td className="num" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: r.day_change === undefined ? 'var(--text-4)' : r.day_change > 0 ? 'var(--pos)' : r.day_change < 0 ? 'var(--neg)' : 'var(--text-3)' }}>
                        {r.day_change !== undefined ? <>{r.day_change > 0 ? '+' : ''}{r.day_change.toFixed(2)}%</> : '—'}
                      </td>
                      <td className="num" style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: r.volume !== null && r.volume !== undefined ? 'var(--text-2)' : 'var(--text-4)' }} title={r.volume !== null && r.volume !== undefined ? r.volume.toLocaleString() : undefined}>
                        {formatVolume(r.volume)}
                      </td>
                      <td className="num" style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: r.trades !== null && r.trades !== undefined ? 'var(--text-2)' : 'var(--text-4)' }}>
                        {r.trades !== null && r.trades !== undefined ? r.trades.toLocaleString() : '—'}
                      </td>
                      <td>
                        {r.source
                          ? <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-2)', textTransform: 'uppercase' as const, letterSpacing: '0.06em' }}>{r.source}</span>
                          : <span style={{ fontSize: 10, color: 'var(--text-4)' }}>—</span>}
                      </td>
                      <td style={{ fontSize: 12 }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} title={dotTitle}>
                          <span style={{ width: 7, height: 7, borderRadius: '50%', background: dotColor, display: 'inline-block', flexShrink: 0 }} />
                          <span style={{ color: stale === 'stale' ? 'var(--warn)' : stale === 'none' ? 'var(--text-3)' : 'var(--text-2)' }}>
                            {formatDate(r.price_date)}
                          </span>
                        </span>
                      </td>
                      <td className="num" style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>
                        {r.holdingsCount > 0 ? <span style={{ color: 'var(--text-2)' }}>{r.holdingsCount}</span> : <span style={{ color: 'var(--text-4)' }}>0</span>}
                      </td>
                      <td>
                        <button onClick={() => openEdit(r)} className="btn-h" style={{ fontSize: 11, padding: '4px 10px' }} title="Manual override">
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

        <div style={{ marginTop: 16, fontSize: 11, color: 'var(--text-3)', display: 'flex', alignItems: 'flex-start', gap: 6, lineHeight: 1.6, maxWidth: 800 }}>
          <Info size={11} style={{ marginTop: 2, flexShrink: 0 }} />
          <span>
            Manual overrides write a row with <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-2)' }}>source='manual'</span>.
            A later NGX refresh will overwrite the same (instrument, date) row if NGX publishes a price.
            The HTML download respects active filters — use "Held only" to export a clean held-positions price sheet.
            Instrument names edited here update the instruments master immediately.
          </span>
        </div>
      </div>

      {/* Override modal */}
      {editing && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(10,31,58,.55)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '0 16px' }}
          onClick={() => setEditing(null)}
        >
          <div className="panel" style={{ maxWidth: 480, width: '100%', margin: 0 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 18 }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.18em', color: 'var(--gold)', textTransform: 'uppercase' as const }}>Manual override</div>
                <div className="hybrid-serif" style={{ fontSize: 20, fontWeight: 500, marginTop: 4, color: 'var(--text)' }}>{editing.name}</div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>{editing.instrument_id} · {editing.type}</div>
              </div>
              <button onClick={() => setEditing(null)} style={{ color: 'var(--text-3)', background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
                <X size={16} />
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

              {/* Current price info */}
              {editing.price !== undefined ? (
                <div style={{ fontSize: 11, color: 'var(--text-2)', background: 'var(--bg-soft)', borderRadius: 3, padding: '8px 12px', border: '1px solid var(--border-soft)' }}>
                  <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase' as const, letterSpacing: '0.1em', marginBottom: 3 }}>Current price</div>
                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>₦{editing.price.toFixed(editing.type === 'Stock' ? 2 : 4)}</span>{' · '}
                  <span style={{ fontFamily: 'var(--font-mono)', textTransform: 'uppercase' as const, fontSize: 10 }}>{editing.source}</span>{' · as of '}{formatDate(editing.price_date)}
                </div>
              ) : (
                <div className="alert-h alert-h-warn" style={{ fontSize: 11 }}>No price recorded yet for this instrument.</div>
              )}

              {/* v21l: Display name field */}
              <div>
                <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>
                  Display name
                  <span style={{ color: 'var(--text-4)', marginLeft: 6, fontSize: 10 }}>— updates instruments master</span>
                </label>
                <input
                  type="text"
                  value={editName}
                  onChange={e => setEditName(e.target.value)}
                  placeholder="Full instrument name"
                  className="input-h"
                />
              </div>

              {/* Price field */}
              <div>
                <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>
                  New price (₦)
                  <span style={{ color: 'var(--text-4)', marginLeft: 6, fontSize: 10 }}>— leave blank to save name only</span>
                </label>
                <input
                  type="number"
                  value={editPrice}
                  onChange={e => setEditPrice(e.target.value)}
                  step="0.01"
                  className="input-h input-h-mono"
                  autoFocus
                />
              </div>

              {/* Date field */}
              {editPrice && Number(editPrice) > 0 && (
                <div>
                  <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>As of date</label>
                  <input type="date" value={editDate} onChange={e => setEditDate(e.target.value)} className="input-h input-h-mono" />
                </div>
              )}

              {editError && (
                <div className="alert-h alert-h-critical" style={{ fontSize: 11 }}>
                  <AlertCircle size={11} style={{ flexShrink: 0, marginTop: 1 }} /><span>{editError}</span>
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, paddingTop: 4 }}>
                <button
                  onClick={saveOverride}
                  disabled={editSaving || (!editName.trim() && (!editPrice || Number(editPrice) <= 0))}
                  className="btn-h btn-h-primary"
                  style={{ flex: 1, justifyContent: 'center' }}
                >
                  <Save size={12} /> {editSaving ? 'Saving…' : 'Save changes'}
                </button>
                <button onClick={() => setEditing(null)} className="btn-h">Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
