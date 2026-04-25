import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import * as XLSX from 'xlsx'
import { computeBondYTM, explainFlag, type YieldFlag } from '@/lib/bond-yield'

// v22:  POST /api/admin/import-bond-yields
// v24:  Multi-file via files[]; returns per-file results.
// v25:  Captures Volume / Deals / Value from the brokerage xlsx alongside the
//       Close price. Threaded through ProposalRow into the /accept payload
//       so they can be persisted to yield_history. Drives the VWC tag.
//
// Defensive column-name detection: NGX brokerage files have used several
// column header conventions for these fields. We try a list of candidates
// and pick the first that resolves to a non-null value for that row.

export const maxDuration = 120

interface XlsxRow {
  'Market Day'?: any
  'Security Code'?: any
  'Close'?: any
  [k: string]: any
}

interface BondInstrument {
  instrument_id: string
  name: string
  coupon_pct: number | null
  coupon_freq: number | null
  maturity_date: string | null
  yield_pct: number | null
}

interface ProposalRow {
  instrument_id:     string
  name:              string
  coupon_pct:        number | null
  maturity_date:     string | null
  clean_price:       number
  settlement_date:   string
  ytm_pct:           number
  flag:              YieldFlag | null
  flag_explanation:  string | null
  current_yield:     number | null
  source:            string
  as_of:             string
  confidence:        'high' | 'medium' | 'low'
  notes:             string
  // v25: liquidity capture
  volume:            number | null
  deals:             number | null
  value_ngn:         number | null
}

interface FileResult {
  filename:             string
  settlement_date:      string | null
  rows_in_file:         number
  fi_instruments_in_db: number
  matched:              number
  unmatched_count:      number
  unmatched_ids:        string[]
  results:              ProposalRow[]
  error:                string | null
}

function parseExcelDate(v: any): string | null {
  if (v === null || v === undefined || v === '') return null
  if (v instanceof Date) return v.toISOString().slice(0, 10)
  if (typeof v === 'number' && v > 10000 && v < 100000) {
    const epoch = new Date(Date.UTC(1899, 11, 30))
    const d = new Date(epoch.getTime() + v * 86_400_000)
    return d.toISOString().slice(0, 10)
  }
  const s = String(v).trim()
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/)
  if (m) {
    const months: Record<string, string> = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
    }
    const mm = months[m[2].toLowerCase()]
    if (mm) return `${m[3]}-${mm}-${m[1].padStart(2, '0')}`
  }
  const d = new Date(s)
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10)
  return null
}

function parseClose(v: any): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''))
  return isFinite(n) && n > 0 ? n : null
}

// v25: parse a numeric cell (volume / deals / value) — non-positive returns null,
// since "0 volume" and "no volume reported" are different signals; the brokerage
// file uses 0 to mean "no trades", which we want to preserve as 0 (not null).
function parseNonNegNum(v: any): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''))
  if (!isFinite(n) || n < 0) return null
  return n
}

// Coerce numeric DB columns (which Supabase returns as strings) to numbers.
const numOrNull = (v: any): number | null => {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return isFinite(n) ? n : null
}

// v25: Defensive column-name detection.
// NGX brokerage files have used multiple header conventions for these fields.
// We resolve once per file (header keys are constant within a file).
const VOLUME_CANDIDATES = ['Volume', 'Vol', 'Volume Traded', 'Total Volume', 'Quantity', 'Qty']
const DEALS_CANDIDATES  = ['Deals', 'No. of Deals', 'Trades', 'No. of Trades', 'Number of Deals', 'Total Trades', 'Trade Count']
const VALUE_CANDIDATES  = ['Value', 'Total Value', 'Value Traded', 'Turnover', 'Value (₦)', 'Value (NGN)', 'Total Value Traded']

function resolveColumnName(headerKeys: string[], candidates: string[]): string | null {
  // Exact match first
  const lower = headerKeys.map(k => k.toLowerCase().trim())
  for (const cand of candidates) {
    const i = lower.indexOf(cand.toLowerCase().trim())
    if (i >= 0) return headerKeys[i]
  }
  // Fuzzy: contains
  for (const cand of candidates) {
    const cl = cand.toLowerCase().trim()
    for (let i = 0; i < lower.length; i++) {
      if (lower[i].includes(cl)) return headerKeys[i]
    }
  }
  return null
}

