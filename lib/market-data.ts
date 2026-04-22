// ============================================================
// MARKET DATA — DIRECT NGX REST API + EXCHANGERATE
// ============================================================
// v20f: NGX removed ticker data from their server-rendered HTML page
// (the page at /exchange/data/equities-price-list/ is now a static
// WordPress shell served by w3-total-cache; its Elementor ticker widget
// fetches prices client-side from a REST API). The v16b HTML parser
// returned 0 quotes against the new shell. Migrated to hit the same
// REST endpoint the official widget uses:
//
//   https://doclib.ngxgroup.com/REST/api/statistics/equities/
//     ?market=&sector=&orderby=&pageSize=300&pageNo=0
//
// Returns a JSON array of equity rows. Observed fields (sample):
//   Symbol            "ACCESSCORP"
//   ClosePrice        31.0
//   Change            1.05        (absolute NGN change vs prev close)
//   PercChange        3.51        (percent change; nullable on untraded days)
//   PrevClosingPrice  29.95
//   OpeningPrice, HighPrice, LowPrice, Volume, Trades, Value
//   Market            "Premium Board" | "Main Board" | ...
//   Sector            "FINANCIAL SERVICES" | ...
//   Company2          "ACCESSCORP [MRF]"  (display name + board flag)
//   TradeDate         "2026-04-22T00:00:00"
//
// Behaviour / contract preserved from v16b:
//   - Returns Quote[] with the same shape
//   - source field still 'ngx'
//   - day_change stores PERCENT change (historical convention;
//     matches what the old HTML parser captured from `0.95 %` text)
//   - NGX_TICKER_ALIASES still applied (MOBIL → MRS)
//   - validInstrumentIds filter applied AFTER parse for diagnosability
//   - Throws on empty results so /api/prices surfaces a clear error
//
// Advantages vs the old HTML scrape:
//   - No chunking, no icon-class parsing, no directory disambiguation.
//     The old 3-directory ambiguity (companydirectory vs bonddirectory
//     vs etpdirectory) is gone: this endpoint only returns equities.
//   - PercChange is available with full float precision (old HTML
//     rounded to 2 decimals).
//   - Symbol is already clean (no [MRF]/[DWL]/[MRS] bracket suffixes
//     to strip — those now live in Company2, which we ignore).
// ============================================================

export interface Quote {
  instrument_id: string
  price: number
  day_change: number
  source: string
  fetched_at: string
}

// NGX's published ticker sometimes differs from our instrument_id.
// v19c note: previously aliased FIRSTHOLDCO → FBNH; that alias was
// removed when FIRSTHOLDCO became canonical and FBNH was merged.
const NGX_TICKER_ALIASES: Record<string, string> = {
  MOBIL: 'MRS', // MRS Oil Nigeria (historical Mobil ticker)
}

// pageSize=300 easily covers the ~148-row NGX equity universe.
// Passing empty market/sector/orderby returns the full list.
const NGX_API_URL =
  'https://doclib.ngxgroup.com/REST/api/statistics/equities/' +
  '?market=&sector=&orderby=&pageSize=300&pageNo=0'

// The doclib subdomain appears to respond to a plain fetch, but keep
// a realistic User-Agent as defence against future UA-based filtering.
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

interface NGXApiRow {
  Symbol?: string
  ClosePrice?: number | null
  Change?: number | null
  PercChange?: number | null
  TradeDate?: string
  // Other fields (OpeningPrice, HighPrice, LowPrice, Volume, Trades,
  // Value, Market, Sector, Company2, Id, $id) exist but we don't
  // consume them here. Adding them would require market_prices
  // schema changes.
}

