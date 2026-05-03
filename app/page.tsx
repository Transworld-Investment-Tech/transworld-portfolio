'use client'
import { useEffect, useState, useCallback } from 'react'
import dynamic from 'next/dynamic'
import { RefreshCw } from 'lucide-react'
import Sidebar from '@/components/shared/Sidebar'
import CockpitKPIStrip from '@/components/cockpit/CockpitKPIStrip'
import MandateHealthGrid from '@/components/cockpit/MandateHealthGrid'
import FeeOutlookPanel from '@/components/cockpit/FeeOutlookPanel'
import IdleCashPanel from '@/components/cockpit/IdleCashPanel'
import StaleReportsPanel from '@/components/cockpit/StaleReportsPanel'
import SectorExposureGrid from '@/components/cockpit/SectorExposureGrid'
import TopMoversPanel from '@/components/cockpit/TopMoversPanel'
import HouseViewsPanel from '@/components/cockpit/HouseViewsPanel'
import WatchlistPulsePanel from '@/components/cockpit/WatchlistPulsePanel'
import type { MandateHealth } from '@/lib/mandate-health'
import type { FeeOutlook } from '@/lib/fee-outlook'
import type {
  SectorExposureData,
  TopMoversData,
  HouseViewsData,
  WatchlistPulseData,
} from '@/lib/cockpit-aggregations'

// v27 — FIRM COCKPIT
// v27c — Added Sector Exposure Grid, Top Movers, FI book overlay on yield curve.
// v27d — Added House Views (tickers held by ≥2 mandates) and Watchlist Pulse
//        (unheld watchlist tickers moving today). The Mandate Health Grid's
//        Watchlist Alignment column is now real (was 'na' placeholder until v27c).
//
// Seven API calls, fired in parallel:
//   1. /api/cockpit/summary          — KPIs + AUM trend + allocation + idle cash + stale reports
//   2. /api/cockpit/health           — Mandate Health Grid (now with real WL alignment)
//   3. /api/cockpit/fee-outlook      — Fee Outlook table
//   4. /api/cockpit/sector-exposure  — Sector heatmap (v27c)
//   5. /api/cockpit/top-movers       — Daily NGN-impact movers (v27c)
//   6. /api/cockpit/house-views      — Firm-wide conviction tickers (v27d)
//   7. /api/cockpit/watchlist-pulse  — Unheld watchlist movers (v27d)
//
// The pre-cockpit "All Portfolios" home is preserved at /portfolios.

const FirmAUMTrend         = dynamic(() => import('@/components/cockpit/FirmAUMTrend'),         { ssr: false })
const FirmAllocationDonut  = dynamic(() => import('@/components/cockpit/FirmAllocationDonut'),  { ssr: false })
const YieldCurvePanel      = dynamic(() => import('@/components/admin/YieldCurvePanel'),        { ssr: false })

interface SummaryPayload {
  kpis: {
    total_aum_ngn:           number
    active_mandates:         number
    total_active_portfolios: number
    projected_annual_fees_ngn: number
    mandates_earning_fee:    number
    stale_reports_count:     number
  }
  aum_trend:         { date: string; aum_ngn: number }[]
  allocation_rollup: { sleeve_id: string; name: string; ngn: number; pct: number }[]
  idle_cash:         any[]
  stale_reports:     any[]
}

