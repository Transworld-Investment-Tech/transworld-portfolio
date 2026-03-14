import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

// Sources to scrape for Nigerian dividend data
const SCRAPE_URLS = [
  // NGX corporate actions - official dividend declarations
  'https://ngxgroup.com/exchange/trade/equities/corporate-actions/',
  // NGX issuer filings
  'https://ngxgroup.com/exchange/trade/equities/company-financials/',
]

// Known NGX ticker → company name map for matching scraped results
const NGX_TICKERS: Record<string, string> = {
  ACCESSCORP: 'Access Holdings',
  ARADEL:     'Aradel Holdings',
  FCMB:       'FCMB Group',
  NB:         'Nigerian Breweries',
  NESTLE:     'Nestle Nigeria',
  UACN:       'UAC of Nigeria',
  UNILEVER:   'Unilever Nigeria',
  WAPCO:      'Lafarge Africa',
  GTCO:       'Guaranty Trust',
  ZENITHBANK: 'Zenith Bank',
  DANGCEM:    'Dangote Cement',
  SEPLAT:     'Seplat Energy',
  UBA:        'United Bank for Africa',
  STANBIC:    'Stanbic IBTC',
  FBNH:       'FBN Holdings',
  MTNN:       'MTN Nigeria',
}

interface ScrapedDividend {
  ticker:      string
  company:     string
  divPerShare: number
  divType:     string   // 'final' | 'interim' | 'special'
  declaredDate: string
  closureDate:  string | null
  paymentDate:  string | null
  source:       string
}

async function scrapeWithApify(urls: string[], apifyKey: string): Promise<any[]> {
  // Use Apify's cheerio-scraper for fast HTML extraction
  const runRes = await fetch(
    `https://api.apify.com/v2/acts/apify~cheerio-scraper/run-sync-get-dataset-items?token=${apifyKey}&timeout=60&memory=256`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        startUrls: urls.map(url => ({ url })),
        pageFunction: `async function pageFunction({ $, request, log }) {
          const results = []
          const url = request.url

          // NGX Corporate Actions page
          if (url.includes('corporate-actions')) {
            $('table tr, .dividend-row, [class*="action"]').each((i, el) => {
              const text = $(el).text().replace(/\\s+/g,' ').trim()
              if (text.toLowerCase().includes('dividend') || text.toLowerCase().includes('dps')) {
                results.push({ source: 'NGX Corporate Actions', raw: text, url })
              }
            })
            // Also try to get table data
            $('table').each((ti, table) => {
              const headers = []
              $(table).find('th').each((i, th) => headers.push($(th).text().trim()))
              $(table).find('tr').each((ri, row) => {
                if (ri === 0) return
                const cells = []
                $(row).find('td').each((i, td) => cells.push($(td).text().trim()))
                if (cells.length > 0) results.push({ source: 'NGX Table', headers, cells, url })
              })
            })
          }

          return results
        }`,
        proxyConfiguration: { useApifyProxy: true },
        maxRequestsPerCrawl: 5,
      }),
    }
  )

  if (!runRes.ok) {
    console.error('Apify run failed:', runRes.status, await runRes.text())
    return []
  }

  return runRes.json()
}

