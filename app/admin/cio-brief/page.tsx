'use client'
import { useEffect, useState, useCallback } from 'react'
import { Clock, Sparkles, FileText, Printer, Copy, Check, Radio, Trash2 } from 'lucide-react'

// v21s-hotfix-3: Delete button added to CIO brief history panel.
// Trash icon (faint) on each item → click → inline confirm → DELETE API call.
// loadHistory accepts keepSelectedId so deleting a non-selected brief
// doesn't jump the user to the top of the list.

function formatInline(text: string): React.ReactNode[] {
  if (!text) return []
  const parts: React.ReactNode[] = []
  const regex = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`]+`)/g
  let lastIdx = 0, key = 0
  let match: RegExpExecArray | null
  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIdx) parts.push(text.slice(lastIdx, match.index))
    const m = match[1]
    if (m.startsWith('**'))
      parts.push(<strong key={key++} style={{ color: 'var(--text)', fontWeight: 700 }}>{m.slice(2, -2)}</strong>)
    else if (m.startsWith('`'))
      parts.push(<code key={key++} style={{ background: 'var(--gold-soft)', padding: '1px 5px', borderRadius: 2, fontSize: 11, color: 'var(--gold)' }}>{m.slice(1, -1)}</code>)
    else
      parts.push(<em key={key++} style={{ color: 'var(--text-2)', fontStyle: 'italic' }}>{m.slice(1, -1)}</em>)
    lastIdx = match.index + m.length
  }
  if (lastIdx < text.length) parts.push(text.slice(lastIdx))
  return parts
}

function normalizeParagraphs(text: string): string {
  const lines = text.split('\n')
  const out: string[] = []
  let buf = ''
  const isSpecial = (l: string) =>
    l.startsWith('## ') || l.startsWith('### ') || l.startsWith('#### ') ||
    l.startsWith('---') || l.startsWith('- ') || l.startsWith('\u2022 ') ||
    l.startsWith('> ')  || l.startsWith('| ') || l.trim() === ''
  for (const line of lines) {
    if (isSpecial(line)) { if (buf) { out.push(buf); buf = '' }; out.push(line) }
    else { buf = buf ? buf + ' ' + line.trim() : line }
  }
  if (buf) out.push(buf)
  return out.join('\n')
}

type Block =
  | { t: 'h2'; text: string } | { t: 'h3'; text: string } | { t: 'h4'; text: string }
  | { t: 'hr' } | { t: 'blank' } | { t: 'p'; text: string }
  | { t: 'li'; text: string } | { t: 'bq'; text: string }
  | { t: 'table'; headers: string[]; rows: string[][] }

function parseBlocks(raw: string): Block[] {
  const lines = normalizeParagraphs(raw).split('\n')
  const blocks: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if      (line.startsWith('## '))        { blocks.push({ t: 'h2', text: line.slice(3) });  i++ }
    else if (line.startsWith('### '))       { blocks.push({ t: 'h3', text: line.slice(4) });  i++ }
    else if (line.startsWith('#### '))      { blocks.push({ t: 'h4', text: line.slice(5) });  i++ }
    else if (line.startsWith('---'))        { blocks.push({ t: 'hr' });                        i++ }
    else if (line.trim() === '')            { blocks.push({ t: 'blank' });                     i++ }
    else if (line.startsWith('- ') || line.startsWith('\u2022 ')) {
      blocks.push({ t: 'li', text: line.replace(/^[-\u2022]\s+/, '') }); i++
    }
    else if (line.startsWith('> '))         { blocks.push({ t: 'bq', text: line.slice(2) });  i++ }
    else if (line.startsWith('| ')) {
      const tbl: string[] = []
      while (i < lines.length && lines[i].startsWith('| ')) { tbl.push(lines[i]); i++ }
      const nonSep  = tbl.filter(l => l.replace(/[\s\-|]/g, '') !== '')
      const headers = nonSep[0]?.split('|').filter(c => c.trim()).map(c => c.trim()) ?? []
      const rows    = nonSep.slice(1).map(l => l.split('|').filter(c => c.trim()).map(c => c.trim()))
      blocks.push({ t: 'table', headers, rows })
    }
    else { blocks.push({ t: 'p', text: line }); i++ }
  }
  return blocks
}

