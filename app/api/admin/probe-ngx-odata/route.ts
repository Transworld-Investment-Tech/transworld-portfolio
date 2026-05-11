// v27ca-probe3 — NGX SharePoint OData endpoint validator
//
// Probe2 discovered the actual data source: SharePoint OData feed at
// `doclib.ngxgroup.com/_api/Web/Lists/GetByTitle('XFinancial_News')/items`.
// Probe3 validates this endpoint works from Vercel server-side by:
//   - Test A: bare endpoint with $top=5 (alive check, no ISIN required)
//   - Test B: real-world filtered query for the operator-supplied ISIN
// Both test responses are returned: status, sample of d.results, response headers,
// and timing. From the responses we know whether v27ca proper can ship as a
// pure OData consumer or needs additional anti-CORS workarounds.

import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60
export const runtime = 'nodejs'

const NGX_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const ODATA_BASE =
  "https://doclib.ngxgroup.com/_api/Web/Lists/GetByTitle('XFinancial_News')/items"

interface ODataTestResult {
  label: string
  url: string
  status_code: number
  fetch_duration_ms: number
  fetch_error: string | null
  response_headers: Record<string, string>
  content_type: string | null
  body_size_bytes: number
  body_first_3kb: string
  parsed_record_count: number | null
  parsed_sample: unknown[]
  parse_error: string | null
}

async function fetchOdata(
  url: string,
  label: string,
  referer: string,
): Promise<ODataTestResult> {
  const t0 = Date.now()
  let status = 0
  let bodyText = ''
  let fetchError: string | null = null
  let responseHeaders: Record<string, string> = {}
  let contentType: string | null = null

  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 25_000)
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': NGX_USER_AGENT,
        Accept: 'application/json;odata=verbose',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: referer,
        Origin: 'https://ngxgroup.com',
      },
      signal: controller.signal,
      redirect: 'follow',
    })
    clearTimeout(timeoutId)
    status = res.status
    contentType = res.headers.get('content-type')
    res.headers.forEach((v, k) => {
      responseHeaders[k] = v
    })
    bodyText = await res.text()
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err)
  }

  const fetchDurationMs = Date.now() - t0

  let parsedCount: number | null = null
  let parsedSample: unknown[] = []
  let parseError: string | null = null

  if (bodyText && !fetchError) {
    try {
      const json: unknown = JSON.parse(bodyText)
      // SharePoint OData verbose returns { d: { results: [...] } }
      // SharePoint OData non-verbose returns { value: [...] }
      const j = json as Record<string, unknown>
      let results: unknown[] | null = null
      if (j['d'] && typeof j['d'] === 'object' && j['d'] !== null) {
        const dObj = j['d'] as Record<string, unknown>
        if (Array.isArray(dObj['results'])) {
          results = dObj['results'] as unknown[]
        } else {
          results = [dObj]
        }
      } else if (Array.isArray(j['value'])) {
        results = j['value'] as unknown[]
      }
      if (results !== null) {
        parsedCount = results.length
        parsedSample = results.slice(0, 3)
      }
    } catch (e) {
      parseError = e instanceof Error ? e.message : String(e)
    }
  }

  return {
    label,
    url,
    status_code: status,
    fetch_duration_ms: fetchDurationMs,
    fetch_error: fetchError,
    response_headers: responseHeaders,
    content_type: contentType,
    body_size_bytes: bodyText.length,
    body_first_3kb: bodyText.slice(0, 3000),
    parsed_record_count: parsedCount,
    parsed_sample: parsedSample,
    parse_error: parseError,
  }
}

function buildTestAUrl(): string {
  return `${ODATA_BASE}/?$top=5&$orderby=Modified desc`
}

function buildTestBUrl(isin: string): string {
  // Match the exact filter expression from the front-end (probe2 script block 4)
  const filter = `InternationSecIN eq '${isin}' and (Type_of_Submission eq 'Financial Statements' or Type_of_Submission eq 'EarningForcast')`
  const params = new URLSearchParams()
  params.set('$select', 'URL,Modified,InternationSecIN,Type_of_Submission')
  params.set('$orderby', 'Modified desc')
  params.set('$filter', filter)
  return `${ODATA_BASE}/?${params.toString()}`
}

