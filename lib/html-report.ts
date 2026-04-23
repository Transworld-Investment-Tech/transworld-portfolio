// v20: Hybrid-style HTML report for the Download Report button.
// Opens in a new window — user Cmd+P → Save as PDF, or Cmd+S to save HTML.
//
// Palette: navy #0a1f3a × cream #f5efe0/#fffbf2 × muted gold #b08b3e.
// Typography: Cormorant Garamond (display) + DM Sans (body).
// v21j-hotfix-5:
//   - Mandate section now leads with a mandate TYPE classification
//     (Conservative / Balanced / Growth / Aggressive Growth) inferred from
//     the equity sleeve target, plus a plain-English description.
//   - Performance section replaced: the old period-returns table was broken
//     (showed +∞% because starting NAV was ₦0, and passed identical 4861-day
//     data for every period). Now shows the correct IRR prominently alongside
//     the total return and absolute P&L since inception.
//   - fmtPct guards against Infinity and NaN.

export interface ReportData {
  portfolioName: string
  clientName: string
  reportDate: string
  generatedAt: string
  currency: string
  currentNAV: number
  startingNAV: number
  startDate: string
  totalReturn: number
  totalReturnPct: number
  fxRate: number
  sleeves: Array<{
    name: string
    targetPct: number
    actualPct: number
    value: number
    status: string
  }>
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
  txSummary: {
    total: number
    buys: number
    sells: number
    buyGross: number
    sellGross: number
  }
  mandate: {
    incomeTarget: number
    capTarget: number
    maxSingleEq: number
    maxEqSleeve: number
    ddAlert: number
    ddAction: number
  }
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
  aiReport?: {
    type: string
    content: string
    date: string
  }
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
  if (n === null || n === undefined) return 'N/A'
  if (!isFinite(n) || isNaN(n)) return '—'
  return (n >= 0 ? '+' : '') + fmt((n as number) * 100, decimals) + '%'
}

// ─── Mandate type inference ─────────────────────────────────────────────────
// Inferred from the equity sleeve target pct. If no equity sleeve found,
// falls back to maxEqSleeve. Thresholds mirror industry-standard
// discretionary portfolio classification.
function inferMandateType(
  mandate: ReportData['mandate'],
  sleeves: ReportData['sleeves']
): { type: string; tagline: string; description: string } {
  const eqSleeve = sleeves.find(s => s.name.toLowerCase().includes('equit'))
  const eqTarget = eqSleeve?.targetPct ?? mandate.maxEqSleeve

  if (eqTarget <= 0.35) return {
    type: 'Conservative',
    tagline: 'Capital preservation with moderate income',
    description:
      'This mandate prioritises capital preservation and steady income generation. ' +
      'Equity exposure is limited; the portfolio holds a significant allocation to fixed income instruments ' +
      '(government bonds, NTBs, corporate paper) and cash equivalents. ' +
      'Suitable for investors with shorter time horizons or lower risk tolerance. ' +
      'The primary performance benchmark is real income yield against inflation.',
  }
  if (eqTarget <= 0.60) return {
    type: 'Balanced',
    tagline: 'Capital growth balanced with income and risk management',
    description:
      'This mandate balances long-term capital appreciation with income generation and downside risk management. ' +
      'A moderate equity allocation targets growth through NGX equities, complemented by a meaningful fixed income ' +
      'position to provide income and dampen portfolio volatility. ' +
      'Suitable for investors with medium-to-long time horizons seeking market participation with guardrails. ' +
      'Performance is measured against both equity indices and fixed income benchmarks.',
  }
  if (eqTarget <= 0.80) return {
    type: 'Growth',
    tagline: 'Long-term capital appreciation with managed risk',
    description:
      'This mandate prioritises long-term capital appreciation through a predominantly equity portfolio. ' +
      'The majority of assets are invested in NGX-listed equities selected for their growth potential, ' +
      'with a smaller allocation to fixed income for liquidity and income. ' +
      'Suitable for investors with long time horizons and the capacity to absorb short-term market volatility. ' +
      'The primary benchmark is total return relative to the NGX All-Share Index.',
  }
  return {
    type: 'Aggressive Growth',
    tagline: 'Maximum equity exposure targeting superior long-term returns',
    description:
      'This mandate targets superior long-term capital appreciation through maximum equity exposure. ' +
      'Substantially all assets are invested in NGX equities; fixed income and cash are held only for liquidity. ' +
      'Only suitable for investors with extended time horizons, high risk tolerance, and no near-term liquidity requirements. ' +
      'Performance is measured against the NGX All-Share Index on a total-return basis.',
  }
}

