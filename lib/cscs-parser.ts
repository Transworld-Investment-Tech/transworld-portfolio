/**
 * lib/cscs-parser.ts — v27g
 *
 * CSCS Asset Position parser. Reads the brokerage's canonical position
 * extract (csv or xlsx) and returns normalized rows + session metadata.
 *
 * Expected columns (13, case-insensitive on header match):
 *   HOUSENAME, ACCOUNTNO, ACCOUNTNAME, SYMBOL, ISNCODE, CSCSNO,
 *   SYMBOLNAME, BALANCE, PENDING, AVAILABLEBALANCE, CLOSINGPRICE,
 *   LVALUE, BALANCEDATE
 *
 * Critical conventions:
 *   - Use AVAILABLEBALANCE for canonical units (= BALANCE - PENDING).
 *     Pending units are not yet settled.
 *   - Apply ticker_aliases to SYMBOL (handles MOBIL→MRS, FBNH→FIRSTHOLDCO,
 *     GUARANTY→GTCO, ACCESS→ACCESSCORP, STERLNBANK→STERLINGNG).
 *   - Trim whitespace on every text cell (HOUSENAME has trailing space).
 *   - Parse D-MMM-YYYY ("23-Apr-2026") → ISO YYYY-MM-DD ("2026-04-23").
 *   - CSCS does NOT track operational cash. CASH_NGN reconciliation lives
 *     elsewhere — the variance engine handles that as a separate bucket.
 */

import * as XLSX from 'xlsx'
import { applyAlias } from './ticker-aliases'

export interface CSCSRow {
  symbol: string         // canonical instrument_id (post-alias)
  symbolRaw: string      // pre-alias SYMBOL value
  symbolName: string     // SYMBOLNAME (full name)
  isin: string           // ISNCODE
  units: number          // AVAILABLEBALANCE (= BALANCE - PENDING)
  pending: number
  closingPrice: number
  lvalue: number
}

export interface ParsedCSCS {
  houseName: string
  accountNo: string
  accountName: string
  cscsNumber: string
  balanceDate: string    // ISO YYYY-MM-DD, '' if unparseable
  rows: CSCSRow[]
  errors: string[]
}

const MONTH_MAP: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06',
  jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12',
}

function parseBalanceDate(s: string): string {
  // "23-Apr-2026" → "2026-04-23"
  const m = s.trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/)
  if (!m) return ''
  const day = m[1].padStart(2, '0')
  const month = MONTH_MAP[m[2].toLowerCase()]
  if (!month) return ''
  return `${m[3]}-${month}-${day}`
}

function num(x: any): number {
  if (x === null || x === undefined || x === '') return 0
  const n = typeof x === 'number'
    ? x
    : parseFloat(String(x).replace(/,/g, ''))
  return Number.isFinite(n) ? n : 0
}

function str(x: any): string {
  if (x === null || x === undefined) return ''
  return String(x).trim()
}

