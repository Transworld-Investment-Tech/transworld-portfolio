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
import type { MandateHealth } from '@/lib/mandate-health'
import type { FeeOutlook } from '@/lib/fee-outlook'

// v27 — FIRM COCKPIT
//
// New home page. The thinking-tool above per-portfolio depth.
// Three API calls, staggered:
//   1. /api/cockpit/summary  — KPIs + AUM trend + allocation + idle cash + stale reports
//   2. /api/cockpit/health   — Mandate Health Grid
//   3. /api/cockpit/fee-outlook — Fee Outlook table
//
// The pre-cockpit "All Portfolios" home is preserved at /portfolios.
//
// Surfaces:
//   - 4 KPI tiles
//   - Firm AUM trend (12mo line)
//   - Firm allocation rollup donut
//   - Mandate Health Grid (11 best-practice checks × portfolios)
//   - Fee Outlook (DMA benchmark tracking)
//   - Idle Cash flags
//   - Stale Reports flags
//   - FI yield curve panel (read-only universe view)

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
  const [summary, setSummary]           = useState<SummaryPayload | null>(null)
  const [summaryLoading, setSummaryLoading] = useState(true)

  const [health, setHealth]             = useState<MandateHealth[]>([])
  const [healthLoading, setHealthLoading] = useState(true)

  const [feeOutlook, setFeeOutlook]     = useState<FeeOutlook[]>([])
  const [feeLoading, setFeeLoading]     = useState(true)

  const [refreshing, setRefreshing]     = useState(false)

  const loadAll = useCallback(async () => {
    setRefreshing(true)
    setSummaryLoading(true); setHealthLoading(true); setFeeLoading(true)

    // Fire all three in parallel — they read from the same tables but
    // each endpoint is independent so failures are isolated.
    const [sRes, hRes, fRes] = await Promise.allSettled([
      fetch('/api/cockpit/summary').then(r => r.json()),
      fetch('/api/cockpit/health').then(r => r.json()),
      fetch('/api/cockpit/fee-outlook').then(r => r.json()),
    ])

    if (sRes.status === 'fulfilled' && !sRes.value.error) setSummary(sRes.value)
    setSummaryLoading(false)

    if (hRes.status === 'fulfilled' && !hRes.value.error) setHealth(hRes.value.portfolios ?? [])
    setHealthLoading(false)

    if (fRes.status === 'fulfilled' && !fRes.value.error) setFeeOutlook(fRes.value.portfolios ?? [])
    setFeeLoading(false)

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

          {/* Fee Outlook */}
          <div className="panel" style={{ marginBottom: 20 }}>
            <div className="panel-header">
              <div>
                <div className="panel-title">Fee Outlook — 15% benchmark</div>
                <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>
                  Calendar-year basis · pro-rated for mid-year starters · 30% of excess
                </div>
              </div>
              <div className="panel-meta">
                {feeLoading ? 'Loading…' : `${feeOutlook.filter(f => !f.is_internal).length} active mandates`}
              </div>
            </div>
            <FeeOutlookPanel loading={feeLoading} data={feeOutlook} />
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

          {/* FI yield curve — book context, universe view (no overlay in v27) */}
          <YieldCurvePanel />

        </main>
      </div>
    </div>
  )
}
