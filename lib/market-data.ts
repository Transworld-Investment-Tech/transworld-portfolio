// ============================================================
// MARKET DATA — DIRECT NGX REST API + EXCHANGERATE
// ============================================================
// v20h: Richer data capture. The /statistics/equities/ endpoint returns
// a lot more than price + change — OHLC, prev close, volume, trades
// count, value traded (₦), sector, board classification, and the real
// trade date. v20f was reading only price + PercChange out of the
// response; v20h surfaces the rest through Quote.
//
// Also fixes a timezone-adjacent drift: /api/prices previously wrote
// price_date = server UTC today. When refreshes fired near UTC midnight
// (i.e. early WAT morning), that could record a Lagos trade as the
// "previous" day. We now use the API's TradeDate authoritatively and
// fall back to server today only if missing.
//
// Endpoint:
//   https://doclib.ngxgroup.com/REST/api/statistics/equities/
//     ?market=&sector=&orderby=&pageSize=300&pageNo=0
//
// v21i: Two additions:
//   1. cleanBracketSuffix() strips NGX regulatory-filing tags like
//      [MRF] (Missed Regulatory Filing), [DWL] (Delisting Watch List),
//      [RST] (Restricted), [BMF] (Breach of Market-Making Framework),
//      [BLS] (Breach of Listing Standards), [MRS] (Market Restriction),
//      [DIP] (Defunct in Progress) from Symbol and Company2. These tags
//      are operational alerts appended by NGX — not part of the ticker.
//      Stripping is safe because valid ticker characters never include
//      brackets.
//   2. Quote now carries a `name` field (from Company2) so the route
//      can auto-register unknown instruments with a meaningful display
//      name. fetchNGXPrices no longer pre-filters by validInstrumentIds
//      — that responsibility moved to app/api/prices/route.ts, which now
//      auto-registers unknown tickers (as approved=false) before
//      upserting prices. This keeps the fetcher independently testable
//      and means all 146 NGX equities are priced every run.
//
// Contract preserved from v20h:
//   - Quote.source still 'ngx'
//   - Quote.day_change still stores PERCENT change (historical semantic)
//   - NGX_TICKER_ALIASES still applied (MOBIL → MRS, GUARANTY → GTCO)
//   - Throws on empty results so /api/prices surfaces a clear error
// ============================================================

export interface Quote {
  instrument_id: string
  name?: string | null          // v21i: display name from API (Company2 field)
  price: number                 // API.ClosePrice
  day_change: number            // API.PercChange (percent; historical semantic preserved)
  source: string
  fetched_at: string

  // v20h additions — all optional, all nullable in the DB
  change_ngn?: number | null      // API.Change (absolute NGN change)
  open_price?: number | null      // API.OpeningPrice
  high_price?: number | null      // API.HighPrice
  low_price?: number | null       // API.LowPrice
  prev_close?: number | null      // API.PrevClosingPrice
  volume?: number | null          // API.Volume
  trades?: number | null          // API.Trades (count)
  value_ngn?: number | null       // API.Value (₦ traded)
  sector?: string | null          // API.Sector
  ngx_market?: string | null      // API.Market ("Premium Board" / "Main Board" / …)
  trade_date?: string | null      // YYYY-MM-DD parsed from API.TradeDate
}

// NGX's published ticker sometimes differs from our instrument_id.
export const NGX_TICKER_ALIASES: Record<string, string> = {
  MOBIL: 'MRS',       // MRS Oil Nigeria (historical Mobil ticker)
  GUARANTY: 'GTCO',
}

const NGX_API_URL =
  'https://doclib.ngxgroup.com/REST/api/statistics/equities/' +
  '?market=&sector=&orderby=&pageSize=300&pageNo=0'

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'

interface NGXApiRow {
  Symbol?: string
  Company2?: string | null      // v21i: display name e.g. "Lasaco Assurance Plc"
  ClosePrice?: number | null
  Change?: number | null
  PercChange?: number | null
  OpeningPrice?: number | null
  HighPrice?: number | null
  LowPrice?: number | null
  PrevClosingPrice?: number | null
  Volume?: number | null
  Trades?: number | null
  Value?: number | null
  Market?: string | null
  Sector?: string | null
  TradeDate?: string | null
  // Also present on the wire but not consumed: $id, Id.
  // CalculateChangePercent duplicates PercChange; we prefer the latter.
}

// Extract a finite number or null — mirrors "null-safe number" semantics.
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