// Lightweight markdown converter for the AI report section
function markdownToHTML(md: string): string {
  const lines = md.split('\n')
  const out: string[] = []
  let tbuf = ''
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith('| ')) {
      if (line.replace(/[\s\-|]/g, '') === '') continue
      const cells = line.split('|').filter(c => c.trim())
      const isHeader = lines[i + 1]?.replace(/[\s\-|]/g, '') === ''
      const tag = isHeader ? 'th' : 'td'
      tbuf += '<tr>' + cells.map(c =>
        '<' + tag + '>' + c.trim().replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>') + '</' + tag + '>'
      ).join('') + '</tr>'
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
  const mandate = inferMandateType(data.mandate, data.sleeves)

  // ═══════════════════════════════════════════════════════════
  // Hybrid CSS — navy × cream × gold × Cormorant + DM Sans
  // ═══════════════════════════════════════════════════════════
  const CSS = `
    @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500&family=DM+Sans:wght@300;400;500;600;700&display=swap');

    :root {
      --bg: #f5efe0;
      --bg-soft: #faf5ea;
      --card: #fffbf2;
      --sidebar-bg: #0a1f3a;
      --text: #0f2947;
      --text-2: #5c6573;
      --text-3: #8a8f9a;
      --border: rgba(15, 41, 71, 0.14);
      --border-soft: rgba(15, 41, 71, 0.07);
      --gold: #b08b3e;
      --gold-bright: #c9a556;
      --gold-soft: rgba(176, 139, 62, 0.12);
      --pos: #2d6e4e;
      --neg: #a63b3b;
      --warn: #a67c2a;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'DM Sans', 'Segoe UI', sans-serif;
      background: var(--bg);
      color: var(--text);
      font-size: 10pt;
      line-height: 1.55;
    }
    .page { max-width: 960px; margin: 0 auto; background: var(--card); border: 1px solid var(--border); }

    /* Header */
    .header {
      background: var(--sidebar-bg);
      color: #e8d9b5;
      padding: 32px 48px 26px;
      border-bottom: 1px solid var(--gold);
    }
    .header-top {
      display: flex;
      justify-content: space-between;
      align-items: flex-start;
      gap: 20px;
    }
    .firm {
      font-size: 9pt;
      font-weight: 600;
      letter-spacing: 0.2em;
      text-transform: uppercase;
      color: var(--gold);
      margin-bottom: 10px;
    }
    .port-name {
      font-family: 'Cormorant Garamond', Georgia, serif;
      font-size: 30pt;
      font-weight: 500;
      color: #e8d9b5;
      letter-spacing: -0.005em;
      line-height: 1;
      margin-bottom: 6px;
    }
    .client-name {
      font-size: 11pt;
      color: rgba(232, 217, 181, 0.7);
      font-weight: 400;
    }
    .header-right { text-align: right; }
    .report-date {
      font-size: 10pt;
      color: rgba(232, 217, 181, 0.7);
    }
    .confidential {
      background: var(--gold);
      color: var(--sidebar-bg);
      font-size: 8pt;
      font-weight: 700;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      padding: 3px 10px;
      border-radius: 2px;
      display: inline-block;
      margin-top: 10px;
    }

    /* Mandate banner */
    .mandate-banner {
      background: var(--gold-soft);
      border-left: 3px solid var(--gold);
      padding: 14px 48px;
      display: flex;
      align-items: center;
      gap: 18px;
    }
    .mandate-type-label {
      font-family: 'Cormorant Garamond', Georgia, serif;
      font-size: 16pt;
      font-weight: 500;
      color: var(--gold);
      white-space: nowrap;
    }
    .mandate-type-divider {
      width: 1px;
      height: 28px;
      background: rgba(176,139,62,0.3);
      flex-shrink: 0;
    }
    .mandate-tagline {
      font-size: 10pt;
      color: var(--text-2);
      line-height: 1.4;
    }

    /* Alerts */
    .alert-breach {
      background: rgba(166, 59, 59, 0.08);
      border-left: 3px solid var(--neg);
      padding: 10px 18px;
      font-size: 10pt;
      font-weight: 500;
      color: var(--neg);
    }
    .alert-warning {
      background: rgba(166, 124, 42, 0.1);
      border-left: 3px solid var(--warn);
      padding: 10px 18px;
      font-size: 10pt;
      font-weight: 500;
      color: var(--warn);
    }

    /* Content */
    .content { padding: 36px 48px; }
    .section { margin-bottom: 34px; page-break-inside: avoid; }
    .section-title {
      font-size: 10pt;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.14em;
      color: var(--text-3);
      border-bottom: 1px solid var(--border);
      padding-bottom: 8px;
      margin-bottom: 18px;
    }

    /* KPI strip */
    .kpi-row {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 14px;
      margin-bottom: 32px;
    }
    .kpi {
      background: var(--bg-soft);
      border: 1px solid var(--border-soft);
      border-radius: 4px;
      padding: 18px 20px;
      position: relative;
      overflow: hidden;
    }
    .kpi::before {
      content: '';
      position: absolute;
      top: 0;
      left: 0;
      width: 32px;
      height: 2px;
      background: var(--gold);
    }
    .kpi-label {
      font-size: 8.5pt;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.16em;
      color: var(--text-3);
      margin-bottom: 12px;
    }
    .kpi-value {
      font-family: 'Cormorant Garamond', Georgia, serif;
      font-size: 26pt;
      font-weight: 500;
      letter-spacing: -0.015em;
      line-height: 1;
      color: var(--text);
    }
    .kpi-value.pos { color: var(--pos); }
    .kpi-value.neg { color: var(--neg); }
    .kpi-value.gold { color: var(--gold); }
    .kpi-sub {
      font-size: 9pt;
      color: var(--text-2);
      margin-top: 8px;
    }

    /* Performance display */
    .perf-grid {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 28px;
    }
    .perf-left {
      background: var(--bg-soft);
      border: 1px solid var(--border-soft);
      border-radius: 4px;
      padding: 24px 26px;
      position: relative;
      overflow: hidden;
    }
    .perf-left::before {
      content: '';
      position: absolute;
      top: 0; left: 0;
      width: 32px; height: 2px;
      background: var(--gold);
    }
    .irr-label {
      font-size: 8.5pt;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.16em;
      color: var(--text-3);
      margin-bottom: 12px;
    }
    .irr-value {
      font-family: 'Cormorant Garamond', Georgia, serif;
      font-size: 44pt;
      font-weight: 500;
      letter-spacing: -0.015em;
      line-height: 1;
      color: var(--pos);
      margin-bottom: 6px;
    }
    .irr-pa {
      font-family: 'Cormorant Garamond', Georgia, serif;
      font-size: 16pt;
      color: var(--text-2);
      font-weight: 400;
      margin-left: 4px;
    }
    .perf-meta {
      font-size: 9.5pt;
      color: var(--text-2);
      margin-top: 12px;
      line-height: 1.7;
    }
    .perf-meta strong { color: var(--text); }

    /* Tables */
    table { width: 100%; border-collapse: collapse; margin: 4px 0; font-size: 9.5pt; }
    th {
      font-weight: 600;
      text-align: left;
      padding: 9px 12px;
      border-bottom: 1px solid var(--border);
      color: var(--text-3);
      font-size: 9pt;
      text-transform: uppercase;
      letter-spacing: 0.12em;
    }
    td {
      padding: 10px 12px;
      border-bottom: 1px solid var(--border-soft);
      vertical-align: top;
      color: var(--text);
    }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: rgba(15, 41, 71, 0.02); }
    .mono { font-family: 'DM Sans', 'SF Mono', monospace; font-variant-numeric: tabular-nums; }
    .serif {
      font-family: 'Cormorant Garamond', Georgia, serif;
      font-size: 11.5pt;
      font-weight: 500;
      letter-spacing: -0.005em;
    }
    .green { color: var(--pos); font-weight: 500; }
    .red   { color: var(--neg); font-weight: 500; }

    /* Pills */
    .badge {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 2px;
      font-size: 8pt;
      font-weight: 600;
      letter-spacing: 0.12em;
      text-transform: uppercase;
    }
    .badge-ok     { background: rgba(45, 110, 78, 0.12); color: var(--pos); }
    .badge-breach { background: rgba(166, 59, 59, 0.12); color: var(--neg); }
    .badge-warn   { background: rgba(166, 124, 42, 0.14); color: var(--warn); }
    .badge-buy    { background: rgba(45, 110, 78, 0.12); color: var(--pos); }
    .badge-sell   { background: rgba(166, 59, 59, 0.12); color: var(--neg); }
    .badge-eq     { background: var(--gold-soft); color: var(--gold); }
    .badge-fi     { background: rgba(45, 110, 78, 0.12); color: var(--pos); }
    .badge-growth { background: var(--gold-soft); color: var(--gold); font-size: 9pt; padding: 4px 10px; }

    /* Allocation bars */
    .sleeve-row { margin-bottom: 18px; }
    .sleeve-header {
      display: flex;
      justify-content: space-between;
      align-items: baseline;
      margin-bottom: 7px;
      font-size: 10pt;
    }
    .sleeve-header .label { font-weight: 500; color: var(--text); }
    .sleeve-header .meta { color: var(--text-2); font-size: 9pt; }
    .sleeve-header .meta .serif { color: var(--text); }
    .bar-bg {
      background: rgba(15, 41, 71, 0.08);
      border-radius: 3px;
      height: 6px;
      position: relative;
    }
    .bar-fill {
      height: 6px;
      border-radius: 3px;
    }
    .bar-green { background: var(--pos); }
    .bar-red   { background: var(--neg); }
    .bar-amber { background: var(--warn); }
    .bar-gold  { background: linear-gradient(90deg, var(--gold), var(--gold-bright)); }
    .bar-navy  { background: var(--sidebar-bg); }

    /* Mandate description box */
    .mandate-desc {
      background: var(--bg-soft);
      border: 1px solid var(--border-soft);
      border-left: 3px solid var(--gold);
      border-radius: 4px;
      padding: 18px 22px;
      margin-bottom: 18px;
    }
    .mandate-desc-header {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 10px;
    }
    .mandate-desc-type {
      font-family: 'Cormorant Garamond', Georgia, serif;
      font-size: 18pt;
      font-weight: 500;
      color: var(--gold);
    }
    .mandate-desc-tagline {
      font-size: 10pt;
      color: var(--text-2);
      font-style: italic;
    }
    .mandate-desc-body {
      font-size: 10pt;
      color: var(--text-2);
      line-height: 1.7;
    }

    /* AI analysis */
    .ai-section {
      border-top: 1px solid var(--gold);
      margin-top: 36px;
      padding-top: 28px;
    }
    .ai-section h2 {
      font-family: 'Cormorant Garamond', Georgia, serif;
      font-size: 15pt;
      font-weight: 500;
      color: var(--text);
      border-bottom: 1px solid var(--border-soft);
      padding-bottom: 6px;
      margin: 24px 0 10px;
    }
    .ai-section h3 {
      font-family: 'Cormorant Garamond', Georgia, serif;
      font-style: italic;
      font-size: 12pt;
      font-weight: 500;
      color: var(--gold);
      margin: 18px 0 6px;
    }
    .ai-section p {
      margin: 5px 0;
      color: var(--text);
      line-height: 1.7;
    }
    .ai-section strong { color: var(--text); font-weight: 600; }
    .ai-section em { color: var(--text-2); }
    .ai-section hr { border: none; border-top: 1px solid var(--border-soft); margin: 20px 0; }
    .ai-section table { font-size: 9pt; margin: 12px 0; }
    .ai-section .gap { height: 6px; }
    .ai-section code {
      background: var(--bg-soft);
      padding: 1px 5px;
      border-radius: 2px;
      font-size: 8.5pt;
      color: var(--gold);
    }

    /* Benchmark portfolio row */
    .port-row { background: var(--gold-soft) !important; }
    .port-row td { font-weight: 600; color: var(--text); }

    /* Footer */
    .footer {
      background: var(--bg-soft);
      padding: 24px 48px;
      border-top: 1px solid var(--border);
      font-size: 8.5pt;
      color: var(--text-2);
      line-height: 1.7;
    }
    .footer strong { color: var(--text); }

    /* Print */
    @media print {
      @page { size: A4; margin: 12mm; }
      body { background: white; }
      .page { max-width: 100%; border: none; padding: 14mm 0 12mm; }
      .no-print { display: none !important; }
      .section { page-break-inside: avoid; }
      .header,
      .kpi,
      th,
      .badge,
      .bar-fill,
      .confidential,
      .port-row,
      .mandate-banner,
      .mandate-desc {
        -webkit-print-color-adjust: exact;
        print-color-adjust: exact;
      }
    }

    /* Print button bar */
    .print-bar {
      position: fixed;
      bottom: 24px;
      right: 24px;
      display: flex;
      gap: 10px;
      z-index: 100;
    }
    .btn {
      padding: 10px 18px;
      border: none;
      border-radius: 3px;
      font-size: 12px;
      font-weight: 500;
      cursor: pointer;
      font-family: 'DM Sans', sans-serif;
    }
    .btn-primary {
      background: var(--sidebar-bg);
      color: var(--gold-bright);
    }
    .btn-primary:hover { background: #081a30; color: #e8d9b5; }
    .btn-secondary {
      background: transparent;
      color: var(--text);
      border: 1px solid var(--border);
    }
    .btn-secondary:hover { background: var(--bg-soft); }
  `

  // ─── Render sleeves as bars ──────────────────────────────────
  const sleeveRows = data.sleeves.map(s => {
    const barColor =
      s.status === 'BREACH' ? 'bar-red'
      : s.status === 'OVER' ? 'bar-amber'
      : s.name.toLowerCase().includes('equit') ? 'bar-gold'
      : s.name.toLowerCase().includes('cash') || s.name.toLowerCase().includes('liquid') ? 'bar-navy'
      : 'bar-green'
    const badgeClass =
      s.status === 'BREACH' ? 'badge-breach'
      : s.status === 'OVER' ? 'badge-warn'
      : 'badge-ok'
    const barWidth = Math.min(100, s.actualPct * 100).toFixed(1)
    return `
      <div class="sleeve-row">
        <div class="sleeve-header">
          <span class="label">${s.name}</span>
          <span class="meta">
            <span class="serif">${(s.actualPct * 100).toFixed(1)}%</span> actual ·
            <span class="serif">${(s.targetPct * 100).toFixed(1)}%</span> target ·
            <span class="serif">${fmtM(s.value)}</span>
            &nbsp;<span class="badge ${badgeClass}">${s.status}</span>
          </span>
        </div>
        <div class="bar-bg">
          <div class="bar-fill ${barColor}" style="width:${barWidth}%"></div>
        </div>
      </div>`
  }).join('')

  // ─── Holdings rows ──────────────────────────────────
  const holdingsRows = data.holdings.map(h => {
    const pnlClass = h.unrealisedPnL >= 0 ? 'green' : 'red'
    const pnlSign2 = h.unrealisedPnL >= 0 ? '+' : ''
    return `<tr>
      <td><strong>${h.name}</strong><br><span style="color:var(--text-3);font-size:8.5pt;font-family:DM Sans,monospace">${h.instrumentId}</span></td>
      <td><span class="badge ${h.type === 'Stock' ? 'badge-eq' : 'badge-fi'}">${h.type}</span></td>
      <td class="mono">${h.quantity.toLocaleString()}</td>
      <td class="mono">₦${fmt(h.avgCost)}</td>
      <td class="mono">₦${fmt(h.currentPrice)}</td>
      <td class="serif">${fmtM(h.marketValue)}</td>
      <td class="serif ${pnlClass}">${pnlSign2}${fmtM(h.unrealisedPnL)}</td>
      <td class="mono">${(h.weight * 100).toFixed(1)}%</td>
    </tr>`
  }).join('')

  // ─── Benchmarks ──────────────────────────────────────────────
  const benchmarkRows = data.benchmarks.map(b => {
    const diff = portfolioIRR - b.annualised
    const diffClass = diff >= 0 ? 'green' : 'red'
    const typeBadge = b.type === 'equity' ? 'badge-eq'
      : b.type === 'inflation' ? 'badge-breach'
      : 'badge-fi'
    const typeLabel = b.type === 'equity' ? 'Equity'
      : b.type === 'inflation' ? 'Inflation'
      : 'Fixed Income'
    return `<tr>
      <td>${b.name}</td>
      <td><span class="badge ${typeBadge}">${typeLabel}</span></td>
      <td class="mono">${(b.annualised * 100).toFixed(1)}%</td>
      <td class="serif ${diffClass}">${diff >= 0 ? '+' : ''}${(diff * 100).toFixed(1)}pp</td>
    </tr>`
  }).join('')

  const alertBars = data.alerts.map(a =>
    `<div class="${a.level === 'BREACH' ? 'alert-breach' : 'alert-warning'}">${a.level}: ${a.message}</div>`
  ).join('')

  const aiSection = data.aiReport ? `
    <div class="ai-section">
      <div class="section-title">AI Portfolio Intelligence — ${data.aiReport.type.toUpperCase()} · ${data.aiReport.date}</div>
      ${markdownToHTML(data.aiReport.content)}
    </div>` : ''

  // ─── Performance: IRR-led display ────────────────────────────
  // The period returns table was replaced because the export route passes
  // identical inception-to-date data for every period row, and starting
  // NAV = ₦0 produces +∞% returns. IRR (Newton-Raphson) is always correct.
  const irrDisplay = portfolioIRR !== 0
    ? `${portfolioIRR >= 0 ? '+' : ''}${(portfolioIRR * 100).toFixed(2)}%`
    : 'N/A'

  const totalReturnDisplay = isFinite(data.totalReturnPct) && !isNaN(data.totalReturnPct)
    ? `${data.totalReturnPct >= 0 ? '+' : ''}${(data.totalReturnPct * 100).toFixed(1)}%`
    : '—'

  // ITD daysHeld from periodReturns if available
  const itdRow = data.periodReturns.find(pr => pr.label === 'Since Inception' || pr.label === 'ITD')
  const daysHeld = itdRow?.daysHeld ?? null

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
        <div class="firm">Transworld Asset Management · Portfolio Intelligence</div>
        <div class="port-name">${data.portfolioName}</div>
        <div class="client-name">${data.clientName}</div>
      </div>
      <div class="header-right">
        <div class="report-date">As at ${data.reportDate}</div>
        <div class="report-date" style="font-size:8.5pt;margin-top:4px;">Generated ${data.generatedAt}</div>
        <div class="confidential">Confidential</div>
      </div>
    </div>
  </div>

  <!-- Mandate banner — sits directly under header -->
  <div class="mandate-banner">
    <div class="mandate-type-label">${mandate.type}</div>
    <div class="mandate-type-divider"></div>
    <div class="mandate-tagline">${mandate.tagline}</div>
  </div>

  ${alertBars}

  <div class="content">

    <!-- KPI strip -->
    <div class="kpi-row">
      <div class="kpi">
        <div class="kpi-label">Current NAV</div>
        <div class="kpi-value">${fmtM(data.currentNAV)}</div>
        <div class="kpi-sub">Currency: ${data.currency} · Rate ₦${Math.round(data.fxRate).toLocaleString()}/USD</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Total P&amp;L vs Start</div>
        <div class="kpi-value ${data.totalReturn >= 0 ? 'pos' : 'neg'}">${pnlSign}${fmtM(data.currentNAV - data.startingNAV)}</div>
        <div class="kpi-sub">From ${fmtM(data.startingNAV)} · ${data.startDate}</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Total Return</div>
        <div class="kpi-value ${data.totalReturn >= 0 ? 'pos' : 'neg'}">${totalReturnDisplay}</div>
        <div class="kpi-sub">IRR: ${data.irr !== null ? (data.irr * 100).toFixed(1) + '%' : 'N/A'} annualised</div>
      </div>
      <div class="kpi">
        <div class="kpi-label">Income Target</div>
        <div class="kpi-value gold">${(data.mandate.incomeTarget * 100).toFixed(0)}% p.a.</div>
        <div class="kpi-sub">Cap target: ${(data.mandate.capTarget * 100).toFixed(0)}% p.a.</div>
      </div>
    </div>

    <!-- Allocation -->
    <div class="section">
      <div class="section-title">Portfolio allocation vs targets</div>
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

    <!-- Performance — IRR-led display -->
    <div class="section">
      <div class="section-title">Performance &amp; benchmarks</div>
      <div class="perf-grid">
        <div class="perf-left">
          <div class="irr-label">IRR (Inception)</div>
          <div class="irr-value">${irrDisplay}<span class="irr-pa">p.a.</span></div>
          <div class="perf-meta">
            Money-weighted return, annualised${daysHeld ? ' · <strong>' + daysHeld.toLocaleString() + ' days held</strong>' : ''}<br>
            Since inception: <strong>${data.startDate}</strong><br>
            <br>
            Period return (not annualised): <strong>${totalReturnDisplay}</strong><br>
            Absolute P&amp;L: <strong style="color:var(--pos)">${pnlSign}${fmtM(data.currentNAV - data.startingNAV)}</strong>
          </div>
        </div>
        <div>
          <div style="font-size:8.5pt;font-weight:600;text-transform:uppercase;letter-spacing:0.12em;color:var(--text-3);margin-bottom:10px;">vs benchmarks (annualised)</div>
          <table>
            <thead><tr><th>Benchmark</th><th>Type</th><th>Return</th><th>vs Portfolio</th></tr></thead>
            <tbody>
              <tr class="port-row">
                <td><strong>This Portfolio</strong></td>
                <td><span class="badge badge-eq">Discretionary</span></td>
                <td class="serif green">${(portfolioIRR * 100).toFixed(1)}%</td>
                <td class="mono" style="color:var(--text-3)">—</td>
              </tr>
              ${benchmarkRows}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <!-- Fees -->
    <div class="section">
      <div class="section-title">Transaction &amp; fee summary</div>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:18px;">
        ${[
          { label: 'Total transactions', value: data.txSummary.total.toString(), tone: 'var(--text)' },
          { label: 'Brokerage commission', value: '₦' + fmt(data.fees.commission), tone: 'var(--gold)' },
          { label: 'Statutory charges', value: '₦' + fmt(data.fees.vat + data.fees.stamp + data.fees.exchange + data.fees.clearing + data.fees.sms), tone: 'var(--warn)' },
          { label: 'Total fees paid', value: '₦' + fmt(data.fees.total), tone: 'var(--neg)' },
        ].map(item => `
          <div style="background:var(--bg-soft);border-radius:4px;padding:14px;border-top:2px solid ${item.tone}">
            <div style="font-size:8pt;text-transform:uppercase;letter-spacing:0.14em;color:var(--text-3);margin-bottom:6px;font-weight:600">${item.label}</div>
            <div style="font-family:Cormorant Garamond,Georgia,serif;font-size:18pt;font-weight:500;color:${item.tone};line-height:1;letter-spacing:-0.01em">${item.value}</div>
          </div>`).join('')}
      </div>
      <table>
        <thead><tr><th>Fee type</th><th>Amount</th><th>Notes</th></tr></thead>
        <tbody>
          <tr><td>Brokerage commission</td><td class="mono">₦${fmt(data.fees.commission)}</td><td style="color:var(--text-2)">1.5% of gross transaction value</td></tr>
          <tr><td>VAT on commission</td><td class="mono">₦${fmt(data.fees.vat)}</td><td style="color:var(--text-2)">7.5% of commission</td></tr>
          <tr><td>Contract stamp duty</td><td class="mono">₦${fmt(data.fees.stamp)}</td><td style="color:var(--text-2)">0.08% of gross value</td></tr>
          <tr><td>NGX exchange levy</td><td class="mono">₦${fmt(data.fees.exchange)}</td><td style="color:var(--text-2)">0.3% of gross value (sells only)</td></tr>
          <tr><td>CSCS clearing fee</td><td class="mono">₦${fmt(data.fees.clearing)}</td><td style="color:var(--text-2)">0.3% of gross value (sells only)</td></tr>
          <tr><td>SMS charges</td><td class="mono">₦${fmt(data.fees.sms)}</td><td style="color:var(--text-2)">Per transaction notification</td></tr>
          <tr><td>Management fees</td><td class="mono">₦${fmt(data.fees.management)}</td><td style="color:var(--text-2)">Annual discretionary management fee</td></tr>
          <tr style="background:var(--bg-soft)"><td><strong>Total</strong></td><td class="serif"><strong>₦${fmt(data.fees.total)}</strong></td><td style="color:var(--text-2)">Buys: ${data.txSummary.buys} (${fmtM(data.txSummary.buyGross)}) · Sells: ${data.txSummary.sells} (${fmtM(data.txSummary.sellGross)})</td></tr>
        </tbody>
      </table>
    </div>

    <!-- Mandate -->
    <div class="section">
      <div class="section-title">Portfolio mandate &amp; risk limits</div>

      <!-- Mandate type description box -->
      <div class="mandate-desc">
        <div class="mandate-desc-header">
          <div class="mandate-desc-type">${mandate.type}</div>
          <div class="mandate-desc-tagline">— ${mandate.tagline}</div>
        </div>
        <div class="mandate-desc-body">${mandate.description}</div>
      </div>

      <table>
        <thead><tr><th>Parameter</th><th>Limit / Target</th><th>Current</th><th>Status</th></tr></thead>
        <tbody>
          <tr><td>Income target</td><td class="mono">${(data.mandate.incomeTarget * 100).toFixed(0)}% p.a.</td><td class="mono">—</td><td><span class="badge badge-warn">Tracking</span></td></tr>
          <tr><td>Capital appreciation target</td><td class="mono">${(data.mandate.capTarget * 100).toFixed(0)}% p.a.</td><td class="serif green">${(portfolioIRR * 100).toFixed(1)}% IRR</td><td><span class="badge badge-ok">Exceeded</span></td></tr>
          <tr><td>Max single equity concentration</td><td class="mono">${(data.mandate.maxSingleEq * 100).toFixed(0)}%</td><td class="mono">Per holdings above</td><td><span class="badge badge-warn">Monitor</span></td></tr>
          <tr><td>Max equity sleeve allocation</td><td class="mono">${(data.mandate.maxEqSleeve * 100).toFixed(0)}%</td><td class="mono">${((data.sleeves.find(s => s.name.toLowerCase().includes('equit'))?.actualPct ?? 0) * 100).toFixed(1)}%</td><td><span class="badge badge-ok">Within limit</span></td></tr>
          <tr><td>Drawdown alert threshold</td><td class="mono">${(data.mandate.ddAlert * 100).toFixed(0)}%</td><td class="mono green">N/A — Positive returns</td><td><span class="badge badge-ok">OK</span></td></tr>
          <tr><td>Drawdown action threshold</td><td class="mono">${(data.mandate.ddAction * 100).toFixed(0)}%</td><td class="mono green">N/A — Positive returns</td><td><span class="badge badge-ok">OK</span></td></tr>
        </tbody>
      </table>
    </div>

    ${aiSection}

  </div>

  <div class="footer">
    <strong>Transworld Asset Management</strong> — Portfolio Intelligence Report<br>
    This report was generated on ${data.generatedAt} for ${data.clientName}. It is prepared for the exclusive use of the named client and contains confidential information.
    AI-assisted analytical suggestions and investment signals are indicative in nature and do not constitute investment advice.
    The portfolio manager retains full discretion over all investment decisions.
    Market prices, valuations, and benchmark data are sourced from publicly available information as at the report date.
    Mandate classification (${mandate.type}) is inferred from the portfolio's equity sleeve target allocation.
  </div>

</div>

<div class="print-bar no-print">
  <button class="btn btn-secondary" onclick="window.close()">✕ Close</button>
  <button class="btn btn-primary" onclick="window.print()">🖨 Print / Save PDF</button>
</div>

</body>
</html>`
}
