import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { generateCIOBrief, type CIOBriefInput, type CIOBriefPortfolio } from '@/lib/cio-brief-engine'

// v21r: CIO Weekly Intelligence Brief API
// POST: generate brief for all active portfolios + save to cio_briefs
// GET:  fetch brief history (last 20)
export const maxDuration = 300

export async function POST(req: NextRequest) {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured.' }, { status: 500 })
    }

    const body = await req.json().catch(() => ({}))
    const generatedBy: string = body.generatedBy ?? 'manual'
    const db = supabaseAdmin()

    // Fetch all active portfolios with client info
    const { data: portfoliosRaw, error: portErr } = await db
      .from('portfolios')
      .select('id, name, label, starting_nav, start_date, income_target, currency, client:clients(name, code)')
      .eq('status', 'active')
      .limit(100)

    if (portErr) return NextResponse.json({ error: portErr.message }, { status: 500 })
    if (!portfoliosRaw?.length) return NextResponse.json({ error: 'No active portfolios found.' }, { status: 404 })

    const portfolioIds = portfoliosRaw.map((p: any) => p.id)

    // Fetch holdings, watchlist, FX in parallel
    const [holdingsRes, watchlistRes, fxRes] = await Promise.all([
      db.from('holdings')
        .select('portfolio_id, instrument_id, quantity, avg_cost, instrument:instruments(name, type)')
        .in('portfolio_id', portfolioIds)
        .limit(5000),
      db.from('watchlist')
        .select('ticker, name, section, sub_type, rank, rationale')
        .eq('active', true)
        .order('rank')
        .limit(200),
      fetch('https://api.exchangerate-api.com/v4/latest/USD').then(r => r.json()).catch(() => null),
    ])

    const allHoldings = holdingsRes.data ?? []
    const heldIds = [...new Set(allHoldings.map((h: any) => h.instrument_id as string))]

    // Fetch latest prices for all held instruments (pitfall #59: explicit limit)
    const pricesRes = heldIds.length > 0
      ? await db.from('market_prices')
          .select('instrument_id, price, price_date')
          .in('instrument_id', heldIds)
          .order('price_date', { ascending: false })
          .limit(50000)
      : { data: [] as any[] }

    // Build price map — first occurrence per instrument = latest (ordered DESC)
    const priceMap: Record<string, number> = {}
    ;(pricesRes.data ?? []).forEach((p: any) => {
      if (!priceMap[p.instrument_id]) priceMap[p.instrument_id] = Number(p.price)
    })

    // Aggregate holdings by portfolio
    const holdingsByPortfolio: Record<string, any[]> = {}
    allHoldings.forEach((h: any) => {
      if (!holdingsByPortfolio[h.portfolio_id]) holdingsByPortfolio[h.portfolio_id] = []
      const price = priceMap[h.instrument_id] ?? Number(h.avg_cost)
      holdingsByPortfolio[h.portfolio_id].push({
        instrument_id: h.instrument_id,
        name:          (h.instrument as any)?.name ?? h.instrument_id,
        type:          (h.instrument as any)?.type ?? 'Stock',
        quantity:      Number(h.quantity),
        avg_cost:      Number(h.avg_cost),
        latest_price:  price,
        market_value:  Number(h.quantity) * price,
        weight:        0, // computed below
      })
    })

    // Build portfolio objects with computed NAV and weights
    const portfolios: CIOBriefPortfolio[] = portfoliosRaw.map((p: any) => {
      const holdings = holdingsByPortfolio[p.id] ?? []
      const nav      = holdings.reduce((s: number, h: any) => s + h.market_value, 0)
      holdings.forEach((h: any) => { h.weight = nav > 0 ? h.market_value / nav : 0 })
      holdings.sort((a: any, b: any) => b.weight - a.weight)
      return {
        id:            p.id,
        name:          p.name,
        label:         p.label,
        clientName:    (p.client as any)?.name ?? 'Unknown',
        clientCode:    (p.client as any)?.code ?? '\u2014',
        currency:      p.currency ?? 'NGN',
        starting_nav:  Number(p.starting_nav ?? 0),
        start_date:    p.start_date,
        current_nav:   nav,
        income_target: Number(p.income_target ?? 0),
        holdings,
      }
    })

    const briefInput: CIOBriefInput = {
      portfolios,
      watchlist:   watchlistRes.data ?? [],
      fxRate:      fxRes?.rates?.NGN,
      generatedBy,
    }

    const content   = await generateCIOBrief(briefInput)
    const briefDate = new Date().toISOString().slice(0, 10)

    await db.from('cio_briefs').insert({
      brief_date:   briefDate,
      content,
      generated_by: generatedBy,
    })

    return NextResponse.json({ brief: content, brief_date: briefDate })
  } catch (err) {
    console.error('CIO brief generation error:', err)
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}

export async function GET(_req: NextRequest) {
  const db = supabaseAdmin()
  const { data, error } = await db
    .from('cio_briefs')
    .select('id, brief_date, content, generated_by, created_at')
    .order('brief_date', { ascending: false })
    .limit(20)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ briefs: data ?? [] })
}
