'use client'
import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { Clock, Sparkles, FileText, Calendar, Copy, Check, Printer } from 'lucide-react'
import type { ReportType } from '@/lib/report-engine'

const REPORT_TYPES: { value: ReportType; label: string; desc: string; color: string }[] = [
  { value: 'daily',     label: 'Daily',     desc: 'Pulse + positions',    color: '#2dd4bf' },
  { value: 'weekly',    label: 'Weekly',    desc: 'Week recap + outlook', color: '#60a5fa' },
  { value: 'monthly',   label: 'Monthly',   desc: 'Full analysis',        color: '#a78bfa' },
  { value: 'quarterly', label: 'Quarterly', desc: 'Deep-dive',            color: '#fb923c' },
  { value: 'annual',    label: 'Annual',    desc: 'Year review',          color: '#f59e0b' },
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

// Simple markdown → readable text renderer
function renderMarkdown(text: string) {
  const lines = text.split('\n')
  return lines.map((line, i) => {
    if (line.startsWith('## '))  return <h2 key={i} style={{ color: '#c9a84c', fontSize: 15, fontWeight: 700, marginTop: 28, marginBottom: 8, borderBottom: '1px solid rgba(201,168,76,0.2)', paddingBottom: 6, letterSpacing: '0.05em', textTransform: 'uppercase' }}>{line.slice(3)}</h2>
    if (line.startsWith('### ')) return <h3 key={i} style={{ color: '#a78bfa', fontSize: 13, fontWeight: 600, marginTop: 18, marginBottom: 6 }}>{line.slice(4)}</h3>
    if (line.startsWith('---'))  return <hr key={i} style={{ border: 'none', borderTop: '1px solid rgba(255,255,255,0.07)', margin: '24px 0' }} />
    if (line.startsWith('| ')) {
      const cells = line.split('|').filter(c => c.trim())
      const isHeader = lines[i+1]?.startsWith('|---') || lines[i+1]?.startsWith('| ---')
      const isSeparator = line.replace(/[\s\-|]/g, '') === ''
      if (isSeparator) return null
      return (
        <div key={i} style={{ display: 'flex', borderBottom: '1px solid rgba(255,255,255,0.05)', padding: '6px 0' }}>
          {cells.map((c, j) => (
            <div key={j} style={{ flex: 1, fontSize: 12, color: isHeader ? '#e8eaf0' : '#8a91a8', fontWeight: isHeader ? 600 : 400, padding: '0 8px' }}
              dangerouslySetInnerHTML={{ __html: c.trim().replace(/\*\*(.+?)\*\*/g, '<strong style="color:#e8eaf0">$1</strong>') }}
            />
          ))}
        </div>
      )
    }
    if (line.trim() === '') return <div key={i} style={{ height: 8 }} />
    // Render bold and italic inline
    const html = line
      .replace(/\*\*(.+?)\*\*/g, '<strong style="color:#e8eaf0;font-weight:600">$1</strong>')
      .replace(/\*(.+?)\*/g, '<em style="color:#8a91a8">$1</em>')
      .replace(/`(.+?)`/g, '<code style="background:#1a1e28;padding:1px 5px;border-radius:3px;font-size:11px;color:#a78bfa">$1</code>')
    return <p key={i} style={{ fontSize: 13, lineHeight: 1.8, color: '#8a91a8', margin: '4px 0' }} dangerouslySetInnerHTML={{ __html: html }} />
  }).filter(Boolean)
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

  function handleTypeChange(type: ReportType) {
    setReportType(type)
    setDates(defaultDates(type))
  }

  async function generate() {
    setGenerating(true); setError('')
    try {
      const res = await fetch('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
    const d = new Date().toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long",year:"numeric"})
    const lineArr = selectedReport.content.split("\n")
    const rows: string[] = []
    let tbuf = ""
    for (const ln of lineArr) {
      if (ln.startsWith("| ")) {
        if (ln.replace(/[\s\-|]/g,"") === "") continue
        const cells = ln.split("|").filter((c:string)=>c.trim())
        tbuf += "<tr>"+cells.map((c:string)=>"<td>"+c.trim().replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>")+"</td>").join("")+"</tr>"
      } else {
        if (tbuf) { rows.push("<table>"+tbuf+"</table>"); tbuf="" }
        if (ln.startsWith("## "))       rows.push("<h2>"+ln.slice(3)+"</h2>")
        else if (ln.startsWith("### ")) rows.push("<h3>"+ln.slice(4)+"</h3>")
        else if (ln.startsWith("---"))  rows.push("<hr>")
        else if (ln.trim()==="")        rows.push("<br>")
        else rows.push("<p>"+ln.replace(/\*\*(.+?)\*\*/g,"<strong>$1</strong>")+"</p>")
      }
    }
    if (tbuf) rows.push("<table>"+tbuf+"</table>")
    const body = rows.join("\n")
    const css = "body{font-family:Segoe UI,Arial,sans-serif;font-size:10.5pt;line-height:1.7;color:#111}"+
      ".ph{background:#0f1923;padding:24px 40px;border-bottom:3px solid #c9a84c;margin-bottom:32px}"+
      ".firm{font-size:9pt;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#c9a84c;margin-bottom:6px}"+
      ".pname{font-size:20pt;font-weight:700;color:white;margin-bottom:4px}"+
      ".pmeta{font-size:11pt;color:#8a91a8}"+
      ".content{padding:0 40px 40px}"+
      "h2{font-size:12pt;font-weight:700;text-transform:uppercase;color:#0f1923;border-bottom:1px solid #c9a84c55;padding-bottom:6px;margin:28px 0 10px}"+
      "h3{font-size:11pt;font-weight:600;color:#5b21b6;margin:18px 0 8px}"+
      "p{margin:5px 0}strong{font-weight:700}hr{border:none;border-top:1px solid #ddd;margin:20px 0}"+
      "table{width:100%;border-collapse:collapse;margin:12px 0;font-size:9.5pt}"+
      "td,th{padding:6px 8px;border-bottom:1px solid #eee;text-align:left}"+
      "th{background:#f5f5f5;font-weight:700;border-bottom:2px solid #ddd}"+
      ".pbtn{position:fixed;top:16px;right:16px;background:#a78bfa;color:white;border:none;border-radius:8px;padding:10px 20px;font-size:12px;cursor:pointer}"+
      "@media print{@page{size:A4;margin:15mm}.pbtn{display:none!important}"+
      ".ph{background:none!important;border-bottom:2px solid #c9a84c;padding:0 0 12px;margin-bottom:20px}"+
      ".pname{color:#0f1923!important;font-size:16pt}.pmeta{color:#555!important}"+
      ".content{padding:0}p{orphans:3;widows:3}}"
    const html = "<!DOCTYPE html><html><head><meta charset=\"UTF-8\"><style>"+css+"</style></head><body>"+
      "<button class=\"pbtn\" onclick=\"window.print()\">Print / Save PDF</button>"+
      "<div class=\"ph\"><div class=\"firm\">Transworld Asset Management</div>"+
      "<div class=\"pname\">"+portfolio.name+"</div>"+
      "<div class=\"pmeta\">"+selectedReport.report_type.toUpperCase()+" &middot; "+selectedReport.report_date+" &middot; "+d+"</div></div>"+
      "<div class=\"content\">"+body+"</div></body></html>"
    const win = window.open("","_blank","width=960,height=800")
    if (win) { win.document.write(html); win.document.close() }
  }

  function copyReport() {
    if (!selectedReport) return
    navigator.clipboard.writeText(selectedReport.content)
    setCopied(true)
    setTimeout(() => setCopied(false), 2500)
  }

  const typeInfo = REPORT_TYPES.find(t => t.value === (selectedReport?.report_type ?? reportType))

  return (
    <div className="flex h-full overflow-hidden">

      {/* Sidebar */}
      <div className="w-64 border-r border-white/[0.07] flex flex-col flex-shrink-0 bg-[#13161d]">
        <div className="p-4 border-b border-white/[0.07]">
          <div className="text-[10px] font-bold uppercase tracking-widest text-[#555d72] mb-3">Generate report</div>

          <div className="grid grid-cols-2 gap-1 mb-3">
            {REPORT_TYPES.map(t => (
              <button key={t.value} onClick={() => handleTypeChange(t.value)}
                className="py-1.5 px-2 rounded-lg text-left transition-all border"
                style={reportType === t.value
                  ? { background: t.color+'18', color: t.color, borderColor: t.color+'40' }
                  : { background: '#1a1e28', color: '#555d72', borderColor: 'rgba(255,255,255,0.07)' }}>
                <div className="text-xs font-semibold">{t.label}</div>
                <div className="text-[10px] opacity-70">{t.desc}</div>
              </button>
            ))}
          </div>

          <div className="mb-3">
            <div className="flex items-center gap-1 mb-1.5">
              <Calendar size={10} className="text-[#555d72]" />
              <span className="text-[10px] text-[#555d72] uppercase tracking-wider font-semibold">Period</span>
            </div>
            <div className="space-y-1.5">
              <div>
                <label className="block text-[10px] text-[#555d72] mb-0.5">From</label>
                <input type="date" value={dates.from} onChange={e => setDates(d => ({ ...d, from: e.target.value }))} className="tw-input py-1 text-xs font-mono" />
              </div>
              <div>
                <label className="block text-[10px] text-[#555d72] mb-0.5">To</label>
                <input type="date" value={dates.to} onChange={e => setDates(d => ({ ...d, to: e.target.value }))} className="tw-input py-1 text-xs font-mono" />
              </div>
            </div>
          </div>

          <button onClick={generate} disabled={generating}
            className="w-full py-2 rounded-lg text-xs font-semibold flex items-center justify-center gap-2 transition-all disabled:opacity-60"
            style={{ background: '#a78bfa', color: '#fff' }}>
            {generating
              ? <><div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />Analysing…</>
              : <><Sparkles size={12} />Generate {reportType} report</>
            }
          </button>

          {error && <div className="mt-2 text-[11px] text-[#ff5c7a] bg-[#ff5c7a]/10 rounded px-2 py-1.5 break-words">{error}</div>}

          <p className="mt-2 text-[10px] text-[#555d72] leading-relaxed">
            Deep analysis using portfolio history, transaction data, NAV trajectory, and market knowledge. Clean text — copy to Claude.ai to format.
          </p>
        </div>

        <div className="flex-1 overflow-y-auto">
          <div className="px-4 py-2 text-[10px] font-bold uppercase tracking-widest text-[#555d72]">
            History ({history.length})
          </div>
          {history.map(r => {
            const ti = REPORT_TYPES.find(t => t.value === r.report_type)
            return (
              <div key={r.id} onClick={() => setSelectedReport(r)}
                className={`px-4 py-2.5 cursor-pointer border-b border-white/[0.05] transition-colors ${selectedReport?.id === r.id ? 'bg-[#a78bfa]/[0.07]' : 'hover:bg-white/[0.02]'}`}>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold capitalize" style={{ color: ti?.color ?? '#a78bfa' }}>{r.report_type}</span>
                  <span className="text-[10px] text-[#555d72]">{r.report_date}</span>
                </div>
                <div className="flex items-center gap-1 text-[10px] text-[#555d72] mt-0.5">
                  <Clock size={9} />
                  {new Date(r.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      {/* Main panel */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {generating ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-4">
            <div className="relative">
              <div className="w-14 h-14 border-2 border-white/[0.07] border-t-[#a78bfa] rounded-full animate-spin" />
              <div className="absolute inset-0 flex items-center justify-center">
                <Sparkles size={18} className="text-[#a78bfa]" />
              </div>
            </div>
            <div className="text-center">
              <div className="text-sm text-[#8a91a8] font-medium">Generating {reportType} analysis…</div>
              <div className="text-xs text-[#555d72] mt-1">Reviewing portfolio history · Analysing holdings · Building recommendations</div>
              <div className="text-xs text-[#555d72]">Typically 20–35 seconds</div>
            </div>
          </div>
        ) : selectedReport ? (
          <>
            {/* Toolbar */}
            <div className="px-5 py-2.5 border-b border-white/[0.07] bg-[#13161d] flex items-center justify-between flex-shrink-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-semibold">{portfolio?.name}</span>
                <span className="text-[11px] capitalize font-medium px-2 py-0.5 rounded"
                  style={{ background: (typeInfo?.color ?? '#a78bfa')+'18', color: typeInfo?.color ?? '#a78bfa' }}>
                  {selectedReport.report_type}
                </span>
                <span className="text-xs text-[#555d72]">{selectedReport.report_date}</span>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={copyReport}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
                  style={copied
                    ? { background: '#22c55e18', color: '#22c55e', border: '1px solid #22c55e40' }
                    : { background: 'transparent', color: '#8a91a8', border: '1px solid rgba(255,255,255,0.1)' }}>
                  {copied ? <><Check size={12} />Copied!</> : <><Copy size={12} />Copy to clipboard</>}
                </button>
                <button onClick={printReport}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
                  style={{ background: '#a78bfa', color: '#fff' }}>
                  <Printer size={12} /> Print / PDF
                </button>
              </div>
            </div>

            {/* Report content */}
            <div className="flex-1 overflow-y-auto px-8 py-6 bg-[#0d0f14]">
              <div style={{ maxWidth: 820, margin: '0 auto' }}>
                {/* Header block */}
                <div style={{ borderLeft: '3px solid #c9a84c', paddingLeft: 16, marginBottom: 28 }}>
                  <div style={{ fontSize: 10, color: '#c9a84c', letterSpacing: '0.1em', textTransform: 'uppercase', fontWeight: 700, marginBottom: 4 }}>
                    Transworld Asset Management — Portfolio Intelligence
                  </div>
                  <div style={{ fontSize: 20, color: '#e8eaf0', fontWeight: 700 }}>{portfolio?.name}</div>
                  <div style={{ fontSize: 12, color: '#555d72', marginTop: 2 }}>
                    {selectedReport.report_type.toUpperCase()} REPORT · {selectedReport.report_date}
                  </div>
                </div>

                {/* Rendered content */}
                {renderMarkdown(selectedReport.content)}

                {/* Copy prompt hint */}
                <div style={{ marginTop: 40, padding: '12px 16px', background: '#a78bfa0a', border: '1px solid #a78bfa20', borderRadius: 8 }}>
                  <div style={{ fontSize: 11, color: '#a78bfa', fontWeight: 600, marginBottom: 4 }}>💡 Tip — Enhance this report</div>
                  <div style={{ fontSize: 11, color: '#555d72', lineHeight: 1.7 }}>
                    Copy this report and paste it into Claude.ai with the prompt:<br />
                    <em style={{ color: '#8a91a8' }}>"Please format this portfolio analysis into a beautiful, professional PDF-ready report with sections, tables, and visual hierarchy. Keep all the analysis and numbers exactly as they are."</em>
                  </div>
                </div>
              </div>
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-[#555d72]">
            <FileText size={32} className="mb-3 opacity-30" />
            <div className="text-sm">Generate your first report</div>
            <div className="text-xs mt-1">Select report type and period, then click Generate</div>
          </div>
        )}
      </div>
    </div>
  )
}
