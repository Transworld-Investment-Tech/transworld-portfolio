import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import * as XLSX from 'xlsx'
import { computeBondYTM, explainFlag, type YieldFlag } from '@/lib/bond-yield'

// v22: POST /api/admin/import-bond-yields
// v24: now accepts MULTIPLE files via `files[]` (FormData), returns per-file
//      results. The actual DB write moves to /accept (sibling route) so the
//      bulk flow can write to yield_history with service-role permissions.
//
// Backward-compatible API change:
//   - Reads `files[]` first (preferred). Falls back to single `file` field
//     for any caller that hasn't migrated.
//   - Always returns the new shape `{ files: [...] }`.
//
// Each file gets its own settlement_date (parsed from Column A row 1+) and
// its own results array. Errors are per-file — one bad file doesn't fail the
// whole batch.

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

  if (v instanceof Date) {
    return v.toISOString().slice(0, 10)
  }

  // Excel serial number
  if (typeof v === 'number' && v > 10000 && v < 100000) {
    const epoch = new Date(Date.UTC(1899, 11, 30))
    const d = new Date(epoch.getTime() + v * 86_400_000)
    return d.toISOString().slice(0, 10)
  }

  const s = String(v).trim()
  // DD-MMM-YYYY (e.g. "31-Mar-2026") — the brokerage file format
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

// Coerce numeric DB columns (which Supabase returns as strings) to numbers.
const numOrNull = (v: any): number | null => {
  if (v === null || v === undefined) return null
  const n = typeof v === 'number' ? v : parseFloat(String(v))
  return isFinite(n) ? n : null
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

  if (file.size === 0) {
    result.error = 'File is empty'
    return result
  }
  if (file.size > 20 * 1024 * 1024) {
    result.error = 'File exceeds 20 MB'
    return result
  }

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
      range: 1,        // skip row 0 (the title)
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

  // Settlement date from first row's Market Day
  const firstDate = parseExcelDate(rows[0]['Market Day'])
  if (!firstDate) {
    result.error = `Could not parse Market Day from first row. Got: ${JSON.stringify(rows[0]['Market Day'])}`
    return result
  }
  result.settlement_date = firstDate

  // Sanity: verify all rows agree on the date (within a single file)
  const dateMismatches = rows.filter((r, idx) => {
    if (idx === 0) return false
    const d = parseExcelDate(r['Market Day'])
    return d !== null && d !== firstDate
  })
  if (dateMismatches.length > 0) {
    result.error = `File contains rows with different Market Day values (${dateMismatches.length} rows differ from ${firstDate}). Each file must represent a single date snapshot.`
    return result
  }

  // Build ticker → close-price map
  const priceByTicker = new Map<string, number>()
  for (const row of rows) {
    const ticker = typeof row['Security Code'] === 'string' ? row['Security Code'].trim() : null
    if (!ticker) continue
    const price = parseClose(row['Close'])
    if (price === null) continue
    priceByTicker.set(ticker, price)
  }

  if (priceByTicker.size === 0) {
    result.error = 'No valid Security Code / Close pairs found'
    return result
  }

  // Match against FI instruments and compute YTM
  const proposals: ProposalRow[] = []
  const unmatched: string[] = []

  for (const raw of instruments) {
    const price = priceByTicker.get(raw.instrument_id)
    if (price === undefined) {
      unmatched.push(raw.instrument_id)
      continue
    }
    const couponNum     = numOrNull(raw.coupon_pct)
    const couponFreqNum = numOrNull(raw.coupon_freq)
    const currentYield  = numOrNull(raw.yield_pct)

    if (!raw.maturity_date) {
      proposals.push({
        instrument_id:     raw.instrument_id,
        name:              raw.name,
        coupon_pct:        couponNum,
        maturity_date:     null,
        clean_price:       price,
        settlement_date:   firstDate,
        ytm_pct:           NaN,
        flag:              'solver-failed',
        flag_explanation:  'No maturity date in DB — cannot compute YTM',
        current_yield:     currentYield,
        source:            `Brokerage file ${firstDate}`,
        as_of:             firstDate,
        confidence:        'low',
        notes:             `Price \u20a6${price.toFixed(2)}; no maturity for YTM`,
      })
      continue
    }

    const couponPct = couponNum ?? 0
    const freq      = couponFreqNum !== null && couponFreqNum > 0 ? couponFreqNum : 2
    const r = computeBondYTM(price, couponPct, raw.maturity_date, firstDate, freq)

    if (!r) {
      proposals.push({
        instrument_id:     raw.instrument_id,
        name:              raw.name,
        coupon_pct:        couponNum,
        maturity_date:     raw.maturity_date,
        clean_price:       price,
        settlement_date:   firstDate,
        ytm_pct:           NaN,
        flag:              'solver-failed',
        flag_explanation:  'Could not compute YTM from inputs',
        current_yield:     currentYield,
        source:            `Brokerage file ${firstDate}`,
        as_of:             firstDate,
        confidence:        'low',
        notes:             `Price \u20a6${price.toFixed(2)}, coupon ${couponPct}%, matures ${raw.maturity_date}`,
      })
      continue
    }

    let confidence: 'high' | 'medium' | 'low' = 'high'
    if (r.flag) confidence = 'low'
    else if (Math.abs(r.ytm_pct - couponPct) < 0.01 && price === 100) confidence = 'medium'

    proposals.push({
      instrument_id:     raw.instrument_id,
      name:              raw.name,
      coupon_pct:        couponNum,
      maturity_date:     raw.maturity_date,
      clean_price:       price,
      settlement_date:   firstDate,
      ytm_pct:           r.ytm_pct,
      flag:              r.flag,
      flag_explanation:  r.flag ? explainFlag(r.flag) : null,
      current_yield:     currentYield,
      source:            `Brokerage file ${firstDate}`,
      as_of:             firstDate,
      confidence,
      notes:             `Clean price \u20a6${price.toFixed(2)}, ${couponPct.toFixed(2)}% coupon, matures ${raw.maturity_date}`,
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

  // Prefer plural `files[]`; fall back to singular `file` for any pre-v24 caller.
  let files = formData.getAll('files').filter((v): v is File => v instanceof File)
  if (files.length === 0) {
    const single = formData.get('file')
    if (single instanceof File) files = [single]
  }

  if (files.length === 0) {
    return NextResponse.json({ error: 'No file(s) provided. Use field name "files" (plural) or "file" (singular).' }, { status: 400 })
  }

  // Cap on number of files per request to keep the function within timeout.
  // 50 monthly files * ~1s each = ~50s. We allow up to 80.
  if (files.length > 80) {
    return NextResponse.json({ error: `Too many files in one request (${files.length}). Maximum is 80.` }, { status: 400 })
  }

  // Fetch FI instruments once and reuse across all files
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

  // Process each file in series. Each file is small (~250KB) and YTM solving
  // is fast (~50ms total per file), so series is fine and avoids any memory
  // pressure from holding 50 xlsx ArrayBuffers concurrently.
  const fileResults: FileResult[] = []
  for (const f of files) {
    const r = await processOneFile(f, instruments as any as BondInstrument[])
    fileResults.push(r)
  }

  return NextResponse.json({ files: fileResults })
}
