'use client'
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import {
  ArrowLeft, Edit2, Search, X, Save, Info, Sparkles,
  AlertCircle, CheckCircle2,
} from 'lucide-react'

// v21z: Fixed Income admin page.
// Manages yield_pct / yield_as_of / yield_source / yield_notes on the
// 72 sleeve_id='fi' instruments (2 legacy buckets + 70 watchlist-seeded).
// Two entry paths: per-row manual Edit, or batch AI refresh that proposes
// yields via web_search and lets the user review before saving.

const YIELD_STALE_DAYS = 14

interface FiRow {
  instrument_id: string
  name: string
  type: string
  sub_type: string | null
  rationale: string | null
  coupon_pct: number | null
  coupon_freq: number | null
  maturity_date: string | null
  approved: boolean
  yield_pct: number | null
  yield_source: string | null
  yield_as_of: string | null
  yield_last_refreshed_at: string | null
  yield_notes: string | null
}

interface AiProposal {
  instrument_id: string
  yield_pct: number
  source: string
  as_of: string
  confidence?: string
  notes?: string
}

interface ReviewRow extends AiProposal {
  name: string
  current_yield: number | null
  accepted: boolean
}

function parseNotes(notes: string | null): { subType: string | null; rationale: string | null } {
  if (!notes) return { subType: null, rationale: null }
  const m = notes.match(/^\[([^\]]+)\]\s*(.*)$/)
  if (m) return { subType: m[1], rationale: m[2] }
  return { subType: null, rationale: notes }
}

function formatMaturity(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso + 'T00:00:00Z')
  return d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
}

function formatTenor(maturity: string | null): string {
  if (!maturity) return '—'
  const m = new Date(maturity + 'T00:00:00Z')
  const now = new Date()
  now.setUTCHours(0, 0, 0, 0)
  const days = (m.getTime() - now.getTime()) / 86_400_000
  if (days < 0) return 'matured'
  if (days < 365) return `${Math.round(days)}d`
  const years = days / 365.25
  return `${years.toFixed(1)}y`
}

function yieldStalenessOf(asOf: string | null): 'fresh' | 'stale' | 'none' {
  if (!asOf) return 'none'
  const d = new Date(asOf + 'T00:00:00Z')
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  const diff = Math.floor((today.getTime() - d.getTime()) / 86_400_000)
  return diff > YIELD_STALE_DAYS ? 'stale' : 'fresh'
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso + 'T00:00:00Z')
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
}

