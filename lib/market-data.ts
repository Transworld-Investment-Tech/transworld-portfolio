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

// Full NGX instrument map — instrument_id → TradingView symbol
// TradingView uses NGX: prefix for Nigerian Exchange Group stocks
const NGX_SYMBOL_MAP: Record<string, string> = {
  // Banking & Finance
  'ACCESSCORP':  'NGX:ACCESSCORP',
  'GTCO':        'NGX:GTCO',
  'ZENITHBANK':  'NGX:ZENITHBANK',
  'UBA':         'NGX:UBA',
  'FBNH':        'NGX:FBNH',
  'FIRSTHOLDCO': 'NGX:FBNH',
  'FIDELITYBK':  'NGX:FIDELITYBK',
  'FCMB':        'NGX:FCMB',
  'UBN':         'NGX:UBN',
  'WEMABANK':    'NGX:WEMABANK',
  'STANBIC':     'NGX:STANBIC',
  'STERLINGNG':  'NGX:STERLINGNG',
  'AFRIPRUD':    'NGX:AFRIPRUD',
  'UCAP':        'NGX:UCAP',
  // Oil & Gas
  'SEPLAT':      'NGX:SEPLAT',
  'ARADEL':      'NGX:ARADEL',
  'OANDO':       'NGX:OANDO',
  'ETERNA':      'NGX:ETERNA',
  'CONOIL':      'NGX:CONOIL',
  'MRS':         'NGX:MRS',
  'TOTAL':       'NGX:TOTAL',
  // Telecoms & Tech
  'MTNN':        'NGX:MTNN',
  'AIRTELAFRI':  'NGX:AIRTELAFRI',
  // Industrial & Cement
  'DANGCEM':     'NGX:DANGCEM',
  'WAPCO':       'NGX:WAPCO',
  'JBERGER':     'NGX:JBERGER',
  'SCOA':        'NGX:SCOA',
  // Consumer Goods & FMCG
  'NB':          'NGX:NB',
  'GUINNESS':    'NGX:GUINNESS',
  'NESTLE':      'NGX:NESTLE',
  'UNILEVER':    'NGX:UNILEVER',
  'DANGSUGAR':   'NGX:DANGSUGAR',
  'FLOURMILL':   'NGX:FLOURMILL',
  'CADBURY':     'NGX:CADBURY',
  'PZ':          'NGX:PZ',
  'VITAFOAM':    'NGX:VITAFOAM',
  // Agriculture
  'OKOMUOIL':    'NGX:OKOMUOIL',
  'PRESCO':      'NGX:PRESCO',
  // Conglomerates
  'UACN':        'NGX:UACN',
  'TRANSCORP':   'NGX:TRANSCORP',
  // Insurance
  'AIICO':       'NGX:AIICO',
  'WAPIC':       'NGX:WAPIC',
  'CUSTODIAN':   'NGX:CUSTODIAN',
  'PRESTIGE':    'NGX:PRESTIGE',
  'MANSARD':     'NGX:MANSARD',
  // Services & Others
  'NAHCO':       'NGX:NAHCO',
  'JOHNHOLT':    'NGX:JOHNHOLT',
  'TRIPPLEG':    'NGX:TRIPPLEG',
  'UPDC':        'NGX:UPDC',
  'UPDCREIT':    'NGX:UPDCREIT',
  'ETI':         'NGX:ETI',
  'ZENITH':      'NGX:ZENITHBANK',   // legacy alias
}

// Reverse map: TradingView symbol suffix → instrument_id
const NGX_REVERSE_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(NGX_SYMBOL_MAP).map(([id, sym]) => [sym.replace('NGX:', ''), id])
)

// ---- Fetch NGX equity prices via Apify TradingView scraper ----
export async function fetchNGXPrices(apifyKey: string): Promise<Quote[]> {
  // Deduplicate symbols (some instrument_ids map to same TradingView symbol)
  const symbols = [...new Set(Object.values(NGX_SYMBOL_MAP))]

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
