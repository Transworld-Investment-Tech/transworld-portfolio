'use client'
import { useState, useRef, useCallback } from 'react'
import Link from 'next/link'
import { ArrowLeft, Upload, RefreshCw, CheckCircle, AlertCircle, FileSpreadsheet, Database } from 'lucide-react'

// v21o: Historical price importer + NAV reconstruction.
//
// Step 1 — Import: Upload all Brokerage PrintDownload Price List xlsx files.
//   Files are batched in groups of 8 to stay within Vercel body size limits.
//   Each file = one month-end snapshot of the full NGX universe.
//   Prices are upserted into market_prices with source='historical-import'.
//   Existing NGX live prices are never overwritten (ignoreDuplicates).
//
// Step 2 — Reconstruct: After prices are imported, replay every portfolio's
//   transaction history at each price date to compute a historical NAV.
//   Inserts into nav_log, unlocking all sub-period performance tabs.
//
// NOTE: If you see tickers in "Unknown tickers" for securities you hold,
// add aliases at /admin/aliases. E.g. ACCESS → ACCESSCORP for pre-2023 files.

const BATCH_SIZE = 8

interface BatchResult {
  filesProcessed: number
  rowsImported:   number
  rowsSkipped:    number
  unknownTickers: string[]
  datesImported:  string[]
  error?:         string
}

interface ReconResult {
  navEntriesAdded:     number
  portfoliosProcessed: number
  portfolioResults:    Array<{ portfolioId: string; navEntriesAdded: number }>
  error?: string
}

