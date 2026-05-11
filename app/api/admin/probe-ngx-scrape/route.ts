// v27ca-probe2 — NGX company-profile scrape diagnostic (enhanced)
//
// Probe1 confirmed the page is fetchable from Vercel and contains the WEBSERVICE
// config block, but PDF URLs aren't in static <a> links — the Documents table is
// rendered by the wpDataTables WordPress plugin via AJAX. Probe2 hunts for the
// AJAX endpoint:
//   1. Extract every <script> block mentioning doclib/WEBSERVICE/requestUri/wpdt
//      (capped 5KB each, max 5 blocks)
//   2. Extract every URL-like candidate from JS: `url: "..."`, `WEBSERVICE_BASE_URL + "..."`,
//      `WEBSERVICE_ORIGIN + "..."`, direct doclib URLs, REST endpoint strings
//   3. Extract wpDataTables `table_id` references — these key the admin-ajax.php endpoint
//   4. Smart-locate the Documents table via wpDataTablesWrapper occurrences with
//      proximity scoring (avoids the footer-nav false-positive that probe1 hit)
//   5. Carry forward probe1 fields for continuity

import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60
export const runtime = 'nodejs'

const NGX_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

function todayIsoT0(): string {
  const today = new Date()
  return `${today.toISOString().slice(0, 10)}T00:00:00`
}

