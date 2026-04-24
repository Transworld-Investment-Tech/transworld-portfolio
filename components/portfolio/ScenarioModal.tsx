'use client'

import { useState, useRef, useEffect, useCallback } from 'react'
import { Sparkles, X, Copy, Save, RefreshCw, Check } from 'lucide-react'
import { supabase } from '@/lib/supabase'

// v21y: Portfolio Scenario Analysis modal.
//
// Ephemeral by default — results disappear when modal closes unless the user
// explicitly saves them to the reports table (report_type = 'scenario', added
// to the CHECK constraint via the v21y companion SQL).
//
// Streams markdown from /api/portfolio/[id]/scenario as NDJSON:
//   { t: 'delta', x: '...' }  — progressive chunks during generation
//   { t: 'final', x: '...' }  — shape-aware-joined clean content at end
//   { t: 'error', x: '...' }
//
// The final message replaces accumulated deltas, so transient artifacts from
// web_search block-splitting (pitfall #68/#69) are cleaned up at completion.

interface ScenarioModalProps {
  portfolioId:   string
  portfolioName: string
  clientName:    string
  onClose:       () => void
}

const PRESETS: { label: string; prompt: string }[] = [
  {
    label:  'Add ₦10M cash',
    prompt: 'The client has ₦10M in additional cash to deploy into this portfolio. Where should it go and why? Recommend specific allocations across tickers and fixed income instruments with concrete naira amounts.',
  },
  {
    label:  'CBN cuts MPR 200bps',
    prompt: 'Model the impact if the CBN cuts the Monetary Policy Rate by 200 basis points over the next two MPC meetings. Which holdings benefit, which are exposed, and what rebalancing actions should we take?',
  },
  {
    label:  '12-month forward projection',
    prompt: 'Provide a 12-month forward projection for this portfolio under a realistic base-case Nigerian macro environment. Give an expected return range, the main drivers, and the key risks to that projection.',
  },
  {
    label:  '20% NGX correction',
    prompt: 'Stress-test the portfolio against a 20% NGX All-Share Index correction over a 3-month window. Identify the most and least exposed holdings, expected drawdown, and defensive actions worth considering.',
  },
]

// ─── Minimal block-based markdown renderer ──────────────────────────────────
// Handles h2/h3/h4, paragraphs, bullet lists, numbered lists, tables, inline
// **bold** and *italic*, inline `code`. Sufficient for scenario output.

type Block =
  | { kind: 'h2';    text: string }
  | { kind: 'h3';    text: string }
  | { kind: 'h4';    text: string }
  | { kind: 'p';     text: string }
  | { kind: 'ul';    items: string[] }
  | { kind: 'ol';    items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'table'; rows: string[][] }
  | { kind: 'hr' }

function normaliseParagraphs(md: string): string {
  // Collapse single-newline-separated prose lines into a single line per
  // paragraph so that AI output wrapped at ~80 chars renders as flowing prose.
  const lines = md.split('\n')
  const out: string[] = []
  let buf = ''
  const flush = () => { if (buf) { out.push(buf); buf = '' } }
  for (const raw of lines) {
    const line = raw
    const isBlockStart =
      /^#{2,4}\s/.test(line) ||
      /^\s*[-*\u2022]\s/.test(line) ||
      /^\s*\d+\.\s/.test(line) ||
      /^\s*>\s/.test(line) ||
      /^\s*\|/.test(line) ||
      /^\s*---\s*$/.test(line) ||
      line.trim() === ''

    if (isBlockStart) {
      flush()
      out.push(line)
    } else {
      buf = buf ? (buf + ' ' + line.trim()) : line
    }
  }
  flush()
  return out.join('\n')
}