function renderMarkdown(raw: string): React.ReactNode[] {
  return parseBlocks(raw).flatMap((block, i): React.ReactNode[] => {
    switch (block.t) {
      case 'h2': return [<h2 key={i} className="hybrid-serif" style={{ fontSize: 21, fontWeight: 500, color: 'var(--text)', marginTop: 36, marginBottom: 4, borderBottom: '2px solid var(--gold)', paddingBottom: 8, letterSpacing: '-0.005em' }}>{block.text}</h2>]
      case 'h3': return [<h3 key={i} className="hybrid-serif" style={{ fontStyle: 'italic', fontSize: 16, fontWeight: 500, color: 'var(--gold)', marginTop: 26, marginBottom: 6 }}>{block.text}</h3>]
      case 'h4': return [<h4 key={i} style={{ fontSize: 12, fontWeight: 700, color: 'var(--text)', textTransform: 'uppercase' as const, letterSpacing: '0.1em', marginTop: 22, marginBottom: 5, borderLeft: '3px solid var(--gold)', paddingLeft: 10 }}>{block.text}</h4>]
      case 'hr':    return [<hr key={i} style={{ border: 'none', borderTop: '1px solid var(--border-soft)', margin: '30px 0' }} />]
      case 'blank': return [<div key={i} style={{ height: 8 }} />]
      case 'p':     return [<p key={i} style={{ fontSize: 13.5, lineHeight: 1.9, color: 'var(--text)', margin: '8px 0', textAlign: 'justify' as const }}>{formatInline(block.text)}</p>]
      case 'li':    return [<div key={i} style={{ display: 'flex', gap: 10, margin: '5px 0 5px 10px' }}><span style={{ color: 'var(--gold)', flexShrink: 0, fontWeight: 700, marginTop: 2 }}>\u00b7</span><p style={{ fontSize: 13.5, lineHeight: 1.85, color: 'var(--text)', margin: 0, textAlign: 'justify' as const }}>{formatInline(block.text)}</p></div>]
      case 'bq':    return [<div key={i} style={{ borderLeft: '3px solid var(--gold)', background: 'linear-gradient(90deg,rgba(176,139,62,0.08) 0%,rgba(176,139,62,0.03) 100%)', padding: '10px 16px', margin: '5px 0', borderRadius: '0 4px 4px 0' }}><p style={{ fontSize: 13, color: 'var(--text)', margin: 0, fontWeight: 500 }}>{formatInline(block.text)}</p></div>]
      case 'table': return [<div key={i} style={{ overflowX: 'auto', margin: '20px 0', borderRadius: 4, border: '1px solid var(--border)', boxShadow: '0 1px 4px rgba(15,41,71,0.06)' }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12.5 }}>{block.headers.length > 0 && <thead><tr style={{ background: 'var(--sidebar-bg)' }}>{block.headers.map((h, j) => <th key={j} style={{ padding: '10px 14px', textAlign: 'left' as const, color: 'var(--gold-bright)', fontWeight: 600, fontSize: 10, textTransform: 'uppercase' as const, letterSpacing: '0.14em', whiteSpace: 'nowrap' as const }}>{h}</th>)}</tr></thead>}<tbody>{block.rows.map((row, ri) => <tr key={ri} style={{ background: ri % 2 === 0 ? 'var(--bg-soft)' : 'var(--card)' }}>{row.map((cell, ci) => <td key={ci} style={{ padding: '9px 14px', borderBottom: ri < block.rows.length-1 ? '1px solid var(--border-soft)' : 'none', color: ci===0?'var(--text)':'var(--text-2)', fontWeight: ci===0?500:400 }}>{formatInline(cell)}</td>)}</tr>)}</tbody></table></div>]
      default: return []
    }
  })
}

