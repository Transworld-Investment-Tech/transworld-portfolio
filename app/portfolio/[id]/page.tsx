'use client'
import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import * as XLSX from 'xlsx'
import {
  RefreshCw, FileText, Download, AlertTriangle, Info, FileSpreadsheet,
} from 'lucide-react'
import dynamic from 'next/dynamic'
import { supabase } from '@/lib/supabase'
import {
  computeNAV, computeSleeveData, complianceAlerts, estimatedIncomePA,
  fmt, type Portfolio, type Holding, type SleeveTarget,
} from '@/lib/portfolio'

// v20c: Sidebar is rendered by app/portfolio/[id]/layout.tsx.
// v20: Hybrid Portfolio Overview — single page, no internal tabs.
// v21g: Performance panel surfaces IRR + period returns + benchmarks.
// v21h: Sector Concentration panel surfaces NAV-weighted sector
//   breakdown of held equities.
// v21j: Excel export via SheetJS. "Export Excel" button added between
//   "Live prices" and "Download report". Four-sheet workbook:
//   Summary (KPIs + performance), Allocation (sleeve targets vs actuals),
//   Holdings (all positions with market values), Dividends (if loaded).
//
// Pitfall #7: the "Download report" button MUST remain in the header
// and MUST call /api/export?portfolioId=... The apply-update.sh greps
// for both "Download report" and "/api/export".

const AllocationDonut = dynamic(() => import('@/components/portfolio/AllocationDonut'), { ssr: false })
const SectorDonut = dynamic(() => import('@/components/portfolio/SectorDonut'), { ssr: false })

const SLEEVE_FILL: Record<string, string> = {
  liq: 'var(--sidebar-bg)',
  eq:  'linear-gradient(90deg, var(--gold), var(--gold-bright))',
  fi:  'var(--pos)',
}

const PERIOD_TABS: { key: string; label: string }[] = [
  { key: '1W',  label: '1W'  },
  { key: '1M',  label: '1M'  },
  { key: '3M',  label: '3M'  },
  { key: '6M',  label: '6M'  },
  { key: '1Y',  label: '1Y'  },
  { key: '2Y',  label: '2Y'  },
  { key: '3Y',  label: '3Y'  },
  { key: '5Y',  label: '5Y'  },
  { key: 'ITD', label: 'ITD' },
]

function fmtPctSigned(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || isNaN(v)) return '—'
  const s = (v * 100).toFixed(digits)
  return (v >= 0 ? '+' : '') + s + '%'
}

function fmtIRR(v: number | null | undefined, digits = 2): { value: string; hasValue: boolean } {
  if (v === null || v === undefined || isNaN(v)) return { value: '—', hasValue: false }
  const s = (v * 100).toFixed(digits)
  return { value: (v >= 0 ? '+' : '') + s + '%', hasValue: true }
}

function buildSectorSlices(holdings: any[]): { slices: any[]; totalEquityNAV: number } {
  const equities = holdings.filter(h => h.instrument?.type === 'Stock')
  const totalEquityNAV = equities.reduce((s, h) => s + (h.quantity * (h.latest_price ?? h.avg_cost ?? 0)), 0)
  if (totalEquityNAV <= 0) return { slices: [], totalEquityNAV: 0 }
  const bySector = new Map<string, { value: number; count: number }>()
  for (const h of equities) {
    const sector = h.instrument?.sector || 'Unclassified'
    const value = h.quantity * (h.latest_price ?? h.avg_cost ?? 0)
    if (value <= 0) continue
    const prev = bySector.get(sector) ?? { value: 0, count: 0 }
    bySector.set(sector, { value: prev.value + value, count: prev.count + 1 })
  }
  const slices = Array.from(bySector.entries())
    .map(([sector, { value, count }]) => ({
      sector, value, pct: value / totalEquityNAV, count,
    }))
    .sort((a, b) => b.value - a.value)
  return { slices, totalEquityNAV }
}

