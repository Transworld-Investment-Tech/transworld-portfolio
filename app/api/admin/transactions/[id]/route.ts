/**
 * app/api/admin/transactions/[id]/route.ts — v27v: Transaction CRUD
 *
 * PATCH and DELETE handlers for individual transaction rows. Mirrors the
 * shape of synthesize-recovery/route.ts (admin() factory, runtime/duration
 * exports, response envelope) so it slots cleanly into the existing pattern.
 *
 * PATCH body shape:
 *   {
 *     updates: Partial<Transaction>,    // fields to change
 *     reason?: string,                  // optional operator reason for audit log
 *   }
 *
 * Behavior:
 *   1. Load the original row.
 *   2. Compute auto-diff between original and updates (changed fields).
 *   3. Build an audit-note line: "[edit YYYY-MM-DD: field old → new | reason: ...]"
 *      and APPEND it to the row's existing notes (never overwrite).
 *   4. Coerce empty-string fields to null per Supabase NOT NULL semantics.
 *   5. Write the UPDATE.
 *   6. Fire rebuildPortfolioHoldings (sync, awaited — fast).
 *   7. Fire reconstructPortfolioNav (async, fire-and-forget — slow,
 *      runs in background; client polls separately or just trusts it).
 *
 * DELETE behavior:
 *   1. Load the row (need portfolio_id for trigger chain + audit log).
 *   2. DELETE the row.
 *   3. Same trigger chain as PATCH.
 *
 * Audit-trail format (auto-diff):
 *   [edit 2026-04-28 by <user_id_short>: action TRANSFER_OUT → FEE,
 *    notes "Being professional charge" → "..." | reason: reclass]
 *
 * Sign convention (per v27p):
 *   amount is POSITIVE for both TRANSFER_IN and TRANSFER_OUT.
 *   The route auto-coerces negative amounts to abs() on save with a note.
 */

import { NextRequest, NextResponse } from 'next/server'
import { createClient, SupabaseClient } from '@supabase/supabase-js'
import { rebuildPortfolioHoldings } from '@/lib/holdings-rebuild'
import { reconstructPortfolioNav } from '@/lib/nav-reconstruct'

export const runtime = 'nodejs'
export const maxDuration = 60
export const dynamic = 'force-dynamic'

function admin(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    throw new Error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY env vars')
  }
  return createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}

// Fields the operator is allowed to edit. Anything outside this allowlist is
// silently dropped. Schema-level fields (id, portfolio_id, created_at, created_by)
// are NEVER editable here.
const EDITABLE_FIELDS = new Set([
  'trade_date', 'action', 'instrument_id', 'quantity', 'price',
  'gross_value', 'amount', 'fees',
  'fee_commission', 'fee_vat', 'fee_exchange', 'fee_clearing',
  'fee_sec', 'fee_contract_stamp', 'fee_sms',
  'fee_management', 'fee_demat', 'fee_other',
  'cn_number', 'settlement_date', 'external_ref',
  'broker', 'counterparty', 'notes',
  'income_category', 'maturity_date',
])

// Compute the auto-diff line. Returns null if no fields changed.
function buildAuditLine(
  original: any,
  updates: Record<string, any>,
  reason: string | null,
  userIdShort: string | null,
): string | null {
  const changes: string[] = []
  for (const key of Object.keys(updates)) {
    if (!EDITABLE_FIELDS.has(key)) continue
    const before = original[key]
    const after = updates[key]
    // Treat null/undefined/empty-string as equivalent for diff purposes.
    const beforeNorm = before === undefined || before === '' ? null : before
    const afterNorm = after === undefined || after === '' ? null : after
    if (beforeNorm === afterNorm) continue
    if (Number.isFinite(beforeNorm) && Number.isFinite(afterNorm) && Number(beforeNorm) === Number(afterNorm)) continue
    // Format for the note line.
    const fmtVal = (v: any): string => {
      if (v === null || v === undefined) return '∅'
      if (typeof v === 'string') {
        // Truncate long strings (notes can be huge).
        if (v.length > 60) return `"${v.slice(0, 57)}…"`
        return `"${v}"`
      }
      return String(v)
    }
    changes.push(`${key} ${fmtVal(beforeNorm)} → ${fmtVal(afterNorm)}`)
  }
  if (changes.length === 0) return null
  const today = new Date().toISOString().slice(0, 10)
  const userTag = userIdShort ? ` by ${userIdShort}` : ''
  const reasonTag = reason && reason.trim() ? ` | reason: ${reason.trim()}` : ''
  return `[edit ${today}${userTag}: ${changes.join(', ')}${reasonTag}]`
}

