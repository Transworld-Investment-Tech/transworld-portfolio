// v27ca — NGX SharePoint OData wrapper
//
// Wraps the public read-only SharePoint OData feed at
//   https://doclib.ngxgroup.com/_api/Web/Lists/GetByTitle('XFinancial_News')/items
//
// Discovered via probes v27ca-probe / probe2 / probe3 — the browser frontend hits
// this exact endpoint when rendering company-profile pages. Returns JSON-verbose
// with `d.results[]` shape; supports OData pagination via `d.__next` token.
//
// Two public helpers:
//   - findIsinForTicker(symbol)         → returns the InternationSecIN for a ticker, or null
//   - fetchFinancialFilings(isin)       → returns all Financial Statements + EarningForcast
//                                          filings for a given ISIN, paginated
//
// All requests sent with browser-like headers (UA + Referer + Origin) to maximise
// compatibility. The endpoint validated via probe3 returns 200 + valid OData JSON
// without any session cookie or CSRF token.

const NGX_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

const ODATA_BASE =
  "https://doclib.ngxgroup.com/_api/Web/Lists/GetByTitle('XFinancial_News')/items"

const REFERER = 'https://ngxgroup.com/exchange/data/company-profile/'

export interface XFinancialNewsItem {
  __metadata?: { id: string; uri: string; etag: string; type: string }
  URL: {
    __metadata?: { type: string }
    Description: string
    Url: string
  }
  InternationSecIN: string
  Type_of_Submission: string
  Modified: string // ISO 8601 timestamp
  CompanySymbol?: string
  CompanyName?: string
  Id?: number
}

interface OdataResponse {
  d: {
    results: XFinancialNewsItem[]
    __next?: string
  }
}

async function odataFetch(url: string): Promise<OdataResponse> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 25_000)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': NGX_USER_AGENT,
        Accept: 'application/json;odata=verbose',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: REFERER,
        Origin: 'https://ngxgroup.com',
      },
      signal: controller.signal,
      redirect: 'follow',
    })
    if (!res.ok) {
      throw new Error(`OData ${res.status}: ${(await res.text()).slice(0, 300)}`)
    }
    const json = (await res.json()) as OdataResponse
    if (!json.d || !Array.isArray(json.d.results)) {
      throw new Error('OData response missing d.results array')
    }
    return json
  } finally {
    clearTimeout(timeoutId)
  }
}

/**
 * Returns the InternationSecIN (ISIN) for a given NGX ticker symbol, or null
 * if the ticker has no Financial Statements filings on file (delisted / new).
 */
export async function findIsinForTicker(symbol: string): Promise<string | null> {
  const params = new URLSearchParams()
  params.set('$select', 'InternationSecIN,CompanySymbol')
  params.set('$top', '1')
  params.set(
    '$filter',
    `CompanySymbol eq '${symbol}' and Type_of_Submission eq 'Financial Statements'`,
  )
  const url = `${ODATA_BASE}/?${params.toString()}`
  const json = await odataFetch(url)
  if (json.d.results.length === 0) return null
  return json.d.results[0].InternationSecIN ?? null
}

/**
 * Returns all Financial Statements + EarningForcast filings for a given ISIN,
 * ordered newest-first by Modified date. Handles OData pagination via __next.
 *
 * Caps at 200 records (4 pages × 50) to bound memory; real-world tickers have
 * 30-60 filings going back ~10 years.
 */
export async function fetchFinancialFilings(isin: string): Promise<XFinancialNewsItem[]> {
  const params = new URLSearchParams()
  params.set('$select', 'URL,Modified,InternationSecIN,Type_of_Submission,CompanySymbol')
  params.set('$orderby', 'Modified desc')
  params.set(
    '$filter',
    `InternationSecIN eq '${isin}' and (Type_of_Submission eq 'Financial Statements' or Type_of_Submission eq 'EarningForcast')`,
  )
  let url: string | undefined = `${ODATA_BASE}/?${params.toString()}`

  const all: XFinancialNewsItem[] = []
  let pages = 0
  while (url && pages < 4 && all.length < 200) {
    const json: OdataResponse = await odataFetch(url)
    all.push(...json.d.results)
    url = json.d.__next
    pages++
  }
  return all
}

/**
 * Categorize a filing's period type from its Description.
 * NGX convention: "QUARTER 5" or "AUDITED" = annual; "QUARTER 1/2/3" = quarterly.
 */
