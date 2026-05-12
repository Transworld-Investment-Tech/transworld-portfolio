// v27cb-a-fix7f — Disclosures + Director Dealings OData fetcher
//
// Distinct from lib/ngx-odata.ts to keep concerns isolated. Reuses the same
// NGX SharePoint OData endpoint ('XFinancial_News' list) with different
// Type_of_Submission filters.
//
// Categories observed in OData (with NGX data-quality quirks):
//   • "Financial Statements"   — already handled by lib/ngx-odata.ts
//   • "EarningForcast"          — already handled (NGX's typo, kept as-is)
//   • "Corporate Actions"       — sometimes with TRAILING SPACE ("Corporate Actions ")
//   • "Board Meeting (BM)"
//   • "DirectorsDealings"
//
// The categorizer normalizes via .trim().toLowerCase() to be robust to NGX's
// inconsistent whitespace and casing.
//
// "Title" field on OData items returns null (confirmed via empirical probe on
// 2026-05-12). The display title comes from URL.Description, which is also
// what lib/ngx-odata.ts uses as pdf_filename.
//
// ngx_item_id derivation: SharePoint OData items expose `ID` (or `Id`)
// natively. Falls back to URL+Modified hash if neither is present, to keep
// the UNIQUE constraint reliable even if NGX changes field naming.

import { type XFinancialNewsItem } from './ngx-odata'

const ODATA_BASE = "https://doclib.ngxgroup.com/_api/Web/Lists/GetByTitle('XFinancial_News')/items"

export type DisclosureCategory =
  | 'corporate_actions'
  | 'board_meeting'
  | 'director_dealings'
  | 'financial_statement'
  | 'earning_forecast'
  | 'other'

export function categorizeDisclosure(rawType: string | null | undefined): DisclosureCategory {
  if (!rawType) return 'other'
  const t = rawType.trim().toLowerCase()
  if (t === 'corporate actions') return 'corporate_actions'
  if (t === 'board meeting (bm)') return 'board_meeting'
  if (t === 'directorsdealings') return 'director_dealings'
  if (t === 'financial statements') return 'financial_statement'
  if (t === 'earningforcast') return 'earning_forecast'
  return 'other'
}

// Derive a stable unique ID for the OData item. SharePoint OData exposes
// `ID` and/or `Id`; we accept both and fall back to URL+Modified hash.
export function deriveItemId(item: XFinancialNewsItem): string {
  const anyItem = item as unknown as Record<string, unknown>
  const candidates = [anyItem.ID, anyItem.Id]
  for (const c of candidates) {
    if (c !== undefined && c !== null && c !== '') {
      return String(c)
    }
  }
  const url = item.URL?.Url ?? 'no-url'
  const mod = item.Modified ?? 'no-date'
  return `${url}#${mod}`
}

export async function fetchAllRecentFilings(
  isin: string,
  topN: number = 200,
): Promise<XFinancialNewsItem[]> {
  const filter = `InternationSecIN eq '${isin}'`
  const url = `${ODATA_BASE}?$filter=${encodeURIComponent(filter)}&$orderby=Modified%20desc&$top=${topN}`
  const res = await fetch(url, {
    headers: { Accept: 'application/json;odata=verbose' },
  })
  if (!res.ok) {
    throw new Error(`OData fetch failed for ISIN ${isin}: HTTP ${res.status}`)
  }
  const json = (await res.json()) as { d?: { results?: XFinancialNewsItem[] } }
  return json.d?.results ?? []
}
