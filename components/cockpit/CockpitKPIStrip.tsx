'use client'

import { TrendingUp, Users, Target, FileWarning } from 'lucide-react'

// v27 — Cockpit KPI strip: Total AUM, Active Mandates, Projected Annual Fees, Stale Reports

interface KPIStripProps {
  loading: boolean
  totalAUM: number
  activeMandates: number
  totalActivePortfolios: number
  projectedFees: number
  mandatesEarningFee: number
  staleReportsCount: number
}

function fmtNgnB(v: number): string {
  if (Math.abs(v) >= 1e9) return '\u20a6' + (v / 1e9).toFixed(2) + 'B'
  if (Math.abs(v) >= 1e6) return '\u20a6' + (v / 1e6).toFixed(2) + 'M'
  if (Math.abs(v) >= 1e3) return '\u20a6' + (v / 1e3).toFixed(1) + 'K'
  return '\u20a6' + v.toFixed(0)
}
function fmtNgnM(v: number): string {
  return '\u20a6' + (v / 1e6).toFixed(2) + 'M'
}

export default function CockpitKPIStrip({
  loading, totalAUM, activeMandates, totalActivePortfolios,
  projectedFees, mandatesEarningFee, staleReportsCount,
}: KPIStripProps) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 28 }}>
      <KpiCard
        icon={<TrendingUp size={16} style={{ color: 'var(--gold)' }} />}
        label="Total AUM"
        value={loading ? '—' : fmtNgnB(totalAUM)}
        sub="market value across mandates"
      />
      <KpiCard
        icon={<Users size={16} style={{ color: 'var(--gold)' }} />}
        label="Active Mandates"
        value={loading ? '—' : String(activeMandates)}
        sub={loading ? '' : `${totalActivePortfolios} total portfolios incl. internal`}
      />
      <KpiCard
        icon={<Target size={16} style={{ color: 'var(--gold)' }} />}
        label="Projected Annual Fees"
        value={loading ? '—' : fmtNgnM(projectedFees)}
        sub={loading ? '' : `${mandatesEarningFee} of ${activeMandates} above benchmark`}
        accent
      />
      <KpiCard
        icon={<FileWarning size={16} style={{ color: 'var(--gold)' }} />}
        label="Stale Reports"
        value={loading ? '—' : String(staleReportsCount)}
        sub={staleReportsCount > 0 ? 'past 100-day quarterly window' : 'all reports current'}
        warn={staleReportsCount > 0}
      />
    </div>
  )
}

function KpiCard({
  icon, label, value, sub, accent, warn,
}: {
  icon: React.ReactNode
  label: string
  value: string
  sub: string
  accent?: boolean
  warn?: boolean
}) {
  const valueColor = accent ? 'var(--gold)' : warn ? 'var(--warn)' : 'var(--text)'
  return (
    <div
      style={{
        background: 'var(--card)',
        border: '1px solid var(--border)',
        borderRadius: 5,
        padding: '20px 22px',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: 32,
          height: 2,
          background: 'var(--gold)',
        }}
      />
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <div
          style={{
            width: 28,
            height: 28,
            borderRadius: 4,
            background: 'var(--gold-soft)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          {icon}
        </div>
        <div
          style={{
            fontSize: 10,
            letterSpacing: '0.16em',
            fontWeight: 600,
            color: 'var(--text-3)',
            textTransform: 'uppercase',
          }}
        >
          {label}
        </div>
      </div>
      <div
        className="hybrid-serif"
        style={{
          fontSize: 32,
          fontWeight: 500,
          letterSpacing: '-0.015em',
          lineHeight: 1,
          color: valueColor,
          marginBottom: 8,
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-2)' }}>{sub}</div>
    </div>
  )
}
