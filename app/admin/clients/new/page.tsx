'use client'
import { useState, useEffect } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { ArrowLeft, Save, AlertCircle, CheckCircle2, Info, Users } from 'lucide-react'

// v18: client creation form. Styling mirrors /admin/prices (v17).
// On success we hand off to /admin/portfolios/new?client=<id> so the
// user immediately creates the client's first portfolio — per the
// agreed scope, these are two separate trips rather than a combined form.

type CodeCheckState = 'idle' | 'checking' | 'available' | 'taken'

export default function NewClientPage() {
  const router = useRouter()
  const [code, setCode] = useState('')
  const [name, setName] = useState('')
  const [type, setType] = useState<'discretionary' | 'advisory' | 'internal'>('discretionary')

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [codeCheck, setCodeCheck] = useState<CodeCheckState>('idle')

  // Debounced uniqueness check
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
      // Hand off to portfolio creation with this client preselected.
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
    <div>
      {/* Header */}
      <div className="px-8 py-6 border-b border-white/[0.07] bg-[#13161d]">
        <div className="flex items-center gap-3">
          <Link
            href="/admin"
            className="flex items-center gap-1.5 text-xs text-[#8a91a8] hover:text-[#e8eaf0] transition-colors">
            <ArrowLeft size={13} /> Admin panel
          </Link>
          <div className="w-px h-4 bg-white/10" />
          <h1 className="text-xl font-semibold">Add client</h1>
        </div>
        <p className="text-xs text-[#555d72] mt-2">
          Create a new client entity. Afterwards you&apos;ll be taken to the portfolio creation form.
        </p>
      </div>

      <div className="px-8 py-6 max-w-xl">
        <div className="tw-card">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-9 h-9 rounded-xl bg-[#a78bfa]/10 border border-[#a78bfa]/20 flex items-center justify-center flex-shrink-0">
              <Users size={16} className="text-[#a78bfa]" />
            </div>
            <div>
              <div className="text-sm font-semibold">Client details</div>
              <div className="text-[11px] text-[#555d72]">Basic information for the new mandate</div>
            </div>
          </div>

          <div className="space-y-4">
            {/* Code */}
            <div>
              <label className="block text-xs text-[#8a91a8] mb-1.5">Client code</label>
              <input
                type="text"
                value={code}
                onChange={e => handleCodeChange(e.target.value)}
                placeholder="e.g. ADE, DON, CMFB"
                maxLength={10}
                className="tw-input font-mono uppercase"
                autoFocus
              />
              <div className="mt-1.5 text-[11px] min-h-[14px]">
                {codeCheck === 'checking' && (
                  <span className="text-[#555d72]">Checking availability…</span>
                )}
                {codeCheck === 'available' && (
                  <span className="text-[#22c55e] inline-flex items-center gap-1">
                    <CheckCircle2 size={10} /> Available
                  </span>
                )}
                {codeCheck === 'taken' && (
                  <span className="text-[#ef4444] inline-flex items-center gap-1">
                    <AlertCircle size={10} /> Already in use
                  </span>
                )}
                {codeCheck === 'idle' && (
                  <span className="text-[#555d72]">
                    2-10 uppercase letters or digits. Used as short identifier.
                  </span>
                )}
              </div>
            </div>

            {/* Name */}
            <div>
              <label className="block text-xs text-[#8a91a8] mb-1.5">Client name</label>
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                placeholder="e.g. Adolphus Estate"
                className="tw-input"
              />
            </div>

            {/* Type */}
            <div>
              <label className="block text-xs text-[#8a91a8] mb-1.5">Type</label>
              <select
                value={type}
                onChange={e => setType(e.target.value as any)}
                className="tw-select">
                <option value="discretionary">Discretionary</option>
                <option value="advisory">Advisory</option>
                <option value="internal">Internal</option>
              </select>
              <div className="mt-1.5 text-[11px] text-[#555d72]">
                {type === 'discretionary' && 'Transworld manages the portfolio with full authority.'}
                {type === 'advisory' && 'Client makes final decisions; Transworld advises.'}
                {type === 'internal' && "Transworld's own portfolio."}
              </div>
            </div>

            {error && (
              <div className="text-xs text-[#ef4444] bg-[#ef4444]/10 rounded-lg px-3 py-2 border border-[#ef4444]/20">
                <AlertCircle size={11} className="inline mr-1 -mt-0.5" />
                {error}
              </div>
            )}

            <div className="flex gap-2 pt-2">
              <button
                onClick={handleSubmit}
                disabled={!canSubmit}
                className="flex-1 flex items-center justify-center gap-2 bg-[#a78bfa] text-white px-4 py-2 rounded-lg text-xs font-medium hover:bg-[#9b87e8] transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                <Save size={12} /> {saving ? 'Creating…' : 'Create client & continue'}
              </button>
              <Link
                href="/admin"
                className="px-4 py-2 border border-white/10 rounded-lg text-xs text-[#8a91a8] hover:text-[#e8eaf0] transition-colors">
                Cancel
              </Link>
            </div>
          </div>
        </div>

        <div className="mt-4 text-[11px] text-[#555d72] flex items-start gap-2">
          <Info size={11} className="mt-0.5 flex-shrink-0" />
          <span>
            The client code must be unique across the system. Existing codes include{' '}
            <span className="font-mono">TW, CMFB, ADE, DON, OPC</span>. After saving, you&apos;ll be
            taken to the portfolio creation form with this client preselected.
          </span>
        </div>
      </div>
    </div>
  )
}
