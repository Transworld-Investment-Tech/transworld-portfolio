// lib/retired-shares-html.ts — v27z
//
// Renderer for the retired-shares HTML download. Same philosophy as
// lib/html-report.ts: pure function, returns a fully self-contained
// HTML document with all styles inlined inside <head>. The downloaded
// file opens cleanly in any browser, prints correctly, and saves
// correctly via Cmd+S without depending on any of the live app's
// styling (which fights @media print due to stacked min-height: 100vh
// constraints — see v27x→v27y).
//
// Palette: navy #0a1f3a × cream #f5efe0/#fffbf2 × muted gold #b08b3e.
// Typography: Cormorant Garamond (display) + DM Sans (body).
//
// Used by app/api/admin/portfolios/[id]/retired-shares/html/route.ts.

export interface RetiredRowForReport {
  id: string
  trade_date: string
  instrument_id: string
  instrument_name: string
  quantity: number
  price: number
  amount: number
  notes: string | null
  external_ref: string
}

export interface RetiredSharesReportData {
  portfolio: {
    id: string
    label: string
    name: string
    client_name: string
    client_code: string
  }
  zeroRecovery: RetiredRowForReport[]
  delisting: RetiredRowForReport[]
  generatedAt: string  // ISO string; renderer formats it
}

function fmtNum(n: number, digits = 0): string {
  return n.toLocaleString('en-GB', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

function fmtNaira(n: number): string {
  return `₦${n.toLocaleString('en-GB', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-GB', {
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })
  } catch { return iso }
}

// Defensive HTML escape for any text from DB (notes, names, etc.) that
// could conceivably contain < > & or quotes.
function esc(s: string | null | undefined): string {
  if (s === null || s === undefined) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function renderRetiredSharesHTML(data: RetiredSharesReportData): string {
  const { portfolio, zeroRecovery, delisting } = data
  const totalCount = zeroRecovery.length + delisting.length
  const totalQuantityZero = zeroRecovery.reduce((s, r) => s + r.quantity, 0)
  const totalConsiderationDelisting = delisting.reduce((s, r) => s + r.amount, 0)

  const zeroRecoveryRows = zeroRecovery.map(r => `
    <tr>
      <td class="mono">${esc(r.instrument_id)}</td>
      <td class="muted">${esc(r.instrument_name) || '—'}</td>
      <td class="num serif">${fmtNum(r.quantity)}</td>
      <td class="mono">${esc(r.trade_date)}</td>
      <td class="muted small">${esc(r.notes) || '—'}</td>
    </tr>
  `).join('')

  const delistingRows = delisting.map(r => `
    <tr>
      <td class="mono">${esc(r.instrument_id)}</td>
      <td class="muted">${esc(r.instrument_name) || '—'}</td>
      <td class="num serif">${fmtNum(r.quantity)}</td>
      <td class="num serif">${r.price > 0 ? fmtNum(r.price, 2) : '—'}</td>
      <td class="num serif gold">${r.amount > 0 ? fmtNaira(r.amount) : '—'}</td>
      <td class="mono">${esc(r.trade_date)}</td>
    </tr>
  `).join('')

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Retired shares — ${esc(portfolio.client_name)} · Portfolio ${esc(portfolio.label)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600&family=DM+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
  /* Self-contained styling — no external CSS dependencies. */
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    background: #fffbf2;
    color: #0f2947;
    font-family: 'DM Sans', sans-serif;
    font-size: 13px;
    line-height: 1.5;
  }
  body { padding: 32px 40px; max-width: 920px; margin: 0 auto; }

  /* Header */
  .head {
    display: flex; justify-content: space-between; align-items: flex-end;
    border-bottom: 1px solid rgba(15, 41, 71, 0.18);
    padding-bottom: 18px; margin-bottom: 24px;
  }
  .eyebrow {
    font-size: 10px; letter-spacing: 0.18em; font-weight: 600;
    color: #b08b3e; text-transform: uppercase; margin-bottom: 8px;
  }
  h1 {
    font-family: 'Cormorant Garamond', serif;
    font-weight: 500; font-size: 32px;
    letter-spacing: -0.005em; line-height: 1; color: #0f2947;
  }
  .head-meta {
    text-align: right; font-size: 11px; color: #5c6573;
  }
  .head-meta strong { color: #0f2947; font-weight: 500; }

  /* KPI strip */
  .kpis {
    display: grid; grid-template-columns: repeat(3, 1fr);
    gap: 12px; margin-bottom: 22px;
  }
  .kpi {
    background: white;
    border: 1px solid rgba(15, 41, 71, 0.1);
    border-top: 3px solid #b08b3e;
    padding: 14px 16px; border-radius: 4px;
  }
  .kpi.zero { border-top-color: #a63b3b; }
  .kpi.delist { border-top-color: #a67c2a; }
  .kpi-label {
    font-size: 9px; letter-spacing: 0.16em; font-weight: 600;
    color: #5c6573; text-transform: uppercase; margin-bottom: 8px;
  }
  .kpi-value {
    font-family: 'Cormorant Garamond', serif;
    font-size: 28px; font-weight: 500; letter-spacing: -0.01em;
    line-height: 1; color: #b08b3e;
  }
  .kpi.zero .kpi-value { color: #a63b3b; }
  .kpi.delist .kpi-value { color: #a67c2a; }
  .kpi-sub { font-size: 10px; color: #8a8f9a; margin-top: 6px; }

  /* Disclaimer banner */
  .disclaimer {
    background: rgba(176, 139, 62, 0.1);
    border: 1px solid rgba(176, 139, 62, 0.4);
    border-radius: 4px;
    padding: 12px 16px; margin-bottom: 22px;
    font-size: 12px; line-height: 1.6;
  }
  .disclaimer strong { color: #b08b3e; font-weight: 600; }

  /* Panels */
  .panel {
    background: white;
    border: 1px solid rgba(15, 41, 71, 0.12);
    border-radius: 4px;
    padding: 18px 20px; margin-bottom: 18px;
    page-break-inside: auto;
  }
  .panel-head {
    display: flex; justify-content: space-between; align-items: flex-start;
    padding-bottom: 12px; margin-bottom: 14px;
    border-bottom: 1px solid rgba(15, 41, 71, 0.08);
  }
  .panel-title {
    font-family: 'Cormorant Garamond', serif;
    font-style: italic; font-size: 18px; font-weight: 500;
    color: #0f2947;
  }
  .panel-sub {
    font-size: 11px; color: #5c6573; margin-top: 4px; line-height: 1.5;
  }
  .pill {
    display: inline-block; padding: 3px 9px; border-radius: 2px;
    font-size: 9px; letter-spacing: 0.14em; font-weight: 600;
    text-transform: uppercase; border: 1px solid currentColor;
  }
  .pill-breach { color: #a63b3b; background: rgba(166, 59, 59, 0.1); }
  .pill-warn { color: #a67c2a; background: rgba(166, 124, 42, 0.12); }

  .high-priority { color: #a63b3b; font-weight: 700; }

  .panel-note {
    font-size: 11px; color: #5c6573; font-style: italic;
    line-height: 1.6; padding-bottom: 12px;
  }

  /* Tables */
  table { width: 100%; border-collapse: collapse; }
  thead th {
    text-align: left;
    padding: 8px 10px;
    font-size: 9px; letter-spacing: 0.12em; font-weight: 600;
    color: #5c6573; text-transform: uppercase;
    border-bottom: 1px solid rgba(15, 41, 71, 0.18);
  }
  tbody td {
    padding: 10px 10px;
    border-bottom: 1px solid rgba(15, 41, 71, 0.06);
    font-size: 12px;
    vertical-align: top;
  }
  tbody tr:last-child td { border-bottom: none; }
  th.num, td.num { text-align: right; }
  td.mono { font-family: 'Courier New', monospace; font-size: 11px; }
  td.muted { color: #5c6573; }
  td.small { font-size: 11px; max-width: 460px; line-height: 1.5; }
  td.serif {
    font-family: 'Cormorant Garamond', serif;
    font-size: 15px; font-weight: 500; letter-spacing: -0.005em;
  }
  td.gold { color: #b08b3e; }

  /* Footer */
  .footer {
    margin-top: 32px; padding-top: 16px;
    border-top: 1px solid rgba(15, 41, 71, 0.12);
    font-size: 10px; color: #8a8f9a; text-align: center;
    line-height: 1.6;
  }

  /* Empty state */
  .empty {
    background: white;
    border: 1px solid rgba(15, 41, 71, 0.12);
    border-radius: 4px;
    padding: 32px; text-align: center;
    color: #5c6573; font-size: 13px;
  }

  /* Print */
  @media print {
    @page { size: A4; margin: 14mm 12mm; }
    html, body {
      background: white;
      padding: 0; margin: 0;
      max-width: none;
    }
    .panel, .kpi, .disclaimer { page-break-inside: avoid; }
    thead { display: table-header-group; }
    tr { page-break-inside: avoid; }
  }
</style>
</head>
<body>

<div class="head">
  <div>
    <div class="eyebrow">${esc(portfolio.client_name)} · Portfolio ${esc(portfolio.label)}</div>
    <h1>Retired shares</h1>
  </div>
  <div class="head-meta">
    <div><strong>Generated</strong> ${esc(fmtDate(data.generatedAt))}</div>
    <div>Transworld Asset Management</div>
  </div>
</div>

${totalCount === 0 ? `
  <div class="empty">No retired-share records for this portfolio.</div>
` : `

  <div class="kpis">
    <div class="kpi zero">
      <div class="kpi-label">Zero-recovery positions</div>
      <div class="kpi-value">${zeroRecovery.length}</div>
      <div class="kpi-sub">${totalQuantityZero > 0 ? `${fmtNum(totalQuantityZero)} units · high priority` : 'High priority'}</div>
    </div>
    <div class="kpi delist">
      <div class="kpi-label">Delisting writeoffs</div>
      <div class="kpi-value">${delisting.length}</div>
      <div class="kpi-sub">${totalConsiderationDelisting > 0 ? `~${fmtNaira(totalConsiderationDelisting)} consideration` : 'Verify with registrar'}</div>
    </div>
    <div class="kpi">
      <div class="kpi-label">Total retired</div>
      <div class="kpi-value">${totalCount}</div>
      <div class="kpi-sub">Across both categories</div>
    </div>
  </div>

  <div class="disclaimer">
    <strong>For client follow-up.</strong> Positions retired from the portfolio
    that may have outstanding consideration from the issuer's registrar.
    Operator should contact each registrar with the client's CSCS number and
    original holding details to confirm payment status. This report is a
    checklist for client service, not a record of unpaid amounts.
  </div>

  ${zeroRecovery.length === 0 ? '' : `
    <div class="panel">
      <div class="panel-head">
        <div>
          <div class="panel-title">Zero-recovery writeoffs</div>
          <div class="panel-sub">
            Retired with no recorded consideration ·
            ${zeroRecovery.length} position${zeroRecovery.length === 1 ? '' : 's'} ·
            <span class="high-priority">HIGH PRIORITY</span>
          </div>
        </div>
        <span class="pill pill-breach">Action recommended</span>
      </div>
      <table>
        <thead>
          <tr>
            <th>Ticker</th>
            <th>Name</th>
            <th class="num">Quantity retired</th>
            <th>Retirement date</th>
            <th>Reason / corporate action</th>
          </tr>
        </thead>
        <tbody>${zeroRecoveryRows}</tbody>
      </table>
    </div>
  `}

  ${delisting.length === 0 ? '' : `
    <div class="panel">
      <div class="panel-head">
        <div>
          <div class="panel-title">Delisting writeoffs</div>
          <div class="panel-sub">
            Retired at scheme/last-traded price ·
            ${delisting.length} position${delisting.length === 1 ? '' : 's'} ·
            Verify with registrar
          </div>
        </div>
        <span class="pill pill-warn">Verify</span>
      </div>
      <div class="panel-note">
        Scheme consideration for these positions would have been paid directly
        to the client's bank account or registrar — not to the broker. The
        recorded amount approximates the per-share consideration but actual
        payment status should be confirmed with the registrar.
      </div>
      <table>
        <thead>
          <tr>
            <th>Ticker</th>
            <th>Name</th>
            <th class="num">Quantity retired</th>
            <th class="num">Per-share price</th>
            <th class="num">Approx. consideration</th>
            <th>Retirement date</th>
          </tr>
        </thead>
        <tbody>${delistingRows}</tbody>
      </table>
    </div>
  `}

`}

<div class="footer">
  Transworld Asset Management · Portfolio Intelligence Platform<br>
  This report is generated for internal operations and client follow-up only.
</div>

</body>
</html>`
}