function parseBlocks(md: string): Block[] {
  const text   = normaliseParagraphs(md)
  const lines  = text.split('\n')
  const out: Block[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    if (line.trim() === '') { i++; continue }

    if (/^##\s/.test(line))  { out.push({ kind: 'h2', text: line.replace(/^##\s+/, '')  }); i++; continue }
    if (/^###\s/.test(line)) { out.push({ kind: 'h3', text: line.replace(/^###\s+/, '') }); i++; continue }
    if (/^####\s/.test(line)){ out.push({ kind: 'h4', text: line.replace(/^####\s+/, '')}); i++; continue }
    if (/^\s*---\s*$/.test(line)) { out.push({ kind: 'hr' }); i++; continue }

    // Table
    if (/^\s*\|/.test(line) && i + 1 < lines.length && /^\s*\|[\s\-:|]+\|\s*$/.test(lines[i+1])) {
      const rows: string[][] = []
      const header = line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
      rows.push(header)
      i += 2 // skip separator
      while (i < lines.length && /^\s*\|/.test(lines[i])) {
        const body = lines[i].trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
        rows.push(body)
        i++
      }
      out.push({ kind: 'table', rows })
      continue
    }

    // Blockquote
    if (/^\s*>\s/.test(line)) {
      const quoteLines: string[] = []
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^\s*>\s?/, ''))
        i++
      }
      out.push({ kind: 'quote', text: quoteLines.join(' ') })
      continue
    }

    // Bullet list
    if (/^\s*[-*\u2022]\s/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*\u2022]\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*\u2022]\s+/, ''))
        i++
      }
      out.push({ kind: 'ul', items })
      continue
    }

    // Numbered list
    if (/^\s*\d+\.\s/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+\.\s/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''))
        i++
      }
      out.push({ kind: 'ol', items })
      continue
    }

    // Paragraph
    out.push({ kind: 'p', text: line })
    i++
  }
  return out
}

function renderInline(s: string): (string | JSX.Element)[] {
  // Handle **bold**, *italic*, `code` in a simple pass.
  const parts: (string | JSX.Element)[] = []
  const re = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/g
  let lastIdx = 0
  let m: RegExpExecArray | null
  let key = 0
  while ((m = re.exec(s)) !== null) {
    if (m.index > lastIdx) parts.push(s.slice(lastIdx, m.index))
    const tok = m[0]
    if (tok.startsWith('**')) {
      parts.push(<strong key={key++} style={{ fontWeight: 600, color: 'var(--text)' }}>{tok.slice(2, -2)}</strong>)
    } else if (tok.startsWith('*')) {
      parts.push(<em key={key++}>{tok.slice(1, -1)}</em>)
    } else {
      parts.push(<code key={key++} style={{ fontFamily: 'var(--font-mono, monospace)', fontSize: '0.92em', background: 'var(--bg-soft)', padding: '1px 5px', borderRadius: 3 }}>{tok.slice(1, -1)}</code>)
    }
    lastIdx = m.index + tok.length
  }
  if (lastIdx < s.length) parts.push(s.slice(lastIdx))
  return parts
}

