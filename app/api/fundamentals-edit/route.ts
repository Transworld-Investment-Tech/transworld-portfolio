// v27cb-a-fix5 — Fundamentals editor API
//
// Adds vs v27cb-a-fix3:
//   • Per-period shares_outstanding I/O (read + write fundamentals_history)
//   • derived_ratios now includes computed book_value_per_share (uses per-period
//     shares with fallback to instruments.shares_outstanding for null periods)
//   • New POST action 'update-shares-current': updates instruments.shares_outstanding
//     (current shares, used by per-instrument page for market cap)
//   • Auto-sync: when operator saves a period with shares_outstanding set, if that
//     period is the MOST RECENT (latest period_end), also update instruments.shares_outstanding
//   • Re-extract reads shares_outstanding from Claude output (may be null if filing
//     doesn't disclose; operator can manually type after)
//
// New fields in derived_ratios payload:
//   - book_value_per_share: number | null
//   - bvps_basis: 'per_period_shares' | 'current_shares_fallback' | 'no_shares' | 'no_equity'

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import {
  fetchFinancialFilings,
  extractPeriodMetadata,
  type XFinancialNewsItem,
} from '@/lib/ngx-odata'
import {
  downloadPdfAsBuffer,
  extractPdfLines,
  findFinancialStatementSection,
} from '@/lib/pdf-extractor'

export const dynamic = 'force-dynamic'
export const maxDuration = 300
export const runtime = 'nodejs'

const CLAUDE_MODEL = 'claude-sonnet-4-20250514'
const CLAUDE_MAX_TOKENS = 2000

// ─── Types ─────────────────────────────────────────────────────────

interface FundamentalsRow {
  id?:                          string
  instrument_id:                string
  period_end:                   string
  period_type:                  'annual' | 'quarterly'
  pdf_source_url?:              string | null
  pdf_filename?:                string | null
  revenue_ngn_m?:               number | null
  gross_profit_ngn_m?:          number | null
  operating_profit_ngn_m?:      number | null
  profit_before_tax_ngn_m?:     number | null
  profit_after_tax_ngn_m?:      number | null
  eps_basic?:                   number | null
  eps_diluted?:                 number | null
  book_value_per_share?:        number | null
  total_assets_ngn_m?:          number | null
  total_equity_ngn_m?:          number | null
  total_debt_ngn_m?:            number | null
  cash_and_equivalents_ngn_m?:  number | null
  cash_from_operations_ngn_m?:  number | null
  shares_outstanding?:          number | null
  currency?:                    string | null
  source?:                      string | null
  extraction_notes?:            string | null
  verified_status?:             'unverified' | 'verified' | 'flagged'
  verified_at?:                 string | null
  verified_by?:                 string | null
  operator_notes?:              string | null
}

interface DerivedRatios {
  roe_pct:              number | null
  roa_pct:              number | null
  net_margin_pct:       number | null
  cash_conversion_pct:  number | null
  book_value_per_share: number | null
  bvps_basis:           'per_period_shares' | 'current_shares_fallback' | 'no_shares' | 'no_equity'
}

function deriveRatios(row: FundamentalsRow, currentShares: number | null): DerivedRatios {
  const pat = row.profit_after_tax_ngn_m ?? null
  const eq = row.total_equity_ngn_m ?? null
  const assets = row.total_assets_ngn_m ?? null
  const rev = row.revenue_ngn_m ?? null
  const cfo = row.cash_from_operations_ngn_m ?? null
  const periodShares = row.shares_outstanding ?? null

  // BVPS: total_equity_ngn_m × 1,000,000 ÷ shares_outstanding
  // Per-period shares preferred; fallback to current instrument shares
  let bvps: number | null = null
  let basis: DerivedRatios['bvps_basis'] = 'no_equity'
  if (eq === null || eq <= 0) {
    basis = 'no_equity'
  } else if (periodShares !== null && periodShares > 0) {
    bvps = (eq * 1_000_000) / periodShares
    basis = 'per_period_shares'
  } else if (currentShares !== null && currentShares > 0) {
    bvps = (eq * 1_000_000) / currentShares
    basis = 'current_shares_fallback'
  } else {
    basis = 'no_shares'
  }

  return {
    roe_pct: pat !== null && eq !== null && eq > 0 ? (pat / eq) * 100 : null,
    roa_pct: pat !== null && assets !== null && assets > 0 ? (pat / assets) * 100 : null,
    net_margin_pct: pat !== null && rev !== null && rev > 0 ? (pat / rev) * 100 : null,
    cash_conversion_pct: pat !== null && pat !== 0 && cfo !== null ? (cfo / pat) * 100 : null,
    book_value_per_share: bvps,
    bvps_basis: basis,
  }
}