export function categorizeFiling(item: XFinancialNewsItem): 'annual' | 'quarterly' {
  const desc = (item.URL?.Description ?? '').toUpperCase()
  // v27cb-a-fix7b: YEAR\s*END added — ARADEL filed FY2025 as "YEAR END - FINANCIAL STATEMENT FOR 2025"
  if (/QUARTER\s*5|AUDITED|FULL\s*YEAR|ANNUAL|YEAR\s*END/.test(desc)) return 'annual'
  return 'quarterly'
}

/**
 * Extract period_end date and the YEAR mentioned in the Description.
 * "QUARTER 5 - FINANCIAL STATEMENT FOR 2025" → period_end = 2025-12-31, period_type = annual
 * "QUARTER 1 - FINANCIAL STATEMENT FOR 2026" → period_end = 2026-03-31, period_type = quarterly
 * "QUARTER 2 - FINANCIAL STATEMENT FOR 2025" → period_end = 2025-06-30, period_type = quarterly
 * "QUARTER 3 - FINANCIAL STATEMENT FOR 2025" → period_end = 2025-09-30, period_type = quarterly
 * "AUDITED ... 31 DECEMBER 2025" / "FOR 2025" → period_end = 2025-12-31, period_type = annual
 *
 * Returns null if the year can't be parsed — caller should skip the row.
 */
export function extractPeriodMetadata(item: XFinancialNewsItem): {
  period_end: string // ISO date YYYY-MM-DD
  period_type: 'annual' | 'quarterly'
  fiscal_year: number
} | null {
  const desc = (item.URL?.Description ?? '').toUpperCase()
  const period_type = categorizeFiling(item)

  // Try to pull a 4-digit year (1990-2099)
  const yearMatch = desc.match(/(?:FOR\s+|YEAR\s+ENDED\s+(?:\d+\s+\w+\s+)?|31\s+\w+\s+)((?:19|20)\d{2})/i)
  if (!yearMatch) return null
  const year = parseInt(yearMatch[1], 10)
  if (year < 1990 || year > 2099) return null

  let period_end: string
  if (period_type === 'annual') {
    period_end = `${year}-12-31`
  } else {
    const qMatch = desc.match(/QUARTER\s*(\d)/)
    if (!qMatch) return null
    const q = parseInt(qMatch[1], 10)
    if (q === 1) period_end = `${year}-03-31`
    else if (q === 2) period_end = `${year}-06-30`
    else if (q === 3) period_end = `${year}-09-30`
    else return null
  }

  return { period_end, period_type, fiscal_year: year }
}

/**
 * Pick the canonical refresh set per v27ca scope:
 *   - 4 most-recent ANNUALS (for CAGR / Buffett PEG)
 *   - 1 most-recent QUARTERLY (for current TTM context)
 *
 * Input must be the raw OData result ordered newest-first by Modified.
 * Dedupes by (period_end, period_type) and picks the one with the most recent
 * Modified date for each duplicate.
 */
export function pickCanonicalRefreshSet(items: XFinancialNewsItem[]): Array<{
  item: XFinancialNewsItem
  period_end: string
  period_type: 'annual' | 'quarterly'
  fiscal_year: number
}> {
  const byKey = new Map<
    string,
    {
      item: XFinancialNewsItem
      period_end: string
      period_type: 'annual' | 'quarterly'
      fiscal_year: number
    }
  >()
  for (const item of items) {
    const meta = extractPeriodMetadata(item)
    if (!meta) continue
    const key = `${meta.period_end}|${meta.period_type}`
    const existing = byKey.get(key)
    if (!existing || new Date(item.Modified) > new Date(existing.item.Modified)) {
      byKey.set(key, { item, period_end: meta.period_end, period_type: meta.period_type, fiscal_year: meta.fiscal_year })
    }
  }
  const annuals = Array.from(byKey.values())
    .filter((x) => x.period_type === 'annual')
    .sort((a, b) => b.period_end.localeCompare(a.period_end))
    .slice(0, 5)
  // v27cb-a-fix7b: quarters now include ALL with period_end strictly after the
  // latest annual (was: 1 latest quarter regardless of position). Capped at 5
  // as a safety bound for tickers with no annual on file.
  const latestAnnualEnd = annuals.length > 0 ? annuals[0].period_end : '0000-00-00'
  const quarterlies = Array.from(byKey.values())
    .filter((x) => x.period_type === 'quarterly' && x.period_end > latestAnnualEnd)
    .sort((a, b) => b.period_end.localeCompare(a.period_end))
    .slice(0, 5)
  return [...annuals, ...quarterlies]
}
