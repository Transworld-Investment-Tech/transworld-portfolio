'use client'
import { useEffect, useState, useCallback } from 'react'
import { useParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { FileText, Download, Clock, Sparkles } from 'lucide-react'

type ReportType = 'daily' | 'weekly' | 'monthly' | 'quarterly'

const REPORT_COLORS: Record<ReportType, string> = {
  daily: '#2dd4bf',
  weekly: '#60a5fa',
  monthly: '#a78bfa',
  quarterly: '#fb923c',
}

export default function PortfolioReportsPage() {
  const { id: portfolioId } = useParams() as { id: string }
  const [portfolio, setPortfolio] = useState<any>(null)
  const [history, setHistory] = useState<any[]>([])
  const [selectedReport, setSelectedReport] = useState<any>(null)
  const [reportType, setReportType] = useState<ReportType>('monthly')
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState('')

  const loadHistory = useCallback(async () => {
    const [portRes, rptRes] = await Promise.all([
      supabase.from('portfolios').select('name, label, client:clients(name)').eq('id', portfolioId).single(),
      supabase.from('reports').select('*').eq('portfolio_id', portfolioId).order('created_at', { ascending: false }).limit(30),
    ])
    setPortfolio(portRes.data)
    setHistory(rptRes.data ?? [])
    if (rptRes.data && rptRes.data.length > 0 && !selectedReport) {
      setSelectedReport(rptRes.data[0])
    }
  }, [portfolioId, selectedReport])

  useEffect(() => { loadHistory() }, [portfolioId])

  async function generate() {
    setGenerating(true)
    setError('')
    try {
      const res = await fetch('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ portfolioId, reportType }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error)
      await loadHistory()
      // Select the just-generated report
      const { data } = await supabase.from('reports').select('*')
        .eq('portfolio_id', portfolioId).order('created_at', { ascending: false }).limit(1).single()
      if (data) setSelectedReport(data)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setGenerating(false)
    }
  }

  function downloadReport(r: any) {
    const blob = new Blob([r.content], { type: 'text/plain' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${portfolio?.name?.replace(/\s+/g, '-')}_${r.report_type}_${r.report_date}.txt`
    a.click()
  }

  function renderMarkdown(text: string) {
    return text
      .replace(/^## (.*)/gm, '<h1>$1</h1>')
      .replace(/^### (.*)/gm, '<h2>$1</h2>')
      .replace(/^#### (.*)/gm, '<h3>$1</h3>')
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(.*?)\*/g, '<em>$1</em>')
      .replace(/`(.*?)`/g, '<code>$1</code>')
      .replace(/^\| (.*)/gm, (match) => {
        const cells = match.split('|').filter(c => c.trim() && !c.trim().match(/^[-:]+$/))
        return `<div style="display:flex;gap:16px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.06);">${cells.map(c => `<span style="flex:1;font-size:12px;">${c.trim()}</span>`).join('')}</div>`
      })
      .replace(/^---+$/gm, '<hr style="border-color:rgba(255,255,255,0.06);margin:16px 0;">')
      .replace(/\n\n/g, '</p><p>')
      .replace(/\n/g, '<br/>')
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* Left panel */}
      <div className="w-72 border-r border-white/[0.07] flex flex-col flex-shrink-0 bg-[#13161d]">
        {/* Generate section */}
        <div className="p-5 border-b border-white/[0.07]">
          <div className="text-xs font-semibold uppercase tracking-widest text-[#555d72] mb-3">Generate report</div>

          <div className="grid grid-cols-2 gap-1.5 mb-3">
            {(['daily','weekly','monthly','quarterly'] as ReportType[]).map(t => (
              <button key={t} onClick={() => setReportType(t)}
                className={`py-2 px-3 rounded-lg text-xs font-medium capitalize transition-all ${
                  reportType === t
                    ? 'text-white border border-transparent'
                    : 'bg-[#1a1e28] text-[#555d72] border border-white/[0.07] hover:text-[#8a91a8]'
                }`}
                style={reportType === t ? { background: REPORT_COLORS[t] + '20', color: REPORT_COLORS[t], borderColor: REPORT_COLORS[t] + '40' } : {}}>
                {t}
              </button>
            ))}
          </div>

          <button onClick={generate} disabled={generating}
            className="w-full py-2.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-2 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
            style={{ background: '#a78bfa', color: '#fff' }}>
            {generating
              ? <><div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" /> Searching market data…</>
              : <><Sparkles size={13} /> Generate {reportType} report</>
            }
          </button>

          {error && (
            <div className="mt-2 text-[11px] text-[#ff5c7a] bg-[#ff5c7a]/10 rounded-lg px-3 py-2 border border-[#ff5c7a]/20">
              {error}
            </div>
          )}

          <div className="mt-3 text-[10px] text-[#555d72] leading-relaxed">
            Claude searches live CBN, NGX, FMDQ & NBS data, then writes a full report with market commentary and priority actions.
          </div>
        </div>

        {/* History list */}
        <div className="flex-1 overflow-y-auto">
          <div className="px-5 py-3 text-[10px] font-semibold uppercase tracking-widest text-[#555d72]">
            Report history ({history.length})
          </div>
          {history.length === 0 ? (
            <div className="px-5 py-4 text-xs text-[#555d72]">No reports yet</div>
          ) : (
            history.map(r => (
              <div key={r.id} onClick={() => setSelectedReport(r)}
                className={`px-5 py-3 cursor-pointer border-b border-white/[0.05] transition-colors ${
                  selectedReport?.id === r.id ? 'bg-[#a78bfa]/[0.07]' : 'hover:bg-white/[0.02]'
                }`}>
                <div className="flex items-center justify-between mb-0.5">
                  <span className="text-xs font-medium capitalize" style={{ color: REPORT_COLORS[r.report_type as ReportType] }}>
                    {r.report_type}
                  </span>
                  <span className="text-[10px] text-[#555d72]">{r.report_date}</span>
                </div>
                <div className="flex items-center gap-1 text-[10px] text-[#555d72]">
                  <Clock size={10} />
                  {new Date(r.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Right panel - report content */}
      <div className="flex-1 overflow-auto">
        {generating ? (
          <div className="flex flex-col items-center justify-center h-full gap-5 text-[#555d72]">
            <div className="relative">
              <div className="w-14 h-14 border-2 border-white/[0.07] border-t-[#a78bfa] rounded-full animate-spin" />
              <div className="absolute inset-0 flex items-center justify-center">
                <Sparkles size={18} className="text-[#a78bfa]" />
              </div>
            </div>
            <div className="text-center">
              <div className="text-sm text-[#8a91a8] font-medium mb-1">Generating {reportType} report…</div>
              <div className="text-xs text-[#555d72]">Searching CBN · NGX · FMDQ · NBS · market data</div>
              <div className="text-xs text-[#555d72] mt-0.5">This takes 25–45 seconds</div>
            </div>
          </div>
        ) : selectedReport ? (
          <div>
            {/* Report toolbar */}
            <div className="px-8 py-4 border-b border-white/[0.07] bg-[#13161d] sticky top-0 z-10 flex items-center justify-between">
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold">{portfolio?.name}</span>
                  <span className="badge capitalize text-[9px]"
                    style={{ background: REPORT_COLORS[selectedReport.report_type as ReportType] + '18', color: REPORT_COLORS[selectedReport.report_type as ReportType] }}>
                    {selectedReport.report_type}
                  </span>
                </div>
                <div className="text-xs text-[#555d72] mt-0.5">
                  {new Date(selectedReport.created_at).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
              <div className="flex gap-2">
                <button onClick={() => navigator.clipboard.writeText(selectedReport.content)}
                  className="flex items-center gap-1.5 px-3 py-1.5 border border-white/10 rounded-lg text-xs text-[#8a91a8] hover:text-[#e8eaf0] hover:border-white/20 transition-colors">
                  ⎘ Copy
                </button>
                <button onClick={() => downloadReport(selectedReport)}
                  className="flex items-center gap-1.5 px-3 py-1.5 border border-white/10 rounded-lg text-xs text-[#8a91a8] hover:text-[#e8eaf0] hover:border-white/20 transition-colors">
                  <Download size={12} /> .txt
                </button>
              </div>
            </div>

            {/* Report body */}
            <div className="px-8 py-6">
              <div className="tw-card report-content max-w-4xl mx-auto">
                <div dangerouslySetInnerHTML={{ __html: renderMarkdown(selectedReport.content) }} />
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-[#555d72]">
            <FileText size={32} className="mb-3 opacity-30" />
            <div className="text-sm">Generate your first report</div>
            <div className="text-xs mt-1">Select a period and click Generate</div>
          </div>
        )}
      </div>
    </div>
  )
}
