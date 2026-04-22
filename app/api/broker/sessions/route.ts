/**
 * app/api/broker/sessions/route.ts — v21b-3a
 *
 * GET /api/broker/sessions
 *   Returns recent broker upload sessions (grouped by upload_session_id)
 *   with summary counts, suitable for listing in the inbox UI.
 *
 *   Query params:
 *     portfolio_id  (optional)  — filter to one portfolio
 *     limit         (optional)  — cap number of sessions returned (default 50)
 *
 * Response shape (success):
 *   {
 *     sessions: [
 *       {
 *         session_id: string,
 *         portfolio: { id, name, label, client: { code, name } } | null,
 *         upload_time: string (ISO, earliest created_at in the session),
 *         uploaded_by: string | null,
 *         file_count: number,
 *         kinds: { contract_notes: number, statement: number },
 *         parse_status: 'all_parsed' | 'mixed' | 'any_failed',
 *         all_balanced: boolean,  // true if every statement row audits clean
 *         staged_total: number,
 *         has_failed_audit: boolean,
 *       },
 *       ...
 *     ]
 *   }
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient, SupabaseClient } from '@supabase/supabase-js'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

function admin(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error(
      'Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars'
    )
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

export async function GET(req: NextRequest) {
  try {
    const db = admin()
    const url = new URL(req.url)
    const portfolioId = url.searchParams.get('portfolio_id')
    const limitParam = url.searchParams.get('limit')
    const limit = limitParam ? Math.min(parseInt(limitParam, 10) || 50, 200) : 50

    // Fetch recent broker_files with session_id, joined to portfolios + clients.
    // We fetch more files than we need (limit*10) because each session may
    // contain multiple files and we group client-side.
    let query = db
      .from('broker_files')
      .select(
        `id, upload_session_id, portfolio_id, file_kind,
         original_filename, parse_status, audit_passes,
         uploaded_by, created_at,
         portfolios (
           id, name, label,
           clients ( code, name )
         )`
      )
      .not('upload_session_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(limit * 10)

    if (portfolioId) {
      query = query.eq('portfolio_id', portfolioId)
    }

    const { data: files, error: filesErr } = await query
    if (filesErr) {
      return NextResponse.json(
        { error: `broker_files query: ${filesErr.message}` },
        { status: 500 }
      )
    }

    const fileList = (files || []) as any[]
    if (fileList.length === 0) {
      return NextResponse.json({ sessions: [] })
    }

    // Fetch staged_transactions counts keyed by source_file_id, in a single call.
    const allFileIds = fileList.map((f) => f.id)
    const { data: staged, error: stagedErr } = await db
      .from('staged_transactions')
      .select('source_file_id')
      .in('source_file_id', allFileIds)
    if (stagedErr) {
      return NextResponse.json(
        { error: `staged_transactions query: ${stagedErr.message}` },
        { status: 500 }
      )
    }

    const stagedCountByFile = new Map<string, number>()
    for (const s of staged || []) {
      const fid = (s as any).source_file_id as string | null
      if (!fid) continue
      stagedCountByFile.set(fid, (stagedCountByFile.get(fid) || 0) + 1)
    }

    // Group by upload_session_id.
    type Session = {
      session_id: string
      portfolio: any
      upload_time: string
      uploaded_by: string | null
      files: Array<{
        id: string
        kind: string
        filename: string
        parse_status: string
        audit_passes: boolean | null
      }>
      kinds: { contract_notes: number; statement: number }
      parse_statuses: Set<string>
      all_balanced: boolean
      has_audit_data: boolean
      has_failed_audit: boolean
      staged_total: number
    }

    const sessions = new Map<string, Session>()

    for (const f of fileList) {
      const sid = f.upload_session_id as string
      if (!sid) continue
      if (!sessions.has(sid)) {
        sessions.set(sid, {
          session_id: sid,
          portfolio: f.portfolios
            ? {
                id: (f.portfolios as any).id,
                name: (f.portfolios as any).name,
                label: (f.portfolios as any).label,
                client: (f.portfolios as any).clients || null,
              }
            : null,
          upload_time: f.created_at,
          uploaded_by: f.uploaded_by,
          files: [],
          kinds: { contract_notes: 0, statement: 0 },
          parse_statuses: new Set(),
          all_balanced: true,
          has_audit_data: false,
          has_failed_audit: false,
          staged_total: 0,
        })
      }
      const s = sessions.get(sid)!

      s.files.push({
        id: f.id,
        kind: f.file_kind,
        filename: f.original_filename,
        parse_status: f.parse_status,
        audit_passes: f.audit_passes,
      })

      if (f.file_kind === 'contract_notes') s.kinds.contract_notes += 1
      if (f.file_kind === 'statement') s.kinds.statement += 1

      s.parse_statuses.add(f.parse_status)

      if (f.file_kind === 'statement' && f.audit_passes !== null) {
        s.has_audit_data = true
        if (f.audit_passes === false) {
          s.has_failed_audit = true
          s.all_balanced = false
        }
      }

      // upload_time is the EARLIEST created_at in the session
      if (new Date(f.created_at) < new Date(s.upload_time)) {
        s.upload_time = f.created_at
      }

      s.staged_total += stagedCountByFile.get(f.id) || 0
    }

    // Sort sessions by upload_time desc, apply limit.
    const output = Array.from(sessions.values())
      .sort(
        (a, b) => new Date(b.upload_time).getTime() - new Date(a.upload_time).getTime()
      )
      .slice(0, limit)
      .map((s) => ({
        session_id: s.session_id,
        portfolio: s.portfolio,
        upload_time: s.upload_time,
        uploaded_by: s.uploaded_by,
        file_count: s.files.length,
        kinds: s.kinds,
        parse_status:
          s.parse_statuses.size === 1 && s.parse_statuses.has('parsed')
            ? 'all_parsed'
            : s.parse_statuses.has('parse_failed')
              ? 'any_failed'
              : 'mixed',
        all_balanced: s.has_audit_data ? s.all_balanced : true,
        staged_total: s.staged_total,
        has_failed_audit: s.has_failed_audit,
      }))

    return NextResponse.json({ sessions: output })
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'unknown error' },
      { status: 500 }
    )
  }
}
