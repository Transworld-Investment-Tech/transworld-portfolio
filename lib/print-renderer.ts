// v27cb-a-fix7h — Shared HTML print renderer
//
// Server-side HTML rendering for the "Download report" buttons on both
// per-instrument pages and the cockpit. Produces a standalone HTML file
// the operator can print to PDF locally via their browser. No Puppeteer
// dependency.
//
// Design discipline:
//   - All CSS inline (no external sheets)
//   - All data passed as JS objects, rendered as static HTML strings
//   - Print-friendly @page rules baked in
//   - Each major panel gets page-break-inside: avoid
//   - Background white for print readability
//   - No interactive elements (no buttons, no hover, no sticky)
//
// Inputs are loosely typed (record shapes) to avoid coupling this module
// to the per-instrument response interface. The route handlers shape
// data before passing.

export const EMBEDDED_PRINT_STYLES = `
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { background: white; color: #0f2947; font-family: 'DM Sans', system-ui, -apple-system, sans-serif; font-size: 12px; line-height: 1.5; }
body { padding: 24px 32px; max-width: 1100px; margin: 0 auto; }
h1 { font-family: 'Cormorant Garamond', Georgia, serif; font-weight: 500; font-size: 32px; letter-spacing: -0.005em; color: #0f2947; }
h2 { font-family: 'Cormorant Garamond', Georgia, serif; font-style: italic; font-weight: 500; font-size: 18px; color: #0f2947; }
.crumb { font-size: 10px; letter-spacing: 0.18em; font-weight: 600; color: #b08b3e; text-transform: uppercase; margin-bottom: 8px; }
.sub { font-size: 11px; color: #5c6573; letter-spacing: 0.02em; }
.header { padding-bottom: 18px; border-bottom: 1px solid rgba(15,41,71,0.12); margin-bottom: 24px; }
.report-meta { display: flex; justify-content: space-between; align-items: flex-end; }
.report-stamp { font-size: 10px; color: #8a8f9a; letter-spacing: 0.12em; text-transform: uppercase; font-weight: 600; }
.kpi-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
.kpi { background: #fffbf2; border: 1px solid rgba(15,41,71,0.12); border-radius: 4px; padding: 16px; position: relative; }
.kpi::before { content: ''; position: absolute; top: 0; left: 0; width: 28px; height: 2px; background: #b08b3e; }
.kpi-label { font-size: 9px; letter-spacing: 0.16em; font-weight: 600; color: #8a8f9a; text-transform: uppercase; margin-bottom: 10px; }
.kpi-value { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 26px; font-weight: 500; letter-spacing: -0.015em; line-height: 1; color: #0f2947; }
.kpi-sub { font-size: 10px; color: #5c6573; margin-top: 6px; }
.panel { background: #fffbf2; border: 1px solid rgba(15,41,71,0.12); border-radius: 4px; padding: 20px 22px; margin-bottom: 18px; page-break-inside: avoid; break-inside: avoid; }
.panel-header { display: flex; justify-content: space-between; align-items: baseline; padding-bottom: 10px; margin-bottom: 14px; border-bottom: 1px solid rgba(15,41,71,0.06); }
.panel-meta { font-size: 9px; letter-spacing: 0.12em; color: #8a8f9a; text-transform: uppercase; font-weight: 600; }
table { width: 100%; border-collapse: collapse; }
th { text-align: left; padding: 8px 10px; font-size: 9px; letter-spacing: 0.14em; font-weight: 600; color: #8a8f9a; text-transform: uppercase; border-bottom: 1px solid rgba(15,41,71,0.12); }
td { padding: 9px 10px; border-bottom: 1px solid rgba(15,41,71,0.06); font-size: 11px; color: #0f2947; }
th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }
.pill { display: inline-block; padding: 2px 7px; border-radius: 2px; font-size: 8px; letter-spacing: 0.14em; font-weight: 600; text-transform: uppercase; }
.pill-pos { background: rgba(45,110,78,0.12); color: #2d6e4e; }
.pill-neg { background: rgba(166,59,59,0.12); color: #a63b3b; }
.pill-gold { background: rgba(176,139,62,0.14); color: #b08b3e; }
.pill-neutral { background: rgba(15,41,71,0.06); color: #5c6573; }
.facts-row { font-size: 10px; font-style: italic; color: #5c6573; padding: 4px 10px 10px 10px; border-bottom: 1px solid rgba(15,41,71,0.06); }
.facts-row.material { background: rgba(176,139,62,0.04); border-left: 2px solid #b08b3e; padding-left: 14px; }
.cell-grid { display: grid; gap: 12px; }
.cell { border-left: 2px solid rgba(15,41,71,0.06); padding-left: 10px; }
.cell-label { font-size: 9px; letter-spacing: 0.14em; font-weight: 600; color: #8a8f9a; text-transform: uppercase; margin-bottom: 6px; }
.cell-value { font-family: 'Cormorant Garamond', Georgia, serif; font-size: 18px; font-weight: 500; color: #0f2947; letter-spacing: -0.01em; }
.cell-sub { font-size: 9px; color: #8a8f9a; margin-top: 3px; }
.footer { margin-top: 32px; padding-top: 16px; border-top: 1px solid rgba(15,41,71,0.12); font-size: 9px; color: #8a8f9a; letter-spacing: 0.04em; }
@media print {
  @page { size: A4; margin: 12mm; }
  body { padding: 0; }
  .panel { page-break-inside: avoid; }
  .kpi-grid { page-break-inside: avoid; }
}
`

