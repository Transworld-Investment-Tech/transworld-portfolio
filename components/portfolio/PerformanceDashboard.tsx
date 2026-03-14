'use client'
import { useState, useEffect, useCallback } from 'react'
import type { PeriodKey } from '@/lib/analytics'

const PERIOD_KEYS: PeriodKey[] = ['1W','1M','3M','6M','1Y','2Y','3Y','5Y','ITD']
const PERIOD_LABELS: Record<PeriodKey, string> = {
  '1W':'1W','1M':'1M','3M':'3M','6M':'6M','1Y':'1Y','2Y':'2Y','3Y':'3Y','5Y':'5Y','ITD':'ITD',
}

function fmtPct(v: number | null, decimals = 1): string {
  if (v === null || v === undefined || isNaN(v)) return '—'
  return (v >= 0 ? '+' : '') + (v * 100).toFixed(decimals) + '%'
}
function fmtPctRaw(v: number | null, decimals = 1): string {
  if (v === null || v === undefined || isNaN(v)) return '—'
  const s = (v * 100).toFixed(decimals) + '%'
  return v >= 0 ? '+' + s : s
}
function ngnM(v: number | null): string {
  if (v === null || v === undefined) return '—'
  const abs = Math.abs(v)
  const s = abs >= 1e6 ? '₦' + (abs / 1e6).toFixed(2) + 'M' : '₦' + abs.toLocaleString('en-NG', { maximumFractionDigits: 0 })
  return (v < 0 ? '−' : '+') + s
}
function colour(v: number | null): string {
  if (v === null || v === undefined) return '#8a91a8'
  return v >= 0 ? '#22c55e' : '#ef4444'
}

function KPI({ label, main, sub, borderColor, note }: { label: string; main: string; sub?: string; borderColor: string; note?: string }) {
  return (
    <div style={{ background: '#13161d', border: '1px solid rgba(255,255,255,0.07)', borderTop: `2px solid ${borderColor}`, borderRadius: 10, padding: '14px 16px' }}>
      <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.08em', color: '#555d72', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 24, fontWeight: 700, fontFamily: 'monospace', lineHeight: 1.15, color: borderColor }}>{main}</div>
      {sub  && <div style={{ fontSize: 10, color: '#8a91a8', marginTop: 5 }}>{sub}</div>}
      {note && <div style={{ fontSize: 9,  color: '#555d72', marginTop: 3, fontStyle: 'italic' }}>{note}</div>}
    </div>
  )
}