export default function FixedIncomePage() {
  const [rows, setRows] = useState<FiRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [subTypeFilter, setSubTypeFilter] = useState<string>('all')
  const [staleOnly, setStaleOnly] = useState(false)
  const [noYieldOnly, setNoYieldOnly] = useState(false)

  // Single-row edit modal
  const [editing, setEditing] = useState<FiRow | null>(null)
  const [editYield, setEditYield] = useState('')
  const [editAsOf, setEditAsOf] = useState('')
  const [editNotes, setEditNotes] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  const [editError, setEditError] = useState('')

  // AI refresh modal
  const [aiLoading, setAiLoading] = useState(false)
  const [aiError, setAiError] = useState('')
  const [aiProposals, setAiProposals] = useState<ReviewRow[] | null>(null)
  const [aiSaving, setAiSaving] = useState(false)
  const [aiSaveMsg, setAiSaveMsg] = useState('')

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    const { data, error } = await supabase
      .from('instruments')
      .select('*')
      .eq('sleeve_id', 'fi')
      .order('maturity_date', { ascending: true, nullsFirst: false })

    if (error) {
      console.error('Load FI instruments failed:', error)
      setLoading(false)
      return
    }

    const mapped: FiRow[] = (data ?? []).map((i: any) => {
      const { subType, rationale } = parseNotes(i.notes)
      return {
        instrument_id: i.instrument_id,
        name: i.name,
        type: i.type,
        sub_type: subType,
        rationale,
        coupon_pct: i.coupon_pct === null ? null : Number(i.coupon_pct),
        coupon_freq: i.coupon_freq === null ? null : Number(i.coupon_freq),
        maturity_date: i.maturity_date ?? null,
        approved: !!i.approved,
        yield_pct: i.yield_pct === null || i.yield_pct === undefined ? null : Number(i.yield_pct),
        yield_source: i.yield_source ?? null,
        yield_as_of: i.yield_as_of ?? null,
        yield_last_refreshed_at: i.yield_last_refreshed_at ?? null,
        yield_notes: i.yield_notes ?? null,
      }
    })
    setRows(mapped)
    setLoading(false)
  }

  const subTypes = useMemo(() => {
    const s = new Set<string>()
    rows.forEach(r => { if (r.sub_type) s.add(r.sub_type) })
    return Array.from(s).sort()
  }, [rows])

  const filtered = useMemo(() => rows.filter(r => {
    if (search) {
      const q = search.toLowerCase()
      if (!r.instrument_id.toLowerCase().includes(q) && !r.name.toLowerCase().includes(q)) return false
    }
    if (subTypeFilter !== 'all' && r.sub_type !== subTypeFilter) return false
    const stale = yieldStalenessOf(r.yield_as_of)
    if (staleOnly && stale === 'fresh') return false
    if (noYieldOnly && r.yield_pct !== null) return false
    return true
  }), [rows, search, subTypeFilter, staleOnly, noYieldOnly])

  const withYield = rows.filter(r => r.yield_pct !== null).length
  const staleYield = rows.filter(r => yieldStalenessOf(r.yield_as_of) === 'stale').length

  // ─── Single-row edit flow ───

  function openEdit(r: FiRow) {
    setEditing(r)
    setEditYield(r.yield_pct !== null ? r.yield_pct.toString() : '')
    setEditAsOf(r.yield_as_of ?? new Date().toISOString().slice(0, 10))
    setEditNotes(r.yield_notes ?? '')
    setEditError('')
  }

  async function saveEdit() {
    if (!editing) return
    setEditSaving(true)
    setEditError('')
    try {
      const hasYield = editYield.trim().length > 0
      const y = hasYield ? parseFloat(editYield) : null
      if (hasYield && (y === null || !isFinite(y) || y <= 0 || y > 100)) {
        setEditError('Yield must be a positive number between 0 and 100')
        setEditSaving(false)
        return
      }
      const update: any = hasYield
        ? {
            yield_pct: y,
            yield_as_of: editAsOf,
            yield_source: editing.yield_source === 'ai-refresh' ? 'manual' : (editing.yield_source ?? 'manual'),
            yield_notes: editNotes || null,
            yield_last_refreshed_at: new Date().toISOString(),
          }
        : {
            yield_pct: null,
            yield_as_of: null,
            yield_source: null,
            yield_notes: null,
            yield_last_refreshed_at: null,
          }
      // Always set source='manual' for hand-edits even if there was a prior AI value
      if (hasYield) update.yield_source = 'manual'

      const { error } = await (supabase.from('instruments') as any)
        .update(update)
        .eq('instrument_id', editing.instrument_id)
      if (error) {
        setEditError(error.message)
        setEditSaving(false)
        return
      }
      setEditing(null)
      await load()
    } catch (e) {
      setEditError((e as Error).message)
    } finally {
      setEditSaving(false)
    }
  }

  // ─── AI refresh flow ───

  async function runAiRefresh() {
    setAiLoading(true)
    setAiError('')
    setAiProposals(null)
    setAiSaveMsg('')
    try {
      const res = await fetch('/api/fixed-income/refresh-yields', { method: 'POST' })
      const body = await res.json()
      if (!res.ok) {
        setAiError(body?.error || `HTTP ${res.status}`)
        return
      }
      const proposals: AiProposal[] = body.results ?? []
      const byId = new Map(rows.map(r => [r.instrument_id, r]))
      const review: ReviewRow[] = proposals
        .filter(p => byId.has(p.instrument_id))
        .map(p => {
          const r = byId.get(p.instrument_id)!
          return {
            ...p,
            name: r.name,
            current_yield: r.yield_pct,
            accepted: true,
          }
        })
      if (review.length === 0) {
        setAiError('AI could not find reliable yields. Try again later or enter yields manually.')
      } else {
        setAiProposals(review)
      }
    } catch (e) {
      setAiError((e as Error).message)
    } finally {
      setAiLoading(false)
    }
  }

  function toggleAccept(idx: number) {
    setAiProposals(prev => {
      if (!prev) return prev
      const next = [...prev]
      next[idx] = { ...next[idx], accepted: !next[idx].accepted }
      return next
    })
  }

  function toggleAll(accept: boolean) {
    setAiProposals(prev => prev ? prev.map(p => ({ ...p, accepted: accept })) : prev)
  }

  async function saveAiBatch() {
    if (!aiProposals) return
    const accepted = aiProposals.filter(p => p.accepted)
    if (accepted.length === 0) return
    setAiSaving(true)
    setAiSaveMsg('')
    try {
      const nowIso = new Date().toISOString()
      const results = await Promise.all(accepted.map(p =>
        (supabase.from('instruments') as any)
          .update({
            yield_pct: p.yield_pct,
            yield_as_of: p.as_of,
            yield_source: 'ai-refresh',
            yield_notes: p.notes ?? p.source,
            yield_last_refreshed_at: nowIso,
          })
          .eq('instrument_id', p.instrument_id)
      ))
      const errors = results.filter((r: any) => r?.error)
      if (errors.length > 0) {
        setAiSaveMsg(`✗ ${errors.length} save${errors.length === 1 ? '' : 's'} failed`)
      } else {
        setAiSaveMsg(`✓ Saved ${accepted.length} yield${accepted.length === 1 ? '' : 's'}`)
        setAiProposals(null)
        await load()
      }
    } catch (e) {
      setAiSaveMsg(`✗ ${(e as Error).message}`)
    } finally {
      setAiSaving(false)
      setTimeout(() => setAiSaveMsg(''), 8000)
    }
  }

  return (
    <main className="hybrid-page" style={{ padding: '32px 44px 64px', minHeight: '100vh' }}>
      <div className="page-head">
        <div>
          <Link
            href="/admin"
            className="eyebrow"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 10, textDecoration: 'none' }}
          >
            <ArrowLeft size={11} /> Admin panel
          </Link>
          <h1 className="hybrid-serif" style={{ fontSize: 36, fontWeight: 500, letterSpacing: '-0.005em', lineHeight: 1, color: 'var(--text)' }}>
            Fixed income
          </h1>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {aiSaveMsg && (
            <span style={{ fontSize: 11, color: aiSaveMsg.startsWith('✓') ? 'var(--pos)' : 'var(--neg)' }}>
              {aiSaveMsg}
            </span>
          )}
          <button
            className="btn-h btn-h-primary"
            onClick={runAiRefresh}
            disabled={aiLoading}
          >
            <Sparkles size={12} style={aiLoading ? { animation: 'spin 0.7s linear infinite' } : undefined} />
            {aiLoading ? 'Searching FMDQ / DMO…' : 'AI refresh yields'}
          </button>
        </div>
      </div>

      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>

      <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 18, lineHeight: 1.6 }}>
        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{rows.length}</span> fixed income instruments ·{' '}
        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{withYield}</span> with current yield ·{' '}
        {staleYield > 0 ? (
          <span style={{ color: 'var(--warn)' }}>
            {staleYield} stale (older than {YIELD_STALE_DAYS} days)
          </span>
        ) : (
          <span style={{ color: 'var(--pos)' }}>All yields fresh</span>
        )}
        . AI refresh proposes yields from FMDQ / DMO — review before saving.
      </div>

      {aiError && (
        <div className="alert-h alert-h-critical" style={{ fontSize: 12, marginBottom: 16, maxWidth: 900, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
          <span>{aiError}</span>
          <button onClick={() => setAiError('')} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: 'inherit', cursor: 'pointer' }}><X size={12} /></button>
        </div>
      )}

      <div style={{ maxWidth: 1400 }}>
        {/* Filters */}
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 14 }}>
          <div style={{ position: 'relative', flex: 1, minWidth: 200, maxWidth: 320 }}>
            <Search size={12} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }} />
            <input
              type="text" value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search by ticker or name…" className="input-h input-h-sm"
              style={{ paddingLeft: 32 }}
            />
          </div>
          <select value={subTypeFilter} onChange={e => setSubTypeFilter(e.target.value)} className="select-h" style={{ width: 200, padding: '5px 32px 5px 10px', fontSize: 12 }}>
            <option value="all">All sub-types ({rows.length})</option>
            {subTypes.map(s => {
              const n = rows.filter(r => r.sub_type === s).length
              return <option key={s} value={s}>{s} ({n})</option>
            })}
          </select>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-2)', cursor: 'pointer', userSelect: 'none' as const }}>
            <input type="checkbox" checked={noYieldOnly} onChange={e => setNoYieldOnly(e.target.checked)} style={{ accentColor: 'var(--gold)' }} />
            No yield yet
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-2)', cursor: 'pointer', userSelect: 'none' as const }}>
            <input type="checkbox" checked={staleOnly} onChange={e => setStaleOnly(e.target.checked)} style={{ accentColor: 'var(--warn)' }} />
            Stale yields
          </label>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginLeft: 'auto' }}>
            {filtered.length} shown
          </div>
        </div>

        {/* Table */}
        <div className="panel" style={{ padding: 0, overflowX: 'auto' }}>
          {loading ? (
            <div style={{ padding: '32px 20px', textAlign: 'center', fontSize: 12, color: 'var(--text-3)' }}>Loading…</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: '32px 20px', textAlign: 'center', fontSize: 12, color: 'var(--text-3)' }}>No instruments match your filters</div>
          ) : (
            <table className="h-table" style={{ width: '100%', minWidth: 1100 }}>
              <thead>
                <tr>
                  <th>Instrument</th>
                  <th>Sub-type</th>
                  <th className="num">Coupon</th>
                  <th>Maturity</th>
                  <th className="num">Tenor</th>
                  <th className="num">Yield</th>
                  <th>Source</th>
                  <th>As of</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(r => {
                  const stale = yieldStalenessOf(r.yield_as_of)
                  const dotColor = stale === 'fresh' ? 'var(--pos)' : stale === 'stale' ? 'var(--warn)' : 'var(--text-4)'
                  const dotTitle = stale === 'fresh' ? `Fresh (within ${YIELD_STALE_DAYS} days)` : stale === 'stale' ? `Stale (older than ${YIELD_STALE_DAYS} days)` : 'No yield recorded'
                  return (
                    <tr key={r.instrument_id}>
                      <td>
                        <div style={{ fontWeight: 500 }}>{r.name}</div>
                        <div style={{ fontSize: 10, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
                          {r.instrument_id}
                        </div>
                      </td>
                      <td>
                        {r.sub_type && (
                          <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 2, background: 'var(--gold-soft)', color: 'var(--gold)', border: '1px solid rgba(176, 139, 62, 0.24)', fontWeight: 600, letterSpacing: '0.03em', textTransform: 'uppercase' as const, whiteSpace: 'nowrap' as const }}>
                            {r.sub_type}
                          </span>
                        )}
                      </td>
                      <td className="num" style={{ fontFamily: 'var(--font-mono)', color: r.coupon_pct ? 'var(--text-2)' : 'var(--text-4)' }}>
                        {r.coupon_pct ? `${r.coupon_pct.toFixed(2)}%` : '—'}
                      </td>
                      <td style={{ fontSize: 12, color: r.maturity_date ? 'var(--text-2)' : 'var(--text-4)' }}>
                        {formatMaturity(r.maturity_date)}
                      </td>
                      <td className="num" style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-2)' }}>
                        {formatTenor(r.maturity_date)}
                      </td>
                      <td className="num" style={{ fontFamily: 'var(--font-mono)' }}>
                        {r.yield_pct !== null
                          ? <span style={{ fontWeight: 500, color: 'var(--text)' }}>{r.yield_pct.toFixed(2)}%</span>
                          : <span style={{ color: 'var(--text-4)' }}>—</span>}
                      </td>
                      <td>
                        {r.yield_source
                          ? <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-2)', textTransform: 'uppercase' as const, letterSpacing: '0.06em' }}>{r.yield_source}</span>
                          : <span style={{ fontSize: 10, color: 'var(--text-4)' }}>—</span>}
                      </td>
                      <td style={{ fontSize: 12 }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} title={dotTitle}>
                          <span style={{ width: 7, height: 7, borderRadius: '50%', background: dotColor, display: 'inline-block', flexShrink: 0 }} />
                          <span style={{ color: stale === 'stale' ? 'var(--warn)' : stale === 'none' ? 'var(--text-3)' : 'var(--text-2)' }}>
                            {formatDate(r.yield_as_of)}
                          </span>
                        </span>
                      </td>
                      <td>
                        <button onClick={() => openEdit(r)} className="btn-h" style={{ fontSize: 11, padding: '4px 10px' }} title="Edit yield">
                          <Edit2 size={11} /> Edit
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        <div style={{ marginTop: 16, fontSize: 11, color: 'var(--text-3)', display: 'flex', alignItems: 'flex-start', gap: 6, lineHeight: 1.6, maxWidth: 860 }}>
          <Info size={11} style={{ marginTop: 2, flexShrink: 0 }} />
          <span>
            Yields feed into AI report generation and scenario analysis, so the AI can recommend specific fixed income instruments with current yield context.
            AI refresh proposes yields via web search across FMDQ daily quotations, DMO auction results, and trusted Nigerian market sources — you review before anything is saved.
            Manual edits always take precedence over AI refreshes.
          </span>
        </div>
      </div>

      {/* ─── Single-row edit modal ─── */}
      {editing && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(10,31,58,.55)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '0 16px' }}
          onClick={() => setEditing(null)}
        >
          <div className="panel" style={{ maxWidth: 480, width: '100%', margin: 0 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 18 }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.18em', color: 'var(--gold)', textTransform: 'uppercase' as const }}>Update yield</div>
                <div className="hybrid-serif" style={{ fontSize: 20, fontWeight: 500, marginTop: 4, color: 'var(--text)' }}>{editing.name}</div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>
                  {editing.instrument_id}
                  {editing.coupon_pct ? ` · ${editing.coupon_pct.toFixed(2)}% coupon` : ''}
                  {editing.maturity_date ? ` · matures ${formatMaturity(editing.maturity_date)}` : ''}
                </div>
              </div>
              <button onClick={() => setEditing(null)} style={{ color: 'var(--text-3)', background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
                <X size={16} />
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

              {editing.yield_pct !== null ? (
                <div style={{ fontSize: 11, color: 'var(--text-2)', background: 'var(--bg-soft)', borderRadius: 3, padding: '8px 12px', border: '1px solid var(--border-soft)' }}>
                  <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase' as const, letterSpacing: '0.1em', marginBottom: 3 }}>Current yield</div>
                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{editing.yield_pct.toFixed(2)}%</span>{' · '}
                  <span style={{ fontFamily: 'var(--font-mono)', textTransform: 'uppercase' as const, fontSize: 10 }}>{editing.yield_source}</span>{' · as of '}{formatDate(editing.yield_as_of)}
                </div>
              ) : (
                <div className="alert-h alert-h-warn" style={{ fontSize: 11 }}>No yield recorded yet for this instrument.</div>
              )}

              <div>
                <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>
                  Yield (%)
                  <span style={{ color: 'var(--text-4)', marginLeft: 6, fontSize: 10 }}>— leave blank to clear</span>
                </label>
                <input
                  type="number"
                  value={editYield}
                  onChange={e => setEditYield(e.target.value)}
                  step="0.01"
                  placeholder="e.g. 18.75"
                  className="input-h input-h-mono"
                  autoFocus
                />
              </div>

              {editYield && parseFloat(editYield) > 0 && (
                <div>
                  <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>As of date</label>
                  <input type="date" value={editAsOf} onChange={e => setEditAsOf(e.target.value)} className="input-h input-h-mono" />
                </div>
              )}

              <div>
                <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>
                  Notes
                  <span style={{ color: 'var(--text-4)', marginLeft: 6, fontSize: 10 }}>— optional source detail</span>
                </label>
                <input
                  type="text"
                  value={editNotes}
                  onChange={e => setEditNotes(e.target.value)}
                  placeholder="e.g. FMDQ 23 April daily quotations list"
                  className="input-h"
                />
              </div>

              {editError && (
                <div className="alert-h alert-h-critical" style={{ fontSize: 11 }}>
                  <AlertCircle size={11} style={{ flexShrink: 0, marginTop: 1 }} /><span>{editError}</span>
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, paddingTop: 4 }}>
                <button
                  onClick={saveEdit}
                  disabled={editSaving}
                  className="btn-h btn-h-primary"
                  style={{ flex: 1, justifyContent: 'center' }}
                >
                  <Save size={12} /> {editSaving ? 'Saving…' : 'Save'}
                </button>
                <button onClick={() => setEditing(null)} className="btn-h">Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ─── AI proposals review modal ─── */}
      {aiProposals && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(10,31,58,.55)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 24 }}
          onClick={() => !aiSaving && setAiProposals(null)}
        >
          <div className="panel" style={{ maxWidth: 920, width: '100%', margin: 0, maxHeight: '88vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.18em', color: 'var(--gold)', textTransform: 'uppercase' as const }}>Review AI-proposed yields</div>
                <div className="hybrid-serif" style={{ fontSize: 22, fontWeight: 500, marginTop: 4, color: 'var(--text)' }}>
                  {aiProposals.length} yield{aiProposals.length === 1 ? '' : 's'} proposed
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
                  Uncheck any rows that look wrong. Only accepted rows will be saved.
                </div>
              </div>
              <button onClick={() => !aiSaving && setAiProposals(null)} disabled={aiSaving} style={{ color: 'var(--text-3)', background: 'none', border: 'none', cursor: aiSaving ? 'not-allowed' : 'pointer', padding: 4 }}>
                <X size={16} />
              </button>
            </div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 10, fontSize: 11 }}>
              <button onClick={() => toggleAll(true)} disabled={aiSaving} className="btn-h" style={{ fontSize: 11, padding: '3px 10px' }}>Select all</button>
              <button onClick={() => toggleAll(false)} disabled={aiSaving} className="btn-h" style={{ fontSize: 11, padding: '3px 10px' }}>Deselect all</button>
              <div style={{ marginLeft: 'auto', alignSelf: 'center', color: 'var(--text-3)' }}>
                {aiProposals.filter(p => p.accepted).length} of {aiProposals.length} selected
              </div>
            </div>

            <div style={{ overflowY: 'auto', flex: 1, border: '1px solid var(--border-soft)', borderRadius: 3 }}>
              <table className="h-table" style={{ width: '100%' }}>
                <thead style={{ position: 'sticky' as const, top: 0, background: 'var(--card)', zIndex: 1 }}>
                  <tr>
                    <th style={{ width: 36 }}></th>
                    <th>Instrument</th>
                    <th className="num">Current</th>
                    <th className="num">Proposed</th>
                    <th>Source</th>
                    <th>As of</th>
                    <th>Confidence</th>
                  </tr>
                </thead>
                <tbody>
                  {aiProposals.map((p, i) => {
                    const conf = p.confidence ?? 'medium'
                    const confColor = conf === 'high' ? 'var(--pos)' : conf === 'low' ? 'var(--warn)' : 'var(--text-2)'
                    return (
                      <tr key={p.instrument_id} style={p.accepted ? {} : { opacity: 0.45 }}>
                        <td>
                          <input type="checkbox" checked={p.accepted} onChange={() => toggleAccept(i)} disabled={aiSaving} style={{ accentColor: 'var(--gold)' }} />
                        </td>
                        <td>
                          <div style={{ fontSize: 12, fontWeight: 500 }}>{p.name}</div>
                          <div style={{ fontSize: 10, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>{p.instrument_id}</div>
                        </td>
                        <td className="num" style={{ fontFamily: 'var(--font-mono)', color: p.current_yield !== null ? 'var(--text-2)' : 'var(--text-4)' }}>
                          {p.current_yield !== null ? `${p.current_yield.toFixed(2)}%` : '—'}
                        </td>
                        <td className="num" style={{ fontFamily: 'var(--font-mono)', fontWeight: 500, color: 'var(--gold)' }}>
                          {p.yield_pct.toFixed(2)}%
                        </td>
                        <td style={{ fontSize: 11, color: 'var(--text-2)' }} title={p.notes}>
                          {p.source}
                        </td>
                        <td style={{ fontSize: 11, color: 'var(--text-2)' }}>{formatDate(p.as_of)}</td>
                        <td style={{ fontSize: 10, color: confColor, textTransform: 'uppercase' as const, letterSpacing: '0.06em', fontWeight: 600 }}>
                          {conf}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <div style={{ display: 'flex', gap: 8, paddingTop: 14, borderTop: '1px solid var(--border-soft)', marginTop: 12 }}>
              <button
                onClick={saveAiBatch}
                disabled={aiSaving || aiProposals.filter(p => p.accepted).length === 0}
                className="btn-h btn-h-primary"
                style={{ flex: 1, justifyContent: 'center' }}
              >
                <CheckCircle2 size={12} />
                {aiSaving ? 'Saving…' : `Accept ${aiProposals.filter(p => p.accepted).length} yield${aiProposals.filter(p => p.accepted).length === 1 ? '' : 's'}`}
              </button>
              <button onClick={() => setAiProposals(null)} disabled={aiSaving} className="btn-h">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
