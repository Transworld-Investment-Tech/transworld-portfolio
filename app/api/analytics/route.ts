import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import {
  calculateIRR, buildCashFlows, calcPeriodReturn, BENCHMARKS,
} from '@/lib/analytics'
import { computeNAV } from '@/lib/portfolio'

export async function GET(req: NextRequest) {
  const portfolioId = req.nextUrl.searchParams.get('portfolioId')
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

  const portfolio = portRes.data
  const navHistory = navRes.data ?? []
  const transactions = txRes.data ?? []

  // Current NAV
  const priceMap: Record<string, number> = {}
  pricesRes.data?.forEach((p: any) => {
    if (!priceMap[p.instrument_id]) priceMap[p.instrument_id] = p.price
  })
  const holdings = (holdRes.data ?? []).map((h: any) => ({
    ...h,
    latest_price: priceMap[h.instrument_id] ?? h.avg_cost,
  }))
  const currentNAV = computeNAV(holdings)

  // ── IRR ───────────────────────────────────────────────────────
  const cashFlows = buildCashFlows(
    portfolio.starting_nav,
    portfolio.start_date,
    transactions,
    currentNAV,
  )
  const irr = calculateIRR(cashFlows)

  // ── Period returns ────────────────────────────────────────────
  // Try to get NAV from nav_log first; fall back to computing from holdings
  const navWithCurrent = [
    ...navHistory,
    { nav_date: new Date().toISOString().slice(0, 10), nav_value: currentNAV },
  ]

  const periods = [
    { label: '1 Month',   days: 30  },
    { label: '3 Months',  days: 91  },
    { label: '6 Months',  days: 182 },
    { label: '1 Year',    days: 365 },
    { label: 'Since Inception', days: Math.round((Date.now() - new Date(portfolio.start_date).getTime()) / 86400000) },
  ]

  const periodReturns = periods.map(p =>
    calcPeriodReturn(currentNAV, navWithCurrent, p.days, p.label)
  )

  // ── Total return since inception ──────────────────────────────
  const totalReturn = (currentNAV - portfolio.starting_nav) / portfolio.starting_nav
  const daysInception = Math.round((Date.now() - new Date(portfolio.start_date).getTime()) / 86400000)
  const annualisedReturn = daysInception > 0
    ? Math.pow(1 + totalReturn, 365 / daysInception) - 1
    : null

  return NextResponse.json({
    portfolioId,
    portfolioName: portfolio.name,
    startDate:     portfolio.start_date,
    startingNAV:   portfolio.starting_nav,
    currentNAV,
    totalReturn,
    annualisedReturn,
    daysInception,
    irr,
    periodReturns,
    benchmarks:    BENCHMARKS,
    cashFlowCount: cashFlows.length,
  })
}
