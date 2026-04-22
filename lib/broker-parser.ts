/**
 * lib/broker-parser.ts — v21a
 *
 * Parses Transworld Investment and Securities broker PDFs:
 *   - Contract Notes (trade-level detail with fee breakdown)
 *   - Statement of Account (cash ledger with running balance)
 *
 * Reconciles the two by (date, ticker, action, price) — one CN row can
 * pair with N statement rows (partial-fill splits). Runs a running-balance
 * audit on each statement so the parse proves itself against the
 * broker's printed closing balance.
 *
 * Pure functions. No I/O beyond accepting PDF Buffers. No DB writes.
 * Safe to run in parallel. Callable from any API route.
 */

// ───────────────────────────────────────────────────────────
// Types — exported for the debug endpoint and future v21b/c.
// ───────────────────────────────────────────────────────────

export interface ContractNoteRow {
  trade_date: string         // ISO YYYY-MM-DD
  security_code: string      // as broker printed, e.g. "ACCESSCORP"
  action: 'BUY' | 'SELL'
  quantity: number
  price: number
  consideration: number
  fee_commission: number     // Brokerage
  fee_vat: number            // VAT on Brokerage
  fee_exchange: number
  fee_clearing: number
  fee_sec: number
  fee_contract_stamp: number
  fee_sms: number
  total: number              // net amount after fees
  settlement_date: string
  raw_line?: string
}

export interface ContractNotesTotals {
  consideration: number
  brokerage: number
  vat: number
  exchange: number
  clearing: number
  sec: number
  contract_stamp: number
  sms: number
  total: number
}

export interface ParsedContractNotes {
  account_holder: string
  cscs_number: string
  address?: string
  date_range?: { from: string; to: string }
  rows: ContractNoteRow[]
  printed_totals?: ContractNotesTotals
  computed_totals: ContractNotesTotals
  totals_match: boolean
  parse_errors: string[]
  raw_lines?: string[]
}

export type StatementRowKind =
  | 'balance_brought_forward'
  | 'trade_buy'
  | 'trade_sell'
  | 'deposit'
  | 'withdrawal'
  | 'management_fee'
  | 'bank_charge'
  | 'refund'
  | 'unknown'

export interface StatementRow {
  trans_date: string
  post_date: string
  narration: string
  debit: number              // 0 if no debit
  credit: number             // 0 if no credit
  balance: number
  kind: StatementRowKind
  cn_number?: string         // for trade_buy / trade_sell
  ticker?: string
  quantity?: number
  price?: number
  raw_line?: string
}

export interface ParsedStatement {
  account_holder: string
  cscs_number: string
  account_number?: string
  period: { from: string; to: string }
  opening_balance: number
  total_credit: number
  total_debit: number
  closing_balance: number
  rows: StatementRow[]
  audit: {
    computed_closing: number
    printed_closing: number
    diff: number
    passes: boolean
  }
  parse_errors: string[]
  raw_lines?: string[]
}

export interface TradeMatch {
  cn_row_index: number
  statement_refs: Array<{ statement_index: number; row_index: number }>
  kind: 'exact' | 'split' | 'partial_mismatch' | 'unmatched'
  note?: string
}

export interface CashEvent {
  statement_index: number
  row_index: number
  proposed_action: 'TRANSFER_IN' | 'TRANSFER_OUT' | 'FEE'
  amount: number
  date: string
  narration: string
  kind: StatementRowKind
}

export interface Reconciliation {
  contract_notes: ParsedContractNotes
  statements: ParsedStatement[]
  trade_matches: TradeMatch[]
  orphan_statement_trades: Array<{
    statement_index: number
    row_index: number
    reason: string
  }>
  cash_events: CashEvent[]
  summary: {
    cn_row_count: number
    statement_trade_count: number
    matched_exact: number
    matched_split: number
    partial_mismatch: number
    unmatched_cn: number
    orphan_statement: number
    cash_event_count: number
    all_statements_balanced: boolean
  }
}

export interface ParseOptions {
  includeRawLines?: boolean
}

// ───────────────────────────────────────────────────────────
// PDF text extraction — line-oriented, y-coordinate grouped.
// ───────────────────────────────────────────────────────────

const Y_TOLERANCE = 2

