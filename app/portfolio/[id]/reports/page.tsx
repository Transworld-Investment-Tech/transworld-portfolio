'use client'
import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { Clock, Sparkles, FileText, Calendar, Copy, Check, Printer } from 'lucide-react'
import type { ReportType } from '@/lib/report-engine'

// v20d: Hybrid rewrite + pure-React markdown renderer.
// The legacy page used dangerouslySetInnerHTML for inline formatting
// (bold / italic / code) inside table cells, list items, and paragraphs.
// v20d replaces this with a `formatInline()` helper that tokenises the
// input and returns React.ReactNode[]. Zero dangerouslySetInnerHTML
// remains in the React render tree.
//
// The print view (buildPrintHTML) still emits an HTML string for
// window.document.write — that's not a React render path, so it's fine
// to keep as-is. Its CSS has been updated to the hybrid palette.

const REPORT_TYPE_COLORS: Record<ReportType, string> = {
  daily:     '#2d6e4e', // pos green
  weekly:    '#0a1f3a', // navy
  monthly:   '#b08b3e', // gold (primary)
  quarterly: '#a67c2a', // warn gold
  annual:    '#a63b3b', // neg red — year-in-review gravitas
}

const REPORT_TYPES: { value: ReportType; label: string; desc: string }[] = [
  { value: 'daily',     label: 'Daily',     desc: 'Pulse + positions'    },
  { value: 'weekly',    label: 'Weekly',    desc: 'Week recap + outlook' },
  { value: 'monthly',   label: 'Monthly',   desc: 'Full analysis'        },
  { value: 'quarterly', label: 'Quarterly', desc: 'Deep-dive'            },
  { value: 'annual',    label: 'Annual',    desc: 'Year review'          },
]

function defaultDates(type: ReportType) {
  const to = new Date(), from = new Date()
  if (type === 'daily')     from.setDate(to.getDate() - 1)
  if (type === 'weekly')    from.setDate(to.getDate() - 7)
  if (type === 'monthly')   from.setMonth(to.getMonth() - 1)
  if (type === 'quarterly') from.setMonth(to.getMonth() - 3)
  if (type === 'annual')    from.setFullYear(to.getFullYear() - 1)
  return { from: from.toISOString().slice(0,10), to: to.toISOString().slice(0,10) }
}

// ─── Pure-React inline formatter (replaces dangerouslySetInnerHTML) ──
// Tokenises **bold**, *italic*, `code` via a single regex pass with
// lookahead for the closing delimiter. Returns React.ReactNode[].
function formatInline(text: string): React.ReactNode[] {
  if (!text) return []
  const parts: React.ReactNode[] = []
  const regex = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`)/g
  let lastIdx = 0
  let match: RegExpExecArray | null
  let key = 0
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIdx) {
      parts.push(text.slice(lastIdx, match.index))
    }
    const m = match[1]
    if (m.startsWith('**')) {
      parts.push(
        <strong key={key++} style={{ color: 'var(--text)', fontWeight: 600 }}>
          {m.slice(2, -2)}
        </strong>
      )
    } else if (m.startsWith('`')) {
      parts.push(
        <code
          key={key++}
          style={{
            background: 'var(--gold-soft)',
            padding: '1px 5px',
            borderRadius: 2,
            fontSize: 11,
            color: 'var(--gold)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {m.slice(1, -1)}
        </code>
      )
    } else {
      parts.push(
        <em key={key++} style={{ color: 'var(--text-2)', fontStyle: 'italic' }}>
          {m.slice(1, -1)}
        </em>
      )
    }
    lastIdx = match.index + m.length
  }
  if (lastIdx < text.length) {
    parts.push(text.slice(lastIdx))
  }
  return parts
}

