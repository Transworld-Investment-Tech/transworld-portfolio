'use client'

// ============================================================
// PrintButton — v27x: tiny client island for window.print()
// ============================================================
// Used on the retired-shares page (and potentially others) to give the
// operator a printable artifact for registrar follow-up. Lives as a
// standalone client subcomponent so the parent page stays server-
// rendered (smaller blast radius than flipping the whole page to
// 'use client').
//
// The actual print styling lives on the parent page in a <style> block
// gated to @media print. This component is just the trigger.
// ============================================================

import { Printer } from 'lucide-react'

export default function PrintButton({ label = 'Print / Save as PDF' }: { label?: string }) {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="btn-h no-print"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
    >
      <Printer size={12} /> {label}
    </button>
  )
}
