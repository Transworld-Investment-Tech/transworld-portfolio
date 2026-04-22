'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { ArrowLeft, Save, AlertCircle, CheckCircle2, Info, Users } from 'lucide-react'

// v20e: Hybrid rewrite. Preserves v18 debounced code uniqueness check,
// sanitisation (uppercase letters/digits only, max 10 chars), and the
// handoff to /admin/portfolios/new?client=<id> on success.

type CodeCheckState = 'idle' | 'checking' | 'available' | 'taken'

export default function NewClientPage() {
  const router = useRouter()
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [type, setType] = useState<'discretionary' | 'advisory' | 'internal'>('discretionary')

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [codeCheck, setCodeCheck] = useState<CodeCheckState>('idle')

  useEffect(() => {
    if (!code || code.length < 2) {
      setCodeCheck('idle')
      return
    }
    setCodeCheck('checking')
    const t = setTimeout(async () => {
      const { data } = await supabase
        .from('clients')
        .select('id')
        .eq('code', code)
        .maybeSingle()
      setCodeCheck(data ? 'taken' : 'available')
    }, 400)
    return () => clearTimeout(t)
  }, [code])

  function handleCodeChange(val: string) {
    const sanitised = val.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10)
    setCode(sanitised)
  }

  async function handleSubmit() {
    setError('')
    if (!code) return setError('Code is required')
    if (code.length < 2) return setError('Code must be at least 2 characters')
    if (!name.trim()) return setError('Name is required')
    if (codeCheck === 'taken') return setError(`Code "${code}" is already in use`)
    if (codeCheck === 'checking') return setError('Still checking code availability…')

    setSaving(true)
    try {
      const res = await fetch('/api/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, name: name.trim(), type }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error || 'Failed to create client')
        setSaving(false)
        return
      }
      router.push(`/admin/portfolios/new?client=${data.client.id}`)
    } catch (e) {
      setError((e as Error).message)
      setSaving(false)
    }
  }

  const canSubmit =
    code.length >= 2 &&
    name.trim().length > 0 &&
    codeCheck === 'available' &&
    !saving

  return (
    <main className="hybrid-page" style={{ padding: '32px 44px 64px', minHeight: '100vh' }}>
      <div className="page-head">
        <div>
          <Link
            href="/admin"
            className="eyebrow"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              marginBottom: 10,
              textDecoration: 'none',
            }}
          >
            <ArrowLeft size={11} /> Admin panel
          </Link>
          <h1 className="hybrid-serif" style={{ fontSize: 36, fontWeight: 500, letterSpacing: '-0.005em', lineHeight: 1, color: 'var(--text)' }}>
            Add client
          </h1>
        </div>
      </div>

      <div style={{ maxWidth: 560 }}>
        <div className="panel">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 20, paddingBottom: 14, borderBottom: '1px solid var(--border-soft)' }}>
            <div
              style={{
                width: 36,
                height: 36,
                borderRadius: 4,
                background: 'var(--gold-soft)',
                border: '1px solid rgba(176, 139, 62, 0.25)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <Users size={16} style={{ color: 'var(--gold)' }} />
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>Client details</div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                Basic information for the new mandate
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
            {/* Code */}
            <div>
              <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>Client code</label>
              <input
                type="text"
                value={code}
                onChange={e => handleCodeChange(e.target.value)}
                placeholder="e.g. ADE, DON, CMFB"
                maxLength={10}
                className="input-h input-h-mono"
                style={{ textTransform: 'uppercase' }}
                autoFocus
              />
              <div style={{ marginTop: 6, fontSize: 11, minHeight: 14 }}>
                {codeCheck === 'checking' && (
                  <span style={{ color: 'var(--text-3)' }}>Checking availability…</span>
                )}
                {codeCheck === 'available' && (
                  <span style={{ color: 'var(--pos)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <CheckCircle2 size={10} /> Available
                  </span>
                )}
                {codeCheck === 'taken' && (
                  <span style={{ color: 'var(--neg)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <AlertCircle size={10} /> Already in use
                  </span>
                )}
                {codeCheck === 'idle' && (
                  <span style={{ color: 'var(--text-3)' }}>
                    2–10 uppercase letters or digits. Used as short identifier.
                  </span>
                )}
              </div>
            </div>

            {/* Name */}
            <div>
              <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>Client name</label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Adolphus Estate"
                className="input-h"
              />
            </div>

            {/* Type */}
            <div>
              <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>Type</label>
              <select
                value={type}
                onChange={e => setType(e.target.value as any)}
                className="select-h"
              >
                <option value="discretionary">Discretionary</option>
                <option value="advisory">Advisory</option>
                <option value="internal">Internal</option>
              </select>
              <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-3)' }}>
                {type === 'discretionary' && 'Transworld manages the portfolio with full authority.'}
                {type === 'advisory' && 'Client makes final decisions; Transworld advises.'}
                {type === 'internal' && "Transworld's own portfolio."}
              </div>
            </div>

            {error && (
              <div className="alert-h alert-h-critical" style={{ fontSize: 12 }}>
                <AlertCircle size={12} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>{error}</span>
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, paddingTop: 4 }}>
              <button
                className="btn-h btn-h-primary"
                onClick={handleSubmit}
                disabled={!canSubmit}
                style={{ flex: 1, justifyContent: 'center' }}
              >
                <Save size={12} /> {saving ? 'Creating…' : 'Create client & continue'}
              </button>
              <Link href="/admin" className="btn-h" style={{ textDecoration: 'none' }}>
                Cancel
              </Link>
            </div>
          </div>
        </div>

        <div style={{ marginTop: 14, fontSize: 11, color: 'var(--text-3)', display: 'flex', alignItems: 'flex-start', gap: 6, lineHeight: 1.6 }}>
          <Info size={11} style={{ marginTop: 2, flexShrink: 0 }} />
          <span>
            The client code must be unique across the system. Existing codes include{' '}
            <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-2)' }}>TW, CMFB, ADE, DON, OPC</span>. After saving, you'll be
            taken to the portfolio creation form with this client preselected.
          </span>
        </div>
      </div>
    </main>
  )
}