// Parse scraped items to extract dividend data
function parseDividendData(items: any[]): ScrapedDividend[] {
  const dividends: ScrapedDividend[] = []

  for (const item of items) {
    const raw = (item.raw || '').toLowerCase()
    const cells: string[] = item.cells || []
    const text = cells.join(' ').toLowerCase() + raw

    // Look for dividend-related content
    if (!text.includes('dividend') && !text.includes('dps') && !text.includes('kobo')) continue

    // Try to extract ticker
    let ticker = ''
    for (const [t] of Object.entries(NGX_TICKERS)) {
      if (text.includes(t.toLowerCase()) || text.includes(NGX_TICKERS[t].toLowerCase())) {
        ticker = t; break
      }
    }
    if (!ticker) continue

    // Try to extract DPS amount (look for ₦X.XX or X kobo patterns)
    let divPerShare = 0
    const nairaMatch = text.match(/[₦#]\s*(\d+\.?\d*)\s*(?:per share|\/share|kobo|k\b)?/)
    const koboMatch  = text.match(/(\d+\.?\d*)\s*kobo/)
    const dpsMatch   = text.match(/dps[:\s]+[₦#]?\s*(\d+\.?\d*)/)

    if (nairaMatch) divPerShare = parseFloat(nairaMatch[1])
    else if (koboMatch) divPerShare = parseFloat(koboMatch[1]) / 100
    else if (dpsMatch) divPerShare = parseFloat(dpsMatch[1])

    if (divPerShare === 0 && cells.length > 2) {
      // Try to find a number in cells that looks like DPS
      for (const cell of cells) {
        const num = parseFloat(cell.replace(/[₦,]/g, ''))
        if (!isNaN(num) && num > 0 && num < 1000) { divPerShare = num; break }
      }
    }

    // Extract dates
    const dateMatch = text.match(/\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}/)
    const declaredDate = dateMatch ? dateMatch[0] : new Date().toISOString().slice(0, 10)

    const divType = text.includes('interim') ? 'interim' : text.includes('special') ? 'special' : 'final'

    dividends.push({
      ticker,
      company:      NGX_TICKERS[ticker],
      divPerShare,
      divType,
      declaredDate,
      closureDate:  null,
      paymentDate:  null,
      source:       item.source || item.url || 'NGX scrape',
    })
  }

  return dividends
}

// Fallback: use Anthropic to get latest dividend data from training knowledge
// supplemented with web search context
async function getAIDividendEstimates(tickers: string[], anthropicKey: string): Promise<ScrapedDividend[]> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      messages: [{
        role: 'user',
        content: `You are a Nigerian capital markets expert. For these NGX-listed stocks, provide the most recent dividend information you know as of early 2026:

${tickers.map(t => `- ${t} (${NGX_TICKERS[t] || t})`).join('\n')}

For each stock respond in this EXACT JSON format only, no other text:
[
  {
    "ticker": "ACCESSCORP",
    "divPerShare": 0.70,
    "divYieldPct": 0.028,
    "divStatus": "paying",
    "divFrequency": "annual",
    "lastDivDate": "2024-07-15",
    "nextDivDate": "2025-07-01",
    "divNotes": "FY2024 final dividend ₦0.70/share declared April 2024"
  }
]

divStatus options: "paying" | "suspended" | "none"
Use null for unknown dates. Be accurate — if dividend is suspended, set divPerShare to 0.
Include any relevant notes about recapitalisation, forex impact, or dividend policy changes.`,
      }],
    }),
  })

  const d = await res.json()
  const text = d.content?.[0]?.text ?? '[]'

  try {
    const clean = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
    const parsed = JSON.parse(clean)
    return parsed.map((item: any) => ({
      ticker:       item.ticker,
      company:      NGX_TICKERS[item.ticker] || item.ticker,
      divPerShare:  item.divPerShare ?? 0,
      divType:      'final',
      declaredDate: item.lastDivDate ?? new Date().toISOString().slice(0, 10),
      closureDate:  null,
      paymentDate:  item.nextDivDate ?? null,
      source:       'AI estimate (Claude knowledge base)',
      // Extra fields for direct DB update
      divYieldPct:  item.divYieldPct ?? 0,
      divStatus:    item.divStatus ?? 'unknown',
      divFrequency: item.divFrequency ?? 'annual',
      lastDivDate:  item.lastDivDate ?? null,
      nextDivDate:  item.nextDivDate ?? null,
      divNotes:     item.divNotes ?? null,
    }))
  } catch {
    return []
  }
}

export const maxDuration = 120

export async function POST(req: NextRequest) {
  const apifyKey    = process.env.APIFY_API_KEY
  const anthropicKey = process.env.ANTHROPIC_API_KEY

  if (!anthropicKey) return NextResponse.json({ error: 'ANTHROPIC_API_KEY not set' }, { status: 500 })

  const db = supabaseAdmin()

  // Get all equity instruments
  const { data: instruments } = await db
    .from('instruments')
    .select('instrument_id, name, div_per_share, div_status')
    .eq('type', 'Stock')

  const tickers = (instruments ?? []).map((i: any) => i.instrument_id)

  let dividends: ScrapedDividend[] = []
  let method = 'ai'

  // Try Apify scraping first if key available
  if (apifyKey) {
    try {
      console.log('Attempting NGX scrape via Apify...')
      const scraped = await scrapeWithApify(SCRAPE_URLS, apifyKey)
      const parsed  = parseDividendData(scraped)
      if (parsed.length > 0) {
        dividends = parsed
        method    = 'apify'
        console.log(`Apify found ${parsed.length} dividend entries`)
      }
    } catch (err) {
      console.error('Apify scrape failed, falling back to AI:', err)
    }
  }

  // Always use AI estimates as the primary/supplementary source
  // (NGX page structure changes frequently; AI is more reliable for structured data)
  const aiEstimates = await getAIDividendEstimates(tickers.slice(0, 15), anthropicKey)
  if (aiEstimates.length > 0) {
    dividends = aiEstimates
    method = apifyKey && dividends.length > 0 ? 'apify+ai' : 'ai'
  }

  // Update instruments table
  const updates: string[] = []
  const errors: string[] = []

  for (const div of dividends) {
    const updateData: any = {
      div_per_share:  div.divPerShare ?? 0,
      div_yield_pct:  (div as any).divYieldPct ?? 0,
      div_status:     (div as any).divStatus ?? (div.divPerShare > 0 ? 'paying' : 'suspended'),
      div_frequency:  (div as any).divFrequency ?? 'annual',
      div_notes:      (div as any).divNotes ?? `Updated via ${method}. Source: ${div.source}`,
    }
    if ((div as any).lastDivDate) updateData.last_div_date = (div as any).lastDivDate
    if ((div as any).nextDivDate) updateData.next_div_date = (div as any).nextDivDate

    const { error } = await db.from('instruments')
      .update(updateData)
      .eq('instrument_id', div.ticker)

    if (error) errors.push(`${div.ticker}: ${error.message}`)
    else       updates.push(div.ticker)
  }

  return NextResponse.json({
    ok:      true,
    method,
    updated: updates,
    errors,
    total:   dividends.length,
    message: `Updated ${updates.length} instruments via ${method}`,
    data:    dividends.map(d => ({
      ticker:      d.ticker,
      divPerShare: d.divPerShare,
      divStatus:   (d as any).divStatus,
      source:      d.source,
    })),
  })
}
