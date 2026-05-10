// ═══════════════════════════════════════════════════════════════
// COCKPIT SIGNALS (v27ax)
// ═══════════════════════════════════════════════════════════════
//
// Pure deterministic synthesis layer. Reads the aggregations already
// produced by lib/cockpit-aggregations.ts and lib/mandate-health.ts;
// emits a ranked Signal[] of force-investigation triggers.
//
// No AI here. No side effects. No persistence. The narrator
// (lib/cockpit-narrator.ts) is a separate, optional layer that wraps
// these signals in operator-voice prose.
//
// Five signal types in v27ax:
//   1. concentration_thread       — name overweight in ≥1 mandate × material move
//   2. outsized_return_low_cash   — YTD > 80% × cash sleeve below liq band midpoint
//   3. watchlist_opportunity      — unheld watchlist ticker × move × corroborator
//   4. stale_material_mandate     — overdue × NAV > median × |YTD| > 20%
//   5. fee_divergence             — BEATING with sizeable projected fee, OR BELOW with deep excess
//
// All thresholds are composed from per-portfolio fields already on
// the portfolios table. No firmwide settings introduced.
//
// Severity tiers:
//   red   — any mandate AT or OVER its own per-portfolio threshold
//   amber — ≥80% of threshold, or "worth attention this week" cases
//   gold  — opportunities (watchlist; positive fee divergence)
//
// Ranking: red → amber → gold, then ranking_score desc within tier.
// ═══════════════════════════════════════════════════════════════

import type {
  PortfolioWithMeta,
  HouseViewsData,
  TopMoversData,
  WatchlistPulseData,
  SectorExposureData,
  StaleReportFlag,
} from './cockpit-aggregations'
import type { FeeOutlook } from './fee-outlook'

// ─── Types ────────────────────────────────────────────────────

export type SignalSeverity = 'red' | 'amber' | 'gold'

export type SignalType =
  | 'concentration_thread'
  | 'outsized_return_low_cash'
  | 'watchlist_opportunity'
  | 'stale_material_mandate'
  | 'fee_divergence'

export interface SignalEvidence {
  // Structured facts the narrator quotes verbatim. Every number Claude
  // renders comes from this object — no fabrication possible. Shape is
  // per-signal-type. Unknown is the right floor; per-type narrowing
  // happens at narrator-time via type field.
  [key: string]: unknown
}

export interface Signal {
  id:                  string         // stable hash of (type + primary_subject)
  type:                SignalType
  severity:            SignalSeverity
  primary_subject:     string         // ticker / portfolio_id / etc.
  primary_subject_kind: 'ticker' | 'portfolio' | 'mandate'
  affected_portfolios: string[]       // portfolio_ids relevant for drill-down
  evidence:            SignalEvidence
  suggested_action:    string         // engine-generated one-liner
  ranking_score:       number         // for sort within severity tier
}

export interface SignalsInput {
  portfolios:      PortfolioWithMeta[]
  navByPortfolio:  Map<string, number>
  // ytd return as a decimal (e.g., 0.83 = 83%); null when not computable
  ytdByPortfolio:  Map<string, number | null>
  // cash NAV per portfolio (computeCashBalance result)
  cashByPortfolio: Map<string, number>
  houseViews:      HouseViewsData
  topMovers:       TopMoversData
  watchlistPulse:  WatchlistPulseData
  sectorExposure:  SectorExposureData
  feeOutlook:      FeeOutlook[]
  staleReports:    StaleReportFlag[]
}

// ─── Helpers ──────────────────────────────────────────────────

const numOrNull = (v: unknown): number | null => {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return isFinite(n) ? n : null
}
const num = (v: unknown, fallback = 0): number => numOrNull(v) ?? fallback

function stableHash(s: string): string {
  // Tiny FNV-1a 32-bit. Collisions don't matter since we only use this
  // for stable React keys + dedup within a single render.
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0
  }
  return h.toString(16)
}