function buildPrintHTML(briefDate: string, content: string): string {
  const date = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
  const applyInline = (s: string) => s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>')
  const lines = normalizeParagraphs(content).split('\n')
  const html: string[] = []
  let i = 0
  while (i < lines.length) {
    const ln = lines[i]
    if      (ln.startsWith('## '))       html.push('<h2>' + applyInline(ln.slice(3)) + '</h2>')
    else if (ln.startsWith('### '))      html.push('<h3>' + applyInline(ln.slice(4)) + '</h3>')
    else if (ln.startsWith('#### '))     html.push('<h4>' + applyInline(ln.slice(5)) + '</h4>')
    else if (ln.startsWith('---'))       html.push('<hr>')
    else if (ln.trim() === '')           html.push('<div class="gap"></div>')
    else if (ln.startsWith('> '))        html.push('<div class="callout">' + applyInline(ln.slice(2)) + '</div>')
    else if (ln.startsWith('| ')) {
      const tbl: string[] = []
      while (i < lines.length && lines[i].startsWith('| ')) { tbl.push(lines[i]); i++ }
      i--
      const nonSep  = tbl.filter(l => l.replace(/[\s\-|]/g, '') !== '')
      const headers = nonSep[0]?.split('|').filter(c => c.trim()) ?? []
      const rows2   = nonSep.slice(1).map(l => l.split('|').filter(c => c.trim()))
      let t = '<table><thead><tr>'
      headers.forEach(h => { t += '<th>' + applyInline(h.trim()) + '</th>' })
      t += '</tr></thead><tbody>'
      rows2.forEach((row, ri) => {
        t += '<tr class="' + (ri % 2 === 0 ? 'even' : 'odd') + '">'
        row.forEach((cell, ci) => { t += '<td class="' + (ci === 0 ? 'first' : '') + '">' + applyInline(cell.trim()) + '</td>' })
        t += '</tr>'
      })
      t += '</tbody></table>'
      html.push(t)
    }
    else html.push('<p>' + applyInline(ln) + '</p>')
    i++
  }
  const css = "@import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,500&family=DM+Sans:wght@400;500;600&display=swap');"
    + 'body{font-family:"DM Sans",Arial,sans-serif;font-size:11pt;line-height:1.85;color:#0f2947;background:#f5efe0;margin:0}'
    + '.ph{background:#0a1f3a;padding:34px 52px 30px;border-bottom:2px solid #b08b3e}'
    + '.firm{font-size:8pt;font-weight:600;letter-spacing:.22em;text-transform:uppercase;color:#b08b3e;margin-bottom:10px}'
    + '.title{font-family:"Cormorant Garamond",Georgia,serif;font-size:30pt;font-weight:500;color:#e8d9b5;line-height:1;margin-bottom:8px}'
    + '.meta{font-size:10pt;color:rgba(232,217,181,0.65)}'
    + '.content{max-width:740px;margin:0 auto;padding:40px 52px 60px;background:#fffbf2}'
    + 'h2{font-family:"Cormorant Garamond",Georgia,serif;font-size:17pt;font-weight:500;color:#0f2947;border-bottom:2px solid #b08b3e;padding-bottom:6px;margin:32px 0 12px}'
    + 'h3{font-family:"Cormorant Garamond",Georgia,serif;font-style:italic;font-size:13pt;font-weight:500;color:#b08b3e;margin:22px 0 7px}'
    + 'h4{font-size:9.5pt;font-weight:700;color:#0f2947;text-transform:uppercase;letter-spacing:0.1em;margin:18px 0 5px;border-left:3px solid #b08b3e;padding-left:8px}'
    + 'p{margin:7px 0;color:#0f2947;font-size:11pt;line-height:1.85;text-align:justify}'
    + 'strong{font-weight:700;color:#0f2947}em{color:#5c6573}'
    + 'hr{border:none;border-top:1px solid rgba(15,41,71,0.12);margin:24px 0}.gap{height:8px}'
    + '.callout{border-left:3px solid #b08b3e;background:rgba(176,139,62,0.07);padding:9px 14px;margin:5px 0;border-radius:0 3px 3px 0;font-weight:500;font-size:10.5pt}'
    + 'table{width:100%;border-collapse:collapse;margin:16px 0;font-size:9.5pt;page-break-inside:avoid}'
    + 'thead tr{background:#0a1f3a}th{padding:9px 12px;text-align:left;color:#c9a556;font-weight:600;font-size:8pt;text-transform:uppercase;letter-spacing:0.12em}'
    + 'td{padding:8px 12px;border-bottom:1px solid rgba(15,41,71,0.07)}tr.even td{background:#faf5ea}tr.odd td{background:#fffbf2}td.first{font-weight:600}'
    + '.pbtn{position:fixed;top:16px;right:16px;background:#0a1f3a;color:#c9a556;border:none;border-radius:3px;padding:10px 18px;font-size:12px;cursor:pointer;font-family:"DM Sans",sans-serif;font-weight:600}'
    + '@media print{@page{size:A4;margin:15mm}.pbtn{display:none!important}body{background:white}.ph{background:none!important;border-bottom:2px solid #b08b3e;padding:0 0 18px;margin-bottom:24px}.title{color:#0f2947!important}.firm{color:#b08b3e!important}.meta{color:#5c6573!important}.content{padding:0}thead tr{background:#0a1f3a!important;-webkit-print-color-adjust:exact;print-color-adjust:exact}}'
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"><style>' + css + '</style></head><body>'
    + '<button class="pbtn" onclick="window.print()">Print / Save PDF</button>'
    + '<div class="ph"><div class="firm">Transworld Investment and Securities \u00b7 CIO Intelligence Brief</div>'
    + '<div class="title">Weekly CIO Brief</div>'
    + '<div class="meta">Week ending ' + briefDate + ' \u00b7 Generated ' + date + '</div></div>'
    + '<div class="content">' + html.join('\n') + '</div>'
    + '</body></html>'
}

