'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Chart, ScatterController, PointElement, LinearScale, Tooltip, Legend, type ChartConfiguration } from 'chart.js'
import { Calendar, AlertCircle, TrendingUp, Building2 } from 'lucide-react'
import { supabase } from '@/lib/supabase'
import { computeDurationConvexity } from '@/lib/bond-yield'

// v25: Yield curve visualization.
// v27c: Adds firm-wide overlay mode (Cockpit FI book context).
//
// Three modes (precedence order):
//   1. lockedPortfolioId set → no picker; holdings overlay = that portfolio
//   2. firmOverlay true     → no picker; holdings overlay = aggregated firm-wide
//   3. neither             → picker shown; user chooses which portfolio (or none)
//
// Numeric coercion at the DB-to-JS boundary (pitfall #72).
// All .toFixed call sites guarded by render helpers (pitfall #73).

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
  tenor_years:      number
  yield_pct:        number
  coupon_pct:       number | null
  maturity_date:    string
  mod_duration:     number | null
  convexity:        number | null
  // v27c — firm-mode fields (undefined in per-portfolio mode)
  mandate_count?:   number
  portfolio_codes?: string[]
}

interface PortfolioOption {
  id:           string
  name:         string
  client_name:  string
}

interface Props {
  lockedPortfolioId?: string
  lockedPortfolioName?: string
  firmOverlay?: boolean   // v27c — render aggregated firm-wide FI holdings as overlay
}

// ─── Numeric helpers ──────────────────────────────────────────────────────
const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return isFinite(n) ? n : null
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

const GROUP_COLOR: Record<FIGroup, string> = {
  federal:       '#0f2947',
  federal_sukuk: '#2d6e4e',
  fgs_fgnsb:     '#5780a8',
  sub_sovereign: '#a67c2a',
  corporate:     '#a63b3b',
}
const HOLDINGS_COLOR = '#c9a556'

const STALE_DAYS = 14

