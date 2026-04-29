/**
 * app/api/admin/portfolios/[id]/retired-shares/html/route.ts — v27z
 *
 * Returns a fully self-contained HTML document for the retired-shares
 * report. Fetched via a plain <a href download> link on the page —
 * no client-side JS needed. Pattern mirrors lib/html-report.ts +
 * /api/export/route.ts.
 *
 * Why this exists: the in-app print preview (v27x → v27y) kept clipping
 * to a single A4 page despite enhanced @media print rules in globals.css.
 * Three layers of stacked min-height: 100vh constraints (Tailwind
 * min-h-screen on body, .hybrid-page class, inline style) plus complex
 * CSS variable inheritance made the live page hostile to print engines.
 *
 * The downloaded HTML side-steps all of that: it's a standalone document
 * with inline <style> rules and Google Fonts CDN imports — opens cleanly
 * in any browser, prints correctly via Cmd+P, saves correctly via Cmd+S.
 *
 * Endpoint: GET /api/admin/portfolios/[id]/retired-shares/html
 *           ?download=1   → forces Content-Disposition: attachment
 *                           (default: inline, opens in new tab)
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import {
  renderRetiredSharesHTML,
  type RetiredRowForReport,
  type RetiredSharesReportData,
} from '@/lib/retired-shares-html'

export const runtime = 'nodejs'
export const maxDuration = 30
export const dynamic = 'force-dynamic'

function admin(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars')
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  try {
    const { id: portfolioId } = await ctx.params
    if (!portfolioId) {
      return NextResponse.json({ error: 'portfolio id required' }, { status: 400 })
    }

    const url = new URL(req.url)
    const forceDownload = url.searchParams.get('download') === '1'

    const db = admin()

    // ── Fetch portfolio metadata ──────────────────────────────────
    const { data: pData, error: pErr } = await db
      .from('portfolios')
      .select('id, label, name, clients(code, name)')
      .eq('id', portfolioId)
      .single()
    if (pErr || !pData) {
      return NextResponse.json(
        { error: pErr?.message ?? 'portfolio not found' },
        { status: 404 }
      )
    }
    const clientObj = (pData as any).clients
    const portfolio = {
      id:          (pData as any).id,
      label:       (pData as any).label,
      name:        (pData as any).name,
      client_name: clientObj?.name ?? '',
      client_code: clientObj?.code ?? '',
    }

    // ── Fetch retired transactions ────────────────────────────────
    const { data: txData, error: txErr } = await db
      .from('transactions')
      .select(`
        id, trade_date, instrument_id, quantity, price, amount,
        notes, external_ref,
        instruments(name)
      `)
      .eq('portfolio_id', portfolioId)
      .or('external_ref.like.corp-action-zero-recovery-%,external_ref.like.corp-action-delisting-%')
      .order('trade_date', { ascending: false })
      .limit(500)

    if (txErr) {
      return NextResponse.json({ error: txErr.message }, { status: 500 })
    }

    const rows: RetiredRowForReport[] = (txData ?? []).map((r: any) => ({
      id:              r.id,
      trade_date:      r.trade_date,
      instrument_id:   r.instrument_id,
      instrument_name: r.instruments?.name ?? '',
      quantity:        Number(r.quantity ?? 0),
      price:           Number(r.price ?? 0),
      amount:          Number(r.amount ?? 0),
      notes:           r.notes,
      external_ref:    r.external_ref,
    }))

    const data: RetiredSharesReportData = {
      portfolio,
      zeroRecovery: rows.filter(r => r.external_ref.startsWith('corp-action-zero-recovery-')),
      delisting:    rows.filter(r => r.external_ref.startsWith('corp-action-delisting-')),
      generatedAt:  new Date().toISOString(),
    }

    const html = renderRetiredSharesHTML(data)

    // Sanitise filename: client code + portfolio label + date.
    const today = new Date().toISOString().slice(0, 10)
    const filename = `retired-shares-${portfolio.client_code || 'portfolio'}-${portfolio.label || ''}-${today}.html`
      .replace(/\s+/g, '-')

    const disposition = forceDownload
      ? `attachment; filename="${filename}"`
      : `inline; filename="${filename}"`

    return new NextResponse(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Disposition': disposition,
        'Cache-Control': 'no-store',
      },
    })
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'unknown error' },
      { status: 500 }
    )
  }
}
