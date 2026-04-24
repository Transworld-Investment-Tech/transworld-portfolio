'use client'
import { useEffect, useState, useCallback } from 'react'
import { Clock, Sparkles, FileText, Printer, Copy, Check, Radio } from 'lucide-react'

// v21r: CIO Weekly Intelligence Brief page.
// admin/layout.tsx renders Sidebar \u2014 do NOT add another Sidebar here.
// Left pane: generate + history | Right pane: brief viewer.

// \u2500\u2500\u2500 Inline formatter (bold, italic, code) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function formatInline(text: string): React.ReactNode[] {
  if (!text) return []
  const parts: React.ReactNode[] = []
  const regex = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`)/g
  let lastIdx = 0, key = 0
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIdx) parts.push(text.slice(lastIdx, match.index))
    const m = match[1]
    if (m.startsWith('**')) {
      parts.push(<strong key={key++} style={{ color: 'var(--text)', fontWeight: 600 }}>{m.slice(2, -2)}</strong>)
    } else if (m.startsWith('`')) {
      parts.push(<code key={key++} style={{ background: 'var(--gold-soft)', padding: '1px 5px', borderRadius: 2, fontSize: 11, color: 'var(--gold)' }}>{m.slice(1, -1)}</code>)
    } else {
      parts.push(<em key={key++} style={{ color: 'var(--text-2)', fontStyle: 'italic' }}>{m.slice(1, -1)}</em>)
    }
    lastIdx = match.index + m.length
  }
  if (lastIdx < text.length) parts.push(text.slice(lastIdx))
  return parts
}

// \u2500\u2500\u2500 Markdown renderer \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function renderMarkdown(text: string): React.ReactNode[] {
  if (!text) return []
  const lines = text.split('\n')
  const out: React.ReactNode[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('## ')) {
      out.push(
        <h2 key={i} className="hybrid-serif" style={{ fontSize: 22, fontWeight: 500, color: 'var(--text)', marginTop: 34, marginBottom: 12, borderBottom: '1px solid var(--border-soft)', paddingBottom: 7, letterSpacing: '-0.005em' }}>
          {line.slice(3)}
        </h2>
      )
      continue
    }
    if (line.startsWith('### ')) {
      out.push(
        <h3 key={i} className="hybrid-serif" style={{ fontStyle: 'italic', fontSize: 16, fontWeight: 500, color: 'var(--gold)', marginTop: 24, marginBottom: 8 }}>
          {line.slice(4)}
        </h3>
      )
      continue
    }
    if (line.startsWith('---')) {
      out.push(<hr key={i} style={{ border: 'none', borderTop: '1px solid var(--border-soft)', margin: '28px 0' }} />)
      continue
    }
    if (line.startsWith('- ') || line.startsWith('\u2022 ')) {
      out.push(
        <div key={i} style={{ display: 'flex', gap: 10, margin: '5px 0', paddingLeft: 6 }}>
          <span style={{ color: 'var(--gold)', flexShrink: 0, fontWeight: 600 }}>\u00b7</span>
          <p style={{ fontSize: 14, lineHeight: 1.8, color: 'var(--text)', margin: 0 }}>{formatInline(line.replace(/^[-\u2022]\s+/, ''))}</p>
        </div>
      )
      continue
    }
    if (line.trim() === '') {
      out.push(<div key={i} style={{ height: 10 }} />)
      continue
    }
    // Regular narrative paragraph
    out.push(
      <p key={i} style={{ fontSize: 14, lineHeight: 1.9, color: 'var(--text)', margin: '6px 0', fontFamily: 'var(--font-sans)' }}>
        {formatInline(line)}
      </p>
    )
  }
  return out
}