// ─── Component ────────────────────────────────────────────────────────────
export default function YieldCurvePanel({ lockedPortfolioId, lockedPortfolioName, firmOverlay }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const chartRef  = useRef<Chart | null>(null)

  const [availableDates, setAvailableDates] = useState<string[]>([])
  const [selectedDate,   setSelectedDate]   = useState<string>('current')
  const [points,         setPoints]         = useState<CurvePoint[]>([])
  const [pointsLoading,  setPointsLoading]  = useState(true)
  const [pointsError,    setPointsError]    = useState('')

  const [portfolios,            setPortfolios]            = useState<PortfolioOption[]>([])
  const [overlayPortfolioId,    setOverlayPortfolioId]    = useState<string>(lockedPortfolioId ?? '')
  const [holdings,              setHoldings]              = useState<HoldingPoint[]>([])
  const [holdingsLoading,       setHoldingsLoading]       = useState(false)

  // Mode resolution
  const modePicker = !lockedPortfolioId && !firmOverlay
  const modeFirm   = !lockedPortfolioId && firmOverlay === true

  // ─── Mount: load distinct dates and portfolio options ───────────────────
  useEffect(() => {
    (async () => {
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

      // Portfolio picker — only relevant in mode 3
      if (modePicker) {
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
  }, [modePicker])

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
        if (tenor <= 0) continue

        let modDur: number | null = null
        let convex: number | null = null
        if (couponNum !== null) {
          const dc = computeDurationConvexity(yp, couponNum, matIso, asOfForTenor, 2)
          if (dc) { modDur = dc.mod_duration; convex = dc.convexity }
        }

        let vwc: 'traded' | 'quoted' | 'stale' = 'quoted'
        if (selectedDate === 'current') {
          const ageDays = (new Date(today + 'T00:00:00Z').getTime() - new Date(asOfIso + 'T00:00:00Z').getTime()) / 86_400_000
          if (ageDays > STALE_DAYS) vwc = 'stale'
          else if ((latestVolMap.get(r.instrument_id) ?? 0) > 0) vwc = 'traded'
          else vwc = 'quoted'
        } else {
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

      const filtered = out.filter(p => p.yield_pct >= 5 && p.yield_pct <= 50)
      setPoints(filtered)
    } catch (e: any) {
      setPointsError(e?.message || String(e))
      setPoints([])
    } finally {
      setPointsLoading(false)
    }
  }

  // ─── Per-portfolio holdings load (modes 1 + 3 picker selection) ────────
  useEffect(() => {
    if (modeFirm) return  // firm mode handled separately
    if (!overlayPortfolioId) { setHoldings([]); return }
    if (points.length === 0) return
    loadHoldings(overlayPortfolioId)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [overlayPortfolioId, points.length, selectedDate, modeFirm])

  async function loadHoldings(pid: string) {
    setHoldingsLoading(true)
    try {
      const { data: holds } = await supabase
        .from('holdings')
        .select('instrument_id, quantity, avg_cost, instrument:instruments(sleeve_id, name, coupon_pct, maturity_date)')
        .eq('portfolio_id', pid)

      const out: HoldingPoint[] = []
      for (const h of (holds ?? []) as any[]) {
        const instr = h.instrument
        if (!instr || instr.sleeve_id !== 'fi') continue
        if (!instr.maturity_date) continue
        const qty     = numOrNull(h.quantity) ?? 0
        const avgCost = numOrNull(h.avg_cost) ?? 0
        if (qty <= 0) continue

        const cp = points.find(p => p.instrument_id === h.instrument_id)
        if (!cp) continue

        out.push({
          instrument_id: h.instrument_id,
          name:          instr.name,
          quantity:      qty,
          market_value:  qty,
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

  // ─── v27c — Firm-wide aggregated holdings load (mode 2) ─────────────────
  useEffect(() => {
    if (!modeFirm) return
    if (points.length === 0) return
    loadFirmHoldings()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modeFirm, points.length, selectedDate])

  async function loadFirmHoldings() {
    setHoldingsLoading(true)
    try {
      // Fetch all active portfolios with client_code
      const { data: pData } = await supabase
        .from('portfolios')
        .select('id, client:clients(code, type)')
        .eq('status', 'active')
        .limit(2000)
      const codeByPortfolio = new Map<string, string>()
      const activePids: string[] = []
      for (const p of (pData ?? []) as any[]) {
        activePids.push(p.id)
        codeByPortfolio.set(p.id, p.client?.code ?? '—')
      }
      if (activePids.length === 0) { setHoldings([]); return }

      const { data: holds } = await supabase
        .from('holdings')
        .select('portfolio_id, instrument_id, quantity, instrument:instruments(sleeve_id, name)')
        .in('portfolio_id', activePids)
        .limit(50000)

      // Aggregate qty per FI instrument
      const qtyMap   = new Map<string, number>()
      const codeMap  = new Map<string, Set<string>>()
      const nameMap  = new Map<string, string>()

      for (const h of (holds ?? []) as any[]) {
        const sleeve = h.instrument?.sleeve_id
        if (sleeve !== 'fi') continue
        const qty = numOrNull(h.quantity) ?? 0
        if (qty <= 0) continue
        qtyMap.set(h.instrument_id, (qtyMap.get(h.instrument_id) ?? 0) + qty)
        let codes = codeMap.get(h.instrument_id)
        if (!codes) { codes = new Set(); codeMap.set(h.instrument_id, codes) }
        const code = codeByPortfolio.get(h.portfolio_id)
        if (code) codes.add(code)
        if (!nameMap.has(h.instrument_id)) {
          nameMap.set(h.instrument_id, h.instrument?.name ?? h.instrument_id)
        }
      }

      // Join with curve points for plot coordinates
      const out: HoldingPoint[] = []
      for (const [instrId, qty] of qtyMap) {
        const cp = points.find(p => p.instrument_id === instrId)
        if (!cp) continue
        const codes = Array.from(codeMap.get(instrId) ?? []).sort()
        out.push({
          instrument_id:   instrId,
          name:            nameMap.get(instrId) ?? instrId,
          quantity:        qty,
          market_value:    qty,
          avg_cost:        0,            // not meaningful aggregated
          tenor_years:     cp.tenor_years,
          yield_pct:       cp.yield_pct,
          coupon_pct:      cp.coupon_pct,
          maturity_date:   cp.maturity_date,
          mod_duration:    cp.mod_duration,
          convexity:       cp.convexity,
          mandate_count:   codes.length,
          portfolio_codes: codes,
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

    const groupOrder: FIGroup[] = ['federal', 'federal_sukuk', 'fgs_fgnsb', 'sub_sovereign', 'corporate']
    for (const g of groupOrder) {
      const pts = points.filter(p => p.group === g)
      if (pts.length === 0) continue
      datasets.push({
        label: GROUP_LABEL[g],
        data: pts.map(p => ({
          x: p.tenor_years,
          y: p.yield_pct,
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

    if (holdings.length > 0) {
      const maxMV = Math.max(...holdings.map(h => h.market_value), 1)
      const overlayLabel = modeFirm
        ? `Firm-wide holdings — ${holdings.length} bond${holdings.length === 1 ? '' : 's'}`
        : (lockedPortfolioName ? `Holdings — ${lockedPortfolioName}` : 'Portfolio holdings')
      datasets.push({
        label: overlayLabel,
        data: holdings.map(h => ({
          x: h.tenor_years,
          y: h.yield_pct,
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
          return 7 + ratio * 6
        }) as any,
        pointHoverRadius: ((ctx: any) => {
          const h = ctx.raw?._payload as HoldingPoint | undefined
          if (!h) return 11
          const ratio = h.market_value / maxMV
          return 10 + ratio * 6
        }) as any,
        pointStyle: 'rectRot',
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
                if (kind === 'holding') {
                  const h = p as HoldingPoint
                  if (h.mandate_count !== undefined) return `★ ${h.name} (FIRM-WIDE)`
                  return `★ ${h.name} (HELD)`
                }
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
                  if (h.mandate_count !== undefined) {
                    lines.push(`Held by: ${h.mandate_count} mandate${h.mandate_count === 1 ? '' : 's'}`)
                    if (h.portfolio_codes && h.portfolio_codes.length > 0) {
                      lines.push(`  ${h.portfolio_codes.join(', ')}`)
                    }
                    lines.push(`Aggregate face: ${h.quantity.toLocaleString()}`)
                  } else {
                    lines.push(`Qty / Face: ${h.quantity.toLocaleString()}`)
                    lines.push(`Avg cost: ${fmtNaira(h.avg_cost)}`)
                  }
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
  }, [points, holdings, lockedPortfolioName, modeFirm])

  // ─── Render ─────────────────────────────────────────────────────────────
  const tradedCount = useMemo(() => points.filter(p => p.vwc_tag === 'traded').length, [points])
  const quotedCount = useMemo(() => points.filter(p => p.vwc_tag === 'quoted').length, [points])
  const staleCount  = useMemo(() => points.filter(p => p.vwc_tag === 'stale').length,  [points])

  const dateLabel = selectedDate === 'current' ? 'Current snapshot' : fmtDate(selectedDate)

  // Footer summary helpers (work in both per-portfolio and firm modes)
  const totalMV = holdings.reduce((s, h) => s + h.market_value, 0)
  const wMD = totalMV > 0
    ? holdings.reduce((s, h) => s + (h.mod_duration ?? 0) * h.market_value, 0) / totalMV
    : null
  const wY = totalMV > 0
    ? holdings.reduce((s, h) => s + h.yield_pct * h.market_value, 0) / totalMV
    : null
  const totalMandates = modeFirm
    ? new Set(holdings.flatMap(h => h.portfolio_codes ?? [])).size
    : null

  return (
    <div className="panel" style={{ marginBottom: 18 }}>
      <div className="panel-header" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div className="panel-title">
            Yield curve
            {modeFirm && (
              <span style={{
                marginLeft: 10,
                fontSize: 10,
                letterSpacing: '0.14em',
                fontWeight: 600,
                color: 'var(--gold)',
                textTransform: 'uppercase',
                fontFamily: 'var(--font-sans)',
                fontStyle: 'normal',
              }}>
                <Building2 size={11} style={{ display: 'inline', marginRight: 4, verticalAlign: '-1px' }} />
                Firm-wide overlay
              </span>
            )}
          </div>
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

          {modePicker && portfolios.length > 0 && (
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
              {holdingsLoading
                ? 'Loading holdings…'
                : modeFirm
                  ? `${holdings.length} firm-wide bond${holdings.length === 1 ? '' : 's'} held by ${totalMandates ?? 0} mandate${totalMandates === 1 ? '' : 's'}`
                  : `${holdings.length} held bond${holdings.length === 1 ? '' : 's'}`}
            </strong>
            {!holdingsLoading && holdings.length > 0 && (
              <>
                {' · '}
                <span>weighted MD: <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>
                  {wMD !== null ? fmtYears(wMD) : '—'}
                </span></span>
                {' · '}
                <span>weighted yield: <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>
                  {wY !== null ? fmtPct(wY) : '—'}
                </span></span>
              </>
            )}
          </span>
        </div>
      )}
    </div>
  )
}
