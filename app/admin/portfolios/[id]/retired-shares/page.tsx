/**
 * app/admin/portfolios/[id]/retired-shares/page.tsx — v27w
 *
 * v27q-fix5 (original) → v27w design refresh:
 *   - Full hybrid v3 vocabulary (navy × cream × gold, Cormorant + DM Sans)
 *   - <main className="hybrid-page"> wrapper (was <div className="main">)
 *   - hybrid-serif h1, eyebrow crumb, KPI summary strip
 *   - btn-h buttons (was .btn)
 *   - alert-h-warn for the "for client follow-up" disclaimer
 *   - h-table for tables (was bare <table>)
 *   - Proper "Back to overview" link returning to /portfolio/[id] (the
 *     Overview page) instead of /portfolio/[id]/holdings — Overview
 *     gets the v27w callout that surfaces this report's count
 *
 * Page lists positions retired from a portfolio via the variance panel's
 * reconciliation flow. Two sections:
 *
 *   1. Zero-recovery writeoffs — Force-Zero toggle was used. Positions
 *      retired with no consideration recorded. Highest-priority follow-up.
 *
 *   2. Delisting writeoffs — picker date set to delisting era, price was
 *      the scheme/last-traded price. Worth verifying with registrar.
 *
 * Tagged in transactions via external_ref:
 *   - corp-action-zero-recovery-<sessionId>
 *   - corp-action-delisting-<sessionId>
 *
 * Server-rendered (async function, no 'use client') — uses service-role
 * key for the read so it bypasses RLS without needing browser auth.
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

  // ─── Error state ───────────────────────────────────────────────
  if (error || !portfolio) {
    return (
      <main className="hybrid-page" style={{ padding: '32px 44px 64px', minHeight: '100vh' }}>
        <div className="page-head">
          <div>
            <div className="eyebrow" style={{ marginBottom: 10 }}>Retired shares report</div>
            <h1 className="hybrid-serif" style={{ fontSize: 36, fontWeight: 500, letterSpacing: '-0.005em', lineHeight: 1, color: 'var(--text)' }}>
              Error
            </h1>
          </div>
        </div>
        <div className="alert-h" style={{
          background: 'rgba(166, 59, 59, 0.08)',
          borderColor: 'var(--neg)',
          color: 'var(--neg)',
          fontSize: 12,
        }}>
          {error ?? 'Portfolio not found'}
        </div>
      </main>
    )
  }

  const totalCount = zeroRecovery.length + delisting.length
  const totalQuantityZero = zeroRecovery.reduce((s, r) => s + r.quantity, 0)
  const totalConsiderationDelisting = delisting.reduce((s, r) => s + r.amount, 0)

  return (
    <main className="hybrid-page" style={{ padding: '32px 44px 64px' }}>
      {/* Page header — hybrid v3 vocabulary */}
      <div className="page-head">
        <div>
          <div className="eyebrow" style={{ marginBottom: 10 }}>
            {portfolio.client_name} · Portfolio {portfolio.label}
          </div>
          <h1 className="hybrid-serif" style={{ fontSize: 36, fontWeight: 500, letterSpacing: '-0.005em', lineHeight: 1, color: 'var(--text)' }}>
            Retired shares
          </h1>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {/* v27z: download self-contained HTML report (open + print from browser) */}
          <a
            href={`/api/admin/portfolios/${portfolio.id}/retired-shares/html?download=1`}
            className="btn-h"
            style={{ textDecoration: 'none', display: 'inline-flex', alignItems: 'center', gap: 6 }}
          >
            ⬇ Download HTML
          </a>
          <Link href={`/portfolio/${portfolio.id}`} style={{ textDecoration: 'none' }}>
            <button className="btn-h">← Back to overview</button>
          </Link>
        </div>
      </div>

      {/* Empty state */}
      {totalCount === 0 ? (
        <div className="panel" style={{ padding: 32, textAlign: 'center', color: 'var(--text-2)', fontSize: 13 }}>
          No retired-share records for this portfolio.
        </div>
      ) : (
        <>
          {/* KPI summary strip */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 24 }}>
            <div className="kpi-mini" style={{ borderTopColor: 'var(--neg)' }}>
              <div className="kpi-mini-label">Zero-recovery positions</div>
              <div className="kpi-mini-value" style={{ color: 'var(--neg)' }}>
                {zeroRecovery.length}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>
                {totalQuantityZero > 0 ? `${fmtNum(totalQuantityZero)} units · high priority` : 'High priority'}
              </div>
            </div>
            <div className="kpi-mini" style={{ borderTopColor: 'var(--warn)' }}>
              <div className="kpi-mini-label">Delisting writeoffs</div>
              <div className="kpi-mini-value" style={{ color: 'var(--warn)' }}>
                {delisting.length}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>
                {totalConsiderationDelisting > 0 ? `~${fmtNaira(totalConsiderationDelisting)} consideration` : 'Verify with registrar'}
              </div>
            </div>
            <div className="kpi-mini" style={{ borderTopColor: 'var(--gold)' }}>
              <div className="kpi-mini-label">Total retired</div>
              <div className="kpi-mini-value" style={{ color: 'var(--gold)' }}>
                {totalCount}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>
                Across both categories
              </div>
            </div>
          </div>

          {/* Disclaimer banner — hybrid alert-h-warn vocabulary */}
          <div className="alert-h alert-h-warn" style={{ marginBottom: 24, fontSize: 12, lineHeight: 1.6, alignItems: 'flex-start' }}>
            <div>
              <strong style={{ color: 'var(--gold)' }}>For client follow-up.</strong>{' '}
              Positions retired from the portfolio that may have outstanding consideration
              from the issuer&apos;s registrar. Operator should contact each registrar with
              the client&apos;s CSCS number and original holding details to confirm payment
              status. This report is a checklist for client service, not a record of unpaid amounts.
            </div>
          </div>

          {/* Section 1: Zero-recovery writeoffs */}
          {zeroRecovery.length > 0 && (
            <div className="panel" style={{ marginBottom: 20 }}>
              <div className="panel-header">
                <div>
                  <div className="panel-title">Zero-recovery writeoffs</div>
                  <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 4, lineHeight: 1.5 }}>
                    Retired with no recorded consideration · {zeroRecovery.length} position{zeroRecovery.length === 1 ? '' : 's'} ·{' '}
                    <span style={{ color: 'var(--neg)', fontWeight: 600 }}>HIGH PRIORITY</span>
                  </div>
                </div>
                <span className="pill pill-breach">Action recommended</span>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table className="h-table">
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
                        <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 500 }}>
                          {r.instrument_id}
                        </td>
                        <td style={{ fontSize: 12, color: 'var(--text-2)' }}>
                          {r.instrument_name || '—'}
                        </td>
                        <td className="num num-serif">{fmtNum(r.quantity)}</td>
                        <td style={{ fontSize: 12, fontFamily: 'var(--font-mono)' }}>
                          {r.trade_date}
                        </td>
                        <td style={{ fontSize: 11, color: 'var(--text-2)', maxWidth: 480, lineHeight: 1.5 }}>
                          {r.notes || '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Section 2: Delisting writeoffs */}
          {delisting.length > 0 && (
            <div className="panel">
              <div className="panel-header">
                <div>
                  <div className="panel-title">Delisting writeoffs</div>
                  <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 4, lineHeight: 1.5 }}>
                    Retired at scheme/last-traded price · {delisting.length} position{delisting.length === 1 ? '' : 's'} · Verify with registrar
                  </div>
                </div>
                <span className="pill pill-warn">Verify</span>
              </div>
              <div style={{
                fontSize: 11, color: 'var(--text-2)', padding: '0 0 14px',
                lineHeight: 1.6, fontStyle: 'italic',
              }}>
                Scheme consideration for these positions would have been paid directly to the client&apos;s bank account
                or registrar — not to the broker. The recorded amount approximates the per-share consideration but
                actual payment status should be confirmed with the registrar.
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table className="h-table">
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
                        <td style={{ fontFamily: 'var(--font-mono)', fontSize: 12, fontWeight: 500 }}>
                          {r.instrument_id}
                        </td>
                        <td style={{ fontSize: 12, color: 'var(--text-2)' }}>
                          {r.instrument_name || '—'}
                        </td>
                        <td className="num num-serif">{fmtNum(r.quantity)}</td>
                        <td className="num num-serif">{r.price > 0 ? fmtNum(r.price, 2) : '—'}</td>
                        <td className="num num-serif" style={{ color: 'var(--gold)' }}>
                          {r.amount > 0 ? fmtNaira(r.amount) : '—'}
                        </td>
                        <td style={{ fontSize: 12, fontFamily: 'var(--font-mono)' }}>
                          {r.trade_date}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </main>
  )
}
