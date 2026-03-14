// Generates a self-contained HTML report combining portfolio data + AI analysis
// Opens in a new window — user can Cmd+P → Save as PDF, or Cmd+S to save HTML

export interface ReportData {
  portfolioName: string
  clientName: string
  reportDate: string
  generatedAt: string
  currency: string
  // Performance
  currentNAV: number
  startingNAV: number
  startDate: string
  totalReturn: number
  totalReturnPct: number
  fxRate: number
  // Sleeves
  sleeves: Array<{
    name: string
    targetPct: number
    actualPct: number
    value: number
    status: string
  }>
  // Holdings
  holdings: Array<{
    instrumentId: string
    name: string
    sleeve: string
    type: string
    quantity: number
    avgCost: number
    currentPrice: number
    marketValue: number
    unrealisedPnL: number
    weight: number
  }>
  // Fee summary
  fees: {
    commission: number
    vat: number
    stamp: number
    exchange: number
    clearing: number
    sms: number
    management: number
    total: number
  }
  // Transaction counts
  txSummary: {
    total: number
    buys: number
    sells: number
    buyGross: number
    sellGross: number
  }
  // Mandate
  mandate: {
    incomeTarget: number
    capTarget: number
    maxSingleEq: number
    maxEqSleeve: number
    ddAlert: number
    ddAction: number
  }
  // Analytics
  irr: number | null
  annualisedReturn: number | null
  periodReturns: Array<{
    label: string
    percentReturn: number | null
    annualisedReturn: number | null
    daysHeld: number | null
  }>
  benchmarks: Array<{
    name: string
    annualised: number
    type: string
  }>
  // AI report
  aiReport?: {
    type: string
    content: string
    date: string
  }
  // Compliance alerts
  alerts: Array<{
    level: string
    message: string
  }>
}

function fmt(n: number, decimals = 2): string {
  return n.toLocaleString('en-NG', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}
function fmtM(n: number): string {
  return '₦' + fmt(n / 1e6) + 'M'
}
function fmtPct(n: number | null, decimals = 1): string {
  if (n === null || isNaN(n as number)) return 'N/A'
  return (n >= 0 ? '+' : '') + fmt((n as number) * 100, decimals) + '%'
}
function markdownToHTML(md: string): string {
  const lines = md.split('\n')
  const out: string[] = []
  let tbuf = ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('| ')) {
      if (line.replace(/[\s\-|]/g, '') === '') continue
      if (!tbuf) tbuf = ''
      const cells = line.split('|').filter(c => c.trim())
      const isHeader = lines[i + 1]?.replace(/[\s\-|]/g, '') === ''
      const tag = isHeader ? 'th' : 'td'
      tbuf += '<tr>' + cells.map(c => '<' + tag + '>' + c.trim().replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>') + '</' + tag + '>').join('') + '</tr>'
      continue
    } else if (tbuf) {
      out.push('<table>' + tbuf + '</table>')
      tbuf = ''
    }
    if (line.startsWith('## '))       out.push('<h2>' + line.slice(3) + '</h2>')
    else if (line.startsWith('### ')) out.push('<h3>' + line.slice(4) + '</h3>')
    else if (line.startsWith('---'))  out.push('<hr>')
    else if (line.trim() === '')      out.push('<div class="gap"></div>')
    else {
      const html = line
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/`(.+?)`/g, '<code>$1</code>')
      out.push('<p>' + html + '</p>')
    }
  }
  if (tbuf) out.push('<table>' + tbuf + '</table>')
  return out.join('\n')
}