export default function CockpitPage() {
  const [summary, setSummary]               = useState<SummaryPayload | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(true)

  const [health, setHealth]                 = useState<MandateHealth[]>([])
  const [healthLoading, setHealthLoading]   = useState(true)

  const [feeOutlook, setFeeOutlook]         = useState<FeeOutlook[]>([])
  const [feeLoading, setFeeLoading]         = useState(true)

  // v27c — sector exposure + top movers state
  const [sectorData, setSectorData]         = useState<SectorExposureData | null>(null)
  const [sectorLoading, setSectorLoading]   = useState(true)

  const [movers, setMovers]                 = useState<TopMoversData | null>(null)
  const [moversLoading, setMoversLoading]   = useState(true)

  // v27d — house views + watchlist pulse state
  const [houseViews, setHouseViews]         = useState<HouseViewsData | null>(null)
  const [houseViewsLoading, setHouseViewsLoading] = useState(true)

  const [pulse, setPulse]                   = useState<WatchlistPulseData | null>(null)
  const [pulseLoading, setPulseLoading]     = useState(true)

  const [refreshing, setRefreshing]         = useState(false)

  const loadAll = useCallback(async () => {
    setRefreshing(true)
    setSummaryLoading(true); setHealthLoading(true); setFeeLoading(true)
    setSectorLoading(true); setMoversLoading(true)
    setHouseViewsLoading(true); setPulseLoading(true)

    const [sRes, hRes, fRes, secRes, movRes, hvRes, plRes] = await Promise.allSettled([
      fetch('/api/cockpit/summary').then(r => r.json()),
      fetch('/api/cockpit/health').then(r => r.json()),
      fetch('/api/cockpit/fee-outlook').then(r => r.json()),
      fetch('/api/cockpit/sector-exposure').then(r => r.json()),
      fetch('/api/cockpit/top-movers').then(r => r.json()),
      fetch('/api/cockpit/house-views').then(r => r.json()),
      fetch('/api/cockpit/watchlist-pulse').then(r => r.json()),
    ])

    if (sRes.status === 'fulfilled' && !sRes.value.error) setSummary(sRes.value)
    setSummaryLoading(false)

    if (hRes.status === 'fulfilled' && !hRes.value.error) setHealth(hRes.value.portfolios ?? [])
    setHealthLoading(false)

    if (fRes.status === 'fulfilled' && !fRes.value.error) setFeeOutlook(fRes.value.portfolios ?? [])
    setFeeLoading(false)

    if (secRes.status === 'fulfilled' && !secRes.value.error) setSectorData(secRes.value)
    setSectorLoading(false)

    if (movRes.status === 'fulfilled' && !movRes.value.error) setMovers(movRes.value)
    setMoversLoading(false)

    if (hvRes.status === 'fulfilled' && !hvRes.value.error) setHouseViews(hvRes.value)
    setHouseViewsLoading(false)

    if (plRes.status === 'fulfilled' && !plRes.value.error) setPulse(plRes.value)
    setPulseLoading(false)

    setRefreshing(false)
  }, [])

  useEffect(() => { loadAll() }, [loadAll])

  const today = new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })

  const k = summary?.kpis ?? {
    total_aum_ngn: 0, active_mandates: 0, total_active_portfolios: 0,
    projected_annual_fees_ngn: 0, mandates_earning_fee: 0, stale_reports_count: 0,
  }

  return (
    <div className="hybrid-page flex">
      <Sidebar />
      <div style={{ flex: 1, overflow: 'auto' }}>
        <main style={{ padding: '32px 44px 64px', maxWidth: '100%' }}>

          {/* Page header */}
          <div className="page-head">
            <div>
              <div className="eyebrow" style={{ marginBottom: 10 }}>Transworld Investment and Securities</div>
              <h1
                className="hybrid-serif"
                style={{
                  fontSize: 36,
                  fontWeight: 500,
                  letterSpacing: '-0.005em',
                  lineHeight: 1,
                  color: 'var(--text)',
                }}
              >
                Firm Cockpit
              </h1>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span className="btn-h" style={{ pointerEvents: 'none', opacity: 0.85 }}>
                {today}
              </span>
              <button className="btn-h" onClick={loadAll} disabled={refreshing}>
                <RefreshCw size={12} className={refreshing ? 'animate-spin' : ''} />
                {refreshing ? 'Refreshing…' : 'Refresh'}
              </button>
            </div>
          </div>

          {/* KPI strip */}
          <CockpitKPIStrip
            loading={summaryLoading}
            totalAUM={k.total_aum_ngn}
            activeMandates={k.active_mandates}
            totalActivePortfolios={k.total_active_portfolios}
            projectedFees={k.projected_annual_fees_ngn}
            mandatesEarningFee={k.mandates_earning_fee}
            staleReportsCount={k.stale_reports_count}
          />

          {/* Firm AUM trend + allocation donut */}
          <div style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr', gap: 14, marginBottom: 20 }}>
            <div className="panel">
              <div className="panel-header">
                <div className="panel-title">Firm AUM trend (12 months)</div>
                <div className="panel-meta">Month-end snapshots</div>
              </div>
              <FirmAUMTrend data={summary?.aum_trend ?? []} />
            </div>
            <div className="panel">
              <div className="panel-header">
                <div className="panel-title">Allocation rollup</div>
                <div className="panel-meta">All active portfolios</div>
              </div>
              <FirmAllocationDonut data={summary?.allocation_rollup ?? []} />
            </div>
          </div>

          {/* Mandate Health Grid */}
          <div className="panel" style={{ marginBottom: 20 }}>
            <div className="panel-header">
              <div>
                <div className="panel-title">Mandate Health Grid</div>
                <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>
                  11 best-practice checks · sorted worst-first · click any mandate to drill in
                </div>
              </div>
              <div className="panel-meta">
                {healthLoading ? 'Loading…' : `${health.length} mandates`}
              </div>
            </div>
            <MandateHealthGrid loading={healthLoading} data={health} />
          </div>

          {/* v27c — Sector Exposure Grid */}
          <div className="panel" style={{ marginBottom: 20 }}>
            <div className="panel-header">
              <div>
                <div className="panel-title">Sector Exposure Grid</div>
                <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>
                  Equity sleeve only · NGX sectors sorted by firm-wide concentration · click mandate to drill in
                </div>
              </div>
              <div className="panel-meta">
                {sectorLoading
                  ? 'Loading…'
                  : sectorData
                    ? `${sectorData.sectors.length} sector${sectorData.sectors.length === 1 ? '' : 's'} · ${sectorData.portfolios.length} mandate${sectorData.portfolios.length === 1 ? '' : 's'}`
                    : '—'}
              </div>
            </div>
            <SectorExposureGrid loading={sectorLoading} data={sectorData} />
          </div>

          {/* Fee Outlook */}
          <div className="panel" style={{ marginBottom: 20 }}>
            <div className="panel-header">
              <div>
                <div className="panel-title">Fee Outlook</div>
                <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>
                  Per-mandate target & split · calendar-year basis · pro-rated for mid-year starters
                </div>
              </div>
              <div className="panel-meta">
                {feeLoading ? 'Loading…' : `${feeOutlook.filter(f => !f.is_internal).length} active mandates`}
              </div>
            </div>
            <FeeOutlookPanel loading={feeLoading} data={feeOutlook} />
          </div>

          {/* v27c — Top Movers */}
          <div className="panel" style={{ marginBottom: 20 }}>
            <div className="panel-header">
              <div>
                <div className="panel-title">Top Movers — firm book</div>
                <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>
                  Equities ranked by NGN impact (exposure × period change) · day / week / month / quarter · top 5 each side
                </div>
              </div>
              <div className="panel-meta">
                {moversLoading
                  ? 'Loading…'
                  : movers
                    ? `${movers.day.gainers.length} gainers · ${movers.day.losers.length} losers today`
                    : '—'}
              </div>
            </div>
            <TopMoversPanel loading={moversLoading} data={movers} />
          </div>

          {/* v27d — House Views */}
          <div className="panel" style={{ marginBottom: 20 }}>
            <div className="panel-header">
              <div>
                <div className="panel-title">House Views — held by ≥2 mandates</div>
                <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>
                  Tickers expressed across multiple client portfolios · firm-wide conviction surface
                </div>
              </div>
              <div className="panel-meta">
                {houseViewsLoading
                  ? 'Loading…'
                  : houseViews
                    ? `${houseViews.rows.length} ticker${houseViews.rows.length === 1 ? '' : 's'}`
                    : '—'}
              </div>
            </div>
            <HouseViewsPanel loading={houseViewsLoading} data={houseViews} />
          </div>

          {/* v27d — Watchlist Pulse */}
          <div className="panel" style={{ marginBottom: 20 }}>
            <div className="panel-header">
              <div>
                <div className="panel-title">Watchlist Pulse — unheld movers today</div>
                <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>
                  Active equity-watchlist tickers no mandate currently holds, moving ±2% or more today
                </div>
              </div>
              <div className="panel-meta">
                {pulseLoading
                  ? 'Loading…'
                  : pulse
                    ? `${pulse.rows.length} above threshold`
                    : '—'}
              </div>
            </div>
            <WatchlistPulsePanel loading={pulseLoading} data={pulse} />
          </div>

          {/* Idle Cash + Stale Reports */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 14, marginBottom: 20 }}>
            <div className="panel">
              <div className="panel-header">
                <div>
                  <div className="panel-title">Idle cash</div>
                  <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>
                    Portfolios over liquidity max
                  </div>
                </div>
                <div className="panel-meta">
                  {summaryLoading ? '—' : `${summary?.idle_cash.length ?? 0} flagged`}
                </div>
              </div>
              <IdleCashPanel loading={summaryLoading} data={summary?.idle_cash ?? []} />
            </div>
            <div className="panel">
              <div className="panel-header">
                <div>
                  <div className="panel-title">Stale reports</div>
                  <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>
                    Past 100-day quarterly window
                  </div>
                </div>
                <div className="panel-meta">
                  {summaryLoading ? '—' : `${summary?.stale_reports.length ?? 0} overdue`}
                </div>
              </div>
              <StaleReportsPanel loading={summaryLoading} data={summary?.stale_reports ?? []} />
            </div>
          </div>

          {/* v27c — FI yield curve with firm-wide overlay */}
          <YieldCurvePanel firmOverlay />

        </main>
      </div>
    </div>
  )
}