export function parseCSCSFile(
  buffer: Buffer,
  filename: string,
  aliasMap: Record<string, string>
): ParsedCSCS {
  const errors: string[] = []
  const empty: ParsedCSCS = {
    houseName: '', accountNo: '', accountName: '', cscsNumber: '',
    balanceDate: '', rows: [], errors,
  }

  let wb: XLSX.WorkBook
  try {
    wb = XLSX.read(buffer, { type: 'buffer' })
  } catch (e: any) {
    errors.push(`Could not read file ${filename}: ${e.message}`)
    return empty
  }

  if (!wb.SheetNames || wb.SheetNames.length === 0) {
    errors.push('No sheets found in file')
    return empty
  }

  const firstSheet = wb.Sheets[wb.SheetNames[0]]
  const aoa: any[][] = XLSX.utils.sheet_to_json(firstSheet, {
    header: 1,
    defval: null,
    raw: false,
  })

  if (aoa.length < 2) {
    errors.push('File has fewer than 2 rows (need header + at least 1 data row)')
    return empty
  }

  // Locate header row — must contain SYMBOL and BALANCE.
  const headerIdx = aoa.findIndex(row =>
    Array.isArray(row) &&
    row.some(c => str(c).toUpperCase() === 'SYMBOL') &&
    row.some(c => str(c).toUpperCase() === 'BALANCE')
  )

  if (headerIdx < 0) {
    errors.push('Header row not found — expected columns SYMBOL and BALANCE')
    return empty
  }

  const header = aoa[headerIdx].map(c => str(c).toUpperCase())
  const colIdx = (name: string) => header.indexOf(name)

  const HOUSENAME        = colIdx('HOUSENAME')
  const ACCOUNTNO        = colIdx('ACCOUNTNO')
  const ACCOUNTNAME      = colIdx('ACCOUNTNAME')
  const SYMBOL           = colIdx('SYMBOL')
  const ISNCODE          = colIdx('ISNCODE')
  const CSCSNO           = colIdx('CSCSNO')
  const SYMBOLNAME       = colIdx('SYMBOLNAME')
  const BALANCE          = colIdx('BALANCE')
  const PENDING          = colIdx('PENDING')
  const AVAILABLEBALANCE = colIdx('AVAILABLEBALANCE')
  const CLOSINGPRICE     = colIdx('CLOSINGPRICE')
  const LVALUE           = colIdx('LVALUE')
  const BALANCEDATE      = colIdx('BALANCEDATE')

  if (SYMBOL < 0 || BALANCE < 0) {
    errors.push('Required columns SYMBOL or BALANCE missing from header')
    return empty
  }

  const rows: CSCSRow[] = []
  let houseName = ''
  let accountNo = ''
  let accountName = ''
  let cscsNumber = ''
  let balanceDate = ''

  for (let i = headerIdx + 1; i < aoa.length; i++) {
    const r = aoa[i]
    if (!Array.isArray(r)) continue
    if (r.every(c => c === null || c === '' || c === undefined)) continue

    const symbolRaw = str(r[SYMBOL])
    if (!symbolRaw) continue

    // Capture session-level metadata from first non-empty row.
    if (!houseName && HOUSENAME >= 0) houseName = str(r[HOUSENAME])
    if (!accountNo && ACCOUNTNO >= 0) accountNo = str(r[ACCOUNTNO])
    if (!accountName && ACCOUNTNAME >= 0) accountName = str(r[ACCOUNTNAME])
    if (!cscsNumber && CSCSNO >= 0) cscsNumber = str(r[CSCSNO])
    if (!balanceDate && BALANCEDATE >= 0) {
      balanceDate = parseBalanceDate(str(r[BALANCEDATE]))
    }

    const balance      = BALANCE          >= 0 ? num(r[BALANCE])          : 0
    const pending      = PENDING          >= 0 ? num(r[PENDING])          : 0
    const avail        = AVAILABLEBALANCE >= 0 ? num(r[AVAILABLEBALANCE]) : (balance - pending)
    const closingPrice = CLOSINGPRICE     >= 0 ? num(r[CLOSINGPRICE])     : 0
    const lvalue       = LVALUE           >= 0 ? num(r[LVALUE])           : 0

    const aliased = applyAlias(symbolRaw, aliasMap)
    const symbol = aliased ?? symbolRaw

    rows.push({
      symbol,
      symbolRaw,
      symbolName: SYMBOLNAME >= 0 ? str(r[SYMBOLNAME]) : '',
      isin:       ISNCODE    >= 0 ? str(r[ISNCODE])    : '',
      units: avail,
      pending,
      closingPrice,
      lvalue,
    })
  }

  if (rows.length === 0) {
    errors.push('No data rows found after header')
  }

  return {
    houseName, accountNo, accountName, cscsNumber, balanceDate, rows, errors,
  }
}
