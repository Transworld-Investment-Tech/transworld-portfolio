'use client'
import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import { ArrowLeft, Plus, Trash2, RefreshCw, AlertCircle, X, Info } from 'lucide-react'

// v21l: Ticker Aliases admin page.
// Lists all entries in the ticker_aliases DB table.
// Hardcoded fallback aliases (from lib/market-data.ts NGX_TICKER_ALIASES)
// are shown as read-only context — they are always active regardless of
// what's in the DB.

interface Alias {
  id: string
  broker_ticker: string
  canonical_id: string
  notes: string | null
  created_at: string
  updated_at: string
}

const HARDCODED: Array<{ broker_ticker: string; canonical_id: string; notes: string }> = [
  { broker_ticker: 'MOBIL',    canonical_id: 'MRS',         notes: 'MRS Oil Nigeria — legacy Mobil ticker' },
  { broker_ticker: 'GUARANTY', canonical_id: 'GTCO',        notes: 'Guaranty Trust Holding Co — pre-HoldCo ticker' },
]

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
}

export default function AliasesPage() {
  const [aliases, setAliases] = useState<Alias[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError]   = useState<string | null>(null)

  // Add form state
  const [showAdd, setShowAdd]         = useState(false)
  const [addBroker, setAddBroker]     = useState('')
  const [addCanonical, setAddCanonical] = useState('')
  const [addNotes, setAddNotes]       = useState('')
  const [addSaving, setAddSaving]     = useState(false)
  const [addError, setAddError]       = useState<string | null>(null)

  // Delete state
  const [deleting, setDeleting] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await fetch('/api/aliases')
      const json = await res.json()
      if (!res.ok) { setError(json.error ?? 'Load failed'); return }
      setAliases(json.aliases ?? [])
    } catch { setError('Network error') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  async function addAlias() {
    if (!addBroker.trim() || !addCanonical.trim()) {
      setAddError('Both fields are required')
      return
    }
    setAddSaving(true)
    setAddError(null)
    try {
      const res = await fetch('/api/aliases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          broker_ticker: addBroker.trim().toUpperCase(),
          canonical_id:  addCanonical.trim().toUpperCase(),
          notes:         addNotes.trim() || null,
        }),
      })
      const json = await res.json()
      if (!res.ok) { setAddError(json.error ?? 'Save failed'); return }
      setShowAdd(false)
      setAddBroker('')
      setAddCanonical('')
      setAddNotes('')
      await load()
    } catch { setAddError('Network error') }
    finally { setAddSaving(false) }
  }

  async function deleteAlias(id: string) {
    setDeleting(id)
    try {
      await fetch(`/api/aliases/${id}`, { method: 'DELETE' })
      await load()
    } finally { setDeleting(null) }
  }

  return (
    <main className="hybrid-page" style={{ padding: '32px 44px 64px', minHeight: '100vh' }}>
      {/* Page header */}
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
            Ticker Aliases
          </h1>
          <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-3)' }}>
            Map broker PDF tickers to canonical instrument IDs
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn-h" onClick={load} disabled={loading}>
            <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
          </button>
          <button className="btn-h btn-h-primary" onClick={() => { setShowAdd(true); setAddError(null) }}>
            <Plus size={12} /> Add alias
          </button>
        </div>
      </div>

      {/* Info box */}
      <div
        style={{
          background: 'var(--gold-soft)', border: '1px solid rgba(176,139,62,0.2)',
          borderRadius: 4, padding: '12px 16px', marginBottom: 24,
          fontSize: 12, color: 'var(--text-2)', display: 'flex', gap: 10, alignItems: 'flex-start',
          lineHeight: 1.6,
        }}
      >
        <Info size={13} style={{ color: 'var(--gold)', flexShrink: 0, marginTop: 1 }} />
        <span>
          Aliases are applied at the broker ingestion boundary (upload + commit) and during NGX price refreshes.
          Adding an alias here takes effect on the next upload or refresh — no code deploy required.
          The hardcoded aliases below are always active as a permanent fallback even if the DB is unavailable.
        </span>
      </div>

      {/* Add form */}
      {showAdd && (
        <div className="panel" style={{ marginBottom: 24, maxWidth: 560 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16 }}>
            <div className="panel-title" style={{ fontStyle: 'italic' }}>New alias</div>
            <button onClick={() => setShowAdd(false)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-3)' }}>
              <X size={14} />
            </button>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
              <div>
                <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>
                  Broker ticker (as it appears in PDFs)
                </label>
                <input
                  type="text"
                  value={addBroker}
                  onChange={e => setAddBroker(e.target.value.toUpperCase())}
                  placeholder="e.g. FBNH"
                  className="input-h input-h-mono"
                  autoFocus
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>
                  Canonical instrument ID (must exist in instruments)
                </label>
                <input
                  type="text"
                  value={addCanonical}
                  onChange={e => setAddCanonical(e.target.value.toUpperCase())}
                  placeholder="e.g. FIRSTHOLDCO"
                  className="input-h input-h-mono"
                />
              </div>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>
                Notes (optional)
              </label>
              <input
                type="text"
                value={addNotes}
                onChange={e => setAddNotes(e.target.value)}
                placeholder="e.g. FBN Holdings — pre-HoldCo merger ticker"
                className="input-h"
              />
            </div>
            {addError && (
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, color: 'var(--neg)', background: 'rgba(166,59,59,0.07)', borderRadius: 3, padding: '8px 12px' }}>
                <AlertCircle size={12} /> {addError}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={addAlias} disabled={addSaving || !addBroker || !addCanonical} className="btn-h btn-h-primary">
                {addSaving ? <><RefreshCw size={12} className="animate-spin" /> Saving…</> : <><Plus size={12} /> Add alias</>}
              </button>
              <button onClick={() => setShowAdd(false)} className="btn-h">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div style={{ color: 'var(--neg)', fontSize: 12, marginBottom: 16 }}>{error}</div>
      )}

      {/* DB aliases table */}
      <div className="panel" style={{ marginBottom: 24 }}>
        <div className="panel-header">
          <div className="panel-title">Database aliases</div>
          <div className="panel-meta">{aliases.length} entries · DB-driven · editable</div>
        </div>
        {loading ? (
          <div style={{ padding: '32px 0', textAlign: 'center', fontSize: 12, color: 'var(--text-3)' }}>
            <RefreshCw size={13} className="animate-spin" style={{ display: 'inline', marginRight: 6 }} /> Loading…
          </div>
        ) : aliases.length === 0 ? (
          <div style={{ padding: '32px 0', textAlign: 'center', fontSize: 12, color: 'var(--text-3)', fontStyle: 'italic' }}>
            No DB aliases yet. Add one above, or use the hardcoded fallbacks below.
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['Broker ticker', 'Canonical ID', 'Notes', 'Added', ''].map(h => (
                  <th key={h} style={{ textAlign: 'left', padding: '9px 12px', fontSize: 10, letterSpacing: '0.14em', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', borderBottom: '1px solid var(--border)' }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {aliases.map(a => (
                <tr key={a.id} style={{ borderBottom: '1px solid var(--border-soft)' }}>
                  <td style={{ padding: '11px 12px' }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 13, color: 'var(--text)' }}>
                      {a.broker_ticker}
                    </span>
                  </td>
                  <td style={{ padding: '11px 12px' }}>
                    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--gold)' }}>
                      → {a.canonical_id}
                    </span>
                  </td>
                  <td style={{ padding: '11px 12px', fontSize: 12, color: 'var(--text-2)' }}>
                    {a.notes ?? <span style={{ color: 'var(--text-4)' }}>—</span>}
                  </td>
                  <td style={{ padding: '11px 12px', fontSize: 11, color: 'var(--text-3)' }}>
                    {formatDate(a.created_at)}
                  </td>
                  <td style={{ padding: '11px 12px', textAlign: 'right' }}>
                    <button
                      onClick={() => deleteAlias(a.id)}
                      disabled={deleting === a.id}
                      className="btn-h"
                      style={{ fontSize: 11, padding: '3px 10px', color: 'var(--neg)', borderColor: 'rgba(166,59,59,0.3)' }}
                    >
                      {deleting === a.id ? <RefreshCw size={11} className="animate-spin" /> : <Trash2 size={11} />}
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* Hardcoded fallbacks — read-only */}
      <div className="panel">
        <div className="panel-header">
          <div className="panel-title">Hardcoded fallbacks</div>
          <div className="panel-meta">Always active · read-only · edit in lib/market-data.ts</div>
        </div>
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr>
              {['Broker ticker', 'Canonical ID', 'Notes'].map(h => (
                <th key={h} style={{ textAlign: 'left', padding: '9px 12px', fontSize: 10, letterSpacing: '0.14em', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', borderBottom: '1px solid var(--border)' }}>
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {HARDCODED.map(a => (
              <tr key={a.broker_ticker} style={{ borderBottom: '1px solid var(--border-soft)', opacity: 0.7 }}>
                <td style={{ padding: '11px 12px' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600, fontSize: 13, color: 'var(--text)' }}>
                    {a.broker_ticker}
                  </span>
                </td>
                <td style={{ padding: '11px 12px' }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--gold)' }}>
                    → {a.canonical_id}
                  </span>
                </td>
                <td style={{ padding: '11px 12px', fontSize: 12, color: 'var(--text-2)' }}>
                  {a.notes}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div style={{ padding: '12px 12px 0', fontSize: 11, color: 'var(--text-3)' }}>
          To add a hardcoded alias, edit <code style={{ fontFamily: 'var(--font-mono)', background: 'var(--bg-soft)', padding: '1px 4px', borderRadius: 2 }}>lib/market-data.ts</code> → <code style={{ fontFamily: 'var(--font-mono)', background: 'var(--bg-soft)', padding: '1px 4px', borderRadius: 2 }}>NGX_TICKER_ALIASES</code>. Use the DB table above for aliases that don't need a code deploy.
        </div>
      </div>
    </main>
  )
}
