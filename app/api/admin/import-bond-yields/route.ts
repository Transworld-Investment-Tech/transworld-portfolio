import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import * as XLSX from 'xlsx'
import { computeBondYTM, explainFlag, type YieldFlag } from '@/lib/bond-yield'

// v22: POST /api/admin/import-bond-yields
//
// Accepts a single Brokerage PrintDownload Price List xlsx file. Parses its
// rows, filters to instruments where sleeve_id='fi' in our DB, and computes
// YTM for each using clean price + coupon + maturity.
//
// Returns proposed yields for user review. Nothing writes to the DB from this
// route — the page handles the review + accept + save flow via the existing
// Supabase anon client (same pattern as scenarios and the v21z-hotfix-1 paste
// flow).
//
// Expected xlsx shape (confirmed from March 2026 brokerage file):
//   Row 0: title "Brokerage - Print/Download Price Lists"
//   Row 1: headers [Market Day, Security Code, Description, Prev. Close, Open,
//                   High, Low, Close, Change, ChangeP, Volume, Value, Deals]
//   Rows 2+: data
//
// Settlement date comes from the "Market Day" column of the first data row
// (all rows share the same date since each file is a single-date snapshot).

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
  instrument_id: string
  name: string
  coupon_pct: number | null
  maturity_date: string | null
  clean_price: number
  settlement_date: string
  ytm_pct: number
  flag: YieldFlag | null
  flag_explanation: string | null
  current_yield: number | null
  source: string
  as_of: string
  confidence: 'high' | 'medium' | 'low'
  notes: string
}

function parseExcelDate(v: any): string | null {
  if (v === null || v === undefined || v === '') return null

  // Excel stored as Date
  if (v instanceof Date) {
    return v.toISOString().slice(0, 10)
  }

  // Excel serial number
  if (typeof v === 'number' && v > 10000 && v < 100000) {
    const epoch = new Date(Date.UTC(1899, 11, 30))
    const d = new Date(epoch.getTime() + v * 86_400_000)
    return d.toISOString().slice(0, 10)
  }

  // String — try common formats
  const s = String(v).trim()
  // DD-MMM-YYYY (e.g. "31-Mar-2026")
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/)
  if (m) {
    const months: Record<string, string> = {
      jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
      jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
    }
    const mm = months[m[2].toLowerCase()]
    if (mm) return `${m[3]}-${mm}-${m[1].padStart(2, '0')}`
  }

  // ISO-ish
  const d = new Date(s)
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10)

  return null
}

function parseClose(v: any): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/,/g, ''))
  return isFinite(n) && n > 0 ? n : null
}

