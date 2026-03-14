'use client'
import { useState } from 'react'
import { Printer, Copy, Check } from 'lucide-react'

interface PageActionsProps {
  pageTitle: string
  portfolioName: string
  getText: () => string
}

function buildPrintHTML(portfolioName: string, pageTitle: string, text: string): string {
  const date = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })

  // Convert plain text to simple HTML — preserve structure
  const body = text
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .split('\n')
    .map(line => {
      if (line.startsWith('──') || line.startsWith('─'.repeat(10))) {
        return `<hr style="border:none;border-top:1px solid #ddd;margin:12px 0;">`
      }
      if (line.trim() === '') return '<br>'
      // Bold lines that look like section headers (all caps or starts with ──)
      if (/^[A-Z][A-Z\s&:()\/]+$/.test(line.trim()) && line.trim().length > 3) {
        return `<p style="font-weight:700;color:#0f1923;margin:16px 0 4px;font-size:10pt;letter-spacing:0.05em;">${line}</p>`
      }
      return `<p style="margin:2px 0;font-size:10pt;line-height:1.6;color:#333;">${line}</p>`
    })
    .join('\n')

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${portfolioName} — ${pageTitle}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', Arial, sans-serif;
      background: white;
      color: #111;
      font-size: 10pt;
      line-height: 1.6;
    }
    .page-header {
      background: #0f1923;
      color: white;
      padding: 24px 40px;
      border-bottom: 3px solid #c9a84c;
      margin-bottom: 32px;
    }
    .page-header .firm { font-size: 9pt; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #c9a84c; margin-bottom: 6px; }
    .page-header .title { font-size: 20pt; font-weight: 700; color: white; margin-bottom: 4px; }
    .page-header .subtitle { font-size: 11pt; color: #8a91a8; }
    .content { padding: 0 40px 40px; }
    @media print {
      @page { size: A4; margin: 15mm 15mm 15mm 15mm; }
      .page-header { margin-bottom: 20px; padding: 16px 0; background: none !important; border-bottom: 2px solid #c9a84c; }
      .page-header .firm { color: #c9a84c !important; }
      .page-header .title { color: #0f1923 !important; font-size: 16pt; }
      .page-header .subtitle { color: #555 !important; }
      .content { padding: 0; }
      .no-print { display: none !important; }
      p { orphans: 3; widows: 3; }
    }
    .print-btn {
      position: fixed; top: 20px; right: 20px;
      background: #a78bfa; color: white; border: none; border-radius: 8px;
      padding: 10px 20px; font-size: 12px; font-weight: 600; cursor: pointer;
      font-family: inherit;
    }
    .print-btn:hover { background: #9b87e8; }
  </style>
</head>
<body>
  <button class="print-btn no-print" onclick="window.print()">🖨 Print / Save PDF</button>
  <div class="page-header">
    <div class="firm">Transworld Asset Management — Portfolio Intelligence</div>
    <div class="title">${portfolioName}</div>
    <div class="subtitle">${pageTitle} &nbsp;·&nbsp; ${date}</div>
  </div>
  <div class="content">
    ${body}
  </div>
</body>
</html>`
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
    ].join('\n')
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2500)
  }

  function handlePrint() {
    const html = buildPrintHTML(portfolioName, pageTitle, getText())
    const win = window.open('', '_blank', 'width=900,height=700')
    if (win) {
      win.document.write(html)
      win.document.close()
      // Auto-trigger print after content loads
      win.onload = () => win.print()
    }
  }

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={handleCopy}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all border"
        style={copied
          ? { background: '#22c55e18', color: '#22c55e', borderColor: '#22c55e40' }
          : { background: 'transparent', color: '#8a91a8', borderColor: 'rgba(255,255,255,0.1)' }}>
        {copied ? <><Check size={12} /> Copied!</> : <><Copy size={12} /> Copy as text</>}
      </button>
      <button
        onClick={handlePrint}
        className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all"
        style={{ background: '#a78bfa', color: '#fff' }}>
        <Printer size={12} /> Print / PDF
      </button>
    </div>
  )
}
