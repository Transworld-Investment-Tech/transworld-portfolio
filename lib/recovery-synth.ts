/**
 * lib/recovery-synth.ts — v27o
 *
 * Detects and synthesizes TRANSFER_IN rows for in-kind share transfers
 * that recovery-account clients bring with them at the start of their
 * relationship.
 *
 * THE PROBLEM
 * ───────────
 * Recovery-account clients (DON-C, ADE-C, OPC-A, FMI-A, CDOO-A, CMFB-D,
 * etc.) walk through Transworld's door already holding shares in their
 * CSCS account from prior broker relationships. Those shares are part
 * of the firm's managed AUM from day one but the broker-import flow
 * records ONLY the subsequent BUY/SELL/FEE activity from contract notes
 * — not the in-kind share value.
 *
 * Consequences before v27o:
 * - contributedCapital was radically understated (DON-C showed +₦1.08M
 *   when the true figure is ~₦16M)
 * - Period IRR was correspondingly inflated (DON-C ITD showed +155% p.a.
 *   when the true figure is ~+24% p.a.)
 * - Performance fees would have been over-charged on this inflated excess
 *
 * THE DETECTION (sold orphans)
 * ────────────────────────────
 * Any SELL whose cumulative same-instrument SELL quantity exceeds
 * cumulative BUY quantity at that point in time is, by definition, an
 * in-kind transfer the system never recorded. NGX prohibits short-selling,
 * so the excess MUST have come from somewhere — in recovery-account
 * context, that "somewhere" is the client's pre-existing CSCS holdings.
 *
 * FIFO walk per (portfolio, instrument) identifies these. Each orphan
 * SELL portion produces one synthetic TRANSFER_IN row dated at
 * portfolio.start_date with amount = orphan_qty × sell_price.
 *
 * SCOPE NOTES
 * ───────────
 * v27o handles SOLD orphans only. Held orphans (current CSCS positions
 * with no BUY history — variance-engine's `cscs_only` bucket) continue
 * to flow through apply-reconciliation/route.ts and the variance panel
 * UI. v27p will add held-orphan auto-detection at commit time.
 *
 * IDEMPOTENCY
 * ───────────
 * Synthesized rows carry `external_ref = synthetic-recovery-v1-<portfolio_id>`.
 * synthesizeRecoveryTransfers refuses to insert if any row with this ref
 * already exists for the portfolio (unless options.rerun=true, which
 * deletes existing synth rows first).
 *
 * SIGN CONVENTION
 * ───────────────
 * Synthetic TRANSFER_IN rows use POSITIVE `amount`. lib/fee-calc.ts uses
 * Math.abs() so it tolerates either sign, but for consistency with
 * DON-C's existing pre-v27o TRANSFER_IN row (₦961,868 stored positive)
 * we use positive. The reconciliation route's negative-amount convention
 * is preserved as-is — fee-calc tolerates both. A future cleanup release
 * can unify the convention across writers.
 *
 * FALLBACK BEHAVIOR
 * ─────────────────
 * If portfolios.start_date is NULL at synthesis time (e.g. a brand-new
 * portfolio that has not yet run inferPortfolioStart), we fall back to
 * the earliest transaction date as the anchor. The downstream
 * inferPortfolioStart call (commit route step 11) will then see the
 * synthetic rows AND the real transactions and arrive at the same
 * earliest date — stable.
 */

import { SupabaseClient } from '@supabase/supabase-js'

export interface OrphanSoldRow {
  instrumentId:  string
  qty:           number   // positive
  price:         number   // sale price (proxy for value at recovery)
  amount:        number   // qty × price (gross_value, pre-fees)
  sellTradeDate: string   // ISO YYYY-MM-DD — when the orphan was unmasked
  cnNumber:      string | null
}

export interface DetectionResult {
  ok:              boolean
  portfolioId:     string
  startDate:       string | null
  startDateSource: 'portfolio' | 'earliest_transaction' | 'none'
  soldOrphans:     OrphanSoldRow[]
  totalSoldAmount: number
  reason?:         string
}

export interface SynthesisResult {
  attempted:          boolean
  applied:            boolean
  inserted:           number
  totalAmount:        number
  startDate:          string | null
  externalRef:        string
  alreadySynthesized: boolean
  reason:             string
  error?:             string
}

