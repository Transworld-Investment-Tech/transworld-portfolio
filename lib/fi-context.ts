// v23: Fixed Income context module.
// v25: Extended FIInstrument with mod_duration, convexity, vwc_tag.
// v25c: Filters AI prompt to watchlist members only. Approach (a):
//       a separate fetch on the watchlist table → IN filter on instruments.
//       The full instruments universe (now 160+ rows) lives in the DB and
//       is visible everywhere else (Holdings page, /admin/fixed-income table,
//       yield curve viz). But the AI prompt is scoped to watchlist-curated
//       items only, so it doesn't get to recommend off-watchlist names.
//
// Single source of truth for how FI yield data is fetched, grouped,
// formatted, and flagged for AI prompt injection.

import { computeDurationConvexity } from './bond-yield'

export type FIGroup = 'federal' | 'federal_sukuk' | 'fgs_fgnsb' | 'sub_sovereign' | 'corporate'

export type VWCTag = 'traded' | 'quoted' | 'stale'

export interface FIInstrument {
  instrument_id: string
  name:          string
  coupon_pct:    number | null
  maturity_date: string
  yield_pct:     number
  yield_as_of:   string | null
  sub_type:      string
  group:         FIGroup
  mod_duration:  number | null
  convexity:     number | null
  vwc_tag:       VWCTag
}

// ── Numeric coercion at the DB-to-JS boundary (pitfall #72) ──────────────
function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return isFinite(n) ? n : null
}

// ── Sub-type extraction ──────────────────────────────────────────────────
function parseSubType(notes: string | null, ticker: string, name: string): string {
  if (notes) {
    const m = notes.match(/^\[([^\]]+)\]/)
    if (m) return m[1].trim()
  }
  if (ticker.startsWith('CP'))                             return 'Commercial Paper'
  if (/FGNSB/i.test(name))                                 return 'FGNSB'
  if (/FHSUK|FGSUK/i.test(ticker) || /FHSUK/i.test(name))  return 'Federal Sukuk'
  if (ticker.startsWith('FGS'))                            return 'FGS'
  if (/FGN/i.test(name))                                   return 'Federal'
  if (/LASUK|LAB/i.test(ticker))                           return 'State'
  if (/NSP/i.test(ticker))                                 return 'Impact Board'
  return 'Corporate'
}

function groupOf(subType: string): FIGroup {
  const s = subType.toLowerCase()
  if (s.includes('federal sukuk'))                 return 'federal_sukuk'
  if (s === 'federal')                             return 'federal'
  if (s === 'fgs' || s === 'fgnsb')                return 'fgs_fgnsb'
  if (s.includes('state')    || s.includes('impact') ||
      s.includes('municipal'))                     return 'sub_sovereign'
  return 'corporate'
}

const YIELD_STALE_DAYS = 14

function vwcTagFor(
  yieldAsOf: string | null,
  latestVolume: number | null,
): VWCTag {
  if (!yieldAsOf) return 'stale'
  const asOf = new Date(yieldAsOf + 'T00:00:00Z')
  const now  = new Date()
  const days = (now.getTime() - asOf.getTime()) / 86_400_000
  if (days > YIELD_STALE_DAYS) return 'stale'
  if (latestVolume !== null && latestVolume > 0) return 'traded'
  return 'quoted'
}