// Build a delete audit line.
function buildDeleteAuditLine(
  reason: string | null,
  userIdShort: string | null,
): string {
  const today = new Date().toISOString().slice(0, 10)
  const userTag = userIdShort ? ` by ${userIdShort}` : ''
  const reasonTag = reason && reason.trim() ? ` | reason: ${reason.trim()}` : ''
  return `[deleted ${today}${userTag}${reasonTag}]`
}

// Sanitize an updates payload: drop non-editable keys, coerce '' → null
// for nullable fields, coerce numeric strings to numbers.
function sanitizeUpdates(raw: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = {}
  const numericFields = new Set([
    'quantity', 'price', 'gross_value', 'amount', 'fees',
    'fee_commission', 'fee_vat', 'fee_exchange', 'fee_clearing',
    'fee_sec', 'fee_contract_stamp', 'fee_sms',
    'fee_management', 'fee_demat', 'fee_other',
  ])
  for (const [key, val] of Object.entries(raw)) {
    if (!EDITABLE_FIELDS.has(key)) continue
    if (val === '' || val === undefined) {
      out[key] = null
    } else if (numericFields.has(key)) {
      const n = Number(val)
      out[key] = Number.isFinite(n) ? n : null
    } else {
      out[key] = val
    }
  }
  // Sign convention (v27p): amount is POSITIVE for all action types.
  if (typeof out.amount === 'number' && out.amount < 0) {
    out.amount = Math.abs(out.amount)
  }
  return out
}

// Fire post-edit trigger chain. Holdings rebuild is awaited (fast).
// NAV reconstruct is fire-and-forget (slow) — caller doesn't wait.
async function firePostEditChain(
  db: SupabaseClient,
  portfolio_id: string,
): Promise<{ holdingsRebuild: any; navReconstructStarted: boolean }> {
  // 1. Holdings rebuild (sync, awaited).
  let holdingsRebuild: any
  try {
    const r = await rebuildPortfolioHoldings(db, portfolio_id)
    holdingsRebuild = {
      upserted:              r.upserted,
      deleted:               r.deleted,
      skipped_no_instrument: r.skipped_no_instrument,
      errors:                r.errors,
    }
  } catch (e: any) {
    holdingsRebuild = { error: e.message || 'unknown' }
  }

  // 2. NAV reconstruct (async, fire-and-forget).
  // We deliberately do NOT await — it can take 10-30s on a large portfolio
  // and we want the modal to close fast.
  let navReconstructStarted = false
  try {
    void reconstructPortfolioNav(db, portfolio_id).catch((e) => {
      console.error(`[v27v] NAV reconstruct failed for ${portfolio_id}:`, e?.message)
    })
    navReconstructStarted = true
  } catch (e: any) {
    console.error(`[v27v] NAV reconstruct kickoff failed for ${portfolio_id}:`, e?.message)
  }

  return { holdingsRebuild, navReconstructStarted }
}

