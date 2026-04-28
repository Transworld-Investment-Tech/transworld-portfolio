import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { computeNAV, computeSleeveData, complianceAlerts, fmt } from '@/lib/portfolio'
import { computePeriodMetrics, calcPeriodReturn, BENCHMARKS } from '@/lib/analytics'  // v27s: route IRR through consolidated codepath
import { generateHTMLReport } from '@/lib/html-report'

// v20g fix: complianceAlerts() was being called with arguments 2 and 3
// swapped. The signature is (portfolio, holdings, sleeveData, totalNAV)
// but this route was passing (portfolio, sleeveDefs, holdings, totalNAV).
// Both loops inside complianceAlerts were iterating the wrong shape, so
// the PDF export has been silently producing an empty alerts array for
// as long as this code has existed. See pitfall #37 in 04_pitfalls.md.

export async function GET(req: NextRequest) {
  const portfolioId = req.nextUrl.searchParams.get('portfolioId')
  if (!portfolioId) return new NextResponse('portfolioId required', { status: 400 })

  const db = supabaseAdmin()
  const [portRes, holdRes, sleeveRes, pricesRes, txRes, navRes, reportRes, fxRes] = await Promise.all([
    db.from('portfolios').select('*, client:clients(name, code)').eq('id', portfolioId).single(),
    db.from('holdings').select('*, instrument:instruments(*)').eq('portfolio_id', portfolioId),
    db.from('sleeve_targets').select('*').eq('portfolio_id', portfolioId).order('sort_order'),
    db.from('market_prices').select('instrument_id, price, day_change').order('price_date', { ascending: false }),
    db.from('transactions').select('*').eq('portfolio_id', portfolioId).order('trade_date', { ascending: true }),
    db.from('nav_log').select('*').eq('portfolio_id', portfolioId).order('nav_date', { ascending: true }),
    db.from('reports').select('report_type, content, report_date').eq('portfolio_id', portfolioId).order('created_at', { ascending: false }).limit(1).single(),
    fetch('https://api.exchangerate-api.com/v4/latest/USD').then(r => r.json()).catch(() => null),
  ])

  if (!portRes.data) return new NextResponse('Portfolio not found', { status: 404 })

  const portfolio = portRes.data
  const txns = txRes.data ?? []
  const navHistory = navRes.data ?? []

  const priceMap: Record<string, number> = {}
  pricesRes.data?.forEach((p: any) => { if (!priceMap[p.instrument_id]) priceMap[p.instrument_id] = p.price })

  const holdings = (holdRes.data ?? []).map((h: any) => ({
    ...h,
    latest_price: priceMap[h.instrument_id] ?? h.avg_cost,
    day_change: 0,
  }))

  const sleeveDefs = sleeveRes.data ?? []
  const currentNAV = computeNAV(holdings)
  const sleeveData = computeSleeveData(holdings, sleeveDefs, currentNAV)

  // v20g: arg order is (portfolio, holdings, sleeveData, totalNAV).
  // Previously this passed (portfolio, sleeveDefs, holdings, ...) which
  // made both inner loops silently iterate the wrong collection.
  const alerts = complianceAlerts(portfolio as any, holdings, sleeveData, currentNAV)

  const fxRate = fxRes?.rates?.NGN ?? 1665

  // IRR — v27u: extend v27s single-period to three periods (ITD + LY + YTD).
  // YTD becomes the report headline; LY + ITD shown smaller below.
  // navHistory is required for LY/YTD period-boundary NAV lookups; ITD
  // reads portfolio.starting_nav directly so it works either way.
  let irrITD: number | null = null
  let irrLY:  number | null = null
  let irrYTD: number | null = null
  if ((portfolio.starting_nav ?? 0) > 0 && portfolio.start_date) {
    try { irrITD = computePeriodMetrics('ITD', portfolio, currentNAV, navHistory, txns).irr } catch { irrITD = null }
    try { irrLY  = computePeriodMetrics('LY',  portfolio, currentNAV, navHistory, txns).irr } catch { irrLY  = null }
    try { irrYTD = computePeriodMetrics('YTD', portfolio, currentNAV, navHistory, txns).irr } catch { irrYTD = null }
  }
  // Backward compat: page-1 KPI strip and benchmarks "This Portfolio" row
  // continue reading `irr` which keeps its prior meaning (ITD).
  const irr = irrITD
  const navWithCurrent = [...navHistory, { nav_date: new Date().toISOString().slice(0, 10), nav_value: currentNAV }]
  const periodReturns = [
    { label: '1 Month',   days: 30  },
    { label: '3 Months',  days: 91  },
    { label: '1 Year',    days: 365 },
    { label: 'Since Inception', days: Math.round((Date.now() - new Date(portfolio.start_date).getTime()) / 86400000) },
  ].map(p => calcPeriodReturn(currentNAV, navWithCurrent, p.days, p.label))

  const totalReturn = currentNAV - portfolio.starting_nav
  const totalReturnPct = portfolio.starting_nav > 0 ? totalReturn / portfolio.starting_nav : 0
  const daysInception = Math.round((Date.now() - new Date(portfolio.start_date).getTime()) / 86400000)
  const annualisedReturn = daysInception > 0 && portfolio.starting_nav > 0
    ? Math.pow(1 + totalReturnPct, 365 / daysInception) - 1
    : null

  // Fee totals
  const fees = {
    commission: txns.reduce((s: number, t: any) => s + (t.fee_commission ?? 0), 0),
    vat:        txns.reduce((s: number, t: any) => s + (t.fee_vat ?? 0), 0),
    stamp:      txns.reduce((s: number, t: any) => s + (t.fee_contract_stamp ?? 0), 0),
    exchange:   txns.reduce((s: number, t: any) => s + (t.fee_exchange ?? 0), 0),
    clearing:   txns.reduce((s: number, t: any) => s + (t.fee_clearing ?? 0), 0),
    sms:        txns.reduce((s: number, t: any) => s + (t.fee_sms ?? 0), 0),
    management: txns.reduce((s: number, t: any) => s + (t.fee_management ?? 0), 0),
    total:      txns.reduce((s: number, t: any) => s + (t.fees ?? 0), 0),
  }
  const buys  = txns.filter((t: any) => t.action === 'BUY')
  const sells = txns.filter((t: any) => t.action === 'SELL')

  const reportDate = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })
  const generatedAt = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })

  const html = generateHTMLReport({
    portfolioName: portfolio.name,
    clientName:    (portfolio as any).client?.name ?? 'N/A',
    reportDate,
    generatedAt,
    currency: portfolio.currency,
    currentNAV,
    startingNAV: portfolio.starting_nav,
    startDate: portfolio.start_date,
    totalReturn,
    totalReturnPct,
    fxRate,
    sleeves: sleeveData.map((s: any) => ({
      name: s.name,
      targetPct: s.target_pct,
      actualPct: s.act,
      value: s.val,
      status: s.status,
    })),
    holdings: holdings.map((h: any) => ({
      instrumentId: h.instrument_id,
      name: h.instrument?.name ?? h.instrument_id,
      sleeve: h.sleeve_id ?? '',
      type: h.instrument?.type ?? 'Unknown',
      quantity: Math.round(h.quantity),
      avgCost: h.avg_cost,
      currentPrice: h.latest_price,
      marketValue: h.quantity * h.latest_price,
      unrealisedPnL: h.quantity * (h.latest_price - h.avg_cost),
      weight: currentNAV > 0 ? (h.quantity * h.latest_price) / currentNAV : 0,
    })),
    fees,
    txSummary: {
      total: txns.length,
      buys: buys.length,
      sells: sells.length,
      buyGross:  buys.reduce((s: number, t: any) => s + (t.gross_value ?? 0), 0),
      sellGross: sells.reduce((s: number, t: any) => s + (t.gross_value ?? 0), 0),
    },
    mandate: {
      incomeTarget: portfolio.income_target,
      capTarget:    portfolio.cap_target,
      maxSingleEq:  portfolio.max_eq_single,
      maxEqSleeve:  portfolio.max_eq_sleeve,
      ddAlert:      Math.abs(portfolio.dd_alert),
      ddAction:     Math.abs(portfolio.dd_action),
    },
    irr,
    irrITD,    // v27u
    irrLY,     // v27u
    irrYTD,    // v27u
    annualisedReturn,
    periodReturns: periodReturns.map(p => ({
      label: p.label,
      percentReturn: p.percentReturn,
      annualisedReturn: p.annualisedReturn,
      daysHeld: p.daysHeld,
    })),
    benchmarks: BENCHMARKS,
    aiReport: reportRes.data ? {
      type:    reportRes.data.report_type,
      content: reportRes.data.content,
      date:    reportRes.data.report_date,
    } : undefined,
    alerts: (alerts ?? []).map((a: any) => ({ level: a.level, message: a.message })),
  })

  return new NextResponse(html, {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': `inline; filename="${portfolio.name.replace(/\s+/g, '_')}_Report_${new Date().toISOString().slice(0, 10)}.html"`,
    },
  })
}
