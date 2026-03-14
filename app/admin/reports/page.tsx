'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import { FileText, Download, ChevronRight, Search } from 'lucide-react'

export default function AllReportsPage() {
  const [reports, setReports] = useState<any[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState('')
  const [selectedReport, setSelectedReport] = useState<any>(null)

  useEffect(() => {
    supabase.from('reports')
      .select('*, portfolio:portfolios(name, label, client:clients(name, code))')
      .order('created_at', { ascending: false })
      .limit(100)
      .then(({ data }) => { setReports(data ?? []); setLoading(false) })
  }, [])

  function downloadReport(r: any) {
    const blob = new Blob([r.content], { type: 'text/plain' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `${r.portfolio?.name?.replace(/\s+/g, '-')}_${r.report_type}_${r.report_date}.txt`
    a.click()
  }

  const filtered = reports.filter(r => {
    const name = `${r.portfolio?.name} ${r.portfolio?.client?.name}`.toLowerCase()
    if (search && !name.includes(search.toLowerCase())) return false
    if (typeFilter && r.report_type !== typeFilter) return false
    return true
  })

  return (
    <div className="flex h-full">
      {/* Left panel - report list */}
      <div className="w-80 border-r border-white/[0.07] flex flex-col flex-shrink-0">
        <div className="px-5 py-4 border-b border-white/[0.07]">
          <h2 className="text-sm font-semibold mb-3">Report history</h2>
          <div className="space-y-2">
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search…" className="tw-input py-1.5 text-xs" />
            <select value={typeFilter} onChange={e => setTypeFilter(e.target.value)} className="tw-select py-1.5 text-xs">
              <option value="">All types</option>
              {['daily','weekly','monthly','quarterly'].map(t => <option key={t} className="capitalize">{t}</option>)}
            </select>
          </div>
        </div>
        <div className="overflow-y-auto flex-1">
          {loading ? (
            <div className="text-center py-8 text-xs text-[#555d72]">Loading…</div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-8 text-xs text-[#555d72]">No reports found</div>
          ) : (
            filtered.map(r => (
              <div key={r.id} onClick={() => setSelectedReport(r)}
                className={`px-5 py-3.5 border-b border-white/[0.05] cursor-pointer transition-colors ${selectedReport?.id === r.id ? 'bg-[#a78bfa]/[0.07]' : 'hover:bg-white/[0.02]'}`}>
                <div className="flex items-start justify-between gap-2 mb-1">
                  <div className="text-xs font-medium truncate">{r.portfolio?.name}</div>
                  <span className="badge badge-ntb capitalize text-[9px] flex-shrink-0">{r.report_type}</span>
                </div>
                <div className="text-[10px] text-[#555d72]">{r.portfolio?.client?.name}</div>
                <div className="text-[10px] text-[#555d72] mt-0.5">{new Date(r.created_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
              </div>
            ))
          )}
        </div>
      </div>

      {/* Right panel - report content */}
      <div className="flex-1 overflow-auto">
        {selectedReport ? (
          <div>
            <div className="px-8 py-4 border-b border-white/[0.07] bg-[#13161d] flex items-center justify-between sticky top-0">
              <div>
                <div className="text-sm font-semibold">{selectedReport.portfolio?.name}</div>
                <div className="text-xs text-[#555d72]">{selectedReport.portfolio?.client?.name} · {selectedReport.report_type} · {selectedReport.report_date}</div>
              </div>
              <div className="flex gap-2">
                <button onClick={() => navigator.clipboard.writeText(selectedReport.content)}
                  className="flex items-center gap-1.5 px-3 py-1.5 border border-white/10 rounded-lg text-xs text-[#8a91a8] hover:text-[#e8eaf0] transition-colors">
                  ⎘ Copy
                </button>
                <button onClick={() => downloadReport(selectedReport)}
                  className="flex items-center gap-1.5 px-3 py-1.5 border border-white/10 rounded-lg text-xs text-[#8a91a8] hover:text-[#e8eaf0] transition-colors">
                  <Download size={12} /> Download
                </button>
                <Link href={`/portfolio/${selectedReport.portfolio_id}/reports`}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-[#a78bfa] text-white rounded-lg text-xs font-medium hover:bg-[#9b87e8] transition-colors">
                  Open portfolio →
                </Link>
              </div>
            </div>
            <div className="px-8 py-6">
              <div className="tw-card report-content max-w-4xl">
                <div dangerouslySetInnerHTML={{ __html: selectedReport.content
                  .replace(/^## (.*)/gm, '<h1>$1</h1>')
                  .replace(/^### (.*)/gm, '<h2>$1</h2>')
                  .replace(/^#### (.*)/gm, '<h3>$1</h3>')
                  .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
                  .replace(/\*(.*?)\*/g, '<em>$1</em>')
                  .replace(/`(.*?)`/g, '<code>$1</code>')
                  .replace(/\n\n/g, '</p><p>')
                  .replace(/\n/g, '<br/>')
                }} />
              </div>
            </div>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-[#555d72]">
            <FileText size={32} className="mb-3 opacity-40" />
            <div className="text-sm">Select a report to view it</div>
          </div>
        )}
      </div>
    </div>
  )
}
