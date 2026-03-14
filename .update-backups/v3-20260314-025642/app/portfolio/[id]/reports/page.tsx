'use client'
import { useEffect, useState, useCallback, useRef } from 'react'
import { useParams } from 'next/navigation'
import { supabase } from '@/lib/supabase'
import { Download, Printer, Clock, Sparkles, FileText, Calendar } from 'lucide-react'
import type { ReportType } from '@/lib/report-engine'

const REPORT_TYPES: { value: ReportType; label: string; desc: string; color: string }[] = [
  { value: 'daily',     label: 'Daily',     desc: 'Market pulse + positions',   color: '#2dd4bf' },
  { value: 'weekly',    label: 'Weekly',    desc: 'Week recap + outlook',        color: '#60a5fa' },
  { value: 'monthly',   label: 'Monthly',   desc: 'Full analysis + signals',     color: '#a78bfa' },
  { value: 'quarterly', label: 'Quarterly', desc: 'Deep-dive + rebalancing',     color: '#fb923c' },
  { value: 'annual',    label: 'Annual',    desc: 'Full year review + strategy', color: '#f59e0b' },
]

function defaultDates(type: ReportType): { from: string; to: string } {
  const to   = new Date()
  const from = new Date()
  if (type === 'daily')     from.setDate(to.getDate() - 1)
  if (type === 'weekly')    from.setDate(to.getDate() - 7)
  if (type === 'monthly')   from.setMonth(to.getMonth() - 1)
  if (type === 'quarterly') from.setMonth(to.getMonth() - 3)
  if (type === 'annual')    from.setFullYear(to.getFullYear() - 1)
  return {
    from: from.toISOString().slice(0, 10),
    to:   to.toISOString().slice(0, 10),
  }
}

