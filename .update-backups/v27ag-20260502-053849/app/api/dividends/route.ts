import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { computeNAV } from '@/lib/portfolio'

export interface DividendEstimate {
  instrumentId:   string
  name:           string
  shares:         number
  currentPrice:   number
  divPerShare:    number
  divYieldPct:    number
  annualIncome:   number
  divStatus:      string   // 'paying' | 'suspended' | 'none' | 'variable'
  divFrequency:   string
  lastDivDate:    string | null
  nextDivDate:    string | null
  divNotes:       string | null
  confidence:     'high' | 'medium' | 'low' | 'none'
}

export interface DividendSummary {
  totalEstimatedIncome:     number
  payingPositions:          number
  suspendedPositions:       number
  portfolioYield:           number   // as decimal
  incomeTargetGap:          number   // income target - estimated yield
  portfolioNAV:             number
  incomeTarget:             number
  positions:                DividendEstimate[]
  incomeForecastLow:        number   // conservative estimate
  incomeForecastHigh:       number   // optimistic estimate
  nextDividendExpected:     string | null  // next expected dividend date
  methodology:              string
}

function confidenceLevel(status: string, lastDate: string | null): 'high' | 'medium' | 'low' | 'none' {
  if (status === 'suspended' || status === 'none') return 'none'
  if (!lastDate) return 'low'
  const monthsAgo = (Date.now() - new Date(lastDate).getTime()) / (1000 * 60 * 60 * 24 * 30)
  if (monthsAgo < 18) return 'high'
  if (monthsAgo < 36) return 'medium'
  return 'low'
}

export async function GET(req: NextRequest) {
  const portfolioId = req.nextUrl.searchParams.get('portfolioId')
  if (!portfolioId) return NextResponse.json({ error: 'portfolioId required' }, { status: 400 })

  const db = supabaseAdmin()

  const [portRes, holdRes, pricesRes] = await Promise.all([
    db.from('portfolios').select('*').eq('id', portfolioId).single(),
    db.from('holdings').select('*, instrument:instruments(*)').eq('portfolio_id', portfolioId),
    db.from('market_prices').select('instrument_id, price').order('price_date', { ascending: false }),
  ])

  if (!portRes.data) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const portfolio = portRes.data
  const priceMap: Record<string, number> = {}
  pricesRes.data?.forEach((p: any) => { if (!priceMap[p.instrument_id]) priceMap[p.instrument_id] = p.price })

  const holdings = (holdRes.data ?? []).map((h: any) => ({
    ...h, latest_price: priceMap[h.instrument_id] ?? h.avg_cost,
  }))

  const portfolioNAV = computeNAV(holdings)
  const equities = holdings.filter((h: any) => h.instrument?.type === 'Stock')

  const positions: DividendEstimate[] = equities.map((h: any) => {
    const instr = h.instrument ?? {}
    const price = h.latest_price ?? h.avg_cost
    const shares = Math.round(h.quantity)
    const divPerShare  = instr.div_per_share  ?? 0
    const divYieldPct  = instr.div_yield_pct  ?? 0
    const divStatus    = instr.div_status     ?? 'unknown'
    const annualIncome = shares * divPerShare

    return {
      instrumentId: h.instrument_id,
      name:         instr.name ?? h.instrument_id,
      shares,
      currentPrice: price,
      divPerShare,
      divYieldPct,
      annualIncome,
      divStatus,
      divFrequency: instr.div_frequency ?? 'annual',
      lastDivDate:  instr.last_div_date ?? null,
      nextDivDate:  instr.next_div_date ?? null,
      divNotes:     instr.div_notes ?? null,
      confidence:   confidenceLevel(divStatus, instr.last_div_date),
    }
  })

  const paying    = positions.filter(p => p.divStatus === 'paying')
  const suspended = positions.filter(p => p.divStatus === 'suspended')

  const totalEstimated = positions.reduce((s, p) => s + p.annualIncome, 0)

  // Conservative: only paying positions with high/medium confidence
  const conservative = positions
    .filter(p => p.divStatus === 'paying' && ['high','medium'].includes(p.confidence))
    .reduce((s, p) => s + p.annualIncome, 0)

  // Optimistic: all paying + 50% of suspended positions' historical yield
  const optimistic = totalEstimated + suspended.reduce((s, p) => {
    // Estimate potential resumption: use market price × 2% yield assumption
    return s + (p.currentPrice * p.shares * 0.02)
  }, 0)

  const portfolioYield = portfolioNAV > 0 ? totalEstimated / portfolioNAV : 0
  const incomeTarget = portfolio.income_target ?? 0.10  // 10% default
  const incomeRequired = portfolioNAV * incomeTarget
  const incomeTargetGap = incomeRequired - totalEstimated

  // Next dividend expected
  const nextDivs = positions
    .filter(p => p.nextDivDate)
    .sort((a, b) => new Date(a.nextDivDate!).getTime() - new Date(b.nextDivDate!).getTime())

  const methodology = [
    'Annual dividend income estimated from most recently declared DPS × current shares held.',
    'Suspended dividends (NB, NESTLE, UNILEVER) contribute ₦0 to estimates.',
    'Conservative estimate excludes low-confidence positions.',
    'Optimistic estimate adds 2% yield assumption on suspended positions if resumption occurs.',
    'Source: NGX company filings, investor relations announcements. Reference: Mar 2026.',
  ].join(' ')

  const summary: DividendSummary = {
    totalEstimatedIncome: totalEstimated,
    payingPositions:      paying.length,
    suspendedPositions:   suspended.length,
    portfolioYield,
    incomeTargetGap,
    portfolioNAV,
    incomeTarget,
    positions,
    incomeForecastLow:  conservative,
    incomeForecastHigh: optimistic,
    nextDividendExpected: nextDivs[0]?.nextDivDate ?? null,
    methodology,
  }

  return NextResponse.json(summary)
}
