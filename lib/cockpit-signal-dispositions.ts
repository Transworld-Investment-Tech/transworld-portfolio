// ═══════════════════════════════════════════════════════════════
// lib/cockpit-signal-dispositions.ts (v27ay)
// ═══════════════════════════════════════════════════════════════
//
// Types + helpers for the per-card cockpit signal disposition
// toggle (dismiss / acted-on). Storage layer is Supabase
// (table: cockpit_signal_dispositions). Day-scoped reset: each
// row's effective scope is its as_of_date column.
//
// The day key derivation here MUST match the signals localStorage
// cache in app/page.tsx (v27ax-fix4) so that client and server
// agree on what "today" is. Both use UTC date.
// ═══════════════════════════════════════════════════════════════

export type Disposition = 'dismissed' | 'acted_on'
export type DispositionMap = Record<string, Disposition | undefined>

export interface DispositionRecord {
  signal_id:   string
  as_of_date:  string
  disposition: Disposition
  set_at:      string
}

// UTC-day key (YYYY-MM-DD). Matches new Date().toISOString().slice(0, 10)
// used by the signals cache. Day rollover is midnight UTC = 1am Lagos.
// If that's ever wrong for the operator's morning triage, switch to an
// Africa/Lagos-aware derivation here and the cache key in app/page.tsx
// in lockstep.
export function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10)
}