// --------------------------------------------------------------
// Primary: Direct JSON call to NGX statistics endpoint
// --------------------------------------------------------------
export async function fetchNGXPrices(
  validInstrumentIds?: Set<string>
): Promise<Quote[]> {
  const res = await fetch(NGX_API_URL, {
    headers: {
      'User-Agent': BROWSER_UA,
      Accept: 'application/json, text/plain, */*',
    },
    cache: 'no-store',
  })

  if (!res.ok) {
    throw new Error(`NGX fetch failed: HTTP ${res.status} ${res.statusText}`)
  }

  const text = await res.text()
  let rows: NGXApiRow[]
  try {
    const parsed = JSON.parse(text)
    if (!Array.isArray(parsed)) {
      throw new Error(
        `NGX API returned non-array (got ${typeof parsed}) — endpoint contract may have changed`
      )
    }
    rows = parsed as NGXApiRow[]
  } catch (e) {
    throw new Error(
      `NGX API response not valid JSON (${(e as Error).message}) — first 200 chars: ${text.slice(0, 200)}`
    )
  }

  if (rows.length === 0) {
    throw new Error('NGX API returned 0 rows — possibly a market holiday; check upstream')
  }

  const fetchedAt = new Date().toISOString()
  const seen = new Map<string, Quote>()

  for (const row of rows) {
    const symbol = (row.Symbol || '').trim().toUpperCase()
    if (!symbol) continue

    // ClosePrice must be a positive number to be useful. Some rows for
    // suspended or untraded equities come through with null ClosePrice.
    const price = typeof row.ClosePrice === 'number' ? row.ClosePrice : NaN
    if (!Number.isFinite(price) || price <= 0) continue

    // PercChange is nullable for zero-volume days (see ACADEMY, AFRINSURE
    // in the observed response); treat null/NaN as 0% change.
    const rawPct = typeof row.PercChange === 'number' ? row.PercChange : 0
    const change = Number.isFinite(rawPct) ? rawPct : 0

    const instrument_id = NGX_TICKER_ALIASES[symbol] || symbol

    // Dedup by instrument_id. The API is a flat equity list so duplicates
    // shouldn't occur, but keep the dedup as belt-and-braces in case a
    // future API change introduces them.
    if (!seen.has(instrument_id)) {
      seen.set(instrument_id, {
        instrument_id,
        price,
        day_change: change,
        source: 'ngx',
        fetched_at: fetchedAt,
      })
    }
  }

  const allQuotes = [...seen.values()]

  if (allQuotes.length === 0) {
    throw new Error(
      'NGX API returned rows but none had a valid Symbol + ClosePrice — field names may have changed'
    )
  }

  // Apply caller-supplied whitelist AFTER parsing so the parse itself is
  // independently diagnosable (raw count returned irrespective of holdings).
  return validInstrumentIds
    ? allQuotes.filter((q) => validInstrumentIds.has(q.instrument_id))
    : allQuotes
}

// --------------------------------------------------------------
// FX rate (USD → NGN) — free endpoint, no key
// --------------------------------------------------------------
export async function fetchFXRate(): Promise<number | null> {
  try {
    const r = await fetch('https://api.exchangerate-api.com/v4/latest/USD', {
      cache: 'no-store',
    })
    const d = await r.json()
    return d.rates?.NGN ?? null
  } catch {
    return null
  }
}

// --------------------------------------------------------------
// Alpha Vantage stub — kept for back-compat; not used in the primary path.
// --------------------------------------------------------------
export async function fetchAlphaVantage(
  symbol: string,
  apiKey: string
): Promise<{ price: number; change: number } | null> {
  try {
    const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}.LAG&apikey=${apiKey}`
    const r = await fetch(url)
    const d = await r.json()
    const q = d['Global Quote']
    if (!q || !q['05. price']) return null
    return {
      price: parseFloat(q['05. price']),
      change: parseFloat(q['10. change percent']?.replace('%', '') || '0'),
    }
  } catch {
    return null
  }
}

// --------------------------------------------------------------
// Aggregator — signature preserved for callers
// --------------------------------------------------------------
export async function fetchAllMarketData(config: {
  validInstrumentIds?: Set<string>
  apifyKey?: string        // deprecated — ignored
  alphaVantageKey?: string // deprecated — ignored
}): Promise<{ quotes: Quote[]; fxRate: number | null; errors: string[] }> {
  const quotes: Quote[] = []
  const errors: string[] = []

  try {
    const ngxQuotes = await fetchNGXPrices(config.validInstrumentIds)
    quotes.push(...ngxQuotes)
  } catch (e) {
    errors.push(`NGX: ${(e as Error).message}`)
  }

  const fxRate = await fetchFXRate()

  return { quotes, fxRate, errors }
}
