'use client'

import { useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useState, useCallback, useMemo } from 'react'
import {
  Search, Plus, Trash2, Edit3, Save, X, Eye, BookOpen,
  TrendingUp, Shield, BarChart3, RefreshCw,
  ChevronDown, ChevronUp, Sparkles,
} from 'lucide-react'
import { supabase } from '@/lib/supabase'
import Link from 'next/link'

// v27ax-fix5: opt out of static pre-rendering. useSearchParams (added in
// fix4) requires either a <Suspense> wrapper or this directive, otherwise
// `next build` fails during static page generation. The watchlist page
// is a fully client-side admin surface with no SEO benefit, so dynamic
// rendering is the right call.
export const dynamic = 'force-dynamic'

// v20e: Hybrid rewrite of NGX Master Watchlist.
// Preserves:
//   • Internal two-pane layout (section tabs left · items right)
//   • CRUD (/api/watchlist POST/PATCH/DELETE)
//   • Section colour coding via hybrid palette
//   • Search, sort, filter logic
// Sidebar is rendered by app/watchlist/layout.tsx — do NOT render here.
//
// v21g-2: AI insight fetch now routes through /api/watchlist/insight
// (server-side proxy). The old code tried to call Anthropic directly
// from the browser, which cannot work:
// there is no safe way to expose the API key client-side, and
// Anthropic does not send CORS headers permitting browser calls.
// The new endpoint also enables web_search so insights include
// current market context instead of only training-cutoff knowledge.
//
// v26: Quick-add-from-universe picker injected at the top of the
// Add (not Edit) form panel. Search the instruments universe by
// ticker or name; one click auto-fills ticker, name, section, and
// sub-type. Manual entry remains as fallback for anything not yet
// in the instruments table.

type Section = 'all' | 'equity' | 'fixed_income' | 'other' | 'watch'

const SECTIONS = [
  { key: 'all',          label: 'All',          icon: BookOpen,   color: 'var(--text-2)' },
  { key: 'equity',       label: 'Equities',     icon: TrendingUp, color: 'var(--pos)' },
  { key: 'fixed_income', label: 'Fixed Income', icon: Shield,     color: 'var(--sidebar-bg)' },
  { key: 'other',        label: 'Other',        icon: BarChart3,  color: 'var(--warn)' },
  { key: 'watch',        label: 'Eagle Eye',    icon: Eye,        color: 'var(--gold)' },
] as const

const SECTION_LABELS: Record<string, { label: string; color: string; bg: string }> = {
  equity:       { label: 'Equity',       color: 'var(--pos)',          bg: 'rgba(45, 110, 78, 0.12)' },
  fixed_income: { label: 'Fixed Income', color: 'var(--sidebar-bg)',   bg: 'rgba(10, 31, 58, 0.1)' },
  other:        { label: 'Other',        color: 'var(--warn)',         bg: 'rgba(166, 124, 42, 0.14)' },
  watch:        { label: 'Eagle Eye',    color: 'var(--gold)',         bg: 'rgba(176, 139, 62, 0.12)' },
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

// v26: minimal shape from the instruments universe table needed
// to drive the picker + auto-fill heuristics.
interface InstrumentRow {
  instrument_id: string
  name: string
  sleeve_id: string | null
  sector: string | null
  notes: string | null
  type: string | null
}

const emptyForm = (): EditForm => ({
  ticker: '', name: '', section: 'equity', sub_type: '',
  rationale: '', notes: '', tags: '', rank: 999,
})

// v26 helpers ------------------------------------------------------------

function sleeveToSection(sleeveId: string | null | undefined): 'equity' | 'fixed_income' | 'other' {
  if (sleeveId === 'eq') return 'equity'
  if (sleeveId === 'fi') return 'fixed_income'
  return 'other'
}

function sleeveLabel(sleeveId: string | null | undefined): string {
  if (sleeveId === 'eq') return 'Equity'
  if (sleeveId === 'fi') return 'Fixed Income'
  if (sleeveId === 'liq') return 'Liquidity'
  return 'Other'
}

// FI sub-type lives at the front of `instruments.notes` as `[Federal]`,
// `[Corporate Sukuk]`, etc. — we map those to the watchlist's allowed
// fixed_income sub-types. Anything we can't classify returns ''.
function inferFiSubType(notes: string | null | undefined): string {
  if (!notes) return ''
  const m = notes.match(/^\s*\[([^\]]+)\]/)
  if (!m) return ''
  const raw = m[1].trim().toLowerCase()
  if (raw.includes('federal sukuk'))  return 'Federal Sukuk'
  if (raw.includes('corporate sukuk')) return 'Corporate'
  if (raw.includes('state sukuk'))    return 'State'
  if (raw === 'federal' || raw === 'fgs' || raw === 'fgnsb' || raw === 'federal eurobond') return 'Federal'
  if (raw === 'corporate')        return 'Corporate'
  if (raw === 'commercial paper') return 'Commercial Paper'
  if (raw === 'state')            return 'State'
  if (raw === 'supranational')    return 'Supranational'
  return ''
}

