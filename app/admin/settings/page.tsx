'use client'
import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { Save, Eye, EyeOff, CheckCircle2, AlertCircle, RefreshCw } from 'lucide-react'

interface APIConfig { key_name: string; key_value: string; is_active: boolean }

export default function SettingsPage() {
  const [configs, setConfigs] = useState<Record<string, string>>({ apify: '', anthropic: '', alpha_vantage: '' })
  const [show, setShow] = useState<Record<string, boolean>>({})
  const [saving, setSaving] = useState<Record<string, boolean>>({})
  const [saved, setSaved] = useState<Record<string, boolean>>({})
  const [testing, setTesting] = useState<Record<string, boolean>>({})
  const [testResults, setTestResults] = useState<Record<string, { ok: boolean; msg: string }>>({})
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.from('api_config').select('key_name, key_value').then(({ data }) => {
      if (data) {
        const m: Record<string, string> = {}
        data.forEach((d: any) => { m[d.key_name] = d.key_value })
        setConfigs(prev => ({ ...prev, ...m }))
      }
      setLoading(false)
    })
  }, [])

  async function saveKey(keyName: string) {
    setSaving(s => ({ ...s, [keyName]: true }))
    const { data: user } = await supabase.auth.getUser()
    await supabase.from('api_config').upsert(
      { key_name: keyName, key_value: configs[keyName], is_active: true, updated_by: user.user?.id },
      { onConflict: 'key_name' }
    )
    setSaving(s => ({ ...s, [keyName]: false }))
    setSaved(s => ({ ...s, [keyName]: true }))
    setTimeout(() => setSaved(s => ({ ...s, [keyName]: false })), 2500)
  }

  async function testApify() {
    setTesting(t => ({ ...t, apify: true }))
    setTestResults(r => ({ ...r, apify: { ok: false, msg: '' } }))
    try {
      const res = await fetch('/api/prices', { method: 'POST' })
      const d = await res.json()
      if (res.ok) setTestResults(r => ({ ...r, apify: { ok: true, msg: `✓ Live — fetched ${d.updated} price(s)` } }))
      else setTestResults(r => ({ ...r, apify: { ok: false, msg: d.error } }))
    } catch (e) {
      setTestResults(r => ({ ...r, apify: { ok: false, msg: (e as Error).message } }))
    } finally {
      setTesting(t => ({ ...t, apify: false }))
    }
  }

  const fields = [
    {
      key: 'anthropic',
      label: 'Anthropic API key',
      placeholder: 'sk-ant-api03-…',
      description: 'Used for AI report generation with Claude claude-sonnet-4. Get from console.anthropic.com.',
      link: 'https://console.anthropic.com',
      badge: 'Required for AI reports',
      badgeColor: '#a78bfa',
      mono: true,
    },
    {
      key: 'apify',
      label: 'Apify API key',
      placeholder: 'apify_api_…',
      description: 'Pulls live NGX stock prices via TradingView scraper. Free tier at apify.com covers daily refreshes.',
      link: 'https://console.apify.com',
      badge: 'Recommended',
      badgeColor: '#2dd4bf',
      canTest: true,
      mono: true,
    },
    {
      key: 'alpha_vantage',
      label: 'Alpha Vantage API key',
      placeholder: 'XXXXXXXXXXXX',
      description: 'Alternative / fallback for NGX prices via .LAG suffix. Free tier: 25 calls/day. alphavantage.co.',
      link: 'https://alphavantage.co',
      badge: 'Fallback',
      badgeColor: '#f5a623',
      mono: true,
    },
  ]

  return (
    <div>
      <div className="px-8 py-5 border-b border-white/[0.07] bg-[#13161d]">
        <h1 className="text-base font-semibold">Settings</h1>
        <p className="text-xs text-[#555d72] mt-0.5">API keys and platform configuration</p>
      </div>

      <div className="px-8 py-6 max-w-2xl space-y-5">
        {/* API Keys */}
        {fields.map(f => (
          <div key={f.key} className="tw-card">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-sm font-medium">{f.label}</span>
              <span className="text-[10px] font-semibold px-2 py-0.5 rounded" style={{ background: f.badgeColor + '18', color: f.badgeColor }}>
                {f.badge}
              </span>
            </div>
            <p className="text-xs text-[#555d72] mb-3 leading-relaxed">
              {f.description}{' '}
              <a href={f.link} target="_blank" className="text-[#a78bfa] hover:underline">{f.link.replace('https://', '')}</a>
            </p>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <input
                  type={show[f.key] ? 'text' : 'password'}
                  value={configs[f.key] || ''}
                  onChange={e => setConfigs(c => ({ ...c, [f.key]: e.target.value }))}
                  placeholder={loading ? 'Loading…' : f.placeholder}
                  className={`tw-input pr-8 ${f.mono ? 'font-mono text-xs' : ''}`}
                />
                <button type="button" onClick={() => setShow(s => ({ ...s, [f.key]: !s[f.key] }))}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#555d72] hover:text-[#8a91a8] transition-colors">
                  {show[f.key] ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
              <button onClick={() => saveKey(f.key)} disabled={saving[f.key] || !configs[f.key]}
                className="flex items-center gap-1.5 px-4 py-2 bg-[#1a1e28] border border-white/10 rounded-lg text-xs hover:border-[#a78bfa]/40 disabled:opacity-50 transition-colors flex-shrink-0">
                {saved[f.key] ? <><CheckCircle2 size={13} className="text-[#00d4a4]" /> Saved</> : saving[f.key] ? 'Saving…' : <><Save size={13} /> Save</>}
              </button>
              {f.canTest && (
                <button onClick={testApify} disabled={testing.apify || !configs.apify}
                  className="flex items-center gap-1.5 px-4 py-2 bg-[#1a1e28] border border-white/10 rounded-lg text-xs hover:border-[#2dd4bf]/40 disabled:opacity-50 transition-colors flex-shrink-0">
                  <RefreshCw size={13} className={testing.apify ? 'animate-spin' : ''} />
                  {testing.apify ? 'Testing…' : 'Test'}
                </button>
              )}
            </div>
            {testResults[f.key] && (
              <div className={`mt-2 text-xs px-3 py-2 rounded-lg ${testResults[f.key].ok ? 'bg-[#00d4a4]/10 text-[#00d4a4]' : 'bg-[#ff5c7a]/10 text-[#ff5c7a]'}`}>
                {testResults[f.key].msg}
              </div>
            )}
          </div>
        ))}

        {/* Data sources info */}
        <div className="tw-card">
          <div className="text-xs font-semibold uppercase tracking-widest text-[#555d72] mb-4">Free data sources (no key needed)</div>
          <div className="space-y-3">
            {[
              ['USD/NGN FX rate', 'exchangerate-api.com', 'Auto-fetched on every page load', '#2dd4bf'],
              ['Nigerian macro data', 'CBN, NBS, DMO, FMDQ', 'Fetched by Claude during AI report generation via web search', '#60a5fa'],
              ['NGX All-Share Index', 'NGX Group website', 'Fetched by Claude during AI report generation', '#a78bfa'],
            ].map(([name, source, note, color]) => (
              <div key={name} className="flex gap-3 text-xs">
                <span className="w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0" style={{ background: color }} />
                <div>
                  <span className="font-medium text-[#8a91a8]">{name}</span>
                  <span className="text-[#555d72]"> · {source}</span>
                  <div className="text-[10px] text-[#555d72] mt-0.5">{note}</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Cost estimates */}
        <div className="tw-card">
          <div className="text-xs font-semibold uppercase tracking-widest text-[#555d72] mb-4">Estimated monthly costs</div>
          <table className="tw-table w-full">
            <thead><tr><th>Service</th><th>Usage</th><th>Est. cost</th></tr></thead>
            <tbody>
              {[
                ['Vercel (hosting)', 'Pro plan recommended', '$20/mo'],
                ['Supabase (database)', 'Free tier is sufficient', '$0–25/mo'],
                ['Anthropic API', '2 reports × 25 portfolios/week', '$15–50/mo'],
                ['Apify (NGX prices)', 'Daily refresh, 6 stocks', '$5–15/mo'],
              ].map(([s, u, c]) => (
                <tr key={s}><td>{s}</td><td className="text-[#555d72]">{u}</td><td className="font-mono text-[#00d4a4]">{c}</td></tr>
              ))}
              <tr className="font-semibold"><td>Total</td><td></td><td className="font-mono text-[#a78bfa]">~$40–110/mo</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}
