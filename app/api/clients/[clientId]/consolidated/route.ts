import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { buildCashFlows, solveIRR } from '@/lib/analytics'

// v21k: GET /api/clients/[clientId]/consolidated
// Aggregates holdings, prices, sleeve data, and blended IRR across
// all active portfolios for a single client.
export const maxDuration = 60

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ clientId: string }> },
) {
  const { clientId } = await params
  const db = supabaseAdmin()

  // ── 1. Client + embedded portfolios ─────────────────────────────────
  const { data: client, error: clientErr } = await db
    .from('clients')
    .select('id, name, code, type, portfolios(id, label, name, starting_nav, start_date, currency, valuation_date, income_target, status)')
    .eq('id', clientId)
    .single()

  if (clientErr || !client) {
    return NextResponse.json({ error: 'Client not found' }, { status: 404 })
  }

  // Pitfall #52: .eq('status','active') on parent does NOT cascade to
  // the embedded portfolios relation — filter client-side.
  const portfolios = ((client as any).portfolios ?? []).filter(
    (p: any) => p.status === 'active',
  ) as Array<{
    id: string; label: string; name: string
    starting_nav: number; start_date: string | null
    currency: string; valuation_date: string | null
    income_target: number; status: string
  }>

  const empty = {
    client: { id: (client as any).id, name: (client as any).name, code: (client as any).code, type: (client as any).type },
    portfolios: [],
    summary: { totalNAV: 0, totalStartingNAV: 0, totalPnL: 0, totalPnLPct: 0, blendedIRR: null, portfolioCount: 0 },
    combinedHoldings: [],
    sleeveBreakdown: [],
  }

  if (portfolios.length === 0) return NextResponse.json(empty)

  const portfolioIds = portfolios.map(p => p.id)

  // ── 2. Holdings + prices + transactions (parallel) ───────────────────
  const [holdRes, pricesRes, txRes] = await Promise.all([
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
  ])

  const allHoldings = holdRes.data ?? []
  const allTx       = txRes.data   ?? []

  // Latest price per instrument (first row per instrument_id = most recent due to ORDER BY desc)
  const priceMap: Record<string, number> = {}
  for (const p of pricesRes.data ?? []) {
    if (!priceMap[p.instrument_id]) priceMap[p.instrument_id] = p.price
  }

  // Per-portfolio NAV
  const navByPortfolio: Record<string, number> = {}
  for (const h of allHoldings) {
    const price = priceMap[h.instrument_id] ?? h.avg_cost
    navByPortfolio[h.portfolio_id] = (navByPortfolio[h.portfolio_id] ?? 0) + h.quantity * price
  }

  // ── 3. Blended IRR — merge cash flows across all portfolios ──────────
  let blendedIRR: number | null = null
  try {
    const mergedFlows: any[] = []
    for (const p of portfolios) {
      if (!(p.starting_nav > 0) || !p.start_date) continue
      const portTx  = allTx.filter((t: any) => t.portfolio_id === p.id)
      const portNAV = navByPortfolio[p.id] ?? 0
      const flows   = buildCashFlows(p.starting_nav, p.start_date, portTx, portNAV)
      mergedFlows.push(...flows)
    }
    if (mergedFlows.length > 1) {
      blendedIRR = solveIRR(mergedFlows)
      // Guard against solver returning Infinity / NaN
      if (!isFinite(blendedIRR as number)) blendedIRR = null
    }
  } catch {
    blendedIRR = null
  }

  // ── 4. Aggregate holdings by instrument_id ───────────────────────────
  const portfolioById = Object.fromEntries(portfolios.map(p => [p.id, p]))

  type AggEntry = {
    instrument_id: string; name: string; type: string
    sector: string | null; coupon_pct: number | null; sleeve_id: string
    totalQty: number; weightedCostSum: number
    breakdown: Array<{ portfolioId: string; label: string; quantity: number; avgCost: number }>
  }

  const aggMap: Record<string, AggEntry> = {}

  for (const h of allHoldings) {
    const instr = (h as any).instrument
    if (!aggMap[h.instrument_id]) {
      aggMap[h.instrument_id] = {
        instrument_id: h.instrument_id,
        name:          instr?.name ?? h.instrument_id,
        type:          instr?.type ?? 'Stock',
        sector:        instr?.sector ?? null,
        coupon_pct:    instr?.coupon_pct ?? null,
        sleeve_id:     h.sleeve_id ?? 'eq',
        totalQty:      0,
        weightedCostSum: 0,
        breakdown:     [],
      }
    }
    const a = aggMap[h.instrument_id]
    a.totalQty        += h.quantity
    a.weightedCostSum += h.quantity * h.avg_cost
    a.breakdown.push({
      portfolioId: h.portfolio_id,
      label:       portfolioById[h.portfolio_id]?.label ?? '?',
      quantity:    h.quantity,
      avgCost:     h.avg_cost,
    })
  }

  const totalNAV = Object.values(navByPortfolio).reduce((s, v) => s + v, 0)

  const combinedHoldings = Object.values(aggMap).map(a => {
    const blendedAvgCost = a.totalQty > 0 ? a.weightedCostSum / a.totalQty : 0
    const latestPrice    = priceMap[a.instrument_id] ?? blendedAvgCost
    const totalValue     = a.totalQty * latestPrice
    const totalPnL       = a.totalQty * (latestPrice - blendedAvgCost)
    const totalPnLPct    = blendedAvgCost > 0 ? (latestPrice - blendedAvgCost) / blendedAvgCost : 0
    return {
      instrument_id: a.instrument_id,
      name:          a.name,
      type:          a.type,
      sector:        a.sector,
      coupon_pct:    a.coupon_pct,
      sleeve_id:     a.sleeve_id,
      totalQuantity: a.totalQty,
      blendedAvgCost,
      latestPrice,
      totalValue,
      totalPnL,
      totalPnLPct,
      weight:        totalNAV > 0 ? totalValue / totalNAV : 0,
      portfolioBreakdown: a.breakdown,
    }
  }).sort((a, b) => b.totalValue - a.totalValue)

  // ── 5. Sleeve breakdown ──────────────────────────────────────────────
  const sleeveAgg: Record<string, { name: string; value: number }> = {}
  const sleeveNames: Record<string, string> = { eq: 'Equities (NGX)', liq: 'Cash & Liquidity', fi: 'Fixed Income' }
  for (const h of combinedHoldings) {
    const sid = h.sleeve_id || 'eq'
    if (!sleeveAgg[sid]) sleeveAgg[sid] = { name: sleeveNames[sid] ?? sid, value: 0 }
    sleeveAgg[sid].value += h.totalValue
  }
  const sleeveBreakdown = Object.entries(sleeveAgg)
    .map(([sleeve_id, v]) => ({ sleeve_id, name: v.name, totalValue: v.value, pct: totalNAV > 0 ? v.value / totalNAV : 0 }))
    .sort((a, b) => b.totalValue - a.totalValue)

  // ── 6. Build response ────────────────────────────────────────────────
  const totalStartingNAV = portfolios.reduce((s, p) => s + (p.starting_nav ?? 0), 0)
  const totalPnL         = totalNAV - totalStartingNAV
  const totalPnLPct      = totalStartingNAV > 0 ? totalPnL / totalStartingNAV : 0

  return NextResponse.json({
    client: {
      id:   (client as any).id,
      name: (client as any).name,
      code: (client as any).code,
      type: (client as any).type,
    },
    portfolios: portfolios.map(p => ({
      id:           p.id,
      label:        p.label,
      name:         p.name,
      starting_nav: p.starting_nav,
      start_date:   p.start_date,
      currency:     p.currency,
      valuation_date: p.valuation_date,
      income_target: p.income_target,
      current_nav:  navByPortfolio[p.id] ?? 0,
    })),
    summary: {
      totalNAV,
      totalStartingNAV,
      totalPnL,
      totalPnLPct,
      blendedIRR,
      portfolioCount: portfolios.length,
    },
    combinedHoldings,
    sleeveBreakdown,
  })
}
