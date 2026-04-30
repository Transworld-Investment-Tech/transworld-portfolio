'use client'
import { useEffect, useMemo, useState } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import * as XLSX from 'xlsx'
import { supabase } from '@/lib/supabase'
import { fmt } from '@/lib/portfolio'
import { computeDurationConvexity } from '@/lib/bond-yield'
import YieldCurvePanel from '@/components/admin/YieldCurvePanel'
import { Save, Plus, Trash2, LineChart, Copy, Check, AlertTriangle, FileSpreadsheet, Edit3 } from 'lucide-react'

// v20d: Hybrid rewrite.
// v17:  prices display an "As of" date with a stale indicator.
// v21h: new Sector, NGX Board, Volume, Prev close, and Day change %
//   columns surface v20h data.
// v21j: Excel export via SheetJS.
// v25:  When a holding is FI, show Mod Duration + Convexity columns.
//   Portfolio-weighted MD displayed in summary. YieldCurvePanel embedded
//   at bottom, locked to this portfolio so its bond holdings overlay
//   automatically as gold diamonds on the live yield curve.

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
  day_change: number | null
  prev_close: number | null
  volume: number | null
  price_date: string
}

const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return isFinite(n) ? n : null
}

export default function HoldingsPage() {
  const { id: portfolioId } = useParams() as { id: string }
  const [portfolio, setPortfolio] = useState<any>(null)
  const [holdings, setHoldings] = useState<any[]>([])
  const [instruments, setInstruments] = useState<any[]>([])
  const [priceData, setPriceData] = useState<Record<string, PriceRow>>({})
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [adding, setAdding] = useState(false)
  const [newHolding, setNewHolding] = useState({ instrument_id: '', quantity: '', avg_cost: '', trade_date: '' })
  const [editingPosition, setEditingPosition] = useState<{
    instrument_id: string
    instrument_name: string
    quantity: string
    avg_cost: string
    trade_date: string
  } | null>(null)
  const [editBusy, setEditBusy] = useState(false)
  const [deleteBusy, setDeleteBusy] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState('')
  const [copied, setCopied] = useState(false)

  useEffect(() => { load() }, [portfolioId])

  async function load() {
    const [portRes, holdRes, instrRes, priceRes] = await Promise.all([
      supabase.from('portfolios').select('*, client:clients(name)').eq('id', portfolioId).single(),
      supabase.from('holdings').select('*, instrument:instruments(*)').eq('portfolio_id', portfolioId).order('sleeve_id'),
      supabase.from('instruments').select('*').eq('approved', true).order('name'),
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
    const res = await fetch('/api/holdings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        portfolioId,
        instrumentId:  newHolding.instrument_id,
        quantity:      Number(newHolding.quantity),
        avgCost:       Number(newHolding.avg_cost) || priceData[newHolding.instrument_id]?.price || 0,
        tradeDate:     newHolding.trade_date || new Date().toISOString().slice(0, 10),
      }),
    })
    const data = await res.json()
    if (!res.ok) { flashMsg('Error: ' + (data.error ?? 'Failed to add position')); return }
    setNewHolding({ instrument_id: '', quantity: '', avg_cost: '', trade_date: '' })
    flashMsg('Position added — transaction recorded ✓')
    await load()
  }

  async function deleteHolding(instrumentId: string) {
    // v27ae: provenance-aware delete. Cascade-removes only manual-entry
    // transaction rows and rebuilds holdings. Synth / reconciliation /
    // broker rows are preserved.
    let prov: any = null
    try {
      const provRes = await fetch(`/api/holdings/provenance?portfolioId=${portfolioId}&instrumentId=${instrumentId}`)
      prov = await provRes.json()
    } catch {
      /* fall through with prov = null */
    }

    const c = prov?.counts ?? null
    let confirmMsg = 'Remove this position?\n\nThis will delete'
    if (c) {
      confirmMsg += ` ${c.manual} manual-entry transaction(s).`
      const nonManual = c.synth + c.reconciliation + c.broker + c.other
      if (nonManual > 0) {
        const parts: string[] = []
        if (c.synth > 0)          parts.push(`${c.synth} synthetic-recovery`)
        if (c.reconciliation > 0) parts.push(`${c.reconciliation} reconciliation`)
        if (c.broker > 0)         parts.push(`${c.broker} broker-import`)
        if (c.other > 0)          parts.push(`${c.other} other`)
        confirmMsg += `\n\n⚠ ${nonManual} non-manual transaction(s) will be PRESERVED: ${parts.join(', ')}.`
        confirmMsg += `\nThe position may still appear (re-derived from those rows) after rebuild.`
      }
    } else {
      confirmMsg += ' all manually-added transaction rows for this position.'
    }

    if (!confirm(confirmMsg)) return

    setDeleteBusy(instrumentId)
    try {
      const res = await fetch(`/api/holdings?portfolioId=${portfolioId}&instrumentId=${instrumentId}`, {
        method: 'DELETE',
      })
      const data = await res.json()
      if (!res.ok) {
        flashMsg('Delete failed: ' + (data.error ?? res.statusText))
      } else {
        const tail = data.preserved_count > 0
          ? ` · ${data.preserved_count} non-manual row(s) preserved`
          : ''
        flashMsg(`Position removed — ${data.deleted_count} transaction(s) deleted${tail}`)
      }
    } finally {
      setDeleteBusy(null)
      load()
    }
  }

  function openEditModal(h: any) {
    setEditingPosition({
      instrument_id: h.instrument_id,
      instrument_name: h.instrument?.name ?? h.instrument_id,
      quantity: String(h.quantity ?? ''),
      avg_cost: String(h.avg_cost ?? ''),
      trade_date: '',
    })
  }

  async function saveEdit() {
    if (!editingPosition) return
    const { instrument_id, quantity, avg_cost, trade_date } = editingPosition
    if (!quantity || Number(quantity) === 0) {
      flashMsg('Quantity must be non-zero')
      return
    }
    if (!trade_date) {
      flashMsg('Trade date required')
      return
    }
    setEditBusy(true)
    try {
      const res = await fetch('/api/holdings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          portfolioId,
          instrumentId: instrument_id,
          quantity: Number(quantity),
          avgCost: Number(avg_cost),
          tradeDate: trade_date,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        flashMsg('Edit failed: ' + (data.error ?? res.statusText))
      } else {
        flashMsg(`Position updated — ${data.deleted_count} replaced ✓`)
        setEditingPosition(null)
      }
    } finally {
      setEditBusy(false)
      load()
    }
  }

  function flashMsg(m: string) { setMsg(m); setTimeout(() => setMsg(''), 2500) }

  const updateLocal = (instrId: string, key: string, val: string) => {
    setHoldings(h => h.map(hold => hold.instrument_id === instrId ? { ...hold, [key]: val } : hold))
  }

  // v25: precompute MD/Convexity per FI holding
  const fiMetrics = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10)
    const out = new Map<string, { mod_duration: number | null; convexity: number | null }>()
    for (const h of holdings) {
      if (h.sleeve_id !== 'fi') continue
      const instr = h.instrument
      if (!instr || !instr.maturity_date) continue
      const yieldPct = numOrNull(instr.yield_pct)
      const couponPct = numOrNull(instr.coupon_pct)
      if (yieldPct === null || couponPct === null) {
        out.set(h.instrument_id, { mod_duration: null, convexity: null })
        continue
      }
      const dc = computeDurationConvexity(yieldPct, couponPct, String(instr.maturity_date).slice(0, 10), today, 2)
      out.set(h.instrument_id, dc ? { mod_duration: dc.mod_duration, convexity: dc.convexity } : { mod_duration: null, convexity: null })
    }
    return out
  }, [holdings])

  // v25: portfolio-weighted MD across the FI sleeve only
  const fiSleeveStats = useMemo(() => {
    let totalFiValue = 0
    let weightedMD = 0
    let weightedYield = 0
    let mdCovered = 0
    let yldCovered = 0
    for (const h of holdings) {
      if (h.sleeve_id !== 'fi') continue
      const instr = h.instrument
      const qty = Number(h.quantity) || 0
      // For FI, qty is face value at par 100. Use face value as a proxy for sizing.
      const value = qty
      totalFiValue += value
      const m = fiMetrics.get(h.instrument_id)
      if (m?.mod_duration !== null && m?.mod_duration !== undefined) {
        weightedMD += m.mod_duration * value
        mdCovered  += value
      }
      const y = instr ? numOrNull(instr.yield_pct) : null
      if (y !== null) {
        weightedYield += y * value
        yldCovered    += value
      }
    }
    return {
      totalFiValue,
      weightedMD:    mdCovered  > 0 ? weightedMD    / mdCovered  : null,
      weightedYield: yldCovered > 0 ? weightedYield / yldCovered : null,
      hasFI:         totalFiValue > 0,
    }
  }, [holdings, fiMetrics])

  // v21j: Excel export
  function downloadExcel() {
    const totalNav = holdings.reduce((sum, h) => {
      const p = priceData[h.instrument_id]?.price ?? h.avg_cost ?? 1
      return sum + Number(h.quantity) * p
    }, 0)

    const headers = [
      'Instrument', 'Ticker', 'Type', 'Sector', 'NGX Board', 'Sleeve',
      'Quantity', 'Avg Cost (₦)', 'Prev Close (₦)', 'Current Price (₦)',
      'Day Chg %', 'Volume', 'Price Date',
      'Market Value (₦)', 'Unrealised P&L (₦)', 'Weight %',
      'Yield (FI)', 'Mod Duration (FI)', 'Convexity (FI)',
    ]

    const rows = holdings.map(h => {
      const pr = priceData[h.instrument_id]
      const p = pr?.price ?? Number(h.avg_cost) ?? 1
      const v = Number(h.quantity) * p
      const pnl = Number(h.quantity) * (p - Number(h.avg_cost))
      const wt = totalNav > 0 ? v / totalNav * 100 : 0
      const m  = fiMetrics.get(h.instrument_id)
      const y  = h.instrument && h.sleeve_id === 'fi' ? numOrNull(h.instrument.yield_pct) : null
      return [
        h.instrument?.name ?? h.instrument_id,
        h.instrument_id,
        h.instrument?.type ?? '',
        h.instrument?.sector ?? '',
        h.instrument?.ngx_market ?? '',
        SLEEVE_NAMES[h.sleeve_id] ?? h.sleeve_id ?? '',
        Number(h.quantity),
        Number(h.avg_cost),
        pr?.prev_close ?? '',
        p,
        pr?.day_change ?? '',
        pr?.volume ?? '',
        pr?.price_date ?? '',
        v,
        pnl,
        Number(wt.toFixed(2)),
        y !== null ? Number(y.toFixed(2)) : '',
        m?.mod_duration  !== null && m?.mod_duration  !== undefined ? Number(m.mod_duration.toFixed(2)) : '',
        m?.convexity     !== null && m?.convexity     !== undefined ? Number(m.convexity.toFixed(2))    : '',
      ]
    })

    const wb = XLSX.utils.book_new()
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows])
    ws['!cols'] = [
      { wch: 32 }, { wch: 14 }, { wch: 10 }, { wch: 24 }, { wch: 14 }, { wch: 18 },
      { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 14 },
      { wch: 10 }, { wch: 12 }, { wch: 12 },
      { wch: 18 }, { wch: 18 }, { wch: 10 },
      { wch: 12 }, { wch: 14 }, { wch: 12 },
    ]
    XLSX.utils.book_append_sheet(wb, ws, 'Holdings')

    const clientName = portfolio?.client?.name ?? 'Portfolio'
    const portfolioName = portfolio?.name ?? 'Holdings'
    const today = new Date().toISOString().slice(0, 10)
    XLSX.writeFile(wb, `${clientName} - ${portfolioName} Holdings ${today}.xlsx`)
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
                display: 'inline-flex', alignItems: 'center', gap: 6,
                fontSize: 10, color: 'var(--warn)',
                background: 'rgba(166, 124, 42, 0.1)',
                border: '1px solid rgba(166, 124, 42, 0.25)',
                borderRadius: 999, padding: '3px 12px',
                textDecoration: 'none', fontWeight: 600, letterSpacing: '0.04em',
              }}
              title="Click to open Market prices filtered to stale entries"
            >
              <AlertTriangle size={10} />
              {staleHeldCount} stale price{staleHeldCount === 1 ? '' : 's'}
            </Link>
          )}
          {msg && <span style={{ fontSize: 11, color: 'var(--pos)' }}>{msg}</span>}
          <Link href="/admin/prices" className="btn-h" style={{ textDecoration: 'none' }}>
            <LineChart size={12} /> Manage prices
          </Link>
          <button className="btn-h" onClick={copyText}>
            {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
          </button>
          <button className="btn-h" onClick={downloadExcel}>
            <FileSpreadsheet size={12} /> Export Excel
          </button>
          <button className="btn-h btn-h-primary" onClick={() => setAdding(true)}>
            <Plus size={12} /> Add position
          </button>
        </div>
      </div>

      {/* v25: FI sleeve summary pill — only shows when portfolio holds FI */}
      {fiSleeveStats.hasFI && (
        <div
          style={{
            background: 'var(--gold-soft)',
            border: '1px solid rgba(176, 139, 62, 0.3)',
            borderRadius: 4,
            padding: '10px 16px',
            marginBottom: 14,
            display: 'flex',
            alignItems: 'center',
            gap: 24,
            flexWrap: 'wrap',
            fontSize: 12,
          }}
        >
          <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.16em', color: 'var(--gold)', textTransform: 'uppercase' as const }}>
            FI sleeve
          </div>
          <div>
            <span style={{ color: 'var(--text-3)', marginRight: 6 }}>Face value</span>
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)', fontWeight: 500 }}>
              {fmt.ngnM(fiSleeveStats.totalFiValue)}
            </span>
          </div>
          <div>
            <span style={{ color: 'var(--text-3)', marginRight: 6 }}>Weighted yield</span>
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)', fontWeight: 500 }}>
              {fiSleeveStats.weightedYield !== null ? fiSleeveStats.weightedYield.toFixed(2) + '%' : '—'}
            </span>
          </div>
          <div>
            <span style={{ color: 'var(--text-3)', marginRight: 6 }}>Weighted mod duration</span>
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)', fontWeight: 500 }}>
              {fiSleeveStats.weightedMD !== null ? fiSleeveStats.weightedMD.toFixed(2) + 'y' : '—'}
            </span>
          </div>
          <div style={{ fontSize: 10, color: 'var(--text-3)', marginLeft: 'auto' }}>
            For every 100bps yield rise, FI value falls ~{fiSleeveStats.weightedMD !== null ? fiSleeveStats.weightedMD.toFixed(1) : '—'}%
          </div>
        </div>
      )}

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
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <label style={{ fontSize: 10, color: 'var(--text-3)', letterSpacing: '0.1em', fontWeight: 600, textTransform: 'uppercase' }}>Trade date</label>
                <input
                  type="date"
                  className="input-h"
                  value={newHolding.trade_date}
                  onChange={e => setNewHolding(h => ({ ...h, trade_date: e.target.value }))}
                  style={{ width: 160 }}
                />
              </div>
              <button className="btn-h btn-h-primary" onClick={addHolding} style={{ alignSelf: 'flex-end' }}>Add</button>
              <button className="btn-h" onClick={() => setAdding(false)}>✕</button>
            </div>
          </div>
        </div>
      )}

      {/* Grouped holdings */}
      {Object.entries(grouped)
        .sort(([a], [b]) => (SLEEVE_ORDER[a] ?? 99) - (SLEEVE_ORDER[b] ?? 99))
        .map(([sleeveId, items]) => {
          const isFI = sleeveId === 'fi'
          return (
          <div key={sleeveId} className="panel" style={{ marginBottom: 14 }}>
            <div className="panel-header">
              <div className="panel-title">{SLEEVE_NAMES[sleeveId] ?? sleeveId}</div>
              <div className="panel-meta">
                {(items as any[]).length} position{(items as any[]).length === 1 ? '' : 's'}
              </div>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="h-table" style={{ minWidth: isFI ? 1340 : 1200 }}>
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
                    {isFI && <th className="num" title="Modified duration: % price change per 100bps yield change">Mod dur</th>}
                    {isFI && <th className="num" title="Convexity: 2nd-order curvature">Convexity</th>}
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
                      'No market price on record — displaying average cost.'
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
                    const fiM = fiMetrics.get(h.instrument_id)

                    return (
                      <tr key={h.instrument_id}>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span style={{ fontWeight: 500 }}>{h.instrument?.name}</span>
                            {ngxMarket && (
                              <span
                                style={{
                                  fontSize: 9, padding: '1px 6px', borderRadius: 2,
                                  background: ngxMarket === 'Premium Board' ? 'var(--gold-soft)' : 'var(--bg-soft)',
                                  color: ngxMarket === 'Premium Board' ? 'var(--gold)' : 'var(--text-3)',
                                  border: '1px solid var(--border)',
                                  fontWeight: 600, letterSpacing: '0.04em', whiteSpace: 'nowrap' as const,
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
                        <td><span className={`pill ${typePill}`}>{h.instrument?.type}</span></td>
                        <td style={{ fontSize: 11, color: sectorRaw ? 'var(--text-2)' : 'var(--text-4)' }}>
                          {sectorRaw ? (
                            <span title={sectorRaw}>
                              {sectorRaw.toLowerCase().split(/\s+/).map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')}
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
                            fontFamily: 'var(--font-mono)', fontSize: 11,
                            color: dayChgVal === null || dayChgVal === undefined ? 'var(--text-4)' :
                              dayChgVal > 0 ? 'var(--pos)' : dayChgVal < 0 ? 'var(--neg)' : 'var(--text-3)',
                          }}
                        >
                          {dayChgVal === null || dayChgVal === undefined
                            ? '—'
                            : <>{dayChgVal > 0 ? '+' : ''}{dayChgVal.toFixed(2)}%</>}
                        </td>
                        {isFI && (
                          <td className="num" style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: fiM?.mod_duration !== null && fiM?.mod_duration !== undefined ? 'var(--text-2)' : 'var(--text-4)' }}>
                            {fiM?.mod_duration !== null && fiM?.mod_duration !== undefined
                              ? `${fiM.mod_duration.toFixed(2)}y`
                              : '—'}
                          </td>
                        )}
                        {isFI && (
                          <td className="num" style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: fiM?.convexity !== null && fiM?.convexity !== undefined ? 'var(--text-2)' : 'var(--text-4)' }}>
                            {fiM?.convexity !== null && fiM?.convexity !== undefined
                              ? fiM.convexity.toFixed(1)
                              : '—'}
                          </td>
                        )}
                        <td
                          className="num"
                          style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: volume !== null && volume !== undefined ? 'var(--text-2)' : 'var(--text-4)' }}
                          title={volume !== null && volume !== undefined ? volume.toLocaleString() : undefined}
                        >
                          {formatVolume(volume)}
                        </td>
                        <td>
                          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11 }} title={dotTitle}>
                            <span style={{ width: 7, height: 7, borderRadius: '50%', background: dotColor, display: 'inline-block', flexShrink: 0 }} />
                            <span style={{ color: stale === 'stale' ? 'var(--warn)' : stale === 'none' ? 'var(--text-3)' : 'var(--text-2)' }}>
                              {formatShortDate(priceDate)}
                            </span>
                          </span>
                        </td>
                        <td className="num num-serif">{fmt.ngnM(mktVal)}</td>
                        <td className="num num-serif" style={{ color: pnl >= 0 ? 'var(--pos)' : 'var(--neg)' }}>
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
                              onClick={() => openEditModal(h)}
                              title="Edit quantity / cost / date"
                            >
                              <Edit3 size={10} />
                            </button>
                            <button
                              className="btn-h"
                              style={{ fontSize: 11, padding: '4px 8px', color: 'var(--text-3)' }}
                              onClick={() => deleteHolding(h.instrument_id)}
                              disabled={deleteBusy === h.instrument_id}
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
          )
        })}

      {/* v25: yield curve panel — only renders if portfolio holds FI */}
      {fiSleeveStats.hasFI && (
        <YieldCurvePanel
          lockedPortfolioId={portfolioId}
          lockedPortfolioName={`${portfolio?.client?.name ?? ''} ${portfolio?.name ?? ''}`.trim()}
        />
      )}
      {editingPosition && (
        <EditPositionModal
          portfolioId={portfolioId}
          state={editingPosition}
          onChange={setEditingPosition}
          onSave={saveEdit}
          onCancel={() => setEditingPosition(null)}
          busy={editBusy}
        />
      )}
    </main>
  )
}

