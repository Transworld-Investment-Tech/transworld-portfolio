// ═══════════════════════════════════════════════════════════════
// /api/cockpit/signals (v27ax)
// ═══════════════════════════════════════════════════════════════
//
// Returns ranked, narrated signals for the firm cockpit's
// "what demands attention today" panel.
//
// Architectural choice: this route does NOT import unfamiliar helpers
// from across the codebase. It depends only on:
//   - fetchAllActivePortfolios   (CONFIRMED export, cockpit-aggregations)
//   - computeAllPortfolioNAVs    (CONFIRMED export, cockpit-aggregations)
//   - computeCashBalance         (CONFIRMED export, lib/cash)
//
// For every other piece of data the signals engine needs (sector
// exposure, top movers, house views, watchlist pulse, fee outlook,
// stale reports), the route fetches the existing /api/cockpit/*
// endpoints server-to-server. This gives us:
//   - zero new aggregation imports (lower TS-error risk)
//   - data that's IDENTICAL to what the cockpit page displays
//     (signals can never disagree with what the user sees)
//   - well-defined contracts (the JSON shapes are already known
//     from app/page.tsx imports)
//
// The minor cost is one extra round-trip per endpoint, but they
// all run in parallel and the dominant latency in this route is
// the Claude narrator call regardless.
//
// For ytdByPortfolio (not served by any single existing endpoint)
// the route reads nav_log directly: anchor = first nav_log row
// at-or-after Jan 1 of current year; current = latest nav_log row.
// Falls back to null when no Jan 1 anchor exists (matches the
// fetchYTDReturns v27b semantic).
// ═══════════════════════════════════════════════════════════════

import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

import {
  fetchAllActivePortfolios,
  computeAllPortfolioNAVs,
} from '@/lib/cockpit-aggregations'
import { computeCashBalance } from '@/lib/cash'
import { computeSignals, type Signal, type SignalsInput } from '@/lib/cockpit-signals'
import { narrateSignals, type NarratedSignal } from '@/lib/cockpit-narrator'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const fmtNgnM = (n: number) => '\u20a6' + (n / 1e6).toFixed(2) + 'M'

interface SignalEnvelope extends Signal {
  narrated: NarratedSignal
}

const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return isFinite(n) ? n : null
}

async function fetchJsonOrNull<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url, { cache: 'no-store' })
    if (!r.ok) return null
    return await r.json() as T
  } catch {
    return null
  }
}

// Inline YTD computation: nav_log first row at-or-after Jan 1 vs latest row.
// Mirrors fetchYTDReturns v27b semantic (returns null when no Jan 1 anchor).
async function computeYTDInline(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  portfolioIds: string[],
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>()
  if (portfolioIds.length === 0) return out

  const yearStart = new Date()
  yearStart.setMonth(0, 1)
  yearStart.setHours(0, 0, 0, 0)
  const yearStartIso = yearStart.toISOString().slice(0, 10)

  const { data: navRows } = await db
    .from('nav_log')
    .select('portfolio_id, nav_date, nav_value')
    .in('portfolio_id', portfolioIds)
    .gte('nav_date', yearStartIso)
    .order('nav_date', { ascending: true })
    .limit(50000)

  // Group by portfolio: first row (anchor at-or-after Jan 1) and last row (current)
  const firstByPid = new Map<string, { nav_date: string; nav_value: number }>()
  const lastByPid  = new Map<string, { nav_date: string; nav_value: number }>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const r of (navRows ?? []) as any[]) {
    const v = numOrNull(r.nav_value)
    if (v === null) continue
    const pid = r.portfolio_id as string
    if (!firstByPid.has(pid)) firstByPid.set(pid, { nav_date: r.nav_date, nav_value: v })
    lastByPid.set(pid, { nav_date: r.nav_date, nav_value: v })
  }

  for (const pid of portfolioIds) {
    const first = firstByPid.get(pid)
    const last  = lastByPid.get(pid)
    if (!first || !last || first.nav_value <= 0) {
      out.set(pid, null)
    } else {
      out.set(pid, (last.nav_value - first.nav_value) / first.nav_value)
    }
  }
  return out
}

// Inline cash-by-portfolio: query transactions, run computeCashBalance per pid.
// Replicates the v27aw-fix4 pattern (notes column included for in-kind detection).
async function computeCashByPortfolioInline(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  portfolioIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (portfolioIds.length === 0) return out

  const { data: txns } = await db
    .from('transactions')
    .select('portfolio_id, action, instrument_id, quantity, price, gross_value, amount, fees, fee_management, fee_other, notes')
    .in('portfolio_id', portfolioIds)
    .limit(50000)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const txByPortfolio = new Map<string, any[]>()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const t of (txns ?? []) as any[]) {
    const arr = txByPortfolio.get(t.portfolio_id) ?? []
    arr.push(t)
    txByPortfolio.set(t.portfolio_id, arr)
  }
  for (const pid of portfolioIds) {
    out.set(pid, computeCashBalance(txByPortfolio.get(pid) ?? []))
  }
  return out
}

