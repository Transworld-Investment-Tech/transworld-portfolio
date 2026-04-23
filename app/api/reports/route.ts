import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { generateAIReport, type ReportType } from '@/lib/report-engine'

// Extend Vercel serverless function timeout to 5 minutes for long AI report generation
export const maxDuration = 300

export async function POST(req: NextRequest) {
  try {
    const { portfolioId, reportType, dateFrom, dateTo } = await req.json() as {
      portfolioId: string
      reportType: ReportType
      dateFrom?: string
      dateTo?: string
    }
    if (!portfolioId || !reportType) {
      return NextResponse.json({ error: 'portfolioId and reportType are required' }, { status: 400 })
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured.' }, { status: 500 })
    }

    const db = supabaseAdmin()

    // ── Stage 1: portfolio + holdings + transactions + nav_log ────────────
    // v21n: transactions and nav_log are now fetched here and passed to
    // generateAIReport so the engine can compute proper cash-flow-adjusted
    // IRR and avoid displaying spurious raw HPR numbers to the AI.
    // Previously these were not fetched — navSummary and txSummary were
    // always empty strings and the performance block used raw HPR only.
    const [portRes, holdRes, txRes, navRes] = await Promise.all([
      db.from('portfolios').select('*, client:clients(name,code)').eq('id', portfolioId).single(),
      db.from('holdings').select('*, instrument:instruments(*)').eq('portfolio_id', portfolioId),
      db.from('transactions')
        .select('trade_date, action, instrument_id, quantity, price, amount, gross_value, fees')
        .eq('portfolio_id', portfolioId)
        .order('trade_date', { ascending: true }),
      db.from('nav_log')
        .select('nav_date, nav_value, notes')
        .eq('portfolio_id', portfolioId)
        .order('nav_date', { ascending: true }),
    ])

    if (!portRes.data) return NextResponse.json({ error: 'Portfolio not found' }, { status: 404 })

    const heldInstrumentIds = (holdRes.data ?? []).map((h: any) => h.instrument_id as string)

    // ── Stage 2: prices (filtered), sleeves, watchlist, FX in parallel ────
    const [sleeveRes, pricesRes, watchlistRes, fxRes] = await Promise.all([
      db.from('sleeve_targets')
        .select('*')
        .eq('portfolio_id', portfolioId)
        .order('sort_order'),
      heldInstrumentIds.length > 0
        ? db.from('market_prices')
            .select('instrument_id, price, day_change')
            .in('instrument_id', heldInstrumentIds)
            .order('price_date', { ascending: false })
        : Promise.resolve({ data: [] }),
      db.from('watchlist')
        .select('ticker, name, section, sub_type, rank, rationale')
        .eq('active', true)
        .order('rank'),
      fetch('https://api.exchangerate-api.com/v4/latest/USD')
        .then(r => r.json())
        .catch(() => null),
    ])

    const priceMap: Record<string, { price: number; day_change: number }> = {}
    pricesRes.data?.forEach((p: any) => {
      if (!priceMap[p.instrument_id]) {
        priceMap[p.instrument_id] = { price: p.price, day_change: p.day_change ?? 0 }
      }
    })

    const holdings = (holdRes.data || []).map((h: any) => ({
      ...h,
      latest_price: priceMap[h.instrument_id]?.price ?? h.avg_cost,
      day_change:   priceMap[h.instrument_id]?.day_change ?? 0,
    }))

    const report = await generateAIReport({
      portfolio:    portRes.data,
      holdings,
      sleeveDefs:   sleeveRes.data || [],
      reportType,
      dateFrom,
      dateTo,
      fxRate:       fxRes?.rates?.NGN,
      watchlist:    watchlistRes.data || [],
      transactions: txRes.data || [],      // v21n: now populated
      navHistory:   navRes.data || [],     // v21n: now populated
    })

    // Save to reports table
    await db.from('reports').insert({
      portfolio_id: portfolioId,
      report_type:  reportType,
      report_date:  (dateTo || new Date().toISOString().slice(0, 10)),
      content:      report,
    })

    return NextResponse.json({ report })
  } catch (err) {
    console.error('Report error:', err)
    return NextResponse.json({ error: (err as Error).message }, { status: 500 })
  }
}

export async function GET(req: NextRequest) {
  const portfolioId = req.nextUrl.searchParams.get('portfolioId')
  if (!portfolioId) return NextResponse.json({ error: 'portfolioId required' }, { status: 400 })
  const db = supabaseAdmin()
  const { data, error } = await db
    .from('reports')
    .select('id, report_type, report_date, created_at, content')
    .eq('portfolio_id', portfolioId)
    .order('created_at', { ascending: false })
    .limit(30)
  if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  return NextResponse.json({ reports: data })
}