interface ProbeResult {
  ok: boolean
  ticker: string
  isin: string
  referer_sent: string
  test_a_alive_check: ODataTestResult
  test_b_filtered_query: ODataTestResult
  interpretation: string
}

async function runProbe(ticker: string, isin: string): Promise<ProbeResult> {
  const referer = `https://ngxgroup.com/exchange/data/company-profile/?symbol=${encodeURIComponent(ticker)}&directory=companydirectory`

  const testA = await fetchOdata(buildTestAUrl(), 'A_alive_check_top5', referer)
  const testB = await fetchOdata(buildTestBUrl(isin), 'B_filtered_for_isin', referer)

  let interpretation: string
  if (testA.fetch_error || testB.fetch_error) {
    interpretation = `FETCH ERROR — A: ${testA.fetch_error ?? 'ok'} | B: ${testB.fetch_error ?? 'ok'}`
  } else if (testA.status_code === 403 || testB.status_code === 403) {
    interpretation = `403 FORBIDDEN — OData endpoint rejects server-side requests. May need session cookie, CSRF token, or browser-only access.`
  } else if (testA.status_code === 401 || testB.status_code === 401) {
    interpretation = `401 UNAUTHORIZED — endpoint requires authentication.`
  } else if (testA.status_code !== 200) {
    interpretation = `TEST A NON-200 (${testA.status_code}) — endpoint reachable but returns error. Check body_first_3kb.`
  } else if (testB.status_code !== 200) {
    interpretation = `TEST B NON-200 (${testB.status_code}) — alive but filter query rejected. Inspect body_first_3kb for OData error details.`
  } else if (testB.parsed_record_count === null) {
    interpretation = `STATUS 200 BUT PARSE FAILED — body not parseable as OData JSON. Check body_first_3kb.`
  } else if (testB.parsed_record_count === 0) {
    interpretation = `STATUS 200 — query worked but ZERO records for ISIN '${isin}'. ISIN may be wrong, or filter syntax needs adjustment.`
  } else {
    interpretation = `ODATA ENDPOINT VIABLE — Test A returned ${testA.parsed_record_count} record(s), Test B returned ${testB.parsed_record_count} filing(s) for ${ticker} (${isin}). v27ca proper can ship as pure OData consumer.`
  }

  const ok =
    !testA.fetch_error &&
    !testB.fetch_error &&
    testA.status_code === 200 &&
    testB.status_code === 200 &&
    (testB.parsed_record_count ?? 0) > 0

  return {
    ok,
    ticker,
    isin,
    referer_sent: referer,
    test_a_alive_check: testA,
    test_b_filtered_query: testB,
    interpretation,
  }
}

function getParams(req: NextRequest): { ticker: string; isin: string } {
  const url = new URL(req.url)
  const ticker = (url.searchParams.get('ticker') ?? '').trim().toUpperCase()
  let isin = (url.searchParams.get('isin') ?? '').trim().toUpperCase()
  // Default: ACCESSCORP -> NGACCESS0005 (known from probe2)
  if (!isin && ticker === 'ACCESSCORP') {
    isin = 'NGACCESS0005'
  }
  return { ticker, isin }
}

export async function POST(req: NextRequest) {
  const { ticker, isin } = getParams(req)
  if (!ticker || !isin) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'ticker and isin query parameters required (e.g. ?ticker=ACCESSCORP&isin=NGACCESS0005)',
      },
      { status: 400 },
    )
  }
  const result = await runProbe(ticker, isin)
  return NextResponse.json(result)
}

export async function GET(req: NextRequest) {
  const { ticker, isin } = getParams(req)
  if (!ticker || !isin) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'ticker and isin query parameters required (e.g. ?ticker=ACCESSCORP&isin=NGACCESS0005)',
      },
      { status: 400 },
    )
  }
  const result = await runProbe(ticker, isin)
  return NextResponse.json(result)
}
