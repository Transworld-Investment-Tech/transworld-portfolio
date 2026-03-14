'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { supabase } from '@/lib/supabase'
import { fmt } from '@/lib/portfolio'
import Sidebar from '@/components/shared/Sidebar'
import { Users, BarChart3, TrendingUp, Plus, RefreshCw, ChevronRight, Activity } from 'lucide-react'

const AUMBarChart = dynamic(() => import('@/components/portfolio/AUMBarChart'), { ssr: false })

export default function HomePage() {
  const [clients, setClients] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [stats, setStats] = useState({ totalPortfolios: 0, totalNAV: 0, activeClients: 0 })

  useEffect(() => { loadClients() }, [])

  async function loadClients() {
    setLoading(true)
    const { data } = await supabase
      .from('clients')
      .select('*, portfolios(id, label, name, starting_nav, currency, status, valuation_date)')
      .eq('status', 'active')
      .order('created_at', { ascending: true })
    if (data) {
      setClients(data)
      setStats({
        totalPortfolios: data.reduce((s: number, c: any) => s + (c.portfolios?.length || 0), 0),
        totalNAV: data.reduce((s: number, c: any) => s + (c.portfolios || []).reduce((ps: number, p: any) => ps + p.starting_nav, 0), 0),
        activeClients: data.length,
      })
    }
    setLoading(false)
  }

  const allPortfolios = clients.flatMap(c =>
    (c.portfolios || []).map((p: any) => ({ ...p, clientName: c.name, nav: p.starting_nav }))
  )

  const typeColor: Record<string, string> = { discretionary: 'badge-ntb', advisory: 'badge-stock', internal: 'badge-cash' }

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex-1 overflow-auto">
        <div className="px-8 py-5 border-b border-white/[0.07] bg-[#13161d] flex items-center justify-between sticky top-0 z-10">
          <div>
            <h1 className="text-base font-semibold">All portfolios</h1>
            <p className="text-xs text-[#555d72] mt-0.5">Transworld Asset Management — Portfolio Intelligence Platform</p>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={loadClients} disabled={loading} className="flex items-center gap-1.5 text-xs text-[#8a91a8] hover:text-[#e8eaf0] border border-white/10 rounded-lg px-3 py-1.5 transition-colors">
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
            </button>
            <Link href="/admin/portfolios/new" className="flex items-center gap-1.5 bg-[#a78bfa] text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-[#9b87e8] transition-colors">
              <Plus size={13} /> New portfolio
            </Link>
          </div>
        </div>

        <div className="px-8 py-6">
          <div className="grid grid-cols-3 gap-4 mb-6">
            {[
              { icon: <Users size={16} className="text-[#a78bfa]" />, label: 'Active clients', value: loading ? '—' : String(stats.activeClients), link: '/admin/clients' },
              { icon: <BarChart3 size={16} className="text-[#2dd4bf]" />, label: 'Portfolios', value: loading ? '—' : `${stats.totalPortfolios} / 25`, link: '#' },
              { icon: <TrendingUp size={16} className="text-[#60a5fa]" />, label: 'Total AUM (starting)', value: loading ? '—' : fmt.ngnB(stats.totalNAV), link: '#' },
            ].map((s, i) => (
              <Link href={s.link} key={i}>
                <div className="tw-card flex items-center gap-3 hover:border-white/15 transition-colors">
                  <div className="w-8 h-8 rounded-lg bg-[#1a1e28] flex items-center justify-center flex-shrink-0">{s.icon}</div>
                  <div><div className="kpi-label">{s.label}</div><div className="text-lg font-semibold font-mono">{s.value}</div></div>
                </div>
              </Link>
            ))}
          </div>

          <div className="tw-card mb-6">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-[#8a91a8]">Portfolio capacity</span>
              <span className="text-xs font-mono text-[#555d72]">{stats.totalPortfolios} / 25</span>
            </div>
            <div className="h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
              <div className="h-full rounded-full bg-gradient-to-r from-[#a78bfa] to-[#2dd4bf] transition-all duration-700"
                style={{ width: `${Math.min((stats.totalPortfolios / 25) * 100, 100)}%` }} />
            </div>
          </div>

          {allPortfolios.length > 1 && (
            <div className="tw-card mb-6">
              <div className="text-xs font-semibold uppercase tracking-widest text-[#555d72] mb-4">AUM by portfolio (starting NAV)</div>
              <AUMBarChart portfolios={allPortfolios} />
            </div>
          )}

          {loading ? (
            <div className="flex items-center justify-center py-20 text-[#555d72] text-xs">Loading portfolios…</div>
          ) : clients.length === 0 ? (
            <div className="tw-card text-center py-16 border-dashed">
              <Users size={32} className="text-[#555d72] mx-auto mb-4" />
              <div className="text-sm font-medium mb-1">No clients yet</div>
              <div className="text-xs text-[#555d72] mb-6 max-w-xs mx-auto">Add Transworld as your first internal client, then create Portfolio A.</div>
              <Link href="/admin/clients/new" className="inline-flex items-center gap-2 bg-[#a78bfa] text-white px-5 py-2.5 rounded-lg text-sm font-medium hover:bg-[#9b87e8] transition-colors">
                <Plus size={14} /> Add first client
              </Link>
            </div>
          ) : (
            <div className="space-y-7">
              {clients.map((client: any) => (
                <div key={client.id}>
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-7 h-7 rounded-lg bg-[#1a1e28] border border-white/10 flex items-center justify-center text-[10px] font-bold text-[#a78bfa]">
                      {client.code.slice(0, 2).toUpperCase()}
                    </div>
                    <span className="text-sm font-semibold">{client.name}</span>
                    <span className={`badge ${typeColor[client.type] || 'badge-cash'}`}>{client.type}</span>
                    <Link href={`/admin/clients/${client.id}`} className="ml-auto text-[11px] text-[#555d72] hover:text-[#a78bfa] transition-colors flex items-center gap-1">
                      Manage <ChevronRight size={11} />
                    </Link>
                  </div>
                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                    {(client.portfolios || []).map((p: any) => (
                      <Link href={`/portfolio/${p.id}`} key={p.id}>
                        <div className="tw-card hover:border-[#a78bfa]/30 hover:bg-[#a78bfa]/[0.02] transition-all cursor-pointer group">
                          <div className="flex items-center justify-between mb-3">
                            <div className="w-8 h-8 rounded-lg bg-[#a78bfa]/10 border border-[#a78bfa]/20 flex items-center justify-center text-[#a78bfa] font-bold">{p.label}</div>
                            <span className={`badge text-[9px] ${p.status === 'active' ? 'badge-ok' : 'badge-hold'}`}>{p.status}</span>
                          </div>
                          <div className="text-sm font-medium leading-tight mb-0.5 group-hover:text-[#a78bfa] transition-colors">{p.name}</div>
                          <div className="text-[11px] font-mono text-[#555d72] mt-2">{fmt.ngnM(p.starting_nav)}</div>
                          {p.valuation_date && <div className="text-[10px] text-[#555d72] mt-1">Val. {fmt.date(p.valuation_date)}</div>}
                          <div className="flex items-center gap-1 mt-3 text-[11px] text-[#a78bfa] opacity-0 group-hover:opacity-100 transition-opacity">
                            <Activity size={11} /> Open →
                          </div>
                        </div>
                      </Link>
                    ))}
                    <Link href={`/admin/portfolios/new?client=${client.id}`}>
                      <div className="border border-dashed border-white/10 rounded-xl p-4 hover:border-[#a78bfa]/40 transition-all cursor-pointer group flex flex-col items-center justify-center min-h-[140px] text-center">
                        <Plus size={18} className="text-[#555d72] group-hover:text-[#a78bfa] transition-colors mb-1.5" />
                        <div className="text-[11px] text-[#555d72] group-hover:text-[#a78bfa] transition-colors">Add portfolio</div>
                      </div>
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