function fmtNgnM(n: number): string {
  return '\u20a6' + (n / 1e6).toFixed(2) + 'M'
}

function fmtPct(n: number, decimals = 1): string {
  return (n * 100).toFixed(decimals) + '%'
}

function fmtSignedPct(n: number, decimals = 1): string {
  const s = (n * 100).toFixed(decimals)
  return n >= 0 ? '+' + s + '%' : s + '%'
}

// ─── Signal 1: concentration_thread ───────────────────────────
//
// Fires when a House View ticker is held at ≥80% of any mandate's own
// max_eq_single AND the ticker had a |weekly move| ≥ 5%.
//
// Severity:
//   red   — any holding mandate is AT-or-OVER its own max_eq_single
//   amber — any holding mandate is ≥80% of its max_eq_single
//
// Why this rule: per Okezie's framing, multiple portfolios holding the
// same name is fine — that's not the trigger. The trigger is one or
// more portfolios being overweight RELATIVE TO THEIR OWN configured
// limit, paired with a price move that creates an action moment.

function fireConcentrationThread(input: SignalsInput): Signal[] {
  const out: Signal[] = []
  const portfolioById = new Map(input.portfolios.map(p => [p.id, p]))

  // Build a ticker → weekly change map from TopMovers (week window only)
  const weekChange = new Map<string, number>()
  const weekMovers = [
    ...input.topMovers.week.gainers,
    ...input.topMovers.week.losers,
  ]
  for (const m of weekMovers) {
    weekChange.set(m.instrument_id, m.change_pct / 100)
  }

  for (const row of input.houseViews.rows) {
    const wkChange = weekChange.get(row.instrument_id)
    // No week change data → can't fire. Skip.
    if (wkChange === undefined) continue
    if (Math.abs(wkChange) < 0.05) continue   // |move| < 5% → not material

    // Per-mandate concentration check
    type MandateBreach = {
      portfolio_id:    string
      portfolio_name:  string
      portfolio_label: string
      client_code:     string
      ngn:             number
      mandate_nav:     number
      pct_of_nav:      number
      cap:             number
      breach_ratio:    number   // pct_of_nav / cap
    }
    const breaches: MandateBreach[] = []

    for (const m of row.mandates) {
      const p = portfolioById.get(m.portfolio_id)
      if (!p) continue
      const mandateNav = input.navByPortfolio.get(m.portfolio_id) ?? 0
      if (mandateNav <= 0) continue
      const pctOfNav = m.ngn / mandateNav
      const cap = num(p.max_eq_single, 0.10)
      if (cap <= 0) continue
      const ratio = pctOfNav / cap
      if (ratio < 0.80) continue  // below amber threshold

      breaches.push({
        portfolio_id:    m.portfolio_id,
        portfolio_name:  m.portfolio_name,
        portfolio_label: m.portfolio_label,
        client_code:     m.client_code,
        ngn:             m.ngn,
        mandate_nav:     mandateNav,
        pct_of_nav:      pctOfNav,
        cap:             cap,
        breach_ratio:    ratio,
      })
    }

    if (breaches.length === 0) continue

    // Severity: red if any breach_ratio >= 1.0, else amber
    const maxRatio = Math.max(...breaches.map(b => b.breach_ratio))
    const severity: SignalSeverity = maxRatio >= 1.0 ? 'red' : 'amber'

    breaches.sort((a, b) => b.breach_ratio - a.breach_ratio)

    out.push({
      id: stableHash('concentration_thread:' + row.instrument_id),
      type: 'concentration_thread',
      severity,
      primary_subject: row.instrument_id,
      primary_subject_kind: 'ticker',
      affected_portfolios: breaches.map(b => b.portfolio_id),
      evidence: {
        ticker:                row.instrument_id,
        ticker_name:           row.name,
        sector:                row.sector,
        firm_exposure_ngn:     row.firm_exposure_ngn,
        firm_exposure_ngn_fmt: fmtNgnM(row.firm_exposure_ngn),
        share_of_firm_equity:  row.share_of_firm_equity_pct,
        share_of_firm_equity_fmt: fmtPct(row.share_of_firm_equity_pct),
        mandate_count:         row.mandate_count,
        weekly_change_pct:     wkChange,
        weekly_change_fmt:     fmtSignedPct(wkChange),
        breaching_mandates: breaches.map(b => ({
          portfolio_id:    b.portfolio_id,
          portfolio_name:  b.portfolio_name,
          portfolio_label: b.portfolio_label,
          client_code:     b.client_code,
          mandate_label:   b.client_code + '-' + b.portfolio_label,
          ngn:             b.ngn,
          ngn_fmt:         fmtNgnM(b.ngn),
          pct_of_nav:      b.pct_of_nav,
          pct_of_nav_fmt:  fmtPct(b.pct_of_nav),
          cap_pct:         b.cap,
          cap_pct_fmt:     fmtPct(b.cap),
          status:          b.breach_ratio >= 1.0 ? 'over_cap' : 'near_cap',
        })),
      },
      suggested_action: severity === 'red'
        ? 'Review concentration in '
            + breaches[0].client_code + '-' + breaches[0].portfolio_label
            + ' before next NGX session'
        : 'Monitor concentration in '
            + breaches[0].client_code + '-' + breaches[0].portfolio_label,
      ranking_score: row.firm_exposure_ngn * Math.abs(wkChange),
    })
  }

  return out
}

