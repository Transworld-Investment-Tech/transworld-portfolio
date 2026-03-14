'use client'
import { useEffect, useState, useCallback } from 'react'
import {
  Search, Plus, Trash2, Edit3, Save, X, Eye, BookOpen,
  TrendingUp, Shield, BarChart3, Star, Filter, RefreshCw,
  ChevronDown, ChevronUp, Tag, AlertCircle, Sparkles
} from 'lucide-react'

type Section = 'all' | 'equity' | 'fixed_income' | 'other' | 'watch'

const SECTIONS = [
  { key: 'all',          label: 'All',          icon: BookOpen,   color: '#8a91a8' },
  { key: 'equity',       label: 'Equities',     icon: TrendingUp, color: '#22c55e' },
  { key: 'fixed_income', label: 'Fixed Income', icon: Shield,     color: '#60a5fa' },
  { key: 'other',        label: 'Other',        icon: BarChart3,  color: '#f59e0b' },
  { key: 'watch',        label: 'Eagle Eye',    icon: Eye,        color: '#a78bfa' },
] as const

const SECTION_LABELS: Record<string, { label: string; color: string; bg: string }> = {
  equity:       { label: 'Equity',       color: '#22c55e', bg: '#22c55e18' },
  fixed_income: { label: 'Fixed Income', color: '#60a5fa', bg: '#60a5fa18' },
  other:        { label: 'Other',        color: '#f59e0b', bg: '#f59e0b18' },
  watch:        { label: 'Eagle Eye',    color: '#a78bfa', bg: '#a78bfa18' },
}

const SUB_TYPES: Record<string, string[]> = {
  equity:       ['Large Cap', 'Mid Cap', 'Small Cap', 'Banking', 'Telecom', 'Oil & Gas', 'Consumer', 'Industrial', 'Healthcare'],
  fixed_income: ['Federal', 'Federal Sukuk', 'State', 'Corporate', 'Supranational', 'Commercial Paper'],
  other:        ['ETF', 'REIT', 'Fund', 'Commodity', 'Index'],
  watch:        ['Listing Pipeline', 'Corporate Action', 'Macro', 'Governance', 'Regulatory'],
}

interface WatchItem {
  id: string
  rank: number
  ticker: string
  name: string
  section: string
  sub_type: string | null
  rationale: string | null
  tags: string[]
  notes: string | null
  active: boolean
  created_at: string
  updated_at: string
}

interface EditForm {
  ticker: string
  name: string
  section: string
  sub_type: string
  rationale: string
  notes: string
  tags: string
  rank: number
}

const emptyForm = (): EditForm => ({
  ticker: '', name: '', section: 'equity', sub_type: '',
  rationale: '', notes: '', tags: '', rank: 999,
})

