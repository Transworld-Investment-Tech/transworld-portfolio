/**
 * app/admin/broker/new/page.tsx — v21c
 *
 * Upload form for broker PDFs. The missing UX piece: until v21c, the
 * /api/broker/upload endpoint could only be hit via curl. This page
 * gives users a real form that POSTs multipart/form-data and redirects
 * to the session detail page on success.
 *
 * Scope (deliberately minimal — Scope A in the v21c planning):
 *   - Pick an existing portfolio from a dropdown (excludes archived)
 *   - Attach 1 contract notes PDF (required)
 *   - Attach 0..N statement PDFs (optional but monthly flow uses 1-N)
 *   - Optional uploaded_by (defaults to "okezie")
 *   - During upload: spinner + clear "this takes up to 5 minutes" copy
 *   - On success: redirect to /admin/broker/[session_id]
 *   - On error: inline alert with server message, form re-enables
 *
 * Does NOT do:
 *   - New-client onboarding (use /admin/clients/new + /admin/portfolios/new first)
 *   - Dry-run preview (server parses during upload — preview is on detail page)
 *   - Progress streaming (spinner only; real progress needs SSE, v21c-2 candidate)
 *   - Retry UI for parse_failed files (delete session, re-upload)
 *
 * Inherits Sidebar from app/admin/layout.tsx — this page does NOT
 * render its own (pitfall #38).
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
  const [uploadedBy, setUploadedBy] = useState<string>('okezie')

  const [submitting, setSubmitting] = useState<boolean>(false)
  const [elapsedSec, setElapsedSec] = useState<number>(0)
  const [serverError, setServerError] = useState<string | null>(null)
  const [serverWarnings, setServerWarnings] = useState<string[]>([])

  const cnInputRef = useRef<HTMLInputElement>(null)
  const stmtInputRef = useRef<HTMLInputElement>(null)

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

  function clearContractNotes() {
    setContractNotesFile(null)
    if (cnInputRef.current) cnInputRef.current.value = ''
  }

  function clearStatements() {
    setStatementFiles([])
    if (stmtInputRef.current) stmtInputRef.current.value = ''
  }

  const canSubmit =
    !submitting &&
    portfolioId !== '' &&
    contractNotesFile !== null

  async function handleSubmit() {
    if (!canSubmit) return

    setServerError(null)
    setServerWarnings([])
    setSubmitting(true)

    try {
      const fd = new FormData()
      fd.append('portfolio_id', portfolioId)
      fd.append('contract_notes', contractNotesFile as File)
      for (const f of statementFiles) {
        fd.append('statements', f)
      }
      if (uploadedBy.trim()) {
        fd.append('uploaded_by', uploadedBy.trim())
      }

      // NOTE: do NOT set Content-Type header — the browser sets its own
      // multipart boundary automatically when you pass a FormData body.
      // Setting Content-Type manually breaks the upload.
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

      // Non-fatal errors are surfaced even on success
      if (Array.isArray(data.errors) && data.errors.length > 0) {
        setServerWarnings(data.errors)
      }

      if (!sessionId) {
        // Shouldn't happen after the v21c route patch, but guard anyway
        setSubmitting(false)
        setServerError(
          'Upload completed but no session_id was returned. Check /admin/broker.'
        )
        return
      }

      // Redirect to the detail page where the existing UX takes over
      router.push(`/admin/broker/${sessionId}`)
    } catch (err: any) {
      setSubmitting(false)
      setServerError(err?.message || 'Network error during upload')
    }
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

      {serverWarnings.length > 0 && (
        <div className="alert-h alert-h-warn" style={{ marginBottom: 16 }}>
          <strong>Upload completed with warnings:</strong>
          <ul style={{ margin: '6px 0 0 18px', padding: 0 }}>
            {serverWarnings.map((w, i) => (
              <li key={i} style={{ fontSize: 12, marginTop: 2 }}>
                {w}
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="panel">
        <div className="panel-header">
          <div className="panel-title">New upload session</div>
          <div className="panel-meta">
            {submitting
              ? `Uploading and parsing… ${elapsedSec}s`
              : 'Pick a portfolio, attach PDFs, upload'}
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
            className="select-h"
            style={{ width: '100%', maxWidth: 520 }}
            value={portfolioId}
            onChange={(e) => setPortfolioId(e.target.value)}
            disabled={submitting || portfolios === null}
          >
            <option value="">
              {portfolios === null
                ? 'Loading portfolios…'
                : portfolios.length === 0
                ? 'No active portfolios found'
                : 'Select a portfolio…'}
            </option>
            {portfolios?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.client_name} · {p.name}
                {p.client_code ? ` (${p.client_code})` : ''}
              </option>
            ))}
          </select>
          {portfolios !== null && portfolios.length === 0 && !portfoliosError && (
            <div style={{ fontSize: 12, color: 'var(--text-3)', marginTop: 8 }}>
              No active portfolios yet.{' '}
              <Link
                href="/admin/clients/new"
                style={{ color: 'var(--gold)', textDecoration: 'underline' }}
              >
                Create a client
              </Link>{' '}
              first, then{' '}
              <Link
                href="/admin/portfolios/new"
                style={{ color: 'var(--gold)', textDecoration: 'underline' }}
              >
                open a portfolio
              </Link>
              .
            </div>
          )}
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
              accept="application/pdf,.pdf"
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
              accept="application/pdf,.pdf"
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
                Clear all
              </button>
            )}
          </div>
          {statementFiles.length > 0 && (
            <ul
              style={{
                margin: '8px 0 0 0',
                padding: 0,
                listStyle: 'none',
                fontSize: 12,
                color: 'var(--text-2)',
              }}
            >
              {statementFiles.map((f, i) => (
                <li key={i} style={{ marginTop: 2 }}>
                  <strong>{f.name}</strong>
                  <span style={{ color: 'var(--text-3)', marginLeft: 8 }}>
                    {(f.size / 1024).toFixed(0)} KB
                  </span>
                </li>
              ))}
            </ul>
          )}
          <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 6 }}>
            Optional. Each PDF is one monthly statement. Hold Shift/Ctrl to
            select multiple.
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

          {submitting && (
            <div style={{ fontSize: 12, color: 'var(--text-2)' }}>
              Parsing broker PDFs can take 1–5 minutes. Don’t close this tab.
            </div>
          )}

          {!submitting && !canSubmit && (
            <div style={{ fontSize: 12, color: 'var(--warn)' }}>
              {portfolioId === '' && 'Select a portfolio. '}
              {!contractNotesFile && 'Attach a contract notes PDF.'}
            </div>
          )}
        </div>
      </div>

      {/* Helper card */}
      <div
        className="panel"
        style={{ marginTop: 16, background: 'var(--bg-soft)' }}
      >
        <div className="panel-header">
          <div className="panel-title">What happens next</div>
        </div>
        <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1.7 }}>
          <li>
            Each PDF is uploaded to private storage and parsed in place — no
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
            If anything is off, rollback unwinds the whole commit. Staged rows
            stay intact so you can re-commit after fixing the issue.
          </li>
        </ol>
      </div>
    </div>
  )
}
