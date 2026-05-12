// v27cb-a-fix7h-fix2 — Unified NGX disclosure PDF extractor
//
// Reads a single NGX disclosure PDF and classifies + extracts in one Claude call.
// Single unified prompt across all subcategories (Option A from spec); no upfront
// title-based classifier. The probe (probe 1-5) showed that NGX titles are too
// economical to support reliable regex classification, and 27% of disclosures
// fell into the "unclassified" bucket including material events like UAC's CHI
// acquisition. Letting Claude classify by reading the PDF body is more robust.
//
// Output: discriminated-union JSON shape; one of 12 subcategories.
//
// fix2: SDK document source type doesn't accept 'url' (only 'text' | 'base64'
//       | 'content'). Workaround: download the PDF ourselves, encode as base64,
//       pass to Claude. Adds ~1-2s per PDF (NGX fetch latency) but is the only
//       supported path given the SDK version in this project.
//
// Scanned-PDF detection: if Claude returns the empty-text sentinel, we treat
// the PDF as image-based and skip the structured-extraction step.
//
// Cost: ~$0.015 per PDF at Sonnet 4 pricing. ~30MB max PDF size (API limit;
// most NGX filings are 100-500KB so well within).

import Anthropic from '@anthropic-ai/sdk'

export type ExtractionStatus =
  | 'extracted'
  | 'scanned_pdf'
  | 'fetch_failed'
  | 'model_error'

export type DisclosureSubcategory =
  | 'dividend'
  | 'agm_resolution'
  | 'board_change'
  | 'rights_issue'
  | 'share_transaction'
  | 'voting_rights'
  | 'mna'
  | 'earnings_release'
  | 'closed_period'
  | 'press_release'
  | 'governance_report'
  | 'other'

export interface DisclosureExtractionResult {
  status: ExtractionStatus
  subcategory: DisclosureSubcategory | null
  material_event: boolean
  facts: Record<string, unknown> | null
  currency: string | null
  extraction_notes: string | null
  input_chars: number
  cost_estimate_usd: number
  model_used: string | null
  error?: string
}

// Pricing for Claude Sonnet 4 (claude-sonnet-4-20250514) per 1M tokens:
//   Input:  $3.00
//   Output: $15.00
const COST_PER_INPUT_TOKEN = 3.0 / 1_000_000
const COST_PER_OUTPUT_TOKEN = 15.0 / 1_000_000
const MODEL_NAME = 'claude-sonnet-4-20250514'
const MAX_INPUT_CHARS = 40_000
const SCANNED_PDF_THRESHOLD_CHARS = 100
const PDF_FETCH_TIMEOUT_MS = 30_000
const MAX_PDF_BYTES = 30 * 1024 * 1024 // 30MB Anthropic API limit

// ─────────────────────────────────────────────────────────────────
// PDF download helper (fix2: replaces URL-based source which SDK
// doesn't support in this version)
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

// ─────────────────────────────────────────────────────────────────
// Single unified extraction prompt (probe-tuned vocabulary)
// ─────────────────────────────────────────────────────────────────

