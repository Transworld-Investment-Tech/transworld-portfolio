import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { computeNAV } from '@/lib/portfolio'
import {
  computePeriodMetrics, PERIODS, type PeriodKey,
  buildCashFlows, calculateIRR, BENCHMARKS,
} from '@/lib/analytics'
import { computeFeeMetrics } from '@/lib/fee-calc'

// v27j: allPeriodsSummary surfaces `available`, `unavailableReason`, and
// `dynamicLabel` so the portfolio page can gate button rendering.
//
// v27l: route now also computes feeMetrics server-side using
// computeFeeMetrics from lib/fee-calc.ts. Returned alongside `period` in the
// response. Page uses this to render the fee calculation panel without an
// extra DB round-trip. Fee math reads portfolio.target_return (default 0.15
// per the v27k schema migration).

export async function GET(req: NextRequest) {
  const portfolioId = req.nextUrl.searchParams.get('portfolioId')
  const periodKey   = (req.nextUrl.searchParams.get('period') ?? 'ITD') as PeriodKey

  if (!portfolioId)
    return NextResponse.json({ error: 'portfolioId required' }, { status: 400 })

  const db = supabaseAdmin()

  const [portRes, holdRes, pricesRes, txRes, navRes] = await Promise.all([
    db.from('portfolios').select('*').eq('id', portfolioId).single(),
    db.from('holdings').select('*, instrument:instruments(*)').eq('portfolio_id', portfolioId),
    db.from('market_prices').select('instrument_id, price').order('price_date', { ascending: false }),
    db.from('transactions').select('*').eq('portfolio_id', portfolioId).order('trade_date', { ascending: true }),
    db.from('nav_log').select('*').eq('portfolio_id', portfolioId).order('nav_date', { ascending: true }),
  ])

  if (!portRes.data) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const portfolio    = portRes.data
  const navHistory   = navRes.data ?? []
  const transactions = txRes.data ?? []

  const priceMap: Record<string, number> = {}
  pricesRes.data?.forEach((p: any) => { if (!priceMap[p.instrument_id]) priceMap[p.instrument_id] = p.price })

  const holdings = (holdRes.data ?? []).map((h: any) => ({
    ...h,
    latest_price: priceMap[h.instrument_id] ?? h.avg_cost,
  }))

  const currentNAV = computeNAV(holdings)

  // Compute metrics for the requested period
  const metrics = computePeriodMetrics(periodKey, portfolio, currentNAV, navHistory, transactions)

  // v27l: fee math for the selected period (only if we have a valid startNAV)
  let feeMetrics: any = null
  if (metrics.available && metrics.startNAV !== null && metrics.startNAV > 0) {
    const thresholdRate = Number(portfolio.target_return ?? 0.15)
    feeMetrics = computeFeeMetrics({
      startNAV:      metrics.startNAV,
      endNAV:        currentNAV,
      startDate:     new Date(metrics.startDate),
      endDate:       new Date(metrics.endDate),
      transactions:  transactions.map((t: any) => ({
        trade_date: t.trade_date,
        action:     t.action,
        amount:     t.amount,
      })),
      thresholdRate,
      clientShare:   0.70,
    })
  }

  // v27j: surface availability flags on every period in the summary
  const allPeriodsSummary = PERIODS.map(p => {
    const m = computePeriodMetrics(p.key, portfolio, currentNAV, navHistory, transactions)
    return {
      period:             m.period,
      periodLabel:        m.periodLabel,
      daysHeld:           m.daysHeld,
      simplePeriodReturn: m.simplePeriodReturn,
      irr:                m.irr,
      available:          m.available,
      unavailableReason:  m.unavailableReason,
      dynamicLabel:       m.dynamicLabel,
    }
  })

  return NextResponse.json({
    portfolioId,
    portfolioName: portfolio.name,
    startDate:     portfolio.start_date,
    startingNAV:   portfolio.starting_nav,
    currentNAV,
    period:        metrics,
    allPeriods:    allPeriodsSummary,
    feeMetrics,    // v27l
    targetReturn:  Number(portfolio.target_return ?? 0.15),  // v27l
    benchmarkNote: 'NGX index data estimated from known annual returns. Live data not available.',
  })
}