export default function PerformanceDashboard({ portfolioId }: { portfolioId: string }) {
  const [period,  setPeriod]  = useState<PeriodKey>('1Y')
  const [data,    setData]    = useState<any>(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState('')

  const load = useCallback(async (p: PeriodKey) => {
    setLoading(true); setError('')
    try {
      const res = await fetch(`/api/analytics?portfolioId=${portfolioId}&period=${p}`)
      if (!res.ok) throw new Error('Analytics request failed')
      setData(await res.json())
    } catch (e) { setError((e as Error).message) }
    finally { setLoading(false) }
  }, [portfolioId])

  useEffect(() => { load(period) }, [period])

  const m: any = data?.period
  const benchmarks: any[] = m?.benchmarks ?? []
  const isShortPeriod = m && m.daysHeld < 365

  return (
    <div style={{ padding: '0 24px 28px' }}>

      {/* ── Period selector ──────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 20, flexWrap: 'wrap' as const }}>
        <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.08em', color: '#555d72', marginRight: 8 }}>
          Performance period
        </span>
        {PERIOD_KEYS.map(p => (
          <button key={p} onClick={() => setPeriod(p)}
            style={{
              padding: '5px 13px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
              border: period === p ? '1px solid #a78bfa60' : '1px solid rgba(255,255,255,0.07)',
              background: period === p ? '#a78bfa18' : 'transparent',
              color: period === p ? '#a78bfa' : '#555d72',
              transition: 'all 0.15s',
            }}>{PERIOD_LABELS[p]}</button>
        ))}
        {m && (
          <span style={{ marginLeft: 'auto', fontSize: 10, color: '#555d72' }}>
            {m.startDate} → {m.endDate} &nbsp;·&nbsp; {m.daysHeld}d &nbsp;·&nbsp; {m.yearsHeld?.toFixed(2)}y
          </span>
        )}
      </div>

      {/* ── Loading ───────────────────────────────────────────── */}
      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '20px 0', color: '#555d72', fontSize: 12 }}>
          <div style={{ width: 14, height: 14, border: '2px solid #555d72', borderTopColor: '#a78bfa', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
          Computing {period} metrics…
          <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
        </div>
      )}
      {error && <div style={{ color: '#ff5c7a', fontSize: 12, padding: '8px 0' }}>Error: {error}</div>}

      {!loading && m && (
        <>
          {/* ── KPI cards ─────────────────────────────────────── */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>

            {/* IRR — always annual by definition */}
            <KPI
              label="IRR (Annual rate, p.a.)"
              main={m.irr !== null ? fmtPct(m.irr) : '—'}
              borderColor={colour(m.irr)}
              sub={m.irr !== null
                ? `From Newton-Raphson with time in years`
                : 'Insufficient NAV data for period'}
              note="Annual rate by definition — not further annualised"
            />

            {/* Simple period return — actual raw return for the period */}
            <KPI
              label={`Period return (${m.periodLabel}, actual)`}
              main={fmtPct(m.simplePeriodReturn)}
              borderColor={colour(m.simplePeriodReturn)}
              sub={isShortPeriod
                ? `Not annualised — raw ${m.daysHeld}d return`
                : `${m.yearsHeld?.toFixed(1)}y compounded return`}
              note={isShortPeriod ? `Annual equiv: ${fmtPct(m.irr)} (see IRR)` : undefined}
            />

            {/* Absolute ₦ P&L */}
            <KPI
              label="Absolute P&L (cash-flow adj.)"
              main={ngnM(m.absoluteReturn)}
              borderColor={colour(m.absoluteReturn)}
              sub={m.startNAV
                ? `₦${(m.startNAV/1e6).toFixed(2)}M → ₦${(m.endNAV/1e6).toFixed(2)}M`
                : `End NAV ₦${(m.endNAV/1e6).toFixed(2)}M`}
              note={m.outflows > 0 ? `Fees/outflows deducted: ₦${(m.outflows/1e6).toFixed(2)}M` : undefined}
            />

            {/* TWR */}
            <KPI
              label="Time-Weighted Return (TWR)"
              main={m.twr !== null ? fmtPct(m.twr) : '—'}
              borderColor={colour(m.twr)}
              sub={m.twrAnnualised !== null
                ? `Annualised: ${fmtPct(m.twrAnnualised)} p.a.`
                : `Actual period return, ${m.daysHeld}d`}
              note="Removes cash-flow timing effect"
            />
          </div>

          {/* ── Benchmark table ───────────────────────────────── */}
          <div style={{ background: '#13161d', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 10, overflow: 'hidden', marginBottom: 16 }}>
            <div style={{ padding: '11px 16px', borderBottom: '1px solid rgba(255,255,255,0.07)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.08em', color: '#555d72' }}>
                Benchmark Comparison — {m.periodLabel} ({m.startDate} to {m.endDate})
              </span>
              <span style={{ fontSize: 9, color: '#555d72' }}>
                Period return = actual un-annualised return for the period · Annual rate = p.a. equivalent
              </span>
            </div>

            <table style={{ width: '100%', borderCollapse: 'collapse' as const }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  {['Benchmark','Type','Period return','Annual rate (p.a.)','vs Portfolio IRR','vs Portfolio TWR','Source'].map((h,i) => (
                    <th key={i} style={{ padding: '8px 14px', textAlign: 'left' as const, fontSize: 9, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.06em', color: '#555d72' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {/* Portfolio row */}
                <tr style={{ background: 'rgba(167,139,250,0.06)', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={{ padding: '10px 14px', fontWeight: 700, fontSize: 12, color: '#a78bfa' }}>This Portfolio</td>
                  <td style={{ padding: '10px 14px' }}>
                    <span style={{ background: '#a78bfa20', color: '#a78bfa', fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 4 }}>Discretionary</span>
                  </td>
                  <td style={{ padding: '10px 14px', fontFamily: 'monospace', fontSize: 13, fontWeight: 700, color: colour(m.simplePeriodReturn) }}>
                    {fmtPctRaw(m.simplePeriodReturn)}
                  </td>
                  <td style={{ padding: '10px 14px', fontFamily: 'monospace', fontSize: 13, fontWeight: 700, color: colour(m.irr) }}>
                    {m.irr !== null ? fmtPctRaw(m.irr) + ' p.a.' : '—'}
                  </td>
                  <td style={{ padding: '10px 14px', color: '#555d72', fontSize: 11 }}>—</td>
                  <td style={{ padding: '10px 14px', color: '#555d72', fontSize: 11 }}>—</td>
                  <td style={{ padding: '10px 14px', fontSize: 10, color: '#555d72' }}>Transworld PI</td>
                </tr>

                {benchmarks.map((b: any) => {
                  const diffIRR = m.irr !== null ? m.irr - b.annualRate : null
                  const diffTWR = m.twr !== null ? m.twr - b.periodReturn : null
                  const tc = b.type === 'equity' ? '#a78bfa' : b.type === 'inflation' ? '#ef4444' : '#22c55e'
                  const tl = b.type === 'equity' ? 'Equity' : b.type === 'inflation' ? 'Inflation' : 'Fixed Income'
                  return (
                    <tr key={b.shortName} style={{ borderBottom: '1px solid rgba(255,255,255,0.03)' }}>
                      <td style={{ padding: '9px 14px' }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: '#e8eaf0' }}>{b.name}</div>
                        {b.note && <div style={{ fontSize: 9, color: '#555d72', marginTop: 1 }}>{b.note}</div>}
                      </td>
                      <td style={{ padding: '9px 14px' }}>
                        <span style={{ background: tc+'20', color: tc, fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 4 }}>{tl}</span>
                      </td>
                      <td style={{ padding: '9px 14px', fontFamily: 'monospace', fontSize: 12, color: colour(b.periodReturn) }}>
                        {fmtPctRaw(b.periodReturn)}
                      </td>
                      <td style={{ padding: '9px 14px', fontFamily: 'monospace', fontSize: 12, color: colour(b.annualRate) }}>
                        {fmtPctRaw(b.annualRate)} p.a.
                      </td>
                      <td style={{ padding: '9px 14px', fontFamily: 'monospace', fontSize: 13, fontWeight: 700, color: colour(diffIRR) }}>
                        {diffIRR !== null ? (diffIRR >= 0 ? '+' : '') + (diffIRR * 100).toFixed(1) + 'pp' : '—'}
                      </td>
                      <td style={{ padding: '9px 14px', fontFamily: 'monospace', fontSize: 13, fontWeight: 700, color: colour(diffTWR) }}>
                        {diffTWR !== null ? (diffTWR >= 0 ? '+' : '') + (diffTWR * 100).toFixed(1) + 'pp' : '—'}
                      </td>
                      <td style={{ padding: '9px 14px', fontSize: 10, color: '#555d72' }}>{b.source}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>

            <div style={{ padding: '8px 14px', borderTop: '1px solid rgba(255,255,255,0.04)', fontSize: 9, color: '#555d72', lineHeight: 1.7 }}>
              <strong style={{ color: '#8a91a8' }}>IRR note:</strong> Computed via Newton-Raphson with time in years — result is an annual rate by definition for any period length. t=0: −startNAV, intermediate: ±TRANSFER_IN/OUT, terminal: +currentNAV. &nbsp;
              <strong style={{ color: '#8a91a8' }}>MWR vs TWR:</strong> IRR/MWR accounts for cash flow timing and size. TWR removes that effect to measure manager skill. &nbsp;
              <strong style={{ color: '#8a91a8' }}>pp</strong> = percentage points outperformance. NGX benchmark data estimated from published annual returns — live index requires market data subscription.
            </div>
          </div>

          {/* ── All periods strip ─────────────────────────────── */}
          {data?.allPeriods && (
            <div>
              <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase' as const, letterSpacing: '0.08em', color: '#555d72', marginBottom: 8 }}>
                All periods — IRR (p.a.) · click to select
              </div>
              <div style={{ display: 'flex', gap: 6 }}>
                {data.allPeriods.map((p: any) => {
                  const v = p.irr ?? p.simplePeriodReturn
                  return (
                    <div key={p.period} onClick={() => setPeriod(p.period)}
                      style={{ flex: 1, background: '#13161d', border: period === p.period ? '1px solid #a78bfa60' : '1px solid rgba(255,255,255,0.07)', borderRadius: 8, padding: '8px 10px', cursor: 'pointer', transition: 'all 0.15s', textAlign: 'center' as const }}>
                      <div style={{ fontSize: 9, color: '#555d72', marginBottom: 4 }}>{p.period}</div>
                      <div style={{ fontSize: 13, fontWeight: 700, fontFamily: 'monospace', color: colour(v) }}>
                        {fmtPctRaw(v, 1)}
                      </div>
                      <div style={{ fontSize: 8, color: '#555d72', marginTop: 2 }}>p.a.</div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
