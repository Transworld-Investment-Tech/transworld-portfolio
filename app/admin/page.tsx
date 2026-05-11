'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import {
  Users, BarChart3, FileText, Settings,
  PlusCircle, ChevronRight, Upload, LineChart, Inbox,
  Sparkles, RefreshCw,
} from 'lucide-react'

// v20e: Hybrid rewrite of the admin dashboard.
// v21b-3b: Added "Broker files" card linking to /admin/broker.
// v27bc: Added "AI Financial Summaries" coverage card between Stats
//        and Quick Actions. New pattern — establishes the operator UI
//        for AI summary refresh (parallel to curl-only dividends and
//        shares-outstanding refresh routes today; future cleanup pass
//        to add equivalent cards for those).
//
//        Card shows: total eligible, summarized count, never-summarized
//        count, last refresh relative time, "Refresh next 30" button.
//        After click: POSTs to /api/ai-summaries/refresh and renders
//        inline success/error message below the button. Coverage stats
//        re-fetch on success.

type QuickAction = {
  href: string
  icon: React.ReactNode
  label: string
  sub: string
  accent: string   // CSS var for accent bar / icon tint
}

type AICoverage = {
  totalEligible:    number    // equities with profit_after_tax_ngn_m populated
  summarized:       number    // also have ai_summary_refreshed_at set
  neverSummarized:  number
  lastRefresh:      string | null  // most recent ai_summary_refreshed_at across all
}

type RefreshOutcome =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'success'; message: string }
  | { kind: 'error';   message: string }