async function extractLines(buffer: Buffer): Promise<string[]> {
  // Use unpdf instead of pdfjs-dist directly. unpdf ships a
  // serverless-friendly pdfjs build with DOMMatrix / Path2D / other
  // browser globals pre-polyfilled. Using pdfjs-dist legacy build
  // directly on Vercel's Node runtime threw "DOMMatrix is not
  // defined" in v21a — this swap is the fix.
  const { getDocumentProxy } = await import('unpdf')
  const pdf = await getDocumentProxy(new Uint8Array(buffer))
  const allLines: string[] = []

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p)
    const content = await page.getTextContent()

    type Item = { str: string; x: number; y: number }
    const items: Item[] = (content.items as any[])
      .filter((it) => it && typeof it.str === 'string' && it.str.trim().length > 0)
      .map((it) => ({
        str: it.str,
        x: it.transform[4] as number,
        y: it.transform[5] as number,
      }))

    // Sort by y desc (PDF coords are bottom-up), then x asc.
    items.sort((a, b) => b.y - a.y || a.x - b.x)

    let currentY: number | null = null
    let current: Item[] = []

    const flush = () => {
      if (current.length === 0) return
      current.sort((a, b) => a.x - b.x)
      const line = current
        .map((c) => c.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
      if (line) allLines.push(line)
      current = []
    }

    for (const it of items) {
      if (currentY === null || Math.abs(it.y - currentY) > Y_TOLERANCE) {
        flush()
        currentY = it.y
      }
      current.push(it)
    }
    flush()
  }

  return allLines
}

// ───────────────────────────────────────────────────────────
// Date + number helpers
// ───────────────────────────────────────────────────────────

const MONTHS: Record<string, string> = {
  jan: '01', feb: '02', mar: '03', apr: '04',
  may: '05', jun: '06', jul: '07', aug: '08',
  sep: '09', oct: '10', nov: '11', dec: '12',
}