// ─────────────────────────────────────────────────────────────────
// Formatting helpers
// ─────────────────────────────────────────────────────────────────

export function escapeHtml(s: unknown): string {
  if (s === null || s === undefined) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function fmtNgnM(v: number | null | undefined): string {
  if (v === null || v === undefined || !isFinite(v)) return '—'
  const sign = v < 0 ? '−' : ''
  const abs = Math.abs(v)
  if (abs >= 1e9) return sign + '\u20a6' + (abs / 1e9).toFixed(2) + 'B'
  if (abs >= 1e6) return sign + '\u20a6' + (abs / 1e6).toFixed(2) + 'M'
  if (abs >= 1e3) return sign + '\u20a6' + (abs / 1e3).toFixed(1) + 'K'
  return sign + '\u20a6' + abs.toFixed(0)
}

export function fmtNgn(v: number | null | undefined): string {
  if (v === null || v === undefined || !isFinite(v)) return '—'
  const sign = v < 0 ? '−' : ''
  return sign + '\u20a6' + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 2 })
}

export function fmtPct(v: number | null | undefined, dp = 2): string {
  if (v === null || v === undefined || !isFinite(v)) return '—'
  return (v * 100).toFixed(dp) + '%'
}

export function fmtRawPct(v: number | null | undefined, dp = 2): string {
  if (v === null || v === undefined || !isFinite(v) || v === 0) return '—'
  return v.toFixed(dp) + '%'
}

export function fmtPctSigned(v: number | null | undefined, dp = 2): string {
  if (v === null || v === undefined || !isFinite(v)) return '—'
  return (v >= 0 ? '+' : '') + (v * 100).toFixed(dp) + '%'
}

export function fmtDate(s: string | null | undefined): string {
  if (!s) return '—'
  try {
    const d = new Date(s.length > 10 ? s : s + 'T00:00:00')
    return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
  } catch {
    return s
  }
}

export function fmtShares(v: number | null | undefined): string {
  if (v === null || v === undefined || !isFinite(v) || v === 0) return '—'
  if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B'
  if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M'
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K'
  return v.toFixed(0)
}

export function fmtQty(v: number | null | undefined): string {
  if (v === null || v === undefined || !isFinite(v)) return '—'
  return Math.round(v).toLocaleString('en-US')
}

// ─────────────────────────────────────────────────────────────────
// HTML doc shell
// ─────────────────────────────────────────────────────────────────

