'use client'

import type { ReactElement } from 'react'
import { TrendingUp, TrendingDown, AlertCircle } from 'lucide-react'
import type { TopMoversData, MoverRow } from '@/lib/cockpit-aggregations'

// v27c — Top Movers panel
//
// Two-column layout: top 5 gainers / top 5 losers.
// Sorted by NGN impact (firm_exposure × day_change/100), so a 2% move in
// a large position outranks a 9% move in a tiny one. Surfaces real-money
// moves across the firm book today rather than just biggest-percent flyers.

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
              {fmtPctSigned(r.day_change_pct, 2)}
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

// ─── Main component ─────────────────────────────────────────────
export default function TopMoversPanel({ loading, data }: Props): ReactElement {
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

  const { gainers, losers, as_of_date } = data
  const totalImpact = [...gainers, ...losers].reduce((s, m) => s + m.ngn_impact, 0)
  const asOfLabel = fmtAsOf(as_of_date)

  return (
    <div>
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
            Prices as of <strong style={{ color: 'var(--text)' }}>{asOfLabel}</strong>
          </span>
        )}
        {(gainers.length > 0 || losers.length > 0) && (
          <span>
            Net firm impact (top 10):
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
        {gainers.length === 0 && losers.length === 0 && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <AlertCircle size={11} />
            No price-change data on file. Run a Live prices refresh from any portfolio overview.
          </span>
        )}
        <span style={{ marginLeft: 'auto', fontStyle: 'italic' }}>
          Equity-only · ranked by NGN impact, not headline %
        </span>
      </div>
    </div>
  )
}