function toIsoFromSlashed(s: string): string | null {
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (!m) return null
  const [, d, mo, y] = m
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`
}

function toIsoFromDashed(s: string): string | null {
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/)
  if (!m) return null
  const [, d, mon, y] = m
  const mo = MONTHS[mon.toLowerCase()]
  if (!mo) return null
  return `${y}-${mo}-${d.padStart(2, '0')}`
}

function parseAmt(s: string): number {
  if (!s) return 0
  let clean = s.replace(/,/g, '')
  // ".00" → "0.00"
  if (clean.startsWith('.')) clean = '0' + clean
  else if (clean.startsWith('-.')) clean = '-0' + clean.slice(1)
  const n = parseFloat(clean)
  return Number.isFinite(n) ? n : 0
}

function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0)
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

// Amounts MUST have a decimal point — this is what keeps us from
// mistaking NIBSS reference numbers ("0000113") for ledger amounts.
const AMOUNT_RE = /^-?[\d,]*\.\d+$/
const DASH_DATE_RE = /^\d{1,2}-[A-Za-z]{3}-\d{4}$/
const SLASH_DATE_RE = /^\d{1,2}\/\d{1,2}\/\d{4}$/

// ───────────────────────────────────────────────────────────
// Contract Notes parser
// ───────────────────────────────────────────────────────────

export async function parseContractNotesPdf(
  buffer: Buffer,
  opts: ParseOptions = {}
): Promise<ParsedContractNotes> {
  const lines = await extractLines(buffer)
  const errors: string[] = []

  let account_holder = ''
  let cscs_number = ''
  let address: string | undefined
  let date_range: { from: string; to: string } | undefined
  let printed_totals: ContractNotesTotals | undefined

  // ── Header ─────────────────────────────────────────
  for (const line of lines) {
    const nm = line.match(/^Name:\s+(.+?)\s+Date:\s+(.+)$/)
    if (nm) {
      account_holder = nm[1].trim()
      const dr = nm[2].match(/^(.+?)\s+TO\s+(.+)$/)
      if (dr) date_range = { from: dr[1].trim(), to: dr[2].trim() }
      continue
    }
    const cs = line.match(/^CSCS No:\s+(\S+)(?:\s+Address:\s+(.+))?$/)
    if (cs) {
      cscs_number = cs[1]
      if (cs[2]) address = cs[2].trim()
      continue
    }

    // Sometimes printed as two-column with value on next visual line.
    // Only use as fallback if we haven't matched the single-line form.
    if (!account_holder) {
      const lone = line.match(/^Name:\s+(.+)$/)
      if (lone) account_holder = lone[1].trim()
    }
    if (!cscs_number) {
      const lone = line.match(/^CSCS No:\s+(\S+)$/)
      if (lone) cscs_number = lone[1]
    }
  }

  if (!account_holder) errors.push('Could not parse account holder from header')
  if (!cscs_number) errors.push('Could not parse CSCS number from header')

  // ── Row body + printed totals ─────────────────────
  const rows: ContractNoteRow[] = []
  for (const line of lines) {
    const row = tryParseCnRow(line)
    if (row) {
      rows.push(row)
      continue
    }

    const tot = line.match(/^TOTALS\s+(.+)$/)
    if (tot) {
      const amts = tot[1].trim().split(/\s+/).filter((t) => AMOUNT_RE.test(t))
      if (amts.length === 9) {
        printed_totals = {
          consideration: parseAmt(amts[0]),
          brokerage: parseAmt(amts[1]),
          vat: parseAmt(amts[2]),
          exchange: parseAmt(amts[3]),
          clearing: parseAmt(amts[4]),
          sec: parseAmt(amts[5]),
          contract_stamp: parseAmt(amts[6]),
          sms: parseAmt(amts[7]),
          total: parseAmt(amts[8]),
        }
      }
    }
  }

  const computed_totals: ContractNotesTotals = {
    consideration: round2(sum(rows.map((r) => r.consideration))),
    brokerage: round2(sum(rows.map((r) => r.fee_commission))),
    vat: round2(sum(rows.map((r) => r.fee_vat))),
    exchange: round2(sum(rows.map((r) => r.fee_exchange))),
    clearing: round2(sum(rows.map((r) => r.fee_clearing))),
    sec: round2(sum(rows.map((r) => r.fee_sec))),
    contract_stamp: round2(sum(rows.map((r) => r.fee_contract_stamp))),
    sms: round2(sum(rows.map((r) => r.fee_sms))),
    total: round2(sum(rows.map((r) => r.total))),
  }

  const totals_match = printed_totals
    ? Math.abs(computed_totals.total - printed_totals.total) < 1
    : false

  if (rows.length === 0) errors.push('No contract note rows parsed')

  return {
    account_holder,
    cscs_number,
    address,
    date_range,
    rows,
    printed_totals,
    computed_totals,
    totals_match,
    parse_errors: errors,
    raw_lines: opts.includeRawLines ? lines : undefined,
  }
}

function tryParseCnRow(line: string): ContractNoteRow | null {
  const tokens = line.split(/\s+/)
  // Expected shape: DATE TICKER ACTION QTY 10×AMOUNT DATE → 15 tokens
  if (tokens.length !== 15) return null

  if (!SLASH_DATE_RE.test(tokens[0])) return null
  if (!SLASH_DATE_RE.test(tokens[14])) return null

  const action = tokens[2]
  if (action !== 'PURCHASE' && action !== 'SALE') return null

  const security_code = tokens[1]
  if (!/^[A-Z][A-Z0-9]*$/.test(security_code)) return null

  const qtyTok = tokens[3]
  if (!/^[\d,]+$/.test(qtyTok)) return null

  // Positions 4..13 are all amounts
  for (let i = 4; i <= 13; i++) {
    if (!AMOUNT_RE.test(tokens[i])) return null
  }

  const trade_date = toIsoFromSlashed(tokens[0])
  const settlement_date = toIsoFromSlashed(tokens[14])
  if (!trade_date || !settlement_date) return null

  return {
    trade_date,
    security_code,
    action: action === 'PURCHASE' ? 'BUY' : 'SELL',
    quantity: parseAmt(qtyTok),
    price: parseAmt(tokens[4]),
    consideration: parseAmt(tokens[5]),
    fee_commission: parseAmt(tokens[6]),
    fee_vat: parseAmt(tokens[7]),
    fee_exchange: parseAmt(tokens[8]),
    fee_clearing: parseAmt(tokens[9]),
    fee_sec: parseAmt(tokens[10]),
    fee_contract_stamp: parseAmt(tokens[11]),
    fee_sms: parseAmt(tokens[12]),
    total: parseAmt(tokens[13]),
    settlement_date,
    raw_line: line,
  }
}

// ───────────────────────────────────────────────────────────
// Statement parser
// ───────────────────────────────────────────────────────────

export async function parseStatementPdf(
  buffer: Buffer,
  opts: ParseOptions = {}
): Promise<ParsedStatement> {
  const lines = await extractLines(buffer)
  const errors: string[] = []

  let account_holder = ''
  let cscs_number = ''
  let account_number: string | undefined
  let period = { from: '', to: '' }
  let opening_balance = 0
  let closing_balance = 0
  let total_credit = 0
  let total_debit = 0

  // ── Header — tolerant to layout variations ───────
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // "Account: NAME [internal][cscs]" on one line
    const accWithBrackets = line.match(
      /^Account:\s+(.+?)\s+\[(\d+)\]\[(\d+)\]$/
    )
    if (accWithBrackets) {
      account_holder = accWithBrackets[1].trim()
      account_number = accWithBrackets[2]
      cscs_number = accWithBrackets[3]
      continue
    }

    // "Account: NAME" alone
    const accOnly = line.match(/^Account:\s+(.+)$/)
    if (accOnly && !account_holder) {
      account_holder = accOnly[1].trim()
      continue
    }

    // Brackets on their own line — "[127466][14561345]"
    const brk = line.match(/^\[(\d+)\]\[(\d+)\]$/)
    if (brk && !account_number) {
      account_number = brk[1]
      cscs_number = brk[2]
      continue
    }

    const per = line.match(
      /^Statement Period:\s+(\d{1,2}-[A-Za-z]{3}-\d{4})\s+to\s+(\d{1,2}-[A-Za-z]{3}-\d{4})/
    )
    if (per) {
      period = {
        from: toIsoFromDashed(per[1]) || per[1],
        to: toIsoFromDashed(per[2]) || per[2],
      }
      continue
    }

    // Balance / totals — tolerate the ₦ glyph or its absence.
    // The number MUST have a decimal to be picked up (e.g. "59,956.50", ".00", "-295,625.00").
    const amtRe = /(-?[\d,]*\.\d+)/
    if (/^Opening Balance:/i.test(line)) {
      const m = line.match(amtRe)
      if (m) opening_balance = parseAmt(m[1])
      continue
    }
    if (/^Closing Balance:/i.test(line)) {
      const m = line.match(amtRe)
      if (m) closing_balance = parseAmt(m[1])
      continue
    }
    if (/^Total Credit:/i.test(line)) {
      const m = line.match(amtRe)
      if (m) total_credit = parseAmt(m[1])
      continue
    }
    if (/^Total Debit:/i.test(line)) {
      const m = line.match(amtRe)
      if (m) total_debit = parseAmt(m[1])
      continue
    }
  }

  // ── Ledger body ───────────────────────────────────
  // State-machine merger — handles 1-, 2-, and 3-visual-line rows
  // produced by the broker's narrow narration column. See the
  // buildStatementRows comment for layout details.
  const rows: StatementRow[] = buildStatementRows(lines)

  // ── Running-balance audit ─────────────────────────
  // Start from 0 and process every ledger row, including
  // "Balance Brought Forward" (whose CREDIT equals opening_balance).
  // Final running total should equal printed closing_balance.
  let running = 0
  for (const r of rows) running += r.credit - r.debit
  const computed_closing = round2(running)
  const printed_closing = round2(closing_balance)
  const diff = round2(computed_closing - printed_closing)
  const passes = Math.abs(diff) < 0.01

  if (!passes) {
    errors.push(
      `Balance audit failed: computed ${computed_closing.toFixed(2)} vs printed ${printed_closing.toFixed(2)} (diff ${diff.toFixed(2)})`
    )
  }
  if (rows.length === 0) errors.push('No ledger rows parsed')

  return {
    account_holder,
    cscs_number,
    account_number,
    period,
    opening_balance,
    total_credit,
    total_debit,
    closing_balance,
    rows,
    audit: { computed_closing, printed_closing, diff, passes },
    parse_errors: errors,
    raw_lines: opts.includeRawLines ? lines : undefined,
  }
}

// Merge visually-wrapped continuation lines into single logical rows
// using a state machine. The broker's narration column is narrow, so
// one logical row can span 1, 2, or 3 visual lines:
//   1-line: dates + narration + amounts all on one Y    (ANCHOR only)
//   2-line: narration above, dates+amounts below        (PRE + ANCHOR)
//   3-line: narration / dates+middle-narr+amounts / narration
//                                                       (PRE + ANCHOR-with-inline + POST)
//
// We classify each extracted line as ANCHOR (has 2 dates + 3 trailing
// amounts), ROW_STARTER (narration fragment that opens a new row —
// "Sale of…", "Purchase of…", "Being…", "1 year…"), JUNK
// (header/footer/totals), or CONTINUATION (anything else). A single
// walk attaches pre-fragments before an anchor is seen and
// post-fragments after; a new ROW_STARTER or ANCHOR emits the
// current row. This replaced the forward-only merger from v21a that
// silently dropped every multi-line row — see hotfix-3 notes.

type AnchorParts = {
  trans_date: string
  post_date: string
  inline_narration: string
  debit: number
  credit: number
  balance: number
  raw: string
}

function tryParseAnchor(line: string): AnchorParts | null {
  const tokens = line.split(/\s+/)
  if (tokens.length < 5) return null
  if (!DASH_DATE_RE.test(tokens[0]) || !DASH_DATE_RE.test(tokens[1])) return null
  const n = tokens.length
  if (
    !AMOUNT_RE.test(tokens[n - 1]) ||
    !AMOUNT_RE.test(tokens[n - 2]) ||
    !AMOUNT_RE.test(tokens[n - 3])
  ) {
    return null
  }
  const trans_date = toIsoFromDashed(tokens[0])
  if (!trans_date) return null
  const post_date = toIsoFromDashed(tokens[1]) || trans_date
  return {
    trans_date,
    post_date,
    inline_narration: tokens.slice(2, n - 3).join(' ').trim(),
    debit: parseAmt(tokens[n - 3]),
    credit: parseAmt(tokens[n - 2]),
    balance: parseAmt(tokens[n - 1]),
    raw: line,
  }
}

// Lines that open a new row's narration. Empirically enumerated from
// Transworld broker statements for both OOO and CMFB portfolios.
const ROW_STARTER_RE =
  /^(Sale|Purchase)\s+of\s+[\d,]+\s+unit\(s\)\s+of\s|^Being\s|^being\s|^Balance\s+Brought\s+Forward|^1\s+year\s+subscription|^[Dd]eposit\s+by|^[Pp]ayment\s+NIBSS/i

function isRowStarter(line: string): boolean {
  return ROW_STARTER_RE.test(line)
}

// Header / footer / totals lines that are never part of any row.
// Some are "contaminated" (e.g. "OFOEGBU… Opening Balance: …" on one
// Y because pdfjs merged two columns) — we match on any occurrence
// of a header label, not just line-start, to catch them.
function isJunkLine(line: string): boolean {
  return (
    /^\d+\/\d+\/\d+,\s/.test(line) ||                    // "4/22/26, 3:20 PM about:blank"
    /^about:blank/.test(line) ||
    /^STATEMENT OF ACCOUNT\b/.test(line) ||
    /^Transworld Investment/.test(line) ||
    /^\d+(st|nd|rd|th)\s+Floor/.test(line) ||
    /^\+\d{2,}/.test(line) ||                            // phone header
    /^\d{4}\/\d{2}\/\d{2}\s+\d/.test(line) ||            // "22/04/2026 20:20:29"
    /Opening\s+Balance:/.test(line) ||                   // anywhere in line
    /Closing\s+Balance:/.test(line) ||
    /Total\s+Credit:/.test(line) ||
    /Total\s+Debit:/.test(line) ||
    /Uncleared\s+Credit:/.test(line) ||
    /Cleared\s+Balance:/.test(line) ||
    /^Account:/.test(line) ||
    /^Account\s+Type:/.test(line) ||
    /^DCS\s+Enrolled/.test(line) ||
    /^Is\s+Custodian/.test(line) ||
    /^Contact\s+Info:/.test(line) ||
    /^Statement\s+Period:/.test(line) ||
    /^TRANSDATE\s/.test(line) ||
    /^Totals\s+for/.test(line) ||
    /^Checked\s+By/.test(line) ||
    /^Approved\s+By/.test(line) ||
    /@[\w.-]+\.\w/.test(line) ||                         // email
    /^\[\d+\]\[\d+\]$/.test(line) ||                     // "[127466][14561345]"
    /^0\d{9,10}$/.test(line)                             // NG phone starting with 0
  )
}

function buildStatementRows(lines: string[]): StatementRow[] {
  type PartialRow = {
    pre: string[]
    anchor: AnchorParts | null
    post: string[]
  }

  const rows: StatementRow[] = []
  let current: PartialRow | null = null

  const emit = () => {
    if (!current || !current.anchor) return
    const narrationParts = [
      ...current.pre,
      current.anchor.inline_narration,
      ...current.post,
    ]
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
    const narration = narrationParts.join(' ').replace(/\s+/g, ' ').trim()

    const row: StatementRow = {
      trans_date: current.anchor.trans_date,
      post_date: current.anchor.post_date,
      narration,
      debit: current.anchor.debit,
      credit: current.anchor.credit,
      balance: current.anchor.balance,
      kind: 'unknown',
      raw_line: [
        current.pre.length ? `[pre] ${current.pre.join(' | ')}` : '',
        `[anchor] ${current.anchor.raw}`,
        current.post.length ? `[post] ${current.post.join(' | ')}` : '',
      ]
        .filter(Boolean)
        .join('  '),
    }
    classifyStatementRow(row)
    rows.push(row)
    current = null
  }

  for (const line of lines) {
    if (isJunkLine(line)) {
      // Junk mid-flow terminates the current row — almost always a
      // page-break like "about:blank 2/5" splitting a row's
      // post-narration from its pre-narration on the next page.
      if (current && current.anchor) emit()
      continue
    }

    const anchor = tryParseAnchor(line)
    if (anchor) {
      if (current && current.anchor) emit()
      if (!current) current = { pre: [], anchor: null, post: [] }
      current.anchor = anchor
      continue
    }

    // Narration fragment (non-anchor, non-junk).
    if (isRowStarter(line)) {
      if (current && current.anchor) emit()
      current = { pre: [line], anchor: null, post: [] }
      continue
    }

    // Continuation fragment.
    if (!current) continue // junk before first row; drop silently
    if (current.anchor) current.post.push(line)
    else current.pre.push(line)
  }

  if (current && current.anchor) emit()
  return rows
}

function classifyStatementRow(row: StatementRow): void {
  const narr = row.narration
  const lc = narr.toLowerCase()

  if (/balance brought forward/i.test(narr)) {
    row.kind = 'balance_brought_forward'
    return
  }

  const saleRe = /sale of ([\d,]+) unit\(s\) of (\w+) @ ([\d.]+);?\s*CN#\s*(\d+)/i
  const buyRe  = /purchase of ([\d,]+) unit\(s\) of (\w+) @ ([\d.]+);?\s*CN#\s*(\d+)/i
  const sm = narr.match(saleRe)
  if (sm) {
    row.kind = 'trade_sell'
    row.quantity = parseAmt(sm[1])
    row.ticker = sm[2].toUpperCase()
    row.price = parseFloat(sm[3])
    row.cn_number = sm[4]
    return
  }
  const bm = narr.match(buyRe)
  if (bm) {
    row.kind = 'trade_buy'
    row.quantity = parseAmt(bm[1])
    row.ticker = bm[2].toUpperCase()
    row.price = parseFloat(bm[3])
    row.cn_number = bm[4]
    return
  }

  // Order of checks matters. "Being deposit for bank charge" is
  // a DEBIT and must classify as bank_charge, NOT deposit.
  if (row.debit > 0) {
    if (/(discretionary|managed fee|investor plan)/i.test(narr)) {
      row.kind = 'management_fee'; return
    }
    if (/bank charge/i.test(narr)) {
      row.kind = 'bank_charge'; return
    }
    if (/(demat|verification|consolidation of shares)/i.test(narr)) {
      row.kind = 'bank_charge'; return
    }
    if (/refund/i.test(narr)) {
      row.kind = 'refund'; return
    }
    if (/(payment for shares|shares sold|shares purchase|NIBSS|CHEQUE)/i.test(narr)) {
      row.kind = 'withdrawal'; return
    }
    row.kind = 'unknown'
    return
  }

  if (row.credit > 0) {
    if (/(deposit|NIBSS|CHEQUE|payment)/i.test(narr)) {
      row.kind = 'deposit'; return
    }
    row.kind = 'unknown'
    return
  }

  row.kind = 'unknown'
  void lc // reserved for future classifier tweaks
}

// ───────────────────────────────────────────────────────────
// Reconciliation
// ───────────────────────────────────────────────────────────

export function reconcile(
  cns: ParsedContractNotes,
  statements: ParsedStatement[]
): Reconciliation {
  const trade_matches: TradeMatch[] = []
  const orphan_statement_trades: Reconciliation['orphan_statement_trades'] = []
  const cash_events: CashEvent[] = []

  type SRef = {
    statement_index: number
    row_index: number
    row: StatementRow
  }

  const claimed = new Set<string>()
  const allStatementTrades: SRef[] = []
  statements.forEach((st, si) => {
    st.rows.forEach((r, ri) => {
      if (r.kind === 'trade_buy' || r.kind === 'trade_sell') {
        allStatementTrades.push({ statement_index: si, row_index: ri, row: r })
      }
    })
  })

  cns.rows.forEach((cn, cnIdx) => {
    const candidates = allStatementTrades.filter((s) => {
      const key = `${s.statement_index}:${s.row_index}`
      if (claimed.has(key)) return false
      if (s.row.trans_date !== cn.trade_date) return false
      if ((s.row.ticker || '').toUpperCase() !== cn.security_code.toUpperCase()) {
        return false
      }
      if (s.row.kind === 'trade_buy' && cn.action !== 'BUY') return false
      if (s.row.kind === 'trade_sell' && cn.action !== 'SELL') return false
      if (Math.abs((s.row.price || 0) - cn.price) > 0.005) return false
      return true
    })

    const refs = candidates.map((s) => ({
      statement_index: s.statement_index,
      row_index: s.row_index,
    }))

    if (candidates.length === 0) {
      trade_matches.push({
        cn_row_index: cnIdx,
        statement_refs: [],
        kind: 'unmatched',
        note: `No statement trade at ${cn.trade_date} ${cn.security_code} ${cn.action} @ ${cn.price}`,
      })
      return
    }

    const sumQty = candidates.reduce((a, s) => a + (s.row.quantity || 0), 0)
    const qtyDiff = Math.abs(sumQty - cn.quantity)

    // Mark claimed regardless — either it reconciles or we flag it.
    candidates.forEach((s) =>
      claimed.add(`${s.statement_index}:${s.row_index}`)
    )

    if (qtyDiff < 0.5) {
      trade_matches.push({
        cn_row_index: cnIdx,
        statement_refs: refs,
        kind: candidates.length === 1 ? 'exact' : 'split',
      })
    } else {
      trade_matches.push({
        cn_row_index: cnIdx,
        statement_refs: refs,
        kind: 'partial_mismatch',
        note: `CN qty ${cn.quantity} vs statement qty sum ${sumQty} (diff ${qtyDiff})`,
      })
    }
  })

  allStatementTrades.forEach((s) => {
    const key = `${s.statement_index}:${s.row_index}`
    if (!claimed.has(key)) {
      orphan_statement_trades.push({
        statement_index: s.statement_index,
        row_index: s.row_index,
        reason: `No CN for ${s.row.trans_date} ${s.row.ticker} ${s.row.kind} @ ${s.row.price}`,
      })
    }
  })

  statements.forEach((st, si) => {
    st.rows.forEach((r, ri) => {
      let proposed: CashEvent['proposed_action'] | null = null
      switch (r.kind) {
        case 'deposit':        proposed = 'TRANSFER_IN';  break
        case 'withdrawal':     proposed = 'TRANSFER_OUT'; break
        case 'management_fee': proposed = 'FEE';          break
        case 'bank_charge':    proposed = 'FEE';          break
        case 'refund':         proposed = 'TRANSFER_OUT'; break
        default: proposed = null
      }
      if (proposed === null) return
      const amount = r.debit > 0 ? r.debit : r.credit
      cash_events.push({
        statement_index: si,
        row_index: ri,
        proposed_action: proposed,
        amount,
        date: r.trans_date,
        narration: r.narration,
        kind: r.kind,
      })
    })
  })

  const summary = {
    cn_row_count: cns.rows.length,
    statement_trade_count: allStatementTrades.length,
    matched_exact: trade_matches.filter((m) => m.kind === 'exact').length,
    matched_split: trade_matches.filter((m) => m.kind === 'split').length,
    partial_mismatch: trade_matches.filter((m) => m.kind === 'partial_mismatch').length,
    unmatched_cn: trade_matches.filter((m) => m.kind === 'unmatched').length,
    orphan_statement: orphan_statement_trades.length,
    cash_event_count: cash_events.length,
    all_statements_balanced: statements.every((s) => s.audit.passes),
  }

  return {
    contract_notes: cns,
    statements,
    trade_matches,
    orphan_statement_trades,
    cash_events,
    summary,
  }
}
