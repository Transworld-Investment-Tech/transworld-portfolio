// v23: Fixed Income context module.
//
// Shared builder for the "Fixed Income Universe" block injected into
// scenario, per-portfolio, and consolidated AI prompts. Single source of
// truth for how FI yield data is fetched, grouped, formatted, and flagged.
//
// Design decisions:
//   - Filter: sleeve_id='fi' AND approved=true AND yield_pct IS NOT NULL
//             AND yield_pct > 0 AND maturity_date IS NOT NULL.
//             Excludes legacy FGN_10/FGN_5_7 buckets and at-par bonds.
//   - Groups: Federal / Federal Sukuk / FGS+FGNSB / Sub-Sovereign /
//             Corporate+CP. Parsed from notes "[SubType]" tag with
//             ticker-prefix fallback.
//   - Flag: yield > 40% or yield < 8%. Nigeria is a high-rate environment
//           so legitimately high yields are plausible, but > 40% is very
//           likely matrix-priced on an illiquid series — the AI should
//           treat such recommendations with a liquidity caveat.
//   - Numeric coercion at fetch boundary (pitfall #72). Supabase returns
//     numeric columns as strings; parseFloat at the seam.

export type FIGroup = 'federal' | 'federal_sukuk' | 'fgs_fgnsb' | 'sub_sovereign' | 'corporate'

export interface FIInstrument {
  instrument_id: string
  name:          string
  coupon_pct:    number | null
  maturity_date: string           // ISO date, never null (filtered upstream)
  yield_pct:     number
  yield_as_of:   string | null    // ISO date
  sub_type:      string           // parsed display label
  group:         FIGroup
}

// ── Numeric coercion at the DB-to-JS boundary (pitfall #72) ──────────────
function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return isFinite(n) ? n : null
}

// ── Sub-type extraction ──────────────────────────────────────────────────
// Primary source: notes field starts with "[SubType] rationale".
// Fallback: infer from ticker prefix or name.
function parseSubType(notes: string | null, ticker: string, name: string): string {
  if (notes) {
    const m = notes.match(/^\[([^\]]+)\]/)
    if (m) return m[1].trim()
  }
  // Fallback heuristics based on ticker and name patterns
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
  // Corporate bucket includes Corporate, Commercial Paper, Guaranteed Corporate
  return 'corporate'
}

// ── Public: fetch + shape ─────────────────────────────────────────────────
export async function fetchFIUniverse(db: any): Promise<FIInstrument[]> {
  const { data, error } = await db
    .from('instruments')
    .select('instrument_id, name, coupon_pct, maturity_date, yield_pct, yield_as_of, notes')
    .eq('sleeve_id', 'fi')
    .eq('approved', true)
    .not('yield_pct',     'is', null)
    .not('maturity_date', 'is', null)
    .order('maturity_date', { ascending: true })

  if (error || !data) return []

  const rows: FIInstrument[] = []
  for (const r of data as any[]) {
    const y = toNum(r.yield_pct)
    if (y === null || y <= 0) continue

    const subType = parseSubType(r.notes, r.instrument_id, r.name)
    rows.push({
      instrument_id: r.instrument_id,
      name:          r.name,
      coupon_pct:    toNum(r.coupon_pct),
      maturity_date: r.maturity_date,
      yield_pct:     y,
      yield_as_of:   r.yield_as_of ?? null,
      sub_type:      subType,
      group:         groupOf(subType),
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
  // Nigeria is a high-rate environment. Wide band to allow legitimately
  // high yields on illiquid short-dated issues. Only flag truly extreme.
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

  // Most-recent yield_as_of becomes the header date
  const asOfs = items.map(i => i.yield_as_of).filter((x): x is string => !!x).sort()
  const latestAsOf = asOfs[asOfs.length - 1] ?? null
  const asOfDisplay = latestAsOf
    ? new Date(latestAsOf).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })
    : 'unknown'

  const lines: string[] = [
    '',
    '═══════════════════════════════════════════════════════',
    `FIXED INCOME UNIVERSE — yields as of ${asOfDisplay}`,
    '═══════════════════════════════════════════════════════',
    `${items.length} instruments with current market yields. Tenor = years to maturity from today.`,
    '⚠ = yield > 40% — likely matrix-priced on thinly traded series. Nigeria is a high-rate',
    'environment so elevated yields can be legitimate, but ⚠ lines warrant a liquidity caveat',
    'if recommended.',
    '',
  ]

  for (const grp of GROUP_ORDER) {
    const rows = grouped[grp]
    if (rows.length === 0) continue

    lines.push(`── ${GROUP_LABELS[grp]} (${rows.length} instruments) ──`)
    for (const r of rows) {
      const tenor = tenorYears(r.maturity_date)
      const flag  = isFlagged(r.yield_pct) ? ' \u26a0' : ''
      lines.push(
        `  ${r.instrument_id} · ${r.name} · tenor ${fmtTenor(tenor)} · yield ${r.yield_pct.toFixed(2)}%${flag}`
      )
    }
    lines.push('')
  }

  lines.push('INSTRUCTIONS FOR AI: When recommending fixed income positions, cite specific')
  lines.push('instruments by ticker and current yield from the universe above. Match tenor to')
  lines.push("the scenario's / mandate's time horizon. Do not invent FI instruments that are")
  lines.push('not in this universe. When a flagged (\u26a0) line is the best match, mention the')
  lines.push('liquidity caveat explicitly.')
  lines.push('═══════════════════════════════════════════════════════')

  return lines.join('\n')
}

// ── Public: summarised curve snapshot (reserved for v24 CIO brief) ────────
// Not used in v23. CIO brief stays untouched this release.
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
