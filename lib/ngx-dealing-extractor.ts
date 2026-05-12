// v27cb-a-fix7h-fix2 — NGX director/insider dealing PDF extractor
//
// Separate from lib/ngx-disclosure-extractor.ts because:
//   1. NGX uses a uniform numbered-field template across all dealings (probe #5
//      confirmed 5/5 dealings follow the same form). No classification needed —
//      just field extraction.
//   2. Cheaper prompt; no discriminated union.
//   3. Cleaner cost tracking separation.
//
// Field naming note: NGX form template uses "Insider" not "Director". Many
// filers are senior staff, not board directors. We store insider_name +
// insider_position and let the UI keep the "Director Dealings" label because
// that's the listed NGX category.
//
// fix2: same SDK-doesn't-support-url-source workaround as disclosure
//       extractor. Download PDF, encode base64, send to Claude.

import Anthropic from '@anthropic-ai/sdk'

export type DealingExtractionStatus =
  | 'extracted'
  | 'scanned_pdf'
  | 'fetch_failed'
  | 'model_error'

export type DealingTransactionType =
  | 'BUY'
  | 'SELL'
  | 'GIFT'
  | 'VEST'
  | 'EXERCISE'
  | 'TRANSFER'

export interface DealingExtractionResult {
  status: DealingExtractionStatus
  insider_name: string | null
  insider_position: string | null
  transaction_type: DealingTransactionType | null
  share_count: number | null
  price_per_share: number | null
  total_value: number | null
  currency: string | null
  transaction_date: string | null
  notification_type: 'Initial' | 'Amendment' | null
  extraction_notes: string | null
  input_chars: number
  cost_estimate_usd: number
  model_used: string | null
  error?: string
}

const COST_PER_INPUT_TOKEN = 3.0 / 1_000_000
const COST_PER_OUTPUT_TOKEN = 15.0 / 1_000_000
const MODEL_NAME = 'claude-sonnet-4-20250514'
const MAX_INPUT_CHARS = 20_000
const SCANNED_PDF_THRESHOLD_CHARS = 100
const PDF_FETCH_TIMEOUT_MS = 30_000
const MAX_PDF_BYTES = 30 * 1024 * 1024

// ─────────────────────────────────────────────────────────────────
// PDF download helper (fix2)
// ─────────────────────────────────────────────────────────────────

async function downloadPdfAsBase64(
  pdfUrl: string,
): Promise<{ data: string; size: number; ok: boolean; error?: string }> {
  try {
    const r = await fetch(pdfUrl, {
      headers: {
        'User-Agent': 'transworld-portfolio/v27cb-a-fix7h-fix2',
        'Accept': 'application/pdf,*/*',
      },
      signal: AbortSignal.timeout(PDF_FETCH_TIMEOUT_MS),
    })
    if (!r.ok) {
      return { data: '', size: 0, ok: false, error: `PDF fetch HTTP ${r.status}` }
    }
    const buf = await r.arrayBuffer()
    if (buf.byteLength === 0) {
      return { data: '', size: 0, ok: false, error: 'empty PDF response from NGX' }
    }
    if (buf.byteLength > MAX_PDF_BYTES) {
      return {
        data: '',
        size: buf.byteLength,
        ok: false,
        error: `PDF too large: ${(buf.byteLength / 1e6).toFixed(1)}MB exceeds ${MAX_PDF_BYTES / 1e6}MB API limit`,
      }
    }
    const data = Buffer.from(buf).toString('base64')
    return { data, size: buf.byteLength, ok: true }
  } catch (e) {
    return {
      data: '',
      size: 0,
      ok: false,
      error: 'PDF fetch failed: ' + (e instanceof Error ? e.message : String(e)),
    }
  }
}

