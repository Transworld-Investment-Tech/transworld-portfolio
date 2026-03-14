'use client'
import { useState } from 'react'
import { Printer, Copy, Check } from 'lucide-react'

interface PageActionsProps {
  pageTitle: string
  portfolioName: string
  getText: () => string
}

function textToHTML(portfolioName: string, pageTitle: string, text: string): string {
  const date = new Date().toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  })

  // Parse the structured text into HTML sections and tables
  const lines = text.split('\n')
  const bodyParts: string[] = []
  let inTable = false
  let tableRows: string[] = []
  let tableHeaders: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // Section dividers (── SECTION NAME ──)
    if (line.startsWith('──') || line.startsWith('─'.repeat(8))) {
      if (inTable) {
        bodyParts.push(buildTable(tableHeaders, tableRows))
        inTable = false; tableRows = []; tableHeaders = []
      }
      const sectionName = line.replace(/─/g, '').trim()
      if (sectionName) {
        bodyParts.push('<div class="section-title">' + sectionName + '</div>')
      } else {
        bodyParts.push('<hr>')
      }
      continue
    }

    // Table rows (pipe-separated like "Col1 | Col2 | Col3")
    if (line.includes(' | ') && !line.startsWith('  ')) {
      const cells = line.split(' | ')
      if (!inTable) {
        inTable = true
        tableHeaders = cells
      } else {
        tableRows.push(cells.join('|||'))
      }
      continue
    }

    // End table if we hit something else
    if (inTable) {
      bodyParts.push(buildTable(tableHeaders, tableRows))
      inTable = false; tableRows = []; tableHeaders = []
    }

    // Key: Value lines
    if (/^[A-Z][A-Z\s&\/()]+:\s+.+/.test(line) && line.length < 120) {
      const colonIdx = line.indexOf(':')
      const key = line.slice(0, colonIdx).trim()
      const val = line.slice(colonIdx + 1).trim()
      bodyParts.push(
        '<div class="kv-row"><span class="kv-key">' + key + '</span><span class="kv-val">' + val + '</span></div>'
      )
      continue
    }

    // Empty lines
    if (line.trim() === '') {
      bodyParts.push('<div class="gap"></div>')
      continue
    }

    // Regular lines
    bodyParts.push('<p>' + line + '</p>')
  }

  // Flush any remaining table
  if (inTable) bodyParts.push(buildTable(tableHeaders, tableRows))

  const body = bodyParts.join('\n')

  const css = `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', Arial, sans-serif; background: #f0f2f5; color: #111; font-size: 10pt; line-height: 1.6; }
    .page { max-width: 960px; margin: 0 auto; background: white; min-height: 100vh; }
    .header { background: #0f1923; padding: 28px 40px; border-bottom: 4px solid #c9a84c; }
    .firm { font-size: 9pt; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #c9a84c; margin-bottom: 6px; }
    .port-name { font-size: 20pt; font-weight: 700; color: white; margin-bottom: 4px; }
    .page-title { font-size: 12pt; color: #8a91a8; margin-bottom: 2px; }
    .gen-date { font-size: 9pt; color: #555d72; }
    .content { padding: 32px 40px 48px; }
    .section-title { font-size: 9pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #c9a84c; border-bottom: 1px solid #e5e7eb; padding-bottom: 5px; margin: 24px 0 12px; }
    .section-title:first-child { margin-top: 0; }
    hr { border: none; border-top: 1px solid #e5e7eb; margin: 16px 0; }
    .gap { height: 6px; }
    p { margin: 3px 0; color: #374151; font-size: 10pt; }
    .kv-row { display: flex; padding: 5px 0; border-bottom: 1px solid #f3f4f6; gap: 16px; }
    .kv-key { font-weight: 600; color: #374151; min-width: 200px; font-size: 9.5pt; text-transform: uppercase; letter-spacing: 0.04em; font-size: 8.5pt; }
    .kv-val { color: #111; font-family: monospace; font-size: 10pt; }
    table { width: 100%; border-collapse: collapse; margin: 8px 0 16px; font-size: 9pt; }
    th { background: #f3f4f6; font-weight: 700; text-align: left; padding: 8px 10px; border-bottom: 2px solid #e5e7eb; color: #374151; font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.04em; white-space: nowrap; }
    td { padding: 6px 10px; border-bottom: 1px solid #f3f4f6; color: #374151; vertical-align: top; }
    tr:last-child td { border-bottom: none; }
    td:first-child { font-weight: 500; }
    .footer { background: #f9fafb; padding: 16px 40px; border-top: 1px solid #e5e7eb; font-size: 8pt; color: #6b7280; }
    .pbtn { position: fixed; bottom: 24px; right: 24px; background: #a78bfa; color: white; border: none; border-radius: 8px; padding: 12px 24px; font-size: 12px; font-weight: 600; cursor: pointer; font-family: inherit; box-shadow: 0 4px 12px rgba(167,139,250,0.4); }
    .pbtn:hover { background: #9b87e8; }
    @media print {
      @page { size: A4; margin: 12mm; }
      body { background: white; }
      .page { max-width: 100%; }
      .pbtn { display: none !important; }
      .header { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      th { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      table { page-break-inside: auto; }
      tr { page-break-inside: avoid; }
      .section-title { page-break-after: avoid; }
    }
  `

  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
    '<title>' + portfolioName + ' — ' + pageTitle + '</title>' +
    '<style>' + css + '</style></head><body>' +
    '<div class="page">' +
    '<div class="header">' +
    '<div class="firm">Transworld Asset Management — Portfolio Intelligence</div>' +
    '<div class="port-name">' + portfolioName + '</div>' +
    '<div class="page-title">' + pageTitle + '</div>' +
    '<div class="gen-date">Generated: ' + date + '</div>' +
    '</div>' +
    '<div class="content">' + body + '</div>' +
    '<div class="footer">Transworld Asset Management &nbsp;·&nbsp; Confidential &nbsp;·&nbsp; ' + date + '</div>' +
    '</div>' +
    '<button class="pbtn" onclick="window.print()">🖨 Print / Save PDF</button>' +
    '</body></html>'
}

function buildTable(headers: string[], rows: string[]): string {
  if (!headers.length) return ''
  const thead = '<thead><tr>' + headers.map(h => '<th>' + h.trim() + '</th>').join('') + '</tr></thead>'
  const tbody = '<tbody>' + rows.map(row => {
    const cells = row.split('|||')
    return '<tr>' + cells.map(c => '<td>' + c.trim() + '</td>').join('') + '</tr>'
  }).join('') + '</tbody>'
  return '<table>' + thead + tbody + '</table>'
}

export default function PageActions({ pageTitle, portfolioName, getText }: PageActionsProps) {
  const [copied, setCopied] = useState(false)

  function handleCopy() {
    const date = new Date().toLocaleDateString('en-GB', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    })
    const text = 'TRANSWORLD ASSET MANAGEMENT\n' + portfolioName + ' — ' + pageTitle + '\nExported: ' + date + '\n' + '─'.repeat(60) + '\n\n' + getText()
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2500)
  }

  function handlePrint() {
    const html = textToHTML(portfolioName, pageTitle, getText())
    const win = window.open('', '_blank', 'width=1024,height=800')
    if (win) { win.document.write(html); win.document.close() }
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
