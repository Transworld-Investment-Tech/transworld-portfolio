'use client'
import { useState, useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'

export default function LoginPageInner() {
  const router = useRouter()
  const params = useSearchParams()
  const redirect = params.get('redirect') || '/'
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [mode, setMode] = useState<'login' | 'reset'>('login')
  const [resetSent, setResetSent] = useState(false)

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (session) window.location.href = redirect
    })
  }, [redirect])

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    if (error) { setError(error.message); setLoading(false) }
    else { window.location.href = '/' }
  }

  async function handleReset(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setError('')
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/login`
    })
    if (error) setError(error.message)
    else setResetSent(true)
    setLoading(false)
  }

  return (
    <div className="min-h-screen bg-[#0d0f14] flex items-center justify-center p-4">
      <div className="fixed inset-0 pointer-events-none" style={{ backgroundImage: 'linear-gradient(rgba(167,139,250,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(167,139,250,0.03) 1px, transparent 1px)', backgroundSize: '40px 40px' }} />
      <div className="w-full max-w-sm relative">
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-[#a78bfa]/10 border border-[#a78bfa]/20 mb-5">
            <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
              <path d="M4 22 L14 6 L24 22" stroke="#a78bfa" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
              <circle cx="14" cy="6" r="2" fill="#a78bfa"/>
            </svg>
          </div>
          <div className="text-[11px] font-bold tracking-[0.15em] text-[#a78bfa] uppercase mb-1">Transworld AM</div>
          <h1 className="text-xl font-semibold text-[#e8eaf0]">Portfolio Intelligence</h1>
          <p className="text-xs text-[#555d72] mt-1.5">Sign in to your account</p>
        </div>
        <div className="bg-[#13161d] border border-white/[0.07] rounded-2xl p-7">
          {mode === 'login' ? (
            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label className="block text-xs text-[#8a91a8] mb-1.5">Email address</label>
                <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@transworldam.com" required autoFocus className="tw-input" />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs text-[#8a91a8]">Password</label>
                  <button type="button" onClick={() => { setMode('reset'); setError('') }} className="text-[11px] text-[#555d72] hover:text-[#a78bfa] transition-colors">Forgot password?</button>
                </div>
                <input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="••••••••••" required className="tw-input" />
              </div>
              {error && <div className="bg-[#ff5c7a]/10 border border-[#ff5c7a]/20 rounded-lg px-3 py-2.5 text-xs text-[#ff5c7a]">{error}</div>}
              <button type="submit" disabled={loading} className="w-full py-2.5 bg-[#a78bfa] text-white rounded-lg text-sm font-medium hover:bg-[#9b87e8] disabled:opacity-50 transition-colors mt-2">
                {loading ? 'Signing in…' : 'Sign in'}
              </button>
            </form>
          ) : (
            <form onSubmit={handleReset} className="space-y-4">
              <button type="button" onClick={() => { setMode('login'); setError(''); setResetSent(false) }} className="flex items-center gap-1.5 text-xs text-[#555d72] hover:text-[#e8eaf0] mb-4 transition-colors">← Back to sign in</button>
              {resetSent ? (
                <div className="bg-[#00d4a4]/10 border border-[#00d4a4]/20 rounded-lg px-4 py-3 text-xs text-[#00d4a4] text-center">Reset link sent to <strong>{email}</strong>.</div>
              ) : (
                <>
                  <input type="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@transworldam.com" required autoFocus className="tw-input" />
                  {error && <div className="text-xs text-[#ff5c7a]">{error}</div>}
                  <button type="submit" disabled={loading} className="w-full mt-4 py-2.5 bg-[#a78bfa] text-white rounded-lg text-sm font-medium hover:bg-[#9b87e8] disabled:opacity-50 transition-colors">
                    {loading ? 'Sending…' : 'Send reset link'}
                  </button>
                </>
              )}
            </form>
          )}
        </div>
        <p className="text-center text-[11px] text-[#555d72] mt-5">New user? Contact your administrator to be added.</p>
      </div>
    </div>
  )
}