// Equity sub-type maps `instruments.sector` (free-form NGX sector text)
// to the watchlist's allowed equity sub-types. Returns '' if no clean
// match — user can pick manually.
function inferEquitySubType(sector: string | null | undefined): string {
  if (!sector) return ''
  const s = sector.trim().toLowerCase()
  if (s.includes('bank'))                                         return 'Banking'
  if (s.includes('telecom') || s.includes('ict') || s.includes('communication')) return 'Telecom'
  if (s.includes('oil') || s.includes('gas') || s.includes('petroleum'))         return 'Oil & Gas'
  if (s.includes('consumer'))                                     return 'Consumer'
  if (s.includes('industrial'))                                   return 'Industrial'
  if (s.includes('health') || s.includes('pharma'))               return 'Healthcare'
  return ''
}

function inferSubType(i: InstrumentRow, section: string): string {
  if (section === 'fixed_income') return inferFiSubType(i.notes)
  if (section === 'equity')       return inferEquitySubType(i.sector)
  return ''
}

// ------------------------------------------------------------------------

// v27ax-fix6: child component owning the useSearchParams call. Returns null —
// its only job is to read ?ticker= once and call onTicker. Wrapped in a
// Suspense boundary in the page JSX so Next.js's static generation
// pass bails out cleanly on this subtree without affecting the rest of the
// page. v27ax-fix5's `force-dynamic` directive proved insufficient in
// Next 16 / Turbopack — the canonical fix is the Suspense boundary.
function TickerDeepLinkSync({ onTicker }: { onTicker: (s: string) => void }) {
  const searchParams = useSearchParams()
  useEffect(() => {
    const ticker = searchParams?.get('ticker')
    if (ticker) onTicker(ticker)
  }, [searchParams, onTicker])
  return null
}

