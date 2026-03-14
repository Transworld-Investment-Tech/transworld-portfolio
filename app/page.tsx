'use client'
import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { supabase } from '@/lib/supabase'
import { fmt } from '@/lib/portfolio'
import Sidebar from '@/components/shared/Sidebar'
import {
  Users, BarChart3, TrendingUp, Plus, RefreshCw,
  ChevronRight, Activity, Trash2, AlertTriangle, X
} from 'lucide-react'

const AUMBarChart = dynamic(() => import('@/components/portfolio/AUMBarChart'), { ssr: false })

interface PortfolioWithNAV {
  id: string
  label: string
  name: string
  starting_nav: number
  current_nav: number
  currency: string
  status: string
  valuation_date: string
  clientName: string
  clientCode: string
  nav: number   // for AUMBarChart compat
}

export default function HomePage() {
  const [clients,    setClients]    = useState<any[]>([])
  const [navMap,     setNavMap]     = useState<Record<string, number>>({})
  const [loading,    setLoading]    = useState(true)
  const [deleting,   setDeleting]   = useState<string | null>(null)
  const [confirmDel,        setConfirmDel]        = useState<{ id: string; name: string } | null>(null)
  const [confirmArchiveClient, setConfirmArchiveClient] = useState<{ id: string; name: string } | null>(null)
  const [archivingClient,      setArchivingClient]      = useState<string | null>(null)
  const [stats, setStats] = useState({ totalPortfolios: 0, totalNAV: 0, activeClients: 0 })

  const loadClients = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase
      .from('clients')
      .select('*, portfolios(id, label, name, starting_nav, currency, status, valuation_date)')
      .eq('status', 'active')
      .order('name', { ascending: true })

    if (!data) { setLoading(false); return }

    // Fetch current NAV for each portfolio from holdings + market prices
    const allPortfolioIds = data.flatMap((c: any) => (c.portfolios || []).map((p: any) => p.id))

    // Get all holdings with latest prices
    const [holdingsRes, pricesRes] = await Promise.all([
      supabase.from('holdings').select('portfolio_id, instrument_id, quantity').in('portfolio_id', allPortfolioIds),
      supabase.from('market_prices').select('instrument_id, price').order('price_date', { ascending: false }),
    ])

    // Build latest price map
    const priceMap: Record<string, number> = {}
    for (const p of pricesRes.data ?? []) {
      if (!priceMap[p.instrument_id]) priceMap[p.instrument_id] = p.price
    }

    // Compute current NAV per portfolio
    const navByPortfolio: Record<string, number> = {}
    for (const h of holdingsRes.data ?? []) {
      const price = priceMap[h.instrument_id] ?? 0
      navByPortfolio[h.portfolio_id] = (navByPortfolio[h.portfolio_id] ?? 0) + h.quantity * price
    }
    setNavMap(navByPortfolio)

    setClients(data)
    const totalNAV = Object.values(navByPortfolio).reduce((s, v) => s + v, 0)
    setStats({
      totalPortfolios: data.reduce((s: number, c: any) => s + (c.portfolios?.length || 0), 0),
      totalNAV: totalNAV || data.reduce((s: number, c: any) =>
        s + (c.portfolios || []).reduce((ps: number, p: any) => ps + p.starting_nav, 0), 0),
      activeClients: data.length,
    })
    setLoading(false)
  }, [])

  useEffect(() => { loadClients() }, [])

  async function archiveClient(id: string) {
    setArchivingClient(id)
    await fetch(`/api/clients/${id}`, { method: 'DELETE' })
    setConfirmArchiveClient(null)
    setArchivingClient(null)
    loadClients()
  }

  async function deletePortfolio(id: string) {
    setDeleting(id)
    await fetch(`/api/portfolios/${id}`, { method: 'DELETE' })
    setConfirmDel(null)
    setDeleting(null)
    loadClients()
  }

  const allPortfolios: PortfolioWithNAV[] = clients.flatMap((c: any) =>
    (c.portfolios || []).map((p: any) => ({
      ...p,
      clientName: c.name,
      clientCode: c.code,
      current_nav: navMap[p.id] ?? 0,
      nav: navMap[p.id] ?? p.starting_nav,
    }))
  )

  const typeColor: Record<string, string> = {
    discretionary: 'badge-ntb', advisory: 'badge-stock', internal: 'badge-cash'
  }

  const totalCurrentNAV = allPortfolios.reduce((s, p) => s + (p.current_nav || 0), 0)

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex-1 overflow-auto">

        {/* Delete confirmation modal */}
        {confirmDel && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
            <div className="bg-[#13161d] border border-white/10 rounded-2xl p-6 w-96 shadow-2xl">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl bg-[#ef4444]/10 flex items-center justify-center flex-shrink-0">
                  <AlertTriangle size={18} className="text-[#ef4444]" />
                </div>
                <div>
                  <div className="text-sm font-semibold">Archive portfolio?</div>
                  <div className="text-xs text-[#555d72] mt-0.5">This will hide it from all views</div>
                </div>
                <button onClick={() => setConfirmDel(null)} className="ml-auto text-[#555d72] hover:text-[#e8eaf0]">
                  <X size={16} />
                </button>
              </div>
              <div className="px-3 py-2 bg-white/[0.03] rounded-lg mb-5 text-sm text-[#8a91a8]">
                {confirmDel.name}
              </div>
              <div className="text-xs text-[#555d72] mb-5 leading-relaxed">
                The portfolio will be archived — holdings, transactions and reports are preserved but it won't appear in the dashboard. This can be reversed in Supabase if needed.
              </div>
              <div className="flex gap-3">
                <button
                  onClick={() => deletePortfolio(confirmDel.id)}
                  disabled={deleting === confirmDel.id}
                  className="flex items-center gap-2 bg-[#ef4444] text-white px-4 py-2 rounded-lg text-xs font-semibold disabled:opacity-50 hover:bg-[#dc2626] transition-colors">
                  {deleting === confirmDel.id ? <RefreshCw size={12} className="animate-spin" /> : <Trash2 size={12} />}
                  Archive portfolio
                </button>
                <button onClick={() => setConfirmDel(null)}
                  className="px-4 py-2 border border-white/10 rounded-lg text-xs text-[#8a91a8] hover:text-[#e8eaf0] transition-colors">
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Archive client modal */}
        {confirmArchiveClient && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
            <div className="bg-[#13161d] border border-white/10 rounded-2xl p-6 w-96 shadow-2xl">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl bg-[#f59e0b]/10 flex items-center justify-center flex-shrink-0">
                  <AlertTriangle size={18} className="text-[#f59e0b]" />
                </div>
                <div>
                  <div className="text-sm font-semibold">Archive client?</div>
                  <div className="text-xs text-[#555d72] mt-0.5">Client and all portfolios will be hidden</div>
                </div>
                <button onClick={() => setConfirmArchiveClient(null)} className="ml-auto text-[#555d72] hover:text-[#e8eaf0]">
                  <X size={16} />
                </button>
              </div>
              <div className="px-3 py-2 bg-white/[0.03] rounded-lg mb-4 text-sm text-[#8a91a8]">
                {confirmArchiveClient.name}
              </div>
              <div className="text-xs text-[#555d72] mb-5 leading-relaxed">
                This archives the client and all their portfolios. All data (holdings, transactions, reports) is preserved and can be restored by setting <code className="text-[#a78bfa]">status = 'active'</code> in Supabase.
              </div>
              <div className="flex gap-3">
                <button
                  onClick={() => archiveClient(confirmArchiveClient.id)}
                  disabled={archivingClient === confirmArchiveClient.id}
                  className="flex items-center gap-2 bg-[#f59e0b] text-white px-4 py-2 rounded-lg text-xs font-semibold disabled:opacity-50 hover:bg-[#d97706] transition-colors">
                  {archivingClient === confirmArchiveClient.id
                    ? <RefreshCw size={12} className="animate-spin" />
                    : <Trash2 size={12} />}
                  Archive client
                </button>
                <button onClick={() => setConfirmArchiveClient(null)}
                  className="px-4 py-2 border border-white/10 rounded-lg text-xs text-[#8a91a8] hover:text-[#e8eaf0] transition-colors">
                  Cancel
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Header */}
        <div className="px-8 py-5 border-b border-white/[0.07] bg-[#13161d] flex items-center justify-between sticky top-0 z-10">
          <div>
            <h1 className="text-base font-semibold">All portfolios</h1>
            <p className="text-xs text-[#555d72] mt-0.5">Transworld Asset Management — Portfolio Intelligence Platform</p>
          </div>
          <div className="flex items-center gap-3">
            <button onClick={loadClients} disabled={loading}
              className="flex items-center gap-1.5 text-xs text-[#8a91a8] hover:text-[#e8eaf0] border border-white/10 rounded-lg px-3 py-1.5 transition-colors">
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
            </button>
            <Link href="/admin/portfolios/new"
              className="flex items-center gap-1.5 bg-[#a78bfa] text-white px-3 py-1.5 rounded-lg text-xs font-medium hover:bg-[#9b87e8] transition-colors">
              <Plus size={13} /> New portfolio
            </Link>
          </div>
        </div>

        <div className="px-8 py-6">

          {/* KPI strip */}
          <div className="grid grid-cols-3 gap-4 mb-6">
            {[
              { icon: <Users size={16} className="text-[#a78bfa]" />, label: 'Active clients', value: loading ? '—' : String(stats.activeClients), sub: 'discretionary mandates', link: '/admin/clients' },
              { icon: <BarChart3 size={16} className="text-[#2dd4bf]" />, label: 'Portfolios', value: loading ? '—' : `${stats.totalPortfolios} / 25`, sub: 'active portfolios', link: '#' },
              {
                icon: <TrendingUp size={16} className="text-[#60a5fa]" />,
                label: totalCurrentNAV > 0 ? 'Total AUM (current)' : 'Total AUM (starting)',
                value: loading ? '—' : fmt.ngnB(totalCurrentNAV > 0 ? totalCurrentNAV : stats.totalNAV),
                sub: totalCurrentNAV > 0 ? 'market value' : 'cost basis',
                link: '#'
              },
            ].map((s, i) => (
              <Link href={s.link} key={i}>
                <div className="tw-card flex items-center gap-3 hover:border-white/15 transition-colors">
                  <div className="w-8 h-8 rounded-lg bg-[#1a1e28] flex items-center justify-center flex-shrink-0">{s.icon}</div>
                  <div>
                    <div className="kpi-label">{s.label}</div>
                    <div className="text-lg font-semibold font-mono">{s.value}</div>
                    <div className="text-[10px] text-[#555d72]">{s.sub}</div>
                  </div>
                </div>
              </Link>
            ))}
          </div>

          {/* Capacity bar */}
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

          {/* AUM chart — only when we have current NAV data */}
          {allPortfolios.filter(p => p.nav > 0).length > 1 && (
            <div className="tw-card mb-6">
              <div className="text-xs font-semibold uppercase tracking-widest text-[#555d72] mb-4">
                AUM by portfolio — {totalCurrentNAV > 0 ? 'current market value' : 'starting NAV'}
              </div>
              <AUMBarChart portfolios={allPortfolios.filter(p => p.nav > 0)} />
            </div>
          )}

          {/* Portfolio grid */}
          {loading ? (
            <div className="flex items-center justify-center py-20 text-[#555d72] text-xs">
              <RefreshCw size={14} className="animate-spin mr-2" /> Loading portfolios…
            </div>
          ) : clients.length === 0 ? (
            <div className="tw-card text-center py-16 border-dashed">
              <Users size={32} className="text-[#555d72] mx-auto mb-4" />
              <div className="text-sm font-medium mb-1">No clients yet</div>
              <Link href="/admin/clients/new"
                className="inline-flex items-center gap-2 bg-[#a78bfa] text-white px-5 py-2.5 rounded-lg text-sm font-medium mt-4">
                <Plus size={14} /> Add first client
              </Link>
            </div>
          ) : (
            <div className="space-y-8">
              {clients.map((client: any) => (
                <div key={client.id}>
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-7 h-7 rounded-lg bg-[#1a1e28] border border-white/10 flex items-center justify-center text-[10px] font-bold text-[#a78bfa]">
                      {client.code?.slice(0, 2).toUpperCase()}
                    </div>
                    <span className="text-sm font-semibold">{client.name}</span>
                    <span className={`badge ${typeColor[client.type] || 'badge-cash'}`}>{client.type}</span>
                    <div className="ml-auto flex items-center gap-2">
                      <Link href={`/admin/clients/${client.id}`}
                        className="text-[11px] text-[#555d72] hover:text-[#a78bfa] transition-colors flex items-center gap-1">
                        Manage <ChevronRight size={11} />
                      </Link>
                      <button
                        onClick={() => setConfirmArchiveClient({ id: client.id, name: client.name })}
                        className="flex items-center gap-1 text-[11px] text-[#555d72] hover:text-[#f59e0b] border border-white/10 hover:border-[#f59e0b]/40 rounded px-2 py-0.5 transition-colors"
                        title="Archive client">
                        <Trash2 size={10} /> Archive
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-3">
                    {(client.portfolios || []).map((p: any) => {
                      const currentNAV    = navMap[p.id] ?? 0
                      const hasCurrentNAV = currentNAV > 0
                      const gain          = currentNAV - p.starting_nav
                      const gainPct       = p.starting_nav > 0 ? gain / p.starting_nav : 0

                      return (
                        <div key={p.id} className="relative group">
                          <Link href={`/portfolio/${p.id}`}>
                            <div className="tw-card hover:border-[#a78bfa]/30 hover:bg-[#a78bfa]/[0.02] transition-all cursor-pointer h-full">
                              <div className="flex items-center justify-between mb-3">
                                <div className="w-8 h-8 rounded-lg bg-[#a78bfa]/10 border border-[#a78bfa]/20 flex items-center justify-center text-[#a78bfa] font-bold text-sm">
                                  {p.label}
                                </div>
                                <span className={`badge text-[9px] ${p.status === 'active' ? 'badge-ok' : 'badge-hold'}`}>
                                  {p.status}
                                </span>
                              </div>

                              <div className="text-sm font-medium leading-tight mb-2 group-hover:text-[#a78bfa] transition-colors pr-6">
                                {p.name}
                              </div>

                              {hasCurrentNAV ? (
                                <>
                                  <div className="text-base font-bold font-mono text-[#e8eaf0]">
                                    {fmt.ngnM(currentNAV)}
                                  </div>
                                  <div className="flex items-center gap-1.5 mt-1">
                                    <span className="text-[10px] font-mono" style={{ color: gain >= 0 ? '#22c55e' : '#ef4444' }}>
                                      {gain >= 0 ? '+' : ''}{fmt.ngnM(gain)} ({gain >= 0 ? '+' : ''}{(gainPct * 100).toFixed(1)}%)
                                    </span>
                                  </div>
                                  <div className="text-[10px] text-[#555d72] mt-0.5">
                                    from {fmt.ngnM(p.starting_nav)} start
                                  </div>
                                </>
                              ) : (
                                <div className="text-[11px] font-mono text-[#555d72] mt-1">
                                  {fmt.ngnM(p.starting_nav)} start
                                </div>
                              )}

                              {p.valuation_date && (
                                <div className="text-[10px] text-[#555d72] mt-2">
                                  Val. {fmt.date(p.valuation_date)}
                                </div>
                              )}

                              <div className="flex items-center gap-1 mt-3 text-[11px] text-[#a78bfa] opacity-0 group-hover:opacity-100 transition-opacity">
                                <Activity size={11} /> Open →
                              </div>
                            </div>
                          </Link>

                          {/* Delete button — top-right corner, shown on hover */}
                          <button
                            onClick={e => { e.preventDefault(); setConfirmDel({ id: p.id, name: p.name }) }}
                            className="absolute top-2 right-2 w-6 h-6 rounded-md bg-[#1a1e28] flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all hover:bg-[#ef4444]/20 z-10"
                            title="Archive portfolio">
                            <Trash2 size={11} className="text-[#555d72] hover:text-[#ef4444]" />
                          </button>
                        </div>
                      )
                    })}

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