// ─── Signal 2: outsized_return_low_cash ───────────────────────
//
// Fires when YTD > 80% AND cash sleeve < 80% of liq_max midpoint.
// "Liq_max midpoint" = average of liq_min and liq_max bands; falls
// back to liq_min × 1.5 when liq_max is null.
//
// Severity:
//   red   — YTD > 150% AND cash < liq_min (already breaching)
//   amber — YTD > 80%  AND cash < 0.8 × liq band midpoint

function fireOutsizedReturnLowCash(input: SignalsInput): Signal[] {
  const out: Signal[] = []

  for (const p of input.portfolios) {
    const ytd = input.ytdByPortfolio.get(p.id)
    if (ytd === null || ytd === undefined) continue
    if (ytd <= 0.80) continue

    const nav = input.navByPortfolio.get(p.id) ?? 0
    if (nav <= 0) continue

    const cash = input.cashByPortfolio.get(p.id) ?? 0
    const cashPct = cash / nav

    const liqMin = num(p.liq_min, 0.05)
    const liqMax = p.liq_max != null ? num(p.liq_max) : (liqMin * 3)
    const midpoint = (liqMin + liqMax) / 2

    if (cashPct >= 0.8 * midpoint) continue

    const overCap = ytd > 1.50 && cashPct < liqMin
    const severity: SignalSeverity = overCap ? 'red' : 'amber'

    out.push({
      id: stableHash('outsized_return_low_cash:' + p.id),
      type: 'outsized_return_low_cash',
      severity,
      primary_subject: p.id,
      primary_subject_kind: 'portfolio',
      affected_portfolios: [p.id],
      evidence: {
        portfolio_id:     p.id,
        portfolio_name:   p.name,
        portfolio_label:  p.label,
        client_code:      p.client_code,
        client_name:      p.client_name,
        mandate_label:    p.client_code + '-' + p.label,
        nav_ngn:          nav,
        nav_ngn_fmt:      fmtNgnM(nav),
        ytd_return:       ytd,
        ytd_return_fmt:   fmtSignedPct(ytd),
        cash_ngn:         cash,
        cash_ngn_fmt:     fmtNgnM(cash),
        cash_pct:         cashPct,
        cash_pct_fmt:     fmtPct(cashPct),
        liq_min:          liqMin,
        liq_min_fmt:      fmtPct(liqMin),
        liq_max:          liqMax,
        liq_max_fmt:      fmtPct(liqMax),
        liq_midpoint:     midpoint,
        liq_midpoint_fmt: fmtPct(midpoint),
        below_min:        cashPct < liqMin,
      },
      suggested_action: overCap
        ? 'Consider crystallising gains in ' + p.client_code + '-' + p.label
        : 'Review cash deployment in ' + p.client_code + '-' + p.label,
      ranking_score: ytd * nav,   // weight by NGN at risk
    })
  }

  return out
}

