'use client'
import { useEffect, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { fmt } from '@/lib/portfolio'
import { Save, Plus, Trash2, LineChart, Copy, Check, AlertTriangle } from 'lucide-react'

// v20d: Hybrid rewrite.
// Sidebar is rendered by app/portfolio/[id]/layout.tsx — do NOT render one here.
// v17: prices display an "As of" date with a stale indicator.
// v21h: new Sector, NGX Board, Volume, Prev close, and Day change %
//   columns surface v20h data. Volume/prev-close/day-change live in
//   market_prices (populated from NGX REST feed); sector + ngx_market
//   live on instruments. All additive; null-safe.

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

// v21h: compact volume formatter. NGX volumes can get huge (50M+) so
// we want K/M/B suffixes for scannability.
function formatVolume(v?: number | null): string {
  if (v === undefined || v === null) return '—'
  if (v >= 1e9) return (v / 1e9).toFixed(1) + 'B'
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M'
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K'
  return v.toFixed(0)
}

const SLEEVE_NAMES: Record<string, string> = {
  liq: 'Cash & Liquidity',
  eq:  'Equities (NGX)',
  fi:  'Fixed Income',
  ntb: 'Treasury Bills',
  fgn: 'FGN Bonds',
}

const SLEEVE_ORDER: Record<string, number> = { liq: 0, ntb: 1, fgn: 2, fi: 3, eq: 4 }

interface PriceRow {
  price: number
  day_change: number | null      // percent
  prev_close: number | null
  volume: number | null
  price_date: string
}

export default function HoldingsPage() {
  const { id: portfolioId } = useParams() as { id: string }
  const [portfolio, setPortfolio] = useState<any>(null)
  const [holdings, setHoldings] = useState<any[]>([])
  const [instruments, setInstruments] = useState<any[]>([])
  const [priceData, setPriceData] = useState<Record<string, PriceRow>>({})
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [adding, setAdding] = useState(false)
  const [newHolding, setNewHolding] = useState({ instrument_id: '', quantity: '', avg_cost: '' })
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => { load() }, [portfolioId])

  async function load() {
    const [portRes, holdRes, instrRes, priceRes] = await Promise.all([
      supabase.from('portfolios').select('*, client:clients(name)').eq('id', portfolioId).single(),
      supabase.from('holdings').select('*, instrument:instruments(*)').eq('portfolio_id', portfolioId).order('sleeve_id'),
      supabase.from('instruments').select('*').eq('approved', true).order('name'),
      // v21h: pull day_change, prev_close, volume alongside price
      supabase.from('market_prices')
        .select('instrument_id, price, day_change, prev_close, volume, price_date')
        .order('price_date', { ascending: false }),
    ])
    setPortfolio(portRes.data)
    setHoldings(holdRes.data ?? [])
    setInstruments(instrRes.data ?? [])

    const pData: Record<string, PriceRow> = {}
    priceRes.data?.forEach((p: any) => {
      if (!(p.instrument_id in pData)) {
        pData[p.instrument_id] = {
          price: Number(p.price),
          day_change: p.day_change !== null ? Number(p.day_change) : null,
          prev_close: p.prev_close !== null ? Number(p.prev_close) : null,
          volume: p.volume !== null ? Number(p.volume) : null,
          price_date: p.price_date,
        }
      }
    })
    setPriceData(pData)
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
      avg_cost: Number(newHolding.avg_cost) || priceData[newHolding.instrument_id]?.price || 1,
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
      const p = priceData[h.instrument_id]?.price ?? h.avg_cost ?? 1
      return sum + Number(h.quantity) * p
    }, 0)
    lines.push(`Total portfolio value: ₦${(totalNav / 1e6).toFixed(2)}M`)
    lines.push(`Holdings as at: ${new Date().toLocaleDateString('en-GB')}`)
    lines.push('')
    lines.push('Instrument       | Sector             | Sleeve | Quantity        | Avg Cost  | Mkt Price | Day chg  | Mkt Value  | Unrl P&L   | Weight')
    lines.push('─'.repeat(140))
    holdings.forEach(h => {
      const pr = priceData[h.instrument_id]
      const p = pr?.price ?? h.avg_cost ?? 1
      const v = Number(h.quantity) * p
      const pnl = Number(h.quantity) * (p - Number(h.avg_cost))
      const wt = totalNav > 0 ? (v / totalNav * 100).toFixed(1) + '%' : '0%'
      const sector = (h.instrument?.sector ?? '—').slice(0, 18)
      const dayChg = pr?.day_change !== null && pr?.day_change !== undefined
        ? (pr.day_change >= 0 ? '+' : '') + pr.day_change.toFixed(2) + '%'
        : '—'
      lines.push(
        `${(h.instrument?.name ?? h.instrument_id).padEnd(16)} | ${sector.padEnd(18)} | ${(h.sleeve_id ?? '').padEnd(6)} | ${Number(h.quantity).toLocaleString().padEnd(15)} | ₦${Number(h.avg_cost).toFixed(2).padEnd(8)} | ₦${p.toFixed(2).padEnd(8)} | ${dayChg.padStart(8)} | ₦${(v/1e6).toFixed(2)}M${' '.repeat(3)} | ${pnl >= 0 ? '+' : ''}₦${(pnl/1e6).toFixed(2)}M | ${wt}`
      )
    })
    return lines.join('\n')
  }

  async function copyText() {
    await navigator.clipboard.writeText(getHoldingsText())
    setCopied(true)
    setTimeout(() => setCopied(false), 2500)
  }

  const grouped = holdings.reduce((acc, h) => {
    const k = h.sleeve_id || 'other'
    if (!acc[k]) acc[k] = []
    acc[k].push(h)
    return acc
  }, {} as Record<string, any[]>)

  const staleHeldCount = holdings.filter(h => stalenessOf(priceData[h.instrument_id]?.price_date) !== 'fresh').length

  if (loading) {
    return (
      <div className="hybrid-page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', color: 'var(--text-3)', fontSize: 14 }}>
        Loading…
      </div>
    )
  }

  return (
    <main className="hybrid-page" style={{ padding: '32px 44px 64px', minHeight: '100vh' }}>
      <div className="page-head">
        <div>
          <div className="eyebrow" style={{ marginBottom: 10 }}>
            {portfolio?.client?.name} · {portfolio?.name}
          </div>
          <h1 className="hybrid-serif" style={{ fontSize: 36, fontWeight: 500, letterSpacing: '-0.005em', lineHeight: 1, color: 'var(--text)' }}>
            Holdings
          </h1>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {staleHeldCount > 0 && (
            <Link
              href="/admin/prices?stale=1"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                fontSize: 10,
                color: 'var(--warn)',
                background: 'rgba(166, 124, 42, 0.1)',
                border: '1px solid rgba(166, 124, 42, 0.25)',
                borderRadius: 999,
                padding: '3px 12px',
                textDecoration: 'none',
                fontWeight: 600,
                letterSpacing: '0.04em',
              }}
              title="Click to open Market prices filtered to stale entries"
            >
              <AlertTriangle size={10} />
              {staleHeldCount} stale price{staleHeldCount === 1 ? '' : 's'}
            </Link>
          )}
          {msg && (
            <span style={{ fontSize: 11, color: 'var(--pos)' }}>{msg}</span>
          )}
          <Link href="/admin/prices" className="btn-h" style={{ textDecoration: 'none' }}>
            <LineChart size={12} /> Manage prices
          </Link>
          <button className="btn-h" onClick={copyText}>
            {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
          </button>
          <button className="btn-h btn-h-primary" onClick={() => setAdding(true)}>
            <Plus size={12} /> Add position
          </button>
        </div>
      </div>

      {/* Add position form */}
      {adding && (
        <div className="panel" style={{ marginBottom: 20, borderColor: 'rgba(176, 139, 62, 0.3)' }}>
          <div className="panel-header">
            <div className="panel-title">Add new position</div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr 1fr auto', gap: 12, alignItems: 'end' }}>
            <div>
              <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>Instrument</label>
              <select
                value={newHolding.instrument_id}
                onChange={e => setNewHolding(n => ({ ...n, instrument_id: e.target.value }))}
                className="select-h"
              >
                <option value="">Select…</option>
                {instruments
                  .filter(i => !holdings.find(h => h.instrument_id === i.instrument_id))
                  .map(i => (
                    <option key={i.instrument_id} value={i.instrument_id}>
                      {i.name} ({i.instrument_id})
                    </option>
                  ))}
              </select>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>Quantity / Face (₦)</label>
              <input
                type="number"
                value={newHolding.quantity}
                onChange={e => setNewHolding(n => ({ ...n, quantity: e.target.value }))}
                placeholder="0"
                className="input-h input-h-mono"
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>Avg cost</label>
              <input
                type="number"
                value={newHolding.avg_cost}
                onChange={e => setNewHolding(n => ({ ...n, avg_cost: e.target.value }))}
                placeholder={priceData[newHolding.instrument_id]?.price.toString() || '1'}
                className="input-h input-h-mono"
                step="0.01"
              />
            </div>
            <div style={{ display: 'flex', gap: 6 }}>
              <button className="btn-h btn-h-primary" onClick={addHolding}>Add</button>
              <button className="btn-h" onClick={() => setAdding(false)}>✕</button>
            </div>
          </div>
        </div>
      )}

      {/* Grouped holdings */}
      {Object.entries(grouped)
        .sort(([a], [b]) => (SLEEVE_ORDER[a] ?? 99) - (SLEEVE_ORDER[b] ?? 99))
        .map(([sleeveId, items]) => (
          <div key={sleeveId} className="panel" style={{ marginBottom: 14 }}>
            <div className="panel-header">
              <div className="panel-title">{SLEEVE_NAMES[sleeveId] ?? sleeveId}</div>
              <div className="panel-meta">
                {(items as any[]).length} position{(items as any[]).length === 1 ? '' : 's'}
              </div>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="h-table" style={{ minWidth: 1200 }}>
                <thead>
                  <tr>
                    <th>Instrument</th>
                    <th>Type</th>
                    <th>Sector</th>
                    <th className="num">Quantity / Face (₦)</th>
                    <th className="num">Avg cost</th>
                    <th className="num">Prev close</th>
                    <th className="num">Current price</th>
                    <th className="num">Day chg %</th>
                    <th className="num">Volume</th>
                    <th>As of</th>
                    <th className="num">Market value</th>
                    <th className="num">Unreal. P&amp;L</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {(items as any[]).map(h => {
                    const pr = priceData[h.instrument_id]
                    const mktPrice = pr?.price ?? h.avg_cost ?? 1
                    const priceDate = pr?.price_date
                    const stale = stalenessOf(priceDate)
                    const dotColor =
                      stale === 'fresh' ? 'var(--pos)' :
                      stale === 'stale' ? 'var(--warn)' : 'var(--text-4)'
                    const dotTitle =
                      stale === 'fresh' ? `Fresh price (within ${STALE_DAYS} days)` :
                      stale === 'stale' ? `Stale price — older than ${STALE_DAYS} days. Click Manage prices to override.` :
                      'No market price on record — displaying average cost. Click Manage prices to set one.'
                    const mktVal = Number(h.quantity) * mktPrice
                    const pnl = Number(h.quantity) * (mktPrice - Number(h.avg_cost))
                    const typePill =
                      h.instrument?.type === 'Stock' ? 'pill-ok' :
                      h.instrument?.type === 'Bond' ? 'pill-buy' :
                      h.instrument?.type === 'NTB' ? 'pill-warn' :
                      'pill-hold'

                    const sectorRaw = h.instrument?.sector as string | null | undefined
                    const ngxMarket = h.instrument?.ngx_market as string | null | undefined
                    const dayChgVal = pr?.day_change
                    const prevClose = pr?.prev_close
                    const volume = pr?.volume

                    return (
                      <tr key={h.instrument_id}>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ fontWeight: 500 }}>{h.instrument?.name}</span>
                            {ngxMarket && (
                              <span
                                style={{
                                  fontSize: 9,
                                  padding: '1px 6px',
                                  borderRadius: 2,
                                  background: ngxMarket === 'Premium Board' ? 'var(--gold-soft)' : 'var(--bg-soft)',
                                  color: ngxMarket === 'Premium Board' ? 'var(--gold)' : 'var(--text-3)',
                                  border: '1px solid var(--border)',
                                  fontWeight: 600,
                                  letterSpacing: '0.04em',
                                  whiteSpace: 'nowrap' as const,
                                }}
                                title={`NGX board: ${ngxMarket}`}
                              >
                                {ngxMarket === 'Premium Board' ? 'PREMIUM' : ngxMarket === 'Main Board' ? 'MAIN' : ngxMarket}
                              </span>
                            )}
                          </div>
                          <div style={{ fontSize: 10, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
                            {h.instrument_id}
                          </div>
                        </td>
                        <td>
                          <span className={`pill ${typePill}`}>{h.instrument?.type}</span>
                        </td>
                        <td style={{ fontSize: 11, color: sectorRaw ? 'var(--text-2)' : 'var(--text-4)' }}>
                          {sectorRaw ? (
                            <span title={sectorRaw}>
                              {sectorRaw
                                .toLowerCase()
                                .split(/\s+/)
                                .map(w => w.charAt(0).toUpperCase() + w.slice(1))
                                .join(' ')}
                            </span>
                          ) : '—'}
                        </td>
                        <td className="num">
                          <input
                            type="number"
                            value={h.quantity}
                            onChange={e => updateLocal(h.instrument_id, 'quantity', e.target.value)}
                            className="input-h-cell"
                            style={{ width: 140 }}
                          />
                        </td>
                        <td className="num">
                          <input
                            type="number"
                            value={h.avg_cost}
                            onChange={e => updateLocal(h.instrument_id, 'avg_cost', e.target.value)}
                            step="0.01"
                            className="input-h-cell"
                            style={{ width: 110 }}
                          />
                        </td>
                        <td className="num" style={{ fontFamily: 'var(--font-mono)', color: prevClose !== null && prevClose !== undefined ? 'var(--text-2)' : 'var(--text-4)' }}>
                          {prevClose !== null && prevClose !== undefined
                            ? `₦${prevClose.toFixed(h.instrument?.type === 'Stock' ? 2 : 4)}`
                            : '—'}
                        </td>
                        <td className="num" style={{ fontFamily: 'var(--font-mono)', fontWeight: 500 }}>
                          ₦{mktPrice.toFixed(h.instrument?.type === 'Stock' ? 2 : 4)}
                        </td>
                        <td
                          className="num"
                          style={{
                            fontFamily: 'var(--font-mono)',
                            fontSize: 11,
                            color:
                              dayChgVal === null || dayChgVal === undefined ? 'var(--text-4)' :
                              dayChgVal > 0 ? 'var(--pos)' :
                              dayChgVal < 0 ? 'var(--neg)' : 'var(--text-3)',
                          }}
                        >
                          {dayChgVal === null || dayChgVal === undefined
                            ? '—'
                            : <>{dayChgVal > 0 ? '+' : ''}{dayChgVal.toFixed(2)}%</>}
                        </td>
                        <td className="num" style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: volume !== null && volume !== undefined ? 'var(--text-2)' : 'var(--text-4)' }} title={volume !== null && volume !== undefined ? volume.toLocaleString() : undefined}>
                          {formatVolume(volume)}
                        </td>
                        <td>
                          <span
                            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11 }}
                            title={dotTitle}
                          >
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
                              {formatShortDate(priceDate)}
                            </span>
                          </span>
                        </td>
                        <td className="num num-serif">{fmt.ngnM(mktVal)}</td>
                        <td
                          className="num num-serif"
                          style={{ color: pnl >= 0 ? 'var(--pos)' : 'var(--neg)' }}
                        >
                          {pnl >= 0 ? '+' : '−'}{fmt.ngnM(Math.abs(pnl))}
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
                            <button
                              className="btn-h"
                              style={{ fontSize: 11, padding: '4px 9px' }}
                              onClick={() => saveHolding(h)}
                              disabled={saving[h.instrument_id]}
                              title="Save changes"
                            >
                              <Save size={10} /> {saving[h.instrument_id] ? '…' : 'Save'}
                            </button>
                            <button
                              className="btn-h"
                              style={{ fontSize: 11, padding: '4px 8px', color: 'var(--text-3)' }}
                              onClick={() => deleteHolding(h.instrument_id)}
                              title="Remove position"
                            >
                              <Trash2 size={10} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ))}
    </main>
  )
}