export default function CIOBriefPage() {
  const [history,         setHistory]         = useState<any[]>([])
  const [selected,        setSelected]        = useState<any>(null)
  const [generating,      setGenerating]      = useState(false)
  const [error,           setError]           = useState('')
  const [copied,          setCopied]          = useState(false)
  const [loadingHist,     setLoadingHist]     = useState(true)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [deleting,        setDeleting]        = useState(false)

  const loadHistory = useCallback(async (keepSelectedId?: string) => {
    setLoadingHist(true)
    try {
      const d      = await fetch('/api/cio-brief').then(r => r.json())
      const briefs = d.briefs ?? []
      setHistory(briefs)
      if (keepSelectedId) {
        const kept = briefs.find((b: any) => b.id === keepSelectedId)
        setSelected(kept ?? briefs[0] ?? null)
      } else if (briefs.length > 0) {
        setSelected(briefs[0])
      } else {
        setSelected(null)
      }
    } catch { /* silent */ }
    setLoadingHist(false)
  }, [])

  async function handleDelete(id: string) {
    setDeleting(true)
    try {
      const res = await fetch('/api/cio-brief?id=' + encodeURIComponent(id), { method: 'DELETE' })
      if (res.ok) {
        setConfirmDeleteId(null)
        // If deleting the currently-viewed brief, auto-select next.
        // If deleting a different one, preserve the current view.
        await loadHistory(selected?.id === id ? undefined : selected?.id)
      }
    } catch { /* silent */ }
    setDeleting(false)
  }

  useEffect(() => { loadHistory() }, [loadHistory])

  async function generate() {
    setGenerating(true); setError('')
    try {
      const res = await fetch('/api/cio-brief', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ generatedBy: 'manual' }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error)
      await loadHistory()
    } catch (e) { setError((e as Error).message) }
    finally { setGenerating(false) }
  }

  function printBrief() {
    if (!selected) return
    const win = window.open('', '_blank', 'width=980,height=820')
    if (win) { win.document.write(buildPrintHTML(selected.brief_date, selected.content)); win.document.close() }
  }

  function copyBrief() {
    if (!selected) return
    navigator.clipboard.writeText(selected.content)
    setCopied(true); setTimeout(() => setCopied(false), 2500)
  }

  return (
    <div className="hybrid-page" style={{ display: 'flex', height: '100%', overflow: 'hidden' }}>

      {/* Left pane */}
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
          <button onClick={generate} disabled={generating} className="btn-h btn-h-primary" style={{ width: '100%', justifyContent: 'center', padding: '11px 14px', gap: 8 }}>
            {generating
              ? <><div style={{ width: 11, height: 11, border: '2px solid rgba(232,217,181,0.25)', borderTopColor: 'var(--gold-bright)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />Generating brief&#8230;</>
              : <><Sparkles size={13} />Generate This Week&apos;s Brief</>}
          </button>
          <style>{`@keyframes spin { to { transform: rotate(360deg) } }`}</style>
          {error && <div className="alert-h alert-h-critical" style={{ marginTop: 10, fontSize: 11, lineHeight: 1.5 }}>&#9888; {error}</div>}
          {generating
            ? <p style={{ marginTop: 10, fontSize: 10, color: 'var(--warn)', lineHeight: 1.5, fontWeight: 500 }}>&#8987; Searching live market data &#8212; please wait, do not close this tab.</p>
            : <p style={{ marginTop: 10, fontSize: 10, color: 'var(--text-3)', lineHeight: 1.5 }}>Searches live data for NGX, CBN, FX, and key holding news. Typically 60&#8211;120 seconds.</p>
          }
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          <div style={{ padding: '10px 18px 6px', fontSize: 9, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: '0.18em', color: 'var(--text-3)' }}>
            History ({history.length})
          </div>
          {loadingHist && <div style={{ padding: '12px 18px', fontSize: 11, color: 'var(--text-3)' }}>Loading&#8230;</div>}
          {!loadingHist && history.length === 0 && <div style={{ padding: '16px 18px', fontSize: 11, color: 'var(--text-3)', lineHeight: 1.55 }}>No briefs yet. Generate your first CIO Brief above.</div>}

          {history.map(b => {
            const isSel     = selected?.id === b.id
            const isConfirm = confirmDeleteId === b.id
            const wkLabel   = new Date(b.brief_date + 'T00:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: '2-digit' })
            return (
              <div key={b.id}
                style={{ padding: '11px 18px', borderBottom: '1px solid var(--border-soft)', background: isSel ? 'var(--gold-soft)' : 'transparent', borderLeft: isSel ? '2px solid var(--gold)' : '2px solid transparent', transition: 'background 0.15s', position: 'relative' as const }}
                onMouseEnter={e => { if (!isSel) e.currentTarget.style.background = 'var(--bg-soft)' }}
                onMouseLeave={e => { if (!isSel && !isConfirm) e.currentTarget.style.background = 'transparent' }}
              >
                {isConfirm ? (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{ fontSize: 11, color: 'var(--neg)', fontWeight: 600, flex: 1 }}>Delete this brief?</span>
                    <button onClick={e => { e.stopPropagation(); handleDelete(b.id) }} disabled={deleting}
                      style={{ fontSize: 10, fontWeight: 700, color: 'var(--neg)', background: 'rgba(166,59,59,0.1)', border: '1px solid var(--neg)', borderRadius: 2, padding: '3px 8px', cursor: 'pointer', fontFamily: 'inherit' }}>
                      {deleting ? '\u2026' : 'Delete'}
                    </button>
                    <button onClick={e => { e.stopPropagation(); setConfirmDeleteId(null) }}
                      style={{ fontSize: 10, color: 'var(--text-3)', background: 'transparent', border: '1px solid var(--border)', borderRadius: 2, padding: '3px 8px', cursor: 'pointer', fontFamily: 'inherit' }}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <>
                    <div onClick={() => setSelected(b)} style={{ cursor: 'pointer' }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text)' }}>Week of {wkLabel}</div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: 'var(--text-3)', marginTop: 3 }}>
                        <Clock size={9} />
                        {new Date(b.created_at).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
                      </div>
                    </div>
                    <button onClick={e => { e.stopPropagation(); setConfirmDeleteId(b.id) }} title="Delete brief"
                      style={{ position: 'absolute' as const, top: '50%', right: 10, transform: 'translateY(-50%)', background: 'transparent', border: 'none', cursor: 'pointer', color: 'var(--text-4)', padding: 4, borderRadius: 2, display: 'flex', alignItems: 'center', opacity: 0.35, transition: 'opacity 0.15s, color 0.15s' }}
                      onMouseEnter={e => { e.currentTarget.style.opacity = '1'; e.currentTarget.style.color = 'var(--neg)' }}
                      onMouseLeave={e => { e.currentTarget.style.opacity = '0.35'; e.currentTarget.style.color = 'var(--text-4)' }}>
                      <Trash2 size={12} />
                    </button>
                  </>
                )}
              </div>
            )
          })}
        </div>
      </aside>

      {/* Main pane */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {generating ? (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 18, background: 'var(--bg)' }}>
            <div style={{ position: 'relative' }}>
              <div style={{ width: 58, height: 58, border: '2px solid var(--border-soft)', borderTopColor: 'var(--gold)', borderRadius: '50%', animation: 'spin 0.7s linear infinite' }} />
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Radio size={20} style={{ color: 'var(--gold)' }} /></div>
            </div>
            <div style={{ textAlign: 'center', maxWidth: 400 }}>
              <div style={{ fontSize: 16, color: 'var(--text)', fontWeight: 500, marginBottom: 10 }}>Preparing your CIO Brief&#8230;</div>
              <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.65, marginBottom: 6 }}>Searching live data &#183; NGX &#183; CBN &#183; FX &#183; key holding news</div>
              <div style={{ fontSize: 12, color: 'var(--text-3)', lineHeight: 1.65, marginBottom: 14 }}>Synthesising across all active mandates</div>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--warn)', padding: '8px 16px', borderRadius: 3, display: 'inline-block', background: 'rgba(166,124,42,0.1)', border: '1px solid rgba(166,124,42,0.25)' }}>
                &#8987; 60&#8211;120 seconds &#8212; do not close this tab
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
                <button className="btn-h" onClick={copyBrief}>{copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy</>}</button>
                <button className="btn-h btn-h-primary" onClick={printBrief}><Printer size={12} /> Print / PDF</button>
              </div>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '36px 44px', background: 'var(--bg)' }}>
              <div style={{ maxWidth: 900, margin: '0 auto', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 5, padding: '44px 56px 52px' }}>
                <div style={{ background: 'var(--sidebar-bg)', margin: '-44px -56px 36px', padding: '32px 56px 28px', borderBottom: '2px solid var(--gold)', borderRadius: '5px 5px 0 0' }}>
                  <div style={{ fontSize: 9, letterSpacing: '0.22em', fontWeight: 600, textTransform: 'uppercase' as const, color: 'var(--gold)', marginBottom: 10 }}>
                    Transworld Investment and Securities &#183; CIO Intelligence Brief
                  </div>
                  <div className="hybrid-serif" style={{ fontSize: 34, fontWeight: 500, color: '#e8d9b5', letterSpacing: '-0.01em', lineHeight: 1, marginBottom: 10 }}>
                    Weekly CIO Brief
                  </div>
                  <div style={{ fontSize: 11.5, color: 'rgba(232,217,181,0.65)', fontFamily: 'var(--font-mono)' }}>
                    Week ending {selected.brief_date} &#183; Generated {new Date(selected.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
                  </div>
                </div>
                {renderMarkdown(selected.content)}
                <div style={{ marginTop: 48, padding: '16px 20px', background: 'var(--gold-soft)', border: '1px solid rgba(176,139,62,0.2)', borderRadius: 4 }}>
                  <div style={{ fontSize: 9, color: 'var(--gold)', fontWeight: 600, letterSpacing: '0.14em', textTransform: 'uppercase' as const, marginBottom: 5 }}>Conference call tip</div>
                  <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.65 }}>
                    Print this brief and use each section as a natural call segment. Market Snapshot opens with the numbers; Market Overview tells the story. Corporate Intelligence is where clients will ask the most questions.
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
              Click &#8220;Generate This Week&#8217;s Brief&#8221; for a cross-portfolio intelligence brief powered by live market data.
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
