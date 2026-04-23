/**
 * app/api/watchlist/insight/route.ts — v21g-2
 *
 * POST /api/watchlist/insight
 *
 * Server-side proxy for the per-watchlist-item AI market intelligence
 * panel. Replaces the broken browser-direct call to api.anthropic.com
 * which could never have worked in production (no API key in client
 * code, no CORS allowlist).
 *
 * Request body:
 *   { name, ticker, section, sub_type, rationale }
 *
 * Response:
 *   { ok: true, text }    — on success
 *   { ok: false, error }  — on failure
 *
 * Uses the web_search_20250305 tool so insights include current
 * market context (NGX prices, recent news) rather than only
 * training-cutoff knowledge. The original prompt even asked the
 * model to acknowledge stale data — web_search fixes the root of
 * that awkwardness.
 *
 * Scaled max_tokens for a 3-4 sentence answer plus tool use
 * overhead. maxDuration 60s because web_search doubles or triples
 * end-to-end latency vs a plain completion.
 *
 * Per pitfall #32: Anthropic responses with tools return mixed
 * content blocks — we filter to type === 'text' only.
 */

import { NextRequest, NextResponse } from 'next/server'

export const runtime = 'nodejs'
export const maxDuration = 60
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY
    if (!apiKey) {
      return NextResponse.json(
        { ok: false, error: 'ANTHROPIC_API_KEY not configured on server' },
        { status: 500 }
      )
    }

    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { ok: false, error: 'Request body must be JSON' },
        { status: 400 }
      )
    }

    const {
      name,
      ticker,
      section,
      sub_type,
      rationale,
    } = body as {
      name?: string
      ticker?: string
      section?: string
      sub_type?: string
      rationale?: string
    }

    if (!name || typeof name !== 'string') {
      return NextResponse.json(
        { ok: false, error: '"name" is required' },
        { status: 400 }
      )
    }

    // Build the same prompt as the old client-side call, unchanged
    // modulo whitespace. "Acknowledge if data is from training
    // knowledge" reminder dropped — web_search gives us current
    // information.
    const prompt = `You are a Nigerian capital markets analyst at Transworld Asset Management, Lagos.
Provide a brief, current market intelligence note for this security:

Name: ${name}
Ticker: ${ticker || 'N/A'}
Type: ${section || 'N/A'}${sub_type ? ' — ' + sub_type : ''}
Watchlist rationale: ${rationale || 'N/A'}

Use the web_search tool to find CURRENT information. Then write 3-4 sentences covering:
1. Current market context / recent developments (cite dates where possible)
2. Key metrics or yield (P/E, dividend yield, or bond yield as applicable)
3. Key risk or opportunity to watch right now
4. One specific catalyst or event to monitor

Be specific and factual. Write in plain text, no markdown headers.`

    const anthropicRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1500,
        tools: [
          {
            type: 'web_search_20250305',
            name: 'web_search',
          },
        ],
        messages: [
          {
            role: 'user',
            content: prompt,
          },
        ],
      }),
    })

    if (!anthropicRes.ok) {
      const errText = await anthropicRes.text().catch(() => '')
      return NextResponse.json(
        {
          ok: false,
          error: `Anthropic API returned ${anthropicRes.status}`,
          detail: errText.slice(0, 500),
        },
        { status: 502 }
      )
    }

    const data = await anthropicRes.json()

    // Per pitfall #32: filter to type === 'text' blocks only.
    // Tool-use responses also include server_tool_use and
    // web_search_tool_result blocks that we don't want to render.
    const text = (data.content || [])
      .filter((b: any) => b && b.type === 'text')
      .map((b: any) => (typeof b.text === 'string' ? b.text : ''))
      .join('')
      .trim()

    if (!text) {
      return NextResponse.json(
        {
          ok: false,
          error: 'Anthropic response contained no text blocks',
          stop_reason: data.stop_reason ?? null,
        },
        { status: 502 }
      )
    }

    return NextResponse.json({ ok: true, text })
  } catch (err: any) {
    return NextResponse.json(
      { ok: false, error: err?.message || 'unknown server error' },
      { status: 500 }
    )
  }
}
