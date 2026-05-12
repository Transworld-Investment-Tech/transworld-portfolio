// v27cb-a-fix3 — broadened cash field vocabulary   // v27cb-a-fix5: per-period shares_outstanding extraction
// v27ca — OData-driven NGX fundamentals refresh
//
// Replaces the Anthropic+web_search-based extraction (which had gaps and
// produced cite XML in the notes field) with a structured pipeline:
//
//   1. Query NGX SharePoint OData feed for the ticker's filings
//   2. Pick canonical refresh set: 4 most-recent annuals + 1 latest interim
//   3. For each filing: download PDF from doclib, extract text via unpdf,
//      grep to financial-statements section
//   4. Send focused text block (~30K chars) to Claude Sonnet 4 with strict
//      JSON-only extraction prompt
//   5. Upsert rows to `fundamentals_history` (one row per period)
//   6. From the most-recent annual: also update `instruments` columns for
//      backward compatibility with the existing per-instrument page
//   7. Stamp `instruments.last_ngx_refresh_at`
//
// Throughput: 2 tickers per call, each ticker = up to 5 PDFs processed in
// parallel. Per-PDF: download ~5s + unpdf ~5s + Claude ~15s = ~25s. Parallel
// for 5 PDFs ≈ 30s. Two tickers sequentially ≈ 60-90s. Well under 300s budget.
//
// Cron: Saturday 10:00 UTC (one day before the legacy fundamentals/refresh
// cron at Sunday 10:00 — gives this primary path priority over the fallback).

import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import {
  fetchFinancialFilings,
  pickCanonicalRefreshSet,
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

const BATCH_SIZE = 2
const CLAUDE_MODEL = 'claude-sonnet-4-20250514'
const CLAUDE_MAX_TOKENS = 2000

// ─── Types ─────────────────────────────────────────────────────────

interface FundamentalsExtraction {
  // v27cb-a-fix2 — added cash_and_equivalents_ngn_m + cash_from_operations_ngn_m
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
  roe_pct: number | null
  roa_pct: number | null
  net_margin_pct: number | null
  currency: string
  extraction_notes: string | null
}

interface PerFilingResult {
  pdf_url: string
  pdf_filename: string
  period_end: string
  period_type: 'annual' | 'quarterly'
  fiscal_year: number
  ok: boolean
  extraction?: FundamentalsExtraction
  error?: string
  claude_input_chars?: number
  total_pdf_lines?: number
  matched_marker?: string | null
  skipped_verified?: boolean // v27cb-a-fix7d
}

interface PerTickerResult {
  ticker: string
  isin: string
  ok: boolean
  filings_processed: number
  filings_succeeded: number
  rows_written: number
  rows_skipped_verified: number // v27cb-a-fix7d
  per_filing: PerFilingResult[]
  errors: string[]
}

// ─── Claude API ────────────────────────────────────────────────────

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
  return `You are a financial-statement extractor for Nigerian-listed equities. Extract the fields specified below from the financial statements text and return as STRICT JSON. No prose, no markdown fences, no preamble.

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
7. ROE, ROA, net_margin are PERCENTAGES (e.g. 25.5 means 25.5%).
8. Return null for ANY field NOT REPORTED in the statement. Do NOT estimate, infer, fabricate, or compute from other fields.
9. For BANKS, INSURERS, ASSET MANAGERS: "gross_profit_ngn_m" should be null (no COGS concept). "revenue_ngn_m" = Gross Earnings (interest income + non-interest income).
10. For CONSUMER, INDUSTRIAL, OIL & GAS, CEMENT: conventional revenue → gross profit → operating profit → PBT → PAT.
11. If the statement shows BOTH Group and Company columns, use the GROUP (consolidated) column.
12. Numbers may have parentheses or hyphens for negatives — convert to negative numbers.
13. Output ONLY the JSON object — nothing else.

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
  "roe_pct": number|null,
  "roa_pct": number|null,
  "net_margin_pct": number|null,
  "currency": "NGN",
  "extraction_notes": "1-2 sentences flagging any oddities, kobo-to-naira conversions, or missing fields"
}

Financial statements text:
═══════════════════════════════════════════════════════════════════
${textBlock}
═══════════════════════════════════════════════════════════════════

Return ONLY the JSON object.`
}