// ── Public: fetch + shape ─────────────────────────────────────────────────
export async function fetchFIUniverse(db: any): Promise<FIInstrument[]> {
  // v25c step 1: fetch watchlist-curated FI tickers.
  // The instruments table now holds the full NGX FI universe (160+ rows),
  // but we only let the AI see what the watchlist explicitly endorses.
  const { data: wlData, error: wlErr } = await db
    .from('watchlist')
    .select('ticker')
    .eq('section', 'fixed_income')
    .eq('active', true)
    .limit(500)

  if (wlErr || !wlData) return []
  const watchlistTickers = (wlData as any[])
    .map(w => w.ticker as string)
    .filter(t => !!t)

  if (watchlistTickers.length === 0) return []

  // v25c step 2: pull instruments restricted to that ticker list.
  const { data, error } = await db
    .from('instruments')
    .select('instrument_id, name, coupon_pct, maturity_date, yield_pct, yield_as_of, notes')
    .eq('sleeve_id', 'fi')
    .eq('approved', true)
    .in('instrument_id', watchlistTickers)
    .not('yield_pct',     'is', null)
    .not('maturity_date', 'is', null)
    .order('maturity_date', { ascending: true })

  if (error || !data) return []

  // v25 step 3: pull latest volume per instrument for VWC tagging.
  const { data: histData } = await db
    .from('yield_history')
    .select('instrument_id, yield_as_of, volume')
    .order('yield_as_of', { ascending: false })
    .limit(5000)

  const latestVolumeBy = new Map<string, number | null>()
  for (const r of (histData ?? []) as any[]) {
    if (!latestVolumeBy.has(r.instrument_id)) {
      latestVolumeBy.set(r.instrument_id, toNum(r.volume))
    }
  }

  const today = new Date().toISOString().slice(0, 10)
  const rows: FIInstrument[] = []
  for (const r of data as any[]) {
    const y = toNum(r.yield_pct)
    if (y === null || y <= 0) continue

    const subType = parseSubType(r.notes, r.instrument_id, r.name)
    const couponNum = toNum(r.coupon_pct)

    let modDur: number | null = null
    let convex: number | null = null
    if (couponNum !== null && r.maturity_date) {
      const dc = computeDurationConvexity(y, couponNum, r.maturity_date, today, 2)
      if (dc) { modDur = dc.mod_duration; convex = dc.convexity }
    }

    rows.push({
      instrument_id: r.instrument_id,
      name:          r.name,
      coupon_pct:    couponNum,
      maturity_date: r.maturity_date,
      yield_pct:     y,
      yield_as_of:   r.yield_as_of ?? null,
      sub_type:      subType,
      group:         groupOf(subType),
      mod_duration:  modDur,
      convexity:     convex,
      vwc_tag:       vwcTagFor(r.yield_as_of ?? null, latestVolumeBy.get(r.instrument_id) ?? null),
    })
  }
  return rows
}

// ── Public: format into prompt block ──────────────────────────────────────
function tenorYears(maturity: string): number {
  const today = new Date()
  const mat   = new Date(maturity)
  const days  = (mat.getTime() - today.getTime()) / 86400000
  return days / 365.25
}

function fmtTenor(y: number): string {
  if (y < 0)    return 'matured'
  return y.toFixed(1) + 'y'
}

function isFlagged(yieldPct: number): boolean {
  return yieldPct > 40 || yieldPct < 8
}

const GROUP_LABELS: Record<FIGroup, string> = {
  federal:        'FEDERAL GOVERNMENT BONDS (benchmark sovereigns)',
  federal_sukuk:  'FEDERAL GOVERNMENT SUKUK (Sharia-compliant sovereigns)',
  fgs_fgnsb:      'FGS / FGNSB (retail sovereign savings bonds)',
  sub_sovereign:  'SUB-SOVEREIGN (State / State Sukuk / Impact)',
  corporate:      'CORPORATE & COMMERCIAL PAPER',
}

const GROUP_ORDER: FIGroup[] = [
  'federal',
  'federal_sukuk',
  'fgs_fgnsb',
  'sub_sovereign',
  'corporate',
]

