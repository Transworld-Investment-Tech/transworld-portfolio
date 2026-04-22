'use client'
import { useEffect, useState, Suspense } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import {
  ArrowLeft, Save, AlertCircle, Info, Shield,
  Briefcase, TrendingUp, Settings2, BarChart3, CheckCircle2,
} from 'lucide-react'

// v18: portfolio creation form.
// v19d: starting NAV can be 0 or blank — the portfolio can be built up via
//       TRANSFER_IN transactions instead of deploying capital up-front.
//
// The form writes three things atomically via POST /api/portfolios:
//   1. `portfolios` row
//   2. Three `sleeve_targets` rows (liq / eq / fi)
//   3. An initial `nav_log` row at `start_date` with `nav_value = starting_nav`
//      (starting_nav may be 0; IRR math handles it — the −0 cash flow at t=0
//      is a no-op and TRANSFER_IN events carry the real capital flows.)

// ─── Preset definitions ─────────────────────────────────────────────
const MANDATE_PRESETS = {
  conservative: {
    label: 'Conservative',
    description: 'Income-focused. Low volatility tolerance.',
    income_target: 0.12,
    cap_target: 0.08,
    liq_min: 0.10,
    dd_alert: -0.05,
    dd_action: -0.08,
    max_eq_single: 0.07,
    max_eq_sleeve: 0.35,
    sleeves: {
      liq: { target: 0.15, min: 0.10, max: 0.25 },
      eq:  { target: 0.25, min: 0.15, max: 0.35 },
      fi:  { target: 0.60, min: 0.50, max: 0.75 },
    },
  },
  balanced: {
    label: 'Balanced',
    description: 'Mix of income and capital growth.',
    income_target: 0.10,
    cap_target: 0.15,
    liq_min: 0.05,
    dd_alert: -0.10,
    dd_action: -0.15,
    max_eq_single: 0.10,
    max_eq_sleeve: 0.60,
    sleeves: {
      liq: { target: 0.10, min: 0.05, max: 0.20 },
      eq:  { target: 0.60, min: 0.45, max: 0.70 },
      fi:  { target: 0.30, min: 0.20, max: 0.45 },
    },
  },
  growth: {
    label: 'Growth',
    description: 'Capital appreciation. Higher volatility.',
    income_target: 0.08,
    cap_target: 0.22,
    liq_min: 0.03,
    dd_alert: -0.15,
    dd_action: -0.20,
    max_eq_single: 0.15,
    max_eq_sleeve: 0.80,
    sleeves: {
      liq: { target: 0.05, min: 0.02, max: 0.15 },
      eq:  { target: 0.80, min: 0.65, max: 0.90 },
      fi:  { target: 0.15, min: 0.05, max: 0.30 },
    },
  },
} as const

type PresetKey = 'conservative' | 'balanced' | 'growth' | 'custom'

const SLEEVE_META: Array<{ id: 'liq' | 'eq' | 'fi'; name: string; color: string }> = [
  { id: 'liq', name: 'Liquidity (Cash)', color: '#8a91a8' },
  { id: 'eq',  name: 'Equities (NGX)',   color: '#60a5fa' },
  { id: 'fi',  name: 'Fixed Income',     color: '#2dd4bf' },
]

interface Client {
  id: string
  code: string
  name: string
}

// ─── Helpers ────────────────────────────────────────────────────────
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

