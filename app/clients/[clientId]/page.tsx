'use client'
import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import Link from 'next/link'
import {
  RefreshCw, FileText, ChevronRight, ExternalLink,
} from 'lucide-react'
import { fmt } from '@/lib/portfolio'

// v21k: Consolidated client view.
// Aggregates holdings across all active portfolios for a single client.
// Shows combined KPIs, blended IRR, merged holdings table, sleeve
// breakdown, and consolidated AI report generation.

interface PortfolioSummary {
  id: string
  label: string
  name: string
  starting_nav: number
  start_date: string
  currency: string
  valuation_date: string
  income_target: number
  current_nav: number
}

interface CombinedHolding {
  instrument_id: string
  name: string
  type: string
  sector: string | null
  sleeve_id: string
  totalQuantity: number
  blendedAvgCost: number
  latestPrice: number
  totalValue: number
  totalPnL: number
  totalPnLPct: number
  weight: number
  portfolioBreakdown: Array<{ portfolioId: string; label: string; quantity: number; avgCost: number }>
}

interface SleeveRow {
  sleeve_id: string
  name: string
  totalValue: number
  pct: number
}

interface ConsolidatedData {
  client: { id: string; name: string; code: string; type: string }
  portfolios: PortfolioSummary[]
  summary: {
    totalNAV: number
    totalStartingNAV: number
    totalPnL: number
    totalPnLPct: number
    blendedIRR: number | null
    portfolioCount: number
  }
  combinedHoldings: CombinedHolding[]
  sleeveBreakdown: SleeveRow[]
}

