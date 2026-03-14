'use client'
import { useState, useEffect, useCallback } from 'react'
import type { PeriodKey } from '@/lib/analytics'

const PERIOD_KEYS: PeriodKey[] = ['1W','1M','3M','6M','1Y','2Y','3Y','5Y','ITD']
const PERIOD_LABELS: Record<PeriodKey, string> = {
  '1W':'1W', '1M':'1M', '3M':'3M', '6M':'6M',
  '1Y':'1Y', '2Y':'2Y', '3Y':'3Y', '5Y':'5Y', 'ITD':'ITD',
}

function pct(v: number | null, decimals = 1, sign = true): string {
  if (v === null || v === undefined || isNaN(v)) return '—'
  const s = (v * 100).toFixed(decimals) + '%'
  return sign && v >= 0 ? '+' + s : s
}
function ngnM(v: number | null): string {
  if (v === null || v === undefined) return '—'
  const abs = Math.abs(v)
  const s = abs >= 1e6 ? '₦' + (abs / 1e6).toFixed(2) + 'M' : '₦' + abs.toLocaleString('en-NG', { maximumFractionDigits: 0 })
  return (v < 0 ? '-' : '+') + s
}
function colourClass(v: number | null): string {
  if (v === null || v === undefined) return '#8a91a8'
  return v >= 0 ? '#22c55e' : '#ef4444'
}