function findDoclibUrls(html: string): string[] {
  const urls = new Set<string>()
  const patterns = [
    /https?:\/\/doclib\.ngxgroup\.com\/Financial_NewsDocs\/[^\s"'<>)\]]+\.pdf/gi,
    /https?:\/\/doclib\.ngxgroup\.com\/[^\s"'<>)\]]+\.pdf/gi,
  ]
  for (const p of patterns) {
    const matches = html.match(p) ?? []
    for (const m of matches) {
      urls.add(m.replace(/&amp;/g, '&'))
    }
  }
  return Array.from(urls).sort()
}

interface ScriptBlock {
  snippet: string
  full_length: number
  matched_keyword: string
  position_in_html: number
}

function extractScriptBlocks(html: string, maxBlocks = 5, maxBytes = 5000): ScriptBlock[] {
  const blocks: ScriptBlock[] = []
  const keywords = ['doclib', 'WEBSERVICE', 'requestUri', 'wpdt', 'get_wdtable', 'admin-ajax']
  const scriptRegex = /<script[^>]*>([\s\S]*?)<\/script>/gi
  let m: RegExpExecArray | null
  while ((m = scriptRegex.exec(html)) !== null && blocks.length < maxBlocks) {
    const content = m[1]
    let matchedKw: string | null = null
    for (const kw of keywords) {
      if (content.includes(kw)) {
        matchedKw = kw
        break
      }
    }
    if (matchedKw === null) continue
    const snippet =
      content.length > maxBytes
        ? content.slice(0, maxBytes) + `\n...[TRUNCATED — full length: ${content.length} bytes]`
        : content
    blocks.push({
      snippet,
      full_length: content.length,
      matched_keyword: matchedKw,
      position_in_html: m.index,
    })
  }
  return blocks
}

function extractJsUrlCandidates(html: string): string[] {
  const candidates = new Set<string>()
  const patterns: Array<[RegExp, (match: RegExpExecArray) => string]> = [
    // url: "..." or url : '...'
    [/\burl\s*:\s*['"]([^'"]+)['"]/gi, (m) => m[1]],
    // requestUri_X = WEBSERVICE_BASE_URL + "..."
    [
      /=\s*WEBSERVICE_BASE_URL\s*\+\s*['"]([^'"]+)['"]/gi,
      (m) => '${WEBSERVICE_BASE_URL}' + m[1],
    ],
    // requestUri_X = WEBSERVICE_ORIGIN + "..."
    [
      /=\s*WEBSERVICE_ORIGIN\s*\+\s*['"]([^'"]+)['"]/gi,
      (m) => '${WEBSERVICE_ORIGIN}' + m[1],
    ],
    // direct doclib URLs in strings
    [/['"](https?:\/\/doclib\.ngxgroup\.com[^'"]+)['"]/gi, (m) => m[1]],
    // /REST/... string refs
    [/['"](\/REST\/[^'"]+)['"]/gi, (m) => m[1]],
    // admin-ajax.php references
    [/['"]([^'"]*admin-ajax\.php[^'"]*)['"]/gi, (m) => m[1]],
    // wp-json REST endpoints
    [/['"]([^'"]*\/wp-json\/[^'"]+)['"]/gi, (m) => m[1]],
    // get_wdtable AJAX action references
    [/action=get_wdtable[^'"\s&]*/gi, (m) => m[0]],
  ]
  for (const [regex, extract] of patterns) {
    let m: RegExpExecArray | null
    while ((m = regex.exec(html)) !== null) {
      const value = extract(m)
      if (value && value.length < 500) candidates.add(value)
    }
  }
  return Array.from(candidates).sort()
}

function extractTableIds(html: string): string[] {
  const ids = new Set<string>()
  const patterns = [
    /table_id["']?\s*[:=]\s*['"]?(\d+)/gi,
    /wpdt[-_]?id["']?\s*[:=]\s*['"]?(\d+)/gi,
    /wpDataTableId["']?\s*[:=]\s*['"]?(\d+)/gi,
    /data-table-id\s*=\s*['"](\d+)['"]/gi,
    /wpDataTablesPlugin\.[a-z]+\s*=\s*['"]?(\d+)/gi,
  ]
  for (const p of patterns) {
    let m: RegExpExecArray | null
    while ((m = p.exec(html)) !== null) {
      ids.add(m[1])
    }
  }
  return Array.from(ids).sort()
}

function locateDocumentsTable(html: string, maxBytes = 15000): string | null {
  const wrapperRegex = /wpDataTablesWrapper/gi
  const candidates: Array<{ start: number; end: number; score: number; preview: string }> = []
  let m: RegExpExecArray | null
  while ((m = wrapperRegex.exec(html)) !== null) {
    const start = Math.max(0, m.index - 500)
    const end = Math.min(html.length, m.index + maxBytes)
    const window = html.slice(start, end)
    let score = 0
    if (/AUDITED FINANCIAL STATEMENT|QUARTER \d+\s*-\s*FINANCIAL/i.test(window)) score += 30
    if (/\bDocuments\b/.test(window) && !/Memorandum Listings|Offer Documents/i.test(window)) {
      score += 10
    }
    if (/Financials Statements/i.test(window)) score += 5
    if (/wpDataTable_\d+|wpdt-c/i.test(window)) score += 3
    // Penalty for footer-nav match
    if (/Memorandum Listings|Mutual Funds.*Offer Documents/i.test(window)) score -= 20
    if (/Company Name|Sub-Sector|Market Classification/i.test(window)) score -= 5 // Profile tab
    candidates.push({
      start,
      end,
      score,
      preview: window.slice(500, 600),
    })
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => b.score - a.score)
  const best = candidates[0]
  return html.slice(best.start, best.end)
}

interface ProbeResult {
  ok: boolean
  ticker: string
  url_fetched: string
  status_code: number
  fetch_duration_ms: number
  fetch_error: string | null
  html_size_bytes: number
  pdf_urls: string[]
  pdf_count: number
  diagnostics: {
    has_financial_statements_tab: boolean
    has_documents_header: boolean
    has_datatable_signature: boolean
    has_wpdatatables_signature: boolean
    has_doclib_reference: boolean
    has_admin_ajax_reference: boolean
    has_cloudflare_challenge: boolean
  }
  js_url_candidates: string[]
  js_url_candidate_count: number
  wpdatatables_table_ids: string[]
  script_blocks_matching_keywords: ScriptBlock[]
  documents_table_excerpt: string | null
  interpretation: string
}

async function runProbe(ticker: string): Promise<ProbeResult> {
  const tdate = todayIsoT0()
  const targetUrl = `https://ngxgroup.com/exchange/data/company-profile/?symbol=${encodeURIComponent(
    ticker,
  )}&directory=companydirectory&tdate=${tdate}`

  const t0 = Date.now()
  let status = 0
  let html = ''
  let fetchError: string | null = null

  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 55_000)
    const res = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'User-Agent': NGX_USER_AGENT,
        Accept:
          'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
      },
      signal: controller.signal,
      redirect: 'follow',
    })
    clearTimeout(timeoutId)
    status = res.status
    html = await res.text()
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err)
  }

  const fetchDurationMs = Date.now() - t0
  const pdfUrls = findDoclibUrls(html)
  const jsUrls = extractJsUrlCandidates(html)
  const tableIds = extractTableIds(html)
  const scriptBlocks = extractScriptBlocks(html)
  const documentsExcerpt = locateDocumentsTable(html)

  const hasFinancialStatementsTab = /financial[s]?\s+statement[s]?/i.test(html)
  const hasDocumentsHeader =
    /<th[^>]*>\s*Documents\s*<\/th>/i.test(html) ||
    /AUDITED FINANCIAL STATEMENT|QUARTER \d+\s*-\s*FINANCIAL/i.test(html)
  const hasDataTable = /DataTable|dataTables/.test(html)
  const hasWpDataTables = /wpDataTable|wpdt-c|wp-data-tables/.test(html)
  const hasDoclibReference = /doclib\.ngxgroup\.com/i.test(html)
  const hasAdminAjax = /admin-ajax\.php/i.test(html)
  const hasCloudflareChallenge =
    /cf-browser-verification|__cf_chl|cloudflare/i.test(html) && status !== 200

  let interpretation: string
  if (fetchError) {
    interpretation = `FETCH FAILED — ${fetchError}.`
  } else if (status !== 200) {
    interpretation = `NON-200 STATUS (${status}) — page rejected the request.`
  } else if (pdfUrls.length > 0) {
    interpretation = `STATIC AUTO-SCRAPE VIABLE — ${pdfUrls.length} PDF URL(s) in static HTML.`
  } else if (tableIds.length > 0 && hasAdminAjax) {
    interpretation = `AJAX VIA admin-ajax.php — wpDataTables found with table_id(s): [${tableIds.join(', ')}]. Probe the admin-ajax.php endpoint with action=get_wdtable + table_id to retrieve JSON.`
  } else if (jsUrls.some((u) => u.includes('REST') || u.includes('doclib'))) {
    interpretation = `REST API ENDPOINTS FOUND — check js_url_candidates for the candidate endpoint that lists company documents. Hit it directly from Vercel.`
  } else if (hasWpDataTables) {
    interpretation = `WPDATATABLES PRESENT but no table_id or AJAX endpoint extracted. Inspect script_blocks_matching_keywords for the loader pattern.`
  } else {
    interpretation = `INCONCLUSIVE — no obvious AJAX endpoint found. Inspect script_blocks_matching_keywords and documents_table_excerpt for manual analysis.`
  }

  return {
    ok: !fetchError && status === 200,
    ticker,
    url_fetched: targetUrl,
    status_code: status,
    fetch_duration_ms: fetchDurationMs,
    fetch_error: fetchError,
    html_size_bytes: html.length,
    pdf_urls: pdfUrls,
    pdf_count: pdfUrls.length,
    diagnostics: {
      has_financial_statements_tab: hasFinancialStatementsTab,
      has_documents_header: hasDocumentsHeader,
      has_datatable_signature: hasDataTable,
      has_wpdatatables_signature: hasWpDataTables,
      has_doclib_reference: hasDoclibReference,
      has_admin_ajax_reference: hasAdminAjax,
      has_cloudflare_challenge: hasCloudflareChallenge,
    },
    js_url_candidates: jsUrls,
    js_url_candidate_count: jsUrls.length,
    wpdatatables_table_ids: tableIds,
    script_blocks_matching_keywords: scriptBlocks,
    documents_table_excerpt: documentsExcerpt,
    interpretation,
  }
}

function getTickerFromRequest(req: NextRequest): string {
  const url = new URL(req.url)
  return (url.searchParams.get('ticker') ?? '').trim().toUpperCase()
}

export async function POST(req: NextRequest) {
  const ticker = getTickerFromRequest(req)
  if (!ticker) {
    return NextResponse.json(
      { ok: false, error: 'ticker query parameter required (e.g. ?ticker=ACCESSCORP)' },
      { status: 400 },
    )
  }
  const result = await runProbe(ticker)
  return NextResponse.json(result)
}

export async function GET(req: NextRequest) {
  const ticker = getTickerFromRequest(req)
  if (!ticker) {
    return NextResponse.json(
      { ok: false, error: 'ticker query parameter required (e.g. ?ticker=ACCESSCORP)' },
      { status: 400 },
    )
  }
  const result = await runProbe(ticker)
  return NextResponse.json(result)
}
