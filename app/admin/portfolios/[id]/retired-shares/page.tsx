/**
 * app/admin/portfolios/[id]/retired-shares/page.tsx — v27q-fix5 (NEW)
 *
 * Report page listing positions retired from a portfolio via the variance
 * panel's reconciliation flow. Two sections:
 *
 *   1. Zero-recovery writeoffs — Force-Zero toggle was used. Positions
 *      retired with no consideration recorded. Client may be entitled to
 *      payment from the issuer's registrar (license revocation, share
 *      consolidation that compressed unit count, etc.) and never received
 *      it. Highest-priority follow-up.
 *
 *   2. Delisting writeoffs — picker date set to delisting era, price was
 *      the scheme/last-traded price. Scheme consideration would have been
 *      paid directly to the client (not to the broker). Worth verifying
 *      with registrar that payment was received.
 *
 * Tagged in transactions via external_ref:
 *   - corp-action-zero-recovery-<sessionId>
 *   - corp-action-delisting-<sessionId>
 */

import { createClient } from '@supabase/supabase-js'
import Link from 'next/link'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

interface RetiredRow {
  id: string
  trade_date: string
  instrument_id: string
  instrument_name: string
  quantity: number
  price: number
  amount: number
  notes: string | null
  external_ref: string
  created_at: string
}

interface PortfolioInfo {
  id: string
  label: string
  name: string
  client_name: string
  client_code: string
}

async function fetchData(portfolioId: string): Promise<{
  portfolio: PortfolioInfo | null
  zeroRecovery: RetiredRow[]
  delisting: RetiredRow[]
  error?: string
}> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    return { portfolio: null, zeroRecovery: [], delisting: [], error: 'Missing Supabase env vars' }
  }
  const db = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { data: pData, error: pErr } = await db
    .from('portfolios')
    .select('id, label, name, clients(code, name)')
    .eq('id', portfolioId)
    .single()
  if (pErr || !pData) {
    return { portfolio: null, zeroRecovery: [], delisting: [], error: pErr?.message ?? 'portfolio not found' }
  }
  const clientObj = (pData as any).clients
  const portfolio: PortfolioInfo = {
    id:          (pData as any).id,
    label:       (pData as any).label,
    name:        (pData as any).name,
    client_name: clientObj?.name ?? '',
    client_code: clientObj?.code ?? '',
  }

  const { data: txData, error: txErr } = await db
    .from('transactions')
    .select(`
      id, trade_date, instrument_id, quantity, price, amount,
      notes, external_ref, created_at,
      instruments(name)
    `)
    .eq('portfolio_id', portfolioId)
    .or('external_ref.like.corp-action-zero-recovery-%,external_ref.like.corp-action-delisting-%')
    .order('trade_date', { ascending: false })
    .limit(500)

  if (txErr) {
    return { portfolio, zeroRecovery: [], delisting: [], error: txErr.message }
  }

  const rows: RetiredRow[] = (txData ?? []).map((r: any) => ({
    id:              r.id,
    trade_date:      r.trade_date,
    instrument_id:   r.instrument_id,
    instrument_name: r.instruments?.name ?? '',
    quantity:        Number(r.quantity ?? 0),
    price:           Number(r.price ?? 0),
    amount:          Number(r.amount ?? 0),
    notes:           r.notes,
    external_ref:    r.external_ref,
    created_at:      r.created_at,
  }))

  const zeroRecovery = rows.filter(r => r.external_ref.startsWith('corp-action-zero-recovery-'))
  const delisting    = rows.filter(r => r.external_ref.startsWith('corp-action-delisting-'))

  return { portfolio, zeroRecovery, delisting }
}