export default function PortfolioReportsPage() {
  const { id: portfolioId } = useParams() as { id: string }
  const [portfolio,       setPortfolio]       = useState<any>(null)
  const [history,         setHistory]         = useState<any[]>([])
  const [selectedReport,  setSelectedReport]  = useState<any>(null)
  const [reportType,      setReportType]      = useState<ReportType>('monthly')
  const [dates,           setDates]           = useState(defaultDates('monthly'))
  const [generating,      setGenerating]      = useState(false)
  const [error,           setError]           = useState('')
  const iframeRef = useRef<HTMLIFrameElement>(null)

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
    setGenerating(true)
    setError('')
    try {
      const res = await fetch('/api/reports', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ portfolioId, reportType, dateFrom: dates.from, dateTo: dates.to }),
      })
      const d = await res.json()
      if (!res.ok) throw new Error(d.error)

      // Reload history and select the new report
      await loadHistory()
      const { data } = await supabase
        .from('reports')
        .select('*')
        .eq('portfolio_id', portfolioId)
        .order('created_at', { ascending: false })
        .limit(1)
        .single()
      if (data) setSelectedReport(data)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setGenerating(false)
    }
  }

  function downloadHTML(r: any) {
    const blob = new Blob([r.content], { type: 'text/html' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${portfolio?.name?.replace(/\s+/g, '-')}_${r.report_type}_${r.report_date}.html`
    a.click()
  }

  function printReport() {
    iframeRef.current?.contentWindow?.print()
  }

  const typeInfo = REPORT_TYPES.find(t => t.value === (selectedReport?.report_type ?? reportType))

  return (
    <div className="flex h-full overflow-hidden">

      {/* ── Left sidebar ── */}
      <div className="w-72 border-r border-white/[0.07] flex flex-col flex-shrink-0 bg-[#13161d]">

        {/* Generate panel */}
        <div className="p-5 border-b border-white/[0.07]">
          <div className="text-[10px] font-bold uppercase tracking-widest text-[#555d72] mb-3">
            Generate report
          </div>

          {/* Report type selector */}
          <div className="grid grid-cols-2 gap-1.5 mb-4">
            {REPORT_TYPES.map(t => (
              <button
                key={t.value}
                onClick={() => handleTypeChange(t.value)}
                className="py-2 px-2 rounded-lg text-left transition-all border"
                style={
                  reportType === t.value
                    ? { background: t.color + '18', color: t.color, borderColor: t.color + '40' }
                    : { background: '#1a1e28', color: '#555d72', borderColor: 'rgba(255,255,255,0.07)' }
                }>
                <div className="text-xs font-semibold">{t.label}</div>
                <div className="text-[10px] opacity-70 leading-tight mt-0.5">{t.desc}</div>
              </button>
            ))}
          </div>

          {/* Date range */}
          <div className="mb-4">
            <div className="flex items-center gap-1.5 mb-2">
              <Calendar size={11} className="text-[#555d72]" />
              <span className="text-[10px] text-[#555d72] uppercase tracking-wider font-semibold">Period</span>
            </div>
            <div className="space-y-2">
              <div>
                <label className="block text-[10px] text-[#555d72] mb-1">From</label>
                <input
                  type="date"
                  value={dates.from}
                  onChange={e => setDates(d => ({ ...d, from: e.target.value }))}
                  className="tw-input py-1.5 text-xs font-mono"
                />
              </div>
              <div>
                <label className="block text-[10px] text-[#555d72] mb-1">To</label>
                <input
                  type="date"
                  value={dates.to}
                  onChange={e => setDates(d => ({ ...d, to: e.target.value }))}
                  className="tw-input py-1.5 text-xs font-mono"
                />
              </div>
            </div>
          </div>

          {/* Generate button */}
          <button
            onClick={generate}
            disabled={generating}
            className="w-full py-2.5 rounded-lg text-xs font-semibold flex items-center justify-center gap-2 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
            style={{ background: '#a78bfa', color: '#fff' }}>
            {generating ? (
              <>
                <div className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                Searching & writing…
              </>
            ) : (
              <><Sparkles size={13} /> Generate {reportType} report</>
            )}
          </button>

          {error && (
            <div className="mt-2 text-[11px] text-[#ff5c7a] bg-[#ff5c7a]/10 rounded-lg px-3 py-2 border border-[#ff5c7a]/20 break-words">
              {error}
            </div>
          )}

          <div className="mt-3 text-[10px] text-[#555d72] leading-relaxed">
            Claude searches NGX prices, P/E ratios, earnings results, dividend dates, CBN rates, macro
            data — then generates a fully formatted HTML report with investment signals.
          </div>
        </div>

        {/* History list */}
        <div className="flex-1 overflow-y-auto">
          <div className="px-5 py-3 text-[10px] font-bold uppercase tracking-widest text-[#555d72]">
            History ({history.length})
          </div>
          {history.length === 0 ? (
            <div className="px-5 py-4 text-xs text-[#555d72]">No reports yet</div>
          ) : (
            history.map(r => {
              const ti = REPORT_TYPES.find(t => t.value === r.report_type)
              return (
                <div
                  key={r.id}
                  onClick={() => setSelectedReport(r)}
                  className={`px-5 py-3 cursor-pointer border-b border-white/[0.05] transition-colors ${
                    selectedReport?.id === r.id ? 'bg-[#a78bfa]/[0.07]' : 'hover:bg-white/[0.02]'
                  }`}>
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-xs font-semibold capitalize" style={{ color: ti?.color ?? '#a78bfa' }}>
                      {r.report_type}
                    </span>
                    <span className="text-[10px] text-[#555d72]">{r.report_date}</span>
                  </div>
                  <div className="flex items-center gap-1 text-[10px] text-[#555d72]">
                    <Clock size={9} />
                    {new Date(r.created_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}
                    {' · '}
                    {new Date(r.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}
                  </div>
                </div>
              )
            })
          )}
        </div>
      </div>

      {/* ── Right panel — report viewer ── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {generating ? (
          <div className="flex-1 flex flex-col items-center justify-center gap-5 text-[#555d72]">
            <div className="relative">
              <div className="w-16 h-16 border-2 border-white/[0.07] border-t-[#a78bfa] rounded-full animate-spin" />
              <div className="absolute inset-0 flex items-center justify-center">
                <Sparkles size={20} className="text-[#a78bfa]" />
              </div>
            </div>
            <div className="text-center">
              <div className="text-sm text-[#8a91a8] font-medium mb-1">
                Generating {reportType} report…
              </div>
              <div className="text-xs text-[#555d72] max-w-xs text-center">
                Searching NGX prices · P/E ratios · earnings · dividends · CBN rates · macro data
              </div>
              <div className="text-xs text-[#555d72] mt-1">Typically 35–60 seconds</div>
            </div>
          </div>
        ) : selectedReport ? (
          <>
            {/* Toolbar */}
            <div className="px-6 py-3 border-b border-white/[0.07] bg-[#13161d] flex items-center justify-between flex-shrink-0">
              <div className="flex items-center gap-3">
                <span className="text-sm font-semibold">{portfolio?.name}</span>
                <span
                  className="text-[11px] capitalize font-medium px-2 py-0.5 rounded"
                  style={{
                    background: (typeInfo?.color ?? '#a78bfa') + '18',
                    color: typeInfo?.color ?? '#a78bfa',
                  }}>
                  {selectedReport.report_type}
                </span>
                <span className="text-xs text-[#555d72]">{selectedReport.report_date}</span>
              </div>
              <div className="flex gap-2">
                <button
                  onClick={() => navigator.clipboard.writeText(selectedReport.content)}
                  className="flex items-center gap-1.5 px-3 py-1.5 border border-white/10 rounded-lg text-xs text-[#8a91a8] hover:text-[#e8eaf0] transition-colors">
                  ⎘ Copy HTML
                </button>
                <button
                  onClick={() => downloadHTML(selectedReport)}
                  className="flex items-center gap-1.5 px-3 py-1.5 border border-white/10 rounded-lg text-xs text-[#8a91a8] hover:text-[#e8eaf0] transition-colors">
                  <Download size={12} /> Download
                </button>
                <button
                  onClick={printReport}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-[#a78bfa] text-white rounded-lg text-xs font-medium hover:bg-[#9b87e8] transition-colors">
                  <Printer size={12} /> Print / PDF
                </button>
              </div>
            </div>

            {/* HTML report rendered in iframe */}
            <div className="flex-1 overflow-hidden bg-[#f0f2f5]">
              <iframe
                ref={iframeRef}
                srcDoc={selectedReport.content}
                className="w-full h-full border-0"
                title="Portfolio Report"
                sandbox="allow-same-origin allow-scripts allow-popups"
              />
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center text-[#555d72]">
            <FileText size={36} className="mb-4 opacity-30" />
            <div className="text-sm">Generate your first report</div>
            <div className="text-xs mt-1">Select a period and date range, then click Generate</div>
          </div>
        )}
      </div>
    </div>
  )
}
