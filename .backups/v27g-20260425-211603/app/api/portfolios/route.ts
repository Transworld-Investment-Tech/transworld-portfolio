import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'

export const dynamic = 'force-dynamic'
export const maxDuration = 30

// POST /api/portfolios — create a new portfolio + sleeve_targets + initial nav_log row
// Performs a best-effort rollback if sleeve_targets insertion fails.
//
// v19d: starting_nav can now be 0 (for portfolios built up via TRANSFER_IN
//       transactions rather than up-front capital deployment). Negatives are
//       still rejected. The initial nav_log row is still written; nav_value
//       will just be 0. The IRR Newton-Raphson solver handles this correctly —
//       the −0 cash flow at t=0 is a no-op and subsequent TRANSFER_IN events
//       become the real capital-in cash flows.
export async function POST(req: NextRequest) {
  try {
    const body = await req.json()
    const {
      client_id,
      label,
      name,
      currency,
      starting_nav,
      start_date,
      income_target,
      cap_target,
      liq_min,
      dd_alert,
      dd_action,
      max_eq_single,
      max_eq_sleeve,
      notes,
      sleeves,
    } = body

    // ─── Validation ──────────────────────────────────────────────────
    if (!client_id || typeof client_id !== 'string') {
      return NextResponse.json({ error: 'client_id is required' }, { status: 400 })
    }
    if (!label || typeof label !== 'string') {
      return NextResponse.json({ error: 'label is required' }, { status: 400 })
    }
    if (!name || typeof name !== 'string') {
      return NextResponse.json({ error: 'name is required' }, { status: 400 })
    }
    // v19d: allow 0. Reject undefined/null/NaN/negatives/non-numbers.
    if (
      starting_nav === undefined ||
      starting_nav === null ||
      typeof starting_nav !== 'number' ||
      isNaN(starting_nav) ||
      starting_nav < 0
    ) {
      return NextResponse.json(
        { error: 'starting_nav must be 0 or a positive number' },
        { status: 400 }
      )
    }
    if (!start_date || typeof start_date !== 'string') {
      return NextResponse.json({ error: 'start_date is required' }, { status: 400 })
    }
    if (!Array.isArray(sleeves) || sleeves.length !== 3) {
      return NextResponse.json({ error: 'sleeves must be an array of exactly 3 entries' }, { status: 400 })
    }
    const sleeveIds = new Set(sleeves.map((s: any) => s.sleeve_id))
    if (!sleeveIds.has('liq') || !sleeveIds.has('eq') || !sleeveIds.has('fi')) {
      return NextResponse.json({ error: 'sleeves must cover liq, eq, and fi' }, { status: 400 })
    }
    const targetSum = sleeves.reduce((acc: number, s: any) => acc + Number(s.target_pct || 0), 0)
    if (Math.abs(targetSum - 1) > 0.0005) {
      return NextResponse.json(
        { error: `Sleeve targets must sum to 1.0 (got ${targetSum.toFixed(4)})` },
        { status: 400 }
      )
    }

    const db = supabaseAdmin()

    // Verify client exists
    const { data: client } = await db
      .from('clients')
      .select('id, name')
      .eq('id', client_id)
      .maybeSingle()
    if (!client) {
      return NextResponse.json({ error: 'Client not found' }, { status: 404 })
    }

    // Label uniqueness within active portfolios for this client
    const { data: existingLabel } = await db
      .from('portfolios')
      .select('id')
      .eq('client_id', client_id)
      .eq('label', label)
      .eq('status', 'active')
      .maybeSingle()
    if (existingLabel) {
      return NextResponse.json(
        { error: `Label "${label}" is already used for this client — pick another letter` },
        { status: 409 }
      )
    }

    // ─── Insert portfolio ───────────────────────────────────────────
    const { data: portfolio, error: pErr } = await (db.from('portfolios') as any)
      .insert({
        client_id,
        label: label.toUpperCase(),
        name: name.trim(),
        currency: currency || 'NGN',
        starting_nav,
        start_date,
        valuation_date: start_date,
        income_target: income_target ?? null,
        cap_target: cap_target ?? null,
        liq_min: liq_min ?? null,
        dd_alert: dd_alert ?? null,
        dd_action: dd_action ?? null,
        max_eq_single: max_eq_single ?? null,
        max_eq_sleeve: max_eq_sleeve ?? null,
        status: 'active',
        notes: notes || null,
      })
      .select()
      .single()

    if (pErr || !portfolio) {
      return NextResponse.json(
        { error: pErr?.message || 'Failed to create portfolio' },
        { status: 500 }
      )
    }

    // ─── Insert sleeve_targets ──────────────────────────────────────
    const sleeveRows = sleeves.map((s: any) => ({
      portfolio_id: portfolio.id,
      sleeve_id: s.sleeve_id,
      name: s.name,
      target_pct: Number(s.target_pct),
      min_pct: Number(s.min_pct ?? 0),
      max_pct: Number(s.max_pct ?? 1),
      sort_order: Number(s.sort_order ?? 0),
    }))

    const { error: sErr } = await (db.from('sleeve_targets') as any).insert(sleeveRows)
    if (sErr) {
      // Rollback: the portfolio shouldn't live without sleeve_targets
      await db.from('portfolios').delete().eq('id', portfolio.id)
      return NextResponse.json(
        { error: `Failed to create sleeve targets (portfolio rolled back): ${sErr.message}` },
        { status: 500 }
      )
    }

    // ─── Insert initial nav_log row ─────────────────────────────────
    // nav_log has NO unique constraint on (portfolio_id, nav_date), so plain INSERT.
    // Never use ON CONFLICT here — see pitfall #3.
    // v19d: nav_value may be 0 for transaction-built portfolios.
    const initialNote =
      starting_nav === 0
        ? 'Initial NAV at portfolio inception — to be built from transactions'
        : 'Initial NAV at portfolio inception'
    const { error: navErr } = await (db.from('nav_log') as any).insert({
      portfolio_id: portfolio.id,
      nav_date: start_date,
      nav_value: starting_nav,
      notes: initialNote,
    })
    if (navErr) {
      // Non-fatal — portfolio works without it, but IRR baseline won't be seeded.
      return NextResponse.json({
        portfolio,
        warning: `Portfolio created but initial NAV log insert failed: ${navErr.message}`,
      })
    }

    return NextResponse.json({ portfolio })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
