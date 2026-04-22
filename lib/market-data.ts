// ============================================================
// MARKET DATA — DIRECT NGX SCRAPE + EXCHANGERATE
// ============================================================
// v16: The Apify actor `apify/trading-view-scraper` was removed
// from the Apify Store, causing silent 502s on Live Prices refresh.
// We now scrape NGX's own equities price list page directly. No
// third-party API key is required for the primary path.
//
// Source: https://ngxgroup.com/exchange/data/equities-price-list/
// Format: Server-rendered HTML. Each listed security appears in
// a <span class="ticker__list__item"> block containing:
//   - An <a href="...?symbol=SYMBOL&directory=companydirectory"> tag
//   - A price literal like "N123.45"
//   - A <span class="iconNull|iconUp|iconDown"> with "X.XX %"
//
// The page repeats each ticker in 6 scrolling marquees; we dedup
// by instrument_id and keep the first occurrence.
// ============================================================

export interface Quote {
  instrument_id: string
  price: number
  day_change: number
  source: string
  fetched_at: string
}

// NGX's published ticker sometimes differs from our instrument_id.
// This map translates NGX-published tickers to the internal IDs used
// by the `instruments` table in Supabase.
const NGX_TICKER_ALIASES: Record<string, string> = {
  FIRSTHOLDCO: 'FBNH',   // First HoldCo (was First Bank of Nigeria Holdings)
  MOBIL: 'MRS',          // MRS Oil Nigeria (historical Mobil ticker)
}

const NGX_EQUITIES_URL = 'https://ngxgroup.com/exchange/data/equities-price-list/'

// User-Agent is required — NGX returns 403 or a stripped page to default fetch UAs.
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

// --------------------------------------------------------------
// Primary: Direct scrape of NGX equities price list
// --------------------------------------------------------------
export async function fetchNGXPrices(
  validInstrumentIds?: Set<string>
): Promise<Quote[]> {
  const res = await fetch(NGX_EQUITIES_URL, {
    headers: {
      'User-Agent': BROWSER_UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    cache: 'no-store',
  })

  if (!res.ok) {
    throw new Error(`NGX fetch failed: HTTP ${res.status} ${res.statusText}`)
  }

  const html = await res.text()
  if (html.length < 5000) {
    throw new Error(
      `NGX returned unexpectedly short HTML (${html.length} bytes) — page structure may have changed`
    )
  }

  // Each ticker entry looks like:
  //   <a href="...?symbol=GTCO&directory=companydirectory" style="...">GTCO </a>
  //   N123.45
  //   <span class="iconNull">0.00 %</span>
  //
  // We capture from the URL `symbol=` (always clean, no bracket suffixes like [MRF])
  // through to the percentage span text.
  const re =
    /<a\s+href="[^"]*\?symbol=([A-Z0-9_]+)&[^"]*"[^>]*>[\s\S]*?<\/a>\s*N([\d,]+\.?\d*)\s*<span\s+class="(iconNull|iconUp|iconDown)"[^>]*>\s*([-+]?\d+\.?\d*)\s*%/g

  const fetchedAt = new Date().toISOString()
  const seen = new Map<string, Quote>()

  let match: RegExpExecArray | null
  while ((match = re.exec(html)) !== null) {
    const rawTicker = match[1]
    const price = parseFloat(match[2].replace(/,/g, ''))
    const direction = match[3]
    let change = parseFloat(match[4])

    if (!Number.isFinite(price) || price <= 0) continue
    if (!Number.isFinite(change)) change = 0
    if (direction === 'iconDown' && change > 0) change = -change
    if (direction === 'iconNull') change = 0

    // Translate NGX-published ticker → our instrument_id
    const instrument_id = NGX_TICKER_ALIASES[rawTicker] || rawTicker

    // If caller supplied a whitelist (the instruments we actually hold),
    // skip anything not in it. Prevents FK violations on market_prices insert
    // (see pitfall #5) and avoids bloating the price table with 400+ rows.
    if (validInstrumentIds && !validInstrumentIds.has(instrument_id)) continue

    // Dedup — NGX repeats each ticker in up to 6 marquees; take the first.
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

  if (seen.size === 0) {
    throw new Error(
      'NGX parse returned 0 quotes — regex may no longer match the page structure'
    )
  }

  return [...seen.values()]
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
// Alpha Vantage fallback (kept for back-compat; not used by default)
// Alpha Vantage has tight rate limits (5 req/min free tier) so it's
// impractical for 50+ tickers, but we keep the export so anything
// importing this symbol elsewhere still compiles.
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
// Aggregator — signature preserved for callers, implementation
// swapped to NGX-direct. The old (apifyKey, alphaVantageKey) config
// is ignored if passed; new callers should pass { validInstrumentIds }.
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