export default function WatchlistPage() {
  const [items,       setItems]       = useState<WatchItem[]>([])
  const [loading,     setLoading]     = useState(true)
  const [section,     setSection]     = useState<Section>('all')
  const [search,      setSearch]      = useState('')

  // v27ax-fix6: deep-link logic moved into <TickerDeepLinkSync /> defined
  // above the page component, mounted inside <Suspense> in the JSX below.
  // setSearch is passed in as a callback. Refactor was forced by Next 16 /
  // Turbopack ignoring force-dynamic for useSearchParams (build failed twice
  // before the Suspense pattern was introduced).
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

  // v26: instruments universe + picker search state
  const [instruments,   setInstruments]   = useState<InstrumentRow[]>([])
  const [pickerSearch,  setPickerSearch]  = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const res = await fetch('/api/watchlist')
    const d   = await res.json()
    setItems(d.items ?? [])
    setLoading(false)
  }, [])

  // v26: load the instruments universe once on mount. We filter
  // client-side because the universe is small (~300 rows now,
  // ~1k worst case) and we need fuzzy matching that Postgres
  // ilike doesn't quite handle.
  const loadInstruments = useCallback(async () => {
    const { data, error } = await supabase
      .from('instruments')
      .select('instrument_id, name, sleeve_id, sector, notes, type')
      .eq('approved', true)
      .order('name')
      .limit(2000)
    if (error) {
      console.error('[watchlist] loadInstruments error:', error)
      return
    }
    setInstruments((data ?? []) as InstrumentRow[])
  }, [])

  useEffect(() => { load(); loadInstruments() }, [load, loadInstruments])

  function flash(m: string) { setMsg(m); setTimeout(() => setMsg(''), 3000) }

  // v26: instruments not already on the watchlist (case-insensitive
  // ticker compare). The picker shows only addable rows.
  const availableInstruments = useMemo(() => {
    const onWatchlist = new Set(
      items.map(i => (i.ticker ?? '').trim().toLowerCase()).filter(Boolean)
    )
    return instruments.filter(i => !onWatchlist.has(i.instrument_id.toLowerCase()))
  }, [instruments, items])

  const pickerMatches = useMemo(() => {
    const q = pickerSearch.trim().toLowerCase()
    if (!q) return []
    return availableInstruments
      .filter(i =>
        i.instrument_id.toLowerCase().includes(q) ||
        (i.name ?? '').toLowerCase().includes(q),
      )
      .slice(0, 12)
  }, [availableInstruments, pickerSearch])

  function pickInstrument(i: InstrumentRow) {
    const sec = sleeveToSection(i.sleeve_id)
    setForm(f => ({
      ...f,
      ticker: i.instrument_id,
      name: i.name,
      section: sec,
      sub_type: inferSubType(i, sec),
    }))
    setPickerSearch('')
    flash(`Filled from universe: ${i.instrument_id}`)
  }

  function closeForm() {
    setAdding(false)
    setEditingId(null)
    setForm(emptyForm())
    setPickerSearch('')
  }

  const filtered = items
    .filter(it => section === 'all' || it.section === section)
    .filter(it => !subFilter || it.sub_type === subFilter)
    .filter(it => !search || it.name.toLowerCase().includes(search.toLowerCase()) || it.ticker.toLowerCase().includes(search.toLowerCase()) || it.rationale?.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      const va: any = sortBy === 'rank' ? a.rank : sortBy === 'name' ? a.name : a.section
      const vb: any = sortBy === 'rank' ? b.rank : sortBy === 'name' ? b.name : b.section
      if (va < vb) return sortDir === 'asc' ? -1 : 1
      if (va > vb) return sortDir === 'asc' ? 1 : -1
      return 0
    })

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
      closeForm(); load()
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
    setPickerSearch('')
  }

  // v21g-2: route through server-side /api/watchlist/insight endpoint
  // so the Anthropic API key stays on the server and we can enable
  // web_search for current market context.
  //
  // forceRefresh lets the "↻ Refresh" button bypass the cache without
  // the old `item.id + '_refresh'` trick, which polluted aiInsight
  // state with fake IDs.
  async function fetchAIInsight(item: WatchItem, forceRefresh = false) {
    if (aiInsight[item.id] && !forceRefresh) { setExpanded(item.id); return }
    setLoadingAI(item.id)
    setExpanded(item.id)
    try {
      const res = await fetch('/api/watchlist/insight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: item.name,
          ticker: item.ticker,
          section: item.section,
          sub_type: item.sub_type,
          rationale: item.rationale,
        }),
      })
      const d = await res.json()
      if (d.ok && d.text) {
        setAiInsight(prev => ({ ...prev, [item.id]: d.text }))
      } else {
        const errMsg = d.error
          ? `Could not load AI insight: ${d.error}`
          : 'Could not load AI insight at this time.'
        setAiInsight(prev => ({ ...prev, [item.id]: errMsg }))
      }
    } catch (e: any) {
      setAiInsight(prev => ({
        ...prev,
        [item.id]: `Could not load AI insight: ${e?.message || 'network error'}`,
      }))
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
      : <ChevronDown size={11} style={{ opacity: 0.25 }} />

  const availableSubs = section === 'all'
    ? Array.from(new Set(items.map(i => i.sub_type).filter(Boolean))) as string[]
    : SUB_TYPES[section] ?? []

  const formSubs = SUB_TYPES[form.section] ?? []

  // v26: only show the picker when adding a new entry, not when editing.
  const showPicker = adding && !editingId

  return (
    <div className="hybrid-page" style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* v27ax-fix6: deep-link sync wrapped in Suspense for Next.js static
          generation compatibility. Returns null — invisible. */}
      <Suspense fallback={null}>
        <TickerDeepLinkSync onTicker={setSearch} />
      </Suspense>
      {/* Sticky top header */}
      <header
        style={{
          background: 'var(--card)',
          borderBottom: '1px solid var(--border)',
          padding: '20px 28px',
          position: 'sticky',
          top: 0,
          zIndex: 10,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div className="eyebrow" style={{ marginBottom: 6 }}>
              Transworld Investment and Securities
            </div>
            <h1 className="hybrid-serif" style={{ fontSize: 28, fontWeight: 500, letterSpacing: '-0.005em', color: 'var(--text)', lineHeight: 1 }}>
              NGX Master Watchlist
            </h1>
            <p style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>
              {stats.total} securities &nbsp;·&nbsp; {stats.equity} equities &nbsp;·&nbsp; {stats.fi} fixed income &nbsp;·&nbsp; {stats.other} other &nbsp;·&nbsp; {stats.watch} eagle-eye
            </p>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            {msg && <span style={{ fontSize: 11, color: 'var(--pos)' }}>{msg}</span>}
            <button className="btn-h" onClick={load}>
              <RefreshCw size={12} /> Refresh
            </button>
            <button
              className="btn-h btn-h-primary"
              onClick={() => { setAdding(true); setEditingId(null); setForm(emptyForm()); setPickerSearch('') }}
            >
              <Plus size={12} /> Add security
            </button>
          </div>
        </div>
      </header>

      <div style={{ display: 'flex', flex: 1 }}>
        {/* Internal section-tabs sidebar */}
        <div
          style={{
            width: 200,
            flexShrink: 0,
            background: 'var(--bg-soft)',
            borderRight: '1px solid var(--border)',
            paddingTop: 16,
          }}
        >
          <div
            style={{
              padding: '0 16px',
              marginBottom: 8,
              fontSize: 9,
              fontWeight: 600,
              textTransform: 'uppercase' as const,
              letterSpacing: '0.18em',
              color: 'var(--text-3)',
            }}
          >
            Sections
          </div>
          {SECTIONS.map(s => {
            const Icon = s.icon
            const count =
              s.key === 'all' ? stats.total :
              s.key === 'equity' ? stats.equity :
              s.key === 'fixed_income' ? stats.fi :
              s.key === 'other' ? stats.other :
              stats.watch
            const active = section === s.key
            return (
              <button
                key={s.key}
                onClick={() => { setSection(s.key as Section); setSubFilter('') }}
                style={{
                  width: '100%',
                  textAlign: 'left' as const,
                  padding: '10px 16px',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  transition: 'all 0.15s',
                  background: active ? `color-mix(in srgb, ${s.color} 8%, transparent)` : 'transparent',
                  borderRight: active ? `2px solid ${s.color}` : '2px solid transparent',
                  border: 'none',
                  borderLeft: 'none',
                  borderTop: 'none',
                  borderBottom: 'none',
                  cursor: 'pointer',
                  fontFamily: 'var(--font-sans)',
                }}
              >
                <Icon size={13} style={{ color: active ? s.color : 'var(--text-3)' }} />
                <span
                  style={{
                    fontSize: 12,
                    fontWeight: active ? 600 : 500,
                    color: active ? s.color : 'var(--text-2)',
                  }}
                >
                  {s.label}
                </span>
                <span
                  style={{
                    marginLeft: 'auto',
                    fontSize: 10,
                    fontFamily: 'var(--font-mono)',
                    color: active ? s.color : 'var(--text-3)',
                  }}
                >
                  {count}
                </span>
              </button>
            )
          })}

          {/* Sub-type filter */}
          {availableSubs.length > 0 && (
            <div style={{ marginTop: 18, padding: '0 16px' }}>
              <div
                style={{
                  fontSize: 9,
                  fontWeight: 600,
                  textTransform: 'uppercase' as const,
                  letterSpacing: '0.18em',
                  color: 'var(--text-3)',
                  marginBottom: 8,
                }}
              >
                Filter by type
              </div>
              <button
                onClick={() => setSubFilter('')}
                style={{
                  width: '100%',
                  textAlign: 'left' as const,
                  fontSize: 11,
                  padding: '4px 8px',
                  borderRadius: 2,
                  marginBottom: 2,
                  transition: 'background 0.15s',
                  background: !subFilter ? 'var(--card)' : 'transparent',
                  color: !subFilter ? 'var(--text)' : 'var(--text-3)',
                  border: 'none',
                  cursor: 'pointer',
                  fontFamily: 'var(--font-sans)',
                }}
              >
                All types
              </button>
              {availableSubs.map(sub => {
                const selected = sub === subFilter
                return (
                  <button
                    key={sub}
                    onClick={() => setSubFilter(sub === subFilter ? '' : sub)}
                    style={{
                      width: '100%',
                      textAlign: 'left' as const,
                      fontSize: 11,
                      padding: '4px 8px',
                      borderRadius: 2,
                      marginBottom: 2,
                      transition: 'background 0.15s',
                      background: selected ? 'var(--card)' : 'transparent',
                      color: selected ? 'var(--text)' : 'var(--text-3)',
                      border: 'none',
                      cursor: 'pointer',
                      whiteSpace: 'nowrap' as const,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      fontFamily: 'var(--font-sans)',
                    }}
                  >
                    {sub}
                  </button>
                )
              })}
            </div>
          )}
        </div>

        {/* Main content */}
        <div style={{ flex: 1, overflowY: 'auto' }}>

          {/* Add / Edit form */}
          {(adding || editingId) && (
            <div
              className="panel"
              style={{
                margin: 16,
                borderColor: 'rgba(176, 139, 62, 0.3)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
                <div
                  style={{
                    fontSize: 10,
                    fontWeight: 600,
                    textTransform: 'uppercase' as const,
                    letterSpacing: '0.18em',
                    color: 'var(--gold)',
                  }}
                >
                  {editingId ? 'Edit security' : 'Add new security'}
                </div>
                <button
                  onClick={closeForm}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)', padding: 4 }}
                >
                  <X size={13} />
                </button>
              </div>

              {/* v26: Quick add from instruments universe */}
              {showPicker && (
                <div
                  style={{
                    marginBottom: 16,
                    padding: 12,
                    background: 'var(--gold-soft)',
                    borderRadius: 3,
                    border: '1px solid rgba(176, 139, 62, 0.25)',
                  }}
                >
                  <label
                    style={{
                      display: 'block',
                      fontSize: 10,
                      color: 'var(--gold)',
                      marginBottom: 6,
                      textTransform: 'uppercase' as const,
                      letterSpacing: '0.14em',
                      fontWeight: 600,
                    }}
                  >
                    Quick add from universe
                    <span
                      style={{
                        marginLeft: 8,
                        color: 'var(--text-3)',
                        fontWeight: 400,
                        textTransform: 'none' as const,
                        letterSpacing: 0,
                      }}
                    >
                      {availableInstruments.length} instruments addable
                    </span>
                  </label>
                  <div style={{ position: 'relative' }}>
                    <Search
                      size={12}
                      style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }}
                    />
                    <input
                      value={pickerSearch}
                      onChange={e => setPickerSearch(e.target.value)}
                      placeholder="Type ticker or name (e.g. MTNN, FGSUK, Dangote)…"
                      className="input-h input-h-sm"
                      style={{ paddingLeft: 30 }}
                      autoFocus
                    />
                    {pickerSearch.trim() && pickerMatches.length > 0 && (
                      <div
                        style={{
                          position: 'absolute',
                          top: '100%',
                          left: 0,
                          right: 0,
                          marginTop: 4,
                          background: 'var(--card)',
                          border: '1px solid var(--border)',
                          borderRadius: 3,
                          boxShadow: '0 6px 18px rgba(15, 41, 71, 0.12)',
                          maxHeight: 320,
                          overflowY: 'auto',
                          zIndex: 30,
                        }}
                      >
                        {pickerMatches.map((i, idx) => (
                          <button
                            key={i.instrument_id}
                            onClick={() => pickInstrument(i)}
                            style={{
                              width: '100%',
                              textAlign: 'left' as const,
                              padding: '8px 12px',
                              border: 'none',
                              background: 'transparent',
                              cursor: 'pointer',
                              fontFamily: 'var(--font-sans)',
                              borderBottom: idx === pickerMatches.length - 1 ? 'none' : '1px solid var(--border-soft)',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 10,
                            }}
                            onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-soft)' }}
                            onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                          >
                            <span
                              style={{
                                fontFamily: 'var(--font-mono)',
                                fontSize: 11,
                                fontWeight: 700,
                                color: 'var(--gold)',
                                width: 110,
                                flexShrink: 0,
                              }}
                            >
                              {i.instrument_id}
                            </span>
                            <span
                              style={{
                                fontSize: 12,
                                color: 'var(--text)',
                                flex: 1,
                                minWidth: 0,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap' as const,
                              }}
                            >
                              {i.name}
                            </span>
                            <span
                              style={{
                                fontSize: 9,
                                padding: '1px 6px',
                                borderRadius: 2,
                                background: 'var(--bg-soft)',
                                color: 'var(--text-3)',
                                textTransform: 'uppercase' as const,
                                letterSpacing: '0.06em',
                                flexShrink: 0,
                              }}
                            >
                              {sleeveLabel(i.sleeve_id)}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                  {pickerSearch.trim() && pickerMatches.length === 0 && (
                    <p
                      style={{
                        marginTop: 8,
                        fontSize: 11,
                        color: 'var(--text-3)',
                        fontStyle: 'italic' as const,
                      }}
                    >
                      No matching instrument in the universe — fill the form below to add manually,
                      or seed it via <code style={{ fontFamily: 'var(--font-mono)' }}>/admin/fixed-income</code> /
                      <code style={{ fontFamily: 'var(--font-mono)' }}>/admin/equities</code> first.
                    </p>
                  )}
                  <p
                    style={{
                      marginTop: 8,
                      fontSize: 10,
                      color: 'var(--text-3)',
                      lineHeight: 1.5,
                    }}
                  >
                    Pick an instrument to auto-fill ticker, name, section, and sub-type.
                    You&rsquo;ll still enter rank, rationale, notes, and tags below.
                  </p>
                </div>
              )}

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 2fr 1fr', gap: 12, marginBottom: 12 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 10, color: 'var(--text-3)', marginBottom: 4, textTransform: 'uppercase' as const, letterSpacing: '0.12em' }}>
                    Ticker / ID
                  </label>
                  <input
                    value={form.ticker}
                    onChange={e => setForm(f => ({ ...f, ticker: e.target.value }))}
                    className="input-h input-h-sm input-h-mono"
                    placeholder="e.g. MTNN"
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 10, color: 'var(--text-3)', marginBottom: 4, textTransform: 'uppercase' as const, letterSpacing: '0.12em' }}>
                    Name <span style={{ color: 'var(--neg)' }}>*</span>
                  </label>
                  <input
                    value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                    className="input-h input-h-sm"
                    placeholder="Security full name"
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 10, color: 'var(--text-3)', marginBottom: 4, textTransform: 'uppercase' as const, letterSpacing: '0.12em' }}>
                    Rank
                  </label>
                  <input
                    type="number"
                    value={form.rank}
                    onChange={e => setForm(f => ({ ...f, rank: Number(e.target.value) }))}
                    className="input-h input-h-sm input-h-mono"
                  />
                </div>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 10, color: 'var(--text-3)', marginBottom: 4, textTransform: 'uppercase' as const, letterSpacing: '0.12em' }}>
                    Section <span style={{ color: 'var(--neg)' }}>*</span>
                  </label>
                  <select
                    value={form.section}
                    onChange={e => setForm(f => ({ ...f, section: e.target.value, sub_type: '' }))}
                    className="select-h"
                    style={{ padding: '5px 32px 5px 10px', fontSize: 12 }}
                  >
                    <option value="equity">Equity</option>
                    <option value="fixed_income">Fixed Income</option>
                    <option value="other">Other Securities</option>
                    <option value="watch">Eagle Eye Watch</option>
                  </select>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 10, color: 'var(--text-3)', marginBottom: 4, textTransform: 'uppercase' as const, letterSpacing: '0.12em' }}>
                    Sub-type
                  </label>
                  <select
                    value={form.sub_type}
                    onChange={e => setForm(f => ({ ...f, sub_type: e.target.value }))}
                    className="select-h"
                    style={{ padding: '5px 32px 5px 10px', fontSize: 12 }}
                  >
                    <option value="">Select…</option>
                    {formSubs.map(s => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              </div>
              <div style={{ marginBottom: 12 }}>
                <label style={{ display: 'block', fontSize: 10, color: 'var(--text-3)', marginBottom: 4, textTransform: 'uppercase' as const, letterSpacing: '0.12em' }}>
                  Why it&rsquo;s on the watchlist
                </label>
                <textarea
                  value={form.rationale}
                  onChange={e => setForm(f => ({ ...f, rationale: e.target.value }))}
                  rows={2}
                  className="textarea-h"
                  style={{ fontSize: 12 }}
                  placeholder="Investment rationale and why this security deserves monitoring…"
                />
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 14 }}>
                <div>
                  <label style={{ display: 'block', fontSize: 10, color: 'var(--text-3)', marginBottom: 4, textTransform: 'uppercase' as const, letterSpacing: '0.12em' }}>
                    Notes (private)
                  </label>
                  <input
                    value={form.notes}
                    onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
                    className="input-h input-h-sm"
                    placeholder="Internal notes…"
                  />
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: 10, color: 'var(--text-3)', marginBottom: 4, textTransform: 'uppercase' as const, letterSpacing: '0.12em' }}>
                    Tags (comma-separated)
                  </label>
                  <input
                    value={form.tags}
                    onChange={e => setForm(f => ({ ...f, tags: e.target.value }))}
                    className="input-h input-h-sm"
                    placeholder="e.g. banking, dividend, recapitalisation"
                  />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 10 }}>
                <button
                  className="btn-h btn-h-primary"
                  onClick={saveItem}
                  disabled={saving || !form.name}
                >
                  <Save size={12} /> {saving ? 'Saving…' : editingId ? 'Save changes' : 'Add to watchlist'}
                </button>
                <button
                  className="btn-h"
                  onClick={closeForm}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Search & sort bar */}
          <div
            style={{
              padding: '12px 16px',
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              borderBottom: '1px solid var(--border-soft)',
              background: 'var(--bg-soft)',
              position: 'sticky',
              top: 0,
              zIndex: 5,
            }}
          >
            <div style={{ position: 'relative', flex: 1, maxWidth: 320 }}>
              <Search
                size={12}
                style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }}
              />
              <input
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Search name, ticker, rationale…"
                className="input-h input-h-sm"
                style={{ paddingLeft: 30 }}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--text-3)' }}>
              <span>Sort:</span>
              {(['rank', 'name', 'section'] as const).map(col => {
                const active = sortBy === col
                return (
                  <button
                    key={col}
                    onClick={() => toggleSort(col)}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 2,
                      padding: '3px 8px',
                      borderRadius: 2,
                      textTransform: 'capitalize' as const,
                      transition: 'all 0.15s',
                      background: active ? 'var(--gold-soft)' : 'transparent',
                      color: active ? 'var(--gold)' : 'var(--text-3)',
                      border: 'none',
                      cursor: 'pointer',
                      fontFamily: 'var(--font-sans)',
                    }}
                  >
                    {col} <SortIcon col={col} />
                  </button>
                )
              })}
            </div>
            <span style={{ fontSize: 11, color: 'var(--text-3)', marginLeft: 'auto' }}>
              {filtered.length} showing
            </span>
          </div>

          {loading && (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: 160, color: 'var(--text-3)', fontSize: 12 }}>
              Loading watchlist…
            </div>
          )}

          {!loading && (
            <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {filtered.length === 0 && (
                <div style={{ textAlign: 'center', padding: '48px 16px', color: 'var(--text-3)', fontSize: 12 }}>
                  No securities match your filter.
                </div>
              )}
              {filtered.map(item => {
                const sl = SECTION_LABELS[item.section] ?? { label: item.section, color: 'var(--text-2)', bg: 'transparent' }
                const isExpanded  = expanded === item.id
                const insight     = aiInsight[item.id]
                const loadingThis = loadingAI === item.id

                return (
                  <div
                    key={item.id}
                    className="panel"
                    style={{
                      padding: 0,
                      overflow: 'hidden',
                      transition: 'all 0.15s',
                      borderLeft: `3px solid ${sl.color}`,
                    }}
                  >
                    {/* Main row */}
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 18px' }}>
                      <div
                        style={{
                          fontSize: 11,
                          fontFamily: 'var(--font-mono)',
                          color: 'var(--text-3)',
                          width: 24,
                          flexShrink: 0,
                          paddingTop: 2,
                          textAlign: 'right' as const,
                        }}
                      >
                        {item.rank}
                      </div>

                      {item.ticker && (
                        <div style={{ flexShrink: 0, marginTop: 2 }}>
                          {/* v27ba: ticker badge becomes click-through to fundamentals page */}
                          <Link
                            href={`/instrument/${item.ticker}`}
                            style={{ textDecoration: 'none' }}
                          >
                            <span
                              style={{
                                fontFamily: 'var(--font-mono)',
                                fontSize: 10,
                                fontWeight: 700,
                                padding: '2px 6px',
                                borderRadius: 2,
                                background: sl.bg,
                                color: sl.color,
                                letterSpacing: '0.02em',
                                cursor: 'pointer',
                              }}
                            >
                              {item.ticker}
                            </span>
                          </Link>
                        </div>
                      )}

                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                          <span style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>
                            {item.name}
                          </span>
                          <span
                            style={{
                              fontSize: 10,
                              padding: '2px 8px',
                              borderRadius: 2,
                              fontWeight: 600,
                              background: sl.bg,
                              color: sl.color,
                              letterSpacing: '0.04em',
                            }}
                          >
                            {sl.label}
                          </span>
                          {item.sub_type && (
                            <span
                              style={{
                                fontSize: 10,
                                padding: '2px 8px',
                                borderRadius: 2,
                                border: '1px solid var(--border)',
                                color: 'var(--text-3)',
                              }}
                            >
                              {item.sub_type}
                            </span>
                          )}
                          {(item.tags ?? []).map(tag => (
                            <span
                              key={tag}
                              style={{
                                fontSize: 10,
                                padding: '2px 8px',
                                borderRadius: 2,
                                background: 'var(--bg-soft)',
                                color: 'var(--text-3)',
                              }}
                            >
                              #{tag}
                            </span>
                          ))}
                        </div>
                        {item.rationale && !isExpanded && (
                          <p
                            style={{
                              fontSize: 11,
                              color: 'var(--text-3)',
                              marginTop: 4,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap' as const,
                            }}
                          >
                            {item.rationale}
                          </p>
                        )}
                        {isExpanded && (
                          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 10 }}>
                            {item.rationale && (
                              <div>
                                <div
                                  style={{
                                    fontSize: 10,
                                    fontWeight: 600,
                                    color: 'var(--text-2)',
                                    textTransform: 'uppercase' as const,
                                    letterSpacing: '0.14em',
                                    marginBottom: 4,
                                  }}
                                >
                                  Watchlist Rationale
                                </div>
                                <p style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.6 }}>{item.rationale}</p>
                              </div>
                            )}
                            {item.notes && (
                              <div
                                style={{
                                  padding: '10px 12px',
                                  background: 'var(--bg-soft)',
                                  borderRadius: 3,
                                  border: '1px solid var(--border-soft)',
                                }}
                              >
                                <div
                                  style={{
                                    fontSize: 10,
                                    fontWeight: 600,
                                    color: 'var(--text-3)',
                                    textTransform: 'uppercase' as const,
                                    letterSpacing: '0.14em',
                                    marginBottom: 4,
                                  }}
                                >
                                  Notes
                                </div>
                                <p style={{ fontSize: 11, color: 'var(--text-2)' }}>{item.notes}</p>
                              </div>
                            )}
                            {/* AI Insight */}
                            <div style={{ marginTop: 6, borderTop: '1px solid var(--border-soft)', paddingTop: 10 }}>
                              {!insight && !loadingThis && (
                                <button
                                  onClick={() => fetchAIInsight(item)}
                                  style={{
                                    display: 'inline-flex',
                                    alignItems: 'center',
                                    gap: 6,
                                    fontSize: 12,
                                    color: 'var(--gold)',
                                    background: 'none',
                                    border: 'none',
                                    cursor: 'pointer',
                                    padding: 0,
                                    fontFamily: 'var(--font-sans)',
                                  }}
                                >
                                  <Sparkles size={12} /> Get AI market intelligence
                                </button>
                              )}
                              {loadingThis && (
                                <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-3)' }}>
                                  <div
                                    style={{
                                      width: 11,
                                      height: 11,
                                      border: '2px solid var(--border)',
                                      borderTopColor: 'var(--gold)',
                                      borderRadius: '50%',
                                      animation: 'spin 0.7s linear infinite',
                                    }}
                                  />
                                  Getting market intelligence… (web search can take ~20s)
                                </div>
                              )}
                              {insight && (
                                <div
                                  style={{
                                    background: 'var(--gold-soft)',
                                    border: '1px solid rgba(176, 139, 62, 0.2)',
                                    borderRadius: 3,
                                    padding: 12,
                                  }}
                                >
                                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                                    <Sparkles size={11} style={{ color: 'var(--gold)' }} />
                                    <span
                                      style={{
                                        fontSize: 10,
                                        fontWeight: 700,
                                        color: 'var(--gold)',
                                        textTransform: 'uppercase' as const,
                                        letterSpacing: '0.14em',
                                      }}
                                    >
                                      AI Market Intelligence
                                    </span>
                                  </div>
                                  <p style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.6, whiteSpace: 'pre-wrap' as const }}>{insight}</p>
                                  <button
                                    onClick={() => fetchAIInsight(item, true)}
                                    style={{
                                      marginTop: 8,
                                      fontSize: 10,
                                      color: 'var(--text-3)',
                                      background: 'none',
                                      border: 'none',
                                      cursor: 'pointer',
                                      padding: 0,
                                      fontFamily: 'var(--font-sans)',
                                    }}
                                  >
                                    ↻ Refresh
                                  </button>
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                        <button
                          onClick={() => setExpanded(isExpanded ? null : item.id)}
                          style={{
                            padding: 6,
                            borderRadius: 2,
                            background: 'transparent',
                            color: 'var(--text-3)',
                            border: 'none',
                            cursor: 'pointer',
                            transition: 'all 0.15s',
                          }}
                          onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-soft)' }}
                          onMouseLeave={e => { e.currentTarget.style.background = 'transparent' }}
                          title={isExpanded ? 'Collapse' : 'Expand'}
                        >
                          {isExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                        </button>
                        <button
                          onClick={() => startEdit(item)}
                          style={{
                            padding: 6,
                            borderRadius: 2,
                            background: 'transparent',
                            color: 'var(--text-3)',
                            border: 'none',
                            cursor: 'pointer',
                            transition: 'all 0.15s',
                          }}
                          onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-soft)'; e.currentTarget.style.color = 'var(--gold)' }}
                          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-3)' }}
                          title="Edit"
                        >
                          <Edit3 size={12} />
                        </button>
                        <button
                          onClick={() => deleteItem(item.id, item.name)}
                          style={{
                            padding: 6,
                            borderRadius: 2,
                            background: 'transparent',
                            color: 'var(--text-3)',
                            border: 'none',
                            cursor: 'pointer',
                            transition: 'all 0.15s',
                          }}
                          onMouseEnter={e => { e.currentTarget.style.background = 'var(--bg-soft)'; e.currentTarget.style.color = 'var(--neg)' }}
                          onMouseLeave={e => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--text-3)' }}
                          title="Delete"
                        >
                          <Trash2 size={12} />
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}

          {!loading && (
            <div
              style={{
                padding: '22px 28px',
                borderTop: '1px solid var(--border-soft)',
                fontSize: 10,
                color: 'var(--text-3)',
                lineHeight: 1.6,
              }}
            >
              <strong style={{ color: 'var(--text-2)' }}>Usage:</strong> This watchlist is Transworld&rsquo;s investment idea universe — 55 equities, 70 fixed income, 15 other securities and 8 eagle-eye watch items.
              The AI report engine scans this list when generating portfolio intelligence.
              Click any item to expand, then &ldquo;Get AI market intelligence&rdquo; for a live Claude-powered brief on that security.
              Source: NGX Daily Summary 12 March 2026 · NGX Daily Official List (Bonds) 13 March 2026.
            </div>
          )}
        </div>
      </div>

      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </div>
  )
}