// \u2500\u2500\u2500 Print popup HTML \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
function buildPrintHTML(briefDate: string, content: string): string {
  const date = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const rows: string[] = []
  for (const ln of content.split('\n')) {
    if (ln.startsWith('## '))       rows.push('<h2>' + ln.slice(3) + '</h2>')
    else if (ln.startsWith('### ')) rows.push('<h3>' + ln.slice(4) + '</h3>')
    else if (ln.startsWith('---'))  rows.push('<hr>')
    else if (ln.trim() === '')      rows.push('<br>')
    else rows.push('<p>' + ln.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>') + '</p>')
  }
  const css = "@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,500&family=DM+Sans:wght@400;500;600&display=swap');"
    + 'body{font-family:"DM Sans",Arial,sans-serif;font-size:11pt;line-height:1.85;color:#0f2947;background:#f5efe0;margin:0}'
    + '.ph{background:#0a1f3a;padding:34px 52px 30px;border-bottom:2px solid #b08b3e}'
    + '.firm{font-size:8.5pt;font-weight:600;letter-spacing:.22em;text-transform:uppercase;color:#b08b3e;margin-bottom:10px}'
    + '.title{font-family:"Cormorant Garamond",Georgia,serif;font-size:30pt;font-weight:500;color:#e8d9b5;line-height:1;margin-bottom:8px;letter-spacing:-0.01em}'
    + '.meta{font-size:10pt;color:rgba(232,217,181,0.65)}'
    + '.content{max-width:740px;margin:0 auto;padding:40px 52px 60px;background:#fffbf2}'
    + 'h2{font-family:"Cormorant Garamond",Georgia,serif;font-size:18pt;font-weight:500;color:#0f2947;border-bottom:1px solid rgba(15,41,71,0.1);padding-bottom:7px;margin:32px 0 12px;letter-spacing:-0.005em}'
    + 'h3{font-family:"Cormorant Garamond",Georgia,serif;font-style:italic;font-size:14pt;font-weight:500;color:#b08b3e;margin:22px 0 8px}'
    + 'p{margin:8px 0;color:#0f2947;font-size:11pt;line-height:1.85}'
    + 'strong{font-weight:600;color:#0f2947}em{color:#5c6573}'
    + 'hr{border:none;border-top:1px solid rgba(15,41,71,0.1);margin:26px 0}'
    + '.pbtn{position:fixed;top:16px;right:16px;background:#0a1f3a;color:#c9a556;border:none;border-radius:3px;padding:10px 18px;font-size:12px;cursor:pointer;font-family:"DM Sans",sans-serif;font-weight:600}'
    + '@media print{@page{size:A4;margin:16mm}.pbtn{display:none!important}body{background:white}'
    + '.ph{background:none!important;border-bottom:2px solid #b08b3e;padding:0 0 18px;margin-bottom:28px}'
    + '.title{color:#0f2947!important}.firm{color:#b08b3e!important}.meta{color:#5c6573!important}'
    + '.content{padding:0}}'
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>' + css + '</style></head><body>'
    + '<button class="pbtn" onclick="window.print()">Print / Save PDF</button>'
    + '<div class="ph"><div class="firm">Transworld Investment and Securities \u00b7 CIO Intelligence Brief</div>'
    + '<div class="title">Weekly CIO Brief</div>'
    + '<div class="meta">Week ending ' + briefDate + ' \u00b7 Generated ' + date + '</div></div>'
    + '<div class="content">' + rows.join('\n') + '</div>'
    + '</body></html>'
}

export default function CIOBriefPage() {
  const [history,     setHistory]     = useState<any[]>([])
  const [selected,    setSelected]    = useState<any>(null)
  const [generating,  setGenerating]  = useState(false)
  const [error,       setError]       = useState('')
  const [copied,      setCopied]      = useState(false)
  const [loadingHist, setLoadingHist] = useState(true)

  const loadHistory = useCallback(async () => {
    setLoadingHist(true)
    try {
      const res    = await fetch('/api/cio-brief')
      const d      = await res.json()
      const briefs = d.briefs ?? []
      setHistory(briefs)
      if (briefs.length > 0) setSelected(briefs[0])
    } catch { /* silent */ }
    setLoadingHist(false)
  }, [])

  useEffect(() => { loadHistory() }, [loadHistory])

  async function generate() {
    setGenerating(true)
    setError('')
    try {
      const res = await fetch('/api/cio-brief', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ generatedBy: 'manual' }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error)
      await loadHistory()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setGenerating(false)
    }
  }

  function printBrief() {
    if (!selected) return
    const html = buildPrintHTML(selected.brief_date, selected.content)
    const win  = window.open('', '_blank', 'width=980,height=820')
    if (win) { win.document.write(html); win.document.close() }
  }

  function copyBrief() {
    if (!selected) return
    navigator.clipboard.writeText(selected.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2500)
  }

  return (
    <div className="hybrid-page" style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>

      {/* \u2500\u2500 Left pane \u2500\u2500 */}
      <aside style={{ width: 276, flexShrink: 0, background: 'var(--card)', borderRight: '1px solid var(--border)', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        <div style={{ padding: '20px 18px 16px', borderBottom: '1px solid var(--border-soft)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <Radio size={13} style={{ color: 'var(--gold)' }} />
            <span style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.18em', color: 'var(--gold)' }}>CIO Intelligence Brief</span>
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-3)', lineHeight: 1.55, margin: 0 }}>
            Cross-portfolio weekly brief for the CIO conference call. Covers all active mandates with live market intelligence and web search.
          </p>
        </div>

        <div style={{ padding: '16px 18px', borderBottom: '1px solid var(--border-soft)' }}>
          <button
            onClick={generate}
            disabled={generating}
            className="btn-h btn-h-primary"
            style={{ width: '100%', justifyContent: 'center', padding: '11px 14px', gap: 8 }}
          >
            {generating ? (
              <>
                <div style={{ width: 11, height: 11, border: '2px solid rgba(232,217,181,0.25)', borderTopColor: 'var(--gold-bright)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
                Generating brief\u2026
              </>
            ) : (
              <><Sparkles size={13} /> Generate This Week&apos;s Brief</>
            )}
          </button>

          <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>

          {error && (
            <div className="alert-h alert-h-critical" style={{ marginTop: 10, fontSize: 11, lineHeight: 1.5 }}>
              \u26a0 {error}
            </div>
          )}
          {generating ? (
            <p style={{ marginTop: 10, fontSize: 10, color: 'var(--warn)', lineHeight: 1.5, fontWeight: 500 }}>
              \u23f3 Searching live market data and synthesising across all mandates \u2014 please wait, do not close this tab.
            </p>
          ) : (
            <p style={{ marginTop: 10, fontSize: 10, color: 'var(--text-3)', lineHeight: 1.5 }}>
              Searches live data for NGX, CBN, FX, and key holding news. Typically 60\u2013120 seconds.
            </p>
          )}
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          <div style={{ padding: '10px 18px 6px', fontSize: 9, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.18em', color: 'var(--text-3)' }}>
            History ({history.length})
          </div>
          {loadingHist && <div style={{ padding: '12px 18px', fontSize: 11, color: 'var(--text-3)' }}>Loading\u2026</div>}
          {!loadingHist && history.length === 0 && (
            <div style={{ padding: '16px 18px', fontSize: 11, color: 'var(--text-3)', lineHeight: 1.55 }}>
              No briefs yet. Generate your first CIO Brief above.
            </div>
          )}
          {history.map(b => {
            const isSelected = selected?.id === b.id
            const wkLabel    = new Date(b.brief_date + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })
            return (
              <div
                key={b.id}
                onClick={() => setSelected(b)}
                style={{ padding: '11px 18px', cursor: 'pointer', borderBottom: '1px solid var(--border-soft)', background: isSelected ? 'var(--gold-soft)' : 'transparent', borderLeft: isSelected ? '2px solid var(--gold)' : '2px solid transparent', transition: 'background 0.15s' }}
                onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = 'var(--bg-soft)' }}
                onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = 'transparent' }}
              >
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>Week of {wkLabel}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--text-3)', marginTop: 3 }}>
                  <Clock size={9} />
                  {new Date(b.created_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
            )
          })}
        </div>
      </aside>

      {/* \u2500\u2500 Main pane \u2500\u2500 */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {generating ? (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18, background: 'var(--bg)' }}>
            <div style={{ position: 'relative' }}>
              <div style={{ width: 58, height: 58, border: '2px solid var(--border-soft)', borderTopColor: 'var(--gold)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                <Radio size={20} style={{ color: 'var(--gold)' }} />
              </div>
            </div>
            <div style={{ textAlign: 'center', maxWidth: 400 }}>
              <div style={{ fontSize: 16, color: 'var(--text)', fontWeight: 500, marginBottom: 10 }}>Preparing your CIO Brief\u2026</div>
              <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.65, marginBottom: 6 }}>Searching live data \u00b7 NGX performance \u00b7 CBN signals \u00b7 FX levels \u00b7 key holding news</div>
              <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.65, marginBottom: 14 }}>Synthesising across all active mandates \u00b7 Building your conference call brief</div>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--warn)', padding: '8px 16px', borderRadius: 3, display: 'inline-block', background: 'rgba(166,124,42,0.1)', border: '1px solid rgba(166,124,42,0.25)' }}>
                \u23f3 60\u2013120 seconds \u2014 do not close this tab
              </div>
            </div>
          </div>

        ) : selected ? (
          <>
            <div style={{ padding: '14px 32px', borderBottom: '1px solid var(--border)', background: 'var(--card)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexShrink: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <Radio size={13} style={{ color: 'var(--gold)' }} />
                <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--text)' }}>CIO Weekly Brief</span>
                <span style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>week ending {selected.brief_date}</span>
                <span style={{ fontSize: 9, fontWeight: 600, letterSpacing: '0.14em', textTransform: 'uppercase' as const, padding: '3px 8px', borderRadius: 2, background: 'var(--gold-soft)', color: 'var(--gold)' }}>All Portfolios</span>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn-h" onClick={copyBrief}>
                  {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}
                </button>
                <button className="btn-h btn-h-primary" onClick={printBrief}>
                  <Printer size={12} /> Print / PDF
                </button>
              </div>
            </div>

            <div style={{ flex: 1, overflowY: 'auto', padding: '36px 44px', background: 'var(--bg)' }}>
              <div style={{ maxWidth: 900, margin: '0 auto', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 5, padding: '44px 56px 52px' }}>

                <div style={{ borderLeft: '3px solid var(--gold)', paddingLeft: 20, marginBottom: 36 }}>
                  <div style={{ fontSize: 9, letterSpacing: '0.22em', fontWeight: 600, textTransform: 'uppercase' as const, color: 'var(--gold)', marginBottom: 10 }}>
                    Transworld Investment and Securities \u00b7 CIO Intelligence Brief
                  </div>
                  <div className="hybrid-serif" style={{ fontSize: 32, fontWeight: 500, color: 'var(--text)', letterSpacing: '-0.01em', lineHeight: 1, marginBottom: 10 }}>
                    Weekly CIO Brief
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
                    Week ending {selected.brief_date} \u00b7 Generated {new Date(selected.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
                  </div>
                </div>

                {renderMarkdown(selected.content)}

                <div style={{ marginTop: 48, padding: '16px 20px', background: 'var(--gold-soft)', border: '1px solid rgba(176,139,62,0.2)', borderRadius: 4 }}>
                  <div style={{ fontSize: 9, color: 'var(--gold)', fontWeight: 600, letterSpacing: '0.14em', textTransform: 'uppercase' as const, marginBottom: 6 }}>Conference call tip</div>
                  <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.65 }}>
                    Print this brief and use each section as a natural segment of the CIO call. Market Overview opens the call; Outlook closes it. Key Holdings Intelligence is where clients will ask the most questions \u2014 have specific numbers ready.
                  </div>
                </div>
              </div>
            </div>
          </>

        ) : (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: 'var(--text-3)', background: 'var(--bg)' }}>
            <FileText size={38} style={{ marginBottom: 16, opacity: 0.3 }} />
            <div style={{ fontSize: 15, color: 'var(--text-2)', fontWeight: 500, marginBottom: 8 }}>Generate your first CIO Brief</div>
            <div style={{ fontSize: 12, maxWidth: 340, textAlign: 'center', lineHeight: 1.65 }}>
              Click \u201cGenerate This Week\u2019s Brief\u201d for a cross-portfolio intelligence brief powered by live market data \u2014 ready for your CIO conference call.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