// ─── Simple markdown → HTML renderer ───────────────────────────────────────
// Converts ## / ### headings, **bold**, - lists, --- hr into HTML.
// Uses CSS classes defined in the <style> block at the bottom.
function renderMd(md: string): string {
  let html = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/^## (.+)$/gm, '<h2 class="rpt-h2">$1</h2>')
    .replace(/^### (.+)$/gm, '<h3 class="rpt-h3">$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/^---$/gm, '<hr class="rpt-hr"/>')
    .replace(/^- (.+)$/gm, '<li class="rpt-li">$1</li>')
    .replace(/^(\d+)\. (.+)$/gm, '<li class="rpt-li rpt-oli">$1. $2</li>')

  // Wrap consecutive li elements in a ul
  html = html.replace(/((?:<li class="rpt-li">.*?<\/li>\n?)+)/gs, '<ul class="rpt-ul">$1</ul>')

  // Lines that aren't block-level tags become paragraphs
  html = html.split('\n').map(line => {
    const trimmed = line.trim()
    if (!trimmed) return ''
    if (/^<(h[23]|ul|li|hr)/.test(trimmed)) return line
    return `<p class="rpt-p">${line}</p>`
  }).join('\n')

  return html
}

// ─── Main component ────────────────────────────────────────────────────────
export default function ConsolidatedClientPage() {
  const params = useParams()
  const clientId = params.clientId as string

  const [data, setData] = useState<ConsolidatedData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [reportType, setReportType] = useState<'monthly' | 'quarterly'>('quarterly')
  const [generating, setGenerating] = useState(false)
  const [liveReport, setLiveReport] = useState<string | null>(null)
  const [reportErr, setReportErr] = useState<string | null>(null)

  const [savedReports, setSavedReports] = useState<any[]>([])
  const [activeReport, setActiveReport] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [dataRes, repRes] = await Promise.all([
        fetch(`/api/clients/${clientId}/consolidated`),
        fetch(`/api/clients/${clientId}/report`),
      ])
      const dataJson = await dataRes.json()
      if (!dataRes.ok) { setError(dataJson.error ?? 'Load failed'); setLoading(false); return }
      setData(dataJson)
      const repJson = await repRes.json()
      if (repJson.reports) setSavedReports(repJson.reports)
    } catch (e) {
      setError('Network error')
    }
    setLoading(false)
  }, [clientId])

  useEffect(() => { load() }, [load])

  async function generateReport() {
    setGenerating(true)
    setLiveReport(null)
    setReportErr(null)
    try {
      const res = await fetch(`/api/clients/${clientId}/report`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reportType }),
      })
      const json = await res.json()
      if (!res.ok) { setReportErr(json.error ?? 'Generation failed'); setGenerating(false); return }
      setLiveReport(json.report)
      setActiveReport(null)
      // Refresh saved list
      const repRes = await fetch(`/api/clients/${clientId}/report`)
      const repJson = await repRes.json()
      if (repJson.reports) setSavedReports(repJson.reports)
    } catch {
      setReportErr('Network error during generation')
    }
    setGenerating(false)
  }

  // ─── Loading / error states ──────────────────────────────────────────────
  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '60vh', color: 'var(--text-3)', fontSize: 12 }}>
        <RefreshCw size={14} className="animate-spin" style={{ marginRight: 8 }} />
        Loading consolidated view…
      </div>
    )
  }

  if (error || !data) {
    return (
      <div style={{ padding: 44, color: 'var(--neg)', fontSize: 13 }}>
        {error ?? 'Client not found.'}
        {' '}
        <Link href="/" style={{ color: 'var(--gold)' }}>← All portfolios</Link>
      </div>
    )
  }

  const { client, portfolios, summary, combinedHoldings, sleeveBreakdown } = data
  const equities = combinedHoldings.filter(h => h.type === 'Stock')
  const irrDisplay = summary.blendedIRR !== null
    ? `${(summary.blendedIRR * 100).toFixed(1)}%`
    : '—'

  return (
    <div className="hybrid-page" style={{ minHeight: '100vh' }}>
      <main style={{ padding: '32px 44px 64px', maxWidth: '100%' }}>

        {/* ── Page header ──────────────────────────────────────────────── */}
        <div className="page-head">
          <div>
            <div className="eyebrow" style={{ marginBottom: 10 }}>
              <Link href="/" style={{ color: 'var(--gold)', textDecoration: 'none' }}>
                All portfolios
              </Link>
              {' / Consolidated view'}
            </div>
            <h1
              className="hybrid-serif"
              style={{ fontSize: 36, fontWeight: 500, letterSpacing: '-0.005em', lineHeight: 1, color: 'var(--text)' }}
            >
              {client.name}
            </h1>
            <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-3)' }}>
              {summary.portfolioCount} active portfolio{summary.portfolioCount !== 1 ? 's' : ''} · consolidated view
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="btn-h" onClick={load} disabled={loading}>
              <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
            </button>
          </div>
        </div>

        {/* ── KPI strip ────────────────────────────────────────────────── */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 14, marginBottom: 24 }}>
          <KpiCard
            label="Total NAV"
            value={fmt.ngnM(summary.totalNAV)}
            sub="current market value"
            color={summary.totalNAV > 0 ? 'var(--pos)' : 'var(--text)'}
          />
          <KpiCard
            label="Total starting NAV"
            value={fmt.ngnM(summary.totalStartingNAV)}
            sub={`across ${summary.portfolioCount} portfolio${summary.portfolioCount !== 1 ? 's' : ''}`}
          />
          <KpiCard
            label="Combined P&L"
            value={(summary.totalPnL >= 0 ? '+' : '') + fmt.ngnM(summary.totalPnL)}
            sub={(summary.totalPnLPct >= 0 ? '+' : '') + (summary.totalPnLPct * 100).toFixed(1) + '% total return'}
            color={summary.totalPnL >= 0 ? 'var(--pos)' : 'var(--neg)'}
          />
          <KpiCard
            label="Blended IRR"
            value={irrDisplay}
            sub="annualised · merged cash flows"
            color={summary.blendedIRR !== null && summary.blendedIRR > 0 ? 'var(--pos)' : 'var(--text)'}
          />
        </div>

        {/* ── Portfolio breakdown cards ────────────────────────────────── */}
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${Math.min(portfolios.length, 4)}, 1fr)`,
            gap: 12,
            marginBottom: 24,
          }}
        >
          {portfolios.map(p => {
            const gain    = p.current_nav - p.starting_nav
            const gainPct = p.starting_nav > 0 ? gain / p.starting_nav : 0
            return (
              <Link key={p.id} href={`/portfolio/${p.id}`} style={{ textDecoration: 'none', color: 'inherit' }}>
                <div
                  className="panel"
                  style={{ cursor: 'pointer', transition: 'border-color 0.15s' }}
                  onMouseEnter={e => (e.currentTarget.style.borderColor = 'var(--gold)')}
                  onMouseLeave={e => (e.currentTarget.style.borderColor = 'var(--border)')}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                    <div
                      style={{
                        width: 28, height: 28, borderRadius: 4,
                        background: 'var(--gold-soft)',
                        border: '1px solid rgba(176,139,62,0.25)',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: 'var(--gold)', fontWeight: 700, fontSize: 13,
                        fontFamily: 'var(--font-serif)',
                      }}
                    >
                      {p.label}
                    </div>
                    <ExternalLink size={11} style={{ color: 'var(--text-3)' }} />
                  </div>
                  <div style={{ fontSize: 12, fontWeight: 500, marginBottom: 8, color: 'var(--text)' }}>
                    {p.name}
                  </div>
                  <div
                    className="hybrid-serif"
                    style={{ fontSize: 20, fontWeight: 500, color: 'var(--text)', letterSpacing: '-0.01em', lineHeight: 1 }}
                  >
                    {fmt.ngnM(p.current_nav)}
                  </div>
                  {p.starting_nav > 0 && (
                    <div style={{ marginTop: 4, fontSize: 11, color: gain >= 0 ? 'var(--pos)' : 'var(--neg)' }}>
                      {gain >= 0 ? '+' : ''}{(gainPct * 100).toFixed(1)}% from {fmt.ngnM(p.starting_nav)}
                    </div>
                  )}
                </div>
              </Link>
            )
          })}
        </div>

        {/* ── Combined holdings table ──────────────────────────────────── */}
        <div className="panel" style={{ marginBottom: 24 }}>
          <div className="panel-header">
            <div className="panel-title">Combined Holdings</div>
            <div className="panel-meta">
              {combinedHoldings.length} positions · {equities.length} equities
            </div>
          </div>
          {combinedHoldings.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-3)', fontSize: 12 }}>
              No holdings across these portfolios yet.
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {['Instrument', 'Total shares', 'Blended cost', 'Price', 'Value', 'Weight', 'P&L', 'In'].map(h => (
                      <th
                        key={h}
                        style={{
                          textAlign: h === 'Instrument' || h === 'In' ? 'left' : 'right',
                          padding: '10px 12px',
                          fontSize: 10,
                          letterSpacing: '0.14em',
                          fontWeight: 600,
                          color: 'var(--text-3)',
                          textTransform: 'uppercase',
                          borderBottom: '1px solid var(--border)',
                        }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {combinedHoldings.map(h => (
                    <tr
                      key={h.instrument_id}
                      style={{ borderBottom: '1px solid var(--border-soft)' }}
                      onMouseEnter={e => (e.currentTarget.style.background = 'rgba(15,41,71,0.02)')}
                      onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}
                    >
                      <td style={{ padding: '12px 12px' }}>
                        <div style={{ fontWeight: 500, fontSize: 13 }}>{h.instrument_id}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{h.name}</div>
                        {h.sector && (
                          <div style={{ fontSize: 10, color: 'var(--text-4)' }}>{h.sector}</div>
                        )}
                      </td>
                      <Num serif>{Math.round(h.totalQuantity).toLocaleString()}</Num>
                      <Num serif>₦{h.blendedAvgCost.toFixed(2)}</Num>
                      <Num serif>₦{h.latestPrice.toFixed(2)}</Num>
                      <Num serif>₦{(h.totalValue / 1e6).toFixed(2)}M</Num>
                      <Num>{(h.weight * 100).toFixed(1)}%</Num>
                      <td style={{ padding: '12px 12px', textAlign: 'right' }}>
                        <div
                          style={{
                            fontFamily: 'var(--font-serif)',
                            fontSize: 16,
                            fontWeight: 500,
                            letterSpacing: '-0.005em',
                            color: h.totalPnL >= 0 ? 'var(--pos)' : 'var(--neg)',
                          }}
                        >
                          {h.totalPnL >= 0 ? '+' : ''}₦{(h.totalPnL / 1e6).toFixed(2)}M
                        </div>
                        <div style={{ fontSize: 10, color: h.totalPnL >= 0 ? 'var(--pos)' : 'var(--neg)' }}>
                          {h.totalPnL >= 0 ? '+' : ''}{(h.totalPnLPct * 100).toFixed(1)}%
                        </div>
                      </td>
                      <td style={{ padding: '12px 12px' }}>
                        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                          {h.portfolioBreakdown.map(pb => (
                            <span
                              key={pb.portfolioId}
                              title={`Portfolio ${pb.label}: ${Math.round(pb.quantity).toLocaleString()} shares @ ₦${pb.avgCost.toFixed(2)}`}
                              style={{
                                fontSize: 9, padding: '2px 6px',
                                background: 'var(--gold-soft)',
                                color: 'var(--gold)', borderRadius: 2,
                                fontWeight: 600, letterSpacing: '0.08em',
                              }}
                            >
                              {pb.label}
                            </span>
                          ))}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* ── Sleeve breakdown ─────────────────────────────────────────── */}
        {sleeveBreakdown.length > 0 && (
          <div className="panel" style={{ marginBottom: 24 }}>
            <div className="panel-header">
              <div className="panel-title">Combined Sleeve Allocation</div>
              <div className="panel-meta">all portfolios</div>
            </div>
            {sleeveBreakdown.map(s => (
              <div key={s.sleeve_id} style={{ marginBottom: 18 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 7 }}>
                  <span style={{ fontSize: 13, fontWeight: 500 }}>{s.name}</span>
                  <span>
                    <span
                      style={{
                        fontFamily: 'var(--font-serif)',
                        fontSize: 18,
                        fontWeight: 500,
                        letterSpacing: '-0.01em',
                      }}
                    >
                      {(s.pct * 100).toFixed(1)}%
                    </span>
                    <span style={{ fontSize: 12, color: 'var(--text-2)', marginLeft: 6 }}>
                      · ₦{(s.totalValue / 1e6).toFixed(2)}M
                    </span>
                  </span>
                </div>
                <div style={{ height: 6, background: 'rgba(15,41,71,0.08)', borderRadius: 3, overflow: 'hidden' }}>
                  <div
                    style={{
                      height: '100%',
                      width: `${Math.min(s.pct * 100, 100)}%`,
                      borderRadius: 3,
                      background:
                        s.sleeve_id === 'eq'  ? 'linear-gradient(90deg, var(--gold), var(--gold-bright))'
                        : s.sleeve_id === 'liq' ? 'var(--sidebar-bg)'
                        : 'var(--pos)',
                    }}
                  />
                </div>
              </div>
            ))}
          </div>
        )}

        {/* ── Consolidated AI Report section ───────────────────────────── */}
        <div className="panel">
          <div className="panel-header">
            <div>
              <div className="panel-title">Consolidated AI Report</div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                Covers all {summary.portfolioCount} portfolios · watchlist-integrated
              </div>
            </div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <select
                value={reportType}
                onChange={e => setReportType(e.target.value as 'monthly' | 'quarterly')}
                className="select-h"
                disabled={generating}
              >
                <option value="monthly">Monthly</option>
                <option value="quarterly">Quarterly</option>
              </select>
              <button
                className="btn-h btn-h-primary"
                onClick={generateReport}
                disabled={generating}
              >
                {generating
                  ? <><RefreshCw size={12} className="animate-spin" /> Generating…</>
                  : <><FileText size={12} /> Generate report</>}
              </button>
            </div>
          </div>

          {reportErr && (
            <div
              style={{
                padding: '12px 16px',
                background: 'rgba(166,59,59,0.08)',
                border: '1px solid rgba(166,59,59,0.2)',
                borderRadius: 4, marginBottom: 16,
                fontSize: 12, color: 'var(--neg)',
              }}
            >
              Error: {reportErr}
            </div>
          )}

          {/* Freshly generated report */}
          {liveReport && (
            <div style={{ marginBottom: 28 }}>
              <div
                style={{
                  fontSize: 10, letterSpacing: '0.16em', color: 'var(--gold)',
                  textTransform: 'uppercase', fontWeight: 600, marginBottom: 14,
                  paddingBottom: 10, borderBottom: '1px solid var(--border-soft)',
                }}
              >
                Just generated
              </div>
              <div
                className="rpt-body"
                dangerouslySetInnerHTML={{ __html: renderMd(liveReport) }}
              />
            </div>
          )}

          {/* Saved reports list */}
          {savedReports.length > 0 && (
            <div>
              <div
                style={{
                  fontSize: 10, letterSpacing: '0.16em', color: 'var(--text-3)',
                  textTransform: 'uppercase', fontWeight: 600, marginBottom: 12,
                }}
              >
                Previously generated
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {savedReports.map(r => (
                  <div key={r.id}>
                    <button
                      onClick={() => setActiveReport(activeReport === r.id ? null : r.id)}
                      style={{
                        width: '100%', textAlign: 'left',
                        background: activeReport === r.id ? 'var(--card)' : 'var(--bg-soft)',
                        border: '1px solid var(--border)',
                        borderRadius: activeReport === r.id ? '4px 4px 0 0' : 4,
                        padding: '10px 14px', cursor: 'pointer',
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                        fontFamily: 'inherit',
                      }}
                    >
                      <div>
                        <span style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)' }}>
                          Consolidated · {r.report_date}
                        </span>
                        <span style={{ fontSize: 10, color: 'var(--text-3)', marginLeft: 10 }}>
                          {new Date(r.created_at).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
                        </span>
                      </div>
                      <ChevronRight
                        size={12}
                        style={{
                          color: 'var(--text-3)',
                          transform: activeReport === r.id ? 'rotate(90deg)' : 'none',
                          transition: 'transform 0.2s',
                        }}
                      />
                    </button>
                    {activeReport === r.id && (
                      <div
                        className="rpt-body"
                        style={{
                          border: '1px solid var(--border)', borderTop: 'none',
                          borderRadius: '0 0 4px 4px',
                          padding: '20px 24px', background: 'var(--card)',
                        }}
                        dangerouslySetInnerHTML={{ __html: renderMd(r.content) }}
                      />
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {!liveReport && savedReports.length === 0 && !generating && (
            <div style={{ textAlign: 'center', padding: '48px 0', color: 'var(--text-3)', fontSize: 12 }}>
              <FileText size={28} style={{ margin: '0 auto 12px', opacity: 0.3, display: 'block' }} />
              No consolidated reports yet. Select a period above and generate one.
            </div>
          )}
        </div>
      </main>

      {/* ── Report body styles ───────────────────────────────────────────── */}
      <style jsx global>{`
        .rpt-body { font-size: 13px; line-height: 1.75; color: var(--text-2); }
        .rpt-body .rpt-h2 {
          font-family: var(--font-serif); font-size: 21px; font-weight: 500;
          color: var(--text); margin: 32px 0 12px;
          padding-bottom: 8px; border-bottom: 1px solid var(--border);
        }
        .rpt-body .rpt-h3 {
          font-family: var(--font-serif); font-size: 17px; font-weight: 500;
          font-style: italic; color: var(--text); margin: 22px 0 8px;
        }
        .rpt-body .rpt-hr { border: none; border-top: 1px solid var(--border); margin: 24px 0; }
        .rpt-body .rpt-ul { list-style: disc; padding-left: 22px; margin: 8px 0; }
        .rpt-body .rpt-li { margin: 4px 0; }
        .rpt-body .rpt-p  { margin: 9px 0; }
        .rpt-body strong  { color: var(--text); font-weight: 600; }
      `}</style>
    </div>
  )
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function KpiCard({
  label, value, sub, color,
}: { label: string; value: string; sub: string; color?: string }) {
  return (
    <div
      style={{
        background: 'var(--card)', border: '1px solid var(--border)',
        borderRadius: 5, padding: '20px 22px',
        position: 'relative', overflow: 'hidden',
      }}
    >
      <span style={{ position: 'absolute', top: 0, left: 0, width: 32, height: 2, background: 'var(--gold)' }} />
      <div
        style={{
          fontSize: 10, letterSpacing: '0.16em', color: 'var(--text-3)',
          textTransform: 'uppercase', fontWeight: 600, marginBottom: 12,
        }}
      >
        {label}
      </div>
      <div
        className="hybrid-serif"
        style={{
          fontSize: 28, fontWeight: 500, letterSpacing: '-0.01em',
          lineHeight: 1, color: color ?? 'var(--text)', marginBottom: 8,
        }}
      >
        {value}
      </div>
      <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{sub}</div>
    </div>
  )
}

function Num({ children, serif }: { children: React.ReactNode; serif?: boolean }) {
  return (
    <td
      style={{
        padding: '12px 12px', textAlign: 'right',
        fontVariantNumeric: 'tabular-nums',
        fontFamily: serif ? 'var(--font-serif)' : undefined,
        fontSize: serif ? 16 : 13,
        fontWeight: serif ? 500 : 400,
        letterSpacing: serif ? '-0.005em' : undefined,
        color: 'var(--text)',
      }}
    >
      {children}
    </td>
  )
}