async function processOneFile(
  file: File,
  instruments: BondInstrument[],
): Promise<FileResult> {
  const result: FileResult = {
    filename:             file.name,
    settlement_date:      null,
    rows_in_file:         0,
    fi_instruments_in_db: instruments.length,
    matched:              0,
    unmatched_count:      0,
    unmatched_ids:        [],
    results:              [],
    error:                null,
  }

  if (file.size === 0)              { result.error = 'File is empty'; return result }
  if (file.size > 20 * 1024 * 1024) { result.error = 'File exceeds 20 MB'; return result }

  let rows: XlsxRow[]
  try {
    const bytes = await file.arrayBuffer()
    const wb = XLSX.read(bytes, { type: 'array', cellDates: true })
    const sheet = wb.Sheets[wb.SheetNames[0]]
    if (!sheet) {
      result.error = 'No sheets in workbook'
      return result
    }
    rows = XLSX.utils.sheet_to_json<XlsxRow>(sheet, {
      range: 1,
      defval: null,
      raw: true,
    })
  } catch (e: any) {
    result.error = `xlsx parse failed: ${e?.message || e}`
    return result
  }

  result.rows_in_file = rows.length
  if (rows.length === 0) {
    result.error = 'Workbook contains no data rows'
    return result
  }

  // Settlement date
  const firstDate = parseExcelDate(rows[0]['Market Day'])
  if (!firstDate) {
    result.error = `Could not parse Market Day from first row. Got: ${JSON.stringify(rows[0]['Market Day'])}`
    return result
  }
  result.settlement_date = firstDate

  // All rows must agree on date
  const dateMismatches = rows.filter((r, idx) => {
    if (idx === 0) return false
    const d = parseExcelDate(r['Market Day'])
    return d !== null && d !== firstDate
  })
  if (dateMismatches.length > 0) {
    result.error = `File contains rows with different Market Day values (${dateMismatches.length} rows differ from ${firstDate}). Each file must represent a single date snapshot.`
    return result
  }

  // v25: resolve volume / deals / value column names once per file
  const headerKeys = Object.keys(rows[0])
  const volCol   = resolveColumnName(headerKeys, VOLUME_CANDIDATES)
  const dealsCol = resolveColumnName(headerKeys, DEALS_CANDIDATES)
  const valCol   = resolveColumnName(headerKeys, VALUE_CANDIDATES)

  // Build ticker → { close, volume, deals, value } map
  interface RowSnapshot { close: number; volume: number | null; deals: number | null; value: number | null }
  const snapshotByTicker = new Map<string, RowSnapshot>()

  for (const row of rows) {
    const ticker = typeof row['Security Code'] === 'string' ? row['Security Code'].trim() : null
    if (!ticker) continue
    const price = parseClose(row['Close'])
    if (price === null) continue
    snapshotByTicker.set(ticker, {
      close:  price,
      volume: volCol   ? parseNonNegNum(row[volCol])   : null,
      deals:  dealsCol ? parseNonNegNum(row[dealsCol]) : null,
      value:  valCol   ? parseNonNegNum(row[valCol])   : null,
    })
  }

  if (snapshotByTicker.size === 0) {
    result.error = 'No valid Security Code / Close pairs found'
    return result
  }

  const proposals: ProposalRow[] = []
  const unmatched: string[] = []

  for (const raw of instruments) {
    const snap = snapshotByTicker.get(raw.instrument_id)
    if (!snap) {
      unmatched.push(raw.instrument_id)
      continue
    }
    const couponNum     = numOrNull(raw.coupon_pct)
    const couponFreqNum = numOrNull(raw.coupon_freq)
    const currentYield  = numOrNull(raw.yield_pct)

    if (!raw.maturity_date) {
      proposals.push({
        instrument_id: raw.instrument_id, name: raw.name,
        coupon_pct: couponNum, maturity_date: null,
        clean_price: snap.close, settlement_date: firstDate,
        ytm_pct: NaN, flag: 'solver-failed',
        flag_explanation: 'No maturity date in DB — cannot compute YTM',
        current_yield: currentYield,
        source: `Brokerage file ${firstDate}`, as_of: firstDate,
        confidence: 'low',
        notes: `Price \u20a6${snap.close.toFixed(2)}; no maturity for YTM`,
        volume: snap.volume, deals: snap.deals, value_ngn: snap.value,
      })
      continue
    }

    const couponPct = couponNum ?? 0
    const freq      = couponFreqNum !== null && couponFreqNum > 0 ? couponFreqNum : 2
    const r = computeBondYTM(snap.close, couponPct, raw.maturity_date, firstDate, freq)

    if (!r) {
      proposals.push({
        instrument_id: raw.instrument_id, name: raw.name,
        coupon_pct: couponNum, maturity_date: raw.maturity_date,
        clean_price: snap.close, settlement_date: firstDate,
        ytm_pct: NaN, flag: 'solver-failed',
        flag_explanation: 'Could not compute YTM from inputs',
        current_yield: currentYield,
        source: `Brokerage file ${firstDate}`, as_of: firstDate,
        confidence: 'low',
        notes: `Price \u20a6${snap.close.toFixed(2)}, coupon ${couponPct}%, matures ${raw.maturity_date}`,
        volume: snap.volume, deals: snap.deals, value_ngn: snap.value,
      })
      continue
    }

    let confidence: 'high' | 'medium' | 'low' = 'high'
    if (r.flag) confidence = 'low'
    else if (Math.abs(r.ytm_pct - couponPct) < 0.01 && snap.close === 100) confidence = 'medium'

    proposals.push({
      instrument_id: raw.instrument_id, name: raw.name,
      coupon_pct: couponNum, maturity_date: raw.maturity_date,
      clean_price: snap.close, settlement_date: firstDate,
      ytm_pct: r.ytm_pct, flag: r.flag,
      flag_explanation: r.flag ? explainFlag(r.flag) : null,
      current_yield: currentYield,
      source: `Brokerage file ${firstDate}`, as_of: firstDate,
      confidence,
      notes: `Clean price \u20a6${snap.close.toFixed(2)}, ${couponPct.toFixed(2)}% coupon, matures ${raw.maturity_date}`,
      volume: snap.volume, deals: snap.deals, value_ngn: snap.value,
    })
  }

  proposals.sort((a, b) => {
    const rank = (p: ProposalRow) => p.flag ? 2 : p.confidence === 'high' ? 0 : 1
    return rank(a) - rank(b)
  })

  result.matched         = proposals.length
  result.unmatched_count = unmatched.length
  result.unmatched_ids   = unmatched.slice(0, 20)
  result.results         = proposals
  return result
}

