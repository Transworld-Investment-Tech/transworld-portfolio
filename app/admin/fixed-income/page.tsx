'use client'
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import {
  ArrowLeft, Edit2, Search, X, Save, Info, Sparkles,
  AlertCircle, CheckCircle2, Upload, FileSpreadsheet, AlertTriangle,
  History,
} from 'lucide-react'
import YieldCurvePanel from '@/components/admin/YieldCurvePanel'
import { computeDurationConvexity } from '@/lib/bond-yield'

// v21z: Fixed Income admin page.
// v21z-hotfix-1: Replaced web_search (3/72 hit rate) with paste-from-FMDQ.
// v21z-hotfix-2: Generalised paste sources after FMDQ Market Data turned out
//                to be subscription-gated.
// v22:           Paste flow replaced with xlsx upload of the brokerage
//                PrintDownload Price List — the same file already used for
//                equity NAV reconstruction. 70/70 FI tickers match. YTM is
//                computed from clean price + coupon + maturity server-side,
//                with extreme yields flagged for review.
// v24:           Bulk historical upload — accepts N files, parses each,
//                shows per-file summary, accepts all valid proposals into
//                yield_history (with conditional update of instruments.yield_*).
//                Existing single-file flow preserved with same UX.

const YIELD_STALE_DAYS = 14

interface FiRow {
  instrument_id: string
  name: string
  type: string
  sub_type: string | null
  rationale: string | null
  coupon_pct: number | null
  coupon_freq: number | null
  maturity_date: string | null
  approved: boolean
  yield_pct: number | null
  yield_source: string | null
  yield_as_of: string | null
  yield_last_refreshed_at: string | null
  yield_notes: string | null
  // v25: computed at load time
  mod_duration: number | null
  convexity: number | null
  vwc_tag: 'traded' | 'quoted' | 'stale'
}

type YieldFlag = 'matured' | 'par-at-or-above' | 'extreme-high' | 'extreme-low' | 'solver-failed'

interface ProposalRow {
  instrument_id: string
  name: string
  coupon_pct: number | null
  maturity_date: string | null
  clean_price: number
  settlement_date: string
  ytm_pct: number
  flag: YieldFlag | null
  flag_explanation: string | null
  current_yield: number | null
  source: string
  as_of: string
  confidence: 'high' | 'medium' | 'low'
  notes: string
}

interface ReviewRow extends ProposalRow {
  accepted: boolean
}

// v24: server returns { files: FileResult[] }. The legacy single-file flow
// extracts files[0] and renders it the same way as before.
interface FileResult {
  filename:             string
  settlement_date:      string | null
  rows_in_file:         number
  fi_instruments_in_db: number
  matched:              number
  unmatched_count:      number
  unmatched_ids:        string[]
  results:              ProposalRow[]
  error:                string | null
}

interface ImportResponse {
  settlement_date: string
  rows_in_file: number
  fi_instruments_in_db: number
  matched: number
  unmatched_count: number
  unmatched_ids: string[]
  results: ProposalRow[]
}

function parseNotes(notes: string | null): { subType: string | null; rationale: string | null } {
  if (!notes) return { subType: null, rationale: null }
  const m = notes.match(/^\[([^\]]+)\]\s*(.*)$/)
  if (m) return { subType: m[1], rationale: m[2] }
  return { subType: null, rationale: notes }
}

function formatMaturity(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso + 'T00:00:00Z')
  return d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })
}

function formatTenor(maturity: string | null): string {
  if (!maturity) return '—'
  const m = new Date(maturity + 'T00:00:00Z')
  const now = new Date()
  now.setUTCHours(0, 0, 0, 0)
  const days = (m.getTime() - now.getTime()) / 86_400_000
  if (days < 0) return 'matured'
  if (days < 365) return `${Math.round(days)}d`
  const years = days / 365.25
  return `${years.toFixed(1)}y`
}

function yieldStalenessOf(asOf: string | null): 'fresh' | 'stale' | 'none' {
  if (!asOf) return 'none'
  const d = new Date(asOf + 'T00:00:00Z')
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  const diff = Math.floor((today.getTime() - d.getTime()) / 86_400_000)
  return diff > YIELD_STALE_DAYS ? 'stale' : 'fresh'
}

function formatDate(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso + 'T00:00:00Z')
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
}

// Bulletproof numeric formatter (pitfall #73).
function fmtPct(v: unknown, dp = 2, suffix = '%'): string {
  if (v === null || v === undefined) return '—'
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  if (!isFinite(n)) return '—'
  return `${n.toFixed(dp)}${suffix}`
}

function fmtNaira(v: unknown, dp = 2): string {
  if (v === null || v === undefined) return '—'
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  if (!isFinite(n)) return '—'
  return `\u20a6${n.toFixed(dp)}`
}

function hasNum(v: unknown): boolean {
  if (v === null || v === undefined) return false
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return isFinite(n)
}

const numOrNull = (v: any): number | null => {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return isFinite(n) ? n : null
}