// ─── PATCH ─────────────────────────────────────────────────────
export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const started = Date.now()
  try {
    const { id: txnId } = await ctx.params
    if (!txnId) {
      return NextResponse.json({ error: 'transaction id required' }, { status: 400 })
    }

    let body: { updates?: Record<string, any>; reason?: string; user_id?: string }
    try {
      body = await req.json()
    } catch (e: any) {
      return NextResponse.json(
        { error: `Invalid JSON body: ${e.message}` },
        { status: 400 }
      )
    }

    const rawUpdates = body.updates ?? {}
    const reason = body.reason ?? null
    const userIdShort = body.user_id ? String(body.user_id).slice(0, 8) : null

    if (!rawUpdates || typeof rawUpdates !== 'object' || Array.isArray(rawUpdates)) {
      return NextResponse.json(
        { error: 'updates (object) required in body' },
        { status: 400 }
      )
    }

    const db = admin()

    // 1. Load original row.
    const { data: original, error: loadErr } = await db
      .from('transactions')
      .select('*')
      .eq('id', txnId)
      .single()

    if (loadErr || !original) {
      return NextResponse.json(
        { error: `transaction not found: ${loadErr?.message ?? 'no row'}` },
        { status: 404 }
      )
    }

    const portfolio_id = original.portfolio_id

    // 2. Sanitize updates.
    const cleanUpdates = sanitizeUpdates(rawUpdates)

    // 3. Build audit line BEFORE applying — we need original values.
    const auditLine = buildAuditLine(original, cleanUpdates, reason, userIdShort)

    if (!auditLine && Object.keys(cleanUpdates).length === 0) {
      return NextResponse.json(
        { ok: false, error: 'no editable fields changed', elapsed_ms: Date.now() - started },
        { status: 400 }
      )
    }

    // 4. Append audit line to notes (never overwrite).
    if (auditLine) {
      const existingNotes = (cleanUpdates.notes !== undefined ? cleanUpdates.notes : original.notes) ?? ''
      const sep = existingNotes && !existingNotes.endsWith(' ') ? ' ' : ''
      cleanUpdates.notes = `${existingNotes}${sep}${auditLine}`.trim()
    }

    // 5. Apply UPDATE.
    const { data: updated, error: updateErr } = await db
      .from('transactions')
      .update(cleanUpdates)
      .eq('id', txnId)
      .select()
      .single()

    if (updateErr) {
      return NextResponse.json(
        { error: `update failed: ${updateErr.message}` },
        { status: 500 }
      )
    }

    // 6. Fire post-edit trigger chain.
    const { holdingsRebuild, navReconstructStarted } = await firePostEditChain(db, portfolio_id)

    return NextResponse.json({
      ok: true,
      transaction:           updated,
      audit_line:            auditLine,
      holdings_rebuild:      holdingsRebuild,
      nav_reconstruct_started: navReconstructStarted,
      elapsed_ms:            Date.now() - started,
    })
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'unknown error' },
      { status: 500 }
    )
  }
}

// ─── DELETE ────────────────────────────────────────────────────
export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const started = Date.now()
  try {
    const { id: txnId } = await ctx.params
    if (!txnId) {
      return NextResponse.json({ error: 'transaction id required' }, { status: 400 })
    }

    // Body optional on DELETE — pull reason if provided.
    let body: { reason?: string; user_id?: string } = {}
    try {
      const text = await req.text()
      if (text) body = JSON.parse(text)
    } catch {
      // Empty or invalid body — fine, just skip.
    }
    const reason = body.reason ?? null
    const userIdShort = body.user_id ? String(body.user_id).slice(0, 8) : null

    const db = admin()

    // 1. Load row (need portfolio_id for trigger chain).
    const { data: original, error: loadErr } = await db
      .from('transactions')
      .select('id, portfolio_id, trade_date, action, instrument_id, amount, notes')
      .eq('id', txnId)
      .single()

    if (loadErr || !original) {
      return NextResponse.json(
        { error: `transaction not found: ${loadErr?.message ?? 'no row'}` },
        { status: 404 }
      )
    }

    const portfolio_id = original.portfolio_id
    const auditLine = buildDeleteAuditLine(reason, userIdShort)

    // 2. Hard DELETE the row.
    const { error: deleteErr } = await db
      .from('transactions')
      .delete()
      .eq('id', txnId)

    if (deleteErr) {
      return NextResponse.json(
        { error: `delete failed: ${deleteErr.message}` },
        { status: 500 }
      )
    }

    // 3. Trigger chain.
    const { holdingsRebuild, navReconstructStarted } = await firePostEditChain(db, portfolio_id)

    return NextResponse.json({
      ok: true,
      deleted_transaction: {
        id:            original.id,
        trade_date:    original.trade_date,
        action:        original.action,
        instrument_id: original.instrument_id,
        amount:        original.amount,
      },
      audit_line:              auditLine,
      holdings_rebuild:        holdingsRebuild,
      nav_reconstruct_started: navReconstructStarted,
      elapsed_ms:              Date.now() - started,
    })
  } catch (err: any) {
    return NextResponse.json(
      { error: err.message || 'unknown error' },
      { status: 500 }
    )
  }
}