export async function POST(req: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseKey) {
    return NextResponse.json({ error: 'Supabase config missing' }, { status: 500 })
  }

  let formData: FormData
  try {
    formData = await req.formData()
  } catch {
    return NextResponse.json({ error: 'Expected multipart/form-data' }, { status: 400 })
  }

  let files = formData.getAll('files').filter((v): v is File => v instanceof File)
  if (files.length === 0) {
    const single = formData.get('file')
    if (single instanceof File) files = [single]
  }

  if (files.length === 0) {
    return NextResponse.json({ error: 'No file(s) provided. Use field name "files" (plural) or "file" (singular).' }, { status: 400 })
  }

  if (files.length > 80) {
    return NextResponse.json({ error: `Too many files in one request (${files.length}). Maximum is 80.` }, { status: 400 })
  }

  const db = createClient(supabaseUrl, supabaseKey)
  const { data: instruments, error: iErr } = await db
    .from('instruments')
    .select('instrument_id, name, coupon_pct, coupon_freq, maturity_date, yield_pct')
    .eq('sleeve_id', 'fi')
    .eq('approved', true)
    .limit(500)

  if (iErr) return NextResponse.json({ error: iErr.message }, { status: 500 })
  if (!instruments || instruments.length === 0) {
    return NextResponse.json({ error: 'No FI instruments in DB' }, { status: 400 })
  }

  const fileResults: FileResult[] = []
  for (const f of files) {
    const r = await processOneFile(f, instruments as any as BondInstrument[])
    fileResults.push(r)
  }

  return NextResponse.json({ files: fileResults })
}
