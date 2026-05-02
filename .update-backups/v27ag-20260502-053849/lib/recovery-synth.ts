/**
 * lib/recovery-synth.ts — v27o-fix1
 *
 * v27o-fix1 change: Replaces broken cumulative-position FIFO with real
 * BUY-lot inventory matching.
 *
 * THE BUG IN v27o
 * ───────────────
 * The original v27o algorithm tracked cumBuy and cumSell as scalars and
 * emitted a synthetic TRANSFER_IN whenever (cumSell − cumBuy) grew over
 * the prior SELL's position. This over-counts when the orphan position
 * temporarily shrinks (BUYs cover part of an existing orphan position)
 * and then grows again (later SELLs exceed the new BUYs). The same
 * physical "phantom" shares get re-counted as new orphans.
 *
 * Concrete failure on DON-C FIRSTHOLDCO:
 *   2021-03-11 SELL 1,681,315 against empty queue   → orphan 1,681,315 ✓
 *   2022-11-11 BUY 93,700                            (queue has 93,700)
 *   2023-05-04 BUY 200,000                           (queue has 293,700)
 *   2023-07-06 SELL 293,700 against queue of 293,700 → real BUYs sold,
 *                                                       NOT an orphan
 *   v27o emitted an extra synthesis row of 293,700 @ ₦18.65 = ₦5.48M
 *   that should not have existed.
 *
 * THE FIX
 * ───────
 * Real FIFO inventory matching: maintain an explicit queue of BUY lots
 * per instrument. Each SELL consumes lots oldest-first. If the queue
 * runs dry mid-SELL, only the unmatched remainder is an orphan, dated
 * at portfolio.start_date and priced at the SELL's price. This handles
 * temporary BUY-coverage cleanly because the BUYs are removed from the
 * queue when they're consumed and cannot be "re-revealed" later.
 *
 * Same idempotency, same external_ref tagging, same return shape as v27o.
 *
 * THE BACKDROP (preserved from v27o)
 * ──────────────────────────────────
 * Recovery-account clients (DON-C, ADE-C, OPC-A, FMI-A, CDOO-A, CMFB-D,
 * etc.) walk through Transworld's door already holding shares in their
 * CSCS account from prior broker relationships. The broker-import flow
 * records ONLY the subsequent BUY/SELL/FEE activity — not the in-kind
 * share value. v27o introduces synthetic TRANSFER_IN rows to capture
 * that initial value. v27o-fix1 corrects the detection algorithm.
 *
 * SCOPE
 * ─────
 * v27o-fix1 still handles SOLD orphans only. Held orphans (current CSCS
 * positions with no BUY history) continue to flow through
 * apply-reconciliation/route.ts and the variance panel UI. Held-orphan
 * auto-detection is on the v27p ship list.
 *
 * SIGN CONVENTION (preserved)
 * ───────────────────────────
 * Synthetic TRANSFER_IN rows use POSITIVE amount, consistent with
 * pre-v27o existing TRANSFER_IN rows. fee-calc.ts uses Math.abs() so it
 * tolerates either sign.
 *
 * START_DATE FALLBACK (preserved)
 * ───────────────────────────────
 * If portfolios.start_date is NULL, falls back to earliest transaction
 * date as the synthesis anchor.
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
 * Pure detection — runs FIFO inventory matching over BUY/SELL transactions
 * and identifies orphan SELL portions. No DB writes. Safe to call from
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

  // IMPORTANT: We must EXCLUDE prior synthetic TRANSFER_IN rows from the
  // FIFO walk. We're walking only real BUY/SELL events to detect orphans.
  // The synthetic rows have action='TRANSFER_IN' so they're already filtered
  // by the .in('action', ['BUY', 'SELL']) below — but noting for clarity.
  const { data: txs, error: txErr } = await db
    .from('transactions')
    .select('id, trade_date, instrument_id, action, quantity, price, cn_number, created_at')
    .eq('portfolio_id', portfolioId)
    .in('action', ['BUY', 'SELL'])
    .not('instrument_id', 'is', null)
    .order('trade_date', { ascending: true })
    .order('action', { ascending: true })  // BUY < SELL alphabetically; same-day BUY-before-SELL
    .order('created_at', { ascending: true })

  if (txErr) {
    return {
      ok: false, portfolioId, startDate, startDateSource,
      soldOrphans: [], totalSoldAmount: 0,
      reason: `transactions fetch: ${txErr.message}`,
    }
  }

  // Group by instrument for per-instrument FIFO walk.
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

  // ── Real FIFO inventory matching (v27o-fix1) ──────────────────
  //
  // For each instrument, maintain a queue of BUY lots (each lot tracks
  // its remaining unmatched quantity). SELL events consume lots oldest-
  // first. Any portion of a SELL that the queue can't satisfy is an
  // orphan (priced at the SELL's price, dated at start_date).
  //
  // This correctly handles the BUY→SELL→BUY→SELL pattern that confused
  // the v27o cumulative-position tracker — once a BUY lot is consumed,
  // it's gone from the queue and can't be re-counted.
  for (const [instrumentId, list] of byInstrument) {
    type BuyLot = { remaining: number }
    const buyQueue: BuyLot[] = []

    for (const t of list) {
      const q = Number(t.quantity ?? 0)
      if (q === 0) continue

      if (t.action === 'BUY') {
        buyQueue.push({ remaining: q })
        continue
      }

      if (t.action === 'SELL') {
        let remainingSell = q
        while (remainingSell > 0 && buyQueue.length > 0) {
          const lot = buyQueue[0]
          if (lot.remaining <= remainingSell) {
            remainingSell -= lot.remaining
            buyQueue.shift()
          } else {
            lot.remaining -= remainingSell
            remainingSell = 0
          }
        }

        if (remainingSell > 0) {
          // Unmatched portion of this SELL — orphan in-kind shares.
          const price  = Number(t.price ?? 0)
          const amount = Math.round(remainingSell * price * 100) / 100
          soldOrphans.push({
            instrumentId,
            qty:           remainingSell,
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
