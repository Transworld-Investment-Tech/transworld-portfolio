'use client'

import { useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import type { SignalSeverity, SignalType } from '@/lib/cockpit-signals'
import type { NarratedSignal } from '@/lib/cockpit-narrator'
import type { Disposition, DispositionMap } from '@/lib/cockpit-signal-dispositions'
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
  // v27ay: per-signal disposition map (dismissed / acted_on / undefined)
  // and the optimistic-update callback. Page-level state lives in
  // app/page.tsx; the panel is purely controlled.
  dispositions: DispositionMap
  onDispositionChange: (signalId: string, disposition: Disposition | null) => void
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
  disposition: Disposition | undefined
  onClick: () => void
  onDispositionChange: (signalId: string, disposition: Disposition | null) => void
  // v27ay: when true, render only the restore button (used in the
  // dismissed-cards footer expansion). Default behavior shows the
  // dismiss + acted-on pair.
  showRestoreOnly?: boolean
}

function SignalCard({
  signal,
  disposition,
  onClick,
  onDispositionChange,
  showRestoreOnly = false,
}: CardProps) {
  const headline = signal.narrated.headline || signal.suggested_action
  const body     = signal.narrated.body
  const callouts = signal.narrated.callouts
  const isActed  = disposition === 'acted_on'

  const cardClassName = [
    styles.card,
    styles['card_' + signal.severity],
    isActed ? styles.acted : '',
  ].filter(Boolean).join(' ')

  // v27ay: card is now <div role="button"> (not <button>) so we can
  // nest the disposition control buttons inside without violating the
  // HTML "no nested buttons" rule. Click + Enter/Space keyboard
  // navigation preserved.
  return (
    <div
      role="button"
      tabIndex={0}
      className={cardClassName}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
    >
      <div className={styles.cardEdge} />
      <div className={styles.dispositionBtns}>
        {showRestoreOnly ? (
          <button
            type="button"
            className={`${styles.dispoBtn} ${styles.dispoBtnRestore}`}
            onClick={(e) => {
              e.stopPropagation()
              e.preventDefault()
              onDispositionChange(signal.id, null)
            }}
            title="Restore"
            aria-label="Restore signal"
          >
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none">
              <path d="M3 7a4 4 0 1 1 1.2 2.85" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" fill="none"/>
              <path d="M3 4v3h3" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" fill="none"/>
            </svg>
          </button>
        ) : (
          <>
            <button
              type="button"
              className={`${styles.dispoBtn} ${styles.dispoBtnAct} ${isActed ? styles.dispoBtnActive : ''}`}
              onClick={(e) => {
                e.stopPropagation()
                e.preventDefault()
                onDispositionChange(signal.id, isActed ? null : 'acted_on')
              }}
              title={isActed ? 'Un-mark acted on' : 'Mark acted on'}
              aria-label={isActed ? 'Un-mark acted on' : 'Mark acted on'}
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M2.5 6L5 8.5L9.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
            <button
              type="button"
              className={`${styles.dispoBtn} ${styles.dispoBtnDismiss}`}
              onClick={(e) => {
                e.stopPropagation()
                e.preventDefault()
                onDispositionChange(signal.id, 'dismissed')
              }}
              title="Dismiss for today"
              aria-label="Dismiss signal"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
                <path d="M3 3L9 9M9 3L3 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
              </svg>
            </button>
          </>
        )}
      </div>
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
    </div>
  )
}

// ─── Main panel ────────────────────────────────────────────────

export default function SignalsPanel({
  signals,
  loading,
  dispositions,
  onDispositionChange,
}: SignalsPanelProps) {
  const router = useRouter()
  const [expanded, setExpanded] = useState(false)
  const [showDismissed, setShowDismissed] = useState(false)

  // v27ay: split signals by disposition. Dismissed cards go to a footer
  // section (hidden by default, expandable). Acted-on cards stay in the
  // main grid with a muted style.
  const { mainSignals, dismissedSignals } = useMemo(() => {
    const main: SignalEnvelope[] = []
    const dismissed: SignalEnvelope[] = []
    for (const s of signals) {
      if (dispositions[s.id] === 'dismissed') dismissed.push(s)
      else main.push(s)
    }
    return { mainSignals: main, dismissedSignals: dismissed }
  }, [signals, dispositions])

  const visible = useMemo(() => {
    return expanded ? mainSignals : mainSignals.slice(0, VISIBLE_CAP)
  }, [mainSignals, expanded])

  const remaining = mainSignals.length - VISIBLE_CAP

  if (loading) return <SignalsSkeleton />
  if (signals.length === 0) return <SignalsEmpty />

  // v27ay: counts based on main grid only (excludes dismissed); meta
  // line stays accurate after the operator hides cards.
  const counts = mainSignals.reduce(
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
      // future per-instrument page (v27ay scope item 3) will replace this.
      router.push('/watchlist?ticker=' + encodeURIComponent(signal.primary_subject))
      return
    }
  }

  // v27ay: if everything is dismissed, show a friendlier near-empty state.
  const allDismissed = mainSignals.length === 0 && dismissedSignals.length > 0

  return (
    <div className={styles.panel}>
      <div className={styles.panelHeader}>
        <div className={styles.panelTitle}>What demands attention</div>
        <div className={styles.panelMeta}>
          {allDismissed
            ? `all ${dismissedSignals.length} dismissed today`
            : metaLine}
        </div>
      </div>
      {allDismissed ? (
        <div className={styles.empty}>
          You&apos;ve dismissed everything for today. The lower panels still
          carry the full mandate-by-mandate detail.
        </div>
      ) : (
        <div className={styles.cards}>
          {visible.map(s => (
            <SignalCard
              key={s.id}
              signal={s}
              disposition={dispositions[s.id]}
              onClick={() => handleCardClick(s)}
              onDispositionChange={onDispositionChange}
            />
          ))}
        </div>
      )}
      {remaining > 0 && !expanded ? (
        <button
          type="button"
          className={styles.expander}
          onClick={() => setExpanded(true)}
        >
          Show all ({remaining} more)
        </button>
      ) : null}
      {expanded && mainSignals.length > VISIBLE_CAP ? (
        <button
          type="button"
          className={styles.expander}
          onClick={() => setExpanded(false)}
        >
          Show top {VISIBLE_CAP} only
        </button>
      ) : null}
      {dismissedSignals.length > 0 ? (
        <div className={styles.dismissedFooter}>
          <button
            type="button"
            className={styles.dismissedFooterBtn}
            onClick={() => setShowDismissed(s => !s)}
          >
            {dismissedSignals.length} dismissed today · {showDismissed ? 'hide' : 'show'}
          </button>
          {showDismissed ? (
            <div className={styles.dismissedList}>
              {dismissedSignals.map(s => (
                <SignalCard
                  key={s.id}
                  signal={s}
                  disposition={dispositions[s.id]}
                  onClick={() => handleCardClick(s)}
                  onDispositionChange={onDispositionChange}
                  showRestoreOnly
                />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