function buildPrompt(pdfText: string, title: string, modifiedAt: string, ticker: string): string {
  return `You are a financial analyst extracting structured facts from Nigerian Exchange (NGX) corporate disclosures.

The disclosure PDF text is below. Your task:

1. Classify the disclosure into ONE subcategory.
2. Extract the structured facts matching that subcategory's schema.
3. Mark material_event=true if this represents an event that an institutional investor would need to know about (any dividend, M&A, board change, rights issue, share repurchase, or major AGM resolution). Mark false for closed period notices, sustainability/NCCG reports, and routine press releases.

CLASSIFICATION GUIDANCE:
- "dividend" — any DPS declaration, interim, final, proposed, or special dividends, dividend cancellations
- "agm_resolution" — formal resolutions list from an Annual General Meeting (the document typically lists numbered resolutions)
- "board_change" — director appointment, resignation, role change (NOT routine re-elections inside an AGM filing — those go into agm_resolution.board_re_elected[])
- "rights_issue" — new share issue at a discount to existing holders
- "share_transaction" — buyback, treasury share purchase, cancellation (the company transacting in its own shares)
- "voting_rights" — periodic disclosure of total voting rights
- "mna" — acquisitions, mergers, disposals, joint ventures, structural separations
- "earnings_release" — press release of period earnings (DISTINCT from the actual financial statements which are routed elsewhere)
- "closed_period" — pre-results trading window closure
- "press_release" — generic announcement with no extractable structured facts
- "governance_report" — sustainability, NCCG, ESG report
- "other" — anything that doesn't fit above

CURRENCY:
- Most Nigerian filings use NGN (kobo if amounts <100, naira if amounts >=1 — judgment required)
- LSE-primary tickers (e.g. Airtel Africa) often file in GBP/GBp (pence)
- Always populate the currency field. If unclear, default to NGN.

DATES:
- Format as ISO 8601 YYYY-MM-DD
- If a date is stated as "Friday 8 May 2026", parse the date, not the day name
- If a date is referenced but absent, leave the field null

NUMBERS:
- DPS values: convert kobo to naira if needed (e.g. "50 kobo" -> 0.50)
- Large totals: state in absolute units (e.g. "N314.93bn" -> 314930000000), NOT scaled
- If a number is stated parenthetically ("bringing the total dividend for the year to N20"), capture the figure but note context in extraction_notes

SCHEMA per subcategory (only include the fields matching the chosen subcategory):

dividend: { dividend_type: "INTERIM"|"FINAL"|"PROPOSED"|"SPECIAL", dps: number|null, par_value_kobo: number|null, qualification_date: string|null, payment_date: string|null, register_close_start: string|null, register_close_end: string|null, agm_date: string|null, total_pool: number|null, period_end: string|null, withholding_tax_note: string|null }

agm_resolution: { meeting_date: string, resolutions: [{ type: string, text: string }], dividend_declared_dps: number|null, dividend_declared_total_pool: number|null, dividend_total_for_year: number|null, board_re_elected: string[], board_appointed: string[], board_resigned: string[], auditor_appointed: string|null, major_resolutions: string[] }

board_change: { director_name: string, position: string, action: "APPOINTED"|"RESIGNED"|"RE_ELECTED"|"CHANGED_ROLE", effective_date: string|null, reason: string|null }

rights_issue: { share_count: number, issue_price: number, par_value_kobo: number|null, ratio_new: number|null, ratio_existing: number|null, status: "PROPOSED"|"APPROVED"|"LISTED"|"COMPLETED", regulatory_approvals_pending: string[], announcement_date: string|null }

share_transaction: { transaction_type: "BUYBACK"|"TREASURY"|"CANCEL", shares_transacted: number, vwap_per_share: number|null, programme_total: number|null, programme_currency: string|null, shares_remaining_in_issue: number|null, voting_rights_total: number|null, transaction_date: string|null }

voting_rights: { total_shares_in_issue: number, voting_rights_total: number, treasury_shares: number|null, as_of_date: string|null }

mna: { counterparty: string, transaction_type: "ACQUISITION"|"MERGER"|"DISPOSAL"|"DIVESTITURE"|"JV"|"STRUCTURAL_SEPARATION", target_or_subject: string, value: number|null, status: "PROPOSED"|"APPROVED"|"REGULATORY_REVIEW"|"COMPLETED"|"WITHDRAWN", announcement_date: string|null }

earnings_release: { period_end: string, period_type: "FY"|"Q1"|"Q2"|"Q3"|"H1"|"H2", revenue: number|null, pat: number|null, eps: number|null, guidance: string|null }

closed_period: { closed_period_start: string|null, closed_period_end: string|null, reason: string|null }

press_release / governance_report / other: { summary: string }

OUTPUT FORMAT (return ONLY this JSON object, no preamble, no markdown fences):
{
  "subcategory": "<one of the values above>",
  "material_event": true | false,
  "facts": <object matching the subcategory's schema>,
  "currency": "NGN" | "GBP" | "GBp" | "USD" | null,
  "extraction_notes": "<2-3 sentence note explaining any ambiguity, low-confidence calls, or operator-relevant context>"
}

If the PDF text is empty, garbled, or you cannot classify with confidence, return:
{
  "subcategory": "other",
  "material_event": false,
  "facts": { "summary": "<best-effort summary of what little is readable>" },
  "currency": null,
  "extraction_notes": "<reason for low-confidence classification>"
}

DISCLOSURE TITLE: ${title}
FILING DATE: ${modifiedAt}
INSTRUMENT: ${ticker}

PDF TEXT:
${pdfText}
`
}

// ─────────────────────────────────────────────────────────────────
// PDF text fetch via Claude — now takes base64 data, not URL
// ─────────────────────────────────────────────────────────────────

