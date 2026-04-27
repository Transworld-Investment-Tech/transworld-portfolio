/**
 * app/admin/broker/new/page.tsx — v27q-fix1
 *
 * v27q rolled back at apply-time due to an over-broad negative sanity
 * grep that false-matched on legitimate JSDoc comment references to the
 * old "serverWarnings" name. Payload is identical; v27q-fix1 ships the
 * tightened grep patterns in apply-update.sh so the apply succeeds.
 *
 * v27q intent (preserved): Pitfall #106 Part B — surface upload-stage
 * errors[] prominently instead of silently redirecting on partial-success.
 *
 * Background: the upload route returns 200 + errors[] for partial-success
 * states (e.g. one statement timing out while CN + others succeed). The
 * v27g implementation redirected to the session detail page on any 200,
 * pushing errors[] into a non-prominent serverWarnings banner that the
 * operator could miss. When the v27p Storage bucket misconfiguration
 * silently rejected the canonical CSV upload, the operator had no way
 * to see that the file hadn't landed.
 *
 * v27q change: if the response contains a non-empty errors[] array, do
 * NOT redirect. Show a sticky red error block at the top of the page
 * with a bold heading and an explicit "Continue to session anyway"
 * button. Operator chooses whether to proceed (statement timeout — they
 * can refresh later) or retry (canonical missing — they need to redo).
 *
 * Everything else preserved from v27g: portfolio dropdown, CN required,
 * statements optional 0..N, canonical positions optional 0..1,
 * uploaded_by free text, spinner during parse.
 */

'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

type PortfolioOption = {
  id: string
  name: string
  label: string
  client_name: string
  client_code: string
}

