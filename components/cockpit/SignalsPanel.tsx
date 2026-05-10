'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { SignalSeverity, SignalType } from '@/lib/cockpit-signals'
import type { NarratedSignal } from '@/lib/cockpit-narrator'
import styles from './SignalsPanel.module.css'

// ─── Types ─────────────────────────────────────────────────────
//
// The route returns Signal & { narrated: NarratedSignal }. We accept
// the envelope shape directly here.

interface SignalEnvelope {
  id:                   string
  type:                 SignalType
  severity:             SignalSeverity
  primary_subject:      string
  primary_subject_kind: 'ticker' | 'portfolio' | 'mandate'
  affected_portfolios:  string[]
  evidence:             Record<string, unknown>
  suggested_action:     string
  narrated:             NarratedSignal
}

interface SignalsPanelProps {
  signals: SignalEnvelope[]
  loading: boolean
}

const VISIBLE_CAP = 7

// ─── Severity styling ──────────────────────────────────────────

const severityLabel: Record<SignalSeverity, string> = {
  red:   'Breach',
  amber: 'Attention',
  gold:  'Opportunity',
}

// ─── Skeleton (loading state) ──────────────────────────────────

function SignalsSkeleton() {
  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <div className={styles.panelTitle}>What demands attention</div>
        <div className={styles.panelMeta}>Loading…</div>
      </div>
      <div className={styles.cards}>
        {[0, 1, 2].map(i => (
          <div key={i} className={styles.skeletonCard}>
            <div className={styles.skelLine} style={{ width: '60%' }} />
            <div className={styles.skelLine} style={{ width: '90%' }} />
            <div className={styles.skelLine} style={{ width: '75%' }} />
          </div>
        ))}
      </div>
    </div>
  )
}

// ─── Empty state ───────────────────────────────────────────────

function SignalsEmpty() {
  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <div className={styles.panelTitle}>What demands attention</div>
        <div className={styles.panelMeta}>0 signals</div>
      </div>
      <div className={styles.empty}>
        Nothing on the firm book is firing today. The lower panels still
        carry the full mandate-by-mandate detail.
      </div>
    </div>
  )
}

// ─── Single card ───────────────────────────────────────────────

interface CardProps {
  signal: SignalEnvelope
  onClick: () => void
}

function SignalCard({ signal, onClick }: CardProps) {
  const headline = signal.narrated.headline || signal.suggested_action
  const body     = signal.narrated.body
  const callouts = signal.narrated.callouts

  return (
    <button
      type="button"
      className={`${styles.card} ${styles['card_' + signal.severity]}`}
      onClick={onClick}
    >
      <div className={styles.cardEdge} />
      <div className={styles.cardBody}>
        <div className={styles.cardTopRow}>
          <span className={`${styles.severityChip} ${styles['chip_' + signal.severity]}`}>
            {severityLabel[signal.severity]}
          </span>
          <span className={styles.cardSubject}>{signal.primary_subject}</span>
        </div>
        <div className={styles.headline}>{headline}</div>
        {body ? <div className={styles.body}>{body}</div> : null}
        {callouts.length > 0 ? (
          <div className={styles.callouts}>
            {callouts.map((c, idx) => (
              <span key={idx} className={styles.callout}>
                <span className={styles.calloutLabel}>{c.label}</span>
                <span className={styles.calloutValue}>{c.value}</span>
              </span>
            ))}
          </div>
        ) : null}
      </div>
    </button>
  )
}

// ─── Main panel ────────────────────────────────────────────────

export default function SignalsPanel({ signals, loading }: SignalsPanelProps) {
  const router = useRouter()
  const [expanded, setExpanded] = useState(false)

  const visible = useMemo(() => {
    return expanded ? signals : signals.slice(0, VISIBLE_CAP)
  }, [signals, expanded])

  const remaining = signals.length - VISIBLE_CAP

  if (loading) return <SignalsSkeleton />
  if (signals.length === 0) return <SignalsEmpty />

  // Counts by severity for the meta line
  const counts = signals.reduce(
    (acc, s) => {
      acc[s.severity]++
      return acc
    },
    { red: 0, amber: 0, gold: 0 } as Record<SignalSeverity, number>,
  )
  const metaParts: string[] = []
  if (counts.red   > 0) metaParts.push(counts.red   + ' breach')
  if (counts.amber > 0) metaParts.push(counts.amber + ' attention')
  if (counts.gold  > 0) metaParts.push(counts.gold  + ' opportunity')
  const metaLine = metaParts.join(' · ')

  function handleCardClick(signal: SignalEnvelope) {
    if (signal.primary_subject_kind === 'portfolio'
        || signal.primary_subject_kind === 'mandate') {
      router.push('/portfolio/' + signal.primary_subject)
      return
    }
    if (signal.primary_subject_kind === 'ticker') {
      // v27ax-fix4: route to NGX Watchlist with ticker as search param.
      // The watchlist page (also patched in fix4) reads ?ticker= and
      // pre-fills its search input so the row is visible on land. A
      // future per-instrument page (v27ay scope) will replace this.
      router.push('/watchlist?ticker=' + encodeURIComponent(signal.primary_subject))
      return
    }
  }

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <div className={styles.panelTitle}>What demands attention</div>
        <div className={styles.panelMeta}>{metaLine}</div>
      </div>
      <div className={styles.cards}>
        {visible.map(s => (
          <SignalCard key={s.id} signal={s} onClick={() => handleCardClick(s)} />
        ))}
      </div>
      {remaining > 0 && !expanded ? (
        <button
          type="button"
          className={styles.expander}
          onClick={() => setExpanded(true)}
        >
          Show all ({remaining} more)
        </button>
      ) : null}
      {expanded && signals.length > VISIBLE_CAP ? (
        <button
          type="button"
          className={styles.expander}
          onClick={() => setExpanded(false)}
        >
          Show top {VISIBLE_CAP} only
        </button>
      ) : null}
    </div>
  )
}
