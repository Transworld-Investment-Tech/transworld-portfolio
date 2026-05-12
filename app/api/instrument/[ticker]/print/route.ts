// v27cb-a-fix7h — Per-instrument HTML print/download route
//
// Server-renders the per-instrument page to standalone HTML with embedded
// styles. Operator clicks "Download report" on the per-instrument page; this
// returns Content-Type: text/html with Content-Disposition: attachment so the
// browser saves the file. Operator can then print to PDF via their browser.
//
// Implementation: reads the same data the per-instrument page uses by fetching
// /api/instrument/[ticker] internally, then passes to renderInstrumentReport()
// in lib/print-renderer.ts.

import { NextRequest, NextResponse } from 'next/server'
import { renderInstrumentReport } from '@/lib/print-renderer'

export const dynamic = 'force-dynamic'
export const maxDuration = 60
export const runtime = 'nodejs'

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ ticker: string }> },
) {
  const params = await ctx.params
  const ticker = params.ticker.toUpperCase()

  // Resolve the base URL from the incoming request. This avoids needing to
  // know the production domain at compile time.
  const baseUrl = new URL(req.url).origin
  const dataUrl = `${baseUrl}/api/instrument/${encodeURIComponent(ticker)}`

  let data: Record<string, unknown>
  try {
    const r = await fetch(dataUrl, {
      headers: { 'User-Agent': 'transworld-print-renderer/v27cb-a-fix7h' },
    })
    if (!r.ok) {
      return new NextResponse(`Failed to fetch instrument data: HTTP ${r.status}`, {
        status: 502,
        headers: { 'Content-Type': 'text/plain' },
      })
    }
    data = (await r.json()) as Record<string, unknown>
  } catch (e) {
    return new NextResponse(`Failed to fetch instrument data: ${e instanceof Error ? e.message : String(e)}`, {
      status: 502,
      headers: { 'Content-Type': 'text/plain' },
    })
  }

  if (!data || !data.instrument) {
    return new NextResponse(`No data available for ticker ${ticker}`, {
      status: 404,
      headers: { 'Content-Type': 'text/plain' },
    })
  }

  const html = renderInstrumentReport(data)
  const filename = `${ticker}_${new Date().toISOString().slice(0, 10)}.html`

  return new NextResponse(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  })
}
