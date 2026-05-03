'use client'

import { useState } from 'react'
import type { ReactElement } from 'react'
import { TrendingUp, TrendingDown, AlertCircle } from 'lucide-react'
import type { TopMoversData, MoverRow, WindowMovers } from '@/lib/cockpit-aggregations'

// v27c → v27ap — Top Movers panel (windowed)
//
// Tabs: Day / Week / Month / Quarter. Each tab renders top 5 gainers and
// top 5 losers within that rolling window, sorted by NGN impact (firm
// exposure × change pct).
//
// Per-window data sufficiency banners surface "insufficient" or "limited"
// states honestly — month/quarter are empty until ≥30/≥90 days of NGX
// price history accumulate, and the panel says so explicitly rather than
// rendering misleading partial results.

interface Props {
  loading: boolean
  data: TopMoversData | null
}

// ─── Render helpers (pitfall #73) ───────────────────────────────
function fmtNgnM(v: number | null | undefined): string {
  if (v === null || v === undefined || !isFinite(v)) return '—'
  const sign = v < 0 ? '−' : ''
  const abs = Math.abs(v)
  if (abs >= 1e9) return sign + '\u20a6' + (abs / 1e9).toFixed(2) + 'B'
  if (abs >= 1e6) return sign + '\u20a6' + (abs / 1e6).toFixed(2) + 'M'
  if (abs >= 1e3) return sign + '\u20a6' + (abs / 1e3).toFixed(1) + 'K'
  return sign + '\u20a6' + abs.toFixed(0)
}

function fmtPctSigned(v: number | null | undefined, dp = 2): string {
  if (v === null || v === undefined || !isFinite(v)) return '—'
  return (v >= 0 ? '+' : '') + v.toFixed(dp) + '%'
}

function fmtImpactSigned(v: number | null | undefined): string {
  if (v === null || v === undefined || !isFinite(v)) return '—'
  return (v >= 0 ? '+' : '−') + fmtNgnM(Math.abs(v))
}

function fmtAsOf(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso + 'T00:00:00Z')
  if (isNaN(d.getTime())) return ''
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
}

// ─── Subcomponent: list of mover rows ───────────────────────────
function MoverList({ rows, kind }: { rows: MoverRow[]; kind: 'gain' | 'loss' }): ReactElement {
  if (rows.length === 0) {
    return (
      <div style={{
        padding: '24px 12px',
        textAlign: 'center',
        color: 'var(--text-3)',
        fontSize: 11,
        fontStyle: 'italic',
      }}>
        No {kind === 'gain' ? 'gainers' : 'losers'} in the firm book today
      </div>
    )
  }
  return (
    <div>
      {rows.map(r => {
        const color = kind === 'gain' ? 'var(--pos)' : 'var(--neg)'
        return (
          <div
            key={r.instrument_id}
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr auto auto',
              gap: 12,
              padding: '11px 4px',
              borderBottom: '1px solid var(--border-soft)',
              alignItems: 'center',
            }}
          >
            <div style={{ minWidth: 0 }}>
              <div style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 12,
                fontWeight: 600,
                color: 'var(--gold)',
                letterSpacing: '0.02em',
              }}>
                {r.instrument_id}
              </div>
              <div style={{
                fontSize: 11,
                color: 'var(--text-2)',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }} title={r.name}>
                {r.name}
              </div>
              <div style={{
                fontSize: 9,
                color: 'var(--text-3)',
                marginTop: 2,
                letterSpacing: '0.04em',
              }}>
                {r.sector ?? 'Unclassified'}
                {' · '}
                {r.mandate_count} {r.mandate_count === 1 ? 'mandate' : 'mandates'}
                {' · exposure '}
                {fmtNgnM(r.firm_exposure_ngn)}
              </div>
            </div>
            <div style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 14,
              fontWeight: 600,
              color,
              textAlign: 'right',
              whiteSpace: 'nowrap',
            }}>
              {fmtPctSigned(r.change_pct, 2)}
            </div>
            <div style={{
              fontFamily: 'var(--font-serif)',
              fontSize: 14,
              fontWeight: 500,
              color,
              textAlign: 'right',
              minWidth: 78,
              whiteSpace: 'nowrap',
            }} title="NGN impact today (exposure × day-change)">
              {fmtImpactSigned(r.ngn_impact)}
            </div>
          </div>
        )
      })}
    </div>
  )
}

// v27ap — Window keys & metadata
type WindowKey = 'day' | 'week' | 'month' | 'quarter'

const WINDOW_META: Record<WindowKey, { label: string; sub: string }> = {
  day:     { label: 'Day',     sub: 'today' },
  week:    { label: 'Week',    sub: '7-day' },
  month:   { label: 'Month',   sub: '30-day' },
  quarter: { label: 'Quarter', sub: '90-day' },
}