export default function AdminPage() {
  const [stats, setStats] = useState({ clients: 0, portfolios: 0, reports: 0 })
  const [recentReports, setRecentReports] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

  // v27bc: AI summary coverage state
  const [aiCoverage, setAiCoverage] = useState<AICoverage | null>(null)
  const [aiCoverageLoading, setAiCoverageLoading] = useState(true)
  const [refreshOutcome, setRefreshOutcome] = useState<RefreshOutcome>({ kind: 'idle' })

  useEffect(() => {
    async function load() {
      const [c, p, r] = await Promise.all([
        supabase.from('clients').select('*', { count: 'exact', head: true }).eq('status', 'active'),
        supabase.from('portfolios').select('*', { count: 'exact', head: true }).eq('status', 'active'),
        supabase.from('reports').select('*, portfolio:portfolios(name, client:clients(name))').order('created_at', { ascending: false }).limit(8),
      ])
      setStats({ clients: c.count ?? 0, portfolios: p.count ?? 0, reports: r.data?.length ?? 0 })
      setRecentReports(r.data ?? [])
      setLoading(false)
    }
    load()
  }, [])

  // v27bc: AI summary coverage fetch (client-side Supabase pattern
  // matching the existing direct query pattern above)
  async function loadAICoverage() {
    setAiCoverageLoading(true)
    try {
      const [total, summarized, lastRefresh] = await Promise.all([
        supabase.from('instruments')
          .select('*', { count: 'exact', head: true })
          .eq('type', 'Stock')
          .eq('approved', true)
          .not('profit_after_tax_ngn_m', 'is', null),
        supabase.from('instruments')
          .select('*', { count: 'exact', head: true })
          .eq('type', 'Stock')
          .eq('approved', true)
          .not('profit_after_tax_ngn_m', 'is', null)
          .not('ai_summary_refreshed_at', 'is', null),
        supabase.from('instruments')
          .select('ai_summary_refreshed_at')
          .eq('type', 'Stock')
          .eq('approved', true)
          .not('ai_summary_refreshed_at', 'is', null)
          .order('ai_summary_refreshed_at', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ])

      const totalCount  = total.count ?? 0
      const summCount   = summarized.count ?? 0
      const neverCount  = totalCount - summCount
      const lastIso     = (lastRefresh.data as { ai_summary_refreshed_at: string } | null)?.ai_summary_refreshed_at ?? null

      setAiCoverage({
        totalEligible:   totalCount,
        summarized:      summCount,
        neverSummarized: neverCount,
        lastRefresh:     lastIso,
      })
    } catch (err) {
      console.error('[admin AI coverage]', err)
      setAiCoverage(null)
    }
    setAiCoverageLoading(false)
  }

  useEffect(() => { loadAICoverage() }, [])

  // v27bc: refresh button handler — POSTs to /api/ai-summaries/refresh,
  // re-fetches coverage on success, displays inline status message.
  async function handleAiRefresh() {
    setRefreshOutcome({ kind: 'running' })
    try {
      const res = await fetch('/api/ai-summaries/refresh', { method: 'POST' })
      const data = await res.json()
      if (!res.ok || !data.ok) {
        setRefreshOutcome({ kind: 'error', message: data.error ?? data.message ?? 'Refresh failed' })
        return
      }
      const updatedCount   = Array.isArray(data.updated) ? data.updated.length : 0
      const skippedCount   = Array.isArray(data.skipped) ? data.skipped.length : 0
      const batchErrCount  = Array.isArray(data.batchErrors)  ? data.batchErrors.length  : 0
      const updateErrCount = Array.isArray(data.updateErrors) ? data.updateErrors.length : 0
      const parts: string[] = []
      parts.push(`Summarized ${updatedCount} ticker${updatedCount === 1 ? '' : 's'}`)
      if (skippedCount > 0)   parts.push(`${skippedCount} skipped`)
      if (batchErrCount > 0)  parts.push(`${batchErrCount} batch error${batchErrCount === 1 ? '' : 's'}`)
      if (updateErrCount > 0) parts.push(`${updateErrCount} write error${updateErrCount === 1 ? '' : 's'}`)
      if (typeof data.neverSummarized === 'number' && data.neverSummarized > 0) {
        parts.push(`${data.neverSummarized} still never-summarized`)
      } else if (typeof data.neverSummarized === 'number' && data.neverSummarized === 0) {
        parts.push('full coverage reached')
      }
      setRefreshOutcome({ kind: 'success', message: parts.join(' · ') })
      // Re-fetch coverage to reflect new counts
      await loadAICoverage()
    } catch (err) {
      setRefreshOutcome({ kind: 'error', message: (err as Error).message ?? 'Network error' })
    }
  }

  function fmtRelative(iso: string | null): string {
    if (!iso) return 'never'
    try {
      const then = new Date(iso).getTime()
      const now = Date.now()
      const diffMs = now - then
      if (diffMs < 0) return 'in the future'
      const days = Math.floor(diffMs / (1000 * 60 * 60 * 24))
      if (days === 0) {
        const hours = Math.floor(diffMs / (1000 * 60 * 60))
        if (hours === 0) return 'just now'
        return `${hours}h ago`
      }
      if (days === 1) return 'yesterday'
      if (days < 7)  return `${days}d ago`
      const weeks = Math.floor(days / 7)
      if (weeks < 5) return `${weeks}w ago`
      const months = Math.floor(days / 30)
      return `${months}mo ago`
    } catch {
      return 'unknown'
    }
  }

  const quickLinks: QuickAction[] = [
    { href: '/admin/clients/new',    icon: <PlusCircle size={14} />, label: 'Add client',           sub: 'Onboard a new discretionary mandate',          accent: 'var(--gold)' },
    { href: '/admin/portfolios/new', icon: <BarChart3 size={14} />,  label: 'New portfolio',        sub: 'Create portfolio A/B/C/D for a client',        accent: 'var(--pos)' },
    { href: '/admin/prices',         icon: <LineChart size={14} />,  label: 'Market prices',        sub: 'View, refresh & manually override NGX prices', accent: 'var(--warn)' },
    { href: '/admin/broker',         icon: <Inbox size={14} />,      label: 'Broker files',         sub: 'Review & commit monthly broker PDFs',          accent: 'var(--gold-bright)' },
    { href: '/admin/settings',       icon: <Settings size={14} />,   label: 'Settings',             sub: 'API keys, Apify, Anthropic',                   accent: 'var(--sidebar-bg)' },
    { href: '/admin/reports',        icon: <FileText size={14} />,   label: 'All reports',          sub: 'View & download generated reports',            accent: 'var(--neg)' },
    { href: '/admin/import',         icon: <Upload size={14} />,     label: 'Import transactions',  sub: 'Upload CSV/Excel (historical reconstruction)', accent: 'var(--gold)' },
  ]

  const statCards = [
    { icon: <Users size={16} />,     label: 'Active clients',     value: stats.clients,            link: '/admin/clients', accent: 'var(--gold)' },
    { icon: <BarChart3 size={16} />, label: 'Active portfolios',  value: `${stats.portfolios} / 25`, link: '/',              accent: 'var(--pos)' },
    { icon: <FileText size={16} />,  label: 'Reports generated',  value: `${stats.reports}+`,       link: '/admin/reports', accent: 'var(--sidebar-bg)' },
  ]

  return (
    <main className="hybrid-page" style={{ padding: '32px 44px 64px', minHeight: '100vh' }}>
      <div className="page-head">
        <div>
          <div className="eyebrow" style={{ marginBottom: 10 }}>
            Transworld Investment and Securities
          </div>
          <h1 className="hybrid-serif" style={{ fontSize: 36, fontWeight: 500, letterSpacing: '-0.005em', lineHeight: 1, color: 'var(--text)' }}>
            Admin panel
          </h1>
        </div>
      </div>

      <div style={{ maxWidth: 960 }}>
        {/* Stats row */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 24 }}>
          {statCards.map((s, i) => (
            <Link key={i} href={s.link} style={{ textDecoration: 'none' }}>
              <div
                className="panel"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  padding: '18px 20px',
                  cursor: 'pointer',
                  transition: 'border-color 0.15s',
                }}
                onMouseEnter={e => { e.currentTarget.style.borderColor = 'var(--border-strong)' }}
                onMouseLeave={e => { e.currentTarget.style.borderColor = 'var(--border)' }}
              >
                <div
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 4,
                    background: 'var(--bg-soft)',
                    border: '1px solid var(--border-soft)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    flexShrink: 0,
                    color: s.accent,
                  }}
                >
                  {s.icon}
                </div>
                <div style={{ flex: 1 }}>
                  <div
                    style={{
                      fontSize: 10,
                      letterSpacing: '0.14em',
                      textTransform: 'uppercase' as const,
                      color: 'var(--text-3)',
                      fontWeight: 600,
                      marginBottom: 6,
                    }}
                  >
                    {s.label}
                  </div>
                  <div className="hybrid-serif" style={{ fontSize: 26, fontWeight: 500, letterSpacing: '-0.01em', color: 'var(--text)', lineHeight: 1 }}>
                    {loading ? '—' : s.value}
                  </div>
                </div>
                <ChevronRight size={14} style={{ color: 'var(--text-3)' }} />
              </div>
            </Link>
          ))}
        </div>

        {/* v27bc: AI Financial Summaries coverage card */}
        <div
          className="panel"
          style={{
            padding: '18px 22px',
            marginBottom: 32,
            borderLeft: '3px solid var(--gold)',
          }}
        >
          <div style={{
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: 16,
            flexWrap: 'wrap',
          }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginBottom: 8,
              }}>
                <Sparkles size={14} style={{ color: 'var(--gold)' }} />
                <div style={{
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: '0.18em',
                  color: 'var(--text-3)',
                  textTransform: 'uppercase' as const,
                }}>
                  AI Financial Summaries
                </div>
              </div>

              {aiCoverageLoading ? (
                <div style={{ fontSize: 13, color: 'var(--text-3)' }}>Loading coverage…</div>
              ) : aiCoverage ? (
                <>
                  <div className="hybrid-serif" style={{
                    fontSize: 24,
                    fontWeight: 500,
                    letterSpacing: '-0.01em',
                    color: 'var(--text)',
                    lineHeight: 1.1,
                    marginBottom: 6,
                  }}>
                    {aiCoverage.summarized} <span style={{ color: 'var(--text-3)', fontSize: 18 }}>of</span> {aiCoverage.totalEligible} <span style={{ color: 'var(--text-3)', fontSize: 16 }}>equities summarized</span>
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-2)', fontVariantNumeric: 'tabular-nums' as const }}>
                    Last refresh: <strong style={{ color: 'var(--text)' }}>{fmtRelative(aiCoverage.lastRefresh)}</strong>
                    {aiCoverage.neverSummarized > 0 ? (
                      <>
                        {' · '}
                        <span style={{ color: 'var(--warn)' }}>
                          {aiCoverage.neverSummarized} never summarized
                        </span>
                      </>
                    ) : aiCoverage.totalEligible > 0 ? (
                      <>
                        {' · '}
                        <span style={{ color: 'var(--pos)' }}>
                          full coverage
                        </span>
                      </>
                    ) : null}
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 13, color: 'var(--neg)' }}>Coverage stats unavailable</div>
              )}
            </div>

            <button
              onClick={handleAiRefresh}
              disabled={refreshOutcome.kind === 'running'}
              style={{
                padding: '10px 16px',
                fontSize: 12,
                fontWeight: 500,
                background: 'var(--gold)',
                color: '#fff',
                border: 'none',
                borderRadius: 3,
                cursor: refreshOutcome.kind === 'running' ? 'wait' : 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                fontFamily: '"DM Sans", system-ui, sans-serif',
                flexShrink: 0,
                opacity: refreshOutcome.kind === 'running' ? 0.7 : 1,
                whiteSpace: 'nowrap',
              }}
            >
              <RefreshCw
                size={12}
                style={refreshOutcome.kind === 'running' ? { animation: 'admin-ai-spin 1s linear infinite' } : undefined}
              />
              {refreshOutcome.kind === 'running' ? 'Refreshing…' : 'Refresh next 30'}
            </button>
          </div>

          {/* Inline status message after refresh */}
          {refreshOutcome.kind === 'success' && (
            <div style={{
              marginTop: 14,
              paddingTop: 12,
              borderTop: '1px solid var(--border-soft, rgba(15,41,71,0.06))',
              fontSize: 11,
              color: 'var(--pos)',
              fontWeight: 500,
            }}>
              ✓ {refreshOutcome.message}
            </div>
          )}
          {refreshOutcome.kind === 'error' && (
            <div style={{
              marginTop: 14,
              paddingTop: 12,
              borderTop: '1px solid var(--border-soft, rgba(15,41,71,0.06))',
              fontSize: 11,
              color: 'var(--neg)',
              fontWeight: 500,
            }}>
              ✗ {refreshOutcome.message}
            </div>
          )}
          {refreshOutcome.kind === 'running' && (
            <div style={{
              marginTop: 14,
              paddingTop: 12,
              borderTop: '1px solid var(--border-soft, rgba(15,41,71,0.06))',
              fontSize: 11,
              color: 'var(--text-3)',
              fontStyle: 'italic',
            }}>
              Calling Claude for up to 30 tickers in batches of 5. This typically takes 2-4 minutes — leave this tab open.
            </div>
          )}
        </div>

        {/* Quick actions */}
        <div style={{ marginBottom: 32 }}>
          <h2 style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.18em', color: 'var(--text-3)', marginBottom: 12 }}>
            Quick actions
          </h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 12 }}>
            {quickLinks.map(l => (
              <Link key={l.href} href={l.href} style={{ textDecoration: 'none' }}>
                <div
                  className="panel"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 14,
                    padding: '14px 18px',
                    cursor: 'pointer',
                    transition: 'all 0.15s',
                    borderLeft: `3px solid ${l.accent}`,
                  }}
                  onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-soft)' }}
                  onMouseLeave={e => { e.currentTarget.style.background = 'var(--card)' }}
                >
                  <div
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: 4,
                      background: l.accent === 'var(--sidebar-bg)' ? 'rgba(10, 31, 58, 0.08)' : `${l.accent}1a`,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                      color: l.accent,
                    }}
                  >
                    {l.icon}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>{l.label}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{l.sub}</div>
                  </div>
                  <ChevronRight size={13} style={{ color: 'var(--text-3)' }} />
                </div>
              </Link>
            ))}
          </div>
        </div>

        {/* Recent reports */}
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
            <h2 style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.18em', color: 'var(--text-3)' }}>
              Recent AI reports
            </h2>
            <Link href="/admin/reports" style={{ fontSize: 11, color: 'var(--gold)', textDecoration: 'none' }}>
              View all →
            </Link>
          </div>
          <div className="panel" style={{ padding: 0, overflow: 'hidden' }}>
            {recentReports.length === 0 ? (
              <div style={{ padding: '32px 20px', textAlign: 'center', fontSize: 12, color: 'var(--text-3)' }}>
                No reports generated yet
              </div>
            ) : (
              <table className="h-table" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>Portfolio</th>
                    <th>Client</th>
                    <th>Type</th>
                    <th>Date</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {recentReports.map(r => (
                    <tr key={r.id}>
                      <td style={{ fontWeight: 500 }}>{r.portfolio?.name}</td>
                      <td style={{ color: 'var(--text-3)' }}>{r.portfolio?.client?.name}</td>
                      <td>
                        <span className="pill pill-warn" style={{ textTransform: 'capitalize' as const }}>
                          {r.report_type}
                        </span>
                      </td>
                      <td style={{ color: 'var(--text-3)', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                        {new Date(r.created_at).toLocaleDateString('en-GB')}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <Link href={`/admin/reports/${r.id}`} style={{ fontSize: 11, color: 'var(--gold)', textDecoration: 'none' }}>
                          View →
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      <style jsx>{`
        @keyframes admin-ai-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </main>
  )
}
