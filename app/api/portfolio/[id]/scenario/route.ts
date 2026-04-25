import { NextRequest } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { supabaseAdmin } from '@/lib/supabase'
import { buildScenarioPrompt, type ScenarioInput } from '@/lib/scenario-engine'
import { fetchFIUniverse } from '@/lib/fi-context'

// v21y: Portfolio Scenario Analysis — streaming POST endpoint.
// v23: FI universe injected via fetchFIUniverse (pulled alongside other
//      context in the initial Promise.all).
//
// Request body: { scenario: string }
// Response: NDJSON stream of { t: 'delta', x: '...' } messages during
//           generation, then a single { t: 'final', x: '<cleaned markdown>' }
//           at completion. Client accumulates deltas for live rendering and
//           replaces accumulated content with `final` when it arrives.
//
// Why the two-phase pattern: web_search splits prose across multiple adjacent
// text blocks (pitfall #68). We stream raw deltas for responsiveness, then
// send a shape-aware-joined final for correct formatting. Client experience:
// text streams naturally, then cleans up into final form when done.
//
// Saving the result to the reports table is handled client-side via the
// Supabase anon client, not here. This route is pure generation.

export const maxDuration = 300

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id: portfolioId } = await ctx.params
  const body = await req.json().catch(() => ({})) as { scenario?: string }
  const scenario = (body.scenario ?? '').trim()

  if (!scenario) {
    return new Response(JSON.stringify({ error: 'scenario is required' }), { status: 400 })
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }), { status: 500 })
  }

  const db = supabaseAdmin()

  // v23: fiUniverse added to parallel fetch
  const [portRes, holdRes, sleeveRes, watchRes, fiUniverse, fxRes] = await Promise.all([
    db.from('portfolios').select('*, client:clients(name,code,type)').eq('id', portfolioId).single(),
    db.from('holdings').select('*, instrument:instruments(*)').eq('portfolio_id', portfolioId),
    db.from('sleeve_targets').select('*').eq('portfolio_id', portfolioId).order('sort_order'),
    db.from('watchlist').select('ticker, name, section, sub_type, rank, rationale').eq('active', true).order('rank'),
    fetchFIUniverse(db),
    fetch('https://api.exchangerate-api.com/v4/latest/USD').then(r => r.json()).catch(() => null),
  ])

  if (!portRes.data) {
    return new Response(JSON.stringify({ error: 'Portfolio not found' }), { status: 404 })
  }

  const heldIds = (holdRes.data ?? []).map((h: any) => h.instrument_id as string)
  const { data: prices } = heldIds.length > 0
    ? await db.from('market_prices').select('instrument_id, price').in('instrument_id', heldIds).order('price_date', { ascending: false })
    : { data: [] as any[] }

  const priceMap: Record<string, number> = {}
  ;(prices ?? []).forEach((p: any) => {
    if (priceMap[p.instrument_id] === undefined) priceMap[p.instrument_id] = Number(p.price)
  })

  const currentNAV = (holdRes.data ?? []).reduce((s: number, h: any) => {
    const p = priceMap[h.instrument_id] ?? Number(h.avg_cost)
    return s + Number(h.quantity) * p
  }, 0)

  const holdings = (holdRes.data ?? []).map((h: any) => {
    const p  = priceMap[h.instrument_id] ?? Number(h.avg_cost)
    const mv = Number(h.quantity) * p
    return {
      instrument_id: h.instrument_id,
      name:          h.instrument?.name ?? h.instrument_id,
      type:          h.instrument?.type ?? 'Stock',
      sector:        h.instrument?.sector ?? null,
      quantity:      Number(h.quantity),
      avg_cost:      Number(h.avg_cost),
      latest_price:  p,
      market_value:  mv,
      weight:        currentNAV > 0 ? mv / currentNAV : 0,
    }
  })

  const sleeves = (sleeveRes.data ?? []).map((s: any) => {
    const val = holdings
      .filter(h => {
        if (s.sleeve_id === 'eq')  return h.type === 'Stock'
        if (s.sleeve_id === 'liq') return h.type === 'Cash'
        if (s.sleeve_id === 'fi')  return h.type === 'Bond' || h.type === 'ETF'
        return false
      })
      .reduce((sum, h) => sum + h.market_value, 0)
    const actual = currentNAV > 0 ? val / currentNAV : 0
    const status = actual < Number(s.min_pct) ? 'UNDER' : actual > Number(s.max_pct) ? 'OVER' : 'OK'
    return {
      sleeve_id:  s.sleeve_id,
      name:       s.name,
      target_pct: Number(s.target_pct),
      actual_pct: actual,
      min_pct:    Number(s.min_pct),
      max_pct:    Number(s.max_pct),
      value:      val,
      status,
    }
  })

  const port = portRes.data as any
  const input: ScenarioInput = {
    portfolio: {
      id:            port.id,
      name:          port.name,
      label:         port.label,
      clientName:    port.client?.name ?? 'Unknown',
      clientCode:    port.client?.code ?? '',
      currency:      port.currency,
      starting_nav:  Number(port.starting_nav ?? 0),
      start_date:    port.start_date,
      current_nav:   currentNAV,
      income_target: Number(port.income_target ?? 0),
      max_eq_single: port.max_eq_single != null ? Number(port.max_eq_single) : null,
      max_eq_sleeve: port.max_eq_sleeve != null ? Number(port.max_eq_sleeve) : null,
      liq_min:       port.liq_min       != null ? Number(port.liq_min)       : null,
      cap_target:    port.cap_target    != null ? Number(port.cap_target)    : null,
    },
    holdings,
    sleeves,
    watchlist:  watchRes.data ?? [],
    fiUniverse,                                  // v23
    fxRate:     fxRes?.rates?.NGN ?? null,
    scenario,
  }

  const prompt = buildScenarioPrompt(input)
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

  const encoder = new TextEncoder()
  const readable = new ReadableStream({
    async start(controller) {
      const blocksByIndex: Record<number, string> = {}
      const emit = (obj: any) => {
        controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'))
      }

      try {
        const stream = await (client.messages.stream as any)({
          model:      'claude-sonnet-4-20250514',
          max_tokens: 3500,
          tools:      [{ type: 'web_search_20250305', name: 'web_search' }],
          messages:   [{ role: 'user', content: prompt }],
        })

        for await (const event of stream as any) {
          if (event.type === 'content_block_start' && event.content_block?.type === 'text') {
            blocksByIndex[event.index] = ''
          } else if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            if (blocksByIndex[event.index] !== undefined) {
              blocksByIndex[event.index] += event.delta.text
              emit({ t: 'delta', x: event.delta.text })
            }
          }
        }

        // Shape-aware join of accumulated blocks (pitfalls #68, #69).
        // Copied directly from lib/cio-brief-engine.ts:generateCIOBrief.
        const blocks = Object.keys(blocksByIndex)
          .sort((a, b) => Number(a) - Number(b))
          .map(k => blocksByIndex[Number(k)].trim())
          .filter(s => s.length > 0)

        let all = blocks[0] ?? ''
        for (let i = 1; i < blocks.length; i++) {
          const next      = blocks[i]
          const firstChar = next[0] || ''
          const lastLine  = all.split('\n').pop() || ''
          const endsHead  = /^#{2,4}\s/.test(lastLine)

          if (/^(#{2,4}\s|---|\||-\s|\u2022\s|>\s)/.test(next)) {
            all = all + '\n\n' + next
          } else if (endsHead) {
            all = all + '\n\n' + next
          } else if (/[.,;:!?)\]"'\u2019\u201d]/.test(firstChar)) {
            all = all + next
          } else {
            all = all + ' ' + next
          }
        }
        all = all.trim()

        const startsH2 = all.startsWith('## ')
        const firstH2  = all.indexOf('\n## ')
        const finalContent = startsH2 ? all : firstH2 >= 0 ? all.slice(firstH2 + 1) : all

        emit({ t: 'final', x: finalContent })
        controller.close()
      } catch (err) {
        emit({ t: 'error', x: (err as Error).message || 'scenario generation failed' })
        controller.close()
      }
    },
  })

  return new Response(readable, {
    headers: {
      'Content-Type':          'application/x-ndjson; charset=utf-8',
      'Cache-Control':         'no-cache, no-transform',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