// ─── Main component ─────────────────────────────────────────────
export default function TopMoversPanel({ loading, data }: Props): ReactElement {
  const [activeWindow, setActiveWindow] = useState<WindowKey>('day')

  if (loading) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)', fontSize: 12 }}>
        Loading top movers…
      </div>
    )
  }
  if (!data) {
    return (
      <div style={{ padding: 24, textAlign: 'center', color: 'var(--text-3)', fontSize: 12 }}>
        Unable to load movers
      </div>
    )
  }

  // v27ap — active window selection
  const w: WindowMovers = data[activeWindow]
  const { gainers, losers, as_of_date } = w
  const totalImpact = [...gainers, ...losers].reduce((s, m) => s + m.ngn_impact, 0)
  const asOfLabel = fmtAsOf(as_of_date)
  const meta = WINDOW_META[activeWindow]

  // Sufficiency classification per tab — drives the small dot indicator
  const sufficiency = (key: WindowKey): 'full' | 'partial' | 'empty' => {
    const win = data[key]
    if (win.total_held_instruments === 0) return 'empty'
    if (win.instruments_with_data === 0) return 'empty'
    if (win.instruments_with_data < win.total_held_instruments * 0.5) return 'partial'
    return 'full'
  }

  return (
    <div>
      {/* v27ap — Tab strip */}
      <div style={{
        display: 'flex',
        gap: 0,
        marginBottom: 14,
        borderBottom: '1px solid var(--border-soft)',
      }}>
        {(Object.keys(WINDOW_META) as WindowKey[]).map(key => {
          const isActive = activeWindow === key
          const suff = sufficiency(key)
          return (
            <button
              key={key}
              onClick={() => setActiveWindow(key)}
              style={{
                background: 'transparent',
                border: 'none',
                borderBottom: isActive ? '2px solid var(--gold)' : '2px solid transparent',
                padding: '8px 16px',
                cursor: 'pointer',
                color: isActive ? 'var(--text)' : 'var(--text-3)',
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: '0.08em',
                textTransform: 'uppercase',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                position: 'relative',
                top: 1,
              }}
            >
              {WINDOW_META[key].label}
              {suff === 'empty' && (
                <span title="Insufficient history" style={{
                  width: 5, height: 5, borderRadius: '50%',
                  background: 'var(--text-3)', opacity: 0.6,
                }} />
              )}
              {suff === 'partial' && (
                <span title="Limited data" style={{
                  width: 5, height: 5, borderRadius: '50%',
                  background: 'var(--gold)', opacity: 0.7,
                }} />
              )}
            </button>
          )
        })}
      </div>

      {/* v27ap — Sufficiency banners */}
      {w.total_held_instruments > 0 && w.instruments_with_data === 0 && (
        <div style={{
          padding: '12px 14px',
          background: 'rgba(176, 139, 62, 0.06)',
          border: '1px solid rgba(176, 139, 62, 0.20)',
          borderRadius: 4,
          fontSize: 11,
          color: 'var(--text-2)',
          marginBottom: 12,
          lineHeight: 1.5,
        }}>
          <strong style={{ color: 'var(--text)' }}>Insufficient history.</strong>
          {' '}Backfilling — none of the {w.total_held_instruments} held equities have NGX price data ≥ {meta.sub} old yet. This window will populate as price history accumulates.
        </div>
      )}
      {w.total_held_instruments > 0
        && w.instruments_with_data > 0
        && w.instruments_with_data < w.total_held_instruments * 0.5 && (
        <div style={{
          padding: '10px 12px',
          background: 'rgba(176, 139, 62, 0.04)',
          borderRadius: 4,
          fontSize: 10,
          color: 'var(--text-2)',
          marginBottom: 12,
        }}>
          Limited data: showing {w.instruments_with_data} of {w.total_held_instruments} held equities with {meta.sub} history.
        </div>
      )}

      {/* Gainers/losers two-column grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: 14,
        alignItems: 'start',
      }}>
        {/* Gainers column */}
        <div>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            paddingBottom: 8,
            marginBottom: 4,
            borderBottom: '1px solid var(--border-soft)',
          }}>
            <TrendingUp size={13} style={{ color: 'var(--pos)' }} />
            <span style={{
              fontSize: 10,
              letterSpacing: '0.14em',
              fontWeight: 600,
              color: 'var(--text-3)',
              textTransform: 'uppercase',
            }}>
              Top Gainers
            </span>
            <span style={{
              fontSize: 10,
              color: 'var(--text-3)',
              marginLeft: 'auto',
            }}>
              by NGN impact
            </span>
          </div>
          <MoverList rows={gainers} kind="gain" />
        </div>

        {/* Losers column */}
        <div>
          <div style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            paddingBottom: 8,
            marginBottom: 4,
            borderBottom: '1px solid var(--border-soft)',
          }}>
            <TrendingDown size={13} style={{ color: 'var(--neg)' }} />
            <span style={{
              fontSize: 10,
              letterSpacing: '0.14em',
              fontWeight: 600,
              color: 'var(--text-3)',
              textTransform: 'uppercase',
            }}>
              Top Losers
            </span>
            <span style={{
              fontSize: 10,
              color: 'var(--text-3)',
              marginLeft: 'auto',
            }}>
              by NGN impact
            </span>
          </div>
          <MoverList rows={losers} kind="loss" />
        </div>
      </div>

      {/* Footer summary */}
      <div style={{
        marginTop: 14,
        paddingTop: 12,
        borderTop: '1px solid var(--border-soft)',
        display: 'flex',
        gap: 18,
        flexWrap: 'wrap',
        fontSize: 10,
        color: 'var(--text-2)',
        alignItems: 'center',
      }}>
        {asOfLabel && (
          <span>
            Latest as of <strong style={{ color: 'var(--text)' }}>{asOfLabel}</strong>
          </span>
        )}
        {(gainers.length > 0 || losers.length > 0) && (
          <span>
            Net firm impact ({meta.sub}, top 10):
            {' '}
            <strong style={{
              color: totalImpact >= 0 ? 'var(--pos)' : 'var(--neg)',
              fontFamily: 'var(--font-serif)',
              fontSize: 13,
            }}>
              {fmtImpactSigned(totalImpact)}
            </strong>
          </span>
        )}
        {gainers.length === 0 && losers.length === 0 && w.instruments_with_data > 0 && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <AlertCircle size={11} />
            No movers in this window — held equities flat over {meta.sub}.
          </span>
        )}
        <span style={{ marginLeft: 'auto', fontStyle: 'italic' }}>
          Equity-only · price-based returns · dividends & corp actions excluded
        </span>
      </div>
    </div>
  )
}