async function callClaudeExtraction(
  prompt: string,
  anthropicKey: string,
): Promise<{ extraction: FundamentalsExtraction | null; error: string | null }> {
  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 60_000)
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
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
    const json = (await res.json()) as {
      content?: Array<{ type: string; text?: string }>
    }
    const textBlock =
      json.content?.find((c) => c.type === 'text')?.text ?? ''
    if (!textBlock) {
      return { extraction: null, error: 'Claude returned no text content' }
    }
    // Strip any ```json fences if present
    const cleaned = textBlock.replace(/```json|```/g, '').trim()
    let parsed: unknown
    try {
      parsed = JSON.parse(cleaned)
    } catch (e) {
      return {
        extraction: null,
        error: `JSON parse failed: ${(e as Error).message}; raw: ${cleaned.slice(0, 200)}`,
      }
    }
    return { extraction: validateExtraction(parsed), error: null }
  } catch (e) {
    return { extraction: null, error: e instanceof Error ? e.message : String(e) }
  }
}

function validateExtraction(raw: unknown): FundamentalsExtraction | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const numOrNull = (v: unknown): number | null => {
    if (v === null || v === undefined) return null
    const n = typeof v === 'string' ? parseFloat(v) : (v as number)
    if (typeof n !== 'number' || !isFinite(n)) return null
    return n
  }
  return {
    revenue_ngn_m: numOrNull(r.revenue_ngn_m),
    gross_profit_ngn_m: numOrNull(r.gross_profit_ngn_m),
    operating_profit_ngn_m: numOrNull(r.operating_profit_ngn_m),
    profit_before_tax_ngn_m: numOrNull(r.profit_before_tax_ngn_m),
    profit_after_tax_ngn_m: numOrNull(r.profit_after_tax_ngn_m),
    eps_basic: numOrNull(r.eps_basic),
    eps_diluted: numOrNull(r.eps_diluted),
    book_value_per_share: numOrNull(r.book_value_per_share),
    total_assets_ngn_m: numOrNull(r.total_assets_ngn_m),
    total_equity_ngn_m: numOrNull(r.total_equity_ngn_m),
    total_debt_ngn_m: numOrNull(r.total_debt_ngn_m),
    cash_and_equivalents_ngn_m: numOrNull(r.cash_and_equivalents_ngn_m),
    cash_from_operations_ngn_m: numOrNull(r.cash_from_operations_ngn_m),
    shares_outstanding: numOrNull(r.shares_outstanding),
    roe_pct: numOrNull(r.roe_pct),
    roa_pct: numOrNull(r.roa_pct),
    net_margin_pct: numOrNull(r.net_margin_pct),
    currency: typeof r.currency === 'string' ? r.currency : 'NGN',
    extraction_notes: typeof r.extraction_notes === 'string' ? r.extraction_notes : null,
  }
}

// ─── Per-filing processor ──────────────────────────────────────────