// ─── Signal 3: watchlist_opportunity ──────────────────────────
//
// Fires when an unheld watchlist ticker has |window change| above the
// window threshold AND at least one corroborating signal:
//   (a) sector is below firm-median allocation across mandates
//   (b) ticker's sector overlaps with held watchlist names (we hold sector peers)
//   (c) the move is contrarian to its sector  (placeholder — sector index not
//       wired in v27ax; treated as not-fired until data source available)
//
// Direction-agnostic: rallies and pullbacks both fire, with different
// narrator framings carried via move_direction in evidence.
//
// Severity: gold (opportunity tier).

function fireWatchlistOpportunity(input: SignalsInput): Signal[] {
  const out: Signal[] = []

  // Use the day window — most actionable for a daily cockpit.
  // The narrator can reference week/month context if we surface them.
  const dayPulse = input.watchlistPulse.day
  if (!dayPulse || dayPulse.rows.length === 0) return out

  // Build sector-allocation map: sector → firm NGN exposure
  const firmSectorTotals = input.sectorExposure.firm_totals
  const firmEquityTotal = input.sectorExposure.firm_total
  if (firmEquityTotal <= 0) return out

  const sectorPctMap = new Map<string, number>()
  for (const [sector, ngn] of Object.entries(firmSectorTotals)) {
    sectorPctMap.set(sector, ngn / firmEquityTotal)
  }
  const sectorPctValues = Array.from(sectorPctMap.values()).sort((a, b) => a - b)
  const firmMedianSectorPct = sectorPctValues.length === 0
    ? 0
    : sectorPctValues[Math.floor(sectorPctValues.length / 2)]

  // Build set of sectors we hold via House Views (mandate_count >= 1 implicitly,
  // since House Views are tickers held by ≥2 mandates; we also want ≥1-mandate
  // names but the gap is acceptable for v27ax — House Views is the conviction
  // surface, which is what corroborator (b) is about).
  const heldSectors = new Set<string>()
  for (const row of input.houseViews.rows) {
    if (row.sector) heldSectors.add(row.sector)
  }

  for (const row of dayPulse.rows) {
    const change = row.change_pct / 100
    if (Math.abs(change) < dayPulse.threshold_pct / 100) continue

    const sector = row.sector
    const sectorPct = sector ? (sectorPctMap.get(sector) ?? 0) : 0

    // Corroborator (a): sector below firm-median allocation
    const corroboratorA = sector !== null && sectorPct < firmMedianSectorPct

    // Corroborator (b): ticker's sector is a held conviction sector
    const corroboratorB = sector !== null && heldSectors.has(sector)

    // Corroborator (c): not wired in v27ax
    const corroboratorC = false

    if (!corroboratorA && !corroboratorB && !corroboratorC) continue

    const direction: 'up' | 'down' = change >= 0 ? 'up' : 'down'

    const reasons: string[] = []
    if (corroboratorA) reasons.push('sector_below_firm_median')
    if (corroboratorB) reasons.push('held_sector_conviction')

    out.push({
      id: stableHash('watchlist_opportunity:' + row.ticker),
      type: 'watchlist_opportunity',
      severity: 'gold',
      primary_subject: row.ticker,
      primary_subject_kind: 'ticker',
      affected_portfolios: [],   // book-wide consideration, no specific mandate
      evidence: {
        ticker:                  row.ticker,
        ticker_name:             row.name,
        sector:                  row.sector,
        section:                 row.section,
        latest_price:            row.latest_price,
        latest_date:             row.latest_date,
        change_pct:              change,
        change_fmt:              fmtSignedPct(change),
        move_direction:          direction,
        window:                  'day',
        threshold_pct:           dayPulse.threshold_pct / 100,
        threshold_fmt:           dayPulse.threshold_pct.toFixed(1) + '%',
        sector_share_of_firm:    sectorPct,
        sector_share_fmt:        fmtPct(sectorPct),
        firm_median_sector:      firmMedianSectorPct,
        firm_median_sector_fmt:  fmtPct(firmMedianSectorPct),
        reasons,
        is_unheld:               true,
      },
      suggested_action: direction === 'up'
        ? 'Confirm thesis on ' + row.ticker + ' — rally on conviction or chase risk'
        : 'Confirm thesis on ' + row.ticker + ' — entry opportunity or signal to skip',
      ranking_score: Math.abs(change) * (corroboratorA && corroboratorB ? 2 : 1),
    })
  }

  return out
}