export default function BrokerUploadPage() {
  const router = useRouter()

  const [portfolios, setPortfolios] = useState<PortfolioOption[] | null>(null)
  const [portfoliosError, setPortfoliosError] = useState<string | null>(null)

  const [portfolioId, setPortfolioId] = useState<string>('')
  const [contractNotesFile, setContractNotesFile] = useState<File | null>(null)
  const [statementFiles, setStatementFiles] = useState<File[]>([])
  const [canonicalFile, setCanonicalFile] = useState<File | null>(null)
  const [uploadedBy, setUploadedBy] = useState<string>('okezie')

  const [submitting, setSubmitting] = useState<boolean>(false)
  const [elapsedSec, setElapsedSec] = useState<number>(0)
  const [serverError, setServerError] = useState<string | null>(null)

  // v27q-fix1: replaces the prior serverWarnings approach.
  // When the response has a non-empty errors[] array we BLOCK redirect,
  // show this prominently, and require operator decision.
  const [uploadErrors, setUploadErrors] = useState<string[]>([])
  const [pendingSessionId, setPendingSessionId] = useState<string | null>(null)

  const cnInputRef        = useRef<HTMLInputElement>(null)
  const stmtInputRef      = useRef<HTMLInputElement>(null)
  const canonicalInputRef = useRef<HTMLInputElement>(null)

  // ─── Load active portfolios ──────────────────────────────────
  useEffect(() => {
    let cancelled = false
    async function load() {
      try {
        const { data, error } = await supabase
          .from('portfolios')
          .select(
            'id, name, label, status, client:clients(code, name, status)'
          )
          .eq('status', 'active')
          .order('created_at', { ascending: false })

        if (cancelled) return
        if (error) {
          setPortfoliosError(error.message)
          setPortfolios([])
          return
        }

        const opts: PortfolioOption[] = (data || [])
          .filter((p: any) => p.client && p.client.status !== 'archived')
          .map((p: any) => ({
            id: p.id,
            name: p.name,
            label: p.label,
            client_name: p.client?.name || '—',
            client_code: p.client?.code || '',
          }))
          .sort((a, b) => a.client_name.localeCompare(b.client_name))

        setPortfolios(opts)
      } catch (err: any) {
        if (cancelled) return
        setPortfoliosError(err.message || 'Failed to load portfolios')
        setPortfolios([])
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [])

  // ─── Elapsed-time ticker while submitting ────────────────────
  useEffect(() => {
    if (!submitting) {
      setElapsedSec(0)
      return
    }
    const t0 = Date.now()
    const interval = setInterval(() => {
      setElapsedSec(Math.floor((Date.now() - t0) / 1000))
    }, 1000)
    return () => clearInterval(interval)
  }, [submitting])

  // ─── Form handlers ───────────────────────────────────────────
  function onContractNotesChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] || null
    setContractNotesFile(f)
  }

  function onStatementsChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files ? Array.from(e.target.files) : []
    setStatementFiles(files)
  }

  function onCanonicalChange(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0] || null
    setCanonicalFile(f)
  }

  function clearContractNotes() {
    setContractNotesFile(null)
    if (cnInputRef.current) cnInputRef.current.value = ''
  }

  function clearStatements() {
    setStatementFiles([])
    if (stmtInputRef.current) stmtInputRef.current.value = ''
  }

  function clearCanonical() {
    setCanonicalFile(null)
    if (canonicalInputRef.current) canonicalInputRef.current.value = ''
  }

  const canSubmit =
    !submitting &&
    portfolioId !== '' &&
    contractNotesFile !== null

  async function handleSubmit() {
    if (!canSubmit) return

    setServerError(null)
    setUploadErrors([])
    setPendingSessionId(null)
    setSubmitting(true)

    try {
      const fd = new FormData()
      fd.append('portfolio_id', portfolioId)
      fd.append('contract_notes', contractNotesFile as File)
      for (const f of statementFiles) {
        fd.append('statements', f)
      }
      if (canonicalFile) {
        fd.append('canonical_positions', canonicalFile)
      }
      if (uploadedBy.trim()) {
        fd.append('uploaded_by', uploadedBy.trim())
      }

      const res = await fetch('/api/broker/upload', {
        method: 'POST',
        body: fd,
      })

      let data: any = null
      try {
        data = await res.json()
      } catch {
        // fall through — data stays null
      }

      if (!res.ok || !data) {
        setSubmitting(false)
        setServerError(
          data?.error ||
            data?.errors?.join('; ') ||
            `Upload failed: HTTP ${res.status}`
        )
        return
      }

      const sessionId = data.upload_session_id as string | undefined
      const errs      = Array.isArray(data.errors) ? (data.errors as string[]) : []

      if (!sessionId) {
        setSubmitting(false)
        setServerError(
          'Upload completed but no session_id was returned. Check /admin/broker.'
        )
        return
      }

      // v27q: any non-empty errors[] blocks the redirect.
      // Operator sees the errors prominently and chooses whether to proceed.
      if (errs.length > 0) {
        setSubmitting(false)
        setUploadErrors(errs)
        setPendingSessionId(sessionId)
        return
      }

      // Clean success — redirect.
      router.push(`/admin/broker/${sessionId}`)
    } catch (err: any) {
      setSubmitting(false)
      setServerError(err?.message || 'Network error during upload')
    }
  }

  function continueToSessionAnyway() {
    if (pendingSessionId) {
      router.push(`/admin/broker/${pendingSessionId}`)
    }
  }

  function dismissErrorsAndStartOver() {
    setUploadErrors([])
    setPendingSessionId(null)
    setServerError(null)
  }

  // ─── Render ──────────────────────────────────────────────────
  return (
    <div className="hybrid-page">
      <div className="page-head">
        <div>
          <div className="eyebrow">Admin</div>
          <h1 className="hybrid-serif">Upload broker files</h1>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <Link href="/admin/broker" className="btn-h">
            Back to sessions
          </Link>
        </div>
      </div>

      {portfoliosError && (
        <div className="alert-h alert-h-critical" style={{ marginBottom: 16 }}>
          <strong>Couldn’t load portfolios.</strong> {portfoliosError}
        </div>
      )}

      {serverError && (
        <div className="alert-h alert-h-critical" style={{ marginBottom: 16 }}>
          <strong>Upload failed.</strong> {serverError}
        </div>
      )}

      {/* v27q: prominent partial-success banner. Operator must read + decide. */}
      {uploadErrors.length > 0 && (
        <div
          className="alert-h alert-h-critical"
          style={{
            marginBottom: 16,
            padding: '16px 20px',
            border: '2px solid var(--neg, #c0392b)',
            background: 'rgba(192, 57, 43, 0.08)',
            borderRadius: 4,
          }}
        >
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 8 }}>
            Upload completed with errors — review before continuing
          </div>
          <div style={{ fontSize: 12, marginBottom: 10, color: 'var(--text-2)' }}>
            The session was created, but one or more files failed to upload or
            parse. The errors are below. Common causes: a CSV file rejected by
            Storage policy (canonical positions), a Vercel function timeout
            (large statement PDF), or a parser failure on a malformed file.
          </div>
          <ul
            style={{
              margin: '0 0 12px 18px',
              padding: 0,
              fontSize: 12,
              lineHeight: 1.5,
            }}
          >
            {uploadErrors.map((w, i) => (
              <li key={i} style={{ marginBottom: 4 }}>
                <code
                  style={{
                    background: 'rgba(0,0,0,0.05)',
                    padding: '1px 6px',
                    borderRadius: 2,
                    fontFamily: 'monospace',
                    fontSize: 11,
                  }}
                >
                  {w}
                </code>
              </li>
            ))}
          </ul>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="btn-h btn-h-primary"
              onClick={continueToSessionAnyway}
              style={{ fontSize: 12 }}
            >
              Continue to session anyway
            </button>
            <button
              type="button"
              className="btn-h"
              onClick={dismissErrorsAndStartOver}
              style={{ fontSize: 12 }}
            >
              Dismiss and re-upload
            </button>
          </div>
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 10 }}>
            Tip: if you see “mime type … is not supported”, the Storage bucket
            policy is rejecting that file format. Check{' '}
            <code>storage.buckets.allowed_mime_types</code> for{' '}
            <code>broker-files</code>. If you see “Gateway Timeout”, retry that
            specific file in a new session.
          </div>
        </div>
      )}

      <div className="panel">
        <div className="panel-header">
          <div className="panel-title">New upload session</div>
          <div className="panel-meta">
            Pick a portfolio, attach PDFs, upload
          </div>
        </div>

        {/* Portfolio picker */}
        <div style={{ marginBottom: 20 }}>
          <label
            style={{
              display: 'block',
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--text-3)',
              marginBottom: 8,
            }}
          >
            Portfolio
          </label>
          <select
            className="input-h"
            value={portfolioId}
            onChange={(e) => setPortfolioId(e.target.value)}
            disabled={submitting || portfolios === null}
            style={{ minWidth: 320 }}
          >
            <option value="">— Select a portfolio —</option>
            {(portfolios || []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.client_name} · {p.name} ({p.client_code})
              </option>
            ))}
          </select>
        </div>

        {/* Contract notes */}
        <div style={{ marginBottom: 20 }}>
          <label
            style={{
              display: 'block',
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--text-3)',
              marginBottom: 8,
            }}
          >
            Contract notes <span style={{ color: 'var(--neg)' }}>*</span>
          </label>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              flexWrap: 'wrap',
            }}
          >
            <input
              ref={cnInputRef}
              type="file"
              accept=".pdf,application/pdf"
              onChange={onContractNotesChange}
              disabled={submitting}
              style={{ fontSize: 12 }}
            />
            {contractNotesFile && (
              <button
                type="button"
                className="btn-h"
                onClick={clearContractNotes}
                disabled={submitting}
                style={{ fontSize: 11, padding: '4px 10px' }}
              >
                Clear
              </button>
            )}
          </div>
          {contractNotesFile && (
            <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 6 }}>
              <strong>{contractNotesFile.name}</strong>
              <span style={{ color: 'var(--text-3)', marginLeft: 8 }}>
                {(contractNotesFile.size / 1024).toFixed(0)} KB
              </span>
            </div>
          )}
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>
            Required. One PDF containing all contract notes for the period.
          </div>
        </div>

        {/* Statements */}
        <div style={{ marginBottom: 20 }}>
          <label
            style={{
              display: 'block',
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--text-3)',
              marginBottom: 8,
            }}
          >
            Account statements
          </label>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              flexWrap: 'wrap',
            }}
          >
            <input
              ref={stmtInputRef}
              type="file"
              accept=".pdf,application/pdf"
              multiple
              onChange={onStatementsChange}
              disabled={submitting}
              style={{ fontSize: 12 }}
            />
            {statementFiles.length > 0 && (
              <button
                type="button"
                className="btn-h"
                onClick={clearStatements}
                disabled={submitting}
                style={{ fontSize: 11, padding: '4px 10px' }}
              >
                Clear
              </button>
            )}
          </div>
          {statementFiles.length > 0 && (
            <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 6 }}>
              <strong>{statementFiles.length} file(s) selected</strong>
            </div>
          )}
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>
            Optional. Each PDF is one monthly statement. Hold Shift/Ctrl to
            select multiple.
          </div>
        </div>

        {/* Canonical positions — v27g picker, v27q error-aware response handling */}
        <div style={{ marginBottom: 20 }}>
          <label
            style={{
              display: 'block',
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--text-3)',
              marginBottom: 8,
            }}
          >
            Canonical positions
            <span style={{ marginLeft: 8, fontSize: 9, fontWeight: 400, color: 'var(--gold)', letterSpacing: '0.1em' }}>
              CSCS extract — optional
            </span>
          </label>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              flexWrap: 'wrap',
            }}
          >
            <input
              ref={canonicalInputRef}
              type="file"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={onCanonicalChange}
              disabled={submitting}
              style={{ fontSize: 12 }}
            />
            {canonicalFile && (
              <button
                type="button"
                className="btn-h"
                onClick={clearCanonical}
                disabled={submitting}
                style={{ fontSize: 11, padding: '4px 10px' }}
              >
                Clear
              </button>
            )}
          </div>
          {canonicalFile && (
            <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 6 }}>
              <strong>{canonicalFile.name}</strong>
              <span style={{ color: 'var(--text-3)', marginLeft: 8 }}>
                {(canonicalFile.size / 1024).toFixed(0)} KB
              </span>
            </div>
          )}
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>
            Optional. Single CSV or XLSX from the brokerage's CSCS Asset
            Position extract. After commit, the staging UI will surface a
            variance panel comparing canonical units to portfolio holdings —
            one click writes the reconciliation transfers.
          </div>
        </div>

        {/* Uploaded by */}
        <div style={{ marginBottom: 24 }}>
          <label
            style={{
              display: 'block',
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--text-3)',
              marginBottom: 8,
            }}
          >
            Uploaded by
          </label>
          <input
            type="text"
            className="input-h"
            style={{ maxWidth: 240 }}
            value={uploadedBy}
            onChange={(e) => setUploadedBy(e.target.value)}
            disabled={submitting}
            placeholder="Your name"
          />
        </div>

        {/* Submit */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            paddingTop: 14,
            borderTop: '1px solid var(--border-soft)',
          }}
        >
          <button
            type="button"
            className="btn-h btn-h-primary"
            onClick={handleSubmit}
            disabled={!canSubmit}
          >
            {submitting ? `Uploading… ${elapsedSec}s` : 'Upload & parse'}
          </button>
          {!canSubmit && !submitting && (
            <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
              {portfolioId === ''
                ? 'Pick a portfolio.'
                : 'Attach a contract notes PDF.'}
            </span>
          )}
        </div>
      </div>

      {/* What happens next */}
      <div className="panel" style={{ marginTop: 20 }}>
        <div className="panel-header">
          <div className="panel-title hybrid-serif">What happens next</div>
        </div>
        <ul style={{ paddingLeft: 18, margin: 0, fontSize: 12, lineHeight: 1.7 }}>
          <li>
            Each file is uploaded to private storage and parsed in place — no
            files touch your machine after this page.
          </li>
          <li>
            The reconciler matches contract-note trades to statement trades
            (handling N-to-1 partial fills) and classifies cash events.
          </li>
          <li>
            You land on the session detail page. Review every staged row,
            toggle any you want to exclude, then commit to the portfolio.
          </li>
          <li>
            On commit, holdings are rebuilt and NAV history is automatically
            reconstructed from transactions.
          </li>
          <li>
            If you attached a CSCS canonical positions file, a variance panel
            renders post-commit with per-row date pickers for held-orphan
            reconciliation transfers.
          </li>
        </ul>
      </div>
    </div>
  )
}
