import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'

// v21z-hotfix-1: Parse pasted FMDQ quotations and map to our instrument IDs.
//
// Replaces the `web_search` approach from v21z (hit rate 3/72 because FMDQ's
// daily PDFs aren't indexed by Google). User pastes FMDQ's quotations table,
// Claude maps pasted rows to our instrument_id list, returns proposals.
//
// No web_search tool needed — the paste IS the data source. Cheaper, faster,
// and much higher hit rate because we're matching authoritative FMDQ data
// directly against our canonical tickers.

export const maxDuration = 120

const MAX_PASTE_CHARS = 50_000

export async function POST(req: Request) {
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  const supabaseUrl  = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey  = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!anthropicKey) return NextResponse.json({ error: 'ANTHROPIC_API_KEY missing' }, { status: 500 })
  if (!supabaseUrl || !supabaseKey) return NextResponse.json({ error: 'Supabase config missing' }, { status: 500 })

  // 1. Validate paste
  let body: any
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
  const paste = typeof body?.paste === 'string' ? body.paste.trim() : ''
  if (paste.length < 30) {
    return NextResponse.json({ error: 'Paste is empty or too short' }, { status: 400 })
  }
  if (paste.length > MAX_PASTE_CHARS) {
    return NextResponse.json({
      error: `Paste exceeds ${MAX_PASTE_CHARS.toLocaleString()} character limit (received ${paste.length.toLocaleString()}). Trim and try again.`,
    }, { status: 400 })
  }

  const db = createClient(supabaseUrl, supabaseKey)

  // 2. Load FI universe for mapping
  const { data: instruments, error: iErr } = await db
    .from('instruments')
    .select('instrument_id, name, coupon_pct, maturity_date, notes')
    .eq('sleeve_id', 'fi')
    .eq('approved', true)
    .limit(500)

  if (iErr) return NextResponse.json({ error: iErr.message }, { status: 500 })
  if (!instruments || instruments.length === 0) {
    return NextResponse.json({ error: 'No fixed income instruments in DB — run the seed SQL first' }, { status: 400 })
  }

  // 3. Build a compact mapping table for Claude
  const instrumentLines = instruments.map((i: any) => {
    const m = (i.notes || '').match(/^\[([^\]]+)\]/)
    const subType = m ? m[1] : 'Unknown'
    const coupon  = i.coupon_pct ? `${Number(i.coupon_pct).toFixed(4)}%` : 'n/a'
    const mat     = i.maturity_date || 'n/a'
    return `${i.instrument_id} | ${subType} | coupon ${coupon} | matures ${mat} | ${i.name}`
  }).join('\n')

  const todayIso = new Date().toISOString().slice(0, 10)

  const prompt = `You are parsing pasted Nigerian fixed income market data from FMDQ Securities Exchange (or a similar research source). Your task is to match each quoted yield to an instrument in our database and return a structured JSON response.

Today's date: ${todayIso}

Our instruments — ONLY match to these, using instrument_id exactly as shown on the left:

${instrumentLines}

The paste may be in any format — a markdown table, tab-separated columns, space-separated columns, text copied from a PDF (with weird line breaks), or text copied from an HTML table. Use your judgment to identify each row's key fields: a ticker or instrument name, a coupon rate, a maturity date, and a yield (yield-to-maturity, YTM, or effective yield).

Matching rules:
- Match on any of: FMDQ ticker (may differ from ours — use coupon+maturity as tiebreaker), bond name similarity, or coupon + maturity combination.
- FMDQ sometimes writes names as "FGN JAN 2035 22.60% S1" or "22.60% FGN JAN 2035"; both map to FG212035S1 in our DB.
- Commercial papers often appear as "DANGCEM CP May 2026 S1" or similar — match via issuer + maturity month/year.
- For state bonds (LAB, LASUK) and corporate bonds (UBN, FMN, DANGCEM, NOVA, LFZC, TSL, NSPGB, TAJ), match by issuer abbreviation + maturity.
- If you cannot CONFIDENTLY match a pasted row to an instrument in our list, SKIP it. Do not guess.
- If a coupon in the paste differs by more than 0.5pp from our coupon for a would-be match, SKIP it — that's a different series.

Yield extraction:
- Use the yield-to-maturity (YTM) or effective yield if available.
- For commercial papers, use the discount/effective yield.
- Clean price vs. dirty price is irrelevant — we want the YIELD, not the price.
- If the paste has multiple yield columns (bid / offer / mid), prefer mid, then bid.

Return ONLY a valid JSON object in exactly this format, with NO surrounding commentary, markdown fences, or explanation:

{
  "results": [
    {
      "instrument_id": "FG202031S1",
      "yield_pct": 18.75,
      "source": "FMDQ paste 23 Apr 2026",
      "as_of": "2026-04-23",
      "confidence": "high",
      "notes": "Clean price 99.20 from paste"
    }
  ]
}

Format rules:
- yield_pct is a number (e.g. 18.75 for 18.75%), NOT a string.
- as_of is YYYY-MM-DD format. If the paste mentions a report date or "as of" date, use that. Otherwise use today: ${todayIso}.
- source should include "FMDQ paste" + the date from the paste (or today).
- confidence: "high" if ticker/coupon/maturity all clearly match; "medium" if match is by name similarity; "low" if inferred.
- notes: optional brief extract from the paste row (e.g. "Clean 99.20, YTM 18.75").

Pasted data:
---
${paste}
---`

  // 4. Call Claude — no web_search needed
  const anthropic = new Anthropic({ apiKey: anthropicKey })

  let response
  try {
    response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }],
    })
  } catch (e: any) {
    return NextResponse.json({ error: `Anthropic call failed: ${e?.message || e}` }, { status: 500 })
  }

  // 5. Extract JSON from response
  const textBlocks = (response.content ?? [])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => (b.text ?? '').trim())
    .filter((t: string) => t.length > 0)

  const joined = textBlocks.join('\n').trim()
  const firstBrace = joined.indexOf('{')
  const lastBrace  = joined.lastIndexOf('}')

  if (firstBrace < 0 || lastBrace < 0 || lastBrace <= firstBrace) {
    return NextResponse.json({
      error: 'AI response did not contain a JSON object',
      raw: joined.slice(0, 1000),
    }, { status: 502 })
  }

  const jsonSlice = joined.slice(firstBrace, lastBrace + 1)

  let parsed: any
  try {
    parsed = JSON.parse(jsonSlice)
  } catch (e: any) {
    return NextResponse.json({
      error: `JSON parse failed: ${e?.message}`,
      raw: jsonSlice.slice(0, 1000),
    }, { status: 502 })
  }

  if (!parsed || !Array.isArray(parsed.results)) {
    return NextResponse.json({
      error: 'AI response missing results array',
      raw: jsonSlice.slice(0, 1000),
    }, { status: 502 })
  }

  // 6. Validate + dedupe
  const validIds = new Set(instruments.map((i: any) => i.instrument_id))
  const seen = new Set<string>()

  const results = parsed.results
    .filter((r: any) =>
      r &&
      typeof r.instrument_id === 'string' &&
      typeof r.yield_pct === 'number' &&
      isFinite(r.yield_pct) &&
      r.yield_pct > 0 &&
      r.yield_pct < 100 &&
      typeof r.as_of === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(r.as_of) &&
      validIds.has(r.instrument_id) &&
      !seen.has(r.instrument_id) &&
      (seen.add(r.instrument_id), true)
    )
    .map((r: any) => ({
      instrument_id: r.instrument_id,
      yield_pct: r.yield_pct,
      source: typeof r.source === 'string' && r.source.length > 0 ? r.source : `FMDQ paste ${todayIso}`,
      as_of: r.as_of,
      confidence: (r.confidence === 'high' || r.confidence === 'medium' || r.confidence === 'low') ? r.confidence : 'high',
      notes: typeof r.notes === 'string' ? r.notes : null,
    }))

  return NextResponse.json({
    results,
    total_instruments: instruments.length,
    proposed: results.length,
  })
}
