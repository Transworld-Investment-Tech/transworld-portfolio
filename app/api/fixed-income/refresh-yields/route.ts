import { NextResponse } from 'next/server'
import Anthropic from '@anthropic-ai/sdk'
import { createClient } from '@supabase/supabase-js'

// v21z: AI-proposed yield refresh for the fixed income universe.
//
// Flow:
//   1. Load all approved FI instruments (sleeve_id='fi')
//   2. Prompt Claude with their tickers/names/coupons/maturities
//   3. Claude uses web_search to find current yields from FMDQ / DMO /
//      Nigerian broker commentary
//   4. Return proposed yields as JSON for user review in the UI
//
// Nothing writes to the DB — the admin page collects accepts and writes
// via the anon Supabase client (same pattern as scenario save).

export const maxDuration = 300

export async function POST() {
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  const supabaseUrl  = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey  = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!anthropicKey) return NextResponse.json({ error: 'ANTHROPIC_API_KEY missing' }, { status: 500 })
  if (!supabaseUrl || !supabaseKey) return NextResponse.json({ error: 'Supabase config missing' }, { status: 500 })

  const db = createClient(supabaseUrl, supabaseKey)

  // 1. Load FI universe
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

  // 2. Build the listing for the prompt. Parse the [SubType] prefix from notes
  //    so Claude knows issuer type and can target sources accordingly.
  const lines = instruments.map((i: any) => {
    const m = (i.notes || '').match(/^\[([^\]]+)\]/)
    const subType = m ? m[1] : 'Unknown'
    const coupon  = i.coupon_pct ? `${Number(i.coupon_pct).toFixed(2)}%` : 'n/a'
    const mat     = i.maturity_date || 'n/a'
    return `- ${i.instrument_id} | ${i.name} | ${subType} | coupon ${coupon} | maturity ${mat}`
  }).join('\n')

  const todayIso = new Date().toISOString().slice(0, 10)

  const prompt = `You are a Nigerian fixed income market data specialist. Your task is to find current yield-to-maturity (YTM) data for the fixed income instruments listed below, and return the results as a strictly-formatted JSON object.

Today's date: ${todayIso}

Authoritative sources to search, in order of preference:
1. FMDQ Securities Exchange daily quotations list (https://www.fmdqgroup.com/markets/fixed-income/quotations/)
2. Debt Management Office of Nigeria bond auction results (https://www.dmo.gov.ng/)
3. Nigerian investment bank research notes (Meristem, Vetiva, Cordros, United Capital, CSL Stockbrokers)
4. Nigerian financial news reporting recent yield quotes (Businessday, Proshare, Nairametrics)

Instruments to research:

${lines}

Approach:
- For each Federal Government bond (FGN, FGNSB, FGS, Federal Sukuk), find the most recent FMDQ daily quotation or DMO auction result.
- For state bonds (LAB = Lagos, LASUK = Lagos sukuk, etc.), search for recent secondary market quotes or issuance data.
- For corporate bonds (UBN, NOVA, DANGCEM, FMN, LFZC, TSL, NSPGB), search for FMDQ quotations or primary market data.
- For commercial paper (CP26DCPS01, CP26DCPS02 — Dangote Cement), search for the discount rate or effective yield at issuance.
- For sukuk (TAJ, FGSUK, FHSUK, LASUK), search for recent quotes or indicative yields.

Rules:
- Only include an instrument if you find a credible yield dated within the last 30 days.
- Do NOT guess or interpolate yields for instruments where no source data is available — omit them entirely.
- Yield values MUST be numbers (e.g. 18.75 for 18.75%), NOT strings.
- Date values MUST be in YYYY-MM-DD format.
- Confidence: "high" = direct FMDQ or DMO quote, "medium" = secondary source / broker note, "low" = inferred from related instrument on the curve.

Return ONLY a valid JSON object in exactly this format, with NO surrounding commentary, preamble, or markdown fences:

{
  "results": [
    {
      "instrument_id": "FG202031S1",
      "yield_pct": 18.75,
      "source": "FMDQ daily quotations 22 Apr 2026",
      "as_of": "2026-04-22",
      "confidence": "high",
      "notes": "Clean price ₦99.20, YTM 18.75%"
    }
  ]
}`

  // 3. Call Claude with web_search
  const anthropic = new Anthropic({ apiKey: anthropicKey })

  let response
  try {
    response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 8000,
      messages: [{ role: 'user', content: prompt }],
      tools: [{ type: 'web_search_20250305', name: 'web_search' } as any],
    })
  } catch (e: any) {
    return NextResponse.json({ error: `Anthropic call failed: ${e?.message || e}` }, { status: 500 })
  }

  // 4. Extract text blocks. No shape-aware join needed here — the answer is
  //    a JSON object, not prose. We just concatenate text blocks and pull
  //    out the first {...} span.
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

  // 5. Validate the results array
  if (!parsed || !Array.isArray(parsed.results)) {
    return NextResponse.json({
      error: 'AI response missing results array',
      raw: jsonSlice.slice(0, 1000),
    }, { status: 502 })
  }

  const validIds = new Set(instruments.map((i: any) => i.instrument_id))

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
      validIds.has(r.instrument_id)
    )
    .map((r: any) => ({
      instrument_id: r.instrument_id,
      yield_pct: r.yield_pct,
      source: typeof r.source === 'string' ? r.source : 'AI',
      as_of: r.as_of,
      confidence: (r.confidence === 'high' || r.confidence === 'medium' || r.confidence === 'low') ? r.confidence : 'medium',
      notes: typeof r.notes === 'string' ? r.notes : null,
    }))

  return NextResponse.json({
    results,
    total_instruments: instruments.length,
    proposed: results.length,
  })
}
