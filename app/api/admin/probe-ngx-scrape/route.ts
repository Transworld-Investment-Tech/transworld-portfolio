// v27ca-probe — NGX company-profile scrape diagnostic
//
// Single-shot diagnostic endpoint. Fetches the NGX company-profile page for a given
// ticker from this Vercel function (browser-like UA, 55s timeout), then parses the
// HTML for doclib.ngxgroup.com PDF URLs. Returns a structured JSON envelope with:
//   - status_code, fetch_duration_ms, html_size_bytes
//   - pdf_urls[] + pdf_count
//   - diagnostics flags (has_doclib_reference, has_datatable_signature, etc.)
//   - excerpts of the HTML around key markers
//   - an interpretation string telling the operator what the result means
//
// Purpose: decides whether v27ca proper ships auto-scrape (pdf_count > 0) or
// manual-upload pipeline (pdf_count == 0, table is JS-rendered).

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

function excerptAroundMarker(html: string, marker: string, padding = 1500): string | null {
  const idx = html.toLowerCase().indexOf(marker.toLowerCase())
  if (idx === -1) return null
  const start = Math.max(0, idx - padding)
  const end = Math.min(html.length, idx + marker.length + padding)
  return html.slice(start, end)
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
    has_doclib_reference: boolean
    has_cloudflare_challenge: boolean
  }
  excerpts: Record<string, string | null>
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

  const hasFinancialStatementsTab = /financial[s]?\s+statement[s]?/i.test(html)
  const hasDocumentsHeader =
    /<th[^>]*>\s*Documents\s*<\/th>/i.test(html) ||
    /class=["'][^"']*documents/i.test(html) ||
    />\s*Documents\s*</.test(html)
  const hasDataTable = /DataTable|dataTables/.test(html)
  const hasDoclibReference = /doclib\.ngxgroup\.com/i.test(html)
  const hasCloudflareChallenge =
    /cf-browser-verification|__cf_chl|cloudflare/i.test(html) && status !== 200

  const excerpts: Record<string, string | null> = {}
  if (hasDoclibReference) {
    excerpts['around_doclib_first'] = excerptAroundMarker(html, 'doclib.ngxgroup.com', 1500)
  }
  if (hasDocumentsHeader) {
    excerpts['around_documents_header'] = excerptAroundMarker(html, 'Documents', 1500)
  }
  if (hasFinancialStatementsTab) {
    excerpts['around_financials_tab'] = excerptAroundMarker(html, 'Financials Statements', 1500)
  }
  // Always include a head-of-body excerpt for sanity if nothing else matched
  if (Object.keys(excerpts).length === 0 && html.length > 0) {
    excerpts['head_of_html'] = html.slice(0, 3000)
  }

  let interpretation: string
  if (fetchError) {
    interpretation = `FETCH FAILED — ${fetchError}. From Vercel this typically means the page timed out (>55s) or the host rejected the request.`
  } else if (status !== 200) {
    interpretation = `NON-200 STATUS (${status}) — page rejected the request. Check headers or anti-bot defenses.`
  } else if (pdfUrls.length > 0) {
    interpretation = `AUTO-SCRAPE VIABLE — ${pdfUrls.length} PDF URL(s) present in static HTML. v27ca proper can ship as auto-scrape pipeline.`
  } else if (hasDataTable && !hasDoclibReference) {
    interpretation =
      'AJAX-RENDERED TABLE — DataTables signature found but zero doclib references. Documents are loaded via AJAX after page render. v27ca proper must fall back to manual-upload pipeline OR reverse-engineer the AJAX endpoint.'
  } else if (!hasDoclibReference) {
    interpretation =
      'NO DOCLIB REFERENCES — page may have anti-bot defenses, geofencing, or returns a different layout to server fetches. Check the head_of_html excerpt for clues.'
  } else {
    interpretation =
      'DOCLIB REFERENCED BUT NO PDF URLS EXTRACTED — investigate the around_doclib_first excerpt; regex may need adjustment.'
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
      has_doclib_reference: hasDoclibReference,
      has_cloudflare_challenge: hasCloudflareChallenge,
    },
    excerpts,
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