export default function PortfolioOverviewPage() {
  const params = useParams()
  const portfolioId = params.id as string

  const [portfolio, setPortfolio] = useState<Portfolio | null>(null)
  const [holdings, setHoldings] = useState<Holding[]>([])
  const [sleeveDefs, setSleeveDefs] = useState<SleeveTarget[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [fxRate, setFxRate] = useState<number>(1665)
  const [dividends, setDividends] = useState<any>(null)
  const [divLoading, setDivLoading] = useState(false)
  const [divRefreshing, setDivRefreshing] = useState(false)
  const [divRefreshMsg, setDivRefreshMsg] = useState('')
  const [divFreshness, setDivFreshness] = useState<Date | null>(null)

  const [analyticsPeriod, setAnalyticsPeriod] = useState<string>('ITD')
  const [analytics, setAnalytics] = useState<any>(null)
  const [analyticsLoading, setAnalyticsLoading] = useState(false)

  const load = useCallback(async () => {
    const [portRes, holdRes, sleeveRes] = await Promise.all([
      supabase.from('portfolios').select('*, client:clients(name,code,type)').eq('id', portfolioId).single(),
      supabase.from('holdings').select('*, instrument:instruments(*)').eq('portfolio_id', portfolioId),
      supabase.from('sleeve_targets').select('*').eq('portfolio_id', portfolioId).order('sort_order'),
    ])
    if (portRes.data) setPortfolio(portRes.data)
    if (sleeveRes.data) setSleeveDefs(sleeveRes.data)
    if (holdRes.data) {
      const { data: prices } = await supabase
        .from('market_prices')
        .select('instrument_id, price, day_change')
        .in('instrument_id', holdRes.data.map((h: any) => h.instrument_id))
        .order('price_date', { ascending: false })
      const priceMap: Record<string, { price: number; day_change: number }> = {}
      prices?.forEach((p: any) => {
        if (!priceMap[p.instrument_id]) {
          priceMap[p.instrument_id] = { price: p.price, day_change: p.day_change ?? 0 }
        }
      })
      setHoldings(holdRes.data.map((h: any) => ({
        ...h,
        latest_price: priceMap[h.instrument_id]?.price ?? h.avg_cost,
        day_change: priceMap[h.instrument_id]?.day_change ?? 0,
      })))
    }
    setLoading(false)
  }, [portfolioId])

  useEffect(() => { load() }, [load])

  useEffect(() => {
    fetch('https://api.exchangerate-api.com/v4/latest/USD')
      .then(r => r.json())
      .then(d => { if (d.rates?.NGN) setFxRate(d.rates.NGN) })
      .catch(() => {})
  }, [])

  useEffect(() => {
    if (!portfolioId) return
    setDivLoading(true)
    fetch(`/api/dividends?portfolioId=${portfolioId}`)
      .then(r => r.json())
      .then(d => { setDividends(d); setDivLoading(false) })
      .catch(() => setDivLoading(false))
  }, [portfolioId, holdings.length])

  useEffect(() => {
    supabase
      .from('instruments')
      .select('div_last_refreshed_at')
      .eq('type', 'Stock').eq('approved', true)
      .not('div_last_refreshed_at', 'is', null)
      .order('div_last_refreshed_at', { ascending: false })
      .limit(1).maybeSingle()
      .then(({ data }) => {
        if (data?.div_last_refreshed_at) setDivFreshness(new Date(data.div_last_refreshed_at))
      })
  }, [])

  useEffect(() => {
    if (!portfolioId || loading) return
    setAnalyticsLoading(true)
    fetch(`/api/analytics?portfolioId=${portfolioId}&period=${analyticsPeriod}`)
      .then(r => r.json())
      .then(d => { setAnalytics(d); setAnalyticsLoading(false) })
      .catch(() => { setAnalyticsLoading(false) })
  }, [portfolioId, analyticsPeriod, loading])

  async function refreshDividends() {
    setDivRefreshing(true); setDivRefreshMsg('')
    try {
      const res = await fetch('/api/dividends/refresh', { method: 'POST' })
      const d = await res.json()
      setDivRefreshMsg(d.ok ? `✓ ${d.message ?? 'refreshed'}` : 'Refresh failed')
      const r2 = await fetch(`/api/dividends?portfolioId=${portfolioId}`)
      setDividends(await r2.json())
      const { data: f } = await supabase
        .from('instruments').select('div_last_refreshed_at')
        .eq('type', 'Stock').eq('approved', true)
        .not('div_last_refreshed_at', 'is', null)
        .order('div_last_refreshed_at', { ascending: false })
        .limit(1).maybeSingle()
      if (f?.div_last_refreshed_at) setDivFreshness(new Date(f.div_last_refreshed_at))
      setTimeout(() => setDivRefreshMsg(''), 6000)
    } catch { setDivRefreshMsg('Refresh failed') }
    setDivRefreshing(false)
  }

  async function refreshPrices() {
    setRefreshing(true)
    try {
      const res = await fetch('/api/prices', { method: 'POST', body: JSON.stringify({ portfolioId }) })
      if (res.ok) await load()
    } finally { setRefreshing(false) }
  }

  if (loading || !portfolio) {
    return (
      <div className="hybrid-page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-3)', fontSize: 14, minHeight: '100vh' }}>
        Loading portfolio…
      </div>
    )
  }

  const tot = computeNAV(holdings)
  const sv = computeSleeveData(holdings, sleeveDefs, tot)
  const hasStartingNav = portfolio.starting_nav > 0
  const pl = tot - portfolio.starting_nav
  const ret = hasStartingNav ? pl / portfolio.starting_nav : 0
  const incPA = dividends?.totalEstimatedIncome ?? estimatedIncomePA(holdings)
  const alerts = complianceAlerts(portfolio as any, holdings as any, sv as any, tot)
  const { slices: sectorSlices, totalEquityNAV } = buildSectorSlices(holdings)

  const divStaleInfo = (() => {
    if (!divFreshness) return { cls: 'none', text: 'Dividend data: never refreshed' }
    const days = Math.floor((Date.now() - divFreshness.getTime()) / 86_400_000)
    const fmtDate = divFreshness.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
    if (days <= 14) return { cls: 'fresh', text: `Fresh · refreshed ${fmtDate}` }
    return { cls: 'stale', text: `Data ${days}d old · refreshed ${fmtDate}` }
  })()

  const metrics = analytics?.period
  const irrDisplay = fmtIRR(metrics?.irr)
  const periodLabel = metrics?.periodLabel ?? PERIOD_TABS.find(t => t.key === analyticsPeriod)?.label ?? analyticsPeriod
  const daysHeld = metrics?.daysHeld ?? null
  const hasEnoughDataForIRR = metrics?.startNAV !== null && metrics?.startNAV !== undefined && metrics.startNAV > 0 && (daysHeld ?? 0) > 0

  // v21j: Excel export — 4-sheet workbook
  function downloadExcel() {
    if (!portfolio) return
    const wb = XLSX.utils.book_new()
    const today = new Date().toLocaleDateString('en-GB')
    const clientName = (portfolio as any).client?.name ?? ''
    const portfolioName = portfolio.name

    // Sheet 1: Summary
    const summaryRows: any[][] = [
      ['PORTFOLIO OVERVIEW', ''],
      ['Client', clientName],
      ['Portfolio', portfolioName],
      ['Export date', today],
      [''],
      ['NAV SUMMARY', ''],
      ['Current NAV (₦)', tot],
      ['Starting NAV (₦)', portfolio.starting_nav ?? 0],
      ['Unrealised P&L (₦)', tot - (portfolio.starting_nav ?? 0)],
      ['Total return', hasStartingNav ? ret : ''],
      ['Est. income p.a. (₦)', incPA ?? 0],
      ['Income target', portfolio.income_target ?? ''],
      ['Start date', portfolio.start_date ?? ''],
      [''],
      [`PERFORMANCE (${analyticsPeriod})`, ''],
      ['IRR p.a.', metrics?.irr ?? ''],
      ['Period return', metrics?.simplePeriodReturn ?? ''],
      ['Absolute P&L (₦)', metrics?.absoluteReturn ?? ''],
      ['TWR (ann.)', metrics?.twrAnnualised ?? metrics?.twr ?? ''],
      ['Days held', metrics?.daysHeld ?? ''],
      ['Period start', metrics?.startDate ?? ''],
      ['Period end', metrics?.endDate ?? ''],
      ['Net cash flows (₦)', metrics?.netCashFlows ?? ''],
    ]
    if (metrics?.benchmarks?.length > 0) {
      summaryRows.push([''])
      summaryRows.push(['BENCHMARKS', 'Annual rate'])
      metrics.benchmarks.forEach((b: any) => summaryRows.push([b.shortName, b.annualRate ?? '']))
    }
    const summaryWs = XLSX.utils.aoa_to_sheet(summaryRows)
    summaryWs['!cols'] = [{ wch: 26 }, { wch: 20 }]
    XLSX.utils.book_append_sheet(wb, summaryWs, 'Summary')

    // Sheet 2: Allocation
    const allocHeaders = [
      'Sleeve', 'Target %', 'Actual %',
      'Target Value (₦)', 'Actual Value (₦)', 'Deviation (₦)', 'Status', 'Suggested',
    ]
    const allocRows = (sv as any[]).map((s: any) => {
      const d = s.diff ?? 0
      const action = d > 50000 ? 'Buy' : d < -50000 ? 'Sell' : 'Hold'
      return [
        s.name,
        Number(((s.target_pct ?? 0) * 100).toFixed(2)),
        Number(((s.act ?? 0) * 100).toFixed(2)),
        tot * (s.target_pct ?? 0),
        s.val ?? 0,
        d,
        s.status,
        action,
      ]
    })
    const allocWs = XLSX.utils.aoa_to_sheet([allocHeaders, ...allocRows])
    allocWs['!cols'] = [
      { wch: 22 }, { wch: 10 }, { wch: 10 },
      { wch: 18 }, { wch: 18 }, { wch: 18 }, { wch: 10 }, { wch: 10 },
    ]
    XLSX.utils.book_append_sheet(wb, allocWs, 'Allocation')

    // Sheet 3: Holdings
    const holdHeaders = [
      'Instrument', 'Ticker', 'Type', 'Sector', 'Sleeve',
      'Quantity', 'Avg Cost (₦)', 'Current Price (₦)',
      'Market Value (₦)', 'Unrealised P&L (₦)', 'Weight %',
    ]
    const holdRows = (holdings as any[]).map(h => {
      const p = h.latest_price ?? h.avg_cost ?? 1
      const v = Number(h.quantity) * p
      const pnl = Number(h.quantity) * (p - Number(h.avg_cost))
      const wt = tot > 0 ? Number((v / tot * 100).toFixed(2)) : 0
      return [
        h.instrument?.name ?? h.instrument_id,
        h.instrument_id,
        h.instrument?.type ?? '',
        h.instrument?.sector ?? '',
        h.sleeve_id ?? '',
        Number(h.quantity),
        Number(h.avg_cost),
        p,
        v,
        pnl,
        wt,
      ]
    })
    const holdWs = XLSX.utils.aoa_to_sheet([holdHeaders, ...holdRows])
    holdWs['!cols'] = [
      { wch: 32 }, { wch: 14 }, { wch: 10 }, { wch: 24 }, { wch: 8 },
      { wch: 14 }, { wch: 14 }, { wch: 14 },
      { wch: 18 }, { wch: 18 }, { wch: 10 },
    ]
    XLSX.utils.book_append_sheet(wb, holdWs, 'Holdings')

    // Sheet 4: Dividends (only if data loaded)
    if (dividends?.positions?.length > 0) {
      const divSummary = [
        ['Est. annual income (₦)', dividends.totalEstimatedIncome ?? 0],
        ['Conservative range (₦)', dividends.incomeForecastLow ?? 0],
        ['Optimistic range (₦)', dividends.incomeForecastHigh ?? 0],
        ['Portfolio yield', dividends.portfolioYield ?? 0],
        ['Income target', dividends.incomeTarget ?? 0],
        ['Income gap (₦)', dividends.incomeTargetGap ?? 0],
        ['Paying positions', dividends.payingPositions ?? 0],
        ['Suspended positions', dividends.suspendedPositions ?? 0],
        [''],
      ]
      const divHeaders = ['Stock', 'Ticker', 'Shares', 'DPS (₦)', 'Yield %', 'Annual Income (₦)', 'Status', 'Last Dividend']
      const divRows = dividends.positions.map((p: any) => [
        p.name, p.instrumentId,
        p.shares ?? 0,
        p.divPerShare > 0 ? p.divPerShare : '',
        p.divYieldPct > 0 ? Number((p.divYieldPct * 100).toFixed(2)) : '',
        p.annualIncome > 0 ? p.annualIncome : '',
        p.divStatus ?? '',
        p.lastDivDate ?? p.nextDivDate ?? '',
      ])
      const divWs = XLSX.utils.aoa_to_sheet([...divSummary, divHeaders, ...divRows])
      divWs['!cols'] = [
        { wch: 28 }, { wch: 14 }, { wch: 12 },
        { wch: 10 }, { wch: 10 }, { wch: 18 }, { wch: 12 }, { wch: 14 },
      ]
      XLSX.utils.book_append_sheet(wb, divWs, 'Dividends')
    }

    const fileDate = new Date().toISOString().slice(0, 10)
    XLSX.writeFile(wb, `${clientName} - ${portfolioName} Overview ${fileDate}.xlsx`)
  }

  return (
    <main className="hybrid-page" style={{ padding: '32px 44px 64px', minHeight: '100vh' }}>
      <div className="page-head">
        <div>
          <div className="eyebrow" style={{ marginBottom: 10 }}>
            {(portfolio as any).client?.name}
          </div>
          <h1 className="hybrid-serif" style={{ fontSize: 36, fontWeight: 500, letterSpacing: '-0.005em', lineHeight: 1, color: 'var(--text)' }}>
            {portfolio.name}
          </h1>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span className="btn-h" style={{ pointerEvents: 'none', opacity: 0.85 }}>
            USD/NGN ₦{Math.round(fxRate).toLocaleString()}
          </span>
          <button className="btn-h" onClick={refreshPrices} disabled={refreshing}>
            <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
            {refreshing ? 'Fetching…' : 'Live prices'}
          </button>
          {/* v21j: Excel export — sits between Live prices and Download report */}
          <button className="btn-h" onClick={downloadExcel}>
            <FileSpreadsheet size={12} /> Export Excel
          </button>
          {/* PITFALL #7 — DO NOT REMOVE: Download report */}
          <button
            className="btn-h"
            onClick={() => window.open('/api/export?portfolioId=' + portfolioId, '_blank', 'width=1024,height=800')}
          >
            <Download size={12} /> Download report
          </button>
          <Link href={`/portfolio/${portfolioId}/reports`} className="btn-h btn-h-primary" style={{ textDecoration: 'none' }}>
            <FileText size={12} /> Generate report
          </Link>
        </div>
      </div>

      {alerts && alerts.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          {alerts.map((a: any, i: number) => (
            <div key={i} className={`alert-h ${a.level === 'critical' ? 'alert-h-critical' : 'alert-h-warn'}`}>
              <AlertTriangle size={14} style={{ marginTop: 2, flexShrink: 0 }} />
              <span>
                <strong>{a.level === 'critical' ? 'Breach: ' : 'Warning: '}</strong>
                {a.message}
              </span>
            </div>
          ))}
        </div>
      )}

      {/* KPI row */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 28 }}>
        <div className="h-kpi">
          <div className="h-kpi-label">Current NAV</div>
          <div className={`h-kpi-value ${tot > 0 ? 'pos' : ''}`}>{fmt.ngnM(tot)}</div>
          <div className="h-kpi-sub">
            {hasStartingNav ? (
              <><span className={ret >= 0 ? 'delta-pos' : 'delta-neg'}>{ret >= 0 ? '▲' : '▼'} {(ret * 100).toFixed(2)}%</span>{' '}vs starting</>
            ) : ('Built from transactions')}
          </div>
        </div>
        <div className="h-kpi">
          <div className="h-kpi-label">Starting NAV</div>
          <div className="h-kpi-value">{hasStartingNav ? fmt.ngnM(portfolio.starting_nav) : '—'}</div>
          <div className="h-kpi-sub">Inception {fmt.date(portfolio.start_date)}</div>
        </div>
        <div className="h-kpi">
          <div className="h-kpi-label">Unrealised P&amp;L</div>
          <div className={`h-kpi-value ${pl >= 0 ? 'pos' : 'neg'}`}>{pl >= 0 ? '+' : ''}{fmt.ngnM(pl)}</div>
          <div className="h-kpi-sub">
            {hasStartingNav ? (
              <span className={pl >= 0 ? 'delta-pos' : 'delta-neg'}>{pl >= 0 ? '+' : ''}{(ret * 100).toFixed(2)}% return</span>
            ) : ('No reference basis')}
          </div>
        </div>
        <div className="h-kpi">
          <div className="h-kpi-label">Est. Income p.a.</div>
          <div className="h-kpi-value accent">{fmt.ngnM(incPA || 0)}</div>
          <div className="h-kpi-sub">
            Target {((portfolio.income_target ?? 0) * 100).toFixed(0)}%
            {incPA && portfolio.income_target && tot > 0 ? (
              incPA / tot >= portfolio.income_target ? ' · on target' : ' · shortfall'
            ) : ''}
          </div>
        </div>
      </div>

      {/* Performance panel (v21g) */}
      <div className="panel" style={{ marginBottom: 20 }}>
        <div className="panel-header">
          <div>
            <div className="panel-title">Performance</div>
            <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>
              {metrics
                ? `${metrics.startDate} → ${metrics.endDate} · ${daysHeld ?? 0} days held`
                : 'Loading period metrics…'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            {PERIOD_TABS.map(t => {
              const active = t.key === analyticsPeriod
              return (
                <button
                  key={t.key}
                  onClick={() => setAnalyticsPeriod(t.key)}
                  disabled={analyticsLoading}
                  style={{
                    padding: '5px 10px', fontSize: 11, fontWeight: 600,
                    letterSpacing: '0.04em', fontFamily: 'var(--font-sans)',
                    border: `1px solid ${active ? 'var(--gold)' : 'var(--border-strong)'}`,
                    background: active ? 'var(--gold-soft)' : 'transparent',
                    color: active ? 'var(--gold)' : 'var(--text-2)',
                    borderRadius: 3, cursor: analyticsLoading ? 'wait' : 'pointer', transition: 'all 0.15s',
                  }}
                >
                  {t.label}
                </button>
              )
            })}
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1.3fr 1fr 1fr 1fr', gap: 24, paddingBottom: 20, borderBottom: '1px solid var(--border-soft)', marginBottom: 18 }}>
          <div>
            <div style={{ fontSize: 10, letterSpacing: '0.16em', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', marginBottom: 10 }}>
              IRR ({periodLabel})
            </div>
            <div
              className="hybrid-serif"
              style={{
                fontSize: 44, fontWeight: 500, letterSpacing: '-0.015em', lineHeight: 1,
                color: irrDisplay.hasValue ? (metrics?.irr >= 0 ? 'var(--pos)' : 'var(--neg)') : 'var(--text-3)',
                marginBottom: 8,
              }}
            >
              {irrDisplay.value}
              {irrDisplay.hasValue && (
                <span style={{ fontSize: 18, color: 'var(--text-2)', fontWeight: 400, marginLeft: 6, letterSpacing: '0.01em' }}>p.a.</span>
              )}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-2)', lineHeight: 1.4 }}>
              {irrDisplay.hasValue ? 'Money-weighted return, annualised' :
                !hasEnoughDataForIRR ? <span style={{ color: 'var(--warn)' }}>Need starting NAV &gt; 0 and ≥1 day held</span> :
                'Insufficient cashflow data for this period'}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 10, letterSpacing: '0.14em', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', marginBottom: 10 }}>Period return</div>
            <div className="hybrid-serif" style={{ fontSize: 22, fontWeight: 500, letterSpacing: '-0.01em', color: metrics?.simplePeriodReturn !== null && metrics?.simplePeriodReturn !== undefined ? (metrics.simplePeriodReturn >= 0 ? 'var(--pos)' : 'var(--neg)') : 'var(--text-3)', marginBottom: 4 }}>
              {fmtPctSigned(metrics?.simplePeriodReturn)}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-2)' }}>Un-annualised</div>
          </div>
          <div>
            <div style={{ fontSize: 10, letterSpacing: '0.14em', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', marginBottom: 10 }}>Absolute P&amp;L</div>
            <div className="hybrid-serif" style={{ fontSize: 22, fontWeight: 500, letterSpacing: '-0.01em', color: metrics?.absoluteReturn !== null && metrics?.absoluteReturn !== undefined ? (metrics.absoluteReturn >= 0 ? 'var(--pos)' : 'var(--neg)') : 'var(--text-3)', marginBottom: 4 }}>
              {metrics?.absoluteReturn !== null && metrics?.absoluteReturn !== undefined
                ? `${metrics.absoluteReturn >= 0 ? '+' : '−'}${fmt.ngnM(Math.abs(metrics.absoluteReturn))}`
                : '—'}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-2)' }}>Net of external flows</div>
          </div>
          <div>
            <div style={{ fontSize: 10, letterSpacing: '0.14em', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', marginBottom: 10 }}>
              TWR {metrics?.twrAnnualised !== null && metrics?.twrAnnualised !== undefined ? '(ann.)' : ''}
            </div>
            <div className="hybrid-serif" style={{ fontSize: 22, fontWeight: 500, letterSpacing: '-0.01em', color: metrics?.twr !== null && metrics?.twr !== undefined && metrics.twr !== 0 ? (metrics.twr >= 0 ? 'var(--pos)' : 'var(--neg)') : 'var(--text-3)', marginBottom: 4 }}>
              {metrics?.twrAnnualised !== null && metrics?.twrAnnualised !== undefined ? fmtPctSigned(metrics.twrAnnualised) : fmtPctSigned(metrics?.twr)}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-2)' }}>
              Time-weighted{daysHeld !== null && daysHeld <= 365 && metrics?.twr !== null ? ' · period return' : ''}
            </div>
          </div>
        </div>

        <div>
          <div style={{ fontSize: 10, letterSpacing: '0.14em', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', marginBottom: 12, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>Benchmarks ({periodLabel}, annual rate)</span>
            {daysHeld !== null && daysHeld < 365 && (
              <span style={{ fontSize: 9, color: 'var(--text-3)', fontWeight: 400, letterSpacing: 0, textTransform: 'none', fontStyle: 'italic' }}>
                Sub-year periods show annual equivalent for fair comparison
              </span>
            )}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 12 }}>
            {(metrics?.benchmarks ?? []).map((b: any) => (
              <div key={b.shortName} style={{ padding: '10px 12px', background: 'var(--bg-soft)', border: '1px solid var(--border-soft)', borderRadius: 4 }}>
                <div style={{ fontSize: 10, color: 'var(--text-3)', letterSpacing: '0.06em', fontWeight: 600, marginBottom: 4 }}>{b.shortName}</div>
                <div className="hybrid-serif" style={{ fontSize: 16, fontWeight: 500, letterSpacing: '-0.005em', color: b.annualRate >= 0 ? 'var(--pos)' : 'var(--neg)' }}>
                  {fmtPctSigned(b.annualRate, 1)}
                </div>
              </div>
            ))}
            {(!metrics?.benchmarks || metrics.benchmarks.length === 0) && (
              <div style={{ gridColumn: '1 / -1', fontSize: 11, color: 'var(--text-3)' }}>Benchmarks unavailable for this period</div>
            )}
          </div>
        </div>

        {metrics && (metrics.inflows > 0 || metrics.outflows > 0) && (
          <div style={{ marginTop: 16, paddingTop: 12, borderTop: '1px solid var(--border-soft)', display: 'flex', gap: 24, fontSize: 11, color: 'var(--text-2)' }}>
            <span>Inflows: <strong style={{ color: 'var(--text)' }}>{fmt.ngnM(metrics.inflows)}</strong></span>
            <span>Outflows: <strong style={{ color: 'var(--text)' }}>{fmt.ngnM(metrics.outflows)}</strong></span>
            <span>Net: <strong style={{ color: metrics.netCashFlows >= 0 ? 'var(--pos)' : 'var(--neg)' }}>{metrics.netCashFlows >= 0 ? '+' : '−'}{fmt.ngnM(Math.abs(metrics.netCashFlows))}</strong></span>
          </div>
        )}
      </div>

      {/* Allocation bars + Composition donut */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 14, marginBottom: 20 }}>
        <div className="panel">
          <div className="panel-header">
            <div className="panel-title">Allocation vs. Targets</div>
            <div className="panel-meta">{sv.length} Sleeves</div>
          </div>
          {sv.map((s: any) => {
            const act = (s.act ?? 0) * 100
            const target = (s.target_pct ?? 0) * 100
            const min = (s.min_pct ?? 0) * 100
            const max = (s.max_pct ?? 1) * 100
            const status = s.status === 'OK' || s.status === 'ok' ? 'ok' : s.status === 'BREACH' || s.status === 'breach' ? 'breach' : 'warn'
            const pillClass = status === 'ok' ? 'pill pill-ok' : status === 'breach' ? 'pill pill-breach' : 'pill pill-warn'
            const fill = SLEEVE_FILL[s.sleeve_id] ?? 'var(--text-4)'
            return (
              <div key={s.sleeve_id} className="sleeve-bar-row">
                <div className="sleeve-bar-head">
                  <div className="sleeve-bar-label">{s.name}</div>
                  <div>
                    <span className="sleeve-bar-actual">{act.toFixed(1)}<span className="unit">%</span></span>
                    &nbsp;&nbsp;
                    <span className={pillClass}>{s.status ?? 'OK'}</span>
                  </div>
                </div>
                <div className="sleeve-bar-track">
                  <div className="sleeve-bar-fill" style={{ width: `${Math.min(100, act)}%`, background: fill }} />
                </div>
                <div className="sleeve-bar-sub">
                  <span>Range {min.toFixed(1)}% – {max.toFixed(1)}%</span>
                  <span>Target {target.toFixed(1)}% · {fmt.ngnM(tot * (s.target_pct ?? 0))}</span>
                </div>
              </div>
            )
          })}
        </div>
        <div className="panel">
          <div className="panel-header"><div className="panel-title">Composition</div></div>
          <AllocationDonut sleeves={sv as any} totalNAV={tot} />
        </div>
      </div>

      {/* v21h: Sector Concentration */}
      {sectorSlices.length > 0 && (
        <div className="panel" style={{ marginBottom: 20 }}>
          <div className="panel-header">
            <div>
              <div className="panel-title">Sector Concentration</div>
              <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>
                NAV-weighted breakdown of held equities by NGX sector
              </div>
            </div>
            <div className="panel-meta">{sectorSlices.length} sector{sectorSlices.length === 1 ? '' : 's'}</div>
          </div>
          <SectorDonut slices={sectorSlices} totalEquityNAV={totalEquityNAV} />
        </div>
      )}

      {/* Rebalancing */}
      <div className="panel" style={{ marginBottom: 20 }}>
        <div className="panel-header">
          <div className="panel-title">Rebalancing Guide</div>
          <div className="panel-meta">Based on targets · {fmt.date((portfolio as any).valuation_date ?? portfolio.start_date)}</div>
        </div>
        <table className="h-table">
          <thead>
            <tr>
              <th>Sleeve</th>
              <th className="num">Target value</th>
              <th className="num">Actual value</th>
              <th className="num">Deviation</th>
              <th>Status</th>
              <th>Suggested</th>
            </tr>
          </thead>
          <tbody>
            {sv.map((s: any) => {
              const d = s.diff ?? 0
              const action = d > 50000 ? 'Buy' : d < -50000 ? 'Sell' : 'Hold'
              const actionPill = action === 'Buy' ? 'pill pill-buy' : action === 'Sell' ? 'pill pill-sell' : 'pill pill-hold'
              const statusPill = s.status === 'OK' ? 'pill pill-ok' : s.status === 'BREACH' ? 'pill pill-breach' : 'pill pill-warn'
              const sleeveColor = s.sleeve_id === 'liq' ? 'var(--sidebar-bg)' : s.sleeve_id === 'eq' ? 'var(--gold)' : 'var(--pos)'
              return (
                <tr key={s.sleeve_id}>
                  <td><span style={{ color: sleeveColor, marginRight: 6 }}>●</span>{s.name}</td>
                  <td className="num num-serif">{fmt.ngnM(tot * (s.target_pct ?? 0))}</td>
                  <td className="num num-serif">{fmt.ngnM(s.val ?? 0)}</td>
                  <td className="num num-serif" style={{ color: d >= 0 ? 'var(--pos)' : 'var(--neg)' }}>
                    {d >= 0 ? '+' : '−'}{fmt.ngnM(Math.abs(d))}
                  </td>
                  <td><span className={statusPill}>{s.status}</span></td>
                  <td><span className={actionPill}>{action}</span></td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {/* Dividend Income Panel */}
      {divLoading && !dividends ? (
        <div className="panel">
          <div className="panel-header"><div className="panel-title">Estimated Dividend Income</div></div>
          <div style={{ padding: '24px 0', textAlign: 'center', color: 'var(--text-3)', fontSize: 12 }}>Loading dividend data…</div>
        </div>
      ) : dividends ? (
        <div className="panel">
          <div className="panel-header">
            <div>
              <div className="panel-title">Estimated Dividend Income</div>
              <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>Last declared DPS × current shares held</div>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
              <span className="staleness-caption">
                <span className={`staleness-dot ${divStaleInfo.cls}`} />
                {divStaleInfo.text}
              </span>
              {divRefreshMsg && (
                <span style={{ fontSize: 10, color: divRefreshMsg.startsWith('✓') ? 'var(--pos)' : 'var(--neg)' }}>{divRefreshMsg}</span>
              )}
              <button className="btn-h" onClick={refreshDividends} disabled={divRefreshing}>
                <RefreshCw size={11} className={divRefreshing ? 'animate-spin' : ''} />
                {divRefreshing ? 'Refreshing…' : 'Refresh from NGX'}
              </button>
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
            <div className="div-kpi">
              <div className="div-kpi-label">Est. Annual Income</div>
              <div className="div-kpi-value">₦{((dividends.totalEstimatedIncome ?? 0) / 1e6).toFixed(2)}M</div>
              <div style={{ fontSize: 10, color: 'var(--text-2)', marginTop: 4 }}>{((dividends.portfolioYield ?? 0) * 100).toFixed(2)}% portfolio yield</div>
            </div>
            <div className="div-kpi">
              <div className="div-kpi-label">Conservative range</div>
              <div className="div-kpi-value">₦{((dividends.incomeForecastLow ?? 0) / 1e6).toFixed(2)}M</div>
              <div style={{ fontSize: 10, color: 'var(--text-2)', marginTop: 4 }}>Declared + confirmed only</div>
            </div>
            <div className="div-kpi">
              <div className="div-kpi-label">Optimistic range</div>
              <div className="div-kpi-value">₦{((dividends.incomeForecastHigh ?? 0) / 1e6).toFixed(2)}M</div>
              <div style={{ fontSize: 10, color: 'var(--text-2)', marginTop: 4 }}>Incl. potential resumptions</div>
            </div>
            <div className="div-kpi">
              <div className="div-kpi-label">Income target ({((dividends.incomeTarget ?? 0) * 100).toFixed(0)}%)</div>
              <div className="div-kpi-value" style={{ color: (dividends.incomeTargetGap ?? 0) > 0 ? 'var(--neg)' : 'var(--pos)' }}>
                {(dividends.incomeTargetGap ?? 0) > 0
                  ? `₦${(dividends.incomeTargetGap / 1e6).toFixed(2)}M short`
                  : `₦${(Math.abs(dividends.incomeTargetGap ?? 0) / 1e6).toFixed(2)}M above`}
              </div>
              <div style={{ fontSize: 10, color: 'var(--text-2)', marginTop: 4 }}>{dividends.payingPositions ?? 0} paying · {dividends.suspendedPositions ?? 0} suspended</div>
            </div>
          </div>
          <table className="h-table">
            <thead>
              <tr>
                <th>Stock</th>
                <th className="num">Shares</th>
                <th className="num">DPS</th>
                <th className="num">Yield</th>
                <th className="num">Annual Income</th>
                <th>Status</th>
                <th>Last Div</th>
              </tr>
            </thead>
            <tbody>
              {(dividends.positions ?? []).map((p: any) => {
                const statusPill = p.divStatus === 'paying' ? 'pill pill-ok' : p.divStatus === 'suspended' ? 'pill pill-breach' : 'pill pill-hold'
                return (
                  <tr key={p.instrumentId}>
                    <td>
                      <div style={{ fontWeight: 500 }}>{p.name}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>{p.instrumentId}</div>
                    </td>
                    <td className="num" style={{ fontFamily: 'var(--font-mono)' }}>{(p.shares ?? 0).toLocaleString()}</td>
                    <td className="num num-serif">{p.divPerShare > 0 ? `₦${p.divPerShare.toFixed(2)}` : '—'}</td>
                    <td className="num" style={{ fontFamily: 'var(--font-mono)' }}>{p.divYieldPct > 0 ? `${(p.divYieldPct * 100).toFixed(2)}%` : '—'}</td>
                    <td className="num num-serif" style={{ color: p.annualIncome > 0 ? 'var(--pos)' : 'var(--text-3)' }}>
                      {p.annualIncome > 0 ? `₦${p.annualIncome.toLocaleString('en-NG', { maximumFractionDigits: 0 })}` : '—'}
                    </td>
                    <td><span className={statusPill}>{p.divStatus ?? 'unknown'}</span></td>
                    <td style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>{p.lastDivDate ?? p.nextDivDate ?? '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {dividends.methodology && (
            <div style={{ marginTop: 14, padding: '10px 12px', background: 'var(--bg-soft)', border: '1px solid var(--border-soft)', borderRadius: 4, fontSize: 10, color: 'var(--text-2)', lineHeight: 1.6, display: 'flex', alignItems: 'flex-start', gap: 6 }}>
              <Info size={11} style={{ marginTop: 2, flexShrink: 0, color: 'var(--gold)' }} />
              <span><strong style={{ color: 'var(--text)' }}>Methodology:</strong> {dividends.methodology}</span>
            </div>
          )}
        </div>
      ) : null}
    </main>
  )
}