// ─── GET: list all periods for a ticker ────────────────────────────

async function handleList(ticker: string): Promise<unknown> {
  const db = supabaseAdmin()
  const { data: inst } = await db
    .from('instruments')
    .select('instrument_id, name, sector, isin, type, approved, shares_outstanding, shares_outstanding_last_refreshed_at')
    .eq('instrument_id', ticker)
    .maybeSingle()
  if (!inst) {
    return { ok: false, error: `instrument '${ticker}' not found` }
  }
  const currentShares = (inst.shares_outstanding ?? null) as number | null
  const { data: periods, error: pErr } = await db
    .from('fundamentals_history')
    .select('*')
    .eq('instrument_id', ticker)
    .order('period_end', { ascending: false })
  if (pErr) {
    return { ok: false, error: `fundamentals_history SELECT failed: ${pErr.message}` }
  }
  const enriched = (periods ?? []).map((row) => ({
    ...row,
    derived_ratios: deriveRatios(row as FundamentalsRow, currentShares),
  }))
  return {
    ok: true,
    instrument: inst,
    periods: enriched,
    period_count: enriched.length,
  }
}

// ─── POST (default): upsert one period with operator edits ─────────

function coerceNumOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'string' ? parseFloat(v.replace(/,/g, '')) : Number(v)
  if (!isFinite(n)) return null
  return n
}