async function processFiling(
  ticker: string,
  companyName: string | null,
  sector: string | null,
  filing: {
    item: XFinancialNewsItem
    period_end: string
    period_type: 'annual' | 'quarterly'
    fiscal_year: number
  },
  anthropicKey: string,
): Promise<PerFilingResult> {
  const pdfUrl = filing.item.URL.Url
  const pdfFilename = filing.item.URL.Description
  const base: Omit<PerFilingResult, 'ok' | 'error' | 'extraction'> = {
    pdf_url: pdfUrl,
    pdf_filename: pdfFilename,
    period_end: filing.period_end,
    period_type: filing.period_type,
    fiscal_year: filing.fiscal_year,
  }

  try {
    const buffer = await downloadPdfAsBuffer(pdfUrl)
    const lines = await extractPdfLines(buffer)
    const { section, matched_marker, total_lines } = findFinancialStatementSection(lines)
    if (!section || section.length < 500) {
      return {
        ...base,
        ok: false,
        error: `extracted text too short (${section.length} chars from ${total_lines} lines)`,
        total_pdf_lines: total_lines,
        matched_marker,
      }
    }
    const prompt = buildExtractionPrompt(
      ticker,
      companyName,
      sector,
      pdfFilename,
      filing.period_end,
      filing.period_type,
      section,
    )
    const { extraction, error } = await callClaudeExtraction(prompt, anthropicKey)
    if (error || !extraction) {
      return {
        ...base,
        ok: false,
        error: error ?? 'extraction returned null',
        claude_input_chars: prompt.length,
        total_pdf_lines: total_lines,
        matched_marker,
      }
    }
    return {
      ...base,
      ok: true,
      extraction,
      claude_input_chars: prompt.length,
      total_pdf_lines: total_lines,
      matched_marker,
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    return { ...base, ok: false, error: msg }
  }
}

// ─── Per-ticker processor ──────────────────────────────────────────

async function processTicker(
  ticker: string,
  isin: string,
  companyName: string | null,
  sector: string | null,
  anthropicKey: string,
): Promise<PerTickerResult> {
  const db = supabaseAdmin()
  const result: PerTickerResult = {
    ticker,
    isin,
    ok: false,
    filings_processed: 0,
    filings_succeeded: 0,
    rows_written: 0,
    rows_skipped_verified: 0, // v27cb-a-fix7d
    per_filing: [],
    errors: [],
  }

  try {
    const allFilings = await fetchFinancialFilings(isin)
    const canonicalSet = pickCanonicalRefreshSet(allFilings)
    if (canonicalSet.length === 0) {
      result.errors.push(`no filings returned from OData for ISIN ${isin}`)
      return result
    }
    result.filings_processed = canonicalSet.length

    // Process each filing in parallel — 5 PDFs in parallel ≈ longest single
    // PDF processing time, not the sum.
    const perFilingResults = await Promise.all(
      canonicalSet.map((f) => processFiling(ticker, companyName, sector, f, anthropicKey)),
    )
    result.per_filing = perFilingResults
    result.filings_succeeded = perFilingResults.filter((p) => p.ok).length

    // v27cb-a-fix7d: pre-fetch verified statuses to protect operator-verified
    // rows. Canonical invariant: once a row is marked verified, no cron or
    // automated process ever overwrites it.
    const { data: existingRows, error: vfErr } = await db
      .from('fundamentals_history')
      .select('period_end, period_type, verified_status')
      .eq('instrument_id', ticker)
    if (vfErr) {
      // Defensive: cannot determine verified state — refuse the run to protect data.
      result.errors.push(`verified-status SELECT failed: ${vfErr.message}; refusing to upsert (protects any verified rows)`)
      return result
    }
    const verifiedSet = new Set<string>(
      (existingRows ?? [])
        .filter((r) => r.verified_status === 'verified')
        .map((r) => `${r.period_end}|${r.period_type}`),
    )

    // Persist successful extractions — but NEVER overwrite verified rows
    for (const pfr of perFilingResults) {
      if (!pfr.ok || !pfr.extraction) continue
      const vkey = `${pfr.period_end}|${pfr.period_type}`
      if (verifiedSet.has(vkey)) {
        pfr.skipped_verified = true
        result.rows_skipped_verified++
        continue
      }
      const row = {
        instrument_id: ticker,
        period_end: pfr.period_end,
        period_type: pfr.period_type,
        pdf_source_url: pfr.pdf_url,
        pdf_filename: pfr.pdf_filename,
        revenue_ngn_m: pfr.extraction.revenue_ngn_m,
        gross_profit_ngn_m: pfr.extraction.gross_profit_ngn_m,
        operating_profit_ngn_m: pfr.extraction.operating_profit_ngn_m,
        profit_before_tax_ngn_m: pfr.extraction.profit_before_tax_ngn_m,
        profit_after_tax_ngn_m: pfr.extraction.profit_after_tax_ngn_m,
        eps_basic: pfr.extraction.eps_basic,
        eps_diluted: pfr.extraction.eps_diluted,
        book_value_per_share: pfr.extraction.book_value_per_share,
        total_assets_ngn_m: pfr.extraction.total_assets_ngn_m,
        total_equity_ngn_m: pfr.extraction.total_equity_ngn_m,
        total_debt_ngn_m: pfr.extraction.total_debt_ngn_m,
        cash_and_equivalents_ngn_m: pfr.extraction.cash_and_equivalents_ngn_m,
        cash_from_operations_ngn_m: pfr.extraction.cash_from_operations_ngn_m,
        shares_outstanding: pfr.extraction.shares_outstanding,
        roe_pct: pfr.extraction.roe_pct,
        roa_pct: pfr.extraction.roa_pct,
        net_margin_pct: pfr.extraction.net_margin_pct,
        currency: pfr.extraction.currency,
        source: 'ngx_odata',
        extraction_notes: pfr.extraction.extraction_notes,
      }
      const { error: upErr } = await db
        .from('fundamentals_history')
        .upsert(row, { onConflict: 'instrument_id,period_end,period_type' })
      if (upErr) {
        result.errors.push(
          `upsert failed for period ${pfr.period_end} ${pfr.period_type}: ${upErr.message}`,
        )
      } else {
        result.rows_written++
      }
    }

    // v27cb-a-fix7d: instruments columns now reflect the latest annual from
    // fundamentals_history (post-upsert DB state). This automatically respects
    // verified rows — whatever the DB currently holds for the latest annual is
    // what `instruments` mirrors. If the latest annual was skipped-verified,
    // its pre-existing values (operator-corrected) drive `instruments`.
    const { data: latestAnnualRow } = await db
      .from('fundamentals_history')
      .select('*')
      .eq('instrument_id', ticker)
      .eq('period_type', 'annual')
      .order('period_end', { ascending: false })
      .limit(1)
      .maybeSingle()
    if (latestAnnualRow) {
      const fyYear = parseInt((latestAnnualRow.period_end as string).slice(0, 4), 10)
      const sharesUpdate =
        latestAnnualRow.shares_outstanding !== null && (latestAnnualRow.shares_outstanding as number) > 0
          ? {
              shares_outstanding: latestAnnualRow.shares_outstanding as number,
              shares_outstanding_last_refreshed_at: new Date().toISOString(),
            }
          : {}
      const { error: instUpErr } = await db
        .from('instruments')
        .update({
          revenue_ngn_m: latestAnnualRow.revenue_ngn_m,
          gross_profit_ngn_m: latestAnnualRow.gross_profit_ngn_m,
          operating_profit_ngn_m: latestAnnualRow.operating_profit_ngn_m,
          profit_before_tax_ngn_m: latestAnnualRow.profit_before_tax_ngn_m,
          profit_after_tax_ngn_m: latestAnnualRow.profit_after_tax_ngn_m,
          eps_basic: latestAnnualRow.eps_basic,
          eps_diluted: latestAnnualRow.eps_diluted,
          book_value_per_share: latestAnnualRow.book_value_per_share,
          total_assets_ngn_m: latestAnnualRow.total_assets_ngn_m,
          total_equity_ngn_m: latestAnnualRow.total_equity_ngn_m,
          total_debt_ngn_m: latestAnnualRow.total_debt_ngn_m,
          cash_and_equivalents_ngn_m: latestAnnualRow.cash_and_equivalents_ngn_m,
          cash_from_operations_ngn_m: latestAnnualRow.cash_from_operations_ngn_m,
          ...sharesUpdate,
          roe_pct: latestAnnualRow.roe_pct,
          roa_pct: latestAnnualRow.roa_pct,
          net_margin_pct: latestAnnualRow.net_margin_pct,
          fundamentals_period_end: latestAnnualRow.period_end,
          fundamentals_period_type: `FY${fyYear} Annual`,
          fundamentals_currency: latestAnnualRow.currency,
          fundamentals_source: latestAnnualRow.source ?? 'ngx_odata',
          fundamentals_notes: latestAnnualRow.extraction_notes,
          fundamentals_last_refreshed_at: new Date().toISOString(),
          last_ngx_refresh_at: new Date().toISOString(),
        })
        .eq('instrument_id', ticker)
      if (instUpErr) {
        result.errors.push(`instruments update failed: ${instUpErr.message}`)
      }
    } else {
      // Still stamp last_ngx_refresh_at so this ticker rotates out of the front of the queue
      await db
        .from('instruments')
        .update({ last_ngx_refresh_at: new Date().toISOString() })
        .eq('instrument_id', ticker)
    }

    result.ok = result.filings_succeeded > 0 && result.errors.length === 0
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    result.errors.push(msg)
  }

  return result
}

// ─── Orchestration ─────────────────────────────────────────────────

async function runRefresh(forceTicker?: string): Promise<{
  ok: boolean
  mode: 'single_ticker' | 'batch'
  tickers_processed: PerTickerResult[]
  total_eligible: number
  remaining_after_run: number
  message: string
  config_error?: string
}> {
  const db = supabaseAdmin()
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (!anthropicKey) {
    return {
      ok: false,
      mode: forceTicker ? 'single_ticker' : 'batch',
      tickers_processed: [],
      total_eligible: 0,
      remaining_after_run: 0,
      message: 'ANTHROPIC_API_KEY not set',
      config_error: 'ANTHROPIC_API_KEY env var missing',
    }
  }

  let q = db
    .from('instruments')
    .select('instrument_id, name, sector, isin')
    .eq('type', 'Stock')
    .eq('approved', true)
    .not('isin', 'is', null)

  if (forceTicker) {
    q = q.eq('instrument_id', forceTicker)
  } else {
    q = q.order('last_ngx_refresh_at', { ascending: true, nullsFirst: true }).limit(BATCH_SIZE)
  }

  const { data: rows, error: selectErr } = await q
  if (selectErr) {
    return {
      ok: false,
      mode: forceTicker ? 'single_ticker' : 'batch',
      tickers_processed: [],
      total_eligible: 0,
      remaining_after_run: 0,
      message: `instruments SELECT failed: ${selectErr.message}`,
    }
  }

  const eligible = rows ?? []
  const results: PerTickerResult[] = []
  for (const row of eligible) {
    const ticker = row.instrument_id as string
    const isin = row.isin as string
    const companyName = (row.name as string | null) ?? null
    const sector = (row.sector as string | null) ?? null
    const r = await processTicker(ticker, isin, companyName, sector, anthropicKey)
    results.push(r)
  }

  // Count remaining after this run
  const { count: remainingCount } = await db
    .from('instruments')
    .select('instrument_id', { count: 'exact', head: true })
    .eq('type', 'Stock')
    .eq('approved', true)
    .not('isin', 'is', null)

  const allOk = results.every((r) => r.ok)
  return {
    ok: allOk,
    mode: forceTicker ? 'single_ticker' : 'batch',
    tickers_processed: results,
    total_eligible: eligible.length,
    remaining_after_run: remainingCount ?? 0,
    message: allOk
      ? `Refreshed ${results.length} ticker(s). Total filings extracted: ${results.reduce(
          (s, r) => s + r.rows_written,
          0,
        )}.`
      : `Completed with errors — see per-ticker .errors[]`,
  }
}

function getForceTicker(req: NextRequest): string | undefined {
  const url = new URL(req.url)
  const t = url.searchParams.get('ticker')
  return t ? t.trim().toUpperCase() : undefined
}

export async function POST(req: NextRequest) {
  const forceTicker = getForceTicker(req)
  const result = await runRefresh(forceTicker)
  return NextResponse.json(result)
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url)
  const cronSecret = url.searchParams.get('cron_secret')
  const envSecret = process.env.CRON_SECRET
  const forceTicker = getForceTicker(req)
  if (envSecret && cronSecret !== envSecret && !forceTicker) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 })
  }
  const result = await runRefresh(forceTicker)
  return NextResponse.json(result)
}