export async function POST(req: NextRequest) {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseKey) {
    return NextResponse.json({ error: 'Supabase config missing' }, { status: 500 })
  }

  // 1. Multipart form
  let formData: FormData
  try {
    formData = await req.formData()
  } catch {
    return NextResponse.json({ error: 'Expected multipart/form-data' }, { status: 400 })
  }

  const file = formData.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'Missing file field' }, { status: 400 })
  }
  if (file.size === 0) {
    return NextResponse.json({ error: 'Uploaded file is empty' }, { status: 400 })
  }
  if (file.size > 20 * 1024 * 1024) {
    return NextResponse.json({ error: 'File exceeds 20 MB limit' }, { status: 400 })
  }

  // 2. Parse xlsx
  let rows: XlsxRow[]
  try {
    const bytes = await file.arrayBuffer()
    const wb = XLSX.read(bytes, { type: 'array', cellDates: true })
    const sheet = wb.Sheets[wb.SheetNames[0]]
    if (!sheet) {
      return NextResponse.json({ error: 'No sheets in workbook' }, { status: 400 })
    }
    // Brokerage format has title in row 1 — use row 2 as headers
    rows = XLSX.utils.sheet_to_json<XlsxRow>(sheet, {
      range: 1, // skip row 0 (the title)
      defval: null,
      raw: true,
    })
  } catch (e: any) {
    return NextResponse.json({ error: `xlsx parse failed: ${e?.message || e}` }, { status: 400 })
  }

  if (rows.length === 0) {
    return NextResponse.json({ error: 'Workbook contains no data rows' }, { status: 400 })
  }

  // 3. Extract settlement date from the first data row
  const firstDate = parseExcelDate(rows[0]['Market Day'])
  if (!firstDate) {
    return NextResponse.json({
      error: `Could not parse Market Day from first row. Got: ${JSON.stringify(rows[0]['Market Day'])}. Expected a date in column "Market Day".`,
    }, { status: 400 })
  }

  // 4. Build a ticker → close-price map from the paste
  const priceByTicker = new Map<string, number>()
  for (const row of rows) {
    const ticker = typeof row['Security Code'] === 'string'
      ? row['Security Code'].trim()
      : null
    if (!ticker) continue
    const price = parseClose(row['Close'])
    if (price === null) continue
    priceByTicker.set(ticker, price)
  }

  if (priceByTicker.size === 0) {
    return NextResponse.json({ error: 'No valid Security Code / Close pairs found in file' }, { status: 400 })
  }

  // 5. Fetch FI instruments from DB
  const db = createClient(supabaseUrl, supabaseKey)
  const { data: instruments, error: iErr } = await db
    .from('instruments')
    .select('instrument_id, name, coupon_pct, coupon_freq, maturity_date, yield_pct')
    .eq('sleeve_id', 'fi')
    .eq('approved', true)
    .limit(500)

  if (iErr) return NextResponse.json({ error: iErr.message }, { status: 500 })
  if (!instruments || instruments.length === 0) {
    return NextResponse.json({ error: 'No fixed income instruments in DB — run the seed SQL first' }, { status: 400 })
  }

  // 6. For each FI instrument that has a price in the file, compute YTM
  const proposals: ProposalRow[] = []
  const unmatched: string[] = []

  for (const raw of instruments as any as BondInstrument[]) {
    const price = priceByTicker.get(raw.instrument_id)
    if (price === undefined) {
      unmatched.push(raw.instrument_id)
      continue
    }
    if (!raw.maturity_date) {
      // Can't compute YTM without maturity. Still report so user sees gap.
      proposals.push({
        instrument_id: raw.instrument_id,
        name: raw.name,
        coupon_pct: raw.coupon_pct,
        maturity_date: null,
        clean_price: price,
        settlement_date: firstDate,
        ytm_pct: NaN,
        flag: 'solver-failed',
        flag_explanation: 'No maturity date recorded in DB — cannot compute YTM',
        current_yield: raw.yield_pct,
        source: `Brokerage file ${firstDate}`,
        as_of: firstDate,
        confidence: 'low',
        notes: `Price ₦${price.toFixed(2)}; no maturity date for YTM calc`,
      })
      continue
    }

    const couponPct = raw.coupon_pct !== null ? Number(raw.coupon_pct) : 0
    const freq = raw.coupon_freq !== null && Number(raw.coupon_freq) > 0
      ? Number(raw.coupon_freq)
      : 2
    const result = computeBondYTM(price, couponPct, raw.maturity_date, firstDate, freq)

    if (!result) {
      proposals.push({
        instrument_id: raw.instrument_id,
        name: raw.name,
        coupon_pct: raw.coupon_pct,
        maturity_date: raw.maturity_date,
        clean_price: price,
        settlement_date: firstDate,
        ytm_pct: NaN,
        flag: 'solver-failed',
        flag_explanation: 'Could not compute YTM from inputs',
        current_yield: raw.yield_pct,
        source: `Brokerage file ${firstDate}`,
        as_of: firstDate,
        confidence: 'low',
        notes: `Price ₦${price.toFixed(2)}, coupon ${couponPct}%, matures ${raw.maturity_date}`,
      })
      continue
    }

    let confidence: 'high' | 'medium' | 'low' = 'high'
    if (result.flag) confidence = 'low'
    else if (Math.abs(result.ytm_pct - couponPct) < 0.01 && price === 100) {
      // At par — technically correct, but not a real market signal
      confidence = 'medium'
    }

    proposals.push({
      instrument_id: raw.instrument_id,
      name: raw.name,
      coupon_pct: raw.coupon_pct,
      maturity_date: raw.maturity_date,
      clean_price: price,
      settlement_date: firstDate,
      ytm_pct: result.ytm_pct,
      flag: result.flag,
      flag_explanation: result.flag ? explainFlag(result.flag) : null,
      current_yield: raw.yield_pct,
      source: `Brokerage file ${firstDate}`,
      as_of: firstDate,
      confidence,
      notes: `Clean price ₦${price.toFixed(2)}, ${couponPct.toFixed(2)}% coupon, matures ${raw.maturity_date}`,
    })
  }

  // Sort: clean matches first (no flag, high conf), then flagged, then unmatched
  proposals.sort((a, b) => {
    const rank = (p: ProposalRow) => p.flag ? 2 : p.confidence === 'high' ? 0 : 1
    return rank(a) - rank(b)
  })

  return NextResponse.json({
    settlement_date: firstDate,
    rows_in_file: rows.length,
    fi_instruments_in_db: instruments.length,
    matched: proposals.length,
    unmatched_count: unmatched.length,
    unmatched_ids: unmatched.slice(0, 20), // first 20 for UI display
    results: proposals,
  })
}
