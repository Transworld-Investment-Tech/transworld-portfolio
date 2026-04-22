// ============================================================
// MARKET DATA — DIRECT NGX SCRAPE + EXCHANGERATE
// ============================================================
// v16b fix: v16's single-regex approach had a lazy quantifier that
// crossed ticker boundaries and also only accepted icon classes
// `iconNull|iconUp|iconDown`. NGX actually uses `iconNull|iconGreen|
// iconRed`, so every mover (gainer or loser) was rejected within its
// own block, and the regex then consumed the next flat ticker's price
// downstream. Result: FCMB stored at 146.14 instead of 13.50, etc.
//
// This rewrite splits the HTML into per-ticker chunks FIRST, then parses
// each chunk in isolation. A chunk that doesn't yield a complete
// (symbol, price, change) triple is discarded — it cannot contaminate
// other tickers by construction.
//
// Source: https://ngxgroup.com/exchange/data/equities-price-list/
// Each listing appears as:
//   <span class="ticker__list__item">
//     <a href="...?symbol=SYMBOL&directory=DIR">SYMBOL [FLAG]</a>
//     NPRICE
//     <span class="icon{Null|Green|Red}">PCT %</span>
//   </span>
//
// The same ticker can appear under three directories on this page:
//   companydirectory   (equities — what we want)
//   bonddirectory      (debt instruments; irrelevant for our equity holdings)
//   etpdirectory       (exchange-traded products)
// We restrict to `companydirectory` so an FCMB equity isn't
// shadowed by an FCMB bond listing with a different price.
// ============================================================

export interface Quote {
  instrument_id: string
  price: number
  day_change: number
  source: string
  fetched_at: string
}

// NGX's published ticker sometimes differs from our instrument_id.
// Extend this map as new mismatches are discovered.
const NGX_TICKER_ALIASES: Record<string, string> = {
  FIRSTHOLDCO: 'FBNH',   // First HoldCo (was First Bank of Nigeria Holdings)
  MOBIL: 'MRS',          // MRS Oil Nigeria (historical Mobil ticker)
}

const NGX_EQUITIES_URL = 'https://ngxgroup.com/exchange/data/equities-price-list/'

// User-Agent required — NGX returns 403 or a stripped page for default fetch UA.
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

// Split the HTML into per-ticker chunks and parse each independently.
// Returns only chunks that contain all three fields; silently drops malformed ones.
function parseNGXChunks(html: string): Quote[] {
  // Split on the opening <span class="ticker__list__item"> tag. The first
  // element is the preamble (head, nav, etc.) and has no ticker; skip it.
  const chunks = html.split(/<span\s+class="ticker__list__item">/i).slice(1)

  const fetchedAt = new Date().toISOString()
  const seen = new Map<string, Quote>()

  for (const chunk of chunks) {
    // Truncate at the next chunk boundary so we can't accidentally peek
    // forward. (split() already did this, but belt-and-braces.)
    const block = chunk.split('</span>')[0] + (chunk.includes('</span>') ? '</span>' : '')

    // Extract the symbol from the ?symbol= URL param — always alphabetic,
    // immune to bracket suffixes like "FCMB [MRF]" in the display text.
    // The href looks like: ...?symbol=FCMB&directory=companydirectory
    // value of `directory` is one of: companydirectory | bonddirectory | etpdirectory
    const symbolMatch = /\?symbol=([A-Z0-9_]+)&directory=([a-z]+)directory/i.exec(chunk)
    if (!symbolMatch) continue

    const rawTicker = symbolMatch[1]
    const directory = (symbolMatch[2] || '').toLowerCase()

    // Restrict to equities. bond/etp entries for the same symbol are a
    // different security and must not be upserted under the equity's ID.
    if (directory !== 'company') continue

    // Extract price: an `N` immediately followed by digits, after the </a>.
    // Anchor to the start of the chunk so we don't match numbers inside
    // other attributes or scripts that happen to start with N.
    const priceMatch = /<\/a>\s*N([\d,]+\.?\d*)\s*<span\s+class="icon/.exec(chunk)
    if (!priceMatch) continue
    const price = parseFloat(priceMatch[1].replace(/,/g, ''))
    if (!Number.isFinite(price) || price <= 0) continue

    // Extract direction + magnitude from the icon span. Accept ANY icon class
    // (iconNull, iconGreen, iconRed, and any future variants).
    const iconMatch = /<span\s+class="icon([A-Za-z]+)"[^>]*>\s*([-+]?\d+\.?\d*)\s*%/.exec(chunk)
    if (!iconMatch) continue

    const iconVariant = iconMatch[1].toLowerCase()
    let change = parseFloat(iconMatch[2])
    if (!Number.isFinite(change)) change = 0

    // Derive sign from class name. "null" = flat, "red"/"down" = negative,
    // everything else (green/up) = positive.
    if (iconVariant === 'null') {
      change = 0
    } else if (iconVariant === 'red' || iconVariant === 'down') {
      if (change > 0) change = -change
    }
    // iconGreen/iconUp: leave as-is (already positive or parsed as-is)

    const instrument_id = NGX_TICKER_ALIASES[rawTicker] || rawTicker

    // Dedup by instrument_id. Since we've restricted to companydirectory,
    // there should now be at most one equity entry per symbol on the page,
    // but keep the dedup as defence in depth.
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

  return [...seen.values()]
}

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

  const allQuotes = parseNGXChunks(html)

  if (allQuotes.length === 0) {
    throw new Error(
      'NGX parse yielded 0 quotes — page structure may have changed, regex no longer matches'
    )
  }

  // Apply caller-supplied whitelist AFTER parsing so the parse itself is
  // independently diagnosable (count returned irrespective of holdings).
  const filtered = validInstrumentIds
    ? allQuotes.filter((q) => validInstrumentIds.has(q.instrument_id))
    : allQuotes

  return filtered
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