// Extract YYYY-MM-DD directly from the TradeDate string to avoid any
// Date() object timezone shifting. The API returns formats like
// "2026-04-22T00:00:00" with no TZ suffix; treating it as a naive local
// date and slicing the first 10 chars is the safest read.
function parseTradeDate(s: unknown): string | null {
  if (typeof s !== 'string' || s.length < 10) return null
  const d = s.slice(0, 10)
  // Basic shape check: YYYY-MM-DD
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null
}

function cleanText(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length > 0 ? t : null
}

// v21i: Strip NGX regulatory-status bracket tags from a string.
// Valid ticker characters (letters, digits) never include brackets, so
// removing a trailing [...] token is always correct for Symbol processing.
// Applied to display names too so auto-registered instrument names are clean.
function cleanBracketSuffix(s: string): string {
  return s.replace(/\s*\[.*?\]\s*$/, '').trim()
}

// --------------------------------------------------------------
// Primary: Direct JSON call to NGX statistics endpoint
// --------------------------------------------------------------
// v21i: No longer accepts validInstrumentIds. Returns ALL rows that have
// a valid Symbol + positive ClosePrice. The route (app/api/prices/route.ts)
// owns the "do we know this instrument?" question and auto-registers
// unknown tickers before upserting prices.
export async function fetchNGXPrices(): Promise<Quote[]> {
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
    // v21i: strip bracket regulatory tags BEFORE alias lookup and dedup.
    const rawSymbol = cleanBracketSuffix((row.Symbol || '').trim().toUpperCase())
    if (!rawSymbol) continue

    // v21j-hotfix-3: use PrevClosingPrice as fallback when ClosePrice is
    // null or zero. Many NGX equities show "--" for Close on days where
    // they didn't trade (low-volume names, market-making halts, etc.).
    // Previously those rows were silently dropped, causing ~34 securities
    // to never be registered. Now they are priced at their last known
    // close. day_change is forced to 0 when using the fallback — no trade
    // means no movement to report.
    const closePrice = num(row.ClosePrice)
    const prevClose  = num(row.PrevClosingPrice)
    const price = (closePrice !== null && closePrice > 0) ? closePrice : prevClose
    if (price === null || price <= 0) continue

    // PercChange is only meaningful when the stock actually traded today.
    const pct = (closePrice !== null && closePrice > 0) ? num(row.PercChange) : null
    const day_change = pct === null ? 0 : pct

    const instrument_id = NGX_TICKER_ALIASES[rawSymbol] || rawSymbol

    // v21i: strip bracket tags from display name too (e.g. "Lasaco Assurance Plc [MRF]"
    // → "Lasaco Assurance Plc").
    const rawName = cleanText(row.Company2)
    const name = rawName ? cleanBracketSuffix(rawName) : null

    if (!seen.has(instrument_id)) {
      seen.set(instrument_id, {
        instrument_id,
        name,
        price,
        day_change,
        source: 'ngx',
        fetched_at: fetchedAt,

        // v20h additions
        change_ngn: num(row.Change),
        open_price: num(row.OpeningPrice),
        high_price: num(row.HighPrice),
        low_price:  num(row.LowPrice),
        prev_close: num(row.PrevClosingPrice),
        volume:     num(row.Volume),
        trades:     num(row.Trades),
        value_ngn:  num(row.Value),
        sector:     cleanText(row.Sector),
        ngx_market: cleanText(row.Market),
        trade_date: parseTradeDate(row.TradeDate),
      })
    }
  }

  const allQuotes = [...seen.values()]

  if (allQuotes.length === 0) {
    throw new Error(
      'NGX API returned rows but none had a valid Symbol + ClosePrice — field names may have changed'
    )
  }

  return allQuotes
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
// v21i: validInstrumentIds and other config options are accepted for
// back-compat but ignored — fetchNGXPrices now returns everything and
// the route handles filtering / auto-registration.
export async function fetchAllMarketData(config?: {
  validInstrumentIds?: Set<string>
  apifyKey?: string        // deprecated — ignored
  alphaVantageKey?: string // deprecated — ignored
}): Promise<{ quotes: Quote[]; fxRate: number | null; errors: string[] }> {
  const quotes: Quote[] = []
  const errors: string[] = []

  try {
    const ngxQuotes = await fetchNGXPrices()
    quotes.push(...ngxQuotes)
  } catch (e) {
    errors.push(`NGX: ${(e as Error).message}`)
  }

  const fxRate = await fetchFXRate()

  return { quotes, fxRate, errors }
}