// ─── Signal 4: stale_material_mandate ─────────────────────────
//
// Fires when a stale report exists AND the affected mandate has both
// (a) NAV > firm median NAV across active mandates
// (b) |YTD return| > 20% (i.e., the mandate has a story to tell, in
//     either direction — outsized win or significant drawdown).
//
// Severity:
//   red   — days_overdue > 90 AND NAV in top quartile
//   amber — otherwise

function fireStaleMaterialMandate(input: SignalsInput): Signal[] {
  const out: Signal[] = []

  if (input.staleReports.length === 0) return out

  // Compute firm-median NAV and top-quartile cutoff
  const navs = Array.from(input.navByPortfolio.values())
    .filter(n => n > 0)
    .sort((a, b) => a - b)
  if (navs.length === 0) return out
  const median = navs[Math.floor(navs.length / 2)]
  const q3 = navs[Math.floor(navs.length * 0.75)]

  for (const stale of input.staleReports) {
    if (stale.days_overdue <= 0) continue

    const nav = input.navByPortfolio.get(stale.portfolio_id) ?? 0
    if (nav <= median) continue   // material = above-median NAV

    const ytd = input.ytdByPortfolio.get(stale.portfolio_id)
    if (ytd === null || ytd === undefined) continue
    if (Math.abs(ytd) <= 0.20) continue   // material = >20% move either way

    const port = input.portfolios.find(p => p.id === stale.portfolio_id)

    const severity: SignalSeverity =
      stale.days_overdue > 90 && nav >= q3 ? 'red' : 'amber'

    out.push({
      id: stableHash('stale_material_mandate:' + stale.portfolio_id),
      type: 'stale_material_mandate',
      severity,
      primary_subject: stale.portfolio_id,
      primary_subject_kind: 'portfolio',
      affected_portfolios: [stale.portfolio_id],
      evidence: {
        portfolio_id:    stale.portfolio_id,
        portfolio_name:  stale.portfolio_name,
        portfolio_label: port?.label ?? '',
        client_name:     stale.client_name,
        client_code:     port?.client_code ?? '',
        mandate_label:   (port?.client_code ?? '') + '-' + (port?.label ?? ''),
        nav_ngn:         nav,
        nav_ngn_fmt:     fmtNgnM(nav),
        ytd_return:      ytd,
        ytd_return_fmt:  fmtSignedPct(ytd),
        last_report_date: stale.last_report_date,
        last_report_type: stale.last_report_type,
        days_overdue:    stale.days_overdue,
        ytd_direction:   ytd >= 0 ? 'up' : 'down',
      },
      suggested_action: 'Run fresh report for '
        + (port?.client_code ?? '') + '-' + (port?.label ?? '')
        + ' before next client touchpoint',
      ranking_score: stale.days_overdue * (nav / 1e6),
    })
  }

  return out
}

// ─── Signal 5: fee_divergence ─────────────────────────────────
//
// Fires when fee outlook trajectory has action implications:
//   amber — status BELOW with excess_pct < -10%   (fee conversation is timely)
//   gold  — status BEATING with projected fee >= ₦2M (positive economics)
//
// "Year-end fee" interpretation: projected_year_end_fee is the engine's
// hold-flat projection. We surface it as a structured fact; the narrator
// frames it appropriately ("on track to crystallise" vs "currently below
// hurdle by N%").

