import { NextRequest, NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/supabase'
import { getAliasMap, applyAlias } from '@/lib/ticker-aliases'
import * as XLSX from 'xlsx'

// v21o: POST /api/admin/import-prices
// Accepts multiple .xlsx files (Brokerage PrintDownload Price List format).
// Parses each file, extracts (date, ticker, close), applies the alias map,
// and upserts into market_prices with source='historical-import'.
// ignoreDuplicates=true so existing NGX live prices are never overwritten.
//
// Expected file structure (row 0 = title, row 1 = headers, row 2+ = data):
//   Col 0: Market Day  "31-Jan-2022"
//   Col 1: Security Code  "GTCO"
//   Col 7: Close  26.90

export const runtime = 'nodejs'
export const maxDuration = 60

const MONTHS: Record<string, string> = {
  Jan:'01', Feb:'02', Mar:'03', Apr:'04', May:'05', Jun:'06',
  Jul:'07', Aug:'08', Sep:'09', Oct:'10', Nov:'11', Dec:'12',
}

function parseNGXDate(s: string): string | null {
  const m = String(s).match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/)
  if (!m) return null
  const mm = MONTHS[m[2]]
  if (!mm) return null
  return `${m[3]}-${mm}-${m[1].padStart(2, '0')}`
}

interface PriceRow { date: string; ticker: string; price: number }

function parseFile(buf: Buffer): PriceRow[] {
  const wb  = XLSX.read(buf, { type: 'buffer' })
  const ws  = wb.Sheets[wb.SheetNames[0]]
  const raw = XLSX.utils.sheet_to_json<any[]>(ws, { header: 1, raw: true, defval: null })
  const rows: PriceRow[] = []

  for (let i = 2; i < raw.length; i++) {
    const row = raw[i] as any[]
    if (!row || row.length < 8) continue
    const dateRaw = row[0]
    const ticker  = row[1]
    const close   = row[7]
    if (!dateRaw || !ticker) continue

    const date  = parseNGXDate(String(dateRaw).trim())
    if (!date) continue

    const price = Number(close)
    if (!isFinite(price) || price <= 0) continue

    rows.push({ date, ticker: String(ticker).trim().toUpperCase(), price })
  }
  return rows
}

export async function POST(req: NextRequest) {
  try {
    const form  = await req.formData()
    const files = form.getAll('files') as File[]
    if (!files.length) {
      return NextResponse.json({ error: 'No files provided' }, { status: 400 })
    }

    const db = supabaseAdmin()

    // Load instruments master + alias map in parallel
    const [instrRes, aliasMap] = await Promise.all([
      db.from('instruments').select('instrument_id'),
      getAliasMap(db),
    ])

    const known          = new Set((instrRes.data ?? []).map((r: any) => r.instrument_id as string))
    const unknownSet     = new Set<string>()
    const allRows: any[] = []
    let filesProcessed   = 0

    for (const file of files) {
      const buf    = Buffer.from(await file.arrayBuffer())
      const parsed = parseFile(buf)

      for (const row of parsed) {
        const canonical = applyAlias(row.ticker, aliasMap) ?? row.ticker
        if (!known.has(canonical)) {
          unknownSet.add(row.ticker)   // log original ticker for user review
          continue
        }
        allRows.push({
          instrument_id: canonical,
          price_date:    row.date,
          price:         row.price,
          day_change:    null,
          source:        'historical-import',
        })
      }
      filesProcessed++
    }

    // Deduplicate within this batch (keep first per instrument × date)
    const seen   = new Set<string>()
    const unique = allRows.filter(r => {
      const k = `${r.instrument_id}|${r.price_date}`
      if (seen.has(k)) return false
      seen.add(k)
      return true
    })

    // Upsert in chunks of 500 rows
    // ignoreDuplicates=true: preserves existing NGX live data if already present
    let rowsImported = 0
    const upsertErrors: string[] = []
    for (let i = 0; i < unique.length; i += 500) {
      const chunk = unique.slice(i, i + 500)
      const { error } = await (db.from('market_prices') as any)
        .upsert(chunk, { onConflict: 'instrument_id,price_date', ignoreDuplicates: true })
      if (error) {
        upsertErrors.push(error.message)
      } else {
        rowsImported += chunk.length
      }
    }

    // Distinct dates imported (for the NAV reconstruction step)
    const datesImported = Array.from(new Set(unique.map(r => r.price_date))).sort()

    return NextResponse.json({
      ok:             upsertErrors.length === 0,
      filesProcessed,
      rowsImported,
      rowsSkipped:    allRows.length - unique.length,
      unknownTickers: Array.from(unknownSet).sort(),
      datesImported,
      upsertErrors:   upsertErrors.slice(0, 5),
    })
  } catch (err: any) {
    console.error('[import-prices]', err)
    return NextResponse.json({ error: err.message }, { status: 500 })
  }
}