const EXTERNAL_REF_PREFIX = 'synthetic-recovery-v1'

export function externalRefFor(portfolioId: string): string {
  return `${EXTERNAL_REF_PREFIX}-${portfolioId}`
}

/**
 * Pure detection — runs FIFO walk over BUY/SELL transactions and
 * identifies orphan SELL portions. No DB writes. Safe to call from
 * read-only / diagnostic contexts.
 */
export async function detectOrphans(
  db: SupabaseClient,
  portfolioId: string
): Promise<DetectionResult> {
  // Resolve portfolio start_date with fallback to earliest transaction.
  const { data: portfolio, error: pfErr } = await db
    .from('portfolios')
    .select('start_date')
    .eq('id', portfolioId)
    .single()

  if (pfErr || !portfolio) {
    return {
      ok: false, portfolioId, startDate: null, startDateSource: 'none',
      soldOrphans: [], totalSoldAmount: 0,
      reason: pfErr ? `portfolio fetch: ${pfErr.message}` : 'portfolio not found',
    }
  }

  let startDate: string | null = portfolio.start_date ?? null
  let startDateSource: DetectionResult['startDateSource'] =
    startDate ? 'portfolio' : 'none'

  if (!startDate) {
    const { data: earliest } = await db
      .from('transactions')
      .select('trade_date')
      .eq('portfolio_id', portfolioId)
      .order('trade_date', { ascending: true })
      .limit(1)
      .maybeSingle()
    if (earliest?.trade_date) {
      startDate = earliest.trade_date
      startDateSource = 'earliest_transaction'
    }
  }

  if (!startDate) {
    return {
      ok: false, portfolioId, startDate: null, startDateSource: 'none',
      soldOrphans: [], totalSoldAmount: 0,
      reason: 'portfolios.start_date is NULL and no transactions exist — cannot anchor synthetic rows',
    }
  }

  // Fetch BUY/SELL transactions ordered for FIFO walk.
  // Same-day BUY before SELL (alphabetical 'BUY' < 'SELL') extends BUY
  // coverage as far as possible before declaring an orphan — conservative.
  const { data: txs, error: txErr } = await db
    .from('transactions')
    .select('id, trade_date, instrument_id, action, quantity, price, cn_number, created_at')
    .eq('portfolio_id', portfolioId)
    .in('action', ['BUY', 'SELL'])
    .not('instrument_id', 'is', null)
    .order('trade_date', { ascending: true })
    .order('action', { ascending: true })
    .order('created_at', { ascending: true })

  if (txErr) {
    return {
      ok: false, portfolioId, startDate, startDateSource,
      soldOrphans: [], totalSoldAmount: 0,
      reason: `transactions fetch: ${txErr.message}`,
    }
  }

  // FIFO walk per instrument.
  type Tx = {
    id:            string
    trade_date:    string
    instrument_id: string | null
    action:        string
    quantity:      number | null
    price:         number | null
    cn_number:     string | null
    created_at:    string
  }
  const byInstrument = new Map<string, Tx[]>()
  for (const t of (txs ?? []) as Tx[]) {
    if (!t.instrument_id) continue
    const arr = byInstrument.get(t.instrument_id) ?? []
    arr.push(t)
    byInstrument.set(t.instrument_id, arr)
  }

  const soldOrphans: OrphanSoldRow[] = []

  for (const [instrumentId, list] of byInstrument) {
    let cumBuy  = 0
    let cumSell = 0
    for (const t of list) {
      const q = Number(t.quantity ?? 0)
      if (q === 0) continue
      if (t.action === 'BUY') {
        cumBuy += q
      } else if (t.action === 'SELL') {
        const orphanBefore = Math.max(0, cumSell - cumBuy)
        cumSell += q
        const orphanAfter  = Math.max(0, cumSell - cumBuy)
        const orphanQty    = orphanAfter - orphanBefore
        if (orphanQty > 0) {
          const price  = Number(t.price ?? 0)
          const amount = Math.round(orphanQty * price * 100) / 100
          soldOrphans.push({
            instrumentId,
            qty:           orphanQty,
            price,
            amount,
            sellTradeDate: t.trade_date,
            cnNumber:      t.cn_number ?? null,
          })
        }
      }
    }
  }

  const totalSoldAmount = Math.round(
    soldOrphans.reduce((s, o) => s + o.amount, 0) * 100
  ) / 100

  return {
    ok: true,
    portfolioId,
    startDate,
    startDateSource,
    soldOrphans,
    totalSoldAmount,
  }
}