export async function GET(request: Request) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (!supabaseUrl || !supabaseKey) {
    return NextResponse.json({ error: 'supabase env missing', signals: [] }, { status: 500 })
  }
  const db = createClient(supabaseUrl, supabaseKey)

  const baseUrl = new URL(request.url).origin

  try {
    // ─── Step 1: portfolios + NAV (direct, confirmed exports) ──────
    const portfolios = await fetchAllActivePortfolios(db)
    const portfolioIds = portfolios.map(p => p.id)

    // ─── Step 2: parallel fan-out ──────────────────────────────────
    // Server-to-server for the existing endpoints; direct DB for the
    // three quantities not served by any single endpoint.
    const [
      navByPortfolio,
      cashByPortfolio,
      ytdByPortfolio,
      summaryRes,
      sectorRes,
      moversRes,
      houseViewsRes,
      pulseRes,
      feeOutlookRes,
    ] = await Promise.all([
      computeAllPortfolioNAVs(db, portfolioIds),
      computeCashByPortfolioInline(db, portfolioIds),
      computeYTDInline(db, portfolioIds),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchJsonOrNull<any>(baseUrl + '/api/cockpit/summary'),
      fetchJsonOrNull<SignalsInput['sectorExposure']>(baseUrl + '/api/cockpit/sector-exposure'),
      fetchJsonOrNull<SignalsInput['topMovers']>(baseUrl + '/api/cockpit/top-movers'),
      fetchJsonOrNull<SignalsInput['houseViews']>(baseUrl + '/api/cockpit/house-views'),
      fetchJsonOrNull<SignalsInput['watchlistPulse']>(baseUrl + '/api/cockpit/watchlist-pulse'),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fetchJsonOrNull<{ portfolios: any[] }>(baseUrl + '/api/cockpit/fee-outlook'),
    ])

    // ─── Step 3: adapt responses into SignalsInput ─────────────────
    const sectorExposure = sectorRes ?? {
      sectors: [], firm_totals: {}, firm_total: 0, portfolios: [],
    }
    const topMovers = moversRes ?? {
      day:     { gainers: [], losers: [], as_of_date: null, lookback_target_days: 0,  instruments_with_data: 0, total_held_instruments: 0 },
      week:    { gainers: [], losers: [], as_of_date: null, lookback_target_days: 7,  instruments_with_data: 0, total_held_instruments: 0 },
      month:   { gainers: [], losers: [], as_of_date: null, lookback_target_days: 30, instruments_with_data: 0, total_held_instruments: 0 },
      quarter: { gainers: [], losers: [], as_of_date: null, lookback_target_days: 90, instruments_with_data: 0, total_held_instruments: 0 },
    }
    const houseViews = houseViewsRes ?? {
      rows: [], firm_equity_total: 0, total_unique: 0,
    }
    const watchlistPulse = pulseRes ?? {
      day:     { rows: [], threshold_pct: 2.0,  lookback_target_days: 0,  as_of_date: null, watchlist_size: 0, unheld_count: 0, instruments_with_data: 0, below_threshold_count: 0 },
      week:    { rows: [], threshold_pct: 5.0,  lookback_target_days: 7,  as_of_date: null, watchlist_size: 0, unheld_count: 0, instruments_with_data: 0, below_threshold_count: 0 },
      month:   { rows: [], threshold_pct: 10.0, lookback_target_days: 30, as_of_date: null, watchlist_size: 0, unheld_count: 0, instruments_with_data: 0, below_threshold_count: 0 },
      quarter: { rows: [], threshold_pct: 20.0, lookback_target_days: 90, as_of_date: null, watchlist_size: 0, unheld_count: 0, instruments_with_data: 0, below_threshold_count: 0 },
    }
    const feeOutlook = (feeOutlookRes && Array.isArray(feeOutlookRes.portfolios))
      ? feeOutlookRes.portfolios
      : []
    const staleReports = (summaryRes && Array.isArray(summaryRes.stale_reports))
      ? summaryRes.stale_reports
      : []

    // ─── Step 4: compute + narrate ─────────────────────────────────
    const signals = computeSignals({
      portfolios,
      navByPortfolio,
      ytdByPortfolio,
      cashByPortfolio,
      houseViews,
      topMovers,
      watchlistPulse,
      sectorExposure,
      feeOutlook,
      staleReports,
    })

    const totalAum = Array.from(navByPortfolio.values()).reduce((a, b) => a + b, 0)
    const asOfDate = new Date().toISOString().slice(0, 10)
    const activeMandates = portfolios.filter(p => !p.is_internal).length

    const narratedMap = await narrateSignals(signals, {
      asOfDate,
      firmAumNgnFmt:  fmtNgnM(totalAum),
      activeMandates,
    })

    // ─── Step 5: envelope + return ─────────────────────────────────
    const envelope: SignalEnvelope[] = signals.map(s => ({
      ...s,
      narrated: narratedMap.get(s.id) ?? {
        id:       s.id,
        headline: s.suggested_action,
        body:     '',
        callouts: [],
      },
    }))

    return NextResponse.json({
      as_of_date:    asOfDate,
      total_signals: envelope.length,
      signals:       envelope,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'unknown error'
    return NextResponse.json({ error: msg, signals: [] }, { status: 500 })
  }
}
