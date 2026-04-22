'use client'
import { useEffect, useState, Suspense } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import {
  ArrowLeft, Save, AlertCircle, Info, Shield,
  Briefcase, TrendingUp, Settings2, BarChart3, CheckCircle2,
} from 'lucide-react'

// v20e: Hybrid rewrite.
// Preserves v19d verbatim:
//   • Starting NAV accepts 0 or blank (portfolio built from TRANSFER_IN)
//   • missingReasons hint surfaces under disabled Create button
//   • label conflict detection, name auto-sync with label
//   • Suspense wrapper (Next 15 requires this for useSearchParams)

const MANDATE_PRESETS = {
  conservative: {
    label: 'Conservative',
    description: 'Income-focused. Low volatility tolerance.',
    income_target: 0.12, cap_target: 0.08, liq_min: 0.10,
    dd_alert: -0.05, dd_action: -0.08,
    max_eq_single: 0.07, max_eq_sleeve: 0.35,
    sleeves: {
      liq: { target: 0.15, min: 0.10, max: 0.25 },
      eq:  { target: 0.25, min: 0.15, max: 0.35 },
      fi:  { target: 0.60, min: 0.50, max: 0.75 },
    },
  },
  balanced: {
    label: 'Balanced',
    description: 'Mix of income and capital growth.',
    income_target: 0.10, cap_target: 0.15, liq_min: 0.05,
    dd_alert: -0.10, dd_action: -0.15,
    max_eq_single: 0.10, max_eq_sleeve: 0.60,
    sleeves: {
      liq: { target: 0.10, min: 0.05, max: 0.20 },
      eq:  { target: 0.60, min: 0.45, max: 0.70 },
      fi:  { target: 0.30, min: 0.20, max: 0.45 },
    },
  },
  growth: {
    label: 'Growth',
    description: 'Capital appreciation. Higher volatility.',
    income_target: 0.08, cap_target: 0.22, liq_min: 0.03,
    dd_alert: -0.15, dd_action: -0.20,
    max_eq_single: 0.15, max_eq_sleeve: 0.80,
    sleeves: {
      liq: { target: 0.05, min: 0.02, max: 0.15 },
      eq:  { target: 0.80, min: 0.65, max: 0.90 },
      fi:  { target: 0.15, min: 0.05, max: 0.30 },
    },
  },
} as const

type PresetKey = 'conservative' | 'balanced' | 'growth' | 'custom'

const SLEEVE_META: Array<{ id: 'liq' | 'eq' | 'fi'; name: string; color: string }> = [
  { id: 'liq', name: 'Liquidity (Cash)', color: 'var(--sidebar-bg)' },
  { id: 'eq',  name: 'Equities (NGX)',   color: 'var(--gold)' },
  { id: 'fi',  name: 'Fixed Income',     color: 'var(--pos)' },
]

interface Client {
  id: string
  code: string
  name: string
}

function pctToStr(v: number): string {
  return (v * 100).toFixed(2).replace(/\.?0+$/, '') || '0'
}
function strToPct(s: string): number {
  const n = Number(s)
  if (isNaN(n)) return 0
  return n / 100
}
function nextLetter(used: string[]): string {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
  for (const L of letters) if (!used.includes(L)) return L
  return 'A'
}

function NewPortfolioInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const preselectedClientId = searchParams.get('client') || ''

  const [clients, setClients] = useState<Client[]>([])
  const [clientId, setClientId] = useState(preselectedClientId)
  const [existingLabels, setExistingLabels] = useState<string[]>([])
  const [label, setLabel] = useState('A')
  const [name, setName] = useState('Portfolio A')
  const [nameEditedManually, setNameEditedManually] = useState(false)
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10))
  const [startingNav, setStartingNav] = useState('')
  const [notes, setNotes] = useState('')

  const [preset, setPreset] = useState<PresetKey>('balanced')
  const [mandate, setMandate] = useState(() => {
    const b = MANDATE_PRESETS.balanced
    return {
      income_target: pctToStr(b.income_target),
      cap_target: pctToStr(b.cap_target),
      liq_min: pctToStr(b.liq_min),
      dd_alert: pctToStr(b.dd_alert),
      dd_action: pctToStr(b.dd_action),
      max_eq_single: pctToStr(b.max_eq_single),
      max_eq_sleeve: pctToStr(b.max_eq_sleeve),
    }
  })
  const [sleeves, setSleeves] = useState(() => {
    const b = MANDATE_PRESETS.balanced.sleeves
    return {
      liq: { target: pctToStr(b.liq.target), min: pctToStr(b.liq.min), max: pctToStr(b.liq.max) },
      eq:  { target: pctToStr(b.eq.target),  min: pctToStr(b.eq.min),  max: pctToStr(b.eq.max)  },
      fi:  { target: pctToStr(b.fi.target),  min: pctToStr(b.fi.min),  max: pctToStr(b.fi.max)  },
    }
  })

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    supabase
      .from('clients')
      .select('id, code, name')
      .eq('status', 'active')
      .order('name')
      .then(({ data }) => {
        if (data) setClients(data as Client[])
      })
  }, [])

  useEffect(() => {
    if (!clientId) {
      setExistingLabels([])
      return
    }
    supabase
      .from('portfolios')
      .select('label')
      .eq('client_id', clientId)
      .eq('status', 'active')
      .then(({ data }) => {
        const used = (data ?? []).map((p: any) => p.label).filter(Boolean)
        setExistingLabels(used)
        const next = nextLetter(used)
        setLabel(next)
        if (!nameEditedManually) {
          setName(`Portfolio ${next}`)
        }
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clientId])

  function handleLabelChange(val: string) {
    const upper = val.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2)
    const prevAutoName = `Portfolio ${label}`
    setLabel(upper)
    if (!nameEditedManually && name === prevAutoName) {
      setName(`Portfolio ${upper}`)
    }
  }

  function handleNameChange(val: string) {
    setName(val)
    setNameEditedManually(true)
  }

  function applyPreset(key: PresetKey) {
    setPreset(key)
    if (key === 'custom') return
    const p = MANDATE_PRESETS[key]
    setMandate({
      income_target: pctToStr(p.income_target),
      cap_target: pctToStr(p.cap_target),
      liq_min: pctToStr(p.liq_min),
      dd_alert: pctToStr(p.dd_alert),
      dd_action: pctToStr(p.dd_action),
      max_eq_single: pctToStr(p.max_eq_single),
      max_eq_sleeve: pctToStr(p.max_eq_sleeve),
    })
    setSleeves({
      liq: { target: pctToStr(p.sleeves.liq.target), min: pctToStr(p.sleeves.liq.min), max: pctToStr(p.sleeves.liq.max) },
      eq:  { target: pctToStr(p.sleeves.eq.target),  min: pctToStr(p.sleeves.eq.min),  max: pctToStr(p.sleeves.eq.max)  },
      fi:  { target: pctToStr(p.sleeves.fi.target),  min: pctToStr(p.sleeves.fi.min),  max: pctToStr(p.sleeves.fi.max)  },
    })
  }

  function updateMandate(field: keyof typeof mandate, val: string) {
    setMandate(m => ({ ...m, [field]: val }))
    if (preset !== 'custom') setPreset('custom')
  }
  function updateSleeve(
    sleeveId: 'liq' | 'eq' | 'fi',
    field: 'target' | 'min' | 'max',
    val: string,
  ) {
    setSleeves(s => ({ ...s, [sleeveId]: { ...s[sleeveId], [field]: val } }))
    if (preset !== 'custom') setPreset('custom')
  }

  // Live validation — v19d preserved exactly
  const sleeveSum =
    strToPct(sleeves.liq.target) + strToPct(sleeves.eq.target) + strToPct(sleeves.fi.target)
  const sleeveSumPct = sleeveSum * 100
  const sumValid = Math.abs(sleeveSumPct - 100) < 0.01

  const navIsEmpty = startingNav.trim() === ''
  const navNum = navIsEmpty ? 0 : Number(startingNav)
  const navValid = !isNaN(navNum) && navNum >= 0

  const labelConflict = existingLabels.includes(label)

  const canSubmit =
    !!clientId && !!label && !!name.trim() && navValid && sumValid && !labelConflict && !saving

  const missingReasons: string[] = []
  if (!clientId) missingReasons.push('select a client')
  if (!label.trim()) missingReasons.push('enter a label')
  else if (labelConflict) missingReasons.push(`label "${label}" already used for this client`)
  if (!name.trim()) missingReasons.push('enter a portfolio name')
  if (!navValid) missingReasons.push('starting NAV must be 0 or positive')
  if (!sumValid) missingReasons.push(`sleeve targets must sum to 100% (now ${sleeveSumPct.toFixed(1)}%)`)

  async function handleSubmit() {
    setError('')
    if (!clientId) return setError('Please select a client')
    if (!label) return setError('Label is required')
    if (labelConflict) return setError(`Label "${label}" is already used for this client`)
    if (!name.trim()) return setError('Name is required')
    if (!navValid) return setError('Starting NAV must be 0 or a positive number')
    if (!sumValid) {
      return setError(
        `Sleeve targets must sum to 100% (currently ${sleeveSumPct.toFixed(2)}%)`,
      )
    }

    setSaving(true)
    try {
      const body = {
        client_id: clientId,
        label,
        name: name.trim(),
        currency: 'NGN',
        starting_nav: navNum,
        start_date: startDate,
        income_target: strToPct(mandate.income_target),
        cap_target: strToPct(mandate.cap_target),
        liq_min: strToPct(mandate.liq_min),
        dd_alert: strToPct(mandate.dd_alert),
        dd_action: strToPct(mandate.dd_action),
        max_eq_single: strToPct(mandate.max_eq_single),
        max_eq_sleeve: strToPct(mandate.max_eq_sleeve),
        notes: notes.trim() || null,
        sleeves: SLEEVE_META.map((m, idx) => ({
          sleeve_id: m.id,
          name: m.name,
          target_pct: strToPct(sleeves[m.id].target),
          min_pct: strToPct(sleeves[m.id].min),
          max_pct: strToPct(sleeves[m.id].max),
          sort_order: idx + 1,
        })),
      }
      const res = await fetch('/api/portfolios', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        setError(data.error || 'Failed to create portfolio')
        setSaving(false)
        return
      }
      router.push(`/portfolio/${data.portfolio.id}`)
    } catch (e) {
      setError((e as Error).message)
      setSaving(false)
    }
  }

  const selectedClient = clients.find(c => c.id === clientId)

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
            New portfolio
          </h1>
          <p style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 8 }}>
            Configure mandate parameters and sleeve targets. The form will also seed an initial
            NAV log entry for IRR baselining.
          </p>
        </div>
      </div>

      <div style={{ maxWidth: 880, display: 'flex', flexDirection: 'column', gap: 14 }}>

        {/* ── Section 1: Client & basics ──────────────────── */}
        <div className="panel">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18, paddingBottom: 14, borderBottom: '1px solid var(--border-soft)' }}>
            <div
              style={{
                width: 36, height: 36, borderRadius: 4,
                background: 'var(--gold-soft)',
                border: '1px solid rgba(176, 139, 62, 0.25)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <BarChart3 size={16} style={{ color: 'var(--gold)' }} />
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>Portfolio basics</div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                Which client, portfolio name, start date, capital deployed
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
            <div style={{ gridColumn: 'span 2' }}>
              <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>Client</label>
              <select
                value={clientId}
                onChange={e => setClientId(e.target.value)}
                className="select-h"
              >
                <option value="">— Select a client —</option>
                {clients.map(c => (
                  <option key={c.id} value={c.id}>{c.code} · {c.name}</option>
                ))}
              </select>
              {clientId && existingLabels.length > 0 && (
                <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-3)' }}>
                  Existing portfolios for this client:{' '}
                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-2)' }}>
                    {existingLabels.join(', ')}
                  </span>
                </div>
              )}
              {clients.length === 0 && (
                <div style={{ marginTop: 6, fontSize: 11, color: 'var(--warn)' }}>
                  No active clients yet.{' '}
                  <Link href="/admin/clients/new" style={{ textDecoration: 'underline', color: 'var(--warn)' }}>
                    Create one first
                  </Link>
                  .
                </div>
              )}
            </div>

            <div>
              <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>Label</label>
              <input
                type="text"
                value={label}
                onChange={e => handleLabelChange(e.target.value)}
                maxLength={2}
                className="input-h input-h-mono"
                style={{ textTransform: 'uppercase' }}
              />
              <div style={{ marginTop: 6, fontSize: 11, minHeight: 14 }}>
                {labelConflict ? (
                  <span style={{ color: 'var(--neg)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <AlertCircle size={10} /> Already used for this client
                  </span>
                ) : (
                  <span style={{ color: 'var(--text-3)' }}>Single letter (A, B, C…)</span>
                )}
              </div>
            </div>

            <div>
              <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>Name</label>
              <input
                type="text"
                value={name}
                onChange={e => handleNameChange(e.target.value)}
                className="input-h"
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>Start date</label>
              <input
                type="date"
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
                max={new Date().toISOString().slice(0, 10)}
                className="input-h input-h-mono"
              />
            </div>

            <div>
              <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>
                Starting NAV (₦) <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>— optional</span>
              </label>
              <input
                type="number"
                value={startingNav}
                onChange={e => setStartingNav(e.target.value)}
                placeholder="Leave blank to build from transactions"
                min="0"
                step="0.01"
                className="input-h input-h-mono"
              />
              <div style={{ marginTop: 6, fontSize: 11, minHeight: 14 }}>
                {!navValid ? (
                  <span style={{ color: 'var(--neg)' }}>Must be 0 or a positive number</span>
                ) : navIsEmpty || navNum === 0 ? (
                  <span style={{ color: 'var(--text-3)' }}>
                    Built from transaction history — initial NAV seeded as ₦0
                  </span>
                ) : (
                  <span style={{ color: 'var(--text-3)' }}>
                    ₦{navNum.toLocaleString('en-NG', { maximumFractionDigits: 2 })}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ── Section 2: Mandate preset selector ──────────── */}
        <div className="panel">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 18, paddingBottom: 14, borderBottom: '1px solid var(--border-soft)' }}>
            <div
              style={{
                width: 36, height: 36, borderRadius: 4,
                background: 'rgba(45, 110, 78, 0.1)',
                border: '1px solid rgba(45, 110, 78, 0.25)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                flexShrink: 0,
              }}
            >
              <Briefcase size={16} style={{ color: 'var(--pos)' }} />
            </div>
            <div>
              <div style={{ fontSize: 13, fontWeight: 500, color: 'var(--text)' }}>Mandate style</div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                Pick a preset to pre-fill thresholds and sleeves, then fine-tune below
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10 }}>
            <PresetCard
              active={preset === 'conservative'}
              onClick={() => applyPreset('conservative')}
              icon={<Shield size={14} />}
              color="var(--sidebar-bg)"
              label="Conservative"
              description="Income-focused, low volatility"
            />
            <PresetCard
              active={preset === 'balanced'}
              onClick={() => applyPreset('balanced')}
              icon={<Briefcase size={14} />}
              color="var(--pos)"
              label="Balanced"
              description="Income + growth mix"
            />
            <PresetCard
              active={preset === 'growth'}
              onClick={() => applyPreset('growth')}
              icon={<TrendingUp size={14} />}
              color="var(--gold)"
              label="Growth"
              description="Capital appreciation"
            />
            <PresetCard
              active={preset === 'custom'}
              onClick={() => applyPreset('custom')}
              icon={<Settings2 size={14} />}
              color="var(--warn)"
              label="Custom"
              description="Set everything manually"
            />
          </div>
        </div>

        {/* ── Section 3: Mandate thresholds ───────────────── */}
        <div className="panel">
          <div className="panel-header">
            <div>
              <div className="panel-title">Mandate thresholds</div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
                All values in percent. Drawdown thresholds are negative.
              </div>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 16 }}>
            <MandateField
              label="Income target"
              hint="Annual yield from dividends + coupons"
              value={mandate.income_target}
              onChange={v => updateMandate('income_target', v)}
            />
            <MandateField
              label="Capital appreciation target"
              hint="Annual price-return target"
              value={mandate.cap_target}
              onChange={v => updateMandate('cap_target', v)}
            />
            <MandateField
              label="Minimum liquidity"
              hint="Floor for cash sleeve"
              value={mandate.liq_min}
              onChange={v => updateMandate('liq_min', v)}
            />
            <MandateField
              label="Max single equity"
              hint="Largest allowed concentration in one stock"
              value={mandate.max_eq_single}
              onChange={v => updateMandate('max_eq_single', v)}
            />
            <MandateField
              label="Max equity sleeve"
              hint="Ceiling for equities as % of NAV"
              value={mandate.max_eq_sleeve}
              onChange={v => updateMandate('max_eq_sleeve', v)}
            />
            <div />
            <MandateField
              label="Drawdown alert"
              hint="Warn when peak-to-trough falls past this (negative)"
              value={mandate.dd_alert}
              onChange={v => updateMandate('dd_alert', v)}
              allowNegative
            />
            <MandateField
              label="Drawdown action"
              hint="Mandate-level intervention trigger (negative)"
              value={mandate.dd_action}
              onChange={v => updateMandate('dd_action', v)}
              allowNegative
            />
          </div>
        </div>

        {/* ── Section 4: Sleeve targets ───────────────────── */}
        <div className="panel">
          <div className="panel-header">
            <div>
              <div className="panel-title">Sleeve allocation</div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
                Target / min / max as % of NAV. Targets must sum to 100%.
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 10, textTransform: 'uppercase' as const, letterSpacing: '0.14em', color: 'var(--text-3)', fontWeight: 600 }}>
                Target sum
              </div>
              <div
                className="hybrid-serif"
                style={{
                  fontSize: 22,
                  fontWeight: 500,
                  color: sumValid ? 'var(--pos)' : 'var(--neg)',
                  fontFamily: 'var(--font-mono)',
                  lineHeight: 1,
                  marginTop: 4,
                }}
              >
                {sleeveSumPct.toFixed(2)}%
                {sumValid && <CheckCircle2 size={14} style={{ display: 'inline', marginLeft: 5, verticalAlign: 'middle' }} />}
              </div>
            </div>
          </div>

          {!sumValid && (
            <div className="alert-h alert-h-critical" style={{ fontSize: 11, marginBottom: 12 }}>
              <AlertCircle size={11} style={{ flexShrink: 0, marginTop: 1 }} />
              <span>Targets must sum to 100%. Adjust values or click a preset above to reset.</span>
            </div>
          )}

          <table className="h-table" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>Sleeve</th>
                <th className="num">Target %</th>
                <th className="num">Min %</th>
                <th className="num">Max %</th>
              </tr>
            </thead>
            <tbody>
              {SLEEVE_META.map(m => (
                <tr key={m.id}>
                  <td>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span
                        style={{
                          width: 10, height: 10, borderRadius: '50%',
                          display: 'inline-block', flexShrink: 0,
                          background: m.color,
                        }}
                      />
                      <div>
                        <div style={{ fontSize: 13, color: 'var(--text)' }}>{m.name}</div>
                        <div style={{ fontSize: 10, color: 'var(--text-3)', fontFamily: 'var(--font-mono)', textTransform: 'uppercase' as const }}>
                          {m.id}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="num">
                    <SleeveInput
                      value={sleeves[m.id].target}
                      onChange={v => updateSleeve(m.id, 'target', v)}
                    />
                  </td>
                  <td className="num">
                    <SleeveInput
                      value={sleeves[m.id].min}
                      onChange={v => updateSleeve(m.id, 'min', v)}
                    />
                  </td>
                  <td className="num">
                    <SleeveInput
                      value={sleeves[m.id].max}
                      onChange={v => updateSleeve(m.id, 'max', v)}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* ── Section 5: Notes ────────────────────────────── */}
        <div className="panel">
          <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>
            Notes (optional)
          </label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            rows={3}
            placeholder="Any context on this mandate — source of funds, restrictions, expected cash flows…"
            className="textarea-h"
          />
        </div>

        {/* ── Submit bar ─────────────────────────────────── */}
        {error && (
          <div className="alert-h alert-h-critical" style={{ fontSize: 12 }}>
            <AlertCircle size={12} style={{ flexShrink: 0, marginTop: 1 }} />
            <span>{error}</span>
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="btn-h btn-h-primary"
            style={{ padding: '9px 20px' }}
          >
            <Save size={13} /> {saving ? 'Creating portfolio…' : 'Create portfolio'}
          </button>
          <Link href="/admin" className="btn-h" style={{ textDecoration: 'none' }}>
            Cancel
          </Link>
          {selectedClient && (
            <div style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--text-3)' }}>
              Creating{' '}
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-2)' }}>
                {selectedClient.code}-{label}
              </span>{' '}
              for <span style={{ color: 'var(--text)' }}>{selectedClient.name}</span>
            </div>
          )}
        </div>

        {/* v19d: missing-requirements hint */}
        {!canSubmit && !saving && missingReasons.length > 0 && (
          <div style={{ fontSize: 11, color: 'var(--warn)', display: 'flex', alignItems: 'flex-start', gap: 6, lineHeight: 1.6 }}>
            <AlertCircle size={11} style={{ marginTop: 2, flexShrink: 0 }} />
            <span>Before creating: {missingReasons.join(' · ')}</span>
          </div>
        )}

        <div style={{ fontSize: 11, color: 'var(--text-3)', display: 'flex', alignItems: 'flex-start', gap: 6, lineHeight: 1.6 }}>
          <Info size={11} style={{ marginTop: 2, flexShrink: 0 }} />
          <span>
            On save we write three things: the portfolio row, three sleeve_targets rows, and an
            initial nav_log row at the start date so IRR calculations have a baseline. Holdings
            stay empty — use Import transactions to load trade history.
          </span>
        </div>
      </div>
    </main>
  )
}

