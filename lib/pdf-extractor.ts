// v27ca — PDF download + text extraction + financial-section locator
//
// Builds on the unpdf-based pattern already proven in lib/broker-parser.ts.
// unpdf ships a serverless-friendly pdfjs build with DOMMatrix / Path2D / other
// browser globals pre-polyfilled — required because Vercel's Node runtime
// otherwise throws "DOMMatrix is not defined" when pdfjs is used directly.
//
// Three public helpers:
//   - downloadPdfAsBuffer(url)          → fetch the PDF binary as a Buffer
//   - extractPdfLines(buffer)           → layout-aware line extraction (y-sorted, x-joined)
//   - findFinancialStatementSection(lines, maxChars)
//                                       → returns a focused text block of just the
//                                          P&L + Balance Sheet + EPS pages, capped at ~30K chars
//
// findFinancialStatementSection is the key sizing knob: full audited reports are
// 100-300 pages but the actual financial statements are concentrated in ~10-30
// pages near the middle. Cutting to that section reduces Claude input cost ~10x.

const PDF_USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

/**
 * Fetch a PDF from a URL and return its bytes as a Node Buffer.
 * Uses browser-like headers to maximise compatibility with anti-bot defenses.
 */
export async function downloadPdfAsBuffer(url: string): Promise<Buffer> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), 30_000)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': PDF_USER_AGENT,
        Accept: 'application/pdf,application/octet-stream,*/*',
      },
      signal: controller.signal,
      redirect: 'follow',
    })
    if (!res.ok) {
      throw new Error(`PDF download ${res.status}: ${url.slice(-80)}`)
    }
    const ab = await res.arrayBuffer()
    return Buffer.from(ab)
  } finally {
    clearTimeout(timeoutId)
  }
}

const Y_TOLERANCE = 2

/**
 * Coordinate-aware line extraction. Sort items by y descending (PDF coords
 * are bottom-up), then group items within Y_TOLERANCE pixels into the same
 * line, then sort each line's items left-to-right by x. Returns one logical
 * line per array element. Critical for tabular financial statements where
 * column alignment matters.
 */
export async function extractPdfLines(buffer: Buffer): Promise<string[]> {
  const { getDocumentProxy } = await import('unpdf')
  const pdf = await getDocumentProxy(new Uint8Array(buffer))
  const allLines: string[] = []

  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p)
    const content = await page.getTextContent()

    type Item = { str: string; x: number; y: number }
    const items: Item[] = (content.items as Array<{ str: string; transform: number[] }>)
      .filter((it) => it && typeof it.str === 'string' && it.str.trim().length > 0)
      .map((it) => ({
        str: it.str,
        x: it.transform[4],
        y: it.transform[5],
      }))

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

/**
 * Locate the financial-statements section within an extracted line array.
 * Returns the joined text of lines from the first "Statement of profit or loss"
 * or "Statement of comprehensive income" marker through to the end of the
 * "Statement of cash flows" or "Earnings per share" notes, capped at maxChars.
 *
 * Falls back to returning the whole document head (first maxChars) if no
 * marker is found — better to send full text than nothing.
 */