export default function FixedIncomePage() {
  const [rows, setRows] = useState<FiRow[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [subTypeFilter, setSubTypeFilter] = useState<string>('all')
  const [staleOnly, setStaleOnly] = useState(false)
  const [noYieldOnly, setNoYieldOnly] = useState(false)

  // Single-row edit modal
  const [editing, setEditing] = useState<FiRow | null>(null)
  const [editYield, setEditYield] = useState('')
  const [editAsOf, setEditAsOf] = useState('')
  const [editNotes, setEditNotes] = useState('')
  const [editSaving, setEditSaving] = useState(false)
  const [editError, setEditError] = useState('')

  // Single-file upload modal (existing v22 flow)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [uploadFile, setUploadFile] = useState<File | null>(null)
  const [uploadLoading, setUploadLoading] = useState(false)
  const [uploadError, setUploadError] = useState('')

  // Single-file review modal
  const [proposals, setProposals] = useState<ReviewRow[] | null>(null)
  const [importMeta, setImportMeta] = useState<ImportResponse | null>(null)
  const [batchSaving, setBatchSaving] = useState(false)
  const [batchSaveMsg, setBatchSaveMsg] = useState('')

  // v24: Bulk historical upload modal
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkFiles, setBulkFiles] = useState<File[]>([])
  const [bulkParsing, setBulkParsing] = useState(false)
  const [bulkParseError, setBulkParseError] = useState('')

  // v24: Bulk historical results modal
  const [bulkResults, setBulkResults] = useState<FileResult[] | null>(null)
  const [bulkSelections, setBulkSelections] = useState<Map<string, boolean>>(new Map())
  const [bulkSaving, setBulkSaving] = useState(false)
  const [bulkSaveError, setBulkSaveError] = useState('')

  useEffect(() => { load() }, [])

  async function load() {
    setLoading(true)
    const { data, error } = await supabase
      .from('instruments')
      .select('*')
      .eq('sleeve_id', 'fi')
      .order('maturity_date', { ascending: true, nullsFirst: false })

    if (error) {
      console.error('Load FI instruments failed:', error)
      setLoading(false)
      return
    }

    const weird = (data ?? []).filter((i: any) =>
      (i.coupon_pct !== null && i.coupon_pct !== undefined && numOrNull(i.coupon_pct) === null) ||
      (i.yield_pct !== null && i.yield_pct !== undefined && numOrNull(i.yield_pct) === null)
    )
    if (weird.length > 0) {
      console.warn('[Fixed income] Rows with un-coerceable numeric fields:',
        weird.map((w: any) => ({ id: w.instrument_id, coupon_pct: w.coupon_pct, yield_pct: w.yield_pct })))
    }

    const mapped = (data ?? []).map((i: any) => {
      const { subType, rationale } = parseNotes(i.notes)
      return {
        instrument_id: i.instrument_id,
        name: i.name,
        type: i.type,
        sub_type: subType,
        rationale,
        coupon_pct: numOrNull(i.coupon_pct),
        coupon_freq: numOrNull(i.coupon_freq),
        maturity_date: i.maturity_date ?? null,
        approved: !!i.approved,
        yield_pct: numOrNull(i.yield_pct),
        yield_source: i.yield_source ?? null,
        yield_as_of: i.yield_as_of ?? null,
        yield_last_refreshed_at: i.yield_last_refreshed_at ?? null,
        yield_notes: i.yield_notes ?? null,
      }
    })
    // v25: augment with mod duration, convexity, and VWC tag
    const { data: histData } = await supabase
      .from('yield_history')
      .select('instrument_id, yield_as_of, volume')
      .order('yield_as_of', { ascending: false })
      .limit(2000)
    const latestVolMap = new Map<string, number | null>()
    for (const r of (histData ?? []) as any[]) {
      if (!latestVolMap.has(r.instrument_id)) {
        latestVolMap.set(r.instrument_id, numOrNull(r.volume))
      }
    }
    const today = new Date().toISOString().slice(0, 10)
    const augmented: FiRow[] = mapped.map(r => {
      let modDur: number | null = null
      let convex: number | null = null
      if (r.yield_pct !== null && r.coupon_pct !== null && r.maturity_date) {
        const dc = computeDurationConvexity(r.yield_pct, r.coupon_pct, r.maturity_date, today, 2)
        if (dc) { modDur = dc.mod_duration; convex = dc.convexity }
      }
      let vwc: 'traded' | 'quoted' | 'stale' = 'quoted'
      if (!r.yield_as_of) vwc = 'stale'
      else {
        const ageDays = (new Date(today).getTime() - new Date(r.yield_as_of).getTime()) / 86_400_000
        if (ageDays > 14) vwc = 'stale'
        else if ((latestVolMap.get(r.instrument_id) ?? 0) > 0) vwc = 'traded'
        else vwc = 'quoted'
      }
      return { ...r, mod_duration: modDur, convexity: convex, vwc_tag: vwc }
    })
    setRows(augmented)
    setLoading(false)
  }

  const subTypes = useMemo(() => {
    const s = new Set<string>()
    rows.forEach(r => { if (r.sub_type) s.add(r.sub_type) })
    return Array.from(s).sort()
  }, [rows])

  const filtered = useMemo(() => rows.filter(r => {
    if (search) {
      const q = search.toLowerCase()
      if (!r.instrument_id.toLowerCase().includes(q) && !r.name.toLowerCase().includes(q)) return false
    }
    if (subTypeFilter !== 'all' && r.sub_type !== subTypeFilter) return false
    const stale = yieldStalenessOf(r.yield_as_of)
    if (staleOnly && stale === 'fresh') return false
    if (noYieldOnly && r.yield_pct !== null) return false
    return true
  }), [rows, search, subTypeFilter, staleOnly, noYieldOnly])

  const withYield = rows.filter(r => r.yield_pct !== null).length
  const staleYield = rows.filter(r => yieldStalenessOf(r.yield_as_of) === 'stale').length

  // ─── Single-row edit flow ───

  function openEdit(r: FiRow) {
    setEditing(r)
    setEditYield(r.yield_pct !== null ? r.yield_pct.toString() : '')
    setEditAsOf(r.yield_as_of ?? new Date().toISOString().slice(0, 10))
    setEditNotes(r.yield_notes ?? '')
    setEditError('')
  }

  async function saveEdit() {
    if (!editing) return
    setEditSaving(true)
    setEditError('')
    try {
      const hasYield = editYield.trim().length > 0
      const y = hasYield ? parseFloat(editYield) : null
      if (hasYield && (y === null || !isFinite(y) || y <= 0 || y > 100)) {
        setEditError('Yield must be a positive number between 0 and 100')
        setEditSaving(false)
        return
      }
      const update: any = hasYield
        ? {
            yield_pct: y,
            yield_as_of: editAsOf,
            yield_source: 'manual',
            yield_notes: editNotes || null,
            yield_last_refreshed_at: new Date().toISOString(),
          }
        : {
            yield_pct: null,
            yield_as_of: null,
            yield_source: null,
            yield_notes: null,
            yield_last_refreshed_at: null,
          }

      const { error } = await (supabase.from('instruments') as any)
        .update(update)
        .eq('instrument_id', editing.instrument_id)
      if (error) {
        setEditError(error.message)
        setEditSaving(false)
        return
      }
      setEditing(null)
      await load()
    } catch (e) {
      setEditError((e as Error).message)
    } finally {
      setEditSaving(false)
    }
  }

  // ─── Single-file upload flow (v22, preserved) ───

  function openUpload() {
    setUploadOpen(true)
    setUploadFile(null)
    setUploadError('')
  }

  function onFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] ?? null
    setUploadFile(f)
    setUploadError('')
  }

  async function submitUpload() {
    if (!uploadFile) {
      setUploadError('Choose a file first')
      return
    }
    if (uploadFile.size > 20 * 1024 * 1024) {
      setUploadError('File exceeds 20 MB')
      return
    }
    setUploadLoading(true)
    setUploadError('')
    try {
      const fd = new FormData()
      // v24: API now prefers `files[]` (plural). Server falls back to `file`
      // for backward compat, but we send the new field name.
      fd.append('files', uploadFile)
      const res = await fetch('/api/admin/import-bond-yields', { method: 'POST', body: fd })
      const body = await res.json() as { files?: FileResult[]; error?: string }
      if (!res.ok) {
        setUploadError(body?.error || `HTTP ${res.status}`)
        return
      }
      const fileResult = body.files?.[0]
      if (!fileResult) {
        setUploadError('No result for the uploaded file')
        return
      }
      if (fileResult.error) {
        setUploadError(fileResult.error)
        return
      }
      if (fileResult.results.length === 0) {
        setUploadError('No matches. File parsed but no FI tickers matched. Check the file is the brokerage PrintDownload format.')
        return
      }

      // Coerce numerics (defensive — pitfalls #72/73)
      const review: ReviewRow[] = fileResult.results.map(p => {
        const ytm = numOrNull(p.ytm_pct)
        return {
          ...p,
          coupon_pct:    numOrNull(p.coupon_pct),
          current_yield: numOrNull(p.current_yield),
          clean_price:   numOrNull(p.clean_price) ?? 0,
          ytm_pct:       ytm ?? NaN,
          accepted:      !p.flag && ytm !== null,
        }
      })
      const imp: ImportResponse = {
        settlement_date:      fileResult.settlement_date!,
        rows_in_file:         fileResult.rows_in_file,
        fi_instruments_in_db: fileResult.fi_instruments_in_db,
        matched:              fileResult.matched,
        unmatched_count:      fileResult.unmatched_count,
        unmatched_ids:        fileResult.unmatched_ids,
        results:              fileResult.results,
      }
      setProposals(review)
      setImportMeta(imp)
      setUploadOpen(false)
    } catch (e) {
      setUploadError((e as Error).message)
    } finally {
      setUploadLoading(false)
    }
  }

  // ─── Single-file review + accept ───

  function toggleAccept(idx: number) {
    setProposals(prev => {
      if (!prev) return prev
      const next = [...prev]
      next[idx] = { ...next[idx], accepted: !next[idx].accepted }
      return next
    })
  }

  function toggleAll(accept: boolean) {
    setProposals(prev => prev ? prev.map(p => ({ ...p, accepted: accept && !p.flag && isFinite(p.ytm_pct) })) : prev)
  }

  // v24: now POSTs to /accept which writes yield_history + conditionally
  // updates instruments.yield_*. Replaces the previous N-supabase-calls pattern.
  async function saveBatch() {
    if (!proposals) return
    const accepted = proposals.filter(p => p.accepted && isFinite(p.ytm_pct))
    if (accepted.length === 0) return
    setBatchSaving(true)
    setBatchSaveMsg('')
    try {
      const payload = accepted.map(p => ({
        instrument_id: p.instrument_id,
        yield_pct:     p.ytm_pct,
        yield_as_of:   p.as_of,
        coupon_pct:    p.coupon_pct,
        maturity_date: p.maturity_date,
        clean_price:   p.clean_price,
        notes:         p.notes,
        // v25d: forward liquidity capture from import route → /accept → yield_history
        volume:        (p as any).volume     ?? null,
        deals:         (p as any).deals      ?? null,
        value_ngn:     (p as any).value_ngn  ?? null,
      }))
      const res = await fetch('/api/admin/import-bond-yields/accept', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ proposals: payload }),
      })
      const body = await res.json()
      if (!res.ok) {
        setBatchSaveMsg(`\u2717 ${body?.error || 'Accept failed'}`)
        return
      }
      setBatchSaveMsg(`\u2713 Saved ${body.history_inserted} to history, ${body.current_updated} updated to current`)
      setProposals(null)
      setImportMeta(null)
      await load()
    } catch (e) {
      setBatchSaveMsg(`\u2717 ${(e as Error).message}`)
    } finally {
      setBatchSaving(false)
      setTimeout(() => setBatchSaveMsg(''), 8000)
    }
  }

  // ─── Bulk historical upload flow (v24) ───

  function openBulk() {
    setBulkOpen(true)
    setBulkFiles([])
    setBulkParseError('')
  }

  function onBulkFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const fs = Array.from(e.target.files ?? [])
    setBulkFiles(fs)
    setBulkParseError('')
  }

  async function submitBulk() {
    if (bulkFiles.length === 0) {
      setBulkParseError('Choose at least one file')
      return
    }
    if (bulkFiles.length > 80) {
      setBulkParseError(`Maximum 80 files per batch (got ${bulkFiles.length})`)
      return
    }
    const oversized = bulkFiles.filter(f => f.size > 20 * 1024 * 1024)
    if (oversized.length > 0) {
      setBulkParseError(`${oversized.length} file(s) exceed 20 MB: ${oversized.map(f => f.name).join(', ')}`)
      return
    }
    setBulkParsing(true)
    setBulkParseError('')
    try {
      const fd = new FormData()
      for (const f of bulkFiles) fd.append('files', f)
      const res = await fetch('/api/admin/import-bond-yields', { method: 'POST', body: fd })
      const body = await res.json() as { files?: FileResult[]; error?: string }
      if (!res.ok) {
        setBulkParseError(body?.error || `HTTP ${res.status}`)
        return
      }
      const files = body.files ?? []
      if (files.length === 0) {
        setBulkParseError('No files parsed')
        return
      }
      // Coerce numerics in every result row
      const coerced: FileResult[] = files.map(f => ({
        ...f,
        results: (f.results ?? []).map(p => ({
          ...p,
          coupon_pct:    numOrNull(p.coupon_pct),
          current_yield: numOrNull(p.current_yield),
          clean_price:   numOrNull(p.clean_price) ?? 0,
          ytm_pct:       numOrNull(p.ytm_pct) ?? NaN,
        })),
      }))
      // Default selection: include any file that parsed AND has at least 1
      // valid (no flag, finite YTM) proposal
      const sels = new Map<string, boolean>()
      for (const f of coerced) {
        const hasValid = !f.error && f.results.some(p => !p.flag && isFinite(p.ytm_pct))
        sels.set(f.filename, hasValid)
      }
      setBulkResults(coerced)
      setBulkSelections(sels)
      setBulkOpen(false)
    } catch (e) {
      setBulkParseError((e as Error).message)
    } finally {
      setBulkParsing(false)
    }
  }

  function toggleBulkFile(filename: string) {
    setBulkSelections(prev => {
      const next = new Map(prev)
      next.set(filename, !next.get(filename))
      return next
    })
  }

  function toggleAllBulk(include: boolean) {
    setBulkSelections(prev => {
      const next = new Map<string, boolean>()
      for (const f of bulkResults ?? []) {
        const eligible = !f.error && f.results.some(p => !p.flag && isFinite(p.ytm_pct))
        next.set(f.filename, include && eligible)
      }
      return next
    })
  }

  async function saveBulk() {
    if (!bulkResults) return
    const includedFiles = bulkResults.filter(f => bulkSelections.get(f.filename))
    const proposals: any[] = []
    for (const f of includedFiles) {
      for (const p of f.results) {
        if (!p.flag && isFinite(p.ytm_pct)) {
          proposals.push({
            instrument_id: p.instrument_id,
            yield_pct:     p.ytm_pct,
            yield_as_of:   p.as_of,
            coupon_pct:    p.coupon_pct,
            maturity_date: p.maturity_date,
            clean_price:   p.clean_price,
            notes:         p.notes,
            // v25d: forward liquidity capture from import route → /accept → yield_history
            volume:        (p as any).volume     ?? null,
            deals:         (p as any).deals      ?? null,
            value_ngn:     (p as any).value_ngn  ?? null,
          })
        }
      }
    }
    if (proposals.length === 0) {
      setBulkSaveError('No valid proposals across the selected files')
      return
    }
    setBulkSaving(true)
    setBulkSaveError('')
    try {
      const res = await fetch('/api/admin/import-bond-yields/accept', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ proposals }),
      })
      const body = await res.json()
      if (!res.ok) {
        setBulkSaveError(body?.error || `HTTP ${res.status}`)
        return
      }
      setBatchSaveMsg(`\u2713 Bulk: ${body.history_inserted} historical yields across ${body.unique_dates} dates · ${body.current_updated} updated to current`)
      setBulkResults(null)
      setBulkSelections(new Map())
      await load()
    } catch (e) {
      setBulkSaveError((e as Error).message)
    } finally {
      setBulkSaving(false)
      setTimeout(() => setBatchSaveMsg(''), 12000)
    }
  }

  // Helpers for the bulk-results header summary
  const bulkSummary = useMemo(() => {
    if (!bulkResults) return null
    const inc = bulkResults.filter(f => bulkSelections.get(f.filename))
    let total = 0, valid = 0, flagged = 0
    const dates = new Set<string>()
    for (const f of inc) {
      for (const p of f.results) {
        total++
        if (p.flag || !isFinite(p.ytm_pct)) flagged++
        else valid++
      }
      if (f.settlement_date) dates.add(f.settlement_date)
    }
    const sortedDates = Array.from(dates).sort()
    return {
      includedFiles:  inc.length,
      totalFiles:     bulkResults.length,
      total, valid, flagged,
      uniqueDates:    sortedDates.length,
      minDate:        sortedDates[0] ?? null,
      maxDate:        sortedDates[sortedDates.length - 1] ?? null,
    }
  }, [bulkResults, bulkSelections])

  return (
    <main className="hybrid-page" style={{ padding: '32px 44px 64px', minHeight: '100vh' }}>
      <div className="page-head">
        <div>
          <Link
            href="/admin"
            className="eyebrow"
            style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 10, textDecoration: 'none' }}
          >
            <ArrowLeft size={11} /> Admin panel
          </Link>
          <h1 className="hybrid-serif" style={{ fontSize: 36, fontWeight: 500, letterSpacing: '-0.005em', lineHeight: 1, color: 'var(--text)' }}>
            Fixed income
          </h1>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          {batchSaveMsg && (
            <span style={{ fontSize: 11, color: batchSaveMsg.startsWith('\u2713') ? 'var(--pos)' : 'var(--neg)' }}>
              {batchSaveMsg}
            </span>
          )}
          <button
            className="btn-h"
            onClick={openBulk}
            title="Upload multiple historical brokerage files at once"
          >
            <History size={12} />
            Bulk historical upload
          </button>
          <button
            className="btn-h btn-h-primary"
            onClick={openUpload}
          >
            <Upload size={12} />
            Upload brokerage file
          </button>
        </div>
      </div>

      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>

      <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 18, lineHeight: 1.6 }}>
        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{rows.length}</span> fixed income instruments ·{' '}
        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{withYield}</span> with current yield ·{' '}
        {staleYield > 0 ? (
          <span style={{ color: 'var(--warn)' }}>
            {staleYield} stale (older than {YIELD_STALE_DAYS} days)
          </span>
        ) : (
          <span style={{ color: 'var(--pos)' }}>All yields fresh</span>
        )}
        . Single file → review per row. Bulk historical → multi-file with per-file summary, populates yield_history for time-series analysis.
      </div>

      <div style={{ maxWidth: 1400 }}>
        {/* Filters */}
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 12, marginBottom: 14 }}>
          <div style={{ position: 'relative', flex: 1, minWidth: 200, maxWidth: 320 }}>
            <Search size={12} style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)' }} />
            <input
              type="text" value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search by ticker or name…" className="input-h input-h-sm"
              style={{ paddingLeft: 32 }}
            />
          </div>
          <select value={subTypeFilter} onChange={e => setSubTypeFilter(e.target.value)} className="select-h" style={{ width: 200, padding: '5px 32px 5px 10px', fontSize: 12 }}>
            <option value="all">All sub-types ({rows.length})</option>
            {subTypes.map(s => {
              const n = rows.filter(r => r.sub_type === s).length
              return <option key={s} value={s}>{s} ({n})</option>
            })}
          </select>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-2)', cursor: 'pointer', userSelect: 'none' as const }}>
            <input type="checkbox" checked={noYieldOnly} onChange={e => setNoYieldOnly(e.target.checked)} style={{ accentColor: 'var(--gold)' }} />
            No yield yet
          </label>
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--text-2)', cursor: 'pointer', userSelect: 'none' as const }}>
            <input type="checkbox" checked={staleOnly} onChange={e => setStaleOnly(e.target.checked)} style={{ accentColor: 'var(--warn)' }} />
            Stale yields
          </label>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginLeft: 'auto' }}>
            {filtered.length} shown
          </div>
        </div>

        {/* v25: yield curve panel */}
        <YieldCurvePanel />

        {/* Table */}
        <div className="panel" style={{ padding: 0, overflowX: 'auto' }}>
          {loading ? (
            <div style={{ padding: '32px 20px', textAlign: 'center', fontSize: 12, color: 'var(--text-3)' }}>Loading…</div>
          ) : filtered.length === 0 ? (
            <div style={{ padding: '32px 20px', textAlign: 'center', fontSize: 12, color: 'var(--text-3)' }}>No instruments match your filters</div>
          ) : (
            <table className="h-table" style={{ width: '100%', minWidth: 1100 }}>
              <thead>
                <tr>
                  <th>Instrument</th>
                  <th>Sub-type</th>
                  <th className="num">Coupon</th>
                  <th>Maturity</th>
                  <th className="num">Tenor</th>
                  <th className="num">Yield</th>
                  <th className="num" title="Modified duration: % price change per 100bps yield change">Mod dur</th>
                  <th className="num" title="Convexity">Convexity</th>
                  <th title="Volume-Weighted Confidence: traded / quoted / stale">VWC</th>
                  <th>Source</th>
                  <th>As of</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(r => {
                  const stale = yieldStalenessOf(r.yield_as_of)
                  const dotColor = stale === 'fresh' ? 'var(--pos)' : stale === 'stale' ? 'var(--warn)' : 'var(--text-4)'
                  const dotTitle = stale === 'fresh' ? `Fresh (within ${YIELD_STALE_DAYS} days)` : stale === 'stale' ? `Stale (older than ${YIELD_STALE_DAYS} days)` : 'No yield recorded'
                  return (
                    <tr key={r.instrument_id}>
                      <td>
                        <div style={{ fontWeight: 500 }}>{r.name}</div>
                        <div style={{ fontSize: 10, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
                          {r.instrument_id}
                        </div>
                      </td>
                      <td>
                        {r.sub_type && (
                          <span style={{ fontSize: 10, padding: '2px 7px', borderRadius: 2, background: 'var(--gold-soft)', color: 'var(--gold)', border: '1px solid rgba(176, 139, 62, 0.24)', fontWeight: 600, letterSpacing: '0.03em', textTransform: 'uppercase' as const, whiteSpace: 'nowrap' as const }}>
                            {r.sub_type}
                          </span>
                        )}
                      </td>
                      <td className="num" style={{ fontFamily: 'var(--font-mono)', color: hasNum(r.coupon_pct) ? 'var(--text-2)' : 'var(--text-4)' }}>
                        {fmtPct(r.coupon_pct)}
                      </td>
                      <td style={{ fontSize: 12, color: r.maturity_date ? 'var(--text-2)' : 'var(--text-4)' }}>
                        {formatMaturity(r.maturity_date)}
                      </td>
                      <td className="num" style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-2)' }}>
                        {formatTenor(r.maturity_date)}
                      </td>
                      <td className="num" style={{ fontFamily: 'var(--font-mono)' }}>
                        {hasNum(r.yield_pct)
                          ? <span style={{ fontWeight: 500, color: 'var(--text)' }}>{fmtPct(r.yield_pct)}</span>
                          : <span style={{ color: 'var(--text-4)' }}>—</span>}
                      </td>
                      <td className="num" style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: r.mod_duration !== null ? 'var(--text-2)' : 'var(--text-4)' }}>
                        {r.mod_duration !== null ? `${r.mod_duration.toFixed(2)}y` : '—'}
                      </td>
                      <td className="num" style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: r.convexity !== null ? 'var(--text-2)' : 'var(--text-4)' }}>
                        {r.convexity !== null ? r.convexity.toFixed(1) : '—'}
                      </td>
                      <td>
                        <span style={{
                          fontSize: 9, padding: '2px 7px', borderRadius: 2,
                          background: r.vwc_tag === 'traded' ? 'rgba(45, 110, 78, 0.12)' : r.vwc_tag === 'stale' ? 'rgba(166, 124, 42, 0.14)' : 'var(--bg-soft)',
                          color: r.vwc_tag === 'traded' ? 'var(--pos)' : r.vwc_tag === 'stale' ? 'var(--warn)' : 'var(--text-3)',
                          border: '1px solid var(--border-soft)',
                          fontWeight: 600, letterSpacing: '0.06em', textTransform: 'uppercase' as const, whiteSpace: 'nowrap' as const,
                        }}>
                          {r.vwc_tag}
                        </span>
                      </td>
                      <td>
                        {r.yield_source
                          ? <span style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-2)', textTransform: 'uppercase' as const, letterSpacing: '0.06em' }}>{r.yield_source}</span>
                          : <span style={{ fontSize: 10, color: 'var(--text-4)' }}>—</span>}
                      </td>
                      <td style={{ fontSize: 12 }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} title={dotTitle}>
                          <span style={{ width: 7, height: 7, borderRadius: '50%', background: dotColor, display: 'inline-block', flexShrink: 0 }} />
                          <span style={{ color: stale === 'stale' ? 'var(--warn)' : stale === 'none' ? 'var(--text-3)' : 'var(--text-2)' }}>
                            {formatDate(r.yield_as_of)}
                          </span>
                        </span>
                      </td>
                      <td>
                        <button onClick={() => openEdit(r)} className="btn-h" style={{ fontSize: 11, padding: '4px 10px' }} title="Edit yield">
                          <Edit2 size={11} /> Edit
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>

        <div style={{ marginTop: 16, fontSize: 11, color: 'var(--text-3)', display: 'flex', alignItems: 'flex-start', gap: 6, lineHeight: 1.6, maxWidth: 860 }}>
          <Info size={11} style={{ marginTop: 2, flexShrink: 0 }} />
          <span>
            Yields feed AI report generation and scenario analysis. YTM is computed from the brokerage clean price,
            coupon, and maturity using a standard semi-annual bond formula. Outlier yields ({'>'} 50% or {'<'} 5%)
            are flagged for review — usually a sign the clean price is stale. Manual Edit takes precedence.
            All accepted yields write to <code style={{ fontSize: 10, padding: '1px 4px', background: 'var(--bg-soft)', borderRadius: 2 }}>yield_history</code>;
            current values on this page reflect the most-recent date for each instrument.
          </span>
        </div>
      </div>

      {/* ─── Single-row edit modal ─── */}
      {editing && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(10,31,58,.55)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: '0 16px' }}
          onClick={() => setEditing(null)}
        >
          <div className="panel" style={{ maxWidth: 480, width: '100%', margin: 0 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 18 }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.18em', color: 'var(--gold)', textTransform: 'uppercase' as const }}>Update yield</div>
                <div className="hybrid-serif" style={{ fontSize: 20, fontWeight: 500, marginTop: 4, color: 'var(--text)' }}>{editing.name}</div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', fontFamily: 'var(--font-mono)', marginTop: 2 }}>
                  {editing.instrument_id}
                  {hasNum(editing.coupon_pct) ? ` · ${fmtPct(editing.coupon_pct)} coupon` : ''}
                  {editing.maturity_date ? ` · matures ${formatMaturity(editing.maturity_date)}` : ''}
                </div>
              </div>
              <button onClick={() => setEditing(null)} style={{ color: 'var(--text-3)', background: 'none', border: 'none', cursor: 'pointer', padding: 4 }}>
                <X size={16} />
              </button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

              {hasNum(editing.yield_pct) ? (
                <div style={{ fontSize: 11, color: 'var(--text-2)', background: 'var(--bg-soft)', borderRadius: 3, padding: '8px 12px', border: '1px solid var(--border-soft)' }}>
                  <div style={{ fontSize: 10, color: 'var(--text-3)', textTransform: 'uppercase' as const, letterSpacing: '0.1em', marginBottom: 3 }}>Current yield</div>
                  <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{fmtPct(editing.yield_pct)}</span>{' · '}
                  <span style={{ fontFamily: 'var(--font-mono)', textTransform: 'uppercase' as const, fontSize: 10 }}>{editing.yield_source}</span>{' · as of '}{formatDate(editing.yield_as_of)}
                </div>
              ) : (
                <div className="alert-h alert-h-warn" style={{ fontSize: 11 }}>No yield recorded yet for this instrument.</div>
              )}

              <div>
                <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>
                  Yield (%)
                  <span style={{ color: 'var(--text-4)', marginLeft: 6, fontSize: 10 }}>— leave blank to clear</span>
                </label>
                <input
                  type="number"
                  value={editYield}
                  onChange={e => setEditYield(e.target.value)}
                  step="0.01"
                  placeholder="e.g. 18.75"
                  className="input-h input-h-mono"
                  autoFocus
                />
              </div>

              {editYield && parseFloat(editYield) > 0 && (
                <div>
                  <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>As of date</label>
                  <input type="date" value={editAsOf} onChange={e => setEditAsOf(e.target.value)} className="input-h input-h-mono" />
                </div>
              )}

              <div>
                <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>
                  Notes
                  <span style={{ color: 'var(--text-4)', marginLeft: 6, fontSize: 10 }}>— optional source detail</span>
                </label>
                <input
                  type="text"
                  value={editNotes}
                  onChange={e => setEditNotes(e.target.value)}
                  placeholder="e.g. Investing.com 23 April, or DMO auction 15 April"
                  className="input-h"
                />
              </div>

              {editError && (
                <div className="alert-h alert-h-critical" style={{ fontSize: 11 }}>
                  <AlertCircle size={11} style={{ flexShrink: 0, marginTop: 1 }} /><span>{editError}</span>
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, paddingTop: 4 }}>
                <button
                  onClick={saveEdit}
                  disabled={editSaving}
                  className="btn-h btn-h-primary"
                  style={{ flex: 1, justifyContent: 'center' }}
                >
                  <Save size={12} /> {editSaving ? 'Saving…' : 'Save'}
                </button>
                <button onClick={() => setEditing(null)} className="btn-h">Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ─── Single-file upload modal ─── */}
      {uploadOpen && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(10,31,58,.55)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 24 }}
          onClick={() => !uploadLoading && setUploadOpen(false)}
        >
          <div className="panel" style={{ maxWidth: 600, width: '100%', margin: 0 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.18em', color: 'var(--gold)', textTransform: 'uppercase' as const }}>Refresh yields</div>
                <div className="hybrid-serif" style={{ fontSize: 22, fontWeight: 500, marginTop: 4, color: 'var(--text)' }}>
                  Upload brokerage file
                </div>
              </div>
              <button onClick={() => !uploadLoading && setUploadOpen(false)} disabled={uploadLoading} style={{ color: 'var(--text-3)', background: 'none', border: 'none', cursor: uploadLoading ? 'not-allowed' : 'pointer', padding: 4 }}>
                <X size={16} />
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>

              <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.6, background: 'var(--bg-soft)', padding: '12px 14px', borderRadius: 3, border: '1px solid var(--border-soft)' }}>
                <strong style={{ color: 'var(--text)' }}>How this works:</strong> choose a Brokerage PrintDownload Price List xlsx
                — the same format you use for equity NAV reconstruction. We extract the clean prices for your fixed income
                universe and compute YTM from coupon + maturity + clean price server-side. You review the proposals before
                anything saves. Equity prices in the file are untouched by this route.
              </div>

              <div>
                <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>
                  File
                  <span style={{ color: 'var(--text-4)', marginLeft: 6, fontSize: 10 }}>— .xlsx, up to 20 MB</span>
                </label>
                <div style={{
                  border: '1px dashed var(--border-strong)',
                  borderRadius: 4,
                  padding: '18px 14px',
                  background: 'var(--bg-soft)',
                  textAlign: 'center' as const,
                }}>
                  <input
                    type="file"
                    accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    onChange={onFileChange}
                    disabled={uploadLoading}
                    style={{ display: 'block', margin: '0 auto', fontSize: 12 }}
                  />
                  {uploadFile && (
                    <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-2)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <FileSpreadsheet size={12} />
                      <span style={{ fontFamily: 'var(--font-mono)' }}>{uploadFile.name}</span>
                      <span style={{ color: 'var(--text-3)' }}>· {(uploadFile.size / 1024).toFixed(0)} KB</span>
                    </div>
                  )}
                </div>
              </div>

              {uploadError && (
                <div className="alert-h alert-h-critical" style={{ fontSize: 11, display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                  <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span>{uploadError}</span>
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, paddingTop: 4 }}>
                <button
                  onClick={submitUpload}
                  disabled={uploadLoading || !uploadFile}
                  className="btn-h btn-h-primary"
                  style={{ flex: 1, justifyContent: 'center' }}
                >
                  <Sparkles size={12} style={uploadLoading ? { animation: 'spin 0.7s linear infinite' } : undefined} />
                  {uploadLoading ? 'Parsing & computing YTM…' : 'Parse & propose yields'}
                </button>
                <button onClick={() => setUploadOpen(false)} disabled={uploadLoading} className="btn-h">Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ─── Single-file proposals review modal ─── */}
      {proposals && importMeta && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(10,31,58,.55)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 24 }}
          onClick={() => !batchSaving && setProposals(null)}
        >
          <div className="panel" style={{ maxWidth: 1100, width: '100%', margin: 0, maxHeight: '88vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.18em', color: 'var(--gold)', textTransform: 'uppercase' as const }}>Review computed yields</div>
                <div className="hybrid-serif" style={{ fontSize: 22, fontWeight: 500, marginTop: 4, color: 'var(--text)' }}>
                  {proposals.length} yield{proposals.length === 1 ? '' : 's'} computed · {formatDate(importMeta.settlement_date)}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
                  File: {importMeta.rows_in_file.toLocaleString()} rows · Matched {importMeta.matched} of {importMeta.fi_instruments_in_db} FI instruments{importMeta.unmatched_count > 0 ? ` · ${importMeta.unmatched_count} unmatched` : ''}
                </div>
              </div>
              <button onClick={() => !batchSaving && setProposals(null)} disabled={batchSaving} style={{ color: 'var(--text-3)', background: 'none', border: 'none', cursor: batchSaving ? 'not-allowed' : 'pointer', padding: 4 }}>
                <X size={16} />
              </button>
            </div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 10, fontSize: 11 }}>
              <button onClick={() => toggleAll(true)} disabled={batchSaving} className="btn-h" style={{ fontSize: 11, padding: '3px 10px' }}>Select all valid</button>
              <button onClick={() => toggleAll(false)} disabled={batchSaving} className="btn-h" style={{ fontSize: 11, padding: '3px 10px' }}>Deselect all</button>
              <div style={{ marginLeft: 'auto', alignSelf: 'center', color: 'var(--text-3)' }}>
                {proposals.filter(p => p.accepted).length} of {proposals.length} selected
              </div>
            </div>

            <div style={{ overflowY: 'auto', flex: 1, border: '1px solid var(--border-soft)', borderRadius: 3 }}>
              <table className="h-table" style={{ width: '100%' }}>
                <thead style={{ position: 'sticky' as const, top: 0, background: 'var(--card)', zIndex: 1 }}>
                  <tr>
                    <th style={{ width: 36 }}></th>
                    <th>Instrument</th>
                    <th className="num">Coupon</th>
                    <th className="num">Clean price</th>
                    <th className="num">Current yield</th>
                    <th className="num">Computed YTM</th>
                    <th>Flag</th>
                  </tr>
                </thead>
                <tbody>
                  {proposals.map((p, i) => {
                    const flaggedOrBad = !!p.flag || !isFinite(p.ytm_pct)
                    return (
                      <tr key={p.instrument_id} style={p.accepted ? {} : { opacity: flaggedOrBad ? 0.55 : 0.45 }}>
                        <td>
                          <input
                            type="checkbox"
                            checked={p.accepted}
                            onChange={() => toggleAccept(i)}
                            disabled={batchSaving || !isFinite(p.ytm_pct)}
                            style={{ accentColor: 'var(--gold)' }}
                            title={!isFinite(p.ytm_pct) ? 'Cannot save: no valid YTM' : undefined}
                          />
                        </td>
                        <td>
                          <div style={{ fontSize: 12, fontWeight: 500 }}>{p.name}</div>
                          <div style={{ fontSize: 10, color: 'var(--text-3)', fontFamily: 'var(--font-mono)' }}>
                            {p.instrument_id} · matures {formatMaturity(p.maturity_date)}
                          </div>
                        </td>
                        <td className="num" style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-2)' }}>
                          {fmtPct(p.coupon_pct)}
                        </td>
                        <td className="num" style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text-2)' }}>
                          {fmtNaira(p.clean_price)}
                        </td>
                        <td className="num" style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: hasNum(p.current_yield) ? 'var(--text-3)' : 'var(--text-4)' }}>
                          {fmtPct(p.current_yield)}
                        </td>
                        <td className="num" style={{ fontFamily: 'var(--font-mono)', fontWeight: 500, color: p.flag ? 'var(--warn)' : 'var(--gold)' }}>
                          {fmtPct(p.ytm_pct)}
                        </td>
                        <td style={{ fontSize: 11 }}>
                          {p.flag ? (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--warn)' }} title={p.flag_explanation ?? ''}>
                              <AlertTriangle size={11} /> {p.flag}
                            </span>
                          ) : (
                            <span style={{ color: 'var(--pos)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                              <CheckCircle2 size={11} /> OK
                            </span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            <div style={{ display: 'flex', gap: 8, paddingTop: 14, borderTop: '1px solid var(--border-soft)', marginTop: 12 }}>
              <button
                onClick={saveBatch}
                disabled={batchSaving || proposals.filter(p => p.accepted).length === 0}
                className="btn-h btn-h-primary"
                style={{ flex: 1, justifyContent: 'center' }}
              >
                <CheckCircle2 size={12} />
                {batchSaving ? 'Saving…' : `Accept ${proposals.filter(p => p.accepted).length} yield${proposals.filter(p => p.accepted).length === 1 ? '' : 's'}`}
              </button>
              <button onClick={() => setProposals(null)} disabled={batchSaving} className="btn-h">Cancel</button>
            </div>
          </div>
        </div>
      )}

      {/* ─── v24: Bulk historical upload modal ─── */}
      {bulkOpen && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(10,31,58,.55)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 24 }}
          onClick={() => !bulkParsing && setBulkOpen(false)}
        >
          <div className="panel" style={{ maxWidth: 700, width: '100%', margin: 0 }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.18em', color: 'var(--gold)', textTransform: 'uppercase' as const }}>Historical onboarding</div>
                <div className="hybrid-serif" style={{ fontSize: 22, fontWeight: 500, marginTop: 4, color: 'var(--text)' }}>
                  Bulk historical upload
                </div>
              </div>
              <button onClick={() => !bulkParsing && setBulkOpen(false)} disabled={bulkParsing} style={{ color: 'var(--text-3)', background: 'none', border: 'none', cursor: bulkParsing ? 'not-allowed' : 'pointer', padding: 4 }}>
                <X size={16} />
              </button>
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div style={{ fontSize: 12, color: 'var(--text-2)', lineHeight: 1.6, background: 'var(--bg-soft)', padding: '12px 14px', borderRadius: 3, border: '1px solid var(--border-soft)' }}>
                <strong style={{ color: 'var(--text)' }}>Upload N monthly EOM brokerage files at once.</strong> Each file's
                as-of date is auto-detected from the Market Day column. Server computes YTM per row, returns a per-file summary
                you can review before saving. All accepted yields are written to <code style={{ fontSize: 10 }}>yield_history</code>;
                the most-recent date for each instrument also updates the current snapshot used by AI reports.
                Maximum 80 files per batch. Re-uploading the same date is idempotent.
              </div>

              <div>
                <label style={{ display: 'block', fontSize: 11, color: 'var(--text-2)', marginBottom: 6 }}>
                  Files
                  <span style={{ color: 'var(--text-4)', marginLeft: 6, fontSize: 10 }}>— select multiple .xlsx files (Cmd/Ctrl-click)</span>
                </label>
                <div style={{
                  border: '1px dashed var(--border-strong)',
                  borderRadius: 4,
                  padding: '18px 14px',
                  background: 'var(--bg-soft)',
                  textAlign: 'center' as const,
                }}>
                  <input
                    type="file"
                    multiple
                    accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                    onChange={onBulkFileChange}
                    disabled={bulkParsing}
                    style={{ display: 'block', margin: '0 auto', fontSize: 12 }}
                  />
                  {bulkFiles.length > 0 && (
                    <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-2)', display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                      <FileSpreadsheet size={12} />
                      <span>{bulkFiles.length} file{bulkFiles.length === 1 ? '' : 's'} selected</span>
                      <span style={{ color: 'var(--text-3)' }}>· {(bulkFiles.reduce((s, f) => s + f.size, 0) / 1024 / 1024).toFixed(1)} MB total</span>
                    </div>
                  )}
                </div>
              </div>

              {bulkParseError && (
                <div className="alert-h alert-h-critical" style={{ fontSize: 11, display: 'flex', alignItems: 'flex-start', gap: 6 }}>
                  <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                  <span>{bulkParseError}</span>
                </div>
              )}

              <div style={{ display: 'flex', gap: 8, paddingTop: 4 }}>
                <button
                  onClick={submitBulk}
                  disabled={bulkParsing || bulkFiles.length === 0}
                  className="btn-h btn-h-primary"
                  style={{ flex: 1, justifyContent: 'center' }}
                >
                  <Sparkles size={12} style={bulkParsing ? { animation: 'spin 0.7s linear infinite' } : undefined} />
                  {bulkParsing ? `Parsing ${bulkFiles.length} file${bulkFiles.length === 1 ? '' : 's'}…` : `Parse ${bulkFiles.length || ''} file${bulkFiles.length === 1 ? '' : 's'}`}
                </button>
                <button onClick={() => setBulkOpen(false)} disabled={bulkParsing} className="btn-h">Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ─── v24: Bulk historical results modal ─── */}
      {bulkResults && bulkSummary && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(10,31,58,.55)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50, padding: 24 }}
          onClick={() => !bulkSaving && setBulkResults(null)}
        >
          <div className="panel" style={{ maxWidth: 1100, width: '100%', margin: 0, maxHeight: '88vh', display: 'flex', flexDirection: 'column' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 14 }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 600, letterSpacing: '0.18em', color: 'var(--gold)', textTransform: 'uppercase' as const }}>Bulk parsed</div>
                <div className="hybrid-serif" style={{ fontSize: 22, fontWeight: 500, marginTop: 4, color: 'var(--text)' }}>
                  {bulkResults.length} file{bulkResults.length === 1 ? '' : 's'} parsed
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
                  Selected: {bulkSummary.includedFiles} of {bulkSummary.totalFiles} files ·{' '}
                  <span style={{ color: 'var(--pos)', fontWeight: 500 }}>{bulkSummary.valid.toLocaleString()} valid</span>
                  {bulkSummary.flagged > 0 && <span style={{ color: 'var(--warn)' }}> · {bulkSummary.flagged} flagged</span>}
                  {bulkSummary.uniqueDates > 0 && <span> · {bulkSummary.uniqueDates} unique date{bulkSummary.uniqueDates === 1 ? '' : 's'} ({formatDate(bulkSummary.minDate)} → {formatDate(bulkSummary.maxDate)})</span>}
                </div>
              </div>
              <button onClick={() => !bulkSaving && setBulkResults(null)} disabled={bulkSaving} style={{ color: 'var(--text-3)', background: 'none', border: 'none', cursor: bulkSaving ? 'not-allowed' : 'pointer', padding: 4 }}>
                <X size={16} />
              </button>
            </div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 10, fontSize: 11 }}>
              <button onClick={() => toggleAllBulk(true)} disabled={bulkSaving} className="btn-h" style={{ fontSize: 11, padding: '3px 10px' }}>Include all</button>
              <button onClick={() => toggleAllBulk(false)} disabled={bulkSaving} className="btn-h" style={{ fontSize: 11, padding: '3px 10px' }}>Exclude all</button>
            </div>

            <div style={{ overflowY: 'auto', flex: 1, border: '1px solid var(--border-soft)', borderRadius: 3 }}>
              <table className="h-table" style={{ width: '100%' }}>
                <thead style={{ position: 'sticky' as const, top: 0, background: 'var(--card)', zIndex: 1 }}>
                  <tr>
                    <th style={{ width: 36 }}></th>
                    <th>File</th>
                    <th>Date</th>
                    <th className="num">Match</th>
                    <th className="num">Valid</th>
                    <th className="num">Flagged</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {bulkResults.map(f => {
                    const eligible = !f.error && f.results.some(p => !p.flag && isFinite(p.ytm_pct))
                    const included = !!bulkSelections.get(f.filename)
                    const valid = f.results.filter(p => !p.flag && isFinite(p.ytm_pct)).length
                    const flagged = f.results.filter(p => p.flag || !isFinite(p.ytm_pct)).length
                    return (
                      <tr key={f.filename} style={included ? {} : { opacity: 0.55 }}>
                        <td>
                          <input
                            type="checkbox"
                            checked={included}
                            onChange={() => toggleBulkFile(f.filename)}
                            disabled={bulkSaving || !eligible}
                            style={{ accentColor: 'var(--gold)' }}
                            title={!eligible ? 'No valid proposals in this file' : undefined}
                          />
                        </td>
                        <td>
                          <div style={{ fontSize: 11, fontFamily: 'var(--font-mono)', color: 'var(--text)' }}>{f.filename}</div>
                          {f.error && (
                            <div style={{ fontSize: 10, color: 'var(--neg)', marginTop: 2 }}>{f.error}</div>
                          )}
                        </td>
                        <td style={{ fontSize: 12, color: 'var(--text-2)' }}>
                          {f.settlement_date ? formatDate(f.settlement_date) : '—'}
                        </td>
                        <td className="num" style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-2)' }}>
                          {f.matched}/{f.fi_instruments_in_db}
                        </td>
                        <td className="num" style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: valid > 0 ? 'var(--pos)' : 'var(--text-4)' }}>
                          {valid}
                        </td>
                        <td className="num" style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: flagged > 0 ? 'var(--warn)' : 'var(--text-4)' }}>
                          {flagged}
                        </td>
                        <td style={{ fontSize: 11 }}>
                          {f.error ? (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--neg)' }}>
                              <AlertCircle size={11} /> error
                            </span>
                          ) : valid === 0 ? (
                            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--text-3)' }}>
                              <AlertTriangle size={11} /> no valid
                            </span>
                          ) : (
                            <span style={{ color: 'var(--pos)', display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                              <CheckCircle2 size={11} /> ok
                            </span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {bulkSaveError && (
              <div className="alert-h alert-h-critical" style={{ fontSize: 11, display: 'flex', alignItems: 'flex-start', gap: 6, marginTop: 10 }}>
                <AlertCircle size={13} style={{ flexShrink: 0, marginTop: 1 }} />
                <span>{bulkSaveError}</span>
              </div>
            )}

            <div style={{ display: 'flex', gap: 8, paddingTop: 14, borderTop: '1px solid var(--border-soft)', marginTop: 12 }}>
              <button
                onClick={saveBulk}
                disabled={bulkSaving || bulkSummary.valid === 0}
                className="btn-h btn-h-primary"
                style={{ flex: 1, justifyContent: 'center' }}
              >
                <CheckCircle2 size={12} />
                {bulkSaving
                  ? 'Saving…'
                  : `Accept ${bulkSummary.valid.toLocaleString()} valid yield${bulkSummary.valid === 1 ? '' : 's'} across ${bulkSummary.uniqueDates} date${bulkSummary.uniqueDates === 1 ? '' : 's'}`}
              </button>
              <button onClick={() => setBulkResults(null)} disabled={bulkSaving} className="btn-h">Cancel</button>
            </div>
          </div>
        </div>
      )}
    </main>
  )
}
