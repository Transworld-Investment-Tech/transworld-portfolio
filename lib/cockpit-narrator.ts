// ═══════════════════════════════════════════════════════════════
// COCKPIT NARRATOR (v27ax)
// ═══════════════════════════════════════════════════════════════
//
// Wraps deterministic signals (lib/cockpit-signals.ts) in operator-voice
// prose. ONE batch Claude call per cockpit load — bounded cost, fast
// enough to fit inside the cockpit's parallel fetch budget.
//
// Architectural invariant: Claude NEVER invents numbers. Every NGN
// figure, %, ticker code, and mandate label in the rendered output
// MUST appear in the upstream Signal.evidence object. The prompt is
// engineered to make the model quote-and-frame, not compute.
//
// Fallback path: if the Claude response fails to parse or returns
// fewer signals than requested, we fall back to engine-generated
// suggested_action plus a stripped-evidence rendering on a per-signal
// basis. This means a model outage degrades gracefully — the panel
// still renders, just with terser copy.
// ═══════════════════════════════════════════════════════════════

import Anthropic from '@anthropic-ai/sdk'
import type { Signal } from './cockpit-signals'

export interface NarratedSignal {
  id:        string
  headline:  string                   // 6-12 words, action-oriented
  body:      string                   // 2-3 sentences, operator voice
  callouts:  Array<{ label: string; value: string }>
}

export interface NarratorContext {
  asOfDate:        string             // ISO yyyy-mm-dd
  firmAumNgnFmt:   string             // e.g. "₦773.43M"
  activeMandates:  number
}

const MODEL = 'claude-sonnet-4-20250514'
const MAX_TOKENS = 1500

// System prompt: defines the role, register, and the inviolable rule
// (never invent numbers; quote evidence verbatim).
const SYSTEM_PROMPT = `You are an internal analyst writing for the CIO of a Nigerian discretionary asset manager. You are NOT writing for clients — you are writing notes the CIO will read in the morning before NGX opens to triage 20 mandates in 30 minutes.

Voice: terse, analyst-density, no padding, no platitudes. The CIO has years of context — do not over-explain. Use NGX-trader vocabulary where it fits naturally.

CRITICAL RULE: Every number, ticker, percentage, and mandate code in your output MUST be quoted verbatim from the structured evidence object provided for each signal. Do NOT compute, round, infer, or invent any figure. If the evidence does not contain a number, do not mention that number. This rule is absolute.

For each signal, write:
- headline: 6-12 words, action-oriented (what demands attention or what to consider)
- body: 2-3 sentences. Frame the situation, name the evidence, end on the implication. AVOID telegraphic phrases like "rally on conviction or chase risk" or "entry opportunity or signal to skip". Instead, lay out the actual decision the CIO faces in plain language (e.g., "decide whether this dislocation is buyable or thesis-breaking", "confirm whether to add at this level or treat as already priced in").
- callouts: 1-3 short label:value pairs the CIO can scan instantly (e.g., mandate codes, key NGN amounts, % moves). Use the formatted strings from evidence.

Output format: a single JSON object with shape:
{
  "narrations": {
    "<signal_id>": {
      "headline": "...",
      "body": "...",
      "callouts": [{"label": "...", "value": "..."}, ...]
    },
    ...
  }
}

Return ONLY the JSON object. No preamble, no markdown fences, no commentary.`

function buildUserPrompt(signals: Signal[], context: NarratorContext): string {
  const parts: string[] = []

  parts.push('As of ' + context.asOfDate + '. Firm AUM ' + context.firmAumNgnFmt
    + ' across ' + context.activeMandates + ' active mandates.')
  parts.push('')
  parts.push('Narrate the following signals. Quote every number from the evidence object verbatim.')
  parts.push('')

  for (const s of signals) {
    parts.push('---')
    parts.push('signal_id: ' + s.id)
    parts.push('type: ' + s.type)
    parts.push('severity: ' + s.severity)
    parts.push('primary_subject: ' + s.primary_subject + ' (' + s.primary_subject_kind + ')')
    parts.push('engine_suggested_action: ' + s.suggested_action)
    parts.push('evidence:')
    parts.push(JSON.stringify(s.evidence, null, 2))
  }
  parts.push('---')
  parts.push('')
  parts.push('Return the JSON object now.')

  return parts.join('\n')
}

