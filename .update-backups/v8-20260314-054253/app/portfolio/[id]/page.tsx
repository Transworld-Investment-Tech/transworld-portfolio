'use client'
import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { computeNAV, computeSleeveData, complianceAlerts, estimatedIncomePA, totalUnrealizedPnL, fmt, SLEEVE_COLOURS, type Portfolio, type Holding, type SleeveTarget } from '@/lib/portfolio'
import {
  ArrowLeft, RefreshCw, FileText, Settings, TrendingUp, TrendingDown,
  ChevronRight, AlertTriangle, Info, CheckCircle2
} from 'lucide-react'
import dynamic from 'next/dynamic'
import PageActions from '@/components/shared/PageActions'

const AllocationDonut = dynamic(() => import('@/components/portfolio/AllocationDonut'), { ssr: false })
const SleeveBarChart  = dynamic(() => import('@/components/portfolio/SleeveBarChart'),  { ssr: false })
const IncomeChart     = dynamic(() => import('@/components/portfolio/IncomeChart'),     { ssr: false })

type Tab = 'overview' | 'holdings' | 'allocation' | 'market' | 'reports' | 'transactions'

export default function PortfolioDashboard() {
  const params = useParams()
  const portfolioId = params.id as string

  const [portfolio, setPortfolio]   = useState<Portfolio | null>(null)
  const [holdings, setHoldings]     = useState<Holding[]>([])
  const [sleeveDefs, setSleeveDefs] = useState<SleeveTarget[]>([])
  const [tab, setTab]               = useState<Tab>('overview')
  const [loading, setLoading]       = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [fxRate, setFxRate]         = useState<number>(1665)
  const [analytics,    setAnalytics]    = useState<any>(null)
  const [analyticsLoading, setAnalyticsLoading] = useState(false)
  const [selectedPeriod, setSelectedPeriod] = useState<string>('1 Year')
  const [report, setReport]         = useState('')
  const [reportType, setReportType] = useState<'daily'|'weekly'|'monthly'|'quarterly'|'annual'>('monthly')
  const [generatingReport, setGeneratingReport] = useState(false)
  const [reportError, setReportError] = useState('')

  const load = useCallback(async () => {
    const [portRes, holdRes, sleeveRes] = await Promise.all([
      supabase.from('portfolios').select('*, client:clients(name,code)').eq('id', portfolioId).single(),
      supabase.from('holdings').select('*, instrument:instruments(*)').eq('portfolio_id', portfolioId),
      supabase.from('sleeve_targets').select('*').eq('portfolio_id', portfolioId).order('sort_order'),
    ])

    if (portRes.data)   setPortfolio(portRes.data)
    if (sleeveRes.data) setSleeveDefs(sleeveRes.data)

    if (holdRes.data) {
      // Attach latest prices
      const { data: prices } = await supabase
        .from('market_prices')
        .select('instrument_id, price, day_change')
        .in('instrument_id', holdRes.data.map((h: any) => h.instrument_id))
        .order('price_date', { ascending: false })

      const priceMap: Record<string, { price: number; day_change: number }> = {}
      prices?.forEach((p: any) => {
        if (!priceMap[p.instrument_id]) priceMap[p.instrument_id] = { price: p.price, day_change: p.day_change ?? 0 }
      })

      setHoldings(holdRes.data.map((h: any) => ({
        ...h,
        latest_price: priceMap[h.instrument_id]?.price ?? h.avg_cost,
        day_change:   priceMap[h.instrument_id]?.day_change ?? 0,
      })))
    }

    setLoading(false)
  }, [portfolioId])

  useEffect(() => { load() }, [load])

  // Fetch FX rate
  useEffect(() => {
    fetch('https://api.exchangerate-api.com/v4/latest/USD')
      .then(r => r.json())
      .then(d => { if (d.rates?.NGN) setFxRate(d.rates.NGN) })
      .catch(() => {})
  }, [])

  // Fetch analytics (IRR, period returns, benchmarks)
  useEffect(() => {
    if (!portfolioId) return
    setAnalyticsLoading(true)
    fetch(`/api/analytics?portfolioId=${portfolioId}`)
      .then(r => r.json())
      .then(d => { setAnalytics(d); setAnalyticsLoading(false) })
      .catch(() => setAnalyticsLoading(false))
  }, [portfolioId])

  async function refreshPrices() {
    setRefreshing(true)
    try {
      const res = await fetch('/api/prices', { method: 'POST', body: JSON.stringify({ portfolioId }) })
      if (res.ok) await load()
    } finally {
      setRefreshing(false)
    }
  }

  async function handleGenerateReport() {
    setGeneratingReport(true)
    setReport('')
    setReportError('')
    try {
      const res = await fetch('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ portfolioId, reportType }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || 'Unknown error')
      setReport(d.report)
    } catch (e) {
      setReportError((e as Error).message)
    } finally {
      setGeneratingReport(false)
    }
  }

  if (loading || !portfolio) {
    return (
      <div className="min-h-screen flex items-center justify-center text-[#555d72] text-sm">
        Loading portfolio…
      </div>
    )
  }

  const tot     = computeNAV(holdings)
  const sv      = computeSleeveData(holdings, sleeveDefs, tot)
  const pl      = tot - portfolio.starting_nav
  const ret     = pl / portfolio.starting_nav
  const incPA   = estimatedIncomePA(holdings)
  const alerts  = complianceAlerts(portfolio, holdings, sv, tot)
  const equities = holdings.filter(h => h.instrument?.type === 'Stock')
  const fi       = holdings.filter(h => h.instrument?.type !== 'Stock')

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="bg-[#13161d] border-b border-white/[0.07] px-6 py-3.5 flex items-center gap-4 sticky top-0 z-10">
        <Link href="/" className="flex items-center gap-1.5 text-[#8a91a8] hover:text-[#e8eaf0] text-sm transition-colors">
          <ArrowLeft size={15} /> All portfolios
        </Link>
        <div className="w-px h-4 bg-white/10" />
        <div>
          <span className="text-[10px] font-bold tracking-widest text-[#555d72] uppercase">{portfolio.client?.name}</span>
          <span className="text-sm font-semibold ml-2">{portfolio.name}</span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <span className="text-[11px] text-[#555d72]">USD/NGN ₦{Math.round(fxRate).toLocaleString()}</span>
          <button onClick={refreshPrices} disabled={refreshing} className="flex items-center gap-1.5 text-xs text-[#8a91a8] hover:text-[#e8eaf0] border border-white/10 rounded-lg px-3 py-1.5 transition-colors disabled:opacity-50">
            <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} /> {refreshing ? 'Fetching…' : 'Live prices'}
          </button>
          <button onClick={() => setTab('reports')} className="flex items-center gap-1.5 text-xs bg-[#a78bfa] text-white rounded-lg px-3 py-1.5">
            <FileText size={12} /> Generate report
          </button>
          <Link href={`/admin/portfolios/${portfolioId}`} className="flex items-center gap-1.5 text-xs text-[#8a91a8] hover:text-[#e8eaf0] border border-white/10 rounded-lg px-3 py-1.5 transition-colors">
            <Settings size={12} /> Manage
          </Link>
        </div>
      </header>

      <div className="flex-1 flex flex-col">
        {/* Tabs */}
        <div className="bg-[#0d0f14] border-b border-white/[0.07] px-6">
          <div className="flex gap-0">
            {(['overview','holdings','allocation','market','reports','transactions'] as Tab[]).map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={`px-4 py-3 text-xs font-medium capitalize border-b-2 transition-colors ${tab === t ? 'border-[#a78bfa] text-[#a78bfa]' : 'border-transparent text-[#555d72] hover:text-[#8a91a8]'}`}>
                {t}
              </button>
            ))}
          </div>
        </div>

        <main className="flex-1 px-6 py-6">
          {/* Alerts */}
          {alerts.length > 0 && (
            <div className="mb-5">
              {alerts.map((a, i) => (
                <div key={i} className={`alert alert-${a.level}`}>
                  <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                  <span><strong>{a.level === 'critical' ? 'BREACH: ' : 'WARNING: '}</strong>{a.message}</span>
                </div>
              ))}
            </div>
          )}

          {/* TAB: OVERVIEW */}
          {tab === 'overview' && (
            <>
              {/* KPI grid */}
              <div className="grid grid-cols-4 gap-4 mb-6">
                <KPI label="Current NAV" value={fmt.ngnM(tot)} sub={`${fmt.pct(ret)} vs starting`} color={ret >= 0 ? '#00d4a4' : '#ff5c7a'} />
                <KPI label="Starting NAV" value={fmt.ngnM(portfolio.starting_nav)} sub={fmt.date(portfolio.start_date)} />
                <KPI label="Unrealized P&L" value={fmt.ngnM(pl)} sub={fmt.chg(ret)} color={pl >= 0 ? '#00d4a4' : '#ff5c7a'} />
                <KPI label="Est. income p.a." value={fmt.ngnM(incPA)} sub={`Target: ${fmt.pct(portfolio.income_target)}`} color="#a78bfa" />
              </div>

              <div className="grid grid-cols-2 gap-5 mb-5">
                {/* Sleeve bars */}
                <div className="tw-card">
                  <div className="text-[11px] font-semibold uppercase tracking-widest text-[#555d72] mb-4">Allocation vs targets</div>
                  <SleeveBarChart sleeves={sv} />
                </div>
                {/* Donut */}
                <div className="tw-card">
                  <div className="text-[11px] font-semibold uppercase tracking-widest text-[#555d72] mb-4">Portfolio composition</div>
                  <AllocationDonut sleeves={sv} totalNAV={tot} />
                </div>
              </div>

              {/* Rebal table */}
              <div className="tw-card">
                <div className="text-[11px] font-semibold uppercase tracking-widest text-[#555d72] mb-4">Rebalancing guide</div>
                <table className="tw-table w-full">
                  <thead><tr>
                    <th>Sleeve</th><th>Target value</th><th>Actual value</th><th>Diff</th><th>Status</th><th>Action</th>
                  </tr></thead>
                  <tbody>
                    {sv.map(s => {
                      const d = s.diff
                      const act = d > 50000 ? 'BUY' : d < -50000 ? 'SELL' : 'HOLD'
                      const col = SLEEVE_COLOURS[s.sleeve_id]
                      return (
                        <tr key={s.sleeve_id}>
                          <td><span style={{ background: col?.hex, width: 8, height: 8, borderRadius: 2, display: 'inline-block', verticalAlign: 'middle', marginRight: 6 }} />{s.name}</td>
                          <td className="font-mono">{fmt.ngnM(tot * s.target_pct)}</td>
                          <td className="font-mono">{fmt.ngnM(s.val)}</td>
                          <td className={`font-mono ${d >= 0 ? 'text-[#00d4a4]' : 'text-[#ff5c7a]'}`}>{d >= 0 ? '+' : ''}{fmt.ngnM(d)}</td>
                          <td><span className={`badge badge-${s.status.toLowerCase()}`}>{s.status}</span></td>
                          <td><span className={`badge badge-${act.toLowerCase()}`}>{act}</span></td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {/* TAB: HOLDINGS */}

          {/* ── Performance Analytics ──────────────────────────── */}
          {tab === 'overview' && analytics && (
            <div className="px-6 pb-6 grid grid-cols-1 gap-4">

              {/* IRR + Period Returns */}
              <div className="tw-card">
                <div className="flex items-center justify-between mb-4">
                  <div className="text-xs font-semibold uppercase tracking-widest text-[#555d72]">Performance & Returns</div>
                  <div className="flex gap-1">
                    {['1 Month','3 Months','1 Year','Since Inception'].map(p => (
                      <button key={p} onClick={() => setSelectedPeriod(p)}
                        className="px-2.5 py-1 rounded text-[11px] font-medium transition-all"
                        style={selectedPeriod === p
                          ? { background: '#a78bfa20', color: '#a78bfa', border: '1px solid #a78bfa40' }
                          : { background: 'transparent', color: '#555d72', border: '1px solid rgba(255,255,255,0.07)' }}>
                        {p}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Top metrics row */}
                <div className="grid grid-cols-4 gap-4 mb-5">
                  {/* IRR */}
                  <div className="text-center p-3 rounded-xl bg-[#a78bfa]/5 border border-[#a78bfa]/10">
                    <div className="text-[10px] text-[#555d72] uppercase tracking-wider mb-1">IRR (Since Inception)</div>
                    <div className="text-2xl font-bold font-mono" style={{ color: analytics.irr >= 0 ? '#22c55e' : '#ef4444' }}>
                      {analytics.irr != null ? `${(analytics.irr * 100).toFixed(1)}%` : 'N/A'}
                    </div>
                    <div className="text-[10px] text-[#555d72] mt-1">Annualised</div>
                  </div>

                  {/* Annualised return */}
                  <div className="text-center p-3 rounded-xl bg-white/[0.02] border border-white/[0.05]">
                    <div className="text-[10px] text-[#555d72] uppercase tracking-wider mb-1">Annualised Return</div>
                    <div className="text-2xl font-bold font-mono" style={{ color: analytics.annualisedReturn >= 0 ? '#22c55e' : '#ef4444' }}>
                      {analytics.annualisedReturn != null ? `${(analytics.annualisedReturn * 100).toFixed(1)}%` : 'N/A'}
                    </div>
                    <div className="text-[10px] text-[#555d72] mt-1">{analytics.daysInception} days held</div>
                  </div>

                  {/* Selected period return */}
                  {(() => {
                    const pr = analytics.periodReturns?.find((p: any) => p.label === selectedPeriod)
                    return (
                      <div className="text-center p-3 rounded-xl bg-white/[0.02] border border-white/[0.05]">
                        <div className="text-[10px] text-[#555d72] uppercase tracking-wider mb-1">{selectedPeriod} Return</div>
                        <div className="text-2xl font-bold font-mono" style={{ color: pr?.percentReturn >= 0 ? '#22c55e' : '#ef4444' }}>
                          {pr?.percentReturn != null ? `${pr.percentReturn >= 0 ? '+' : ''}${(pr.percentReturn * 100).toFixed(1)}%` : 'N/A'}
                        </div>
                        <div className="text-[10px] text-[#555d72] mt-1">
                          {pr?.absoluteReturn != null ? `${pr.absoluteReturn >= 0 ? '+' : ''}₦${(Math.abs(pr.absoluteReturn)/1e6).toFixed(2)}M` : ''}
                        </div>
                      </div>
                    )
                  })()}

                  {/* Total return ITD */}
                  <div className="text-center p-3 rounded-xl bg-white/[0.02] border border-white/[0.05]">
                    <div className="text-[10px] text-[#555d72] uppercase tracking-wider mb-1">Total Return ITD</div>
                    <div className="text-2xl font-bold font-mono" style={{ color: analytics.totalReturn >= 0 ? '#22c55e' : '#ef4444' }}>
                      {analytics.totalReturn != null ? `${analytics.totalReturn >= 0 ? '+' : ''}${(analytics.totalReturn * 100).toFixed(1)}%` : 'N/A'}
                    </div>
                    <div className="text-[10px] text-[#555d72] mt-1">
                      ₦{(analytics.startingNAV/1e6).toFixed(1)}M → ₦{(analytics.currentNAV/1e6).toFixed(1)}M
                    </div>
                  </div>
                </div>

                {/* Period returns table */}
                <div className="mb-5">
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-[#555d72] mb-2">All period returns</div>
                  <table className="tw-table w-full">
                    <thead><tr><th>Period</th><th>Start NAV</th><th>End NAV</th><th>Absolute Return</th><th>Return %</th><th>Annualised</th><th>Days</th></tr></thead>
                    <tbody>
                      {analytics.periodReturns?.map((pr: any) => (
                        <tr key={pr.label} style={pr.label === selectedPeriod ? { background: 'rgba(167,139,250,0.05)' } : {}}>
                          <td className="font-medium">{pr.label}</td>
                          <td className="font-mono">{pr.startNAV ? `₦${(pr.startNAV/1e6).toFixed(2)}M` : '—'}</td>
                          <td className="font-mono">₦{(pr.endNAV/1e6).toFixed(2)}M</td>
                          <td className={`font-mono ${pr.absoluteReturn >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>
                            {pr.absoluteReturn != null ? `${pr.absoluteReturn >= 0 ? '+' : ''}₦${(Math.abs(pr.absoluteReturn)/1e6).toFixed(2)}M` : '—'}
                          </td>
                          <td className={`font-mono font-semibold ${pr.percentReturn >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>
                            {pr.percentReturn != null ? `${pr.percentReturn >= 0 ? '+' : ''}${(pr.percentReturn*100).toFixed(1)}%` : '—'}
                          </td>
                          <td className="font-mono text-[#8a91a8]">
                            {pr.annualisedReturn != null ? `${pr.annualisedReturn >= 0 ? '+' : ''}${(pr.annualisedReturn*100).toFixed(1)}%` : '—'}
                          </td>
                          <td className="font-mono text-[#555d72]">{pr.daysHeld ?? '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Benchmark comparison */}
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wider text-[#555d72] mb-2">Benchmark comparison (annualised)</div>
                  <table className="tw-table w-full">
                    <thead><tr><th>Benchmark</th><th>Type</th><th>Return</th><th>vs Portfolio IRR</th><th>Source</th></tr></thead>
                    <tbody>
                      {/* Portfolio row first */}
                      <tr style={{ background: 'rgba(167,139,250,0.05)' }}>
                        <td className="font-semibold text-[#a78bfa]">This Portfolio</td>
                        <td><span className="badge badge-stock">Discretionary</span></td>
                        <td className="font-mono font-bold text-[#22c55e]">
                          {analytics.irr != null ? `${(analytics.irr*100).toFixed(1)}%` : `${(analytics.annualisedReturn*100).toFixed(1)}%`}
                        </td>
                        <td className="font-mono text-[#555d72]">—</td>
                        <td className="text-[10px] text-[#555d72]">Transworld PI</td>
                      </tr>
                      {analytics.benchmarks?.map((b: any) => {
                        const portfolioRate = analytics.irr ?? analytics.annualisedReturn ?? 0
                        const diff = portfolioRate - b.annualised
                        return (
                          <tr key={b.shortName}>
                            <td className="font-medium">{b.name}</td>
                            <td>
                              <span className={`badge ${b.type === 'equity' ? 'badge-stock' : b.type === 'inflation' ? 'badge-breach' : 'badge-bond'}`}>
                                {b.type === 'equity' ? 'Equity' : b.type === 'inflation' ? 'Inflation' : 'Fixed Income'}
                              </span>
                            </td>
                            <td className="font-mono">{(b.annualised*100).toFixed(1)}%</td>
                            <td className={`font-mono font-semibold ${diff >= 0 ? 'text-[#22c55e]' : 'text-[#ef4444]'}`}>
                              {diff >= 0 ? '+' : ''}{(diff*100).toFixed(1)}pp
                            </td>
                            <td className="text-[10px] text-[#555d72]">{b.source}</td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                  <div className="mt-2 text-[10px] text-[#555d72]">
                    pp = percentage points outperformance vs benchmark. Positive = portfolio outperforms.
                    IRR uses actual cash flows. Benchmarks are point-in-time annualised rates, not IRR-adjusted.
                  </div>
                </div>
              </div>
            </div>
          )}

          {tab === 'holdings' && (
            <>
              <div className="tw-card mb-5">
                <div className="text-[11px] font-semibold uppercase tracking-widest text-[#555d72] mb-4">NGX equity positions</div>
                <table className="tw-table w-full">
                  <thead><tr><th>Company</th><th>Ticker</th><th>Shares</th><th>Price (₦)</th><th>Market value</th><th>Weight</th><th>Day chg</th><th>Div yield</th></tr></thead>
                  <tbody>
                    {equities.map(h => {
                      const price = h.latest_price ?? h.avg_cost
                      const val = h.quantity * price
                      return (
                        <tr key={h.instrument_id}>
                          <td>{h.instrument?.name}</td>
                          <td className="font-mono text-[#555d72] text-[11px]">{h.instrument?.ngx_symbol}</td>
                          <td className="font-mono">{Math.round(h.quantity).toLocaleString()}</td>
                          <td className="font-mono">₦{price.toFixed(2)}</td>
                          <td className="font-mono">{fmt.ngnM(val)}</td>
                          <td>{fmt.pct(val / tot)}</td>
                          <td className={`font-mono ${(h.day_change ?? 0) >= 0 ? 'text-[#00d4a4]' : 'text-[#ff5c7a]'}`}>{fmt.chg(h.day_change ?? 0)}</td>
                          <td className="text-[#a78bfa]">{h.instrument?.coupon_pct ? h.instrument.coupon_pct.toFixed(1) + '%' : '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              <div className="tw-card mb-5">
                <div className="text-[11px] font-semibold uppercase tracking-widest text-[#555d72] mb-4">Fixed income & cash</div>
                <table className="tw-table w-full">
                  <thead><tr><th>Instrument</th><th>Type</th><th>Face value</th><th>Price</th><th>Market value</th><th>Weight</th><th>Yield p.a.</th></tr></thead>
                  <tbody>
                    {fi.map(h => {
                      const price = h.latest_price ?? h.avg_cost
                      const typeBadge = h.instrument?.type === 'NTB' ? 'badge-ntb' : h.instrument?.type === 'Bond' ? 'badge-bond' : 'badge-cash'
                      return (
                        <tr key={h.instrument_id}>
                          <td>{h.instrument?.name}</td>
                          <td><span className={`badge ${typeBadge}`}>{h.instrument?.type}</span></td>
                          <td className="font-mono">{fmt.ngnM(h.quantity)}</td>
                          <td className="font-mono">{price.toFixed(4)}</td>
                          <td className="font-mono">{fmt.ngnM(h.quantity * price)}</td>
                          <td>{fmt.pct((h.quantity * price) / tot)}</td>
                          <td className="text-[#a78bfa]">{h.instrument?.coupon_pct ? h.instrument.coupon_pct.toFixed(2) + '%' : '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>

              <div className="tw-card">
                <div className="text-[11px] font-semibold uppercase tracking-widest text-[#555d72] mb-4">12-month income projection</div>
                <IncomeChart holdings={holdings} />
              </div>
            </>
          )}

          {/* TAB: REPORTS */}
          {tab === 'reports' && (
            <div className="grid grid-cols-[300px_1fr] gap-6 items-start">
              <div className="tw-card">
                <div className="text-[11px] font-semibold uppercase tracking-widest text-[#555d72] mb-4">Generate report</div>
                <div className="space-y-4">
                  <div>
                    <label className="text-xs text-[#8a91a8] block mb-1.5">Report period</label>
                    <select className="tw-select" value={reportType} onChange={e => setReportType(e.target.value as any)}>
                      <option value="daily">Daily report</option>
                      <option value="weekly">Weekly report</option>
                      <option value="monthly">Monthly report</option>
                      <option value="quarterly">Quarterly report</option>
                      <option value="annual">Annual report</option>
                    </select>
                  </div>
                  <button
                    onClick={handleGenerateReport}
                    disabled={generatingReport}
                    className="w-full py-3 bg-[#a78bfa] text-white rounded-lg text-sm font-medium hover:bg-[#9b87e8] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {generatingReport ? '⟳ Searching market data…' : '✦ Generate AI report'}
                  </button>
                  <div className="text-[11px] text-[#555d72] leading-relaxed bg-[#1a1e28] rounded-lg p-3">
                    Claude searches live CBN rates, NGX ASI, NTB auctions, FGN bond yields, and individual stock prices — then writes a professional report with portfolio commentary and priority actions.
                  </div>
                  {report && (
                    <div className="space-y-2">
                      <button onClick={() => navigator.clipboard.writeText(report)} className="w-full py-2 text-xs border border-white/10 rounded-lg hover:border-white/20 transition-colors">⎘ Copy report</button>
                      <button onClick={() => {
                        const blob = new Blob([report], { type: 'text/plain' })
                        const a = document.createElement('a'); a.href = URL.createObjectURL(blob)
                        a.download = `${portfolio.name.replace(/\s+/g,'-')}_${reportType}_${new Date().toISOString().slice(0,10)}.txt`
                        a.click()
                      }} className="w-full py-2 text-xs border border-white/10 rounded-lg hover:border-white/20 transition-colors">↓ Download .txt</button>
                    </div>
                  )}
                </div>
              </div>

              <div>
                {reportError && <div className="alert alert-critical mb-4">{reportError}</div>}
                {generatingReport ? (
                  <div className="tw-card flex flex-col items-center justify-center py-24 text-[#555d72]">
                    <div className="w-8 h-8 border-2 border-white/10 border-t-[#a78bfa] rounded-full animate-spin mb-4" />
                    <div className="text-sm">Searching Nigerian market data…</div>
                    <div className="text-xs mt-1">CBN · NGX · FMDQ · NBS · Macro news</div>
                  </div>
                ) : report ? (
                  <div className="tw-card report-content max-h-[780px] overflow-y-auto">
                    <div dangerouslySetInnerHTML={{ __html: report
                      .replace(/^## (.*)/gm, '<h1>$1</h1>')
                      .replace(/^### (.*)/gm, '<h2>$2</h2>'.replace('$2','$1'))
                      .replace(/^#### (.*)/gm, '<h3>$1</h3>')
                      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                      .replace(/\*(.*?)\*/g, '<em>$1</em>')
                      .replace(/`(.*?)`/g, '<code>$1</code>')
                      .replace(/\n\n/g, '</p><p>')
                      .replace(/\n/g, '<br/>')
                    }} />
                  </div>
                ) : (
                  <div className="tw-card border-dashed flex items-center justify-center py-24 text-center text-[#555d72]">
                    <div>
                      <FileText size={28} className="mx-auto mb-3 opacity-50" />
                      <div className="text-sm">Select report type and click Generate</div>
                      <div className="text-xs mt-1">Reports typically take 25–40 seconds</div>
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  )
}

function KPI({ label, value, sub, color }: { label: string; value: string; sub: string; color?: string }) {
  return (
    <div className="kpi-card">
      <div className="kpi-label">{label}</div>
      <div className="kpi-value" style={{ color: color || '#e8eaf0' }}>{value}</div>
      <div className="kpi-sub">{sub}</div>
    </div>
  )
}