async function handleUpsert(ticker: string, body: FundamentalsRow): Promise<unknown> {
  const db = supabaseAdmin()
  if (!body.period_end || !body.period_type) {
    return { ok: false, error: 'period_end and period_type are required' }
  }
  const row = {
    instrument_id: ticker,
    period_end: body.period_end,
    period_type: body.period_type,
    pdf_source_url: body.pdf_source_url ?? null,
    pdf_filename: body.pdf_filename ?? null,
    revenue_ngn_m: coerceNumOrNull(body.revenue_ngn_m),
    gross_profit_ngn_m: coerceNumOrNull(body.gross_profit_ngn_m),
    operating_profit_ngn_m: coerceNumOrNull(body.operating_profit_ngn_m),
    profit_before_tax_ngn_m: coerceNumOrNull(body.profit_before_tax_ngn_m),
    profit_after_tax_ngn_m: coerceNumOrNull(body.profit_after_tax_ngn_m),
    eps_basic: coerceNumOrNull(body.eps_basic),
    eps_diluted: coerceNumOrNull(body.eps_diluted),
    book_value_per_share: coerceNumOrNull(body.book_value_per_share),
    total_assets_ngn_m: coerceNumOrNull(body.total_assets_ngn_m),
    total_equity_ngn_m: coerceNumOrNull(body.total_equity_ngn_m),
    total_debt_ngn_m: coerceNumOrNull(body.total_debt_ngn_m),
    cash_and_equivalents_ngn_m: coerceNumOrNull(body.cash_and_equivalents_ngn_m),
    cash_from_operations_ngn_m: coerceNumOrNull(body.cash_from_operations_ngn_m),
    shares_outstanding: coerceNumOrNull(body.shares_outstanding),
    currency: body.currency ?? 'NGN',
    extraction_notes: body.extraction_notes ?? null,
    verified_status: body.verified_status ?? 'unverified',
    verified_at:
      body.verified_status === 'verified' ? new Date().toISOString() : (body.verified_at ?? null),
    verified_by: body.verified_status === 'verified' ? (body.verified_by ?? 'operator') : (body.verified_by ?? null),
    operator_notes: body.operator_notes ?? null,
  }
  const { data, error } = await db
    .from('fundamentals_history')
    .upsert(row, { onConflict: 'instrument_id,period_end,period_type' })
    .select()
    .maybeSingle()
  if (error) {
    return { ok: false, error: `upsert failed: ${error.message}` }
  }

  // Auto-sync: if THIS period is the most recent for the ticker AND has a shares_outstanding,
  // sync it to instruments.shares_outstanding (operator can override later via update-shares-current).
  let auto_synced_current_shares = false
  if (row.shares_outstanding !== null && row.shares_outstanding > 0) {
    const { data: latest } = await db
      .from('fundamentals_history')
      .select('period_end')
      .eq('instrument_id', ticker)
      .order('period_end', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (latest && latest.period_end === body.period_end) {
      const { error: instErr } = await db
        .from('instruments')
        .update({
          shares_outstanding: row.shares_outstanding,
          shares_outstanding_last_refreshed_at: new Date().toISOString(),
        })
        .eq('instrument_id', ticker)
      if (!instErr) auto_synced_current_shares = true
    }
  }

  // Re-fetch current shares for derive
  const { data: inst2 } = await db
    .from('instruments')
    .select('shares_outstanding')
    .eq('instrument_id', ticker)
    .maybeSingle()
  const currentShares = (inst2?.shares_outstanding ?? null) as number | null

  return {
    ok: true,
    row: data,
    derived_ratios: deriveRatios(row as FundamentalsRow, currentShares),
    auto_synced_current_shares,
  }
}

// ─── POST (action=update-shares-current): manual override ──────────

async function handleUpdateSharesCurrent(ticker: string, body: { shares_outstanding: number | null }): Promise<unknown> {
  const db = supabaseAdmin()
  const shares = coerceNumOrNull(body.shares_outstanding)
  if (shares === null || shares <= 0) {
    return { ok: false, error: 'shares_outstanding must be a positive number' }
  }
  const { error } = await db
    .from('instruments')
    .update({
      shares_outstanding: shares,
      shares_outstanding_last_refreshed_at: new Date().toISOString(),
    })
    .eq('instrument_id', ticker)
  if (error) return { ok: false, error: `instruments UPDATE failed: ${error.message}` }
  return { ok: true, shares_outstanding: shares }
}

// ─── POST (action=re-extract) ──────────────────────────────────────

interface ExtractionResult {
  revenue_ngn_m: number | null
  gross_profit_ngn_m: number | null
  operating_profit_ngn_m: number | null
  profit_before_tax_ngn_m: number | null
  profit_after_tax_ngn_m: number | null
  eps_basic: number | null
  eps_diluted: number | null
  book_value_per_share: number | null
  total_assets_ngn_m: number | null
  total_equity_ngn_m: number | null
  total_debt_ngn_m: number | null
  cash_and_equivalents_ngn_m: number | null
  cash_from_operations_ngn_m: number | null
  shares_outstanding: number | null
  currency: string
  extraction_notes: string | null
}

function buildExtractionPrompt(
  ticker: string,
  companyName: string | null,
  sector: string | null,
  pdfFilename: string,
  periodEnd: string,
  periodType: 'annual' | 'quarterly',
  textBlock: string,
): string {
  const sectorContext = sector ? `\nSector context: ${sector}` : ''
  return `You are a financial-statement extractor for Nigerian-listed equities. Extract fields from the financial statements text and return STRICT JSON. No prose, no markdown fences, no preamble.

Company: ${ticker}${companyName ? ` (${companyName})` : ''}${sectorContext}
Filing: ${pdfFilename}
Period end: ${periodEnd} (${periodType})

CRITICAL RULES:
1. **UNIT CONVERSION** (v27cb-a-fix7d — read FIRST, before extracting ANY number): Statements declare their reporting unit at column-header level. Convert raw numbers to MILLIONS OF NAIRA (ngn_m):
   • "In thousands of Naira" / "N'000" / "₦'000"  →  raw ÷ 1,000
   • "In millions of Naira" / "N'million" / "₦'M"  →  raw (as-is)
   • "In billions of Naira" / "N'B"               →  raw × 1,000
   ALWAYS locate the unit declaration BEFORE extracting numbers.

   **SANITY CHECK**: Largest Nigerian listed companies (MTN, Dangote, GTCO, ACCESSCORP, Zenith) have annual profit_after_tax_ngn_m between 100,000 and 2,000,000. If your extracted PAT is >10,000,000, you almost certainly have a unit conversion error — re-check the unit declaration before reporting any number.
2. **Commas in numbers are ALWAYS thousands separators**. Nigerian financial reports never use European decimal notation. The number "4,878,176" means four million eight hundred seventy-eight thousand one hundred seventy-six (i.e. 4878176), NEVER 4878.176. If a line item says "4,878,176" in a column labeled "In millions of Naira", the value is 4878176 (i.e. ₦4.878 trillion).
3. EPS fields (eps_basic, eps_diluted) are in ACTUAL NAIRA per share. Nigerian banks/insurers typically report EPS in KOBO — if the statement says "Earnings per share (kobo)" or "(k)" or "kobo", DIVIDE BY 100 before reporting.
4. book_value_per_share is in actual naira per share.
4b. **total_debt_ngn_m** (v27cb-a-fix7d): INTEREST-BEARING DEBT ONLY. Sector-specific labels:
   • BANKS: sum "Debt securities issued" + "Subordinated liabilities/debt" + "Borrowings" (when reported separately from deposits). DO NOT include "Deposits from customers" / "Deposits from banks" / current accounts — those are funding, not debt.
   • INSURERS: "Borrowings" + "Subordinated debt" (if any). DO NOT include insurance contract liabilities.
   • TELECOM / INDUSTRIAL / CONSUMER / OIL & GAS / CEMENT: sum "Borrowings - current" + "Borrowings - non-current" + lease liabilities (current + non-current, under IFRS 16). DO NOT include trade payables, accrued expenses, or other operating liabilities.
   Alternate label variants: "Interest-bearing borrowings", "Loans and borrowings", "Long-term debt", "Short-term debt", "Lease liabilities", "Debt issued", "Bonds payable". Use Group/consolidated column.
5. cash_and_equivalents_ngn_m: BALANCE SHEET line item. Common labels: "Cash and cash equivalents", "Cash and balances with banks" (banks), "Cash and short-term funds", "Cash and bank balances", "Cash at bank and in hand". Use the top-of-balance-sheet asset line, NOT the cash-flow-statement reconciliation total at year-end. Millions of naira.
6. cash_from_operations_ngn_m: subtotal from the STATEMENT OF CASH FLOWS in the operating activities section. Common labels: "Net cash from operating activities", "Net cash generated from operating activities", "Net cash provided by operating activities", "Net cash (used in) operating activities", "Cash generated from/used in operations" — whichever variant the filing uses. It is the LAST line of the operating-activities section before the "Cash flows from investing activities" heading begins. Millions of naira. Negative numbers (in parentheses) allowed.
6b. Both cash fields: do NOT confuse "Cash and cash equivalents at end of year" (a reconciliation total at the bottom of the cash flow statement) with "Cash and cash equivalents" on the balance sheet. The balance sheet line is what we want for cash_and_equivalents_ngn_m.
6c. shares_outstanding: number of ordinary shares in issue AT PERIOD END. Common labels: "Number of ordinary shares in issue", "Issued share capital (number of ordinary shares)", "Weighted average number of ordinary shares" (for EPS calculation purposes), "Ordinary shares of N0.50 each" with a share count alongside. Report as ACTUAL share count (e.g. 54375796458 for 54.38B shares, NOT in millions). If the filing reports shares in millions, multiply by 1,000,000 before reporting. Return null if NOT disclosed in the filing.
7. Return null for ANY field NOT REPORTED. Do NOT estimate, infer, fabricate, or compute from other fields.
8. For BANKS, INSURERS, ASSET MANAGERS: gross_profit_ngn_m should be null. revenue_ngn_m = Gross Earnings (interest income + non-interest income).
9. For CONSUMER, INDUSTRIAL, OIL & GAS, CEMENT: conventional revenue → gross profit → operating profit → PBT → PAT.
10. If the statement shows BOTH Group and Company columns, use the GROUP (consolidated) column.
11. Numbers in parentheses are negative.
12. Output ONLY the JSON object.

Required JSON schema:
{
  "revenue_ngn_m": number|null,
  "gross_profit_ngn_m": number|null,
  "operating_profit_ngn_m": number|null,
  "profit_before_tax_ngn_m": number|null,
  "profit_after_tax_ngn_m": number|null,
  "eps_basic": number|null,
  "eps_diluted": number|null,
  "book_value_per_share": number|null,
  "total_assets_ngn_m": number|null,
  "total_equity_ngn_m": number|null,
  "total_debt_ngn_m": number|null,
  "cash_and_equivalents_ngn_m": number|null,
  "cash_from_operations_ngn_m": number|null,
  "shares_outstanding": number|null,
  "currency": "NGN",
  "extraction_notes": "1-2 sentences flagging oddities or conversions"
}

Financial statements text:
═══════════════════════════════════════════════════════════════════
${textBlock}
═══════════════════════════════════════════════════════════════════

Return ONLY the JSON object.`
}

async function callClaude(prompt: string, key: string): Promise<{ extraction: ExtractionResult | null; error: string | null }> {
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 60_000)
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: CLAUDE_MAX_TOKENS,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    })
    clearTimeout(timeoutId)
    if (!res.ok) {
      const txt = await res.text()
      return { extraction: null, error: `Claude ${res.status}: ${txt.slice(0, 300)}` }
    }
    const json = (await res.json()) as { content?: Array<{ type: string; text?: string }> }
    const text = json.content?.find((c) => c.type === 'text')?.text ?? ''
    if (!text) return { extraction: null, error: 'no text in response' }
    const cleaned = text.replace(/```json|```/g, '').trim()
    let parsed: unknown
    try {
      parsed = JSON.parse(cleaned)
    } catch (e) {
      return { extraction: null, error: `JSON parse: ${(e as Error).message}` }
    }
    const r = parsed as Record<string, unknown>
    const num = (v: unknown): number | null => {
      if (v === null || v === undefined) return null
      const n = typeof v === 'string' ? parseFloat(v) : (v as number)
      return typeof n === 'number' && isFinite(n) ? n : null
    }
    return {
      extraction: {
        revenue_ngn_m: num(r.revenue_ngn_m),
        gross_profit_ngn_m: num(r.gross_profit_ngn_m),
        operating_profit_ngn_m: num(r.operating_profit_ngn_m),
        profit_before_tax_ngn_m: num(r.profit_before_tax_ngn_m),
        profit_after_tax_ngn_m: num(r.profit_after_tax_ngn_m),
        eps_basic: num(r.eps_basic),
        eps_diluted: num(r.eps_diluted),
        book_value_per_share: num(r.book_value_per_share),
        total_assets_ngn_m: num(r.total_assets_ngn_m),
        total_equity_ngn_m: num(r.total_equity_ngn_m),
        total_debt_ngn_m: num(r.total_debt_ngn_m),
        cash_and_equivalents_ngn_m: num(r.cash_and_equivalents_ngn_m),
        cash_from_operations_ngn_m: num(r.cash_from_operations_ngn_m),
        shares_outstanding: num(r.shares_outstanding),
        currency: typeof r.currency === 'string' ? r.currency : 'NGN',
        extraction_notes: typeof r.extraction_notes === 'string' ? r.extraction_notes : null,
      },
      error: null,
    }
  } catch (e) {
    return { extraction: null, error: e instanceof Error ? e.message : String(e) }
  }
}

