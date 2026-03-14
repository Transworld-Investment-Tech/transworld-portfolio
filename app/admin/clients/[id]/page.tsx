'use client'
import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { fmt } from '@/lib/portfolio'
import { ArrowLeft, Save, Plus, ExternalLink, BarChart3 } from 'lucide-react'

export default function ClientDetailPage() {
  const { id: clientId } = useParams() as { id: string }
  const router = useRouter()
  const [client, setClient] = useState<any>(null)
  const [portfolios, setPortfolios] = useState<any[]>([])
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const { data } = await supabase.from('clients')
        .select('*, portfolios(id, label, name, starting_nav, currency, status, valuation_date, created_at)')
        .eq('id', clientId).single()
      setClient(data)
      setPortfolios(data?.portfolios ?? [])
      setLoading(false)
    }
    load()
  }, [clientId])

  async function save() {
    setSaving(true)
    const { error } = await supabase.from('clients').update({
      name: client.name,
      code: client.code,
      type: client.type,
      contact_name: client.contact_name,
      contact_email: client.contact_email,
      notes: client.notes,
      status: client.status,
    }).eq('id', clientId)
    setSaving(false)
    setMsg(error ? error.message : 'Saved ✓')
    setTimeout(() => setMsg(''), 2500)
  }

  if (loading || !client) return <div className="flex items-center justify-center h-64 text-[#555d72] text-xs">Loading…</div>

  return (
    <div>
      <div className="px-8 py-5 border-b border-white/[0.07] bg-[#13161d] flex items-center gap-4">
        <Link href="/admin/clients" className="flex items-center gap-1.5 text-xs text-[#8a91a8] hover:text-[#e8eaf0] transition-colors">
          <ArrowLeft size={13} /> Clients
        </Link>
        <div className="w-px h-4 bg-white/10" />
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-[#a78bfa]/10 border border-[#a78bfa]/20 flex items-center justify-center text-[10px] font-bold text-[#a78bfa]">
            {client.code?.slice(0, 2).toUpperCase()}
          </div>
          <h1 className="text-base font-semibold">{client.name}</h1>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {msg && <span className={`text-xs ${msg.includes('✓') ? 'text-[#00d4a4]' : 'text-[#ff5c7a]'}`}>{msg}</span>}
          <button onClick={save} disabled={saving}
            className="flex items-center gap-2 bg-[#a78bfa] text-white px-4 py-2 rounded-lg text-xs font-medium hover:bg-[#9b87e8] disabled:opacity-50 transition-colors">
            <Save size={13} /> {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>

      <div className="px-8 py-6 max-w-4xl">
        <div className="grid grid-cols-[1fr_1.4fr] gap-6">

          {/* Client info form */}
          <div className="space-y-5">
            <div className="tw-card space-y-4">
              <div className="text-xs font-semibold uppercase tracking-widest text-[#555d72] pb-2 border-b border-white/[0.07]">Client info</div>
              {[
                ['Full name', 'name', 'text'],
                ['Client code', 'code', 'text'],
                ['Contact name', 'contact_name', 'text'],
                ['Contact email', 'contact_email', 'email'],
              ].map(([label, key, type]) => (
                <div key={key}>
                  <label className="block text-xs text-[#8a91a8] mb-1.5">{label}</label>
                  <input type={type} value={client[key] || ''} onChange={e => setClient((c: any) => ({ ...c, [key]: e.target.value }))} className="tw-input" />
                </div>
              ))}
              <div>
                <label className="block text-xs text-[#8a91a8] mb-1.5">Client type</label>
                <select value={client.type} onChange={e => setClient((c: any) => ({ ...c, type: e.target.value }))} className="tw-select">
                  <option value="discretionary">Discretionary</option>
                  <option value="advisory">Advisory</option>
                  <option value="internal">Internal</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-[#8a91a8] mb-1.5">Status</label>
                <select value={client.status} onChange={e => setClient((c: any) => ({ ...c, status: e.target.value }))} className="tw-select">
                  <option value="active">Active</option>
                  <option value="inactive">Inactive</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-[#8a91a8] mb-1.5">Notes</label>
                <textarea value={client.notes || ''} onChange={e => setClient((c: any) => ({ ...c, notes: e.target.value }))} rows={3} className="tw-input resize-none" />
              </div>
            </div>
          </div>

          {/* Portfolios */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="text-xs font-semibold uppercase tracking-widest text-[#555d72]">Portfolios ({portfolios.length})</div>
              <Link href={`/admin/portfolios/new?client=${clientId}`}
                className="flex items-center gap-1.5 text-xs text-[#a78bfa] hover:underline">
                <Plus size={12} /> Add portfolio
              </Link>
            </div>
            <div className="space-y-3">
              {portfolios.length === 0 ? (
                <div className="tw-card text-center py-8 border-dashed">
                  <BarChart3 size={22} className="text-[#555d72] mx-auto mb-2" />
                  <div className="text-xs text-[#555d72]">No portfolios yet</div>
                  <Link href={`/admin/portfolios/new?client=${clientId}`}
                    className="inline-flex items-center gap-1.5 mt-3 text-xs text-[#a78bfa] hover:underline">
                    <Plus size={12} /> Create first portfolio
                  </Link>
                </div>
              ) : (
                portfolios
                  .sort((a, b) => a.label.localeCompare(b.label))
                  .map(p => (
                    <Link href={`/portfolio/${p.id}`} key={p.id}>
                      <div className="tw-card flex items-center gap-4 hover:border-[#a78bfa]/30 transition-all cursor-pointer group">
                        <div className="w-9 h-9 rounded-lg bg-[#a78bfa]/10 border border-[#a78bfa]/20 flex items-center justify-center text-[#a78bfa] font-bold text-sm flex-shrink-0">
                          {p.label}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm font-medium truncate group-hover:text-[#a78bfa] transition-colors">{p.name}</div>
                          <div className="text-[11px] text-[#555d72] mt-0.5 font-mono">{fmt.ngnM(p.starting_nav)}</div>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <span className={`badge ${p.status === 'active' ? 'badge-ok' : p.status === 'closed' ? 'badge-breach' : 'badge-hold'}`}>{p.status}</span>
                          <ExternalLink size={13} className="text-[#555d72] group-hover:text-[#a78bfa] transition-colors" />
                        </div>
                      </div>
                    </Link>
                  ))
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