function PresetCard({
  active, onClick, icon, color, label, description,
}: {
  active: boolean
  onClick: () => void
  icon: React.ReactNode
  color: string
  label: string
  description: string
}) {
  return (
    <button
      onClick={onClick}
      style={{
        textAlign: 'left' as const,
        padding: 14,
        borderRadius: 4,
        border: active ? `1.5px solid ${color}` : '1px solid var(--border-soft)',
        background: active ? 'var(--bg-soft)' : 'var(--card)',
        cursor: 'pointer',
        transition: 'all 0.15s',
        fontFamily: 'var(--font-sans)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <div
          style={{
            width: 26, height: 26, borderRadius: 3,
            background: color === 'var(--sidebar-bg)' ? 'rgba(10, 31, 58, 0.1)' : `${color}22`,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0,
            color,
          }}
        >
          {icon}
        </div>
        <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>{label}</div>
        {active && <CheckCircle2 size={12} style={{ marginLeft: 'auto', color }} />}
      </div>
      <div style={{ fontSize: 10, color: 'var(--text-3)', lineHeight: 1.4 }}>{description}</div>
    </button>
  )
}

function MandateField({
  label, hint, value, onChange, allowNegative = false,
}: {
  label: string
  hint: string
  value: string
  onChange: (v: string) => void
  allowNegative?: boolean
}) {
  return (
    <div>
      <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>{label}</label>
      <div style={{ position: 'relative' }}>
        <input
          type="number"
          value={value}
          onChange={e => onChange(e.target.value)}
          step="0.01"
          min={allowNegative ? undefined : '0'}
          className="input-h input-h-mono"
          style={{ paddingRight: 28 }}
        />
        <span
          style={{
            position: 'absolute',
            right: 10,
            top: '50%',
            transform: 'translateY(-50%)',
            color: 'var(--text-3)',
            fontSize: 11,
            fontFamily: 'var(--font-mono)',
            pointerEvents: 'none',
          }}
        >
          %
        </span>
      </div>
      <div style={{ marginTop: 4, fontSize: 10, color: 'var(--text-3)' }}>{hint}</div>
    </div>
  )
}

function SleeveInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div style={{ position: 'relative', display: 'inline-block' }}>
      <input
        type="number"
        value={value}
        onChange={e => onChange(e.target.value)}
        step="0.01"
        min="0"
        max="100"
        className="input-h input-h-sm input-h-mono"
        style={{ textAlign: 'right', paddingRight: 22, width: 96 }}
      />
      <span
        style={{
          position: 'absolute',
          right: 8,
          top: '50%',
          transform: 'translateY(-50%)',
          color: 'var(--text-3)',
          fontSize: 10,
          fontFamily: 'var(--font-mono)',
          pointerEvents: 'none',
        }}
      >
        %
      </span>
    </div>
  )
}

export default function NewPortfolioPage() {
  return (
    <Suspense
      fallback={
        <div className="hybrid-page" style={{ padding: 32, fontSize: 13, color: 'var(--text-3)' }}>
          Loading…
        </div>
      }
    >
      <NewPortfolioInner />
    </Suspense>
  )
}