async function handleReExtract(
  ticker: string,
  periodEnd: string,
  periodType: 'annual' | 'quarterly',
): Promise<unknown> {
  const db = supabaseAdmin()
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (!anthropicKey) return { ok: false, error: 'ANTHROPIC_API_KEY not set' }

  const { data: existing } = await db
    .from('fundamentals_history')
    .select('verified_status, pdf_source_url, pdf_filename')
    .eq('instrument_id', ticker)
    .eq('period_end', periodEnd)
    .eq('period_type', periodType)
    .maybeSingle()
  if (existing && existing.verified_status === 'verified') {
    return { ok: false, error: 'period is marked verified — unverify first via UI before re-extracting' }
  }

  const { data: inst } = await db
    .from('instruments')
    .select('instrument_id, name, sector, isin, shares_outstanding')
    .eq('instrument_id', ticker)
    .maybeSingle()
  if (!inst) return { ok: false, error: `instrument '${ticker}' not found` }
  if (!inst.isin) return { ok: false, error: `instrument '${ticker}' has no ISIN — run build-isin-registry first` }

  const filings = await fetchFinancialFilings(inst.isin as string)
  let matchingFiling: XFinancialNewsItem | null = null
  for (const f of filings) {
    const meta = extractPeriodMetadata(f)
    if (meta && meta.period_end === periodEnd && meta.period_type === periodType) {
      if (matchingFiling === null || new Date(f.Modified) > new Date(matchingFiling.Modified)) {
        matchingFiling = f
      }
    }
  }
  if (!matchingFiling) {
    return { ok: false, error: `no OData filing found matching period ${periodEnd} ${periodType}` }
  }

  try {
    const pdfUrl = matchingFiling.URL.Url
    const pdfFilename = matchingFiling.URL.Description
    const buffer = await downloadPdfAsBuffer(pdfUrl)
    const lines = await extractPdfLines(buffer)
    const { section, matched_marker } = findFinancialStatementSection(lines)
    if (!section || section.length < 500) {
      return { ok: false, error: `extracted section too short (${section.length} chars)`, matched_marker }
    }
    const prompt = buildExtractionPrompt(
      ticker,
      (inst.name as string | null) ?? null,
      (inst.sector as string | null) ?? null,
      pdfFilename,
      periodEnd,
      periodType,
      section,
    )
    const { extraction, error } = await callClaude(prompt, anthropicKey)
    if (error || !extraction) {
      return { ok: false, error: error ?? 'no extraction', matched_marker }
    }

    const row = {
      instrument_id: ticker,
      period_end: periodEnd,
      period_type: periodType,
      pdf_source_url: pdfUrl,
      pdf_filename: pdfFilename,
      ...extraction,
      source: 'ngx_odata',
      verified_status: 'unverified',
      verified_at: null,
      verified_by: null,
    }
    const { error: upErr, data: written } = await db
      .from('fundamentals_history')
      .upsert(row, { onConflict: 'instrument_id,period_end,period_type' })
      .select()
      .maybeSingle()
    if (upErr) return { ok: false, error: `upsert failed: ${upErr.message}` }

    const currentShares = (inst.shares_outstanding ?? null) as number | null
    return {
      ok: true,
      row: written,
      matched_marker,
      derived_ratios: deriveRatios(row as unknown as FundamentalsRow, currentShares),
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// ─── Route handlers ────────────────────────────────────────────────

function getTicker(req: NextRequest): string {
  const url = new URL(req.url)
  return (url.searchParams.get('ticker') ?? '').trim().toUpperCase()
}

export async function GET(req: NextRequest) {
  const ticker = getTicker(req)
  if (!ticker) {
    return NextResponse.json({ ok: false, error: 'ticker required' }, { status: 400 })
  }
  const result = await handleList(ticker)
  return NextResponse.json(result)
}

export async function POST(req: NextRequest) {
  const ticker = getTicker(req)
  if (!ticker) {
    return NextResponse.json({ ok: false, error: 'ticker required' }, { status: 400 })
  }
  const url = new URL(req.url)
  const action = url.searchParams.get('action') ?? ''

  if (action === 're-extract') {
    const periodEnd = url.searchParams.get('period_end') ?? ''
    const periodType = (url.searchParams.get('period_type') ?? '') as 'annual' | 'quarterly'
    if (!periodEnd || !['annual', 'quarterly'].includes(periodType)) {
      return NextResponse.json(
        { ok: false, error: 'period_end and period_type (annual|quarterly) required' },
        { status: 400 },
      )
    }
    const result = await handleReExtract(ticker, periodEnd, periodType)
    return NextResponse.json(result)
  }

  if (action === 'update-shares-current') {
    let body: { shares_outstanding: number | null }
    try {
      body = (await req.json()) as { shares_outstanding: number | null }
    } catch {
      return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 })
    }
    const result = await handleUpdateSharesCurrent(ticker, body)
    return NextResponse.json(result)
  }

  let body: FundamentalsRow
  try {
    body = (await req.json()) as FundamentalsRow
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid JSON body' }, { status: 400 })
  }
  const result = await handleUpsert(ticker, body)
  return NextResponse.json(result)
}
