'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { ArrowLeft, Save } from 'lucide-react'

export default function NewClientPage() {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [form, setForm] = useState({
    code: '', name: '', type: 'discretionary',
    contact_name: '', contact_email: '', notes: ''
  })

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm(f => ({ ...f, [k]: e.target.value }))

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError('')
    const { data: user } = await supabase.auth.getUser()
    const { data, error: err } = await supabase.from('clients').insert({
      ...form, status: 'active', created_by: user.user?.id
    }).select().single()
    if (err) { setError(err.message); setSaving(false) }
    else router.push(`/admin/clients/${data.id}`)
  }

  return (
    <div>
      <div className="px-8 py-5 border-b border-white/[0.07] bg-[#13161d] flex items-center gap-4">
        <Link href="/admin/clients" className="flex items-center gap-1.5 text-xs text-[#8a91a8] hover:text-[#e8eaf0] transition-colors">
          <ArrowLeft size={13} /> Clients
        </Link>
        <div className="w-px h-4 bg-white/10" />
        <h1 className="text-base font-semibold">Add new client</h1>
      </div>

      <div className="px-8 py-6 max-w-xl">
        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="tw-card space-y-4">
            <div className="text-xs font-semibold uppercase tracking-widest text-[#555d72] pb-2 border-b border-white/[0.07]">Client details</div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-[#8a91a8] mb-1.5">Client code <span className="text-[#ff5c7a]">*</span></label>
                <input value={form.code} onChange={set('code')} placeholder="e.g. TWI, ACME_A" required className="tw-input font-mono" maxLength={20} />
                <p className="text-[10px] text-[#555d72] mt-1">Unique short identifier</p>
              </div>
              <div>
                <label className="block text-xs text-[#8a91a8] mb-1.5">Client type <span className="text-[#ff5c7a]">*</span></label>
                <select value={form.type} onChange={set('type')} className="tw-select">
                  <option value="discretionary">Discretionary</option>
                  <option value="advisory">Advisory</option>
                  <option value="internal">Internal (Transworld)</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-xs text-[#8a91a8] mb-1.5">Full client name <span className="text-[#ff5c7a]">*</span></label>
              <input value={form.name} onChange={set('name')} placeholder="e.g. Transworld Asset Management" required className="tw-input" />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-xs text-[#8a91a8] mb-1.5">Contact name</label>
                <input value={form.contact_name} onChange={set('contact_name')} placeholder="John Adeyemi" className="tw-input" />
              </div>
              <div>
                <label className="block text-xs text-[#8a91a8] mb-1.5">Contact email</label>
                <input type="email" value={form.contact_email} onChange={set('contact_email')} placeholder="john@company.com" className="tw-input" />
              </div>
            </div>

            <div>
              <label className="block text-xs text-[#8a91a8] mb-1.5">Notes</label>
              <textarea value={form.notes} onChange={set('notes')} rows={2} placeholder="Any notes about this client…" className="tw-input resize-none" />
            </div>
          </div>

          {error && <div className="alert alert-critical">{error}</div>}

          <div className="flex gap-3">
            <button type="submit" disabled={saving}
              className="flex items-center gap-2 bg-[#a78bfa] text-white px-5 py-2.5 rounded-lg text-sm font-medium hover:bg-[#9b87e8] disabled:opacity-50 transition-colors">
              <Save size={14} /> {saving ? 'Saving…' : 'Create client'}
            </button>
            <Link href="/admin/clients" className="flex items-center gap-2 border border-white/10 px-5 py-2.5 rounded-lg text-sm text-[#8a91a8] hover:text-[#e8eaf0] transition-colors">
              Cancel
            </Link>
          </div>
        </form>
      </div>
    </div>
  )
}