function fireFeeDivergence(input: SignalsInput): Signal[] {
  const out: Signal[] = []
  const PROJECTED_FEE_THRESHOLD = 2_000_000   // ₦2M
  const EXCESS_BELOW_THRESHOLD = -0.10        // -10%

  for (const fo of input.feeOutlook) {
    if (fo.is_internal) continue
    if (fo.is_unanchored) continue
    if (fo.status === 'no_fee') continue

    const isBeatingMaterial =
      fo.status === 'beating' &&
      fo.projected_year_end_fee >= PROJECTED_FEE_THRESHOLD

    const isBelowDeep =
      fo.status === 'below' &&
      fo.excess_pct <= EXCESS_BELOW_THRESHOLD

    if (!isBeatingMaterial && !isBelowDeep) continue

    const severity: SignalSeverity = isBelowDeep ? 'amber' : 'gold'

    const port = input.portfolios.find(p => p.id === fo.portfolio_id)

    out.push({
      id: stableHash('fee_divergence:' + fo.portfolio_id),
      type: 'fee_divergence',
      severity,
      primary_subject: fo.portfolio_id,
      primary_subject_kind: 'portfolio',
      affected_portfolios: [fo.portfolio_id],
      evidence: {
        portfolio_id:    fo.portfolio_id,
        portfolio_name:  fo.portfolio_name,
        client_code:     fo.client_code,
        client_name:     fo.client_name,
        mandate_label:   fo.client_code + '-' + (port?.label ?? ''),
        status:          fo.status,
        starting_nav:    fo.starting_nav_at_anchor ?? null,
        starting_nav_fmt: fo.starting_nav_at_anchor != null
          ? fmtNgnM(fo.starting_nav_at_anchor) : null,
        net_flows:       fo.net_flows ?? 0,
        net_flows_fmt:   fmtNgnM(fo.net_flows ?? 0),
        current_nav:     fo.current_nav,
        current_nav_fmt: fmtNgnM(fo.current_nav),
        target_nav:      fo.target_nav,
        target_nav_fmt:  fmtNgnM(fo.target_nav),
        excess_ngn:      fo.excess_ngn,
        excess_ngn_fmt:  fmtNgnM(fo.excess_ngn),
        excess_pct:      fo.excess_pct,
        excess_pct_fmt:  fmtSignedPct(fo.excess_pct),
        crystallised_ytd_fee:    fo.crystallised_ytd_fee,
        crystallised_ytd_fee_fmt: fmtNgnM(fo.crystallised_ytd_fee),
        projected_year_end_fee:  fo.projected_year_end_fee,
        projected_year_end_fee_fmt: fmtNgnM(fo.projected_year_end_fee),
        days_remaining: fo.days_remaining,
      },
      suggested_action: isBelowDeep
        ? 'Discuss fee trajectory with ' + fo.client_name + ' — currently below hurdle'
        : 'Notify ' + fo.client_name + ' of strong YTD trajectory at next touchpoint',
      ranking_score: Math.abs(fo.excess_ngn),
    })
  }

  return out
}

// ─── Top-level entry ──────────────────────────────────────────

export function computeSignals(input: SignalsInput): Signal[] {
  const all: Signal[] = [
    ...fireConcentrationThread(input),
    ...fireOutsizedReturnLowCash(input),
    ...fireWatchlistOpportunity(input),
    ...fireStaleMaterialMandate(input),
    ...fireFeeDivergence(input),
  ]

  // Sort: red → amber → gold, then ranking_score desc within tier
  const sevOrder: Record<SignalSeverity, number> = { red: 0, amber: 1, gold: 2 }
  all.sort((a, b) => {
    const sevDiff = sevOrder[a.severity] - sevOrder[b.severity]
    if (sevDiff !== 0) return sevDiff
    return b.ranking_score - a.ranking_score
  })

  return all
}
