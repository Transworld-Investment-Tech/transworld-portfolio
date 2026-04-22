'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { fmt } from '@/lib/portfolio'
import {
  Users, BarChart3, TrendingUp, FileText, Settings,
  RefreshCw, PlusCircle, Activity, ChevronRight, Upload,
  LineChart
} from 'lucide-react'

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

  // v17: Market prices quick link added. Sits after Settings because it's
  // data-operational, not administrative. Uses yellow to signal it's the
  // place to go when prices go stale.
  const quickLinks = [
    { href: '/admin/clients/new', icon: <PlusCircle size={16} />, label: 'Add client', sub: 'Onboard a new discretionary mandate', color: '#a78bfa' },
    { href: '/admin/portfolios/new', icon: <BarChart3 size={16} />, label: 'New portfolio', sub: 'Create portfolio A/B/C/D for a client', color: '#2dd4bf' },
    { href: '/admin/prices', icon: <LineChart size={16} />, label: 'Market prices', sub: 'View, refresh & manually override NGX prices', color: '#eab308' },
    { href: '/admin/settings', icon: <Settings size={16} />, label: 'Settings', sub: 'API keys, Apify, Anthropic', color: '#60a5fa' },
    { href: '/admin/reports', icon: <FileText size={16} />, label: 'All reports', sub: 'View & download generated reports', color: '#fb923c' },
    { href: '/admin/import', icon: <Upload size={16} />, label: 'Import transactions', sub: 'Upload CSV/Excel from broker system', color: '#22c55e' },
  ]

  return (
    <div>
      <div className="px-8 py-6 border-b border-white/[0.07] bg-[#13161d]">
        <h1 className="text-xl font-semibold">Admin panel</h1>
        <p className="text-xs text-[#555d72] mt-0.5">Transworld Asset Management · Portfolio Intelligence Platform</p>
      </div>

      <div className="px-8 py-6 max-w-5xl">
        {/* Stats */}
        <div className="grid grid-cols-3 gap-4 mb-8">
          {[
            { icon: <Users size={18} className="text-[#a78bfa]" />, label: 'Active clients', value: stats.clients, link: '/admin/clients' },
            { icon: <BarChart3 size={18} className="text-[#2dd4bf]" />, label: 'Active portfolios', value: `${stats.portfolios} / 25`, link: '/' },
            { icon: <FileText size={18} className="text-[#fb923c]" />, label: 'Reports generated', value: stats.reports + '+', link: '/admin/reports' },
          ].map((s, i) => (
            <Link href={s.link} key={i}>
              <div className="tw-card flex items-center gap-4 hover:border-white/15 transition-colors cursor-pointer">
                <div className="w-10 h-10 rounded-xl bg-[#1a1e28] flex items-center justify-center flex-shrink-0">{s.icon}</div>
                <div>
                  <div className="kpi-label">{s.label}</div>
                  <div className="text-xl font-semibold font-mono">{loading ? '—' : s.value}</div>
                </div>
                <ChevronRight size={14} className="ml-auto text-[#555d72]" />
              </div>
            </Link>
          ))}
        </div>

        {/* Quick actions */}
        <div className="mb-8">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-[#555d72] mb-3">Quick actions</h2>
          <div className="grid grid-cols-2 gap-3">
            {quickLinks.map(l => (
              <Link href={l.href} key={l.href}>
                <div className="tw-card flex items-center gap-4 hover:border-white/15 transition-all cursor-pointer group">
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center flex-shrink-0"
                    style={{ background: l.color + '15', color: l.color }}>
                    {l.icon}
                  </div>
                  <div>
                    <div className="text-sm font-medium group-hover:text-[#a78bfa] transition-colors">{l.label}</div>
                    <div className="text-[11px] text-[#555d72]">{l.sub}</div>
                  </div>
                  <ChevronRight size={13} className="ml-auto text-[#555d72] group-hover:text-[#a78bfa] transition-colors" />
                </div>
              </Link>
            ))}
          </div>
        </div>

        {/* Recent reports */}
        <div>
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs font-semibold uppercase tracking-widest text-[#555d72]">Recent AI reports</h2>
            <Link href="/admin/reports" className="text-[11px] text-[#555d72] hover:text-[#a78bfa] transition-colors">View all →</Link>
          </div>
          <div className="tw-card p-0 overflow-hidden">
            {recentReports.length === 0 ? (
              <div className="px-5 py-8 text-center text-xs text-[#555d72]">No reports generated yet</div>
            ) : (
              <table className="tw-table w-full">
                <thead><tr><th>Portfolio</th><th>Client</th><th>Type</th><th>Date</th><th></th></tr></thead>
                <tbody>
                  {recentReports.map(r => (
                    <tr key={r.id}>
                      <td className="font-medium">{r.portfolio?.name}</td>
                      <td className="text-[#555d72]">{r.portfolio?.client?.name}</td>
                      <td><span className="badge badge-ntb capitalize">{r.report_type}</span></td>
                      <td className="text-[#555d72]">{new Date(r.created_at).toLocaleDateString('en-GB')}</td>
                      <td>
                        <Link href={`/admin/reports/${r.id}`} className="text-[11px] text-[#555d72] hover:text-[#a78bfa] transition-colors">View →</Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