// v27ca-fix2: heading-or-P&L-data anchor with back-up logic.
// v27ca-fix1 correctly avoided policy-note false positives but failed when
// pdfjs fragmented the P&L heading line (e.g. ACCESSCORP FY2024) — the
// only matchable heading became the Balance Sheet heading, which left
// Claude with BS rows but no P&L or EPS data. This fix adds P&L-data-row
// anchors that NEVER appear in policy notes, and backs up from the BS
// heading to the earlier P&L-data anchor when one is found.
//
// Verified against ACCESSCORP FY2025 (heading_pl anchor),
// FY2024 (pldata_before_bs anchor), Q1 2026 (heading_pl anchor).
// v27cb-a-fix4: relaxed end-anchors. Previously each pattern required the
// line to END with the heading phrase (\s*$), which rejected NGX-style
// headings like "Consolidated and separate statement of comprehensive income
// for the year ended" (note the trailing date suffix on the same logical
// line). The trailing-text rejection caused the selector to fall back to the
// executive-summary anchor at line 135 of the ACCESSCORP FY2024 audit,
// which has Revenue and EPS but no BS detail and no CFO. Replacing \s*$
// with \b allows the heading to match even when extra text follows.
const HEADING_PATTERNS: RegExp[] = [
  /^\s*(?:consolidated(?:\s+and\s+separate)?\s+)?(?:interim\s+)?statement of (?:profit or loss(?:\s+and other comprehensive income)?|comprehensive income|financial position)\b/i,
  /^\s*(?:consolidated\s+)?income statement\b/i,
  /^\s*consolidated and separate statement of comprehensive income\b/i,
  /^\s*statement of (?:profit or loss|comprehensive income|financial position)\b/i,
]

// PL_DATA_PATTERNS: row labels that ONLY appear in an income statement, never
// in a balance sheet, and never in policy notes (notes describe what the
// concept IS but don't list a value with thousands-separator formatting).
const PL_DATA_PATTERNS: RegExp[] = [
  /^Interest income\b.*[\d,]+/i,
  /^Net interest income\b.*[\d,]+/i,
  /^Gross earnings\b.*[\d,]+/i,
  /^Revenue\b.*[\d,]+/i,
  /^Cost of sales\b.*[\d,]+/i,
  /^Gross profit\b.*[\d,]+/i,
]

const BS_HEADING_RE = /statement of financial position/i

function isHeadingLine(line: string): boolean {
  if (line.length > 100) return false
  for (const re of HEADING_PATTERNS) {
    if (re.test(line)) return true
  }
  return false
}

function isPlDataLine(line: string): boolean {
  if (line.length > 250) return false
  for (const re of PL_DATA_PATTERNS) {
    if (re.test(line)) return true
  }
  return false
}

export function findFinancialStatementSection(
  lines: string[],
  maxChars = 40_000,
): { section: string; matched_marker: string | null; total_lines: number } {
  // Scan for first heading match AND first P&L-data match in parallel
  let firstHeading = -1
  let firstHeadingText: string | null = null
  let firstPlData = -1
  let firstPlText: string | null = null
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (firstHeading === -1 && isHeadingLine(l)) {
      firstHeading = i
      firstHeadingText = l
    }
    if (firstPlData === -1 && isPlDataLine(l)) {
      firstPlData = i
      firstPlText = l
    }
    if (firstHeading !== -1 && firstPlData !== -1) break
  }

  // Decision tree
  let startIdx = -1
  let matched_marker: string | null = null

  if (firstHeading === -1 && firstPlData === -1) {
    // Fallback: return head of document
    const joined = lines.join('\n')
    return {
      section: joined.slice(0, maxChars),
      matched_marker: null,
      total_lines: lines.length,
    }
  } else if (firstHeading !== -1) {
    const isBsHeading = firstHeadingText !== null && BS_HEADING_RE.test(firstHeadingText)
    if (!isBsHeading) {
      // P&L heading found — use it
      startIdx = firstHeading
      matched_marker = firstHeadingText
    } else if (firstPlData !== -1 && firstPlData < firstHeading) {
      // BS heading found but P&L data row exists earlier — back up
      startIdx = firstPlData
      matched_marker = firstPlText
    } else {
      // Only BS heading available — use it
      startIdx = firstHeading
      matched_marker = firstHeadingText
    }
  } else {
    // Only P&L data row found
    startIdx = firstPlData
    matched_marker = firstPlText
  }

  // Read forward — generous slice (1200 lines is enough for P&L + BS + EPS
  // notes in any NGX filing; budget capped by maxChars).
  const slice = lines.slice(startIdx, startIdx + 1200).join('\n')
  return {
    section: slice.slice(0, maxChars),
    matched_marker,
    total_lines: lines.length,
  }
}