function fallbackForSignal(s: Signal): NarratedSignal {
  // Engine-only fallback when Claude is unavailable or returns malformed output.
  // We use the suggested_action plus a few stripped evidence highlights.
  const callouts: Array<{ label: string; value: string }> = []
  const ev = s.evidence as Record<string, unknown>

  // Best-effort labels per signal type. Never invents — only reads what's there.
  if (s.type === 'concentration_thread') {
    if (typeof ev.ticker === 'string') {
      callouts.push({ label: 'Ticker', value: ev.ticker })
    }
    if (typeof ev.weekly_change_fmt === 'string') {
      callouts.push({ label: 'Weekly', value: ev.weekly_change_fmt })
    }
    if (Array.isArray(ev.breaching_mandates) && ev.breaching_mandates.length > 0) {
      const first = ev.breaching_mandates[0] as Record<string, unknown>
      if (typeof first.mandate_label === 'string' && typeof first.pct_of_nav_fmt === 'string') {
        callouts.push({ label: first.mandate_label, value: first.pct_of_nav_fmt })
      }
    }
  } else if (s.type === 'outsized_return_low_cash') {
    if (typeof ev.mandate_label === 'string') {
      callouts.push({ label: 'Mandate', value: ev.mandate_label })
    }
    if (typeof ev.ytd_return_fmt === 'string') {
      callouts.push({ label: 'YTD', value: ev.ytd_return_fmt })
    }
    if (typeof ev.cash_pct_fmt === 'string') {
      callouts.push({ label: 'Cash', value: ev.cash_pct_fmt })
    }
  } else if (s.type === 'watchlist_opportunity') {
    if (typeof ev.ticker === 'string') {
      callouts.push({ label: 'Ticker', value: ev.ticker })
    }
    if (typeof ev.change_fmt === 'string') {
      callouts.push({ label: 'Today', value: ev.change_fmt })
    }
    if (typeof ev.sector === 'string') {
      callouts.push({ label: 'Sector', value: ev.sector })
    }
  } else if (s.type === 'stale_material_mandate') {
    if (typeof ev.mandate_label === 'string') {
      callouts.push({ label: 'Mandate', value: ev.mandate_label })
    }
    if (typeof ev.days_overdue === 'number') {
      callouts.push({ label: 'Overdue', value: ev.days_overdue + 'd' })
    }
    if (typeof ev.ytd_return_fmt === 'string') {
      callouts.push({ label: 'YTD', value: ev.ytd_return_fmt })
    }
  } else if (s.type === 'fee_divergence') {
    if (typeof ev.mandate_label === 'string') {
      callouts.push({ label: 'Mandate', value: ev.mandate_label })
    }
    if (typeof ev.excess_pct_fmt === 'string') {
      callouts.push({ label: 'Excess', value: ev.excess_pct_fmt })
    }
    if (typeof ev.projected_year_end_fee_fmt === 'string') {
      callouts.push({ label: 'Proj. fee', value: ev.projected_year_end_fee_fmt })
    }
  }

  return {
    id: s.id,
    headline: s.suggested_action,
    body: '',
    callouts,
  }
}

interface ClaudeJsonResponse {
  narrations: Record<string, {
    headline?: string
    body?: string
    callouts?: Array<{ label?: string; value?: string }>
  }>
}

function parseClaudeText(text: string): ClaudeJsonResponse | null {
  // Strip code fences defensively even though the prompt forbids them
  let t = text.trim()
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')
  try {
    const parsed = JSON.parse(t)
    if (typeof parsed === 'object' && parsed !== null
        && typeof (parsed as ClaudeJsonResponse).narrations === 'object') {
      return parsed as ClaudeJsonResponse
    }
    return null
  } catch {
    return null
  }
}

export async function narrateSignals(
  signals: Signal[],
  context: NarratorContext
): Promise<Map<string, NarratedSignal>> {
  const result = new Map<string, NarratedSignal>()

  if (signals.length === 0) return result

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    // No key configured — fall back across the board
    for (const s of signals) result.set(s.id, fallbackForSignal(s))
    return result
  }

  let claudeText = ''
  try {
    const client = new Anthropic({ apiKey })
    const resp = await client.messages.create({
      model:       MODEL,
      max_tokens:  MAX_TOKENS,
      system:      SYSTEM_PROMPT,
      messages: [{ role: 'user', content: buildUserPrompt(signals, context) }],
    })
    for (const block of resp.content) {
      if (block.type === 'text') claudeText += block.text
    }
  } catch {
    // Network / API error — fall back across the board
    for (const s of signals) result.set(s.id, fallbackForSignal(s))
    return result
  }

  const parsed = parseClaudeText(claudeText)
  if (!parsed) {
    for (const s of signals) result.set(s.id, fallbackForSignal(s))
    return result
  }

  // Per-signal: take Claude's narration if present, else fall back
  for (const s of signals) {
    const narr = parsed.narrations[s.id]
    if (narr && typeof narr.headline === 'string' && typeof narr.body === 'string') {
      const callouts: Array<{ label: string; value: string }> = []
      if (Array.isArray(narr.callouts)) {
        for (const c of narr.callouts) {
          if (c && typeof c.label === 'string' && typeof c.value === 'string') {
            callouts.push({ label: c.label, value: c.value })
          }
        }
      }
      result.set(s.id, {
        id:       s.id,
        headline: narr.headline,
        body:     narr.body,
        callouts,
      })
    } else {
      result.set(s.id, fallbackForSignal(s))
    }
  }

  return result
}