function renderMarkdown(text: string): React.ReactNode[] {
  if (!text) return []
  const lines = text.split('\n')
  const out: React.ReactNode[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    if (line.startsWith('## ')) {
      out.push(
        <h2
          key={i}
          className="hybrid-serif"
          style={{
            fontSize: 22,
            fontWeight: 500,
            color: 'var(--text)',
            marginTop: 28,
            marginBottom: 10,
            borderBottom: '1px solid var(--border-soft)',
            paddingBottom: 6,
            letterSpacing: '-0.005em',
          }}
        >
          {line.slice(3)}
        </h2>
      )
      continue
    }
    if (line.startsWith('### ')) {
      out.push(
        <h3
          key={i}
          className="hybrid-serif"
          style={{
            fontStyle: 'italic',
            fontSize: 16,
            fontWeight: 500,
            color: 'var(--gold)',
            marginTop: 20,
            marginBottom: 6,
          }}
        >
          {line.slice(4)}
        </h3>
      )
      continue
    }
    if (line.startsWith('#### ')) {
      out.push(
        <h4
          key={i}
          style={{
            fontSize: 11,
            fontWeight: 600,
            color: 'var(--text-2)',
            textTransform: 'uppercase' as const,
            letterSpacing: '0.14em',
            marginTop: 16,
            marginBottom: 5,
          }}
        >
          {line.slice(5)}
        </h4>
      )
      continue
    }
    if (line.startsWith('---')) {
      out.push(<hr key={i} style={{ border: 'none', borderTop: '1px solid var(--border-soft)', margin: '24px 0' }} />)
      continue
    }

    // Tables
    if (line.startsWith('| ')) {
      if (line.replace(/[\s\-|]/g, '') === '') continue
      const cells = line.split('|').filter(c => c.trim())
      const isHeader = lines[i + 1]?.replace(/[\s\-|]/g, '') === ''
      out.push(
        <div
          key={i}
          style={{
            display: 'flex',
            borderBottom: '1px solid var(--border-soft)',
            padding: '7px 0',
            background: isHeader ? 'var(--bg-soft)' : 'transparent',
          }}
        >
          {cells.map((c, j) => (
            <div
              key={j}
              style={{
                flex: 1,
                fontSize: 12,
                color: isHeader ? 'var(--text)' : 'var(--text-2)',
                fontWeight: isHeader ? 600 : 400,
                padding: '0 10px',
              }}
            >
              {formatInline(c.trim())}
            </div>
          ))}
        </div>
      )
      continue
    }

    if (line.trim() === '') {
      out.push(<div key={i} style={{ height: 8 }} />)
      continue
    }

    if (line.startsWith('- ') || line.startsWith('• ')) {
      out.push(
        <div key={i} style={{ display: 'flex', gap: 10, margin: '4px 0', paddingLeft: 6 }}>
          <span style={{ color: 'var(--gold)', flexShrink: 0, fontWeight: 600 }}>·</span>
          <p style={{ fontSize: 13, lineHeight: 1.7, color: 'var(--text-2)', margin: 0 }}>
            {formatInline(line.replace(/^[-•]\s+/, ''))}
          </p>
        </div>
      )
      continue
    }

    out.push(
      <p key={i} style={{ fontSize: 13, lineHeight: 1.8, color: 'var(--text-2)', margin: '4px 0' }}>
        {formatInline(line)}
      </p>
    )
  }

  return out
}