export default function ImportPricesPage() {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [selectedFiles, setSelectedFiles] = useState<File[]>([])
  const [importing, setImporting] = useState(false)
  const [batchResults, setBatchResults] = useState<BatchResult[]>([])
  const [importDone, setImportDone] = useState(false)
  const [currentBatch, setCurrentBatch] = useState(0)
  const [totalBatches, setTotalBatches] = useState(0)

  const [reconstructing, setReconstructing] = useState(false)
  const [reconResult, setReconResult] = useState<ReconResult | null>(null)

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? [])
      .filter(f => f.name.toLowerCase().endsWith('.xlsx'))
      .sort((a, b) => a.name.localeCompare(b.name))
    setSelectedFiles(files)
    setBatchResults([])
    setImportDone(false)
    setReconResult(null)
  }

  const runImport = useCallback(async () => {
    if (!selectedFiles.length) return
    setImporting(true)
    setBatchResults([])
    setImportDone(false)

    const batches: File[][] = []
    for (let i = 0; i < selectedFiles.length; i += BATCH_SIZE) {
      batches.push(selectedFiles.slice(i, i + BATCH_SIZE))
    }
    setTotalBatches(batches.length)
    setCurrentBatch(0)

    const results: BatchResult[] = []

    for (let b = 0; b < batches.length; b++) {
      setCurrentBatch(b + 1)
      const form = new FormData()
      for (const file of batches[b]) form.append('files', file)

      try {
        const res  = await fetch('/api/admin/import-prices', { method: 'POST', body: form })
        const json = await res.json()
        if (!res.ok) {
          results.push({ filesProcessed: 0, rowsImported: 0, rowsSkipped: 0, unknownTickers: [], datesImported: [], error: json.error ?? 'Batch failed' })
        } else {
          results.push(json)
        }
      } catch (e: any) {
        results.push({ filesProcessed: 0, rowsImported: 0, rowsSkipped: 0, unknownTickers: [], datesImported: [], error: e.message })
      }

      setBatchResults([...results])
    }

    setImporting(false)
    setImportDone(true)
  }, [selectedFiles])

  async function runReconstruct() {
    setReconstructing(true)
    setReconResult(null)
    try {
      const res  = await fetch('/api/admin/reconstruct-nav', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) })
      const json = await res.json()
      setReconResult(res.ok ? json : { ...json, error: json.error ?? 'Failed' })
    } catch (e: any) {
      setReconResult({ navEntriesAdded: 0, portfoliosProcessed: 0, portfolioResults: [], error: e.message })
    }
    setReconstructing(false)
  }

  // Running totals from all batches
  const totals = batchResults.reduce(
    (acc, r) => ({
      files:    acc.files    + (r.filesProcessed ?? 0),
      rows:     acc.rows     + (r.rowsImported ?? 0),
      skipped:  acc.skipped  + (r.rowsSkipped ?? 0),
    }),
    { files: 0, rows: 0, skipped: 0 }
  )
  const allUnknown  = Array.from(new Set(batchResults.flatMap(r => r.unknownTickers ?? []))).sort()
  const allDates    = Array.from(new Set(batchResults.flatMap(r => r.datesImported ?? []))).sort()
  const hasErrors   = batchResults.some(r => r.error)
  const progress    = totalBatches > 0 ? Math.round((currentBatch / totalBatches) * 100) : 0

  return (
    <main className="hybrid-page" style={{ padding: '32px 44px 64px', minHeight: '100vh' }}>

      {/* Header */}
      <div className="page-head">
        <div>
          <Link href="/admin" className="eyebrow" style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginBottom: 10, textDecoration: 'none' }}>
            <ArrowLeft size={11} /> Admin panel
          </Link>
          <h1 className="hybrid-serif" style={{ fontSize: 36, fontWeight: 500, letterSpacing: '-0.005em', lineHeight: 1, color: 'var(--text)' }}>
            Import Historical Prices
          </h1>
          <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-3)' }}>
            Upload Brokerage PrintDownload Price Lists → reconstruct NAV history → unlock sub-period performance tabs
          </div>
        </div>
      </div>

      {/* How it works */}
      <div style={{ background: 'var(--gold-soft)', border: '1px solid rgba(176,139,62,0.2)', borderRadius: 4, padding: '14px 18px', marginBottom: 28, fontSize: 12, color: 'var(--text-2)', lineHeight: 1.7 }}>
        <strong style={{ color: 'var(--gold)' }}>How it works:</strong> Each xlsx file = one month-end NGX price snapshot.
        Step 1 seeds prices into the market_prices table. Step 2 replays every portfolio's transactions at each price date to compute a monthly NAV, inserting into nav_log.
        Once nav_log has entries, all performance period tabs (1M, 3M, 6M, 1Y, 2Y, 3Y) become live.
        {' '}<strong style={{ color: 'var(--text)' }}>If any tickers show as "unknown", add aliases at{' '}
        <Link href="/admin/aliases" style={{ color: 'var(--gold)' }}>/admin/aliases</Link>.
        </strong> Common one needed: <code style={{ background: 'var(--bg-soft)', padding: '1px 4px', borderRadius: 2 }}>ACCESS → ACCESSCORP</code> (pre-2023 files).
      </div>

      {/* ─── Step 1: Import ──────────────────────────────────────────────── */}
      <div className="panel" style={{ marginBottom: 24 }}>
        <div className="panel-header">
          <div>
            <div className="panel-title">Step 1 — Import Price Files</div>
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
              Select all your xlsx files at once. They are uploaded in batches of {BATCH_SIZE}.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn-h" onClick={() => fileInputRef.current?.click()} disabled={importing}>
              <FileSpreadsheet size={12} /> Browse files
            </button>
            <button
              className="btn-h btn-h-primary"
              onClick={runImport}
              disabled={importing || selectedFiles.length === 0}
            >
              {importing
                ? <><RefreshCw size={12} className="animate-spin" /> Importing batch {currentBatch}/{totalBatches}…</>
                : <><Upload size={12} /> Import {selectedFiles.length > 0 ? `${selectedFiles.length} files` : 'prices'}</>}
            </button>
          </div>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          accept=".xlsx"
          multiple
          onChange={handleFileChange}
          style={{ display: 'none' }}
        />

        {/* File list */}
        {selectedFiles.length > 0 && (
          <div style={{ marginBottom: 20 }}>
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 8 }}>
              {selectedFiles.length} files selected · {(selectedFiles.reduce((s, f) => s + f.size, 0) / 1e6).toFixed(1)} MB total
            </div>
            <div
              style={{
                maxHeight: 180, overflowY: 'auto',
                background: 'var(--bg-soft)', borderRadius: 4,
                border: '1px solid var(--border-soft)', padding: '8px 12px',
                display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '3px 16px',
                fontSize: 11, color: 'var(--text-2)', fontFamily: 'var(--font-mono)',
              }}
            >
              {selectedFiles.map(f => (
                <span key={f.name} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {f.name}
                </span>
              ))}
            </div>
          </div>
        )}

        {/* Progress bar */}
        {importing && (
          <div style={{ marginBottom: 20 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6, fontSize: 11, color: 'var(--text-2)' }}>
              <span>Batch {currentBatch} of {totalBatches}</span>
              <span>{progress}%</span>
            </div>
            <div style={{ height: 6, background: 'rgba(15,41,71,0.08)', borderRadius: 3, overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${progress}%`, borderRadius: 3, background: 'linear-gradient(90deg, var(--gold), var(--gold-bright))', transition: 'width 0.3s' }} />
            </div>
          </div>
        )}

        {/* Running totals */}
        {batchResults.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12, marginBottom: 20 }}>
            {[
              { label: 'Files processed', value: String(totals.files), color: 'var(--text)' },
              { label: 'Prices imported', value: totals.rows.toLocaleString(), color: 'var(--pos)' },
              { label: 'Rows skipped', value: totals.skipped.toLocaleString(), color: 'var(--text-3)' },
              { label: 'Months covered', value: String(allDates.length), color: 'var(--gold)' },
            ].map(k => (
              <div key={k.label} style={{ padding: '12px 14px', background: 'var(--bg-soft)', border: '1px solid var(--border-soft)', borderRadius: 4 }}>
                <div style={{ fontSize: 10, color: 'var(--text-3)', letterSpacing: '0.12em', fontWeight: 600, textTransform: 'uppercase', marginBottom: 6 }}>{k.label}</div>
                <div className="hybrid-serif" style={{ fontSize: 22, fontWeight: 500, color: k.color }}>{k.value}</div>
              </div>
            ))}
          </div>
        )}

        {/* Dates covered */}
        {allDates.length > 0 && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-2)', marginBottom: 6 }}>Dates covered:</div>
            <div style={{ fontSize: 10, fontFamily: 'var(--font-mono)', color: 'var(--text-3)', lineHeight: 2, display: 'flex', flexWrap: 'wrap', gap: '4px 10px' }}>
              {allDates.map(d => <span key={d}>{d}</span>)}
            </div>
          </div>
        )}

        {/* Unknown tickers warning */}
        {allUnknown.length > 0 && (
          <div style={{ padding: '12px 14px', background: 'rgba(166,124,42,0.08)', border: '1px solid rgba(166,124,42,0.2)', borderRadius: 4, marginBottom: 16 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
              <AlertCircle size={13} style={{ color: 'var(--warn)', marginTop: 1, flexShrink: 0 }} />
              <div>
                <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--warn)', marginBottom: 4 }}>
                  {allUnknown.length} tickers skipped — not in instruments master
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-2)', marginBottom: 8 }}>
                  If any are securities you hold, add an alias at{' '}
                  <Link href="/admin/aliases" style={{ color: 'var(--gold)' }}>/admin/aliases</Link>{' '}
                  and re-import. Common fix: <code style={{ background: 'var(--bg-soft)', padding: '1px 4px', borderRadius: 2 }}>ACCESS → ACCESSCORP</code>
                </div>
                <div style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--text-3)', display: 'flex', flexWrap: 'wrap', gap: '4px 10px' }}>
                  {allUnknown.map(t => <span key={t}>{t}</span>)}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Error list */}
        {hasErrors && (
          <div style={{ padding: '10px 14px', background: 'rgba(166,59,59,0.07)', border: '1px solid rgba(166,59,59,0.2)', borderRadius: 4, fontSize: 11, color: 'var(--neg)' }}>
            {batchResults.filter(r => r.error).map((r, i) => (
              <div key={i}>Batch error: {r.error}</div>
            ))}
          </div>
        )}

        {/* Success banner */}
        {importDone && !hasErrors && (
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '10px 14px', background: 'rgba(45,110,78,0.08)', border: '1px solid rgba(45,110,78,0.2)', borderRadius: 4, fontSize: 12, color: 'var(--pos)' }}>
            <CheckCircle size={14} />
            Import complete — {totals.rows.toLocaleString()} prices across {allDates.length} month-end dates. Proceed to Step 2.
          </div>
        )}
      </div>

      {/* ─── Step 2: Reconstruct NAV ──────────────────────────────────────── */}
      <div className="panel">
        <div className="panel-header">
          <div>
            <div className="panel-title">Step 2 — Reconstruct NAV History</div>
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
              Replays each portfolio's transactions at every imported price date to compute historical NAV snapshots.
              Inserts into nav_log — unlocks all performance period tabs.
            </div>
          </div>
          <button
            className="btn-h btn-h-primary"
            onClick={runReconstruct}
            disabled={reconstructing}
          >
            {reconstructing
              ? <><RefreshCw size={12} className="animate-spin" /> Reconstructing…</>
              : <><Database size={12} /> Reconstruct all portfolios</>}
          </button>
        </div>

        <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 20, lineHeight: 1.7 }}>
          This step is <strong style={{ color: 'var(--text)' }}>idempotent</strong> — safe to run multiple times. It skips dates already in nav_log.
          Run it after importing new price files to extend the NAV history forward.
          After this completes, open any portfolio and try the 1M, 3M, 6M, 1Y, 2Y, 3Y performance tabs.
        </div>

        {reconstructing && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: 'var(--text-3)' }}>
            <RefreshCw size={13} className="animate-spin" />
            Replaying transactions and computing historical NAVs — this may take 20–40 seconds…
          </div>
        )}

        {reconResult && !reconResult.error && (
          <div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '12px 14px', background: 'rgba(45,110,78,0.08)', border: '1px solid rgba(45,110,78,0.2)', borderRadius: 4, marginBottom: 16, fontSize: 12, color: 'var(--pos)' }}>
              <CheckCircle size={14} />
              <strong>{reconResult.navEntriesAdded.toLocaleString()} NAV entries added</strong>
              {' '}across {reconResult.portfoliosProcessed} portfolio{reconResult.portfoliosProcessed !== 1 ? 's' : ''}.
              Sub-period performance tabs are now live.
            </div>
            {reconResult.portfolioResults?.length > 0 && (
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr>
                    {['Portfolio ID', 'NAV entries added', 'Status'].map(h => (
                      <th key={h} style={{ textAlign: 'left', padding: '8px 12px', fontSize: 10, letterSpacing: '0.14em', fontWeight: 600, color: 'var(--text-3)', textTransform: 'uppercase', borderBottom: '1px solid var(--border)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {reconResult.portfolioResults.map((r: any) => (
                    <tr key={r.portfolioId} style={{ borderBottom: '1px solid var(--border-soft)' }}>
                      <td style={{ padding: '10px 12px', fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--text-3)' }}>{r.portfolioId}</td>
                      <td style={{ padding: '10px 12px', fontFamily: 'var(--font-serif)', fontSize: 16, fontWeight: 500, color: r.navEntriesAdded > 0 ? 'var(--pos)' : 'var(--text-3)' }}>
                        {r.navEntriesAdded > 0 ? `+${r.navEntriesAdded}` : '0 (already up to date)'}
                      </td>
                      <td style={{ padding: '10px 12px' }}>
                        <span className={r.navEntriesAdded > 0 ? 'pill pill-ok' : 'pill pill-hold'}>
                          {r.navEntriesAdded > 0 ? 'Updated' : 'Already current'}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        {reconResult?.error && (
          <div style={{ padding: '10px 14px', background: 'rgba(166,59,59,0.07)', border: '1px solid rgba(166,59,59,0.2)', borderRadius: 4, fontSize: 12, color: 'var(--neg)' }}>
            Error: {reconResult.error}
          </div>
        )}

        {!reconResult && !reconstructing && (
          <div style={{ textAlign: 'center', padding: '32px 0', color: 'var(--text-3)', fontSize: 12 }}>
            <Database size={28} style={{ display: 'block', margin: '0 auto 10px', opacity: 0.25 }} />
            Complete Step 1 first, then reconstruct NAV history here.
            You can also run this step alone if you have already imported prices previously.
          </div>
        )}
      </div>
    </main>
  )
}