async function fetchPdfTextViaClaude(
  client: Anthropic,
  pdfBase64: string,
): Promise<{ text: string; ok: boolean; error?: string }> {
  try {
    const resp = await client.messages.create({
      model: MODEL_NAME,
      max_tokens: 8000,
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

// ─────────────────────────────────────────────────────────────────
// Public extraction helper
// ─────────────────────────────────────────────────────────────────

export async function extractDisclosure(args: {
  pdfUrl: string
  title: string
  modifiedAt: string
  ticker: string
  client: Anthropic
}): Promise<DisclosureExtractionResult> {
  const { pdfUrl, title, modifiedAt, ticker, client } = args

  // Step 1: Download PDF as base64 (fix2: SDK doesn't support url type)
  const dl = await downloadPdfAsBase64(pdfUrl)
  if (!dl.ok) {
    return {
      status: 'fetch_failed',
      subcategory: null,
      material_event: false,
      facts: null,
      currency: null,
      extraction_notes: null,
      input_chars: 0,
      cost_estimate_usd: 0,
      model_used: null,
      error: dl.error,
    }
  }

  // Step 2: Get PDF text via Claude using base64 source
  const fetched = await fetchPdfTextViaClaude(client, dl.data)
  if (!fetched.ok) {
    return {
      status: 'fetch_failed',
      subcategory: null,
      material_event: false,
      facts: null,
      currency: null,
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
      subcategory: null,
      material_event: false,
      facts: null,
      currency: null,
      extraction_notes: 'PDF appears to be scanned/image-based with no machine-readable text.',
      input_chars: 0,
      cost_estimate_usd: 0,
      model_used: null,
    }
  }

  const pdfText = fetched.text.slice(0, MAX_INPUT_CHARS)

  // Step 3: Build extraction prompt and call Claude
  const prompt = buildPrompt(pdfText, title, modifiedAt, ticker)

  let resp
  try {
    resp = await client.messages.create({
      model: MODEL_NAME,
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    })
  } catch (e) {
    return {
      status: 'model_error',
      subcategory: null,
      material_event: false,
      facts: null,
      currency: null,
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
      subcategory: null,
      material_event: false,
      facts: null,
      currency: null,
      extraction_notes: null,
      input_chars: pdfText.length,
      cost_estimate_usd: 0,
      model_used: MODEL_NAME,
      error: 'no text block in extraction response',
    }
  }

  // Step 4: Parse JSON output (defensive: strip markdown fences if present)
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
      subcategory: null,
      material_event: false,
      facts: null,
      currency: null,
      extraction_notes: null,
      input_chars: pdfText.length,
      cost_estimate_usd: estimateCost(resp.usage),
      model_used: MODEL_NAME,
      error: 'extraction JSON parse failed: ' + (e instanceof Error ? e.message : String(e)),
    }
  }

  // Step 5: Validate shape
  const subcategory = parsed.subcategory as DisclosureSubcategory | undefined
  if (!subcategory || !isValidSubcategory(subcategory)) {
    return {
      status: 'model_error',
      subcategory: null,
      material_event: false,
      facts: null,
      currency: null,
      extraction_notes: null,
      input_chars: pdfText.length,
      cost_estimate_usd: estimateCost(resp.usage),
      model_used: MODEL_NAME,
      error: `invalid subcategory: ${String(subcategory)}`,
    }
  }

  return {
    status: 'extracted',
    subcategory,
    material_event: Boolean(parsed.material_event),
    facts: (parsed.facts as Record<string, unknown> | null) ?? null,
    currency: (parsed.currency as string | null) ?? null,
    extraction_notes: (parsed.extraction_notes as string | null) ?? null,
    input_chars: pdfText.length,
    cost_estimate_usd: estimateCost(resp.usage),
    model_used: MODEL_NAME,
  }
}

function isValidSubcategory(s: string): s is DisclosureSubcategory {
  return [
    'dividend',
    'agm_resolution',
    'board_change',
    'rights_issue',
    'share_transaction',
    'voting_rights',
    'mna',
    'earnings_release',
    'closed_period',
    'press_release',
    'governance_report',
    'other',
  ].includes(s)
}

function estimateCost(usage: { input_tokens?: number; output_tokens?: number } | undefined): number {
  if (!usage) return 0
  const inT = usage.input_tokens ?? 0
  const outT = usage.output_tokens ?? 0
  return inT * COST_PER_INPUT_TOKEN + outT * COST_PER_OUTPUT_TOKEN
}
