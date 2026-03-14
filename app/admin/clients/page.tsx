'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { fmt } from '@/lib/portfolio'
import { PlusCircle, ChevronRight, Search, Users } from 'lucide-react'

export default function ClientsPage() {
  const [clients, setClients] = useState<any[]>([])
  const [search, setSearch] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.from('clients')
      .select('*, portfolios(id, label, name, starting_nav, status)')
      .order('created_at', { ascending: true })
      .then(({ data }) => { setClients(data ?? []); setLoading(false) })
  }, [])

  const filtered = clients.filter(c =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    c.code.toLowerCase().includes(search.toLowerCase())
  )

  const typeColor: Record<string, string> = { discretionary: 'badge-ntb', advisory: 'badge-stock', internal: 'badge-cash' }

  return (
    <div>
      <div className="px-8 py-5 border-b border-white/[0.07] bg-[#13161d] flex items-center justify-between">
        <div>
          <h1 className="text-base font-semibold">Clients</h1>
          <p className="text-xs text-[#555d72] mt-0.5">{clients.length} client{clients.length !== 1 ? 's' : ''} registered</p>
        </div>
        <Link href="/admin/clients/new" className="flex items-center gap-2 bg-[#a78bfa] text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-[#9b87e8] transition-colors">
          <PlusCircle size={14} /> Add client
        </Link>
      </div>

      <div className="px-8 py-6 max-w-4xl">
        {/* Search */}
        <div className="relative mb-5">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#555d72]" />
          <input value={search} onChange={e => setSearch(e.target.value)}
            placeholder="Search clients…" className="tw-input pl-8" />
        </div>

        {loading ? (
          <div className="text-center py-12 text-xs text-[#555d72]">Loading…</div>
        ) : filtered.length === 0 ? (
          <div className="tw-card text-center py-12">
            <Users size={28} className="text-[#555d72] mx-auto mb-3" />
            <div className="text-sm font-medium mb-1">No clients yet</div>
            <div className="text-xs text-[#555d72] mb-4">Add your first client to get started</div>
            <Link href="/admin/clients/new" className="inline-flex items-center gap-2 bg-[#a78bfa] text-white px-4 py-2 rounded-lg text-sm">
              <PlusCircle size={13} /> Add client
            </Link>
          </div>
        ) : (
          <div className="tw-card p-0 overflow-hidden">
            <table className="tw-table w-full">
              <thead><tr><th>Client</th><th>Code</th><th>Type</th><th>Portfolios</th><th>Total NAV</th><th>Status</th><th></th></tr></thead>
              <tbody>
                {filtered.map(c => {
                  const portfolios = c.portfolios ?? []
                  const totalNAV = portfolios.reduce((s: number, p: any) => s + p.starting_nav, 0)
                  return (
                    <tr key={c.id}>
                      <td>
                        <div className="flex items-center gap-2.5">
                          <div className="w-7 h-7 rounded-lg bg-[#1a1e28] border border-white/10 flex items-center justify-center text-[10px] font-bold text-[#a78bfa]">
                            {c.code.slice(0, 2).toUpperCase()}
                          </div>
                          <div>
                            <div className="text-sm font-medium">{c.name}</div>
                            {c.contact_name && <div className="text-[10px] text-[#555d72]">{c.contact_name}</div>}
                          </div>
                        </div>
                      </td>
                      <td className="font-mono text-[11px] text-[#555d72]">{c.code}</td>
                      <td><span className={`badge ${typeColor[c.type] ?? 'badge-cash'}`}>{c.type}</span></td>
                      <td>
                        <div className="flex gap-1">
                          {portfolios.map((p: any) => (
                            <Link href={`/portfolio/${p.id}`} key={p.id}>
                              <span className="w-5 h-5 rounded bg-[#a78bfa]/10 border border-[#a78bfa]/20 text-[#a78bfa] text-[10px] font-bold flex items-center justify-center hover:bg-[#a78bfa]/20 transition-colors">
                                {p.label}
                              </span>
                            </Link>
                          ))}
                        </div>
                      </td>
                      <td className="font-mono">{fmt.ngnM(totalNAV)}</td>
                      <td><span className={`badge ${c.status === 'active' ? 'badge-ok' : 'badge-hold'}`}>{c.status}</span></td>
                      <td>
                        <Link href={`/admin/clients/${c.id}`} className="text-[11px] text-[#555d72] hover:text-[#a78bfa] transition-colors">Manage →</Link>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