function buildPrompt(pdfText: string, title: string, modifiedAt: string, ticker: string): string {
  return `You are extracting structured facts from a Nigerian Exchange (NGX) insider share dealing notification.

NGX uses a standard form template. Extract these fields:

- insider_name: Full canonical name (field 1 of the form, e.g., "Bolarinwa Mageed Animashaun")
- insider_position: The "Position/status" field. Examples: "Staff of Access Bank Plc, a subsidiary of Access Holdings Plc", "CEO", "Executive Director", "Wife of Director X", "Non-Executive Director"
- transaction_type: Map "Sales"/"Sale"/"Disposal" -> SELL; "Purchase"/"Acquisition"/"Buy" -> BUY; "Gift" -> GIFT; "Vest"/"Vesting" -> VEST; "Exercise" -> EXERCISE; "Transfer" -> TRANSFER
- share_count: Total aggregate shares transacted (use aggregate volume if multi-line)
- price_per_share: Aggregate VWAP or single price stated
- total_value: share_count * price_per_share if not stated; else as stated
- currency: NGN unless GBp/GBP/USD/EUR explicitly stated. Watch for "N" prefix (NGN) vs "GBp" (pence) vs "$".
- transaction_date: ISO 8601 YYYY-MM-DD
- notification_type: "Initial" or "Amendment"

If multiple trades on different dates at different prices in a single filing:
- Use aggregate volume for share_count
- Use aggregate VWAP for price_per_share (or compute weighted average if both stated)
- Use the latest transaction date

If any field is genuinely absent from the PDF, leave null and note in extraction_notes.

OUTPUT FORMAT (return ONLY this JSON object, no preamble, no markdown fences):
{
  "insider_name": <string or null>,
  "insider_position": <string or null>,
  "transaction_type": "BUY" | "SELL" | "GIFT" | "VEST" | "EXERCISE" | "TRANSFER" | null,
  "share_count": <number or null>,
  "price_per_share": <number or null>,
  "total_value": <number or null>,
  "currency": "NGN" | "GBP" | "GBp" | "USD" | null,
  "transaction_date": <YYYY-MM-DD or null>,
  "notification_type": "Initial" | "Amendment" | null,
  "extraction_notes": <1-2 sentence note flagging any ambiguity or null fields>
}

If the PDF text is empty or garbled, return all fields null with a reason in extraction_notes.

DISCLOSURE TITLE: ${title}
FILING DATE: ${modifiedAt}
INSTRUMENT: ${ticker}

PDF TEXT:
${pdfText}
`
}