function EditPositionModal({
  portfolioId,
  state,
  onChange,
  onSave,
  onCancel,
  busy,
}: {
  portfolioId: string
  state: {
    instrument_id: string
    instrument_name: string
    quantity: string
    avg_cost: string
    trade_date: string
  }
  onChange: (next: any) => void
  onSave: () => void
  onCancel: () => void
  busy: boolean
}) {
  const [provenance, setProvenance] = useState<{
    manual: number
    synth: number
    reconciliation: number
    broker: number
    other: number
    total: number
  } | null>(null)

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(
          `/api/holdings/provenance?portfolioId=${portfolioId}&instrumentId=${state.instrument_id}`
        )
        const data = await res.json()
        if (!cancelled && data?.counts) setProvenance(data.counts)
      } catch {
        /* ignore */
      }
    })()
    return () => { cancelled = true }
  }, [portfolioId, state.instrument_id])

  const nonManual = provenance
    ? provenance.synth + provenance.reconciliation + provenance.broker + provenance.other
    : 0

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(10, 31, 58, 0.55)',
      }}
    >
      <div
        style={{
          background: 'var(--card)',
          border: '1px solid var(--border)',
          borderRadius: 5,
          padding: 24,
          width: 460,
          boxShadow: '0 10px 40px rgba(10, 31, 58, 0.3)',
        }}
      >
        <div style={{ marginBottom: 16 }}>
          <div className="hybrid-serif" style={{ fontSize: 18, fontWeight: 500, color: 'var(--text)' }}>
            Edit position
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
            {state.instrument_name} ({state.instrument_id})
          </div>
        </div>

        {nonManual > 0 && provenance && (
          <div
            style={{
              padding: '10px 12px',
              background: 'rgba(166, 124, 42, 0.1)',
              border: '1px solid rgba(166, 124, 42, 0.3)',
              borderRadius: 4,
              marginBottom: 14,
              fontSize: 11,
              color: 'var(--text-2)',
              display: 'flex',
              gap: 10,
              alignItems: 'flex-start',
            }}
          >
            <AlertTriangle size={14} style={{ color: 'var(--warn)', flexShrink: 0, marginTop: 1 }} />
            <div>
              <strong style={{ color: 'var(--warn)' }}>Mixed provenance.</strong>{' '}
              {provenance.manual} manual-entry row(s) will be replaced.{' '}
              {nonManual} non-manual row(s) will be PRESERVED:{' '}
              {[
                provenance.synth          > 0 && `${provenance.synth} synth`,
                provenance.reconciliation > 0 && `${provenance.reconciliation} reconciliation`,
                provenance.broker         > 0 && `${provenance.broker} broker`,
                provenance.other          > 0 && `${provenance.other} other`,
              ].filter(Boolean).join(', ')}.
              {' '}The position's final qty / cost will blend your edit with the preserved rows.
            </div>
          </div>
        )}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
          <div>
            <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>
              Quantity / Face (₦)
            </label>
            <input
              type="number"
              value={state.quantity}
              onChange={e => onChange({ ...state, quantity: e.target.value })}
              disabled={busy}
              className="input-h input-h-mono"
              style={{ width: '100%' }}
            />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>
              Avg cost
            </label>
            <input
              type="number"
              value={state.avg_cost}
              onChange={e => onChange({ ...state, avg_cost: e.target.value })}
              disabled={busy}
              step="0.01"
              className="input-h input-h-mono"
              style={{ width: '100%' }}
            />
          </div>
        </div>

        <div style={{ marginBottom: 18 }}>
          <label
            style={{
              display: 'block',
              fontSize: 10,
              letterSpacing: '0.1em',
              fontWeight: 600,
              color: 'var(--text-3)',
              textTransform: 'uppercase',
              marginBottom: 6,
            }}
          >
            Trade date
          </label>
          <input
            type="date"
            value={state.trade_date}
            onChange={e => onChange({ ...state, trade_date: e.target.value })}
            disabled={busy}
            className="input-h"
            style={{ width: 200 }}
          />
        </div>

        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={onSave}
            disabled={busy || !state.quantity || !state.trade_date}
            className="btn-h btn-h-primary"
          >
            {busy ? 'Saving…' : 'Save changes'}
          </button>
          <button onClick={onCancel} disabled={busy} className="btn-h">
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