/**
 * Detection + insert. Idempotent via external_ref.
 *
 * Returns synth metadata; does NOT trigger holdings rebuild, metadata
 * re-inference, or NAV reconstruction. Callers (commit route, admin
 * route) are responsible for those subsequent steps.
 */
export async function synthesizeRecoveryTransfers(
  db: SupabaseClient,
  portfolioId: string,
  options?: { rerun?: boolean }
): Promise<SynthesisResult> {
  const externalRef = externalRefFor(portfolioId)
  const base: SynthesisResult = {
    attempted:          true,
    applied:            false,
    inserted:           0,
    totalAmount:        0,
    startDate:          null,
    externalRef,
    alreadySynthesized: false,
    reason:             'not yet evaluated',
  }

  try {
    // Idempotency check (with optional rerun cleanup).
    const { count: existingCount, error: countErr } = await db
      .from('transactions')
      .select('id', { count: 'exact', head: true })
      .eq('portfolio_id', portfolioId)
      .eq('external_ref', externalRef)

    if (countErr) {
      return { ...base, reason: `idempotency check failed: ${countErr.message}`, error: countErr.message }
    }

    if ((existingCount ?? 0) > 0) {
      if (options?.rerun) {
        const { error: delErr } = await db
          .from('transactions')
          .delete()
          .eq('portfolio_id', portfolioId)
          .eq('external_ref', externalRef)
        if (delErr) {
          return { ...base, reason: `rerun delete failed: ${delErr.message}`, error: delErr.message }
        }
      } else {
        return {
          ...base,
          alreadySynthesized: true,
          reason: `${existingCount} synthetic row(s) already exist (external_ref=${externalRef}). Pass rerun=true to replace.`,
        }
      }
    }

    // Detection.
    const detection = await detectOrphans(db, portfolioId)
    if (!detection.ok) {
      return { ...base, startDate: detection.startDate, reason: detection.reason ?? 'detection failed' }
    }

    if (detection.soldOrphans.length === 0) {
      return {
        ...base,
        applied:     true,
        inserted:    0,
        totalAmount: 0,
        startDate:   detection.startDate,
        reason:      'no sold orphans detected — portfolio has no in-kind shares to synthesize',
      }
    }

    // Build rows. Sign convention: positive amount for TRANSFER_IN (see header).
    const rows = detection.soldOrphans.map(o => ({
      portfolio_id:   portfolioId,
      trade_date:     detection.startDate,
      action:         'TRANSFER_IN' as const,
      instrument_id:  o.instrumentId,
      quantity:       o.qty,
      price:          o.price,
      amount:         o.amount,
      gross_value:    o.amount,
      notes:          `Recovery in-kind transfer (synthesized from orphan SELL on ${o.sellTradeDate}${o.cnNumber ? `; CN# ${o.cnNumber}` : ''})`,
      external_ref:   externalRef,
    }))

    const { data: inserted, error: insErr } = await db
      .from('transactions')
      .insert(rows)
      .select('id')

    if (insErr) {
      return { ...base, startDate: detection.startDate, reason: `insert failed: ${insErr.message}`, error: insErr.message }
    }

    return {
      ...base,
      applied:     true,
      inserted:    inserted?.length ?? 0,
      totalAmount: detection.totalSoldAmount,
      startDate:   detection.startDate,
      reason:      `inserted ${inserted?.length ?? 0} synthetic TRANSFER_IN row(s) totaling NGN ${detection.totalSoldAmount.toFixed(2)} (anchor: ${detection.startDate}, source: ${detection.startDateSource})`,
    }
  } catch (e: any) {
    return { ...base, reason: `unexpected error: ${e.message || 'unknown'}`, error: e.message }
  }
}