async function fetchPdfTextViaClaude(
  client: Anthropic,
  pdfBase64: string,
): Promise<{ text: string; ok: boolean; error?: string }> {
  try {
    const resp = await client.messages.create({
      model: MODEL_NAME,
      max_tokens: 4000,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'document',
              source: {
                type: 'base64',
                media_type: 'application/pdf',
                data: pdfBase64,
              },
            },
            {
              type: 'text',
              text: 'Output ONLY the verbatim text content of this PDF, preserving paragraph breaks. No commentary, no markdown, no preamble. If the PDF appears to be a scanned image with no machine-readable text, output exactly the string "EMPTY_PDF_NO_TEXT".',
            },
          ],
        },
      ],
    })
    const block = resp.content.find((b) => b.type === 'text')
    if (!block || block.type !== 'text') {
      return { text: '', ok: false, error: 'no text block in response' }
    }
    const text = block.text.trim()
    if (text === 'EMPTY_PDF_NO_TEXT' || text.length < SCANNED_PDF_THRESHOLD_CHARS) {
      return { text: '', ok: true }
    }
    return { text, ok: true }
  } catch (e) {
    return { text: '', ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

export async function extractDealing(args: {
  pdfUrl: string
  title: string
  modifiedAt: string
  ticker: string
  client: Anthropic
}): Promise<DealingExtractionResult> {
  const { pdfUrl, title, modifiedAt, ticker, client } = args

  // Step 1: Download PDF as base64
  const dl = await downloadPdfAsBase64(pdfUrl)
  if (!dl.ok) {
    return {
      status: 'fetch_failed',
      insider_name: null,
      insider_position: null,
      transaction_type: null,
      share_count: null,
      price_per_share: null,
      total_value: null,
      currency: null,
      transaction_date: null,
      notification_type: null,
      extraction_notes: null,
      input_chars: 0,
      cost_estimate_usd: 0,
      model_used: null,
      error: dl.error,
    }
  }

  // Step 2: Get PDF text via Claude
  const fetched = await fetchPdfTextViaClaude(client, dl.data)
  if (!fetched.ok) {
    return {
      status: 'fetch_failed',
      insider_name: null,
      insider_position: null,
      transaction_type: null,
      share_count: null,
      price_per_share: null,
      total_value: null,
      currency: null,
      transaction_date: null,
      notification_type: null,
      extraction_notes: null,
      input_chars: 0,
      cost_estimate_usd: 0,
      model_used: null,
      error: fetched.error,
    }
  }

  if (fetched.text.length < SCANNED_PDF_THRESHOLD_CHARS) {
    return {
      status: 'scanned_pdf',
      insider_name: null,
      insider_position: null,
      transaction_type: null,
      share_count: null,
      price_per_share: null,
      total_value: null,
      currency: null,
      transaction_date: null,
      notification_type: null,
      extraction_notes: 'PDF appears to be scanned/image-based with no machine-readable text.',
      input_chars: 0,
      cost_estimate_usd: 0,
      model_used: null,
    }
  }

  const pdfText = fetched.text.slice(0, MAX_INPUT_CHARS)
  const prompt = buildPrompt(pdfText, title, modifiedAt, ticker)

  let resp
  try {
    resp = await client.messages.create({
      model: MODEL_NAME,
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    })
  } catch (e) {
    return {
      status: 'model_error',
      insider_name: null,
      insider_position: null,
      transaction_type: null,
      share_count: null,
      price_per_share: null,
      total_value: null,
      currency: null,
      transaction_date: null,
      notification_type: null,
      extraction_notes: null,
      input_chars: pdfText.length,
      cost_estimate_usd: 0,
      model_used: MODEL_NAME,
      error: e instanceof Error ? e.message : String(e),
    }
  }

  const block = resp.content.find((b) => b.type === 'text')
  if (!block || block.type !== 'text') {
    return {
      status: 'model_error',
      insider_name: null,
      insider_position: null,
      transaction_type: null,
      share_count: null,
      price_per_share: null,
      total_value: null,
      currency: null,
      transaction_date: null,
      notification_type: null,
      extraction_notes: null,
      input_chars: pdfText.length,
      cost_estimate_usd: 0,
      model_used: MODEL_NAME,
      error: 'no text block in extraction response',
    }
  }

  let parsed: Record<string, unknown>
  try {
    let raw = block.text.trim()
    if (raw.startsWith('```')) {
      raw = raw.replace(/^```(?:json)?\s*/, '').replace(/\s*```\s*$/, '').trim()
    }
    parsed = JSON.parse(raw)
  } catch (e) {
    return {
      status: 'model_error',
      insider_name: null,
      insider_position: null,
      transaction_type: null,
      share_count: null,
      price_per_share: null,
      total_value: null,
      currency: null,
      transaction_date: null,
      notification_type: null,
      extraction_notes: null,
      input_chars: pdfText.length,
      cost_estimate_usd: estimateCost(resp.usage),
      model_used: MODEL_NAME,
      error: 'dealing JSON parse failed: ' + (e instanceof Error ? e.message : String(e)),
    }
  }

  const txType = parsed.transaction_type as string | null
  const validTxType: DealingTransactionType | null =
    txType && ['BUY', 'SELL', 'GIFT', 'VEST', 'EXERCISE', 'TRANSFER'].includes(txType)
      ? (txType as DealingTransactionType)
      : null

  const notifType = parsed.notification_type as string | null
  const validNotifType: 'Initial' | 'Amendment' | null =
    notifType === 'Initial' || notifType === 'Amendment'
      ? (notifType as 'Initial' | 'Amendment')
      : null

  return {
    status: 'extracted',
    insider_name: (parsed.insider_name as string | null) ?? null,
    insider_position: (parsed.insider_position as string | null) ?? null,
    transaction_type: validTxType,
    share_count: numOrNull(parsed.share_count),
    price_per_share: numOrNull(parsed.price_per_share),
    total_value: numOrNull(parsed.total_value),
    currency: (parsed.currency as string | null) ?? null,
    transaction_date: (parsed.transaction_date as string | null) ?? null,
    notification_type: validNotifType,
    extraction_notes: (parsed.extraction_notes as string | null) ?? null,
    input_chars: pdfText.length,
    cost_estimate_usd: estimateCost(resp.usage),
    model_used: MODEL_NAME,
  }
}

function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number' && isFinite(v)) return v
  if (typeof v === 'string') {
    const n = Number(v.replace(/,/g, ''))
    if (isFinite(n)) return n
  }
  return null
}

function estimateCost(usage: { input_tokens?: number; output_tokens?: number } | undefined): number {
  if (!usage) return 0
  const inT = usage.input_tokens ?? 0
  const outT = usage.output_tokens ?? 0
  return inT * COST_PER_INPUT_TOKEN + outT * COST_PER_OUTPUT_TOKEN
}
