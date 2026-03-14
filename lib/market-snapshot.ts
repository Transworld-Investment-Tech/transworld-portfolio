// Pre-fetch market data from free public APIs before calling Claude
// This avoids needing web_search inside the report (which causes rate limit issues)

export interface MarketSnapshot {
  fetchedAt: string
  ngxASI: { level: string; change: string; ytd: string }
  cbr: { mpr: string; inflation: string; lastMPC: string }
  fx: { usdNgn: string; source: string }
  brent: { price: string; change: string }
  ntbRates: { d91: string; d182: string; d364: string }
  fgnYields: { y5: string; y10: string }
  stocks: Record<string, StockData>
  note: string
}

export interface StockData {
  ticker: string
  price: string
  change: string
  source: string
}

// Fetch from exchangerate-api (free, no key needed)
async function fetchFX(): Promise<string> {
  try {
    const r = await fetch('https://api.exchangerate-api.com/v4/latest/USD', { next: { revalidate: 3600 } })
    const d = await r.json()
    return d?.rates?.NGN ? `₦${Math.round(d.rates.NGN).toLocaleString()}/USD` : 'N/A'
  } catch { return 'N/A' }
}

// Fetch NGX stock prices from Apify TradingView scraper
async function fetchNGXPrices(tickers: string[], apifyKey?: string): Promise<Record<string, StockData>> {
  const result: Record<string, StockData> = {}
  if (!apifyKey) {
    tickers.forEach(t => { result[t] = { ticker: t, price: 'N/A', change: 'N/A', source: 'no-key' } })
    return result
  }
  try {
    const symbols = tickers.map(t => `NGX:${t}`)
    const run = await fetch(`https://api.apify.com/v2/acts/harvested~trading-view-scraper/run-sync-get-dataset-items?token=${apifyKey}&timeout=30`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbols, timeframe: '1D', count: 1 }),
    })
    const items = await run.json()
    if (Array.isArray(items)) {
      items.forEach((item: any) => {
        const ticker = item.symbol?.replace('NGX:', '') ?? ''
        if (ticker) {
          result[ticker] = {
            ticker,
            price: item.close ? `₦${Number(item.close).toFixed(2)}` : 'N/A',
            change: item.change_p ? `${item.change_p > 0 ? '+' : ''}${Number(item.change_p).toFixed(2)}%` : 'N/A',
            source: 'Apify/TradingView',
          }
        }
      })
    }
  } catch (e) {
    console.error('Apify fetch failed:', e)
  }
  // Fill missing
  tickers.forEach(t => {
    if (!result[t]) result[t] = { ticker: t, price: 'N/A', change: 'N/A', source: 'unavailable' }
  })
  return result
}

export async function fetchMarketSnapshot(tickers: string[], apifyKey?: string): Promise<MarketSnapshot> {
  const [fxRate, stocks] = await Promise.all([
    fetchFX(),
    fetchNGXPrices(tickers, apifyKey),
  ])

  return {
    fetchedAt: new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }),
    ngxASI: {
      level: 'Search required',
      change: 'Search required',
      ytd: 'Search required',
    },
    cbr: {
      mpr: '26.50% (cut 50bps Feb 2026)',
      inflation: '15.1% headline (Jan 2026, NBS)',
      lastMPC: 'February 23-24, 2026',
    },
    fx: { usdNgn: fxRate, source: 'exchangerate-api.com' },
    brent: { price: 'Search required', change: 'Search required' },
    ntbRates: { d91: '15.80%', d182: '16.65%', d364: '18.47%' },
    fgnYields: { y5: '~15.5%', y10: '16.06%' },
    stocks,
    note: 'CBN/NTB/FGN data from last known values. Stock prices from Apify where available. Claude will supplement with web search for missing values only.',
  }
}
