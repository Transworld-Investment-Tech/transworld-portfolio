// ============================================================
// MARKET DATA — APIFY (TradingView) + FMDQ + EXCHANGERATE
// ============================================================

interface ApifyQuote {
  symbol: string
  close?: number
  last?: number
  changePercent?: number
  change?: number
  volume?: number
}

export interface Quote {
  instrument_id: string
  price: number
  day_change: number
  source: string
  fetched_at: string
}

const NGX_SYMBOL_MAP: Record<string, string> = {
  'UBA':      'NGX:UBA',
  'GTCO':     'NGX:GTCO',
  'ZENITH':   'NGX:ZENITHBANK',
  'DANGCEM':  'NGX:DANGCEM',
  'STANBIC':  'NGX:STANBIC',
  'SEPLAT':   'NGX:SEPLAT',
}

const NGX_REVERSE_MAP: Record<string, string> = {
  'UBA':        'UBA',
  'GTCO':       'GTCO',
  'ZENITHBANK': 'ZENITH',
  'DANGCEM':    'DANGCEM',
  'STANBIC':    'STANBIC',
  'SEPLAT':     'SEPLAT',
}

// ---- Fetch NGX equity prices via Apify TradingView scraper ----
export async function fetchNGXPrices(apifyKey: string): Promise<Quote[]> {
  const symbols = Object.values(NGX_SYMBOL_MAP)

  const response = await fetch(
    `https://api.apify.com/v2/acts/apify~trading-view-scraper/run-sync-get-dataset-items?token=${apifyKey}&timeout=90`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbols, timeframe: 'D', bars: 1 }),
    }
  )

  if (!response.ok) {
    throw new Error(`Apify API error ${response.status}: ${await response.text()}`)
  }

  const data: ApifyQuote[] = await response.json()
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('Apify returned no data. Check your API key and actor permissions.')
  }

  return data
    .map(item => {
      const rawSymbol = (item.symbol || '').replace('NGX:', '')
      const instrument_id = NGX_REVERSE_MAP[rawSymbol]
      if (!instrument_id) return null
      const price = item.close ?? item.last
      if (!price) return null
      return {
        instrument_id,
        price,
        day_change: item.changePercent ?? item.change ?? 0,
        source: 'apify',
        fetched_at: new Date().toISOString(),
      } as Quote
    })
    .filter(Boolean) as Quote[]
}

// ---- Fetch USD/NGN from exchangerate-api (free, no key needed) ----
export async function fetchFXRate(): Promise<number | null> {
  try {
    const r = await fetch('https://api.exchangerate-api.com/v4/latest/USD')
    const d = await r.json()
    return d.rates?.NGN ?? null
  } catch {
    return null
  }
}

// ---- Alternative: Alpha Vantage (Nigerian stocks via .LAG suffix) ----
// GTCO → GTCO.LAG, UBA → UBA.LAG, ZENITH → ZENITHBANK.LAG
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

// ---- Combine all sources ----
export async function fetchAllMarketData(config: {
  apifyKey?: string
  alphaVantageKey?: string
}): Promise<{ quotes: Quote[]; fxRate: number | null; errors: string[] }> {
  const quotes: Quote[] = []
  const errors: string[] = []

  // 1. Apify (primary for NGX equities)
  if (config.apifyKey) {
    try {
      const ngxQuotes = await fetchNGXPrices(config.apifyKey)
      quotes.push(...ngxQuotes)
    } catch (e) {
      errors.push(`Apify: ${(e as Error).message}`)
      // Fallback to Alpha Vantage if available
      if (config.alphaVantageKey) {
        for (const [id, sym] of Object.entries({ UBA:'UBA', GTCO:'GTCO', ZENITH:'ZENITHBANK' })) {
          try {
            const q = await fetchAlphaVantage(sym, config.alphaVantageKey)
            if (q) quotes.push({ instrument_id: id, price: q.price, day_change: q.change, source: 'alpha_vantage', fetched_at: new Date().toISOString() })
          } catch {}
        }
      }
    }
  }

  // 2. FX rate (free)
  const fxRate = await fetchFXRate()

  return { quotes, fxRate, errors }
}