// ─── Print view (document.write popup — string-based, not React) ──
function buildPrintHTML(portfolioName: string, reportType: string, reportDate: string, content: string): string {
  const date = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const lines = content.split('\n')
  const rows: string[] = []
  let tbuf = ''
  for (const ln of lines) {
    if (ln.startsWith('| ')) {
      if (ln.replace(/[\s\-|]/g, '') === '') continue
      const cells = ln.split('|').filter((c: string) => c.trim())
      tbuf += '<tr>' + cells.map((c: string) => '<td>' + c.trim().replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>') + '</td>').join('') + '</tr>'
    } else {
      if (tbuf) { rows.push('<table>' + tbuf + '</table>'); tbuf = '' }
      if (ln.startsWith('## '))       rows.push('<h2>' + ln.slice(3) + '</h2>')
      else if (ln.startsWith('### ')) rows.push('<h3>' + ln.slice(4) + '</h3>')
      else if (ln.startsWith('---'))  rows.push('<hr>')
      else if (ln.trim() === '')      rows.push('<br>')
      else rows.push('<p>' + ln.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>') + '</p>')
    }
  }
  if (tbuf) rows.push('<table>' + tbuf + '</table>')
  const body = rows.join('\n')
  const css = "@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,500&family=DM+Sans:wght@400;500;600&display=swap');" +
    "body{font-family:'DM Sans',Arial,sans-serif;font-size:10.5pt;line-height:1.7;color:#0f2947;background:#f5efe0}" +
    ".ph{background:#0a1f3a;padding:28px 40px;border-bottom:1px solid #b08b3e;margin-bottom:32px}" +
    ".firm{font-size:9pt;font-weight:600;letter-spacing:.2em;text-transform:uppercase;color:#b08b3e;margin-bottom:10px}" +
    ".pname{font-family:'Cormorant Garamond',Georgia,serif;font-size:26pt;font-weight:500;color:#e8d9b5;margin-bottom:6px;letter-spacing:-0.005em}" +
    ".pmeta{font-size:11pt;color:rgba(232,217,181,0.7)}" +
    ".content{padding:0 40px 40px;background:#fffbf2;border:1px solid rgba(15,41,71,0.12)}" +
    "h2{font-family:'Cormorant Garamond',Georgia,serif;font-size:18pt;font-weight:500;color:#0f2947;border-bottom:1px solid rgba(15,41,71,0.08);padding-bottom:6px;margin:28px 0 10px;letterSpacing:-0.005em}" +
    "h3{font-family:'Cormorant Garamond',Georgia,serif;font-style:italic;font-size:14pt;font-weight:500;color:#b08b3e;margin:18px 0 8px}" +
    "p{margin:5px 0;color:#0f2947}strong{font-weight:600;color:#0f2947}em{color:#5c6573}" +
    "hr{border:none;border-top:1px solid rgba(15,41,71,0.1);margin:22px 0}" +
    "table{width:100%;border-collapse:collapse;margin:14px 0;font-size:9.5pt;page-break-inside:avoid}" +
    "td,th{padding:7px 9px;border-bottom:1px solid rgba(15,41,71,0.06);text-align:left;color:#0f2947}" +
    "th{background:#faf5ea;font-weight:600;border-bottom:1px solid rgba(15,41,71,0.12);color:#5c6573;text-transform:uppercase;font-size:8.5pt;letter-spacing:0.1em}" +
    ".pbtn{position:fixed;top:16px;right:16px;background:#0a1f3a;color:#c9a556;border:none;border-radius:3px;padding:10px 18px;font-size:12px;cursor:pointer;font-family:'DM Sans',sans-serif;font-weight:600}" +
    "@media print{@page{size:A4;margin:15mm}.pbtn{display:none!important}" +
    ".ph{background:none!important;border-bottom:2px solid #b08b3e;padding:0 0 14px;margin-bottom:22px}" +
    ".pname{color:#0f2947!important;font-size:20pt}.firm{color:#b08b3e!important}.pmeta{color:#5c6573!important}" +
    ".content{padding:0;border:none}p{orphans:3;widows:3}}"
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>' + css + '</style></head><body>' +
    '<button class="pbtn" onclick="window.print()">Print / Save PDF</button>' +
    '<div class="ph"><div class="firm">Transworld Asset Management · Portfolio Intelligence</div>' +
    '<div class="pname">' + portfolioName + '</div>' +
    '<div class="pmeta">' + reportType.toUpperCase() + ' · ' + reportDate + ' · ' + date + '</div></div>' +
    '<div class="content">' + body + '</div>' +
    '</body></html>'
}

export default function PortfolioReportsPage() {
  const { id: portfolioId } = useParams() as { id: string }
  const [portfolio,      setPortfolio]      = useState<any>(null)
  const [history,        setHistory]        = useState<any[]>([])
  const [selectedReport, setSelectedReport] = useState<any>(null)
  const [reportType,     setReportType]     = useState<ReportType>('monthly')
  const [dates,          setDates]          = useState(defaultDates('monthly'))
  const [generating,     setGenerating]     = useState(false)
  const [error,          setError]          = useState('')
  const [copied,         setCopied]         = useState(false)

  const loadHistory = useCallback(async () => {
    const [portRes, rptRes] = await Promise.all([
      supabase.from('portfolios').select('name, label, client:clients(name)').eq('id', portfolioId).single(),
      supabase.from('reports').select('*').eq('portfolio_id', portfolioId).order('created_at', { ascending: false }).limit(40),
    ])
    setPortfolio(portRes.data)
    const rpts = rptRes.data ?? []
    setHistory(rpts)
    if (rpts.length > 0 && !selectedReport) setSelectedReport(rpts[0])
  }, [portfolioId])

  useEffect(() => { loadHistory() }, [portfolioId])

  function handleTypeChange(type: ReportType) { setReportType(type); setDates(defaultDates(type)) }

  async function generate() {
    setGenerating(true); setError('')
    try {
      const res = await fetch('/api/reports', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ portfolioId, reportType, dateFrom: dates.from, dateTo: dates.to }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error)
      await loadHistory()
      const { data } = await supabase.from('reports').select('*').eq('portfolio_id', portfolioId).order('created_at', { ascending: false }).limit(1).single()
      if (data) setSelectedReport(data)
    } catch (e) { setError((e as Error).message) }
    finally { setGenerating(false) }
  }

  function printReport() {
    if (!selectedReport || !portfolio) return
    const html = buildPrintHTML(portfolio.name, selectedReport.report_type, selectedReport.report_date, selectedReport.content)
    const win = window.open('', '_blank', 'width=960,height=800')
    if (win) { win.document.write(html); win.document.close() }
  }

  function copyReport() {
    if (!selectedReport) return
    navigator.clipboard.writeText(selectedReport.content)
    setCopied(true); setTimeout(() => setCopied(false), 2500)
  }

  const selectedColor = REPORT_TYPE_COLORS[(selectedReport?.report_type ?? reportType) as ReportType]
  const isLongReport = ['quarterly', 'annual'].includes(reportType)

  return (
    <div className="hybrid-page" style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>

      {/* Left pane — Generate + history */}
      <aside
        style={{
          width: 288,
          flexShrink: 0,
          background: 'var(--card)',
          borderRight: '1px solid var(--border)',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
        }}
      >
        <div style={{ padding: 16, borderBottom: '1px solid var(--border-soft)' }}>
          <div
            style={{
              fontSize: 10,
              fontWeight: 600,
              textTransform: 'uppercase' as const,
              letterSpacing: '0.18em',
              color: 'var(--gold)',
              marginBottom: 12,
            }}
          >
            Generate report
          </div>

          {/* Report type grid */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 14 }}>
            {REPORT_TYPES.map(t => {
              const color = REPORT_TYPE_COLORS[t.value]
              const active = reportType === t.value
              return (
                <button
                  key={t.value}
                  onClick={() => handleTypeChange(t.value)}
                  style={{
                    padding: '8px 10px',
                    borderRadius: 3,
                    textAlign: 'left' as const,
                    transition: 'all 0.15s',
                    cursor: 'pointer',
                    fontFamily: 'var(--font-sans)',
                    ...(active
                      ? { background: color + '1a', color, border: `1px solid ${color}55` }
                      : { background: 'var(--bg-soft)', color: 'var(--text-2)', border: '1px solid var(--border-soft)' }),
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: 600 }}>{t.label}</div>
                  <div style={{ fontSize: 10, opacity: 0.75, marginTop: 2 }}>{t.desc}</div>
                </button>
              )
            })}
          </div>

          {/* Date range */}
          <div style={{ marginBottom: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 5, marginBottom: 6 }}>
              <Calendar size={10} style={{ color: 'var(--text-3)' }} />
              <span
                style={{
                  fontSize: 9,
                  color: 'var(--text-3)',
                  textTransform: 'uppercase' as const,
                  letterSpacing: '0.16em',
                  fontWeight: 600,
                }}
              >
                Period
              </span>
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              <div>
                <label style={{ display: 'block', fontSize: 10, color: 'var(--text-3)', marginBottom: 3 }}>From</label>
                <input
                  type="date"
                  value={dates.from}
                  onChange={e => setDates(d => ({ ...d, from: e.target.value }))}
                  className="input-h input-h-sm input-h-mono"
                />
              </div>
              <div>
                <label style={{ display: 'block', fontSize: 10, color: 'var(--text-3)', marginBottom: 3 }}>To</label>
                <input
                  type="date"
                  value={dates.to}
                  onChange={e => setDates(d => ({ ...d, to: e.target.value }))}
                  className="input-h input-h-sm input-h-mono"
                />
              </div>
            </div>
          </div>

          <button
            onClick={generate}
            disabled={generating}
            className="btn-h btn-h-primary"
            style={{ width: '100%', justifyContent: 'center', padding: '10px 14px' }}
          >
            {generating ? (
              <>
                <div
                  style={{
                    width: 11,
                    height: 11,
                    border: '2px solid rgba(232,217,181,0.25)',
                    borderTopColor: 'var(--gold-bright)',
                    borderRadius: '50%',
                    animation: 'spin 0.7s linear infinite',
                  }}
                />
                Analysing…
              </>
            ) : (
              <>
                <Sparkles size={12} /> Generate {reportType}
              </>
            )}
          </button>

          <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>

          {error && (
            <div
              className="alert-h alert-h-critical"
              style={{ marginTop: 10, fontSize: 11, lineHeight: 1.5 }}
            >
              ⚠ {error}
            </div>
          )}

          {isLongReport && !generating && (
            <p
              style={{
                marginTop: 10,
                fontSize: 10,
                color: 'var(--warn)',
                lineHeight: 1.5,
              }}
            >
              ⏳ {reportType === 'annual' ? 'Annual reports take 90–150s' : 'Quarterly takes 60–90s'} — please wait after clicking Generate.
            </p>
          )}
          {!isLongReport && !generating && (
            <p style={{ marginTop: 10, fontSize: 10, color: 'var(--text-3)', lineHeight: 1.5 }}>
              Deep analysis using portfolio history, watchlist intelligence, and market knowledge.
            </p>
          )}
        </div>

        {/* History list */}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          <div
            style={{
              padding: '10px 16px 6px',
              fontSize: 9,
              fontWeight: 600,
              textTransform: 'uppercase' as const,
              letterSpacing: '0.18em',
              color: 'var(--text-3)',
            }}
          >
            History ({history.length})
          </div>
          {history.map(r => {
            const color = REPORT_TYPE_COLORS[r.report_type as ReportType]
            const isSelected = selectedReport?.id === r.id
            return (
              <div
                key={r.id}
                onClick={() => setSelectedReport(r)}
                style={{
                  padding: '10px 16px',
                  cursor: 'pointer',
                  borderBottom: '1px solid var(--border-soft)',
                  transition: 'background 0.15s',
                  background: isSelected ? 'var(--gold-soft)' : 'transparent',
                  borderLeft: isSelected ? `2px solid var(--gold)` : '2px solid transparent',
                }}
                onMouseEnter={e => {
                  if (!isSelected) e.currentTarget.style.background = 'var(--bg-soft)'
                }}
                onMouseLeave={e => {
                  if (!isSelected) e.currentTarget.style.background = 'transparent'
                }}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span
                    style={{
                      fontSize: 12,
                      fontWeight: 600,
                      textTransform: 'capitalize' as const,
                      color,
                    }}
                  >
                    {r.report_type}
                  </span>
                  <span style={{ fontSize: 10, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
                    {r.report_date}
                  </span>
                </div>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 4,
                    fontSize: 10,
                    color: 'var(--text-3)',
                    marginTop: 2,
                  }}
                >
                  <Clock size={9} />
                  {new Date(r.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
            )
          })}
        </div>
      </aside>

      {/* Main pane — selected report */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {generating ? (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 14 }}>
            <div style={{ position: 'relative' }}>
              <div
                style={{
                  width: 52,
                  height: 52,
                  border: '2px solid var(--border-soft)',
                  borderTopColor: 'var(--gold)',
                  borderRadius: '50%',
                  animation: 'spin 0.7s linear infinite',
                }}
              />
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Sparkles size={16} style={{ color: 'var(--gold)' }} />
              </div>
            </div>
            <div style={{ textAlign: 'center', maxWidth: 320 }}>
              <div style={{ fontSize: 14, color: 'var(--text)', fontWeight: 500, marginBottom: 6 }}>
                Generating {reportType} analysis…
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 6, lineHeight: 1.5 }}>
                Reviewing portfolio history · Scanning watchlist · Building recommendations
              </div>
              {isLongReport ? (
                <div
                  style={{
                    fontSize: 11,
                    fontWeight: 600,
                    marginTop: 8,
                    padding: '6px 12px',
                    borderRadius: 3,
                    display: 'inline-block',
                    color: 'var(--warn)',
                    background: 'rgba(166, 124, 42, 0.1)',
                    border: '1px solid rgba(166, 124, 42, 0.25)',
                  }}
                >
                  ⏳ {reportType === 'annual' ? 'Annual reports take 90–150s — do not close this tab' : 'Quarterly takes 60–90s — please wait'}
                </div>
              ) : (
                <div style={{ fontSize: 11, color: 'var(--text-3)' }}>Typically 20–40 seconds</div>
              )}
            </div>
          </div>
        ) : selectedReport ? (
          <>
            {/* Top bar */}
            <div
              style={{
                padding: '14px 32px',
                borderBottom: '1px solid var(--border)',
                background: 'var(--card)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                flexShrink: 0,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text)' }}>{portfolio?.name}</span>
                <span
                  style={{
                    fontSize: 10,
                    textTransform: 'capitalize' as const,
                    fontWeight: 600,
                    padding: '3px 9px',
                    borderRadius: 2,
                    background: selectedColor + '1a',
                    color: selectedColor,
                    letterSpacing: '0.12em',
                  }}
                >
                  {selectedReport.report_type}
                </span>
                <span style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
                  {selectedReport.report_date}
                </span>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn-h" onClick={copyReport}>
                  {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
                </button>
                <button className="btn-h btn-h-primary" onClick={printReport}>
                  <Printer size={12} /> Print / PDF
                </button>
              </div>
            </div>

            {/* Report body */}
            <div style={{ flex: 1, overflowY: 'auto', padding: '32px', background: 'var(--bg)' }}>
              <div style={{ maxWidth: 860, margin: '0 auto', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 5, padding: '36px 44px' }}>
                <div style={{ borderLeft: '3px solid var(--gold)', paddingLeft: 16, marginBottom: 28 }}>
                  <div
                    style={{
                      fontSize: 10,
                      color: 'var(--gold)',
                      letterSpacing: '0.2em',
                      textTransform: 'uppercase' as const,
                      fontWeight: 600,
                      marginBottom: 6,
                    }}
                  >
                    Transworld Asset Management — Portfolio Intelligence
                  </div>
                  <div
                    className="hybrid-serif"
                    style={{
                      fontSize: 26,
                      color: 'var(--text)',
                      fontWeight: 500,
                      letterSpacing: '-0.005em',
                      lineHeight: 1.1,
                    }}
                  >
                    {portfolio?.name}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 4, fontFamily: 'var(--font-mono)' }}>
                    {selectedReport.report_type.toUpperCase()} REPORT · {selectedReport.report_date}
                  </div>
                </div>

                {renderMarkdown(selectedReport.content)}

                <div
                  style={{
                    marginTop: 40,
                    padding: '14px 16px',
                    background: 'var(--gold-soft)',
                    border: '1px solid rgba(176, 139, 62, 0.2)',
                    borderRadius: 4,
                  }}
                >
                  <div
                    style={{
                      fontSize: 10,
                      color: 'var(--gold)',
                      fontWeight: 600,
                      letterSpacing: '0.14em',
                      textTransform: 'uppercase' as const,
                      marginBottom: 6,
                    }}
                  >
                    Tip
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.6 }}>
                    Copy and paste into Claude.ai:{' '}
                    <em style={{ color: 'var(--text)' }}>
                      "Format this portfolio analysis into a professional PDF-ready report. Keep all analysis and numbers exactly as they are."
                    </em>
                  </div>
                </div>
              </div>
            </div>
          </>
        ) : (
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              color: 'var(--text-3)',
              background: 'var(--bg)',
            }}
          >
            <FileText size={32} style={{ marginBottom: 12, opacity: 0.4 }} />
            <div style={{ fontSize: 14, color: 'var(--text-2)' }}>Generate your first report</div>
            <div style={{ fontSize: 11, marginTop: 6 }}>Select report type and period, then click Generate</div>
          </div>
        )}
      </div>
    </div>
  )
}