function RenderedMarkdown({ md }: { md: string }) {
  const blocks = parseBlocks(md)
  return (
    <div style={{ fontSize: 14, lineHeight: 1.65, color: 'var(--text)' }}>
      {blocks.map((b, i) => {
        switch (b.kind) {
          case 'h2':
            return (
              <h2 key={i} className="hybrid-serif" style={{
                fontSize: 22, fontWeight: 500, letterSpacing: '-0.01em',
                color: 'var(--text)', marginTop: i === 0 ? 0 : 22, marginBottom: 10,
                paddingBottom: 6, borderBottom: '1px solid var(--border-soft)',
              }}>{renderInline(b.text)}</h2>
            )
          case 'h3':
            return <h3 key={i} className="hybrid-serif" style={{ fontSize: 17, fontWeight: 500, color: 'var(--text)', marginTop: 16, marginBottom: 8 }}>{renderInline(b.text)}</h3>
          case 'h4':
            return <h4 key={i} style={{ fontSize: 13, fontWeight: 600, letterSpacing: '0.04em', color: 'var(--text-2)', textTransform: 'uppercase', marginTop: 14, marginBottom: 6 }}>{renderInline(b.text)}</h4>
          case 'p':
            return <p key={i} style={{ margin: '0 0 12px 0', textAlign: 'justify' }}>{renderInline(b.text)}</p>
          case 'ul':
            return (
              <ul key={i} style={{ margin: '0 0 12px 0', paddingLeft: 22 }}>
                {b.items.map((it, j) => <li key={j} style={{ marginBottom: 4 }}>{renderInline(it)}</li>)}
              </ul>
            )
          case 'ol':
            return (
              <ol key={i} style={{ margin: '0 0 12px 0', paddingLeft: 22 }}>
                {b.items.map((it, j) => <li key={j} style={{ marginBottom: 4 }}>{renderInline(it)}</li>)}
              </ol>
            )
          case 'quote':
            return (
              <div key={i} style={{
                margin: '0 0 12px 0', padding: '10px 14px', borderLeft: '3px solid var(--gold)',
                background: 'var(--gold-soft)', fontSize: 13.5,
              }}>{renderInline(b.text)}</div>
            )
          case 'table':
            return (
              <div key={i} style={{ overflowX: 'auto', margin: '0 0 14px 0' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                  <thead>
                    <tr>
                      {b.rows[0].map((h, j) => (
                        <th key={j} style={{
                          textAlign: 'left', padding: '8px 10px',
                          fontSize: 10, letterSpacing: '0.12em', fontWeight: 600,
                          color: 'var(--sidebar-text)', textTransform: 'uppercase',
                          background: 'var(--sidebar-bg)', borderBottom: '1px solid var(--sidebar-bg)',
                        }}>{renderInline(h)}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.slice(1).map((row, r) => (
                      <tr key={r} style={{ background: r % 2 === 0 ? 'var(--card)' : 'var(--bg-soft)' }}>
                        {row.map((c, j) => (
                          <td key={j} style={{ padding: '8px 10px', borderBottom: '1px solid var(--border-soft)', verticalAlign: 'top' }}>
                            {renderInline(c)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          case 'hr':
            return <hr key={i} style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '18px 0' }} />
        }
      })}
    </div>
  )
}

// ─── Modal component ────────────────────────────────────────────────────────

type Phase = 'input' | 'streaming' | 'done' | 'error'

export default function ScenarioModal({ portfolioId, portfolioName, clientName, onClose }: ScenarioModalProps) {
  const [scenarioText, setScenarioText] = useState('')
  const [phase,        setPhase]        = useState<Phase>('input')
  const [streamed,     setStreamed]     = useState('')
  const [finalContent, setFinalContent] = useState('')
  const [errorMsg,     setErrorMsg]     = useState('')
  const [saving,       setSaving]       = useState(false)
  const [saved,        setSaved]        = useState(false)
  const [copied,       setCopied]       = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const taRef    = useRef<HTMLTextAreaElement | null>(null)

  // Close on Esc
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') handleClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleClose = useCallback(() => {
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null }
    onClose()
  }, [onClose])

  function applyPreset(prompt: string) {
    setScenarioText(prompt)
    taRef.current?.focus()
  }

  async function handleSubmit() {
    if (!scenarioText.trim() || phase === 'streaming') return
    setPhase('streaming')
    setStreamed('')
    setFinalContent('')
    setErrorMsg('')
    setSaved(false)
    setCopied(false)

    const ac = new AbortController()
    abortRef.current = ac

    try {
      const res = await fetch(`/api/portfolio/${portfolioId}/scenario`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ scenario: scenarioText.trim() }),
        signal:  ac.signal,
      })

      if (!res.ok || !res.body) {
        const e = await res.json().catch(() => ({}))
        throw new Error(e.error || `HTTP ${res.status}`)
      }

      const reader  = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      let streamedAccum = ''
      let finalSeen = ''

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (!trimmed) continue
          try {
            const msg = JSON.parse(trimmed) as { t: string; x: string }
            if (msg.t === 'delta') {
              streamedAccum += msg.x
              setStreamed(streamedAccum)
            } else if (msg.t === 'final') {
              finalSeen = msg.x
              setFinalContent(msg.x)
            } else if (msg.t === 'error') {
              throw new Error(msg.x)
            }
          } catch (parseErr) {
            // Tolerate a malformed line; continue.
          }
        }
      }

      if (!finalSeen) setFinalContent(streamedAccum)
      setPhase('done')
    } catch (err: any) {
      if (err?.name === 'AbortError') return
      setErrorMsg(err.message || 'Scenario generation failed')
      setPhase('error')
    } finally {
      abortRef.current = null
    }
  }

  function resetToInput() {
    setPhase('input')
    setStreamed('')
    setFinalContent('')
    setErrorMsg('')
    setSaved(false)
    setCopied(false)
  }

  async function handleCopy() {
    const md = finalContent || streamed
    if (!md) return
    try {
      await navigator.clipboard.writeText(md)
      setCopied(true)
      setTimeout(() => setCopied(false), 2500)
    } catch { /* noop */ }
  }

  async function handleSave() {
    const md = finalContent || streamed
    if (!md || saving || saved) return
    setSaving(true)
    try {
      const today = new Date().toISOString().slice(0, 10)
      const { error } = await (supabase.from('reports') as any).insert({
        portfolio_id: portfolioId,
        report_type:  'scenario',
        report_date:  today,
        content:      md,
      })
      if (error) throw error
      setSaved(true)
    } catch (err: any) {
      setErrorMsg(err.message || 'Save failed')
    } finally {
      setSaving(false)
    }
  }

  const displayContent = finalContent || streamed

  return (
    <div
      onClick={handleClose}
      style={{
        position: 'fixed', inset: 0, zIndex: 60,
        background: 'rgba(10, 20, 40, 0.55)',
        display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
        padding: '40px 20px', overflowY: 'auto',
        backdropFilter: 'blur(2px)',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 920, background: 'var(--card)',
          border: '1px solid var(--border)', borderRadius: 6,
          boxShadow: '0 20px 60px rgba(10, 20, 40, 0.25)',
          display: 'flex', flexDirection: 'column',
          maxHeight: 'calc(100vh - 80px)',
        }}
      >
        {/* Header */}
        <div style={{
          background: 'var(--sidebar-bg)', color: 'var(--sidebar-text)',
          padding: '18px 24px', borderRadius: '6px 6px 0 0',
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          borderBottom: '1px solid var(--gold)',
        }}>
          <div>
            <div style={{
              fontSize: 10, letterSpacing: '0.18em', fontWeight: 600,
              color: 'var(--gold)', textTransform: 'uppercase', marginBottom: 4,
            }}>
              Portfolio Scenario Analysis
            </div>
            <div className="hybrid-serif" style={{ fontSize: 20, fontWeight: 500, color: 'var(--sidebar-text)', lineHeight: 1.1 }}>
              {clientName} — {portfolioName}
            </div>
          </div>
          <button
            onClick={handleClose}
            style={{
              background: 'transparent', border: 'none', cursor: 'pointer',
              color: 'var(--sidebar-text)', padding: 6, borderRadius: 3,
              display: 'flex', alignItems: 'center', justifyContent: 'center',
            }}
            aria-label="Close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div style={{ padding: '20px 24px', overflowY: 'auto', flex: 1 }}>
          {/* Input (shown in 'input' phase OR always-visible at top for context during streaming/done) */}
          {phase === 'input' && (
            <>
              <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 10 }}>
                Ask a scenario question about this portfolio. Live market context is included.
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 }}>
                {PRESETS.map(p => (
                  <button
                    key={p.label}
                    onClick={() => applyPreset(p.prompt)}
                    style={{
                      padding: '6px 12px', fontSize: 11, fontWeight: 500,
                      border: '1px solid var(--border-strong)', background: 'transparent',
                      color: 'var(--text-2)', borderRadius: 3, cursor: 'pointer',
                      fontFamily: 'var(--font-sans)',
                    }}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <textarea
                ref={taRef}
                value={scenarioText}
                onChange={(e) => setScenarioText(e.target.value)}
                placeholder="Describe the scenario — e.g. 'The client has ₦20M to deploy. Where should it go to address the income shortfall?'"
                rows={5}
                style={{
                  width: '100%', padding: '12px 14px', fontSize: 14, lineHeight: 1.5,
                  border: '1px solid var(--border-strong)', borderRadius: 4,
                  background: 'var(--bg-soft)', color: 'var(--text)',
                  fontFamily: 'var(--font-sans)', resize: 'vertical',
                  outline: 'none',
                }}
              />
              <div style={{ marginTop: 14, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
                <button onClick={handleClose} className="btn-h">Cancel</button>
                <button
                  onClick={handleSubmit}
                  disabled={!scenarioText.trim()}
                  className="btn-h btn-h-primary"
                  style={{ opacity: scenarioText.trim() ? 1 : 0.5, cursor: scenarioText.trim() ? 'pointer' : 'not-allowed' }}
                >
                  <Sparkles size={12} /> Run scenario
                </button>
              </div>
            </>
          )}

          {/* Streaming / Done / Error */}
          {(phase === 'streaming' || phase === 'done' || phase === 'error') && (
            <>
              <div style={{
                padding: '10px 14px', background: 'var(--bg-soft)',
                border: '1px solid var(--border-soft)', borderRadius: 4,
                fontSize: 12, color: 'var(--text-2)', marginBottom: 16,
              }}>
                <div style={{ fontSize: 9, letterSpacing: '0.14em', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', marginBottom: 4 }}>
                  Scenario
                </div>
                <div style={{ fontSize: 13, color: 'var(--text)' }}>{scenarioText}</div>
              </div>

              {phase === 'streaming' && (
                <div style={{ fontSize: 11, color: 'var(--gold)', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <RefreshCw size={11} className="animate-spin" />
                  Generating scenario analysis… (live market search in progress)
                </div>
              )}

              {errorMsg && (
                <div style={{
                  padding: '10px 14px', background: 'rgba(166, 59, 59, 0.08)',
                  border: '1px solid rgba(166, 59, 59, 0.3)', borderRadius: 4,
                  fontSize: 12, color: 'var(--neg)', marginBottom: 12,
                }}>
                  {errorMsg}
                </div>
              )}

              {displayContent && (
                <div style={{
                  padding: '18px 22px', background: 'var(--card)',
                  border: '1px solid var(--border)', borderRadius: 4,
                }}>
                  <RenderedMarkdown md={displayContent} />
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer actions — only on 'done' */}
        {phase === 'done' && (
          <div style={{
            padding: '14px 24px', borderTop: '1px solid var(--border)',
            background: 'var(--bg-soft)',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            gap: 10,
          }}>
            <button
              onClick={resetToInput}
              style={{
                background: 'transparent', border: 'none', cursor: 'pointer',
                color: 'var(--text-2)', fontSize: 12, fontWeight: 500,
                fontFamily: 'var(--font-sans)', padding: 0, textDecoration: 'underline',
              }}
            >
              New scenario
            </button>
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={handleCopy} className="btn-h">
                {copied ? <><Check size={12} /> Copied</> : <><Copy size={12} /> Copy markdown</>}
              </button>
              <button
                onClick={handleSave}
                disabled={saving || saved}
                className="btn-h btn-h-primary"
                style={{ opacity: saving || saved ? 0.7 : 1 }}
              >
                {saved ? <><Check size={12} /> Saved</> : saving ? <><RefreshCw size={12} className="animate-spin" /> Saving…</> : <><Save size={12} /> Save to reports</>}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