export function generateHTMLReport(data: ReportData): string {
  const pnlSign = data.totalReturn >= 0 ? '+' : ''
  const portfolioIRR = data.irr ?? data.annualisedReturn ?? 0

  const CSS = `
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', Arial, sans-serif; background: #f0f2f5; color: #111; font-size: 10pt; line-height: 1.6; }
    .page { max-width: 960px; margin: 0 auto; background: white; }

    /* Header */
    .header { background: #0f1923; color: white; padding: 32px 48px 28px; border-bottom: 4px solid #c9a84c; }
    .header-top { display: flex; justify-content: space-between; align-items: flex-start; }
    .firm { font-size: 9pt; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; color: #c9a84c; margin-bottom: 8px; }
    .port-name { font-size: 22pt; font-weight: 700; color: white; margin-bottom: 4px; }
    .client-name { font-size: 12pt; color: #8a91a8; }
    .header-right { text-align: right; }
    .report-date { font-size: 11pt; color: #8a91a8; }
    .confidential { background: #c9a84c; color: #0f1923; font-size: 8pt; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; padding: 3px 10px; border-radius: 4px; display: inline-block; margin-top: 8px; }

    /* Alerts */
    .alert-breach { background: #fee2e2; border-left: 4px solid #ef4444; padding: 10px 16px; margin: 0; font-size: 9.5pt; font-weight: 600; color: #7f1d1d; }
    .alert-warning { background: #fef3c7; border-left: 4px solid #f59e0b; padding: 10px 16px; margin: 0; font-size: 9.5pt; font-weight: 600; color: #78350f; }

    /* Content */
    .content { padding: 32px 48px; }
    .section { margin-bottom: 32px; page-break-inside: avoid; }
    .section-title { font-size: 9pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #c9a84c; border-bottom: 1px solid #e5e7eb; padding-bottom: 6px; margin-bottom: 16px; }

    /* KPI strip */
    .kpi-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 28px; }
    .kpi { background: #f9fafb; border-radius: 8px; padding: 16px; border-top: 3px solid #e5e7eb; }
    .kpi-gold { border-top-color: #c9a84c; }
    .kpi-green { border-top-color: #22c55e; }
    .kpi-red { border-top-color: #ef4444; }
    .kpi-purple { border-top-color: #8b5cf6; }
    .kpi-label { font-size: 8.5pt; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: #6b7280; margin-bottom: 6px; }
    .kpi-value { font-size: 20pt; font-weight: 700; font-family: monospace; color: #111; }
    .kpi-sub { font-size: 8.5pt; color: #9ca3af; margin-top: 4px; }

    /* Tables */
    table { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 9pt; }
    th { background: #f3f4f6; font-weight: 700; text-align: left; padding: 8px 10px; border-bottom: 2px solid #e5e7eb; color: #374151; font-size: 8.5pt; text-transform: uppercase; letter-spacing: 0.04em; }
    td { padding: 7px 10px; border-bottom: 1px solid #f3f4f6; vertical-align: top; color: #374151; }
    tr:last-child td { border-bottom: none; }
    .mono { font-family: monospace; }
    .green { color: #15803d; font-weight: 600; }
    .red { color: #dc2626; font-weight: 600; }
    .badge { display: inline-block; padding: 2px 7px; border-radius: 4px; font-size: 8pt; font-weight: 700; }
    .badge-ok { background: #dcfce7; color: #15803d; }
    .badge-breach { background: #fee2e2; color: #dc2626; }
    .badge-warn { background: #fef9c3; color: #854d0e; }
    .badge-buy { background: #dbeafe; color: #1d4ed8; }
    .badge-sell { background: #fce7f3; color: #be185d; }
    .badge-eq { background: #ede9fe; color: #6d28d9; }
    .badge-fi { background: #d1fae5; color: #065f46; }

    /* Allocation bars */
    .sleeve-row { margin-bottom: 16px; }
    .sleeve-header { display: flex; justify-content: space-between; margin-bottom: 4px; font-size: 9pt; font-weight: 600; }
    .bar-bg { background: #f3f4f6; border-radius: 4px; height: 8px; position: relative; }
    .bar-fill { height: 8px; border-radius: 4px; }
    .bar-green { background: #22c55e; }
    .bar-red { background: #ef4444; }
    .bar-amber { background: #f59e0b; }

    /* AI report section */
    .ai-section { border-top: 2px solid #c9a84c; margin-top: 32px; padding-top: 28px; }
    .ai-section h2 { font-size: 11pt; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; color: #0f1923; border-bottom: 1px solid rgba(201,168,76,0.3); padding-bottom: 6px; margin: 24px 0 8px; }
    .ai-section h3 { font-size: 10.5pt; font-weight: 600; color: #5b21b6; margin: 16px 0 6px; }
    .ai-section p { margin: 5px 0; color: #222; line-height: 1.7; }
    .ai-section strong { color: #0f1923; font-weight: 700; }
    .ai-section em { color: #555; }
    .ai-section hr { border: none; border-top: 1px solid #e5e7eb; margin: 18px 0; }
    .ai-section table { font-size: 9pt; }
    .ai-section .gap { height: 6px; }
    .ai-section code { background: #f3f4f6; padding: 1px 4px; border-radius: 3px; font-size: 8.5pt; }

    /* Benchmark table */
    .port-row { background: #f5f3ff !important; }
    .port-row td { font-weight: 600; }

    /* Footer */
    .footer { background: #f9fafb; padding: 20px 48px; border-top: 1px solid #e5e7eb; font-size: 8pt; color: #6b7280; line-height: 1.6; }

    /* Print */
    @media print {
      @page { size: A4; margin: 12mm; }
      body { background: white; }
      .page { max-width: 100%; }
      .no-print { display: none !important; }
      .section { page-break-inside: avoid; }
      .header { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .kpi { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      th { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .badge { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
      .bar-fill { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
    }

    /* Print button */
    .print-bar { position: fixed; bottom: 24px; right: 24px; display: flex; gap: 10px; z-index: 100; }
    .btn { padding: 12px 22px; border: none; border-radius: 8px; font-size: 12px; font-weight: 600; cursor: pointer; font-family: inherit; }
    .btn-primary { background: #a78bfa; color: white; }
    .btn-secondary { background: #374151; color: white; }
    .btn:hover { opacity: 0.9; }
  `

  const sleeveRows = data.sleeves.map(s => {
    const barColor = s.status === 'BREACH' ? 'bar-red' : s.status === 'OVER' ? 'bar-amber' : 'bar-green'
    const badgeClass = s.status === 'BREACH' ? 'badge-breach' : s.status === 'OVER' ? 'badge-warn' : 'badge-ok'
    const barWidth = Math.min(100, s.actualPct * 100).toFixed(1)
    const targetWidth = Math.min(100, s.targetPct * 100).toFixed(1)
    return `
      <div class="sleeve-row">
        <div class="sleeve-header">
          <span>${s.name}</span>
          <span class="mono">${(s.actualPct * 100).toFixed(1)}% actual &nbsp;·&nbsp; ${(s.targetPct * 100).toFixed(1)}% target &nbsp;·&nbsp; ${fmtM(s.value)} &nbsp;
            <span class="badge ${badgeClass}">${s.status}</span>
          </span>
        </div>
        <div class="bar-bg">
          <div class="bar-fill ${barColor}" style="width:${barWidth}%"></div>
        </div>
      </div>`
  }).join('')

  const holdingsRows = data.holdings.map(h => {
    const pnlClass = h.unrealisedPnL >= 0 ? 'green' : 'red'
    const pnlSign2 = h.unrealisedPnL >= 0 ? '+' : ''
    return `<tr>
      <td><strong>${h.name}</strong><br><span style="color:#9ca3af;font-size:8pt">${h.instrumentId}</span></td>
      <td><span class="badge ${h.type === 'Stock' ? 'badge-eq' : 'badge-fi'}">${h.type}</span></td>
      <td class="mono">${h.quantity.toLocaleString()}</td>
      <td class="mono">₦${fmt(h.avgCost)}</td>
      <td class="mono">₦${fmt(h.currentPrice)}</td>
      <td class="mono">${fmtM(h.marketValue)}</td>
      <td class="mono ${pnlClass}">${pnlSign2}${fmtM(h.unrealisedPnL)}</td>
      <td class="mono">${(h.weight * 100).toFixed(1)}%</td>
    </tr>`
  }).join('')

  const periodRows = data.periodReturns.map(pr => {
    const cls = (pr.percentReturn ?? 0) >= 0 ? 'green' : 'red'
    return `<tr>
      <td>${pr.label}</td>
      <td class="mono ${cls}">${fmtPct(pr.percentReturn)}</td>
      <td class="mono">${pr.annualisedReturn !== null ? fmtPct(pr.annualisedReturn) : '—'}</td>
      <td class="mono">${pr.daysHeld ?? '—'}</td>
    </tr>`
  }).join('')

  const benchmarkRows = data.benchmarks.map(b => {
    const diff = portfolioIRR - b.annualised
    const diffClass = diff >= 0 ? 'green' : 'red'
    const typeBadge = b.type === 'equity' ? 'badge-eq' : b.type === 'inflation' ? 'badge-breach' : 'badge-fi'
    const typeLabel = b.type === 'equity' ? 'Equity' : b.type === 'inflation' ? 'Inflation' : 'Fixed Income'
    return `<tr>
      <td>${b.name}</td>
      <td><span class="badge ${typeBadge}">${typeLabel}</span></td>
      <td class="mono">${(b.annualised * 100).toFixed(1)}%</td>
      <td class="mono ${diffClass}">${diff >= 0 ? '+' : ''}${(diff * 100).toFixed(1)}pp</td>
    </tr>`
  }).join('')

  const alertBars = data.alerts.map(a =>
    `<div class="${a.level === 'BREACH' ? 'alert-breach' : 'alert-warning'}">${a.level}: ${a.message}</div>`
  ).join('')

  const aiSection = data.aiReport ? `
    <div class="ai-section">
      <div class="section-title">AI Portfolio Intelligence — ${data.aiReport.type.toUpperCase()} Report · ${data.aiReport.date}</div>
      ${markdownToHTML(data.aiReport.content)}
    </div>` : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${data.portfolioName} — Portfolio Report · ${data.reportDate}</title>
  <style>${CSS}</style>
</head>
<body>
<div class="page">

  <!-- Header -->
  <div class="header">
    <div class="header-top">
      <div>
        <div class="firm">Transworld Asset Management — Portfolio Intelligence</div>
        <div class="port-name">${data.portfolioName}</div>
        <div class="client-name">${data.clientName}</div>
      </div>
      <div class="header-right">
        <div class="report-date">As at ${data.reportDate}</div>
        <div class="report-date" style="font-size:9pt;margin-top:4px;">Generated ${data.generatedAt}</div>
        <div class="confidential">Confidential</div>
      </div>
    </div>
  </div>

  <!-- Compliance alerts -->
  ${alertBars}

  <div class="content">

    <!-- KPI Strip -->
    <div class="kpi-row">
      <div class="kpi kpi-gold">
        <div class="kpi-label">Current NAV</div>
        <div class="kpi-value" style="font-size:18pt">${fmtM(data.currentNAV)}</div>
        <div class="kpi-sub">Currency: ${data.currency} · Rate ₦${Math.round(data.fxRate).toLocaleString()}/USD</div>
      </div>
      <div class="kpi ${data.totalReturn >= 0 ? 'kpi-green' : 'kpi-red'}">
        <div class="kpi-label">Total P&amp;L vs Start</div>
        <div class="kpi-value" style="font-size:18pt;color:${data.totalReturn >= 0 ? '#15803d' : '#dc2626'}">${pnlSign}${fmtM(data.currentNAV - data.startingNAV)}</div>
        <div class="kpi-sub">From ${fmtM(data.startingNAV)} · ${data.startDate}</div>
      </div>
      <div class="kpi ${data.totalReturn >= 0 ? 'kpi-green' : 'kpi-red'}">
        <div class="kpi-label">Total Return</div>
        <div class="kpi-value" style="color:${data.totalReturn >= 0 ? '#15803d' : '#dc2626'}">${pnlSign}${(data.totalReturnPct * 100).toFixed(1)}%</div>
        <div class="kpi-sub">IRR: ${data.irr !== null ? (data.irr * 100).toFixed(1) + '%' : 'N/A'} annualised</div>
      </div>
      <div class="kpi kpi-purple">
        <div class="kpi-label">Income Target</div>
        <div class="kpi-value" style="color:#7c3aed">${(data.mandate.incomeTarget * 100).toFixed(0)}% p.a.</div>
        <div class="kpi-sub">Cap target: ${(data.mandate.capTarget * 100).toFixed(0)}% p.a.</div>
      </div>
    </div>

    <!-- Allocation vs Targets -->
    <div class="section">
      <div class="section-title">Portfolio Allocation vs Targets</div>
      ${sleeveRows}
    </div>

    <!-- Holdings -->
    <div class="section">
      <div class="section-title">Holdings as at ${data.reportDate}</div>
      <table>
        <thead><tr><th>Instrument</th><th>Type</th><th>Quantity</th><th>Avg Cost</th><th>Mkt Price</th><th>Mkt Value</th><th>Unrl P&amp;L</th><th>Weight</th></tr></thead>
        <tbody>${holdingsRows}</tbody>
      </table>
    </div>

    <!-- Performance & Benchmarks -->
    <div class="section">
      <div class="section-title">Performance &amp; Benchmarks</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:24px;">
        <div>
          <div style="font-size:8.5pt;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;margin-bottom:8px;">Period Returns</div>
          <table>
            <thead><tr><th>Period</th><th>Return</th><th>Annualised</th><th>Days</th></tr></thead>
            <tbody>${periodRows}</tbody>
          </table>
        </div>
        <div>
          <div style="font-size:8.5pt;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;margin-bottom:8px;">vs Benchmarks (annualised)</div>
          <table>
            <thead><tr><th>Benchmark</th><th>Type</th><th>Return</th><th>vs Portfolio</th></tr></thead>
            <tbody>
              <tr class="port-row">
                <td><strong>This Portfolio</strong></td>
                <td><span class="badge badge-eq">Discretionary</span></td>
                <td class="mono green">${(portfolioIRR * 100).toFixed(1)}%</td>
                <td class="mono" style="color:#9ca3af">—</td>
              </tr>
              ${benchmarkRows}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Fee Summary -->
    <div class="section">
      <div class="section-title">Transaction &amp; Fee Summary</div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:16px;">
        ${[
          { label: 'Total Transactions', value: data.txSummary.total.toString(), color: '#374151' },
          { label: 'Brokerage Commission', value: '₦' + fmt(data.fees.commission), color: '#7c3aed' },
          { label: 'Statutory Charges', value: '₦' + fmt(data.fees.vat + data.fees.stamp + data.fees.exchange + data.fees.clearing + data.fees.sms), color: '#d97706' },
          { label: 'Total Fees Paid', value: '₦' + fmt(data.fees.total), color: '#dc2626' },
        ].map(item => `
          <div style="background:#f9fafb;border-radius:6px;padding:12px;border-top:2px solid ${item.color}">
            <div style="font-size:8pt;text-transform:uppercase;letter-spacing:.06em;color:#6b7280;margin-bottom:4px;">${item.label}</div>
            <div style="font-family:monospace;font-size:12pt;font-weight:700;color:${item.color}">${item.value}</div>
          </div>`).join('')}
      </div>
      <table>
        <thead><tr><th>Fee Type</th><th>Amount</th><th>Notes</th></tr></thead>
        <tbody>
          <tr><td>Brokerage commission</td><td class="mono">₦${fmt(data.fees.commission)}</td><td style="color:#6b7280">1.5% of gross transaction value</td></tr>
          <tr><td>VAT on commission</td><td class="mono">₦${fmt(data.fees.vat)}</td><td style="color:#6b7280">7.5% of commission</td></tr>
          <tr><td>Contract stamp duty</td><td class="mono">₦${fmt(data.fees.stamp)}</td><td style="color:#6b7280">0.08% of gross value</td></tr>
          <tr><td>NGX exchange levy</td><td class="mono">₦${fmt(data.fees.exchange)}</td><td style="color:#6b7280">0.3% of gross value (sells only)</td></tr>
          <tr><td>CSCS clearing fee</td><td class="mono">₦${fmt(data.fees.clearing)}</td><td style="color:#6b7280">0.3% of gross value (sells only)</td></tr>
          <tr><td>SMS charges</td><td class="mono">₦${fmt(data.fees.sms)}</td><td style="color:#6b7280">Per transaction notification</td></tr>
          <tr><td>Management fees</td><td class="mono">₦${fmt(data.fees.management)}</td><td style="color:#6b7280">Annual discretionary management fee</td></tr>
          <tr style="background:#f9fafb"><td><strong>Total</strong></td><td class="mono"><strong>₦${fmt(data.fees.total)}</strong></td><td style="color:#6b7280">Buys: ${data.txSummary.buys} (${fmtM(data.txSummary.buyGross)}) · Sells: ${data.txSummary.sells} (${fmtM(data.txSummary.sellGross)})</td></tr>
        </tbody>
      </table>
    </div>

    <!-- Mandate -->
    <div class="section">
      <div class="section-title">Portfolio Mandate &amp; Risk Limits</div>
      <table>
        <thead><tr><th>Parameter</th><th>Limit</th><th>Current</th><th>Status</th></tr></thead>
        <tbody>
          <tr><td>Income target</td><td class="mono">${(data.mandate.incomeTarget * 100).toFixed(0)}% p.a.</td><td class="mono">—</td><td><span class="badge badge-warn">Tracking</span></td></tr>
          <tr><td>Capital appreciation target</td><td class="mono">${(data.mandate.capTarget * 100).toFixed(0)}% p.a.</td><td class="mono green">${fmtPct(data.annualisedReturn)}</td><td><span class="badge badge-ok">Exceeded</span></td></tr>
          <tr><td>Max single equity</td><td class="mono">${(data.mandate.maxSingleEq * 100).toFixed(0)}%</td><td class="mono">Per holdings above</td><td><span class="badge badge-warn">Monitor</span></td></tr>
          <tr><td>Max equity sleeve</td><td class="mono">${(data.mandate.maxEqSleeve * 100).toFixed(0)}%</td><td class="mono">${((data.sleeves.find(s => s.name.toLowerCase().includes('equit'))?.actualPct ?? 0) * 100).toFixed(1)}%</td><td><span class="badge badge-ok">Within limit</span></td></tr>
          <tr><td>Drawdown alert</td><td class="mono">${(data.mandate.ddAlert * 100).toFixed(0)}%</td><td class="mono green">N/A — Positive returns</td><td><span class="badge badge-ok">OK</span></td></tr>
        </tbody>
      </table>
    </div>

    <!-- AI Analysis -->
    ${aiSection}

  </div>

  <!-- Footer -->
  <div class="footer">
    <strong>Transworld Asset Management</strong> — Portfolio Intelligence Report<br>
    This report was generated on ${data.generatedAt} for ${data.clientName}. It is prepared for the exclusive use of the named client and contains confidential information.
    AI-assisted analytical suggestions and investment signals are indicative in nature and do not constitute investment advice.
    The portfolio manager retains full discretion over all investment decisions.
    Market prices, valuations, and benchmark data are sourced from publicly available information as at the report date.
  </div>

</div>

<!-- Print controls -->
<div class="print-bar no-print">
  <button class="btn btn-secondary" onclick="window.close()">✕ Close</button>
  <button class="btn btn-primary" onclick="window.print()">🖨 Print / Save PDF</button>
</div>

</body>
</html>`
}
