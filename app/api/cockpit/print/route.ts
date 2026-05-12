// v27cb-a-fix7h — Cockpit HTML print/download route
//
// Renders the firmwide cockpit to standalone HTML. Same pattern as
// per-instrument print: server-fetches the cockpit summary endpoint, passes
// to renderCockpitReport() in lib/print-renderer.ts.
//
// This bundles the v27ay-era cockpit print/download leftover into the same
// shared lib/print-renderer.ts utility.

import { NextRequest, NextResponse } from 'next/server'
import { renderCockpitReport } from '@/lib/print-renderer'

export const dynamic = 'force-dynamic'
export const maxDuration = 60
export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const baseUrl = new URL(req.url).origin
  const dataUrl = `${baseUrl}/api/cockpit/summary`

  let data: Record<string, unknown>
  try {
    const r = await fetch(dataUrl, {
      headers: { 'User-Agent': 'transworld-print-renderer/v27cb-a-fix7h' },
    })
    if (!r.ok) {
      return new NextResponse(`Failed to fetch cockpit data: HTTP ${r.status}`, {
        status: 502,
        headers: { 'Content-Type': 'text/plain' },
      })
    }
    data = (await r.json()) as Record<string, unknown>
  } catch (e) {
    return new NextResponse(`Failed to fetch cockpit data: ${e instanceof Error ? e.message : String(e)}`, {
      status: 502,
      headers: { 'Content-Type': 'text/plain' },
    })
  }

  const html = renderCockpitReport(data)
  const filename = `cockpit_${new Date().toISOString().slice(0, 10)}.html`

  return new NextResponse(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  })
}