export function htmlShell(title: string, bodyHtml: string): string {
  const now = new Date().toLocaleString('en-GB', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;1,400;1,500&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>${EMBEDDED_PRINT_STYLES}</style>
</head>
<body>
${bodyHtml}
<div class="footer">
  Generated ${escapeHtml(now)} · Transworld Investment &amp; Securities · Internal use only · Verify against primary sources before acting
</div>
</body>
</html>`
}

// ─────────────────────────────────────────────────────────────────
// Per-instrument report
// ─────────────────────────────────────────────────────────────────

type AnyRecord = Record<string, unknown>

export function renderInstrumentReport(data: AnyRecord): string {
  const inst = (data.instrument as AnyRecord) || {}
  const price = (data.price as AnyRecord) || {}
  const concentration = (data.concentration as AnyRecord) || {}
  const movement = (data.movement as AnyRecord) || {}
  const liquidity = (data.liquidity as AnyRecord) || {}
  const marketCap = (data.market_cap as AnyRecord) || {}
  const valuation = (data.valuation as AnyRecord) || {}
  const fundamentals = (data.fundamentals as AnyRecord) || {}
  const aiSummary = (data.ai_summary as AnyRecord) || {}
  const dividendSnapshot = (data.dividend_snapshot as AnyRecord) || {}
  const disclosures = (data.disclosures as AnyRecord[]) || []
  const dealings = (data.director_dealings as AnyRecord[]) || []
  const holders = (data.holders as AnyRecord[]) || []
  const transactions = (data.recent_transactions as AnyRecord[]) || []
  const fiMeta = (data.fi_metadata as AnyRecord) || {}

  const ticker = String(inst.instrument_id ?? '')
  const name = String(inst.name ?? '')
  const sleeveId = String(inst.sleeve_id ?? '')
  const isEquity = sleeveId === 'eq'
  const isFi = sleeveId === 'ntb' || sleeveId === 'fi'

  // Header
  const header = `
<div class="header">
  <div class="report-meta">
    <div>
      <div class="crumb">Transworld Investment and Securities · Instrument Report</div>
      <h1>${escapeHtml(name)}</h1>
      <div class="sub" style="margin-top: 4px;">
        <strong style="color:#b08b3e">${escapeHtml(ticker)}</strong>
        ${inst.type ? ' · ' + escapeHtml(String(inst.type)) : ''}
        ${inst.sector ? ' · ' + escapeHtml(String(inst.sector)) : ''}
        ${inst.ngx_market ? ' · ' + escapeHtml(String(inst.ngx_market)) : ''}
      </div>
    </div>
    <div class="report-stamp">Report ${escapeHtml(new Date().toISOString().slice(0, 10))}</div>
  </div>
</div>`

  // KPI strip
  const kpi = `
<div class="kpi-grid">
  <div class="kpi">
    <div class="kpi-label">Current Price</div>
    <div class="kpi-value">${escapeHtml(fmtNgn(numOf(price.current_price)))}</div>
    <div class="kpi-sub">as of ${escapeHtml(fmtDate(strOf(price.price_date)))}</div>
  </div>
  <div class="kpi">
    <div class="kpi-label">Held By</div>
    <div class="kpi-value">${escapeHtml(String(numOf(concentration.mandate_count) ?? '—'))} mandates</div>
    <div class="kpi-sub">${escapeHtml(fmtQty(numOf(concentration.total_qty)))} shares</div>
  </div>
  <div class="kpi">
    <div class="kpi-label">Firm NGN Exposure</div>
    <div class="kpi-value">${escapeHtml(fmtNgnM(numOf(concentration.firm_value_ngn)))}</div>
    <div class="kpi-sub">${escapeHtml(fmtPct(numOf(concentration.pct_of_firm_aum)))} of firm AUM</div>
  </div>
  ${
    isFi
      ? `<div class="kpi">
          <div class="kpi-label">Maturity / YTM</div>
          <div class="kpi-value" style="font-size:20px">${escapeHtml(fmtDate(strOf(fiMeta.maturity_date)))}</div>
          <div class="kpi-sub">YTM ${escapeHtml(fmtRawPct(numOf(fiMeta.yield_pct)))}</div>
        </div>`
      : `<div class="kpi">
          <div class="kpi-label">Market Cap</div>
          <div class="kpi-value">${escapeHtml(fmtNgnM(numOf(marketCap.ngn)))}</div>
          <div class="kpi-sub">${escapeHtml(fmtShares(numOf(marketCap.shares_outstanding)))} shares O/S</div>
        </div>`
  }
</div>`

  // Movement
  let movementHtml = ''
  if (movement && (movement.day || movement.week || movement.month || movement.quarter)) {
    const day = (movement.day as AnyRecord) || {}
    const week = (movement.week as AnyRecord) || {}
    const month = (movement.month as AnyRecord) || {}
    const quarter = (movement.quarter as AnyRecord) || {}
    movementHtml = `
<div class="panel">
  <div class="panel-header"><h2>Movement</h2><div class="panel-meta">Today · Week · Month · Quarter</div></div>
  <div class="cell-grid" style="grid-template-columns: repeat(4, 1fr);">
    <div class="cell"><div class="cell-label">Today</div><div class="cell-value">${escapeHtml(fmtPctSigned(numOf(day.pct)))}</div></div>
    <div class="cell"><div class="cell-label">Week</div><div class="cell-value">${escapeHtml(fmtPctSigned(numOf(week.pct)))}</div></div>
    <div class="cell"><div class="cell-label">Month</div><div class="cell-value">${escapeHtml(fmtPctSigned(numOf(month.pct)))}</div></div>
    <div class="cell"><div class="cell-label">Quarter</div><div class="cell-value">${escapeHtml(fmtPctSigned(numOf(quarter.pct)))}</div></div>
  </div>
</div>`
  }

  // Valuation (equity only)
  let valuationHtml = ''
  if (isEquity && valuation && Object.keys(valuation).length > 0) {
    valuationHtml = `
<div class="panel">
  <div class="panel-header"><h2>Valuation Snapshot</h2><div class="panel-meta">P/E · P/B · PEG · Graham · EPS</div></div>
  <div class="cell-grid" style="grid-template-columns: repeat(6, 1fr);">
    <div class="cell"><div class="cell-label">P/E</div><div class="cell-value">${escapeHtml(fmtRatio(numOf(valuation.pe_ratio)))}</div></div>
    <div class="cell"><div class="cell-label">P/B</div><div class="cell-value">${escapeHtml(fmtRatio(numOf(valuation.pb_ratio)))}</div></div>
    <div class="cell"><div class="cell-label">PEG (3yr)</div><div class="cell-value">${escapeHtml(fmtPeg(numOf(valuation.peg_3yr)))}</div><div class="cell-sub">3yr CAGR ${escapeHtml(fmtRawPctSigned(numOf(valuation.eps_cagr_3yr_pct)))}</div></div>
    <div class="cell"><div class="cell-label">Graham #</div><div class="cell-value">${escapeHtml(fmtNgn(numOf(valuation.graham_number)))}</div></div>
    <div class="cell"><div class="cell-label">Graham 22.5</div><div class="cell-value">${valuation.graham_test_passes === true ? '<span class="pill pill-gold">Pass</span>' : valuation.graham_test_passes === false ? '<span class="pill pill-neg">Fail</span>' : '—'}</div></div>
    <div class="cell"><div class="cell-label">EPS</div><div class="cell-value">${escapeHtml(fmtNgn(numOf(valuation.eps_used)))}</div></div>
  </div>
</div>`
  }

  // Fundamentals (equity only)
  let fundamentalsHtml = ''
  if (isEquity && fundamentals && Object.keys(fundamentals).length > 0) {
    fundamentalsHtml = `
<div class="panel">
  <div class="panel-header"><h2>Fundamentals</h2><div class="panel-meta">${escapeHtml(strOf(fundamentals.period_type) || '')} · ${escapeHtml(fmtDate(strOf(fundamentals.period_end)))}</div></div>
  <div class="cell-grid" style="grid-template-columns: repeat(5, 1fr); margin-bottom: 14px;">
    <div class="cell"><div class="cell-label">Revenue</div><div class="cell-value">${escapeHtml(fmtNgnFromMillions(numOf(fundamentals.revenue_ngn_m)))}</div></div>
    <div class="cell"><div class="cell-label">Gross Profit</div><div class="cell-value">${escapeHtml(fmtNgnFromMillions(numOf(fundamentals.gross_profit_ngn_m)))}</div></div>
    <div class="cell"><div class="cell-label">Op Profit</div><div class="cell-value">${escapeHtml(fmtNgnFromMillions(numOf(fundamentals.operating_profit_ngn_m)))}</div></div>
    <div class="cell"><div class="cell-label">PBT</div><div class="cell-value">${escapeHtml(fmtNgnFromMillions(numOf(fundamentals.profit_before_tax_ngn_m)))}</div></div>
    <div class="cell"><div class="cell-label">PAT</div><div class="cell-value">${escapeHtml(fmtNgnFromMillions(numOf(fundamentals.profit_after_tax_ngn_m)))}</div></div>
  </div>
  <div class="cell-grid" style="grid-template-columns: repeat(7, 1fr);">
    <div class="cell"><div class="cell-label">Total Assets</div><div class="cell-value">${escapeHtml(fmtNgnFromMillions(numOf(fundamentals.total_assets_ngn_m)))}</div></div>
    <div class="cell"><div class="cell-label">Total Equity</div><div class="cell-value">${escapeHtml(fmtNgnFromMillions(numOf(fundamentals.total_equity_ngn_m)))}</div></div>
    <div class="cell"><div class="cell-label">Total Debt</div><div class="cell-value">${escapeHtml(fmtNgnFromMillions(numOf(fundamentals.total_debt_ngn_m)))}</div></div>
    <div class="cell"><div class="cell-label">Cash</div><div class="cell-value">${escapeHtml(fmtNgnFromMillions(numOf(fundamentals.cash_and_equivalents_ngn_m)))}</div></div>
    <div class="cell"><div class="cell-label">CFO</div><div class="cell-value">${escapeHtml(fmtNgnFromMillions(numOf(fundamentals.cash_from_operations_ngn_m)))}</div></div>
    <div class="cell"><div class="cell-label">ROE</div><div class="cell-value">${escapeHtml(fmtRawPct(numOf(fundamentals.roe_pct)))}</div></div>
    <div class="cell"><div class="cell-label">Net Margin</div><div class="cell-value">${escapeHtml(fmtRawPct(numOf(fundamentals.net_margin_pct)))}</div></div>
  </div>
</div>`
  }

  // AI Summary
  let aiHtml = ''
  if (isEquity && aiSummary && aiSummary.tilt) {
    const tiltLabel = String(aiSummary.tilt).toUpperCase()
    const tiltPill = aiSummary.tilt === 'bullish' ? 'pill-pos' : aiSummary.tilt === 'bearish' ? 'pill-neg' : 'pill-neutral'
    aiHtml = `
<div class="panel">
  <div class="panel-header"><h2>AI Financial Summary</h2><div class="panel-meta">${escapeHtml(strOf(aiSummary.confidence) || '')} confidence</div></div>
  <div style="margin-bottom: 14px;">
    <span class="pill ${tiltPill}">${escapeHtml(tiltLabel)}</span>
    <span style="margin-left: 10px; font-style: italic; color: #0f2947;">${escapeHtml(strOf(aiSummary.tilt_reason) || '')}</span>
  </div>
  <div style="font-size: 11px; line-height: 1.6;">
    <div style="margin-bottom: 8px;"><strong style="color:#2d6e4e">Strength:</strong> ${escapeHtml(strOf(aiSummary.strength) || '')}</div>
    <div style="margin-bottom: 8px;"><strong style="color:#a63b3b">Concern:</strong> ${escapeHtml(strOf(aiSummary.concern) || '')}</div>
    <div><strong style="color:#b08b3e">Watch For:</strong> ${escapeHtml(strOf(aiSummary.watch_for) || '')}</div>
  </div>
</div>`
  }

  // Disclosures
  let disclosuresHtml = ''
  if (isEquity && disclosures.length > 0) {
    const rows = disclosures
      .slice(0, 20)
      .map((d) => {
        const factsLine = renderDisclosureFactsLine(d)
        const isMaterial = d.material_event === true
        return `
        <tr>
          <td style="width:80px">${escapeHtml(fmtDate(strOf(d.modified_at)?.slice(0, 10) || null))}</td>
          <td style="width:90px"><span class="pill pill-gold">${escapeHtml(strOf(d.subcategory) || strOf(d.category) || '—')}</span></td>
          <td style="font-style:italic; color:#5c6573;">${escapeHtml(strOf(d.title) || '')}</td>
        </tr>
        ${factsLine ? `<tr><td colspan="3" class="facts-row${isMaterial ? ' material' : ''}">${factsLine}</td></tr>` : ''}`
      })
      .join('')
    disclosuresHtml = `
<div class="panel">
  <div class="panel-header"><h2>Corporate Disclosures</h2><div class="panel-meta">Latest ${disclosures.length}</div></div>
  <table>${rows}</table>
</div>`
  }

  // Director dealings
  let dealingsHtml = ''
  if (isEquity && dealings.length > 0) {
    const rows = dealings
      .slice(0, 20)
      .map((d) => {
        const factsLine = renderDealingFactsLine(d)
        return `
        <tr>
          <td style="width:80px">${escapeHtml(fmtDate(strOf(d.modified_at)?.slice(0, 10) || null))}</td>
          <td style="font-style:italic; color:#5c6573;">${escapeHtml(strOf(d.title) || '')}</td>
        </tr>
        ${factsLine ? `<tr><td colspan="2" class="facts-row">${factsLine}</td></tr>` : ''}`
      })
      .join('')
    dealingsHtml = `
<div class="panel">
  <div class="panel-header"><h2>Director Dealings</h2><div class="panel-meta">Latest ${dealings.length}</div></div>
  <table>${rows}</table>
</div>`
  }

  // Dividend snapshot
  let dividendHtml = ''
  if (isEquity && dividendSnapshot && Object.keys(dividendSnapshot).length > 0) {
    dividendHtml = `
<div class="panel">
  <div class="panel-header"><h2>Dividend Snapshot</h2><div class="panel-meta">${escapeHtml(strOf(dividendSnapshot.div_status) || '—')}</div></div>
  <div class="cell-grid" style="grid-template-columns: repeat(4, 1fr);">
    <div class="cell"><div class="cell-label">DPS</div><div class="cell-value">${escapeHtml(fmtNgn(numOf(dividendSnapshot.div_per_share)))}</div></div>
    <div class="cell"><div class="cell-label">Yield</div><div class="cell-value">${escapeHtml(fmtPct(numOf(dividendSnapshot.div_yield_pct)))}</div></div>
    <div class="cell"><div class="cell-label">Last Paid</div><div class="cell-value" style="font-size:14px">${escapeHtml(fmtDate(strOf(dividendSnapshot.last_div_date)))}</div></div>
    <div class="cell"><div class="cell-label">Next Expected</div><div class="cell-value" style="font-size:14px">${escapeHtml(fmtDate(strOf(dividendSnapshot.next_div_date)))}</div></div>
  </div>
  ${dividendSnapshot.div_notes ? `<div style="margin-top:12px;padding-top:10px;border-top:1px solid rgba(15,41,71,0.06);font-size:11px;color:#5c6573;line-height:1.55;">${escapeHtml(strOf(dividendSnapshot.div_notes) || '')}</div>` : ''}
</div>`
  }

  // Holders
  let holdersHtml = ''
  if (holders.length > 0) {
    const rows = holders
      .map((h) => {
        const pl = numOf(h.unrealised_pl_ngn) ?? 0
        const plColor = pl >= 0 ? '#2d6e4e' : '#a63b3b'
        return `
        <tr>
          <td>${escapeHtml(strOf(h.mandate_label) || '')}</td>
          <td>${escapeHtml(strOf(h.client_name) || '')}</td>
          <td class="num">${escapeHtml(fmtQty(numOf(h.qty)))}</td>
          <td class="num">${escapeHtml(fmtNgn(numOf(h.avg_cost)))}</td>
          <td class="num">${escapeHtml(fmtNgn(numOf(h.latest_price)))}</td>
          <td class="num">${escapeHtml(fmtNgnM(numOf(h.market_value_ngn)))}</td>
          <td class="num" style="color:${plColor}">${escapeHtml(fmtNgnM(pl))}</td>
          <td class="num">${escapeHtml(fmtPct(numOf(h.pct_of_portfolio_nav)))}</td>
        </tr>`
      })
      .join('')
    holdersHtml = `
<div class="panel">
  <div class="panel-header"><h2>Holders (${holders.length})</h2></div>
  <table>
    <thead><tr><th>Mandate</th><th>Client</th><th class="num">Qty</th><th class="num">Avg Cost</th><th class="num">Price</th><th class="num">Value</th><th class="num">Unrealised</th><th class="num">% NAV</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>`
  }

  // Recent transactions
  let transactionsHtml = ''
  if (transactions.length > 0) {
    const rows = transactions
      .slice(0, 20)
      .map((t) => `
        <tr>
          <td>${escapeHtml(fmtDate(strOf(t.trade_date)))}</td>
          <td><span class="pill pill-neutral">${escapeHtml(strOf(t.action) || '')}</span></td>
          <td>${escapeHtml(strOf(t.mandate_label) || '')}</td>
          <td class="num">${escapeHtml(fmtQty(numOf(t.qty)))}</td>
          <td class="num">${escapeHtml(fmtNgn(numOf(t.price)))}</td>
          <td class="num">${escapeHtml(fmtNgn(numOf(t.amount)))}</td>
        </tr>`)
      .join('')
    transactionsHtml = `
<div class="panel">
  <div class="panel-header"><h2>Recent Transactions</h2><div class="panel-meta">Last ${Math.min(transactions.length, 20)}</div></div>
  <table>
    <thead><tr><th>Date</th><th>Action</th><th>Mandate</th><th class="num">Qty</th><th class="num">Price</th><th class="num">NGN Value</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>`
  }

  // Suppress unused-var warnings on path-specific data
  void liquidity

  const body = header + kpi + movementHtml + valuationHtml + fundamentalsHtml + aiHtml + disclosuresHtml + dealingsHtml + dividendHtml + holdersHtml + transactionsHtml

  return htmlShell(`${name} (${ticker}) — Report`, body)
}

// ─────────────────────────────────────────────────────────────────
// Cockpit report
// ─────────────────────────────────────────────────────────────────

export function renderCockpitReport(data: AnyRecord): string {
  const summary = (data.summary as AnyRecord) || {}
  const allocations = (summary.allocations as AnyRecord[]) || []
  const idleCash = (summary.idle_cash_flags as AnyRecord[]) || []
  const staleReports = (summary.stale_reports as AnyRecord[]) || []

  const header = `
<div class="header">
  <div class="report-meta">
    <div>
      <div class="crumb">Transworld Investment and Securities · Cockpit Report</div>
      <h1>Firmwide Cockpit</h1>
      <div class="sub" style="margin-top: 4px;">Operator triage layer across all mandates</div>
    </div>
    <div class="report-stamp">Report ${escapeHtml(new Date().toISOString().slice(0, 10))}</div>
  </div>
</div>`

  const kpi = `
<div class="kpi-grid">
  <div class="kpi">
    <div class="kpi-label">Firm AUM</div>
    <div class="kpi-value">${escapeHtml(fmtNgnM(numOf(summary.firm_aum_ngn)))}</div>
    <div class="kpi-sub">${escapeHtml(String(numOf(summary.mandate_count) ?? '—'))} mandates</div>
  </div>
  <div class="kpi">
    <div class="kpi-label">Active Portfolios</div>
    <div class="kpi-value">${escapeHtml(String(numOf(summary.portfolio_count) ?? '—'))}</div>
  </div>
  <div class="kpi">
    <div class="kpi-label">Idle Cash Flags</div>
    <div class="kpi-value">${idleCash.length}</div>
  </div>
  <div class="kpi">
    <div class="kpi-label">Stale Reports</div>
    <div class="kpi-value">${staleReports.length}</div>
  </div>
</div>`

  let allocationsHtml = ''
  if (allocations.length > 0) {
    const rows = allocations
      .map((a) => `
        <tr>
          <td>${escapeHtml(strOf(a.sleeve_label) || strOf(a.sleeve_id) || '')}</td>
          <td class="num">${escapeHtml(fmtNgnM(numOf(a.value_ngn)))}</td>
          <td class="num">${escapeHtml(fmtPct(numOf(a.pct_of_firm)))}</td>
        </tr>`)
      .join('')
    allocationsHtml = `
<div class="panel">
  <div class="panel-header"><h2>Firmwide Allocation</h2></div>
  <table>
    <thead><tr><th>Sleeve</th><th class="num">Value</th><th class="num">% of Firm</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>`
  }

  let idleHtml = ''
  if (idleCash.length > 0) {
    const rows = idleCash
      .map((p) => `
        <tr>
          <td>${escapeHtml(strOf(p.mandate_label) || '')}</td>
          <td>${escapeHtml(strOf(p.client_name) || '')}</td>
          <td class="num">${escapeHtml(fmtNgnM(numOf(p.cash_ngn)))}</td>
          <td class="num">${escapeHtml(fmtPct(numOf(p.pct_of_nav)))}</td>
        </tr>`)
      .join('')
    idleHtml = `
<div class="panel">
  <div class="panel-header"><h2>Idle Cash Flags</h2><div class="panel-meta">${idleCash.length} mandates</div></div>
  <table>
    <thead><tr><th>Mandate</th><th>Client</th><th class="num">Cash</th><th class="num">% NAV</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>`
  }

  let staleHtml = ''
  if (staleReports.length > 0) {
    const rows = staleReports
      .map((p) => `
        <tr>
          <td>${escapeHtml(strOf(p.mandate_label) || '')}</td>
          <td>${escapeHtml(strOf(p.client_name) || '')}</td>
          <td>${escapeHtml(fmtDate(strOf(p.last_report_at)?.slice(0, 10) || null))}</td>
          <td class="num">${escapeHtml(String(numOf(p.days_stale) ?? '—'))}</td>
        </tr>`)
      .join('')
    staleHtml = `
<div class="panel">
  <div class="panel-header"><h2>Stale Reports</h2><div class="panel-meta">${staleReports.length} mandates</div></div>
  <table>
    <thead><tr><th>Mandate</th><th>Client</th><th>Last Report</th><th class="num">Days Stale</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
</div>`
  }

  const body = header + kpi + allocationsHtml + idleHtml + staleHtml
  return htmlShell('Transworld Cockpit — Report', body)
}

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

function numOf(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number' && isFinite(v)) return v
  return null
}

function strOf(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') return v
  return null
}

function fmtNgnFromMillions(v: number | null | undefined): string {
  if (v === null || v === undefined || !isFinite(v)) return '—'
  const sign = v < 0 ? '−' : ''
  const abs = Math.abs(v)
  if (abs >= 1e6) return sign + '\u20a6' + (abs / 1e6).toFixed(2) + 'T'
  if (abs >= 1e3) return sign + '\u20a6' + (abs / 1e3).toFixed(2) + 'B'
  if (abs >= 1) return sign + '\u20a6' + abs.toFixed(0) + 'M'
  return sign + '\u20a6' + (abs * 1e3).toFixed(0) + 'K'
}

function fmtRatio(v: number | null | undefined, dp = 1): string {
  if (v === null || v === undefined || !isFinite(v)) return '—'
  return v.toFixed(dp) + '×'
}

function fmtPeg(v: number | null | undefined): string {
  if (v === null || v === undefined || !isFinite(v)) return '—'
  return v.toFixed(2) + '×'
}

function fmtRawPctSigned(v: number | null | undefined, dp = 1): string {
  if (v === null || v === undefined || !isFinite(v)) return '—'
  return (v >= 0 ? '+' : '') + v.toFixed(dp) + '%'
}

// Render the inline "facts" sub-row for a disclosure with extracted facts.
// Returns empty string if no facts to render (i.e. extraction failed or
// disclosure is in non-material category like closed_period or press_release).
export function renderDisclosureFactsLine(d: AnyRecord): string {
  const subcategory = strOf(d.subcategory)
  const facts = (d.facts as AnyRecord) || {}
  const currency = strOf(d.currency) || 'NGN'
  const currencySym = currency === 'NGN' ? '\u20a6' : currency === 'GBp' ? '' : currency === 'GBP' ? '£' : currency === 'USD' ? '$' : ''
  const currencySuffix = currency === 'GBp' ? 'p' : ''

  if (strOf(d.extraction_status) === 'scanned_pdf') {
    return `<em style="color:#a67c2a">Scanned PDF · structured extraction not possible</em>`
  }
  if (!subcategory || subcategory === 'other' || !facts || Object.keys(facts).length === 0) {
    return ''
  }

  switch (subcategory) {
    case 'dividend': {
      const dps = numOf(facts.dps)
      const dt = strOf(facts.dividend_type)
      const qd = strOf(facts.qualification_date)
      const pd = strOf(facts.payment_date)
      const ad = strOf(facts.agm_date)
      const parts: string[] = []
      if (dps !== null) parts.push(`DPS ${currencySym}${dps.toFixed(2)}${currencySuffix}`)
      if (dt) parts.push(escapeHtml(dt))
      if (qd) parts.push(`Qual ${escapeHtml(fmtDate(qd))}`)
      if (pd) parts.push(`Pay ${escapeHtml(fmtDate(pd))}`)
      if (ad) parts.push(`AGM ${escapeHtml(fmtDate(ad))}`)
      return parts.join(' · ')
    }
    case 'agm_resolution': {
      const ddps = numOf(facts.dividend_declared_dps)
      const dtotal = numOf(facts.dividend_declared_total_pool)
      const dyear = numOf(facts.dividend_total_for_year)
      const re = Array.isArray(facts.board_re_elected) ? facts.board_re_elected.length : 0
      const apt = Array.isArray(facts.board_appointed) ? facts.board_appointed.length : 0
      const res = Array.isArray(facts.board_resigned) ? facts.board_resigned.length : 0
      const major = Array.isArray(facts.major_resolutions) ? facts.major_resolutions.length : 0
      const parts: string[] = []
      if (ddps !== null) parts.push(`Dividend ${currencySym}${ddps.toFixed(2)}/share`)
      if (dtotal !== null) parts.push(`Total ${currencySym}${(dtotal / 1e9).toFixed(2)}B`)
      if (dyear !== null) parts.push(`Year total ${currencySym}${dyear.toFixed(2)}`)
      if (re) parts.push(`${re} re-elected`)
      if (apt) parts.push(`${apt} appointed`)
      if (res) parts.push(`${res} resigned`)
      if (major) parts.push(`${major} major resolution${major === 1 ? '' : 's'}`)
      return parts.join(' · ')
    }
    case 'board_change': {
      const name = strOf(facts.director_name)
      const pos = strOf(facts.position)
      const action = strOf(facts.action)
      const ed = strOf(facts.effective_date)
      const parts: string[] = []
      if (action) parts.push(escapeHtml(action))
      if (name) parts.push(escapeHtml(name))
      if (pos) parts.push(escapeHtml(pos))
      if (ed) parts.push(`effective ${escapeHtml(fmtDate(ed))}`)
      return parts.join(' · ')
    }
    case 'rights_issue': {
      const sc = numOf(facts.share_count)
      const ip = numOf(facts.issue_price)
      const rn = numOf(facts.ratio_new)
      const re = numOf(facts.ratio_existing)
      const status = strOf(facts.status)
      const parts: string[] = []
      if (sc !== null) parts.push(`${sc.toLocaleString('en-US')} shares`)
      if (ip !== null) parts.push(`@ ${currencySym}${ip.toFixed(2)}`)
      if (rn !== null && re !== null) parts.push(`${rn}-for-${re}`)
      if (status) parts.push(escapeHtml(status))
      return parts.join(' · ')
    }
    case 'share_transaction': {
      const tt = strOf(facts.transaction_type)
      const st = numOf(facts.shares_transacted)
      const vwap = numOf(facts.vwap_per_share)
      const sr = numOf(facts.shares_remaining_in_issue)
      const parts: string[] = []
      if (st !== null) parts.push(`${st.toLocaleString('en-US')} shares`)
      if (vwap !== null) parts.push(`@ ${vwap.toFixed(2)} ${escapeHtml(currency)}${currencySuffix}`)
      if (tt) parts.push(escapeHtml(tt))
      if (sr !== null) parts.push(`${(sr / 1e9).toFixed(2)}B in issue`)
      return parts.join(' · ')
    }
    case 'voting_rights': {
      const total = numOf(facts.total_shares_in_issue)
      const voting = numOf(facts.voting_rights_total)
      const treasury = numOf(facts.treasury_shares)
      const asof = strOf(facts.as_of_date)
      const parts: string[] = []
      if (total !== null) parts.push(`${(total / 1e9).toFixed(2)}B shares`)
      if (voting !== null) parts.push(`${(voting / 1e9).toFixed(2)}B voting`)
      if (treasury !== null) parts.push(`${(treasury / 1e6).toFixed(2)}M treasury`)
      if (asof) parts.push(`as of ${escapeHtml(fmtDate(asof))}`)
      return parts.join(' · ')
    }
    case 'mna': {
      const tt = strOf(facts.transaction_type)
      const cp = strOf(facts.counterparty)
      const tgt = strOf(facts.target_or_subject)
      const v = numOf(facts.value)
      const status = strOf(facts.status)
      const parts: string[] = []
      if (tt) parts.push(escapeHtml(tt))
      if (cp) parts.push(escapeHtml(cp))
      if (tgt) parts.push(escapeHtml(tgt))
      if (v !== null) parts.push(`${currencySym}${(v / 1e9).toFixed(2)}B`)
      if (status) parts.push(escapeHtml(status))
      return parts.join(' · ')
    }
    case 'earnings_release': {
      const pt = strOf(facts.period_type)
      const pe = strOf(facts.period_end)
      const rev = numOf(facts.revenue)
      const pat = numOf(facts.pat)
      const eps = numOf(facts.eps)
      const parts: string[] = []
      if (pt) parts.push(escapeHtml(pt))
      if (pe) parts.push(escapeHtml(fmtDate(pe)))
      if (rev !== null) parts.push(`Revenue ${currencySym}${(rev / 1e9).toFixed(2)}B`)
      if (pat !== null) parts.push(`PAT ${currencySym}${(pat / 1e9).toFixed(2)}B`)
      if (eps !== null) parts.push(`EPS ${currencySym}${eps.toFixed(2)}`)
      return parts.join(' · ')
    }
    case 'closed_period': {
      const s = strOf(facts.closed_period_start)
      const e = strOf(facts.closed_period_end)
      if (!s && !e) return ''
      return `${s ? escapeHtml(fmtDate(s)) : '?'} — ${e ? escapeHtml(fmtDate(e)) : '?'}`
    }
    default:
      return ''
  }
}

export function renderDealingFactsLine(d: AnyRecord): string {
  if (strOf(d.extraction_status) === 'scanned_pdf') {
    return `<em style="color:#a67c2a">Scanned PDF · structured extraction not possible</em>`
  }
  const name = strOf(d.insider_name)
  const pos = strOf(d.insider_position)
  const tt = strOf(d.transaction_type)
  const sc = numOf(d.share_count)
  const pps = numOf(d.price_per_share)
  const tv = numOf(d.total_value)
  const td = strOf(d.transaction_date)
  const currency = strOf(d.currency) || 'NGN'
  const sym = currency === 'NGN' ? '\u20a6' : currency === 'GBp' ? '' : currency === 'GBP' ? '£' : currency === 'USD' ? '$' : ''
  const sfx = currency === 'GBp' ? 'p' : ''

  if (!name && !tt && sc === null) return '' // No extraction available

  const parts: string[] = []
  if (tt) parts.push(`<strong>${escapeHtml(tt)}</strong>`)
  if (name) parts.push(escapeHtml(name))
  if (pos) parts.push(`<span style="color:#8a8f9a">(${escapeHtml(pos)})</span>`)
  if (sc !== null) parts.push(`${sc.toLocaleString('en-US')} shares`)
  if (pps !== null) parts.push(`@ ${sym}${pps.toFixed(2)}${sfx}`)
  if (tv !== null) parts.push(`${sym}${(tv / 1e6).toFixed(2)}M`)
  if (td) parts.push(escapeHtml(fmtDate(td)))
  return parts.join(' · ')
}