// ─── Main component ─────────────────────────────────────────────────
function NewPortfolioInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const preselectedClientId = searchParams.get('client') || ''

  // ─── Client selection & basics ───
  const [clients, setClients] = useState<Client[]>([])
  const [clientId, setClientId] = useState(preselectedClientId)
  const [existingLabels, setExistingLabels] = useState<string[]>([])
  const [label, setLabel] = useState('A')
  const [name, setName] = useState('Portfolio A')
  const [nameEditedManually, setNameEditedManually] = useState(false)
  const [startDate, setStartDate] = useState(new Date().toISOString().slice(0, 10))
  const [startingNav, setStartingNav] = useState('')
  const [notes, setNotes] = useState('')

  // ─── Preset + mandate state ───
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

  // ─── Load active clients ───
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

  // ─── On client change: fetch existing labels, auto-suggest next letter ───
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

  // ─── Preset helpers ───
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

  // ─── Live validation ───
  const sleeveSum =
    strToPct(sleeves.liq.target) + strToPct(sleeves.eq.target) + strToPct(sleeves.fi.target)
  const sleeveSumPct = sleeveSum * 100
  const sumValid = Math.abs(sleeveSumPct - 100) < 0.01

  // v19d: NAV is optional. Empty string → 0 (portfolio built from transactions).
  //       Any non-negative number is valid. Negatives and non-numeric are not.
  const navIsEmpty = startingNav.trim() === ''
  const navNum = navIsEmpty ? 0 : Number(startingNav)
  const navValid = !isNaN(navNum) && navNum >= 0

  const labelConflict = existingLabels.includes(label)

  const canSubmit =
    !!clientId && !!label && !!name.trim() && navValid && sumValid && !labelConflict && !saving

  // v19d: surface a friendly "here's what's still missing" hint when the button
  // is disabled, so users don't have to guess why. This would have saved the
  // debug session where "Create portfolio" sat greyed out with no explanation.
  const missingReasons: string[] = []
  if (!clientId) missingReasons.push('select a client')
  if (!label.trim()) missingReasons.push('enter a label')
  else if (labelConflict) missingReasons.push(`label "${label}" already used for this client`)
  if (!name.trim()) missingReasons.push('enter a portfolio name')
  if (!navValid) missingReasons.push('starting NAV must be 0 or positive')
  if (!sumValid) missingReasons.push(`sleeve targets must sum to 100% (now ${sleeveSumPct.toFixed(1)}%)`)

  // ─── Submit ───
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
        starting_nav: navNum,   // 0 is allowed; API will seed nav_log with nav_value=0
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

  // ─── Render ─────────────────────────────────────────────────────
  const selectedClient = clients.find(c => c.id === clientId)

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
          <h1 className="text-xl font-semibold">New portfolio</h1>
        </div>
        <p className="text-xs text-[#555d72] mt-2">
          Configure mandate parameters and sleeve targets. The form will also seed an initial
          NAV log entry for IRR baselining.
        </p>
      </div>

      <div className="px-8 py-6 max-w-4xl">
        {/* ── Section 1: Client & basics ─────────────────────── */}
        <div className="tw-card mb-4">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-9 h-9 rounded-xl bg-[#a78bfa]/10 border border-[#a78bfa]/20 flex items-center justify-center flex-shrink-0">
              <BarChart3 size={16} className="text-[#a78bfa]" />
            </div>
            <div>
              <div className="text-sm font-semibold">Portfolio basics</div>
              <div className="text-[11px] text-[#555d72]">
                Which client, portfolio name, start date, capital deployed
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="col-span-2">
              <label className="block text-xs text-[#8a91a8] mb-1.5">Client</label>
              <select
                value={clientId}
                onChange={e => setClientId(e.target.value)}
                className="tw-select">
                <option value="">— Select a client —</option>
                {clients.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.code} · {c.name}
                  </option>
                ))}
              </select>
              {clientId && existingLabels.length > 0 && (
                <div className="mt-1.5 text-[11px] text-[#555d72]">
                  Existing portfolios for this client:{' '}
                  <span className="font-mono text-[#8a91a8]">
                    {existingLabels.join(', ')}
                  </span>
                </div>
              )}
              {clients.length === 0 && (
                <div className="mt-1.5 text-[11px] text-[#eab308]">
                  No active clients yet.{' '}
                  <Link href="/admin/clients/new" className="underline hover:text-[#e8eaf0]">
                    Create one first
                  </Link>
                  .
                </div>
              )}
            </div>

            <div>
              <label className="block text-xs text-[#8a91a8] mb-1.5">Label</label>
              <input
                type="text"
                value={label}
                onChange={e => handleLabelChange(e.target.value)}
                maxLength={2}
                className="tw-input font-mono uppercase"
              />
              <div className="mt-1.5 text-[11px] min-h-[14px]">
                {labelConflict ? (
                  <span className="text-[#ef4444] inline-flex items-center gap-1">
                    <AlertCircle size={10} /> Already used for this client
                  </span>
                ) : (
                  <span className="text-[#555d72]">Single letter (A, B, C…)</span>
                )}
              </div>
            </div>

            <div>
              <label className="block text-xs text-[#8a91a8] mb-1.5">Name</label>
              <input
                type="text"
                value={name}
                onChange={e => handleNameChange(e.target.value)}
                className="tw-input"
              />
            </div>

            <div>
              <label className="block text-xs text-[#8a91a8] mb-1.5">Start date</label>
              <input
                type="date"
                value={startDate}
                onChange={e => setStartDate(e.target.value)}
                max={new Date().toISOString().slice(0, 10)}
                className="tw-input font-mono"
              />
            </div>

            <div>
              <label className="block text-xs text-[#8a91a8] mb-1.5">
                Starting NAV (₦) <span className="text-[#555d72] font-normal">— optional</span>
              </label>
              <input
                type="number"
                value={startingNav}
                onChange={e => setStartingNav(e.target.value)}
                placeholder="Leave blank to build from transactions"
                min="0"
                step="0.01"
                className="tw-input font-mono"
              />
              {/* v19d: context-aware helper text */}
              <div className="mt-1.5 text-[11px] min-h-[14px]">
                {!navValid ? (
                  <span className="text-[#ef4444]">Must be 0 or a positive number</span>
                ) : navIsEmpty || navNum === 0 ? (
                  <span className="text-[#555d72]">
                    Built from transaction history — initial NAV seeded as ₦0
                  </span>
                ) : (
                  <span className="text-[#555d72]">
                    ₦{navNum.toLocaleString('en-NG', { maximumFractionDigits: 2 })}
                  </span>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* ── Section 2: Mandate preset selector ─────────────── */}
        <div className="tw-card mb-4">
          <div className="flex items-center gap-3 mb-5">
            <div className="w-9 h-9 rounded-xl bg-[#2dd4bf]/10 border border-[#2dd4bf]/20 flex items-center justify-center flex-shrink-0">
              <Briefcase size={16} className="text-[#2dd4bf]" />
            </div>
            <div>
              <div className="text-sm font-semibold">Mandate style</div>
              <div className="text-[11px] text-[#555d72]">
                Pick a preset to pre-fill thresholds and sleeves, then fine-tune below
              </div>
            </div>
          </div>

          <div className="grid grid-cols-4 gap-3">
            <PresetCard
              active={preset === 'conservative'}
              onClick={() => applyPreset('conservative')}
              icon={<Shield size={15} />}
              color="#60a5fa"
              label="Conservative"
              description="Income-focused, low volatility"
            />
            <PresetCard
              active={preset === 'balanced'}
              onClick={() => applyPreset('balanced')}
              icon={<Briefcase size={15} />}
              color="#2dd4bf"
              label="Balanced"
              description="Income + growth mix"
            />
            <PresetCard
              active={preset === 'growth'}
              onClick={() => applyPreset('growth')}
              icon={<TrendingUp size={15} />}
              color="#22c55e"
              label="Growth"
              description="Capital appreciation"
            />
            <PresetCard
              active={preset === 'custom'}
              onClick={() => applyPreset('custom')}
              icon={<Settings2 size={15} />}
              color="#a78bfa"
              label="Custom"
              description="Set everything manually"
            />
          </div>
        </div>

        {/* ── Section 3: Mandate thresholds ──────────────────── */}
        <div className="tw-card mb-4">
          <div className="mb-4">
            <div className="text-sm font-semibold mb-1">Mandate thresholds</div>
            <div className="text-[11px] text-[#555d72]">
              All values in percent. Drawdown thresholds are negative.
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
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

        {/* ── Section 4: Sleeve targets ──────────────────────── */}
        <div className="tw-card mb-4">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="text-sm font-semibold mb-1">Sleeve allocation</div>
              <div className="text-[11px] text-[#555d72]">
                Target / min / max as % of NAV. Targets must sum to 100%.
              </div>
            </div>
            <div className="text-right">
              <div className="text-[10px] uppercase tracking-widest text-[#555d72]">
                Target sum
              </div>
              <div
                className={`text-lg font-mono font-semibold ${
                  sumValid ? 'text-[#22c55e]' : 'text-[#ef4444]'
                }`}>
                {sleeveSumPct.toFixed(2)}%
                {sumValid && <CheckCircle2 size={14} className="inline ml-1 -mt-0.5" />}
              </div>
            </div>
          </div>

          {!sumValid && (
            <div className="mb-3 text-xs text-[#ef4444] bg-[#ef4444]/10 rounded-lg px-3 py-2 border border-[#ef4444]/20 flex items-center gap-2">
              <AlertCircle size={11} />
              Targets must sum to 100%. Adjust values or click a preset above to reset.
            </div>
          )}

          <table className="tw-table w-full">
            <thead>
              <tr>
                <th>Sleeve</th>
                <th className="text-right">Target %</th>
                <th className="text-right">Min %</th>
                <th className="text-right">Max %</th>
              </tr>
            </thead>
            <tbody>
              {SLEEVE_META.map(m => (
                <tr key={m.id}>
                  <td>
                    <div className="flex items-center gap-2">
                      <span
                        className="w-2.5 h-2.5 rounded-full inline-block flex-shrink-0"
                        style={{ background: m.color }}
                      />
                      <div>
                        <div className="text-sm">{m.name}</div>
                        <div className="text-[10px] text-[#555d72] font-mono uppercase">
                          {m.id}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="text-right">
                    <SleeveInput
                      value={sleeves[m.id].target}
                      onChange={v => updateSleeve(m.id, 'target', v)}
                    />
                  </td>
                  <td className="text-right">
                    <SleeveInput
                      value={sleeves[m.id].min}
                      onChange={v => updateSleeve(m.id, 'min', v)}
                    />
                  </td>
                  <td className="text-right">
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

        {/* ── Section 5: Notes ──────────────────────────────── */}
        <div className="tw-card mb-4">
          <label className="block text-xs text-[#8a91a8] mb-1.5">Notes (optional)</label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            rows={3}
            placeholder="Any context on this mandate — source of funds, restrictions, expected cash flows…"
            className="tw-input resize-none"
          />
        </div>

        {/* ── Submit bar ────────────────────────────────────── */}
        {error && (
          <div className="mb-3 text-xs text-[#ef4444] bg-[#ef4444]/10 rounded-lg px-3 py-2 border border-[#ef4444]/20">
            <AlertCircle size={11} className="inline mr-1 -mt-0.5" />
            {error}
          </div>
        )}

        <div className="flex items-center gap-3">
          <button
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="flex items-center gap-2 bg-[#a78bfa] text-white px-5 py-2.5 rounded-lg text-sm font-medium hover:bg-[#9b87e8] transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
            <Save size={13} /> {saving ? 'Creating portfolio…' : 'Create portfolio'}
          </button>
          <Link
            href="/admin"
            className="px-4 py-2 border border-white/10 rounded-lg text-xs text-[#8a91a8] hover:text-[#e8eaf0] transition-colors">
            Cancel
          </Link>
          {selectedClient && (
            <div className="ml-auto text-[11px] text-[#555d72]">
              Creating{' '}
              <span className="font-mono text-[#8a91a8]">
                {selectedClient.code}-{label}
              </span>{' '}
              for <span className="text-[#e8eaf0]">{selectedClient.name}</span>
            </div>
          )}
        </div>

        {/* v19d: tell the user why the button is greyed out */}
        {!canSubmit && !saving && missingReasons.length > 0 && (
          <div className="mt-3 text-[11px] text-[#eab308] flex items-start gap-2">
            <AlertCircle size={11} className="mt-0.5 flex-shrink-0" />
            <span>
              Before creating: {missingReasons.join(' · ')}
            </span>
          </div>
        )}

        <div className="mt-4 text-[11px] text-[#555d72] flex items-start gap-2">
          <Info size={11} className="mt-0.5 flex-shrink-0" />
          <span>
            On save we write three things: the portfolio row, three sleeve_targets rows, and an
            initial nav_log row at the start date so IRR calculations have a baseline. Holdings
            stay empty — use Import transactions to load trade history.
          </span>
        </div>
      </div>
    </div>
  )
}

// ─── Small presentational components ─────────────────────────────────
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
      className={`text-left p-3 rounded-xl border transition-all ${
        active
          ? 'border-white/25 bg-white/[0.04]'
          : 'border-white/[0.07] bg-[#13161d] hover:border-white/15'
      }`}>
      <div className="flex items-center gap-2 mb-2">
        <div
          className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
          style={{ background: color + '15', color }}>
          {icon}
        </div>
        <div className="text-xs font-semibold">{label}</div>
        {active && <CheckCircle2 size={12} className="ml-auto" style={{ color }} />}
      </div>
      <div className="text-[10px] text-[#555d72] leading-snug">{description}</div>
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
      <label className="block text-xs text-[#8a91a8] mb-1.5">{label}</label>
      <div className="relative">
        <input
          type="number"
          value={value}
          onChange={e => onChange(e.target.value)}
          step="0.01"
          min={allowNegative ? undefined : '0'}
          className="tw-input font-mono pr-8"
        />
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[#555d72] text-xs font-mono pointer-events-none">
          %
        </span>
      </div>
      <div className="mt-1 text-[10px] text-[#555d72]">{hint}</div>
    </div>
  )
}

function SleeveInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="relative inline-block">
      <input
        type="number"
        value={value}
        onChange={e => onChange(e.target.value)}
        step="0.01"
        min="0"
        max="100"
        className="tw-input font-mono text-right pr-7 w-24"
      />
      <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#555d72] text-[10px] font-mono pointer-events-none">
        %
      </span>
    </div>
  )
}

// Suspense wrapper — required by Next 15 for useSearchParams in client components.
export default function NewPortfolioPage() {
  return (
    <Suspense
      fallback={
        <div className="px-8 py-6 text-sm text-[#555d72]">Loading…</div>
      }>
      <NewPortfolioInner />
    </Suspense>
  )
}