export default function WatchlistPage() {
  const [items,       setItems]       = useState<WatchItem[]>([])
  const [loading,     setLoading]     = useState(true)
  const [section,     setSection]     = useState<Section>('all')
  const [search,      setSearch]      = useState('')
  const [subFilter,   setSubFilter]   = useState('')
  const [expanded,    setExpanded]    = useState<string | null>(null)
  const [editingId,   setEditingId]   = useState<string | null>(null)
  const [adding,      setAdding]      = useState(false)
  const [form,        setForm]        = useState<EditForm>(emptyForm())
  const [saving,      setSaving]      = useState(false)
  const [msg,         setMsg]         = useState('')
  const [aiInsight,   setAiInsight]   = useState<Record<string, string>>({})
  const [loadingAI,   setLoadingAI]   = useState<string | null>(null)
  const [sortBy,      setSortBy]      = useState<'rank' | 'name' | 'section'>('rank')
  const [sortDir,     setSortDir]     = useState<'asc' | 'desc'>('asc')

  const load = useCallback(async () => {
    setLoading(true)
    const res = await fetch('/api/watchlist')
    const d   = await res.json()
    setItems(d.items ?? [])
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [])

  function flash(m: string) { setMsg(m); setTimeout(() => setMsg(''), 3000) }

  const filtered = items
    .filter(it => section === 'all' || it.section === section)
    .filter(it => !subFilter || it.sub_type === subFilter)
    .filter(it => !search || it.name.toLowerCase().includes(search.toLowerCase()) || it.ticker.toLowerCase().includes(search.toLowerCase()) || it.rationale?.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      let va: any = sortBy === 'rank' ? a.rank : sortBy === 'name' ? a.name : a.section
      let vb: any = sortBy === 'rank' ? b.rank : sortBy === 'name' ? b.name : b.section
      if (va < vb) return sortDir === 'asc' ? -1 : 1
      if (va > vb) return sortDir === 'asc' ? 1 : -1
      return 0
    })

  // Stats
  const stats = {
    total:   items.length,
    equity:  items.filter(i => i.section === 'equity').length,
    fi:      items.filter(i => i.section === 'fixed_income').length,
    other:   items.filter(i => i.section === 'other').length,
    watch:   items.filter(i => i.section === 'watch').length,
  }

  async function saveItem() {
    if (!form.name || !form.section) return
    setSaving(true)
    const payload = {
      ...form,
      tags: form.tags.split(',').map(t => t.trim()).filter(Boolean),
    }
    try {
      if (editingId) {
        await fetch(`/api/watchlist/${editingId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        flash('Updated ✓')
      } else {
        await fetch('/api/watchlist', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) })
        flash('Added ✓')
      }
      setEditingId(null); setAdding(false); setForm(emptyForm()); load()
    } catch { flash('Error saving') }
    setSaving(false)
  }

  async function deleteItem(id: string, name: string) {
    if (!confirm(`Remove "${name}" from watchlist?`)) return
    await fetch(`/api/watchlist/${id}`, { method: 'DELETE' })
    flash('Removed')
    load()
  }

  function startEdit(item: WatchItem) {
    setForm({
      ticker: item.ticker ?? '',
      name: item.name,
      section: item.section,
      sub_type: item.sub_type ?? '',
      rationale: item.rationale ?? '',
      notes: item.notes ?? '',
      tags: (item.tags ?? []).join(', '),
      rank: item.rank,
    })
    setEditingId(item.id)
    setAdding(false)
  }

  async function fetchAIInsight(item: WatchItem) {
    if (aiInsight[item.id]) { setExpanded(item.id); return }
    setLoadingAI(item.id)
    setExpanded(item.id)
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 600,
          messages: [{
            role: 'user',
            content: `You are a Nigerian capital markets analyst at Transworld Asset Management, Lagos.
Provide a brief, current market intelligence note for this security:

Name: ${item.name}
Ticker: ${item.ticker || 'N/A'}
Type: ${item.section} ${item.sub_type ? '— ' + item.sub_type : ''}
Watchlist rationale: ${item.rationale || 'N/A'}

Write 3-4 sentences covering:
1. Current market context / recent developments you know about
2. Key metrics or yield (P/E, dividend yield, or bond yield as applicable)
3. Key risk or opportunity to watch right now
4. One specific catalyst or event to monitor

Be specific and factual. Acknowledge if data is from training knowledge with approximate date.
Write in plain text, no markdown headers.`
          }],
        })
      })
      const d = await res.json()
      const text = d.content?.[0]?.text ?? 'No insight available.'
      setAiInsight(prev => ({ ...prev, [item.id]: text }))
    } catch {
      setAiInsight(prev => ({ ...prev, [item.id]: 'Could not load AI insight at this time.' }))
    }
    setLoadingAI(null)
  }

  const toggleSort = (col: typeof sortBy) => {
    if (sortBy === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortBy(col); setSortDir('asc') }
  }

  const SortIcon = ({ col }: { col: typeof sortBy }) =>
    sortBy === col
      ? sortDir === 'asc' ? <ChevronUp size={11} /> : <ChevronDown size={11} />
      : <ChevronDown size={11} className="opacity-20" />

  // Available sub-types for current section filter
  const availableSubs = section === 'all'
    ? Array.from(new Set(items.map(i => i.sub_type).filter(Boolean))) as string[]
    : SUB_TYPES[section] ?? []

  const formSubs = SUB_TYPES[form.section] ?? []

  return (
    <div className="min-h-screen flex flex-col">
      {/* Header */}
      <header className="bg-[#13161d] border-b border-white/[0.07] px-6 py-4 sticky top-0 z-10">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-[10px] font-bold tracking-widest text-[#555d72] uppercase mb-1">Transworld Asset Management</div>
            <h1 className="text-lg font-bold">NGX Master Watchlist</h1>
            <p className="text-xs text-[#555d72] mt-0.5">
              {stats.total} securities &nbsp;·&nbsp; {stats.equity} equities &nbsp;·&nbsp; {stats.fi} fixed income &nbsp;·&nbsp; {stats.other} other &nbsp;·&nbsp; {stats.watch} eagle-eye
            </p>
          </div>
          <div className="flex items-center gap-3">
            {msg && <span className="text-xs text-[#22c55e]">{msg}</span>}
            <button onClick={load} className="flex items-center gap-1.5 text-xs text-[#8a91a8] hover:text-[#e8eaf0] border border-white/10 rounded-lg px-3 py-1.5 transition-colors">
              <RefreshCw size={12} /> Refresh
            </button>
            <button onClick={() => { setAdding(true); setEditingId(null); setForm(emptyForm()) }}
              className="flex items-center gap-2 bg-[#a78bfa] text-white px-4 py-2 rounded-lg text-xs font-semibold hover:bg-[#9b87e8] transition-colors">
              <Plus size={13} /> Add security
            </button>
          </div>
        </div>
      </header>

      <div className="flex flex-1">
        {/* Left sidebar — section tabs */}
        <div className="w-48 border-r border-white/[0.07] bg-[#0d0f14] flex-shrink-0 pt-4">
          <div className="px-4 mb-2 text-[10px] font-bold uppercase tracking-widest text-[#555d72]">Sections</div>
          {SECTIONS.map(s => {
            const Icon = s.icon
            const count = s.key === 'all' ? stats.total
              : s.key === 'equity' ? stats.equity
              : s.key === 'fixed_income' ? stats.fi
              : s.key === 'other' ? stats.other
              : stats.watch
            return (
              <button key={s.key} onClick={() => { setSection(s.key as Section); setSubFilter('') }}
                className="w-full text-left px-4 py-2.5 flex items-center gap-2.5 transition-all"
                style={section === s.key
                  ? { background: s.color + '12', borderRight: '2px solid ' + s.color }
                  : { borderRight: '2px solid transparent' }}>
                <Icon size={14} style={{ color: section === s.key ? s.color : '#555d72' }} />
                <span className="text-xs font-medium" style={{ color: section === s.key ? s.color : '#8a91a8' }}>{s.label}</span>
                <span className="ml-auto text-[10px] font-mono" style={{ color: section === s.key ? s.color : '#555d72' }}>{count}</span>
              </button>
            )
          })}

          {/* Sub-type filter */}
          {availableSubs.length > 0 && (
            <div className="mt-4 px-4">
              <div className="text-[10px] font-bold uppercase tracking-widest text-[#555d72] mb-2">Filter by type</div>
              <button onClick={() => setSubFilter('')}
                className="w-full text-left text-[11px] py-1 px-2 rounded mb-0.5 transition-colors"
                style={{ background: !subFilter ? 'rgba(255,255,255,0.05)' : 'transparent', color: !subFilter ? '#e8eaf0' : '#555d72' }}>
                All types
              </button>
              {availableSubs.map(sub => (
                <button key={sub} onClick={() => setSubFilter(sub === subFilter ? '' : sub)}
                  className="w-full text-left text-[11px] py-1 px-2 rounded mb-0.5 transition-colors truncate"
                  style={{ background: subFilter === sub ? 'rgba(255,255,255,0.05)' : 'transparent', color: subFilter === sub ? '#e8eaf0' : '#555d72' }}>
                  {sub}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Main content */}
        <div className="flex-1 overflow-auto">

          {/* Add / Edit form */}
          {(adding || editingId) && (
            <div className="m-4 p-5 bg-[#13161d] border border-[#a78bfa]/30 rounded-xl">
              <div className="flex items-center justify-between mb-4">
                <div className="text-xs font-bold uppercase tracking-widest text-[#a78bfa]">
                  {editingId ? 'Edit security' : 'Add new security'}
                </div>
                <button onClick={() => { setAdding(false); setEditingId(null); setForm(emptyForm()) }}>
                  <X size={14} className="text-[#555d72] hover:text-[#e8eaf0]" />
                </button>
              </div>
              <div className="grid grid-cols-4 gap-3 mb-3">
                <div>
                  <label className="block text-[10px] text-[#555d72] mb-1 uppercase tracking-wider">Ticker / ID</label>
                  <input value={form.ticker} onChange={e => setForm(f => ({ ...f, ticker: e.target.value }))} className="tw-input text-xs font-mono" placeholder="e.g. MTNN" />
                </div>
                <div className="col-span-2">
                  <label className="block text-[10px] text-[#555d72] mb-1 uppercase tracking-wider">Name <span className="text-[#ff5c7a]">*</span></label>
                  <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} className="tw-input text-xs" placeholder="Security full name" />
                </div>
                <div>
                  <label className="block text-[10px] text-[#555d72] mb-1 uppercase tracking-wider">Rank</label>
                  <input type="number" value={form.rank} onChange={e => setForm(f => ({ ...f, rank: Number(e.target.value) }))} className="tw-input text-xs font-mono" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3 mb-3">
                <div>
                  <label className="block text-[10px] text-[#555d72] mb-1 uppercase tracking-wider">Section <span className="text-[#ff5c7a]">*</span></label>
                  <select value={form.section} onChange={e => setForm(f => ({ ...f, section: e.target.value, sub_type: '' }))} className="tw-select text-xs">
                    <option value="equity">Equity</option>
                    <option value="fixed_income">Fixed Income</option>
                    <option value="other">Other Securities</option>
                    <option value="watch">Eagle Eye Watch</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] text-[#555d72] mb-1 uppercase tracking-wider">Sub-type</label>
                  <select value={form.sub_type} onChange={e => setForm(f => ({ ...f, sub_type: e.target.value }))} className="tw-select text-xs">
                    <option value="">Select…</option>
                    {formSubs.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              </div>
              <div className="mb-3">
                <label className="block text-[10px] text-[#555d72] mb-1 uppercase tracking-wider">Why it's on the watchlist</label>
                <textarea value={form.rationale} onChange={e => setForm(f => ({ ...f, rationale: e.target.value }))} rows={2} className="tw-input text-xs resize-none" placeholder="Investment rationale and why this security deserves monitoring…" />
              </div>
              <div className="grid grid-cols-2 gap-3 mb-4">
                <div>
                  <label className="block text-[10px] text-[#555d72] mb-1 uppercase tracking-wider">Notes (private)</label>
                  <input value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} className="tw-input text-xs" placeholder="Internal notes…" />
                </div>
                <div>
                  <label className="block text-[10px] text-[#555d72] mb-1 uppercase tracking-wider">Tags (comma-separated)</label>
                  <input value={form.tags} onChange={e => setForm(f => ({ ...f, tags: e.target.value }))} className="tw-input text-xs" placeholder="e.g. banking, dividend, recapitalisation" />
                </div>
              </div>
              <div className="flex gap-3">
                <button onClick={saveItem} disabled={saving || !form.name}
                  className="flex items-center gap-2 bg-[#a78bfa] text-white px-4 py-2 rounded-lg text-xs font-semibold hover:bg-[#9b87e8] disabled:opacity-50 transition-colors">
                  <Save size={12} /> {saving ? 'Saving…' : editingId ? 'Save changes' : 'Add to watchlist'}
                </button>
                <button onClick={() => { setAdding(false); setEditingId(null); setForm(emptyForm()) }}
                  className="px-4 py-2 border border-white/10 rounded-lg text-xs text-[#8a91a8] hover:text-[#e8eaf0] transition-colors">
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Search & sort bar */}
          <div className="px-4 py-3 flex items-center gap-3 border-b border-white/[0.07] bg-[#0d0f14] sticky top-0 z-[5]">
            <div className="relative flex-1 max-w-sm">
              <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[#555d72]" />
              <input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search name, ticker, rationale…"
                className="tw-input pl-8 py-1.5 text-xs w-full" />
            </div>
            <div className="flex items-center gap-1 text-[10px] text-[#555d72]">
              <span>Sort:</span>
              {(['rank','name','section'] as const).map(col => (
                <button key={col} onClick={() => toggleSort(col)}
                  className="flex items-center gap-0.5 px-2 py-1 rounded capitalize transition-colors"
                  style={{ background: sortBy === col ? 'rgba(167,139,250,0.1)' : 'transparent', color: sortBy === col ? '#a78bfa' : '#555d72' }}>
                  {col} <SortIcon col={col} />
                </button>
              ))}
            </div>
            <span className="text-[11px] text-[#555d72] ml-auto">{filtered.length} showing</span>
          </div>

          {/* Loading */}
          {loading && <div className="flex items-center justify-center h-40 text-[#555d72] text-xs">Loading watchlist…</div>}

          {/* Items */}
          {!loading && (
            <div className="p-4 space-y-2">
              {filtered.length === 0 && (
                <div className="text-center py-12 text-[#555d72] text-xs">No securities match your filter.</div>
              )}
              {filtered.map(item => {
                const sl = SECTION_LABELS[item.section] ?? { label: item.section, color: '#8a91a8', bg: 'transparent' }
                const isExpanded  = expanded === item.id
                const isEditing   = editingId === item.id
                const insight     = aiInsight[item.id]
                const loadingThis = loadingAI === item.id

                return (
                  <div key={item.id}
                    className="tw-card py-0 overflow-hidden transition-all"
                    style={{ borderLeft: `3px solid ${sl.color}` }}>

                    {/* Main row */}
                    <div className="flex items-start gap-3 px-4 py-3">
                      {/* Rank */}
                      <div className="text-[11px] font-mono text-[#555d72] w-6 flex-shrink-0 pt-0.5 text-right">{item.rank}</div>

                      {/* Ticker badge */}
                      {item.ticker && (
                        <div className="flex-shrink-0 mt-0.5">
                          <span className="font-mono text-[10px] font-bold px-1.5 py-0.5 rounded"
                            style={{ background: sl.bg, color: sl.color }}>
                            {item.ticker}
                          </span>
                        </div>
                      )}

                      {/* Name + meta */}
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold text-[#e8eaf0]">{item.name}</span>
                          <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold"
                            style={{ background: sl.bg, color: sl.color }}>
                            {sl.label}
                          </span>
                          {item.sub_type && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded border border-white/10 text-[#555d72]">
                              {item.sub_type}
                            </span>
                          )}
                          {(item.tags ?? []).map(tag => (
                            <span key={tag} className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.04] text-[#555d72]">
                              #{tag}
                            </span>
                          ))}
                        </div>
                        {item.rationale && !isExpanded && (
                          <p className="text-[11px] text-[#555d72] mt-1 line-clamp-1">{item.rationale}</p>
                        )}
                        {isExpanded && (
                          <div className="mt-2 space-y-2">
                            {item.rationale && (
                              <div>
                                <div className="text-[10px] font-semibold text-[#8a91a8] uppercase tracking-wider mb-1">Watchlist Rationale</div>
                                <p className="text-[12px] text-[#8a91a8] leading-relaxed">{item.rationale}</p>
                              </div>
                            )}
                            {item.notes && (
                              <div className="px-3 py-2 bg-[#1a1e28] rounded-lg">
                                <div className="text-[10px] font-semibold text-[#555d72] uppercase tracking-wider mb-1">Notes</div>
                                <p className="text-[11px] text-[#8a91a8]">{item.notes}</p>
                              </div>
                            )}
                            {/* AI Insight */}
                            <div className="mt-3 border-t border-white/[0.07] pt-3">
                              {!insight && !loadingThis && (
                                <button onClick={() => fetchAIInsight(item)}
                                  className="flex items-center gap-1.5 text-xs text-[#a78bfa] hover:text-[#9b87e8] transition-colors">
                                  <Sparkles size={12} /> Get AI market intelligence
                                </button>
                              )}
                              {loadingThis && (
                                <div className="flex items-center gap-2 text-xs text-[#555d72]">
                                  <div className="w-3 h-3 border-2 border-white/20 border-t-[#a78bfa] rounded-full animate-spin" />
                                  Getting market intelligence…
                                </div>
                              )}
                              {insight && (
                                <div className="bg-[#a78bfa0a] border border-[#a78bfa20] rounded-lg p-3">
                                  <div className="flex items-center gap-1.5 mb-2">
                                    <Sparkles size={11} className="text-[#a78bfa]" />
                                    <span className="text-[10px] font-bold text-[#a78bfa] uppercase tracking-wider">AI Market Intelligence</span>
                                  </div>
                                  <p className="text-[12px] text-[#8a91a8] leading-relaxed">{insight}</p>
                                  <button onClick={() => fetchAIInsight({ ...item, id: item.id + '_refresh' } as any)}
                                    className="mt-2 text-[10px] text-[#555d72] hover:text-[#a78bfa] transition-colors">
                                    ↻ Refresh
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </div>

                      {/* Actions */}
                      <div className="flex items-center gap-1 flex-shrink-0">
                        <button onClick={() => setExpanded(isExpanded ? null : item.id)}
                          className="p-1.5 rounded hover:bg-white/[0.05] text-[#555d72] hover:text-[#e8eaf0] transition-colors">
                          {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                        </button>
                        <button onClick={() => startEdit(item)}
                          className="p-1.5 rounded hover:bg-white/[0.05] text-[#555d72] hover:text-[#a78bfa] transition-colors">
                          <Edit3 size={13} />
                        </button>
                        <button onClick={() => deleteItem(item.id, item.name)}
                          className="p-1.5 rounded hover:bg-white/[0.05] text-[#555d72] hover:text-[#ff5c7a] transition-colors">
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {/* Footer note */}
          {!loading && (
            <div className="px-8 py-6 border-t border-white/[0.07] text-[10px] text-[#555d72] leading-relaxed">
              <strong className="text-[#8a91a8]">Usage:</strong> This watchlist is Transworld's investment idea universe — 55 equities, 70 fixed income, 15 other securities and 8 eagle-eye watch items.
              The AI report engine scans this list when generating portfolio intelligence.
              Click any item to expand, then "Get AI market intelligence" for a live Claude-powered brief on that security.
              Source: NGX Daily Summary 12 March 2026 · NGX Daily Official List (Bonds) 13 March 2026.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
