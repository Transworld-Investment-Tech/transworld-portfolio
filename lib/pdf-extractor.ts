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
// v27ca-fix1: strict heading-only matching.
// The original selector matched any sentence containing the phrase
// "statement of profit or loss" — but in NGX audited reports those phrases
// appear extensively in accounting-policy NOTES paragraphs that come BEFORE
// the actual statements. To target the real statements we require:
//   1. Match against heading-shaped regex patterns (heading, not prose)
//   2. The line itself is short (<= 100 chars) — true headings are short,
//      while policy-prose paragraphs are long
// Verified against ACCESSCORP FY2025: matches line 3544
// "Consolidated and separate statement of comprehensive income" (the real
// heading) rather than line 4004 (an IFRS-18 policy note).
const HEADING_PATTERNS: RegExp[] = [
  /^\s*(?:consolidated(?:\s+and\s+separate)?\s+)?(?:interim\s+)?statement of (?:profit or loss(?:\s+and other comprehensive income)?|comprehensive income|financial position)\s*$/i,
  /^\s*(?:consolidated\s+)?income statement\s*$/i,
  /^\s*consolidated and separate statement of comprehensive income\s*$/i,
  /^\s*statement of (?:profit or loss|comprehensive income|financial position)\s*(?:\([^)]*\))?\s*$/i,
]

function isLikelyHeadingLine(line: string): boolean {
  if (line.length > 100) return false
  for (const re of HEADING_PATTERNS) {
    if (re.test(line)) return true
  }
  return false
}

export function findFinancialStatementSection(
  lines: string[],
  maxChars = 40_000,
): { section: string; matched_marker: string | null; total_lines: number } {
  let startIdx = -1
  let matched_marker: string | null = null
  for (let i = 0; i < lines.length; i++) {
    if (isLikelyHeadingLine(lines[i])) {
      startIdx = i
      matched_marker = lines[i]
      break
    }
  }

  if (startIdx === -1) {
    // Fallback: return head of document
    const joined = lines.join('\n')
    return {
      section: joined.slice(0, maxChars),
      matched_marker: null,
      total_lines: lines.length,
    }
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