function fmtNum(n: number, digits = 0): string {
  return n.toLocaleString('en-GB', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

function fmtNaira(n: number): string {
  return `₦${n.toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

export default async function RetiredSharesPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const { portfolio, zeroRecovery, delisting, error } = await fetchData(id)

  if (error || !portfolio) {
    return (
      <div className="main">
        <div className="page-head">
          <div>
            <div className="crumb">Retired Shares Report</div>
            <h1>Error</h1>
          </div>
        </div>
        <div style={{ padding: 24, color: 'var(--neg)' }}>
          {error ?? 'Portfolio not found'}
        </div>
      </div>
    )
  }

  const totalCount = zeroRecovery.length + delisting.length

  return (
    <div className="main">
      <div className="page-head">
        <div>
          <div className="crumb">{portfolio.client_name} · Portfolio {portfolio.label}</div>
          <h1>Retired Shares</h1>
        </div>
        <div className="page-actions">
          <Link href={`/portfolio/${portfolio.id}/holdings`}>
            <button className="btn">← Back to portfolio</button>
          </Link>
        </div>
      </div>

      {totalCount === 0 ? (
        <div
          style={{
            padding: 32,
            textAlign: 'center',
            background: 'var(--card)',
            border: '1px solid var(--border)',
            borderRadius: 5,
            color: 'var(--text-2)',
          }}
        >
          No retired-share records for this portfolio.
        </div>
      ) : (
        <>
          {/* Disclaimer banner */}
          <div
            style={{
              padding: '14px 18px',
              background: 'rgba(176, 139, 62, 0.08)',
              border: '1px solid rgba(176, 139, 62, 0.3)',
              borderRadius: 4,
              marginBottom: 24,
              fontSize: 12,
              lineHeight: 1.6,
              color: 'var(--text)',
            }}
          >
            <strong style={{ color: 'var(--gold)' }}>For client follow-up.</strong>{' '}
            Positions retired from the portfolio that may have outstanding consideration
            from the issuer&apos;s registrar. Operator should contact each registrar with
            the client&apos;s CSCS number and original holding details to confirm payment
            status. This report is a checklist for client service, not a record of unpaid amounts.
          </div>

          {/* Section 1: Zero-recovery writeoffs */}
          {zeroRecovery.length > 0 && (
            <div className="panel" style={{ marginBottom: 20 }}>
              <div className="panel-header">
                <div>
                  <div className="panel-title">Zero-Recovery Writeoffs</div>
                  <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 4 }}>
                    Retired with no recorded consideration · {zeroRecovery.length} position{zeroRecovery.length === 1 ? '' : 's'} · HIGH PRIORITY
                  </div>
                </div>
                <span className="pill pill-breach">Action recommended</span>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>Ticker</th>
                    <th>Name</th>
                    <th className="num">Quantity retired</th>
                    <th>Retirement date</th>
                    <th>Reason / corporate action</th>
                  </tr>
                </thead>
                <tbody>
                  {zeroRecovery.map(r => (
                    <tr key={r.id}>
                      <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.instrument_id}</td>
                      <td style={{ fontSize: 11, color: 'var(--text-2)' }}>{r.instrument_name || '—'}</td>
                      <td className="num num-serif">{fmtNum(r.quantity)}</td>
                      <td style={{ fontSize: 12, fontFamily: 'monospace' }}>{r.trade_date}</td>
                      <td style={{ fontSize: 11, color: 'var(--text-2)', maxWidth: 480 }}>{r.notes || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Section 2: Delisting writeoffs */}
          {delisting.length > 0 && (
            <div className="panel">
              <div className="panel-header">
                <div>
                  <div className="panel-title">Delisting Writeoffs</div>
                  <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 4 }}>
                    Retired at scheme/last-traded price · {delisting.length} position{delisting.length === 1 ? '' : 's'} · Verify with registrar
                  </div>
                </div>
                <span className="pill pill-warn">Verify</span>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-2)', padding: '0 0 14px', lineHeight: 1.5 }}>
                Scheme consideration for these positions would have been paid directly to the client&apos;s bank account
                or registrar — not to the broker. The recorded amount approximates the per-share consideration but
                actual payment status should be confirmed with the registrar.
              </div>
              <table>
                <thead>
                  <tr>
                    <th>Ticker</th>
                    <th>Name</th>
                    <th className="num">Quantity retired</th>
                    <th className="num">Per-share price</th>
                    <th className="num">Approx. consideration</th>
                    <th>Retirement date</th>
                  </tr>
                </thead>
                <tbody>
                  {delisting.map(r => (
                    <tr key={r.id}>
                      <td style={{ fontFamily: 'monospace', fontSize: 12 }}>{r.instrument_id}</td>
                      <td style={{ fontSize: 11, color: 'var(--text-2)' }}>{r.instrument_name || '—'}</td>
                      <td className="num num-serif">{fmtNum(r.quantity)}</td>
                      <td className="num num-serif">{r.price > 0 ? fmtNum(r.price, 2) : '—'}</td>
                      <td className="num num-serif">{r.amount > 0 ? fmtNaira(r.amount) : '—'}</td>
                      <td style={{ fontSize: 12, fontFamily: 'monospace' }}>{r.trade_date}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  )
}
