'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import {
  Users, BarChart3, FileText, Settings,
  PlusCircle, ChevronRight, Upload, LineChart, Inbox,
} from 'lucide-react'

// v20e: Hybrid rewrite of the admin dashboard.
// v21b-3b: Added "Broker files" card linking to /admin/broker.

type QuickAction = {
  href: string
  icon: React.ReactNode
  label: string
  sub: string
  accent: string   // CSS var for accent bar / icon tint
}

export default function AdminPage() {
  const [stats, setStats] = useState({ clients: 0, portfolios: 0, reports: 0 })
  const [recentReports, setRecentReports] = useState<any[]>([])
  const [loading, setLoading] = useState(true)

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
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 32 }}>
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
    </main>
  )
}
