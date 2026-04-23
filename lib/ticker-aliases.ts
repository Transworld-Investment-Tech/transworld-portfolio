import type { SupabaseClient } from '@supabase/supabase-js'
import { NGX_TICKER_ALIASES } from './market-data'

// v21l: DB-driven ticker alias map.
//
// The hardcoded NGX_TICKER_ALIASES const in lib/market-data.ts remains
// as a permanent fallback — a DB outage must never silently break the
// broker ingestion pipeline. This function merges the DB entries ON TOP
// of the hardcoded entries (DB wins on conflict) so new aliases added
// in the admin UI take effect immediately without a code deploy.
//
// Callers merge the result with the hardcoded map themselves via:
//   const aliasMap = await getAliasMap(db)
//   // aliasMap already contains the hardcoded entries as baseline
//   const canonical = aliasMap[ticker.toUpperCase()] ?? ticker

export async function getAliasMap(
  db: SupabaseClient
): Promise<Record<string, string>> {
  // Start with the hardcoded map as baseline so callers don't need
  // to import it separately.
  const merged: Record<string, string> = { ...NGX_TICKER_ALIASES }

  try {
    const { data, error } = await db
      .from('ticker_aliases')
      .select('broker_ticker, canonical_id')

    if (error) {
      console.warn('[ticker-aliases] DB load failed, using hardcoded fallback:', error.message)
      return merged
    }

    for (const row of data ?? []) {
      if (row.broker_ticker && row.canonical_id) {
        merged[String(row.broker_ticker).toUpperCase()] = String(row.canonical_id)
      }
    }
  } catch (e: any) {
    console.warn('[ticker-aliases] getAliasMap error, using hardcoded fallback:', e.message)
  }

  return merged
}

// Resolve a single ticker through the alias map.
// Upper-cases the input, checks map, falls back to the original ticker.
// Returns null for null/undefined/empty inputs.
export function applyAlias(
  ticker: string | null | undefined,
  aliasMap: Record<string, string>
): string | null {
  if (ticker === null || ticker === undefined) return null
  const up = String(ticker).toUpperCase()
  if (up === '') return null
  return aliasMap[up] ?? up
}
