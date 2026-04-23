import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { buildCashFlows, solveIRR } from '@/lib/analytics'
import { generateConsolidatedReport } from '@/lib/consolidated-report'

// v21k: /api/clients/[clientId]/report
//   GET  — fetch saved consolidated reports for this client
//   POST — generate + save a consolidated AI report

export const maxDuration = 300

// ─── GET: fetch saved consolidated reports ───────────────────────────────────
export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ clientId: string }> },
) {
  const { clientId } = await params
  const db = supabaseAdmin()

  // Get all active portfolio IDs for this client
  const { data: client } = await db
    .from('clients')
    .select('id, portfolios(id, status)')
    .eq('id', clientId)
    .single()

  if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 })

  // Pitfall #52: filter portfolios client-side
  const portfolioIds = ((client as any).portfolios ?? [])
    .filter((p: any) => p.status === 'active')
    .map((p: any) => p.id as string)

  if (portfolioIds.length === 0) return NextResponse.json({ reports: [] })

  const { data: reports, error } = await db
    .from('reports')
    .select('id, report_type, report_date, created_at, content')
    .in('portfolio_id', portfolioIds)
    .eq('report_type', 'consolidated')
    .order('created_at', { ascending: false })
    .limit(20)

  if (error) return NextResponse.json({ error: error.message }, { status: 500 })

  // Deduplicate by created_at (in case report was saved to multiple portfolios)
  const seen = new Set<string>()
  const unique = (reports ?? []).filter(r => {
    const key = r.created_at
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  return NextResponse.json({ reports: unique })
}

// ─── POST: generate a consolidated AI report ─────────────────────────────────
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ clientId: string }> },
) {
  const { clientId } = await params
  const { reportType } = await req.json() as { reportType: 'monthly' | 'quarterly' }

  if (!reportType) return NextResponse.json({ error: 'reportType required' }, { status: 400 })
  if (!process.env.ANTHROPIC_API_KEY) return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })

  const db = supabaseAdmin()

  // ── 1. Client + active portfolios ─────────────────────────────────────
  const { data: client } = await db
    .from('clients')
    .select('id, name, code, type, portfolios(id, label, name, starting_nav, start_date, currency, valuation_date, income_target, status)')
    .eq('id', clientId)
    .single()

  if (!client) return NextResponse.json({ error: 'Client not found' }, { status: 404 })

  const portfolios = ((client as any).portfolios ?? []).filter((p: any) => p.status === 'active') as any[]
  if (portfolios.length === 0) return NextResponse.json({ error: 'No active portfolios for this client' }, { status: 400 })

  const portfolioIds = portfolios.map((p: any) => p.id as string)

  // ── 2. Holdings + prices + transactions + watchlist + FX ──────────────
  const [holdRes, pricesRes, txRes, watchlistRes, fxRes] = await Promise.all([
    db.from('holdings')
      .select('portfolio_id, instrument_id, quantity, avg_cost, sleeve_id, instrument:instruments(name, type, sector, coupon_pct)')
      .in('portfolio_id', portfolioIds),
    db.from('market_prices')
      .select('instrument_id, price, price_date')
      .order('price_date', { ascending: false }),
    db.from('transactions')
      .select('portfolio_id, trade_date, action, instrument_id, quantity, price, amount')
      .in('portfolio_id', portfolioIds)
      .order('trade_date', { ascending: true }),
    db.from('watchlist')
      .select('ticker, name, section, sub_type, rank, rationale')
      .eq('active', true)
      .order('rank'),
    fetch('https://api.exchangerate-api.com/v4/latest/USD').then(r => r.json()).catch(() => null),
  ])

  const allHoldings = holdRes.data ?? []
  const allTx       = txRes.data   ?? []

  const priceMap: Record<string, number> = {}
  for (const p of pricesRes.data ?? []) {
    if (!priceMap[p.instrument_id]) priceMap[p.instrument_id] = p.price
  }

  const navByPortfolio: Record<string, number> = {}
  for (const h of allHoldings) {
    const price = priceMap[h.instrument_id] ?? h.avg_cost
    navByPortfolio[h.portfolio_id] = (navByPortfolio[h.portfolio_id] ?? 0) + h.quantity * price
  }

  // Blended IRR
  let blendedIRR: number | null = null
  try {
    const mergedFlows: any[] = []
    for (const p of portfolios) {
      if (!(p.starting_nav > 0) || !p.start_date) continue
      const flows = buildCashFlows(p.starting_nav, p.start_date, allTx.filter((t: any) => t.portfolio_id === p.id), navByPortfolio[p.id] ?? 0)
      mergedFlows.push(...flows)
    }
    if (mergedFlows.length > 1) {
      const irr = solveIRR(mergedFlows)
      if (isFinite(irr as number)) blendedIRR = irr
    }
  } catch { blendedIRR = null }

  // Aggregate holdings by instrument
  const aggMap: Record<string, any> = {}
  const portfolioById = Object.fromEntries(portfolios.map((p: any) => [p.id, p]))
  for (const h of allHoldings) {
    const instr = (h as any).instrument
    if (!aggMap[h.instrument_id]) {
      aggMap[h.instrument_id] = {
        instrument_id: h.instrument_id, name: instr?.name ?? h.instrument_id,
        type: instr?.type ?? 'Stock', sector: instr?.sector ?? null,
        coupon_pct: instr?.coupon_pct ?? null, sleeve_id: h.sleeve_id ?? 'eq',
        totalQty: 0, weightedCostSum: 0, breakdown: [],
      }
    }
    const a = aggMap[h.instrument_id]
    a.totalQty        += h.quantity
    a.weightedCostSum += h.quantity * h.avg_cost
    a.breakdown.push({ label: portfolioById[h.portfolio_id]?.label ?? '?', quantity: h.quantity, avgCost: h.avg_cost })
  }

  const totalNAV = Object.values(navByPortfolio).reduce((s: number, v: any) => s + v, 0)

  const combinedHoldings = Object.values(aggMap).map((a: any) => {
    const blendedAvgCost = a.totalQty > 0 ? a.weightedCostSum / a.totalQty : 0
    const latestPrice    = priceMap[a.instrument_id] ?? blendedAvgCost
    return {
      ...a, blendedAvgCost, latestPrice,
      totalValue:  a.totalQty * latestPrice,
      totalPnL:    a.totalQty * (latestPrice - blendedAvgCost),
      totalPnLPct: blendedAvgCost > 0 ? (latestPrice - blendedAvgCost) / blendedAvgCost : 0,
      weight: totalNAV > 0 ? (a.totalQty * latestPrice) / totalNAV : 0,
    }
  }).sort((a: any, b: any) => b.totalValue - a.totalValue)

  const totalStartingNAV = portfolios.reduce((s: number, p: any) => s + (p.starting_nav ?? 0), 0)

  // ── 3. Generate report ─────────────────────────────────────────────────
  const report = await generateConsolidatedReport({
    client: { name: (client as any).name, code: (client as any).code, type: (client as any).type },
    portfolios: portfolios.map((p: any) => ({
      ...p, current_nav: navByPortfolio[p.id] ?? 0,
    })),
    summary: {
      totalNAV, totalStartingNAV,
      totalPnL: totalNAV - totalStartingNAV,
      totalPnLPct: totalStartingNAV > 0 ? (totalNAV - totalStartingNAV) / totalStartingNAV : 0,
      blendedIRR,
    },
    combinedHoldings,
    reportType,
    watchlist: watchlistRes.data ?? [],
    fxRate: fxRes?.rates?.NGN,
  })

  // ── 4. Save — to the first portfolio (sorted by label) ────────────────
  const primaryPortfolio = [...portfolios].sort((a: any, b: any) => a.label.localeCompare(b.label))[0]
  await db.from('reports').insert({
    portfolio_id: primaryPortfolio.id,
    report_type:  'consolidated',
    report_date:  new Date().toISOString().slice(0, 10),
    content:      report,
  })

  return NextResponse.json({ report })
}
