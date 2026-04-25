'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Chart, ScatterController, PointElement, LinearScale, Tooltip, Legend, type ChartConfiguration } from 'chart.js'
import { Calendar, AlertCircle, TrendingUp } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { computeDurationConvexity } from '@/lib/bond-yield'

// v25: Yield curve visualization.
//
// Shows a scatter plot of yields vs. years to maturity for the FI universe
// at a selected historical date. Colored by the same 5 sub-type groups used
// in fi-context.ts. Optional portfolio overlay draws holdings as gold
// diamonds sized by market value.
//
// Data flow:
//   - on mount: fetch distinct yield_as_of dates from yield_history (DESC)
//   - on date change: fetch yield_history rows for that date OR (for 'current')
//                     fetch instruments.yield_* directly
//   - on portfolio change: fetch holdings + transactions to compute avg cost
//                          and overlay only the bonds this portfolio holds
//
// All numeric coercion at the DB-to-JS boundary (pitfall #72).
// All .toFixed call sites guarded by hasNum (pitfall #73).

Chart.register(ScatterController, PointElement, LinearScale, Tooltip, Legend)

// ─── Types ────────────────────────────────────────────────────────────────
type FIGroup = 'federal' | 'federal_sukuk' | 'fgs_fgnsb' | 'sub_sovereign' | 'corporate'

interface CurvePoint {
  instrument_id: string
  name:          string
  group:         FIGroup
  group_label:   string
  tenor_years:   number
  yield_pct:     number
  coupon_pct:    number | null
  maturity_date: string
  yield_as_of:   string
  mod_duration:  number | null
  convexity:     number | null
  vwc_tag:       'traded' | 'quoted' | 'stale'
  volume:        number | null
  deals:         number | null
}

interface HoldingPoint {
  instrument_id:    string
  name:             string
  quantity:         number
  market_value:     number
  avg_cost:         number
  // mirrors CurvePoint fields so we can plot it
  tenor_years:      number
  yield_pct:        number
  coupon_pct:       number | null
  maturity_date:    string
  mod_duration:     number | null
  convexity:        number | null
}

interface PortfolioOption {
  id:           string
  name:         string
  client_name:  string
}

interface Props {
  lockedPortfolioId?: string  // If set, picker is hidden and the panel is locked to this portfolio
  lockedPortfolioName?: string
}

// ─── Numeric helpers ──────────────────────────────────────────────────────
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return isFinite(n) ? n : null
}
const hasNum = (v: unknown): boolean => {
  if (v === null || v === undefined) return false
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return isFinite(n)
}
function fmtPct(v: unknown, dp = 2): string {
  const n = numOrNull(v); return n === null ? '—' : `${n.toFixed(dp)}%`
}
function fmtYears(v: unknown, dp = 1): string {
  const n = numOrNull(v); return n === null ? '—' : `${n.toFixed(dp)}y`
}
function fmtNaira(v: unknown): string {
  const n = numOrNull(v); if (n === null) return '—'
  if (Math.abs(n) >= 1e9) return `\u20a6${(n / 1e9).toFixed(2)}B`
  if (Math.abs(n) >= 1e6) return `\u20a6${(n / 1e6).toFixed(2)}M`
  if (Math.abs(n) >= 1e3) return `\u20a6${(n / 1e3).toFixed(1)}K`
  return `\u20a6${n.toFixed(2)}`
}
function fmtVolume(v: unknown): string {
  const n = numOrNull(v); if (n === null) return '—'
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B'
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M'
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K'
  return n.toFixed(0)
}
function fmtDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso + 'T00:00:00Z')
  if (isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })
}

// ─── Group classification (mirrors lib/fi-context.ts) ─────────────────────
function parseSubType(notes: string | null, ticker: string, name: string): string {
  if (notes) {
    const m = notes.match(/^\[([^\]]+)\]/)
    if (m) return m[1].trim()
  }
  if (ticker.startsWith('CP'))                             return 'Commercial Paper'
  if (/FGNSB/i.test(name))                                 return 'FGNSB'
  if (/FHSUK|FGSUK/i.test(ticker) || /FHSUK/i.test(name))  return 'Federal Sukuk'
  if (ticker.startsWith('FGS'))                            return 'FGS'
  if (/FGN/i.test(name))                                   return 'Federal'
  if (/LASUK|LAB/i.test(ticker))                           return 'State'
  if (/NSP/i.test(ticker))                                 return 'Impact Board'
  return 'Corporate'
}
function groupOf(subType: string): FIGroup {
  const s = subType.toLowerCase()
  if (s.includes('federal sukuk'))   return 'federal_sukuk'
  if (s === 'federal')               return 'federal'
  if (s === 'fgs' || s === 'fgnsb')  return 'fgs_fgnsb'
  if (s.includes('state') || s.includes('impact') || s.includes('municipal')) return 'sub_sovereign'
  return 'corporate'
}