export default function PerformanceDashboard({ portfolioId }: { portfolioId: string }) {
  const [period,   setPeriod]   = useState<PeriodKey>('1Y')
  const [data,     setData]     = useState<any>(null)
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState('')

  const load = useCallback(async (p: PeriodKey) => {
    setLoading(true); setError('')
    try {
      const res = await fetch(`/api/analytics?portfolioId=${portfolioId}&period=${p}`)
      if (!res.ok) throw new Error('Failed to load analytics')
      setData(await res.json())
    } catch (e) { setError((e as Error).message) }
    finally { setLoading(false) }
  }, [portfolioId])

  useEffect(() => { load(period) }, [period])

  const m = data?.period
  const benchmarks: any[] = m?.benchmarks ?? []
  const portfolioMwr = m?.mwr ?? m?.simpleReturn ?? null
  const portfolioAnn = m?.annualisedMwr ?? m?.annualisedTwr ?? null

  return (
    <div style={{ padding: '0 24px 24px' }}>

      {/* Period selector */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 20 }}>
        <span style={{ fontSize: 10, color: '#555d72', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.08em', marginRight: 8 }}>Period</span>
        {PERIOD_KEYS.map(p => (
          <button key={p} onClick={() => setPeriod(p)}
            style={{
              padding: '4px 12px', borderRadius: 6, fontSize: 12, fontWeight: 600, cursor: 'pointer',
              border: period === p ? '1px solid #a78bfa60' : '1px solid rgba(255,255,255,0.07)',
              background: period === p ? '#a78bfa18' : 'transparent',
              color: period === p ? '#a78bfa' : '#555d72',
              transition: 'all 0.15s',
            }}>
            {PERIOD_LABELS[p]}
          </button>
        ))}
        {m && (
          <span style={{ marginLeft: 'auto', fontSize: 10, color: '#555d72' }}>
            {m.startDate} → {m.endDate} &nbsp;·&nbsp; {m.daysHeld} days
          </span>
        )}
      </div>

      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '24px 0', color: '#555d72', fontSize: 12 }}>
          <div style={{ width: 14, height: 14, border: '2px solid #555d72', borderTopColor: '#a78bfa', borderRadius: '50%', animation: 'spin 0.8s linear infinite' }} />
          Computing {period} metrics…
          <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
        </div>
      )}

      {error && <div style={{ color: '#ff5c7a', fontSize: 12, padding: '8px 0' }}>Error: {error}</div>}

      {!loading && m && (
        <>
          {/* Top KPI row */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 16 }}>

            {/* MWR (IRR) */}
            <div style={{ background: '#13161d', border: '1px solid rgba(255,255,255,0.07)', borderTop: '2px solid #a78bfa', borderRadius: 10, padding: '14px 16px' }}>
              <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#555d72', marginBottom: 6 }}>
                Money-Weighted Return
              </div>
              <div style={{ fontSize: 26, fontWeight: 700, fontFamily: 'monospace', color: colourClass(m.mwr ?? m.simpleReturn) }}>
                {pct(m.mwr ?? m.simpleReturn)}
              </div>
              <div style={{ fontSize: 10, color: '#555d72', marginTop: 4 }}>
                {m.daysHeld >= 365 && m.annualisedMwr !== null
                  ? `Annualised: ${pct(m.annualisedMwr)}`
                  : 'Period return (IRR-adjusted)'}
              </div>
            </div>

            {/* TWR */}
            <div style={{ background: '#13161d', border: '1px solid rgba(255,255,255,0.07)', borderTop: '2px solid #60a5fa', borderRadius: 10, padding: '14px 16px' }}>
              <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#555d72', marginBottom: 6 }}>
                Time-Weighted Return
              </div>
              <div style={{ fontSize: 26, fontWeight: 700, fontFamily: 'monospace', color: colourClass(m.twr) }}>
                {pct(m.twr)}
              </div>
              <div style={{ fontSize: 10, color: '#555d72', marginTop: 4 }}>
                {m.daysHeld >= 365 && m.annualisedTwr !== null
                  ? `Annualised: ${pct(m.annualisedTwr)}`
                  : 'Linked internal sub-periods'}
              </div>
            </div>

            {/* Absolute return */}
            <div style={{ background: '#13161d', border: '1px solid rgba(255,255,255,0.07)', borderTop: `2px solid ${colourClass(m.absoluteReturn)}`, borderRadius: 10, padding: '14px 16px' }}>
              <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#555d72', marginBottom: 6 }}>
                Absolute P&amp;L
              </div>
              <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'monospace', color: colourClass(m.absoluteReturn), lineHeight: 1.2 }}>
                {ngnM(m.absoluteReturn)}
              </div>
              <div style={{ fontSize: 10, color: '#555d72', marginTop: 4 }}>
                {m.startNAV ? `₦${(m.startNAV/1e6).toFixed(2)}M → ₦${(m.endNAV/1e6).toFixed(2)}M` : `End NAV: ₦${(m.endNAV/1e6).toFixed(2)}M`}
              </div>
            </div>

            {/* Cash flow summary */}
            <div style={{ background: '#13161d', border: '1px solid rgba(255,255,255,0.07)', borderTop: '2px solid #f59e0b', borderRadius: 10, padding: '14px 16px' }}>
              <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#555d72', marginBottom: 6 }}>
                Net External Flows
              </div>
              <div style={{ fontSize: 22, fontWeight: 700, fontFamily: 'monospace', color: '#f59e0b', lineHeight: 1.2 }}>
                {m.netCashFlows === 0 ? '₦0' : ngnM(m.netCashFlows)}
              </div>
              <div style={{ fontSize: 10, color: '#555d72', marginTop: 4 }}>
                {m.inflows > 0 ? `In: ₦${(m.inflows/1e6).toFixed(2)}M` : 'No new inflows'}
                {m.outflows > 0 ? ` · Out: ₦${(m.outflows/1e6).toFixed(2)}M` : ''}
              </div>
            </div>
          </div>

          {/* Benchmark comparison table */}
          <div style={{ background: '#13161d', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 10, overflow: 'hidden' }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <span style={{ fontSize: 10, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#555d72' }}>
                Benchmark Comparison — {m.periodLabel}
              </span>
              <span style={{ fontSize: 10, color: '#555d72' }}>
                {m.daysHeld >= 365 ? 'Annualised returns where ≥1 year' : 'Actual period returns'}
              </span>
            </div>

            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  {['Benchmark', 'Type', 'Period return', m.daysHeld >= 365 ? 'Annualised' : '', 'vs Portfolio (MWR)', 'vs Portfolio (TWR)', 'Source'].map((h, i) =>
                    h ? <th key={i} style={{ padding: '8px 14px', textAlign: 'left', fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.06em', color: '#555d72' }}>{h}</th> : null
                  )}
                </tr>
              </thead>
              <tbody>
                {/* Portfolio row */}
                <tr style={{ background: 'rgba(167,139,250,0.05)', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                  <td style={{ padding: '10px 14px', fontWeight: 700, fontSize: 12, color: '#a78bfa' }}>This Portfolio</td>
                  <td style={{ padding: '10px 14px' }}>
                    <span style={{ background: '#a78bfa20', color: '#a78bfa', fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 4 }}>Discretionary</span>
                  </td>
                  <td style={{ padding: '10px 14px', fontFamily: 'monospace', fontSize: 13, fontWeight: 700, color: colourClass(m.mwr ?? m.simpleReturn) }}>
                    {pct(m.mwr ?? m.simpleReturn)}
                  </td>
                  {m.daysHeld >= 365 && <td style={{ padding: '10px 14px', fontFamily: 'monospace', fontSize: 12, color: colourClass(m.annualisedMwr) }}>
                    {pct(m.annualisedMwr)}
                  </td>}
                  <td style={{ padding: '10px 14px', fontFamily: 'monospace', fontSize: 11, color: '#555d72' }}>—</td>
                  <td style={{ padding: '10px 14px', fontFamily: 'monospace', fontSize: 11, color: '#555d72' }}>—</td>
                  <td style={{ padding: '10px 14px', fontSize: 10, color: '#555d72' }}>Transworld PI</td>
                </tr>

                {benchmarks.map((b: any) => {
                  const portRate  = m.mwr ?? m.simpleReturn ?? 0
                  const portAnn   = m.annualisedMwr ?? m.annualisedTwr ?? portRate
                  const bRate     = m.daysHeld >= 365 ? b.annualisedReturn : b.periodReturn
                  const diffMwr   = portRate - b.periodReturn
                  const diffTwr   = (m.twr ?? portRate) - b.periodReturn
                  const typeColor = b.type === 'equity' ? '#a78bfa' : b.type === 'inflation' ? '#ef4444' : '#22c55e'
                  const typeLabel = b.type === 'equity' ? 'Equity' : b.type === 'inflation' ? 'Inflation' : 'Fixed Income'
                  return (
                    <tr key={b.shortName} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                      <td style={{ padding: '9px 14px' }}>
                        <div style={{ fontSize: 12, fontWeight: 600, color: '#e8eaf0' }}>{b.name}</div>
                        {b.note && <div style={{ fontSize: 9, color: '#555d72', marginTop: 1 }}>{b.note}</div>}
                      </td>
                      <td style={{ padding: '9px 14px' }}>
                        <span style={{ background: typeColor + '20', color: typeColor, fontSize: 9, fontWeight: 700, padding: '2px 7px', borderRadius: 4 }}>{typeLabel}</span>
                      </td>
                      <td style={{ padding: '9px 14px', fontFamily: 'monospace', fontSize: 12, color: colourClass(b.periodReturn) }}>
                        {pct(b.periodReturn)}
                      </td>
                      {m.daysHeld >= 365 && <td style={{ padding: '9px 14px', fontFamily: 'monospace', fontSize: 11, color: colourClass(b.annualisedReturn) }}>
                        {pct(b.annualisedReturn)}
                      </td>}
                      <td style={{ padding: '9px 14px', fontFamily: 'monospace', fontSize: 12, fontWeight: 600, color: colourClass(diffMwr) }}>
                        {diffMwr >= 0 ? '+' : ''}{(diffMwr * 100).toFixed(1)}pp
                      </td>
                      <td style={{ padding: '9px 14px', fontFamily: 'monospace', fontSize: 12, fontWeight: 600, color: colourClass(diffTwr) }}>
                        {diffTwr >= 0 ? '+' : ''}{(diffTwr * 100).toFixed(1)}pp
                      </td>
                      <td style={{ padding: '9px 14px', fontSize: 10, color: '#555d72' }}>{b.source}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>

            <div style={{ padding: '8px 14px', borderTop: '1px solid rgba(255,255,255,0.04)', fontSize: 9, color: '#555d72', lineHeight: 1.6 }}>
              MWR = Money-Weighted Return (IRR) — accounts for timing and size of cash flows. &nbsp;
              TWR = Time-Weighted Return — removes effect of external cash flows, measures manager skill. &nbsp;
              pp = percentage points outperformance vs benchmark. &nbsp;
              NGX benchmark data estimated from annual returns; live index data requires market data subscription.
            </div>
          </div>

          {/* All periods summary strip */}
          {data?.allPeriods && (
            <div style={{ marginTop: 12 }}>
              <div style={{ fontSize: 9, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.08em', color: '#555d72', marginBottom: 8 }}>All periods — MWR</div>
              <div style={{ display: 'flex', gap: 6 }}>
                {data.allPeriods.map((p: any) => (
                  <div key={p.period} onClick={() => setPeriod(p.period)}
                    style={{ flex: 1, background: '#13161d', border: period === p.period ? '1px solid #a78bfa60' : '1px solid rgba(255,255,255,0.07)', borderRadius: 8, padding: '8px 10px', cursor: 'pointer', transition: 'all 0.15s' }}>
                    <div style={{ fontSize: 9, color: '#555d72', marginBottom: 4 }}>{p.period}</div>
                    <div style={{ fontSize: 13, fontWeight: 700, fontFamily: 'monospace', color: colourClass(p.mwr ?? p.simpleReturn) }}>
                      {pct(p.mwr ?? p.simpleReturn, 1, true)}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
