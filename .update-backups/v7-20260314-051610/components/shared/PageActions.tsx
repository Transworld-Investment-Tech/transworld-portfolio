'use client'
import { useState } from 'react'
import { Printer, Copy, Check } from 'lucide-react'

interface PageActionsProps {
  pageTitle: string
  portfolioName: string
  getText: () => string
}

export default function PageActions({ pageTitle, portfolioName, getText }: PageActionsProps) {
  const [copied, setCopied] = useState(false)

  function handleCopy() {
    const date = new Date().toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    })
    const text = [
      `TRANSWORLD ASSET MANAGEMENT`,
      `${portfolioName} — ${pageTitle}`,
      `Exported: ${date}`,
      `${'─'.repeat(60)}`,
      '',
      getText(),
      '',
      `${'─'.repeat(60)}`,
      `Source: Transworld Portfolio Intelligence`,
    ].join('\n')
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2500)
  }

  return (
    <div className="flex items-center gap-2 no-print">
      <button
        onClick={handleCopy}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all border"
        style={copied
          ? { background: '#22c55e18', color: '#22c55e', borderColor: '#22c55e40' }
          : { background: 'transparent', color: '#8a91a8', borderColor: 'rgba(255,255,255,0.1)' }}>
        {copied ? <><Check size={12} /> Copied!</> : <><Copy size={12} /> Copy as text</>}
      </button>
      <button
        onClick={() => window.print()}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
        style={{ background: '#a78bfa', color: '#fff' }}>
        <Printer size={12} /> Print / PDF
      </button>
    </div>
  )
}
