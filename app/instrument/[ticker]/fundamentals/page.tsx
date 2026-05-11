// v27cb-a — Fundamentals editor page (server wrapper).
//
// Server component that does the initial fetch from /api/fundamentals-edit
// then hands off to the InstrumentFundamentalsClient interactive component.
// Inherits the cream-bg sidebar layout from app/instrument/[ticker]/layout.tsx.

import { headers } from 'next/headers'
import Link from 'next/link'
import InstrumentFundamentalsClient from './InstrumentFundamentalsClient'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

interface PageProps {
  params: Promise<{ ticker: string }>
}

async function getInitialData(ticker: string): Promise<unknown> {
  const h = await headers()
  const host = h.get('host') ?? 'localhost:3000'
  const proto = h.get('x-forwarded-proto') ?? (host.includes('localhost') ? 'http' : 'https')
  const url = `${proto}://${host}/api/fundamentals-edit?ticker=${encodeURIComponent(ticker)}`
  try {
    const res = await fetch(url, { cache: 'no-store' })
    return await res.json()
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export default async function FundamentalsEditorPage({ params }: PageProps) {
  const { ticker: tickerRaw } = await params
  const ticker = tickerRaw.toUpperCase()
  const initial = (await getInitialData(ticker)) as {
    ok: boolean
    error?: string
    instrument?: {
      // v27cb-a-fix5: added shares_outstanding + shares_outstanding_last_refreshed_at
      instrument_id: string
      name: string
      sector: string | null
      isin: string | null
      type: string
      shares_outstanding: number | null
      shares_outstanding_last_refreshed_at: string | null
    }
    periods?: Array<Record<string, unknown>>
  }

  if (!initial.ok) {
    return (
      <div style={{ padding: '32px 44px', maxWidth: 1200 }}>
        <div style={{ marginBottom: 16 }}>
          <Link
            href={`/instrument/${ticker}`}
            style={{
              fontSize: 11,
              letterSpacing: '0.14em',
              color: 'var(--gold, #b08b3e)',
              fontWeight: 600,
              textTransform: 'uppercase',
              textDecoration: 'none',
            }}
          >
            ← Back to {ticker}
          </Link>
        </div>
        <h1
          style={{
            fontFamily: '"Cormorant Garamond", Georgia, serif',
            fontWeight: 500,
            fontSize: 36,
            color: 'var(--text)',
            marginBottom: 12,
          }}
        >
          Fundamentals editor — {ticker}
        </h1>
        <div
          style={{
            padding: '20px 24px',
            background: 'rgba(166, 59, 59, 0.08)',
            border: '1px solid rgba(166, 59, 59, 0.3)',
            borderRadius: 4,
            color: 'var(--neg, #a63b3b)',
            fontSize: 13,
          }}
        >
          Failed to load fundamentals data for {ticker}: {initial.error ?? 'unknown error'}.
        </div>
      </div>
    )
  }

  return (
    <InstrumentFundamentalsClient
      ticker={ticker}
      instrument={initial.instrument!}
      initialPeriods={initial.periods ?? []}
    />
  )
}