export function buildFIContextBlock(items: FIInstrument[]): string {
  if (!items || items.length === 0) return ''

  const grouped: Record<FIGroup, FIInstrument[]> = {
    federal: [], federal_sukuk: [], fgs_fgnsb: [], sub_sovereign: [], corporate: [],
  }
  for (const it of items) grouped[it.group].push(it)

  const asOfs = items.map(i => i.yield_as_of).filter((x): x is string => !!x).sort()
  const latestAsOf = asOfs[asOfs.length - 1] ?? null
  const asOfDisplay = latestAsOf
    ? new Date(latestAsOf).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : 'unknown'

  const tradedCount = items.filter(i => i.vwc_tag === 'traded').length
  const quotedCount = items.filter(i => i.vwc_tag === 'quoted').length
  const staleCount  = items.filter(i => i.vwc_tag === 'stale').length

  const lines: string[] = [
    '',
    '═══════════════════════════════════════════════════════',
    `FIXED INCOME UNIVERSE (watchlist-curated) — yields as of ${asOfDisplay}`,
    '═══════════════════════════════════════════════════════',
    `${items.length} instruments with current market yields. Tenor = years to maturity from today.`,
    `Liquidity signal: ${tradedCount} traded recently · ${quotedCount} quoted (no recent volume) · ${staleCount} stale.`,
    '',
    'Per-row notation:',
    '  · TRADED  — bond had volume in latest brokerage snapshot (real signal)',
    '  · QUOTED  — yield exists but no recent trades (matrix-priced reference)',
    '  · STALE   — yield older than 14 days (do not anchor recommendations on this)',
    '  · ⚠       — yield > 40% — likely matrix-priced on a thinly traded series',
    '  · MD x.xy — modified duration: % price change per 100bps yield move',
    '',
  ]

  for (const grp of GROUP_ORDER) {
    const rows = grouped[grp]
    if (rows.length === 0) continue

    lines.push(`── ${GROUP_LABELS[grp]} (${rows.length} instruments) ──`)
    for (const r of rows) {
      const tenor = tenorYears(r.maturity_date)
      const flag  = isFlagged(r.yield_pct) ? ' \u26a0' : ''
      const tag   = r.vwc_tag.toUpperCase()
      const md    = r.mod_duration !== null ? ` · MD ${r.mod_duration.toFixed(1)}y` : ''
      lines.push(
        `  ${r.instrument_id} · ${r.name} · tenor ${fmtTenor(tenor)} · yield ${r.yield_pct.toFixed(2)}%${md} · ${tag}${flag}`
      )
    }
    lines.push('')
  }

  lines.push('INSTRUCTIONS FOR AI: When recommending fixed income positions, cite specific')
  lines.push('instruments by ticker and current yield from the universe above. The universe')
  lines.push('is curated — these are the instruments approved for client mandates. Match')
  lines.push("tenor to the scenario's / mandate's time horizon. Do not invent FI instruments")
  lines.push('that are not in this universe.')
  lines.push('')
  lines.push('LIQUIDITY GUIDANCE: Prefer TRADED instruments for any recommendation that')
  lines.push('involves actually entering a position at scale. QUOTED instruments are valid')
  lines.push('reference points but mention liquidity risk if recommending size. STALE')
  lines.push('instruments should not be cited unless explicitly noted as approximate.')
  lines.push('')
  lines.push('DURATION GUIDANCE: For mandates with > 1 year horizon, longer-duration')
  lines.push('positions earn more carry but carry more rate risk. For income-focused')
  lines.push('mandates, weighted-average modified duration of the FI sleeve should align')
  lines.push("with the mandate's drawdown tolerance. Mention duration explicitly when")
  lines.push('recommending bonds with MD > 5 years.')
  lines.push('═══════════════════════════════════════════════════════')

  return lines.join('\n')
}

// ── Public: summarised curve snapshot (reserved for CIO brief integration) ────
export function buildFICurveSnapshot(items: FIInstrument[]): string {
  if (!items || items.length === 0) return ''

  const today = new Date()
  const tenor = (m: string) => (new Date(m).getTime() - today.getTime()) / 86400000 / 365.25

  const federalLike = items.filter(i =>
    (i.group === 'federal' || i.group === 'federal_sukuk' || i.group === 'fgs_fgnsb')
    && i.yield_pct <= 40 && i.yield_pct >= 8
  )
  if (federalLike.length === 0) return ''

  const short  = federalLike.filter(i => tenor(i.maturity_date) <  2)
  const belly  = federalLike.filter(i => { const t = tenor(i.maturity_date); return t >= 2 && t <= 7 })
  const long   = federalLike.filter(i => tenor(i.maturity_date) >  7)

  const median = (arr: FIInstrument[]): number | null => {
    if (arr.length === 0) return null
    const sorted = arr.map(x => x.yield_pct).sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  }

  const s = median(short), b = median(belly), l = median(long)
  const fmt = (v: number | null) => v !== null ? v.toFixed(1) + '%' : 'n/a'

  const asOfs = items.map(i => i.yield_as_of).filter((x): x is string => !!x).sort()
  const latestAsOf = asOfs[asOfs.length - 1] ?? null
  const asOfDisplay = latestAsOf
    ? new Date(latestAsOf).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : 'latest available'

  return `FI curve snapshot (as of ${asOfDisplay}): short end (<2y) median yield ${fmt(s)}; ` +
         `belly (2–7y) median ${fmt(b)}; long end (>7y) median ${fmt(l)}. ` +
         `Based on ${federalLike.length} Federal / FGS / Sukuk lines; ` +
         `extreme-yield outliers excluded.`
}