const GROUP_LABEL: Record<FIGroup, string> = {
  federal:       'Federal',
  federal_sukuk: 'Federal Sukuk',
  fgs_fgnsb:     'FGS / FGNSB',
  sub_sovereign: 'Sub-Sovereign',
  corporate:     'Corporate / CP',
}

// Distinct, accessible colors for the 5 groups + holdings overlay
const GROUP_COLOR: Record<FIGroup, string> = {
  federal:       '#0f2947',   // navy
  federal_sukuk: '#2d6e4e',   // forest green
  fgs_fgnsb:     '#5780a8',   // muted blue
  sub_sovereign: '#a67c2a',   // bronze
  corporate:     '#a63b3b',   // burgundy
}
const HOLDINGS_COLOR = '#c9a556'  // bright gold

const STALE_DAYS = 14

// ─── Component ────────────────────────────────────────────────────────────
export default function YieldCurvePanel({ lockedPortfolioId, lockedPortfolioName }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const chartRef  = useRef<Chart | null>(null)

  const [availableDates, setAvailableDates] = useState<string[]>([])  // ISO dates DESC
  const [selectedDate,   setSelectedDate]   = useState<string>('current')
  const [points,         setPoints]         = useState<CurvePoint[]>([])
  const [pointsLoading,  setPointsLoading]  = useState(true)
  const [pointsError,    setPointsError]    = useState('')

  const [portfolios,            setPortfolios]            = useState<PortfolioOption[]>([])
  const [overlayPortfolioId,    setOverlayPortfolioId]    = useState<string>(lockedPortfolioId ?? '')
  const [holdings,              setHoldings]              = useState<HoldingPoint[]>([])
  const [holdingsLoading,       setHoldingsLoading]       = useState(false)

  // ─── Mount: load distinct dates and portfolio options ───────────────────
  useEffect(() => {
    (async () => {
      // Distinct dates
      const { data: dateData } = await supabase
        .from('yield_history')
        .select('yield_as_of')
        .order('yield_as_of', { ascending: false })
        .limit(2000)
      const seen = new Set<string>()
      const dates: string[] = []
      for (const r of (dateData ?? []) as any[]) {
        if (r.yield_as_of && !seen.has(r.yield_as_of)) {
          seen.add(r.yield_as_of)
          dates.push(r.yield_as_of)
        }
      }
      setAvailableDates(dates)

      // Portfolios — only relevant if not locked
      if (!lockedPortfolioId) {
        const { data: pData } = await supabase
          .from('portfolios')
          .select('id, name, client:clients(name)')
          .eq('status', 'active')
          .order('name')
        const opts: PortfolioOption[] = []
        for (const p of (pData ?? []) as any[]) {
          opts.push({ id: p.id, name: p.name, client_name: p.client?.name ?? '—' })
        }
        setPortfolios(opts)
      }
    })()
  }, [lockedPortfolioId])

  // ─── Load curve points whenever selectedDate changes ────────────────────
  useEffect(() => { loadCurve() }, [selectedDate])

  async function loadCurve() {
    setPointsLoading(true)
    setPointsError('')
    try {
      const today = new Date().toISOString().slice(0, 10)

      let raw: any[] = []
      let asOfForTenor = today

      if (selectedDate === 'current') {
        // Fall back to instruments.yield_* — the freshest snapshot per instrument
        const { data, error } = await supabase
          .from('instruments')
          .select('instrument_id, name, coupon_pct, maturity_date, yield_pct, yield_as_of, notes')
          .eq('sleeve_id', 'fi')
          .eq('approved', true)
          .not('yield_pct',     'is', null)
          .not('maturity_date', 'is', null)
          .limit(500)
        if (error) throw error
        raw = data ?? []
      } else {
        // Fetch yield_history for the chosen date, joined with instruments for name + notes
        const { data: hist, error: hErr } = await supabase
          .from('yield_history')
          .select('instrument_id, yield_as_of, yield_pct, coupon_pct, maturity_date, volume, deals')
          .eq('yield_as_of', selectedDate)
          .limit(500)
        if (hErr) throw hErr

        const ids = (hist ?? []).map((h: any) => h.instrument_id)
        const { data: instr, error: iErr } = await supabase
          .from('instruments')
          .select('instrument_id, name, notes')
          .in('instrument_id', ids)
          .limit(500)
        if (iErr) throw iErr

        const nameMap = new Map<string, { name: string; notes: string | null }>()
        for (const r of (instr ?? []) as any[]) {
          nameMap.set(r.instrument_id, { name: r.name, notes: r.notes })
        }
        raw = (hist ?? []).map((h: any) => ({
          ...h,
          name:  nameMap.get(h.instrument_id)?.name  ?? h.instrument_id,
          notes: nameMap.get(h.instrument_id)?.notes ?? null,
        }))
        asOfForTenor = selectedDate
      }

      // Latest volume per instrument (across all yield_history) for VWC tag.
      // Used regardless of whether selectedDate is 'current' or historical.
      const { data: latestVolData } = await supabase
        .from('yield_history')
        .select('instrument_id, yield_as_of, volume')
        .order('yield_as_of', { ascending: false })
        .limit(2000)
      const latestVolMap = new Map<string, number | null>()
      for (const r of (latestVolData ?? []) as any[]) {
        if (!latestVolMap.has(r.instrument_id)) {
          latestVolMap.set(r.instrument_id, numOrNull(r.volume))
        }
      }

      // Build CurvePoint[]
      const out: CurvePoint[] = []
      for (const r of raw) {
        const yp = numOrNull(r.yield_pct)
        if (yp === null || yp <= 0) continue
        if (!r.maturity_date) continue
        const subType = parseSubType(r.notes ?? null, r.instrument_id, r.name)
        const grp     = groupOf(subType)
        const couponNum = numOrNull(r.coupon_pct)
        const matIso = String(r.maturity_date).slice(0, 10)
        const asOfIso = (selectedDate === 'current')
          ? (r.yield_as_of ? String(r.yield_as_of).slice(0, 10) : today)
          : selectedDate
        const tenor = (new Date(matIso + 'T00:00:00Z').getTime() - new Date(asOfForTenor + 'T00:00:00Z').getTime()) / 86_400_000 / 365.25
        if (tenor <= 0) continue  // matured

        let modDur: number | null = null
        let convex: number | null = null
        if (couponNum !== null) {
          const dc = computeDurationConvexity(yp, couponNum, matIso, asOfForTenor, 2)
          if (dc) { modDur = dc.mod_duration; convex = dc.convexity }
        }

        // VWC tag — use the latest-volume map for traded/quoted; stale based on yield age
        let vwc: 'traded' | 'quoted' | 'stale' = 'quoted'
        if (selectedDate === 'current') {
          const ageDays = (new Date(today + 'T00:00:00Z').getTime() - new Date(asOfIso + 'T00:00:00Z').getTime()) / 86_400_000
          if (ageDays > STALE_DAYS) vwc = 'stale'
          else if ((latestVolMap.get(r.instrument_id) ?? 0) > 0) vwc = 'traded'
          else vwc = 'quoted'
        } else {
          // Historical: traded if THIS row's volume > 0; otherwise quoted.
          const v = numOrNull(r.volume)
          if (v !== null && v > 0) vwc = 'traded'
          else vwc = 'quoted'
        }

        out.push({
          instrument_id: r.instrument_id,
          name:          r.name,
          group:         grp,
          group_label:   GROUP_LABEL[grp],
          tenor_years:   tenor,
          yield_pct:     yp,
          coupon_pct:    couponNum,
          maturity_date: matIso,
          yield_as_of:   asOfIso,
          mod_duration:  modDur,
          convexity:     convex,
          vwc_tag:       vwc,
          volume:        numOrNull(r.volume),
          deals:         numOrNull(r.deals),
        })
      }

      // Filter extreme yields to keep the chart readable; user sees them in the table
      const filtered = out.filter(p => p.yield_pct >= 5 && p.yield_pct <= 50)
      setPoints(filtered)
    } catch (e: any) {
      setPointsError(e?.message || String(e))
      setPoints([])
    } finally {
      setPointsLoading(false)
    }
  }

  // ─── Load holdings for the selected portfolio ───────────────────────────
  useEffect(() => {
    if (!overlayPortfolioId) { setHoldings([]); return }
    if (points.length === 0) return
    loadHoldings(overlayPortfolioId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlayPortfolioId, points.length, selectedDate])

  async function loadHoldings(pid: string) {
    setHoldingsLoading(true)
    try {
      const { data: holds } = await supabase
        .from('holdings')
        .select('instrument_id, quantity, avg_cost, instrument:instruments(sleeve_id, name, coupon_pct, maturity_date)')
        .eq('portfolio_id', pid)

      const out: HoldingPoint[] = []
      const today = new Date().toISOString().slice(0, 10)
      const asOfForTenor = selectedDate === 'current' ? today : selectedDate

      for (const h of (holds ?? []) as any[]) {
        const instr = h.instrument
        if (!instr || instr.sleeve_id !== 'fi') continue
        if (!instr.maturity_date) continue
        const qty     = numOrNull(h.quantity) ?? 0
        const avgCost = numOrNull(h.avg_cost) ?? 0
        if (qty <= 0) continue

        // Find this instrument in the curve points to grab its yield + duration
        const cp = points.find(p => p.instrument_id === h.instrument_id)
        if (!cp) continue   // instrument not in current snapshot — skip

        // Market value uses face value × clean-price-equivalent.
        // For bonds, qty in our system is face value (NGX convention). Mark
        // current value via the YIELD on the curve, by computing what price
        // corresponds to that yield from the cashflows. As an approximation
        // for the overlay, we use qty × (curve_yield_factor) — the user will
        // see the size of the diamond as relative weight, not absolute Naira.
        // For a reasonable display value, use qty as-is (face) — this is
        // adequate for sizing purposes.
        const marketValue = qty   // face value, adequate for relative sizing

        out.push({
          instrument_id: h.instrument_id,
          name:          instr.name,
          quantity:      qty,
          market_value:  marketValue,
          avg_cost:      avgCost,
          tenor_years:   cp.tenor_years,
          yield_pct:     cp.yield_pct,
          coupon_pct:    cp.coupon_pct,
          maturity_date: cp.maturity_date,
          mod_duration:  cp.mod_duration,
          convexity:     cp.convexity,
        })
      }
      setHoldings(out)
    } catch {
      setHoldings([])
    } finally {
      setHoldingsLoading(false)
    }
  }

  // ─── Chart render / re-render ───────────────────────────────────────────
  useEffect(() => {
    if (!canvasRef.current) return
    if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null }

    const datasets: ChartConfiguration<'scatter'>['data']['datasets'] = []

    // Build one dataset per group
    const groupOrder: FIGroup[] = ['federal', 'federal_sukuk', 'fgs_fgnsb', 'sub_sovereign', 'corporate']
    for (const g of groupOrder) {
      const pts = points.filter(p => p.group === g)
      if (pts.length === 0) continue
      datasets.push({
        label: GROUP_LABEL[g],
        data: pts.map(p => ({
          x: p.tenor_years,
          y: p.yield_pct,
          // @ts-expect-error custom payload for tooltip
          _payload: p,
          _kind: 'curve',
        })),
        backgroundColor: GROUP_COLOR[g],
        borderColor: GROUP_COLOR[g],
        pointRadius: 4,
        pointHoverRadius: 7,
        pointStyle: 'circle',
      })
    }

    // Holdings overlay (if any)
    if (holdings.length > 0) {
      // Size point by market_value relative to max
      const maxMV = Math.max(...holdings.map(h => h.market_value), 1)
      datasets.push({
        label: lockedPortfolioName ? `Holdings — ${lockedPortfolioName}` : 'Portfolio holdings',
        data: holdings.map(h => ({
          x: h.tenor_years,
          y: h.yield_pct,
          // @ts-expect-error custom payload for tooltip
          _payload: h,
          _kind: 'holding',
        })),
        backgroundColor: HOLDINGS_COLOR,
        borderColor: '#0f2947',
        borderWidth: 1.5,
        pointRadius: ((ctx: any) => {
          const h = ctx.raw?._payload as HoldingPoint | undefined
          if (!h) return 8
          const ratio = h.market_value / maxMV
          return 7 + ratio * 6   // 7 to 13 px
        }) as any,
        pointHoverRadius: ((ctx: any) => {
          const h = ctx.raw?._payload as HoldingPoint | undefined
          if (!h) return 11
          const ratio = h.market_value / maxMV
          return 10 + ratio * 6
        }) as any,
        pointStyle: 'rectRot',  // diamond (rotated square)
      })
    }

    const config: ChartConfiguration<'scatter'> = {
      type: 'scatter',
      data: { datasets },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 250 },
        scales: {
          x: {
            title:  { display: true, text: 'Years to maturity', color: '#5c6573', font: { size: 11 } },
            min: 0,
            grid:   { color: 'rgba(15, 41, 71, 0.06)' },
            ticks:  { color: '#5c6573', font: { size: 11 }, callback: (v) => `${v}y` },
          },
          y: {
            title:  { display: true, text: 'Yield to maturity (%)', color: '#5c6573', font: { size: 11 } },
            grid:   { color: 'rgba(15, 41, 71, 0.06)' },
            ticks:  { color: '#5c6573', font: { size: 11 }, callback: (v) => `${v}%` },
          },
        },
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              color: '#0f2947',
              font: { size: 11, family: 'DM Sans' },
              padding: 12,
              usePointStyle: true,
              boxWidth: 8,
            },
          },
          tooltip: {
            backgroundColor: 'rgba(10, 31, 58, 0.96)',
            titleColor: '#c9a556',
            bodyColor: '#e8d9b5',
            padding: 11,
            displayColors: false,
            titleFont: { family: 'DM Sans', size: 12, weight: 600 },
            bodyFont:  { family: 'DM Sans', size: 11 },
            callbacks: {
              title: (items) => {
                const it = items[0]
                const p = (it.raw as any)?._payload
                if (!p) return ''
                const kind = (it.raw as any)?._kind
                if (kind === 'holding') return `★ ${p.name} (HELD)`
                return p.name
              },
              label: (item) => {
                const p = (item.raw as any)?._payload
                if (!p) return ''
                const kind = (item.raw as any)?._kind
                const lines: string[] = []
                if (kind === 'holding') {
                  const h = p as HoldingPoint
                  lines.push(`${h.instrument_id}`)
                  lines.push(`Qty / Face: ${h.quantity.toLocaleString()}`)
                  lines.push(`Avg cost: ${fmtNaira(h.avg_cost)}`)
                  lines.push(`Yield (curve): ${fmtPct(h.yield_pct)}`)
                  lines.push(`Tenor: ${fmtYears(h.tenor_years)} · matures ${fmtDate(h.maturity_date)}`)
                  if (h.coupon_pct !== null) lines.push(`Coupon: ${fmtPct(h.coupon_pct)}`)
                  if (h.mod_duration  !== null) lines.push(`Mod duration: ${fmtYears(h.mod_duration)}`)
                  if (h.convexity     !== null) lines.push(`Convexity: ${h.convexity.toFixed(1)}`)
                } else {
                  const c = p as CurvePoint
                  lines.push(`${c.instrument_id} · ${c.group_label}`)
                  lines.push(`Yield: ${fmtPct(c.yield_pct)}`)
                  lines.push(`Tenor: ${fmtYears(c.tenor_years)} · matures ${fmtDate(c.maturity_date)}`)
                  if (c.coupon_pct !== null) lines.push(`Coupon: ${fmtPct(c.coupon_pct)}`)
                  if (c.mod_duration  !== null) lines.push(`Mod duration: ${fmtYears(c.mod_duration)}`)
                  if (c.convexity     !== null) lines.push(`Convexity: ${c.convexity.toFixed(1)}`)
                  lines.push(`Liquidity: ${c.vwc_tag.toUpperCase()}${c.volume !== null ? ` · vol ${fmtVolume(c.volume)}` : ''}`)
                }
                return lines
              },
            },
          },
        },
      },
    }
    chartRef.current = new Chart(canvasRef.current, config)

    return () => {
      if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null }
    }
  }, [points, holdings, lockedPortfolioName])

  // ─── Render ─────────────────────────────────────────────────────────────
  const tradedCount = useMemo(() => points.filter(p => p.vwc_tag === 'traded').length, [points])
  const quotedCount = useMemo(() => points.filter(p => p.vwc_tag === 'quoted').length, [points])
  const staleCount  = useMemo(() => points.filter(p => p.vwc_tag === 'stale').length,  [points])

  const dateLabel = selectedDate === 'current' ? 'Current snapshot' : fmtDate(selectedDate)

  return (
    <div className="panel" style={{ marginBottom: 18 }}>
      <div className="panel-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div className="panel-title">Yield curve</div>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
            {points.length > 0
              ? <>{points.length} bonds plotted · <span style={{ color: 'var(--pos)' }}>{tradedCount} traded</span> · {quotedCount} quoted · <span style={{ color: 'var(--warn)' }}>{staleCount} stale</span></>
              : 'Loading…'}
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <Calendar size={12} style={{ color: 'var(--text-3)' }} />
            <select
              value={selectedDate}
              onChange={e => setSelectedDate(e.target.value)}
              className="select-h"
              style={{ width: 200, padding: '5px 32px 5px 10px', fontSize: 12 }}
              title="Select snapshot date"
            >
              <option value="current">Current snapshot</option>
              {availableDates.map(d => (
                <option key={d} value={d}>{fmtDate(d)}</option>
              ))}
            </select>
          </div>

          {!lockedPortfolioId && portfolios.length > 0 && (
            <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <TrendingUp size={12} style={{ color: 'var(--text-3)' }} />
              <select
                value={overlayPortfolioId}
                onChange={e => setOverlayPortfolioId(e.target.value)}
                className="select-h"
                style={{ width: 280, padding: '5px 32px 5px 10px', fontSize: 12 }}
                title="Overlay holdings from a portfolio"
              >
                <option value="">Universe only — no overlay</option>
                {portfolios.map(p => (
                  <option key={p.id} value={p.id}>
                    {p.client_name} — {p.name}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      </div>

      {pointsError && (
        <div className="alert-h alert-h-critical" style={{ fontSize: 11, marginBottom: 12, display: 'flex', alignItems: 'flex-start', gap: 6 }}>
          <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>Failed to load curve: {pointsError}</span>
        </div>
      )}

      <div style={{ position: 'relative', height: 380, marginTop: 6 }}>
        {pointsLoading && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-3)', fontSize: 12, background: 'rgba(255,255,255,0.5)', zIndex: 2 }}>
            Loading curve…
          </div>
        )}
        {!pointsLoading && points.length === 0 && !pointsError && (
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-3)', fontSize: 12 }}>
            No yield data for {dateLabel}
          </div>
        )}
        <canvas ref={canvasRef} style={{ width: '100%', height: '100%' }} />
      </div>

      {(holdings.length > 0 || holdingsLoading) && (
        <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border-soft)', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap', fontSize: 11, color: 'var(--text-2)' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{ width: 11, height: 11, background: HOLDINGS_COLOR, transform: 'rotate(45deg)', border: '1px solid var(--sidebar-bg)', display: 'inline-block' }} />
            <strong style={{ color: 'var(--text)' }}>
              {holdingsLoading ? 'Loading holdings…' : `${holdings.length} held bond${holdings.length === 1 ? '' : 's'}`}
            </strong>
            {!holdingsLoading && holdings.length > 0 && (
              <>
                {' · '}
                <span>weighted MD: <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>
                  {(() => {
                    const totalMV = holdings.reduce((s, h) => s + h.market_value, 0)
                    if (totalMV === 0) return '—'
                    const wMD = holdings.reduce((s, h) => s + (h.mod_duration ?? 0) * h.market_value, 0) / totalMV
                    return fmtYears(wMD)
                  })()}
                </span></span>
                {' · '}
                <span>weighted yield: <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>
                  {(() => {
                    const totalMV = holdings.reduce((s, h) => s + h.market_value, 0)
                    if (totalMV === 0) return '—'
                    const wY = holdings.reduce((s, h) => s + h.yield_pct * h.market_value, 0) / totalMV
                    return fmtPct(wY)
                  })()}
                </span></span>
              </>
            )}
          </span>
        </div>
      )}
    </div>
  )
}
