'use client'
import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { fmt } from '@/lib/portfolio'
import { Save, Plus, Trash2, AlertTriangle, Copy, Check } from 'lucide-react'

// v27an: fee architecture options (mirrors DB CHECK constraints)
const FEE_MODEL_OPTIONS = ['none', 'performance_excess', 'performance_hwm', 'performance_combined', 'fixed_annual']
const FEE_MODEL_LABELS: Record<string, string> = {
  none:                 'None - no fees accrued',
  performance_excess:   'Performance - excess return',
  performance_hwm:      'Performance - high-water mark',
  performance_combined: 'Performance + fixed annual',
  fixed_annual:         'Fixed annual fee',
}
const FEE_BILLING_OPTIONS = ['annual', 'quarterly', 'monthly']

// v20d: Hybrid rewrite.
// Sidebar rendered by app/portfolio/[id]/layout.tsx — do NOT render here.
// PageActions dropped; inline hybrid Copy button wired to getSettingsText().
// Drawdown fields remain stored as negative numbers (mandate convention).
// v21j: Starting NAV and start_date are now editable inputs, included in
//   savePortfolio(). Previously they were read-only display fields. This
//   allows manual override for portfolios not using the broker upload path.

export default function PortfolioSettingsPage() {
  const { id: portfolioId } = useParams() as { id: string }
  const router = useRouter()
  const [portfolio, setPortfolio] = useState<any>(null)
  const [sleeves,   setSleeves]   = useState<any[]>([])
  const [navLog,    setNavLog]    = useState<any[]>([])
  const [newNav, setNewNav] = useState({
    nav_date: new Date().toISOString().slice(0, 10),
    nav_value: '',
    notes: '',
  })
  const [saving,    setSaving]    = useState(false)
  const [savingNav, setSavingNav] = useState(false)
  const [msg,       setMsg]       = useState('')
  const [msgIsErr,  setMsgIsErr]  = useState(false)
  const [loading,   setLoading]   = useState(true)
  const [copied,    setCopied]    = useState(false)

  useEffect(() => {
    async function load() {
      const [portRes, slRes, navRes] = await Promise.all([
        supabase.from('portfolios').select('*, client:clients(name, code)').eq('id', portfolioId).single(),
        supabase.from('sleeve_targets').select('*').eq('portfolio_id', portfolioId).order('sort_order'),
        supabase.from('nav_log').select('*').eq('portfolio_id', portfolioId).order('nav_date', { ascending: false }).limit(20),
      ])
      setPortfolio(portRes.data)
      setSleeves(slRes.data ?? [])
      setNavLog(navRes.data ?? [])
      setLoading(false)
    }
    load()
  }, [portfolioId])

  function updateField(key: string, val: any) {
    setPortfolio((p: any) => ({ ...p, [key]: val }))
  }
  function updateSleeve(id: string, key: string, val: string) {
    setSleeves(s => s.map(sl => sl.sleeve_id === id ? { ...sl, [key]: Number(val) } : sl))
  }

  async function savePortfolio() {
    setSaving(true)
    const sleeveTotal = sleeves.reduce((s, sl) => s + sl.target_pct * 100, 0)
    if (Math.abs(sleeveTotal - 100) > 0.5) {
      flash(`Sleeve targets must sum to 100%. Currently: ${sleeveTotal.toFixed(1)}%`, true)
      setSaving(false)
      return
    }
    // v27an: fee architecture validation (mirrors DB CHECK constraints)
    const feeModel = portfolio.fee_model || 'none'
    if (!FEE_MODEL_OPTIONS.includes(feeModel)) {
      flash(`Invalid fee model: ${feeModel}`, true)
      setSaving(false)
      return
    }
    if (feeModel === 'fixed_annual' && !portfolio.fixed_annual_fee_ngn) {
      flash('Fixed annual fee (NGN) is required when fee model is Fixed Annual', true)
      setSaving(false)
      return
    }
    if (feeModel !== 'none' && portfolio.fee_year_end_md && !/^[0-1][0-9]-[0-3][0-9]$/.test(portfolio.fee_year_end_md)) {
      flash(`Fee year-end must be MM-DD format (e.g. 12-31). Got: ${portfolio.fee_year_end_md}`, true)
      setSaving(false)
      return
    }
    const billingFreq = portfolio.fee_billing_frequency || 'annual'
    if (!FEE_BILLING_OPTIONS.includes(billingFreq)) {
      flash(`Invalid billing frequency: ${billingFreq}`, true)
      setSaving(false)
      return
    }
    // v21j: starting_nav and start_date included in save payload
    // v27an: fee architecture fields included in save payload
    const isPerformance = feeModel.startsWith('performance')
    const isFixedOrCombined = feeModel === 'fixed_annual' || feeModel === 'performance_combined'
    const { error: pe } = await supabase.from('portfolios').update({
      name:           portfolio.name,
      starting_nav:   Number(portfolio.starting_nav) || 0,
      start_date:     portfolio.start_date || null,
      income_target:  Number(portfolio.income_target),
      cap_target:     Number(portfolio.cap_target),
      target_return:  Number(portfolio.target_return) || 0.15,
      liq_min:        Number(portfolio.liq_min),
      dd_alert:       Number(portfolio.dd_alert),
      dd_action:      Number(portfolio.dd_action),
      max_eq_single:  Number(portfolio.max_eq_single),
      max_eq_sleeve:  Number(portfolio.max_eq_sleeve),
      valuation_date: portfolio.valuation_date,
      notes:          portfolio.notes,
      fee_model:                   feeModel,
      performance_fee_split:       isPerformance && portfolio.performance_fee_split !== '' && portfolio.performance_fee_split != null ? Number(portfolio.performance_fee_split) : null,
      fixed_annual_fee_ngn:        isFixedOrCombined && portfolio.fixed_annual_fee_ngn !== '' && portfolio.fixed_annual_fee_ngn != null ? Number(portfolio.fixed_annual_fee_ngn) : null,
      fee_billing_frequency:       billingFreq,
      fee_year_end_md:             feeModel !== 'none' ? (portfolio.fee_year_end_md || '12-31') : (portfolio.fee_year_end_md || '12-31'),
      fee_relationship_start_date: portfolio.fee_relationship_start_date || null,
    }).eq('id', portfolioId)
    if (!pe) {
      for (const sl of sleeves) {
        await supabase.from('sleeve_targets').update({
          target_pct: sl.target_pct,
          min_pct:    sl.min_pct,
          max_pct:    sl.max_pct,
        }).match({ portfolio_id: portfolioId, sleeve_id: sl.sleeve_id })
      }
      // v27an: trigger fee_periods recompute for anchored fee-bearing portfolios
      if (feeModel !== 'none' && portfolio.fee_relationship_start_date) {
        try {
          const recRes = await fetch('/api/admin/recompute-fee-periods', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ portfolio_id: portfolioId }),
          })
          const recJson = await recRes.json().catch(() => ({}))
          if (recRes.ok && recJson.ok !== false) {
            const inserted = typeof recJson.inserted === 'number' ? ` (${recJson.inserted} pending periods)` : ''
            flash(`Settings saved & fee periods recomputed${inserted} ✓`)
          } else {
            flash(`Settings saved — recompute failed: ${recJson.error || recJson.reason || 'unknown'}`, true)
          }
        } catch (err: any) {
          flash(`Settings saved — recompute network error: ${err?.message || 'unknown'}`, true)
        }
      } else {
        flash('Settings saved ✓')
      }
    } else {
      flash(pe.message, true)
    }
    setSaving(false)
  }

  async function addNavEntry() {
    if (!newNav.nav_value) return
    setSavingNav(true)
    // nav_log has no unique constraint on (portfolio_id, nav_date) — pitfall #3.
    // Use plain insert rather than upsert with onConflict to avoid a DB error.
    await supabase.from('nav_log').insert({
      portfolio_id: portfolioId,
      nav_date:     newNav.nav_date,
      nav_value:    Number(newNav.nav_value),
      notes:        newNav.notes || null,
    })
    const { data } = await supabase.from('nav_log').select('*').eq('portfolio_id', portfolioId).order('nav_date', { ascending: false }).limit(20)
    setNavLog(data ?? [])
    setNewNav(n => ({ ...n, nav_value: '', notes: '' }))
    setSavingNav(false)
    flash('NAV entry logged ✓')
  }

  async function deleteNavEntry(id: string) {
    await supabase.from('nav_log').delete().eq('id', id)
    setNavLog(n => n.filter(e => e.id !== id))
  }

  function flash(m: string, isErr = false) {
    setMsg(m)
    setMsgIsErr(isErr)
    setTimeout(() => setMsg(''), 3000)
  }

  function getSettingsText(): string {
    if (!portfolio) return ''
    const pct = (v: number) => `${(Math.abs(Number(v)) * 100).toFixed(1)}%`
    const lines: string[] = [
      `CLIENT:          ${portfolio.client?.name ?? 'N/A'}`,
      `PORTFOLIO:       ${portfolio.name}`,
      `LABEL:           Portfolio ${portfolio.label}`,
      `CURRENCY:        ${portfolio.currency}`,
      `START DATE:      ${portfolio.start_date}`,
      `STARTING NAV:    ₦${(Number(portfolio.starting_nav) / 1e6).toFixed(2)}M`,
      `VALUATION DATE:  ${portfolio.valuation_date ?? 'N/A'}`,
      '',
      '── MANDATE & TARGETS ───────────────────────────────────',
      `Income target:          ${pct(portfolio.income_target)} p.a.`,
      `Cap appreciation target: ${pct(portfolio.cap_target)} p.a.`,
      `Max single equity:      ${pct(portfolio.max_eq_single)} of NAV`,
      `Max equity sleeve:      ${pct(portfolio.max_eq_sleeve)}`,
      `Liquidity minimum:      ${pct(portfolio.liq_min)}`,
      `Drawdown alert:         ${pct(portfolio.dd_alert)}`,
      `Drawdown action:        ${pct(portfolio.dd_action)}`,
      '',
      '── SLEEVE TARGETS ──────────────────────────────────────',
    ]
    sleeves.forEach(s => {
      lines.push(`${s.name}: ${(s.target_pct*100).toFixed(0)}% target (${(s.min_pct*100).toFixed(0)}%–${(s.max_pct*100).toFixed(0)}% range)`)
    })
    // v27an: include fee architecture in copyable settings
    if (portfolio.fee_model && portfolio.fee_model !== 'none') {
      lines.push('')
      lines.push('── FEE ARCHITECTURE ────────────────────────────────────')
      lines.push(`Fee model:              ${FEE_MODEL_LABELS[portfolio.fee_model] || portfolio.fee_model}`)
      if (portfolio.fee_relationship_start_date) {
        lines.push(`Mandate inception:      ${portfolio.fee_relationship_start_date}`)
      } else {
        lines.push(`Mandate inception:      (not yet anchored)`)
      }
      if (portfolio.fee_model.startsWith('performance')) {
        lines.push(`Performance hurdle:     ${pct(portfolio.target_return)} p.a.`)
        if (portfolio.performance_fee_split != null) {
          lines.push(`Performance fee split:  ${Number(portfolio.performance_fee_split).toFixed(1)}% (Transworld share above hurdle)`)
        }
      }
      if (portfolio.fee_model === 'fixed_annual' || portfolio.fee_model === 'performance_combined') {
        if (portfolio.fixed_annual_fee_ngn) {
          lines.push(`Fixed annual fee:       ₦${(Number(portfolio.fixed_annual_fee_ngn) / 1e6).toFixed(2)}M / year`)
        }
        lines.push(`Billing frequency:      ${portfolio.fee_billing_frequency || 'annual'}`)
      }
      lines.push(`Fee year-end:           ${portfolio.fee_year_end_md || '12-31'}`)
    }
    if (navLog.length > 0) {
      lines.push('')
      lines.push('── NAV HISTORY ──────────────────────────────────────')
      navLog.forEach(n => {
        lines.push(`${n.nav_date}: ₦${(n.nav_value / 1e6).toFixed(2)}M${n.notes ? '  — ' + n.notes : ''}`)
      })
    }
    if (portfolio.notes) {
      lines.push('')
      lines.push('── NOTES ────────────────────────────────────────────')
      lines.push(portfolio.notes)
    }
    return lines.join('\n')
  }

  async function copyText() {
    await navigator.clipboard.writeText(getSettingsText())
    setCopied(true)
    setTimeout(() => setCopied(false), 2500)
  }

  const sleeveTotal = sleeves.reduce((s, sl) => s + sl.target_pct * 100, 0)
  const sleeveTotalOk = Math.abs(sleeveTotal - 100) < 0.5

  if (loading || !portfolio) {
    return (
      <div className="hybrid-page" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh', color: 'var(--text-3)', fontSize: 14 }}>
        Loading…
      </div>
    )
  }

  return (
    <main className="hybrid-page" style={{ padding: '32px 44px 64px', minHeight: '100vh' }}>
      {/* Page header */}
      <div className="page-head">
        <div>
          <div className="eyebrow" style={{ marginBottom: 10 }}>
            {portfolio.client?.name} · {portfolio.name}
          </div>
          <h1 className="hybrid-serif" style={{ fontSize: 36, fontWeight: 500, letterSpacing: '-0.005em', lineHeight: 1, color: 'var(--text)' }}>
            Portfolio settings
          </h1>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {msg && (
            <span style={{ fontSize: 11, color: msgIsErr ? 'var(--neg)' : 'var(--pos)' }}>
              {msg}
            </span>
          )}
          <button className="btn-h" onClick={copyText}>
            {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
          </button>
          <button className="btn-h btn-h-primary" onClick={savePortfolio} disabled={saving}>
            <Save size={12} /> {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      </div>

      <div style={{ maxWidth: 760, display: 'flex', flexDirection: 'column', gap: 16 }}>

        {/* Portfolio details */}
        <div className="panel">
          <div className="panel-header">
            <div className="panel-title">Portfolio details</div>
          </div>
          {/* Portfolio name + valuation date */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
            <div>
              <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>Portfolio name</label>
              <input
                value={portfolio.name || ''}
                onChange={e => updateField('name', e.target.value)}
                className="input-h"
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>Valuation date</label>
              <input
                type="date"
                value={portfolio.valuation_date || ''}
                onChange={e => updateField('valuation_date', e.target.value)}
                className="input-h"
              />
            </div>
          </div>
          {/* v21j: Starting NAV and start_date are now editable inputs */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
            <div>
              <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>
                Starting NAV (₦)
              </label>
              <input
                type="number"
                value={portfolio.starting_nav ?? ''}
                onChange={e => updateField('starting_nav', e.target.value)}
                placeholder="0"
                className="input-h input-h-mono"
                step="0.01"
              />
              <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 4, lineHeight: 1.4 }}>
                Used for IRR &amp; performance calculations. Set to 0 for broker-onboarded portfolios (auto-inferred at first commit).
              </div>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>
                Relationship start date
              </label>
              <input
                type="date"
                value={portfolio.start_date || ''}
                onChange={e => updateField('start_date', e.target.value)}
                className="input-h"
              />
              <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 4, lineHeight: 1.4 }}>
                Date of first capital deployment or mandate inception.
              </div>
            </div>
          </div>
          {/* Currency and label remain read-only */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16, fontSize: 12, color: 'var(--text-3)' }}>
            <div>Currency: <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-2)', marginLeft: 4 }}>{portfolio.currency}</span></div>
            <div>Label: <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-2)', marginLeft: 4 }}>Portfolio {portfolio.label}</span></div>
          </div>
          <div>
            <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>Notes</label>
            <textarea
              value={portfolio.notes || ''}
              onChange={e => updateField('notes', e.target.value)}
              rows={3}
              className="textarea-h"
            />
          </div>
        </div>

        {/* Return targets & risk thresholds */}
        <div className="panel">
          <div className="panel-header">
            <div className="panel-title">Return targets &amp; risk thresholds</div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            {/* v27k: target_return field — DMA performance fee threshold */}
            {[
              ['Income target (%)',                  'income_target'],
              ['Cap. appreciation target (%)',       'cap_target'],
              ['Performance fee threshold (%)',      'target_return'],
              ['Max single equity (% NAV)',          'max_eq_single'],
              ['Max equity sleeve (%)',              'max_eq_sleeve'],
              ['Drawdown alert (%)',                 'dd_alert'],
              ['Drawdown action threshold (%)',      'dd_action'],
            ].map(([label, key]) => (
              <div key={key}>
                <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>{label}</label>
                <div style={{ position: 'relative' }}>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    max="100"
                    value={portfolio[key] !== undefined ? (Math.abs(portfolio[key]) * 100).toFixed(1) : ''}
                    onChange={e => {
                      const raw = Number(e.target.value) / 100
                      updateField(key, key.startsWith('dd_') ? -Math.abs(raw) : raw)
                    }}
                    className="input-h input-h-mono"
                    style={{ paddingRight: 28 }}
                  />
                  <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 11, color: 'var(--text-3)' }}>%</span>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* v27an: Fee architecture */}
        <div className="panel">
          <div className="panel-header">
            <div className="panel-title">Fee architecture</div>
            {portfolio.fee_model && portfolio.fee_model !== 'none' && (
              <div className="panel-meta" style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-3)' }}>
                Hurdle: {((Number(portfolio.target_return) || 0) * 100).toFixed(1)}% (set in Return targets)
              </div>
            )}
          </div>

          {/* Fee model dropdown - always shown */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
            <div>
              <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>
                Fee model
              </label>
              <select
                value={portfolio.fee_model || 'none'}
                onChange={e => updateField('fee_model', e.target.value)}
                className="input-h"
              >
                {FEE_MODEL_OPTIONS.map(opt => (
                  <option key={opt} value={opt}>{FEE_MODEL_LABELS[opt]}</option>
                ))}
              </select>
            </div>

            {/* Mandate inception date - shown when fee_model != 'none' */}
            {portfolio.fee_model && portfolio.fee_model !== 'none' && (
              <div>
                <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>
                  Mandate inception date
                </label>
                <input
                  type="date"
                  value={portfolio.fee_relationship_start_date || ''}
                  onChange={e => updateField('fee_relationship_start_date', e.target.value)}
                  className="input-h"
                />
                <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 4, lineHeight: 1.4 }}>
                  When fee accrual begins. Reset this when the mandate is renegotiated.
                </div>
              </div>
            )}
          </div>

          {/* Performance fee split - shown when fee_model contains 'performance' */}
          {portfolio.fee_model && portfolio.fee_model.startsWith('performance') && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
              <div>
                <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>
                  Performance fee split (%)
                </label>
                <div style={{ position: 'relative' }}>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    max="100"
                    value={portfolio.performance_fee_split ?? ''}
                    onChange={e => updateField('performance_fee_split', e.target.value === '' ? null : Number(e.target.value))}
                    className="input-h input-h-mono"
                    style={{ paddingRight: 28 }}
                    placeholder="20.0"
                  />
                  <span style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', fontSize: 11, color: 'var(--text-3)' }}>%</span>
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 4, lineHeight: 1.4 }}>
                  Transworld share of performance above the hurdle.
                </div>
              </div>
            </div>
          )}

          {/* Fixed annual fee + billing - shown for fixed_annual or performance_combined */}
          {(portfolio.fee_model === 'fixed_annual' || portfolio.fee_model === 'performance_combined') && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
              <div>
                <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>
                  Fixed annual fee (NGN)
                </label>
                <input
                  type="number"
                  step="1000"
                  min="0"
                  value={portfolio.fixed_annual_fee_ngn ?? ''}
                  onChange={e => updateField('fixed_annual_fee_ngn', e.target.value === '' ? null : Number(e.target.value))}
                  className="input-h input-h-mono"
                  placeholder="1000000"
                />
                <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 4, lineHeight: 1.4 }}>
                  Flat naira amount per year.
                </div>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>
                  Billing frequency
                </label>
                <select
                  value={portfolio.fee_billing_frequency || 'annual'}
                  onChange={e => updateField('fee_billing_frequency', e.target.value)}
                  className="input-h"
                >
                  {FEE_BILLING_OPTIONS.map(opt => (
                    <option key={opt} value={opt}>{opt.charAt(0).toUpperCase() + opt.slice(1)}</option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {/* Fee year-end - shown when fee_model != 'none' */}
          {portfolio.fee_model && portfolio.fee_model !== 'none' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
              <div>
                <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>
                  Fee year-end (MM-DD)
                </label>
                <input
                  type="text"
                  value={portfolio.fee_year_end_md || '12-31'}
                  onChange={e => updateField('fee_year_end_md', e.target.value)}
                  className="input-h input-h-mono"
                  placeholder="12-31"
                  pattern="[0-1][0-9]-[0-3][0-9]"
                />
                <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 4, lineHeight: 1.4 }}>
                  End of fee year. Default: 12-31.
                </div>
              </div>
            </div>
          )}

          {/* Recompute hint banner */}
          {portfolio.fee_model && portfolio.fee_model !== 'none' && portfolio.fee_relationship_start_date && (
            <div style={{ marginTop: 16, padding: '10px 12px', background: 'rgba(166, 124, 42, 0.08)', border: '1px solid rgba(166, 124, 42, 0.2)', borderRadius: 4, fontSize: 11, color: 'var(--text-2)', lineHeight: 1.5 }}>
              Saving will recompute pending fee periods. Paid/invoiced periods are preserved (snapshot-frozen).
            </div>
          )}
        </div>

        {/* Sleeve allocation targets */}
        <div className="panel">
          <div className="panel-header">
            <div className="panel-title">Sleeve allocation targets</div>
            <div
              className="panel-meta"
              style={{
                fontFamily: 'var(--font-mono)',
                color: sleeveTotalOk ? 'var(--pos)' : 'var(--neg)',
                fontWeight: 500,
              }}
            >
              Total: {sleeveTotal.toFixed(1)}%
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {sleeves.map(s => (
              <div
                key={s.sleeve_id}
                style={{ display: 'grid', gridTemplateColumns: '1.5fr 1fr 1fr 1fr', gap: 12, alignItems: 'end' }}
              >
                <div style={{ fontSize: 13, color: 'var(--text)', paddingBottom: 8, fontWeight: 500 }}>
                  {s.name}
                </div>
                {[['Target %', 'target_pct'], ['Min %', 'min_pct'], ['Max %', 'max_pct']].map(([lbl, key]) => (
                  <div key={key}>
                    <label style={{ display: 'block', fontSize: 10, color: 'var(--text-3)', marginBottom: 4 }}>
                      {lbl}
                    </label>
                    <input
                      type="number"
                      step="1"
                      min="0"
                      max="100"
                      value={(s[key as string] * 100).toFixed(0)}
                      onChange={e => updateSleeve(s.sleeve_id, key as string, String(Number(e.target.value) / 100))}
                      className="input-h input-h-sm input-h-mono"
                      style={{ textAlign: 'right' }}
                    />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </div>

        {/* NAV log */}
        <div className="panel">
          <div className="panel-header">
            <div className="panel-title">NAV log</div>
            <div className="panel-meta">
              {navLog.length} {navLog.length === 1 ? 'entry' : 'entries'}
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1.5fr auto', gap: 12, alignItems: 'end', marginBottom: 16 }}>
            <div>
              <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>Date</label>
              <input
                type="date"
                value={newNav.nav_date}
                onChange={e => setNewNav(n => ({ ...n, nav_date: e.target.value }))}
                className="input-h"
              />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>NAV (₦)</label>
              <input
                type="number"
                value={newNav.nav_value}
                onChange={e => setNewNav(n => ({ ...n, nav_value: e.target.value }))}
                placeholder="300000000"
                className="input-h input-h-mono"
              />
            </div>
            <button
              className="btn-h btn-h-primary"
              onClick={addNavEntry}
              disabled={savingNav || !newNav.nav_value}
            >
              <Plus size={12} /> {savingNav ? 'Logging…' : 'Log NAV'}
            </button>
          </div>
          {navLog.length > 0 && (
            <div style={{ overflowX: 'auto' }}>
              <table className="h-table" style={{ width: '100%' }}>
                <thead>
                  <tr>
                    <th>Date</th>
                    <th className="num">NAV (₦)</th>
                    <th>Notes</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {navLog.map(n => (
                    <tr key={n.id}>
                      <td style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>{n.nav_date}</td>
                      <td className="num num-serif">{fmt.ngnM(n.nav_value)}</td>
                      <td style={{ fontSize: 11, color: 'var(--text-3)' }}>{n.notes || '—'}</td>
                      <td style={{ textAlign: 'right' }}>
                        <button
                          onClick={() => deleteNavEntry(n.id)}
                          className="btn-h"
                          style={{ padding: '4px 8px', color: 'var(--text-3)' }}
                          title="Delete entry"
                        >
                          <Trash2 size={11} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Danger zone */}
        <div
          className="panel"
          style={{ borderColor: 'rgba(166, 59, 59, 0.3)', boxShadow: 'none' }}
        >
          <div
            className="panel-header"
            style={{ borderBottomColor: 'rgba(166, 59, 59, 0.15)' }}
          >
            <div className="panel-title" style={{ color: 'var(--neg)', display: 'flex', alignItems: 'center', gap: 6 }}>
              <AlertTriangle size={12} /> Danger zone
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 16 }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)', marginBottom: 4 }}>
                Close portfolio
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', lineHeight: 1.5 }}>
                Marks this portfolio as closed. Holdings and history are preserved but the portfolio no longer appears in active lists.
              </div>
            </div>
            <button
              onClick={async () => {
                if (!confirm('Close this portfolio? This cannot be undone easily.')) return
                await supabase.from('portfolios').update({ status: 'closed' }).eq('id', portfolioId)
                router.push('/')
              }}
              className="btn-h"
              style={{ color: 'var(--neg)', borderColor: 'rgba(166, 59, 59, 0.35)', flexShrink: 0 }}
            >
              Close portfolio
            </button>
          </div>
        </div>

      </div>
    </main>
  )
}
