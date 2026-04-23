'use client'
import { useRef, useEffect } from 'react'
import { Chart, ArcElement, Tooltip, DoughnutController } from 'chart.js'
import { fmt, HYBRID_PALETTE } from '@/lib/portfolio'

// v21h: Sector concentration donut — NAV-weighted breakdown of held
// equities by NGX sector. Mirrors AllocationDonut's look and feel
// (same cutout, same tooltip style, same center-label treatment) so
// the two charts sit side-by-side on Overview without fighting.
//
// NULL sectors are bucketed into "Unclassified" in a muted gray so
// coverage gaps are visible rather than hidden. This will matter
// until every NGX equity has sector populated — per v20h, ~82% of
// the instruments master has sector today.

Chart.register(ArcElement, Tooltip, DoughnutController)

export interface SectorSlice {
  sector: string           // display label (includes 'Unclassified')
  value: number            // NGN
  pct: number              // 0..1
  count: number            // number of holdings in the sector
}

const UNCLASSIFIED_COLOR = '#b8bcc5'  // --text-4 — muted gray

export default function SectorDonut({
  slices,
  totalEquityNAV,
}: {
  slices: SectorSlice[]
  totalEquityNAV: number
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const chartRef = useRef<Chart | null>(null)

  useEffect(() => {
    if (!canvasRef.current) return
    if (chartRef.current) chartRef.current.destroy()

    const colors = slices.map((s, i) =>
      s.sector === 'Unclassified'
        ? UNCLASSIFIED_COLOR
        : HYBRID_PALETTE[i % HYBRID_PALETTE.length]
    )

    chartRef.current = new Chart(canvasRef.current, {
      type: 'doughnut',
      data: {
        labels: slices.map(s => s.sector),
        datasets: [{
          data: slices.map(s => Math.round(s.value / 10000) / 100),
          backgroundColor: colors,
          borderWidth: 2,
          borderColor: '#fffbf2',
          hoverBorderColor: '#faf5ea',
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '68%',
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#fffbf2',
            borderColor: 'rgba(15, 41, 71, 0.12)',
            borderWidth: 1,
            titleColor: '#0f2947',
            bodyColor: '#5c6573',
            padding: 10,
            titleFont: { family: 'DM Sans, system-ui, sans-serif', size: 12, weight: 600 },
            bodyFont:  { family: 'DM Sans, system-ui, sans-serif', size: 11 },
            callbacks: {
              label: ctx => {
                const sl = slices[ctx.dataIndex]
                return ` ${fmt.ngnM(sl.value)} · ${(sl.pct * 100).toFixed(1)}% · ${sl.count} position${sl.count === 1 ? '' : 's'}`
              },
            },
          },
        },
        animation: { animateRotate: true, duration: 600 },
      },
    })

    return () => { chartRef.current?.destroy() }
  }, [slices, totalEquityNAV])

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '240px 1fr', gap: 24, alignItems: 'center' }}>
      {/* Donut */}
      <div style={{ position: 'relative', height: 220, width: 220 }}>
        <canvas ref={canvasRef} />
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            pointerEvents: 'none',
            gap: 2,
          }}
        >
          <div
            style={{
              fontSize: 9,
              letterSpacing: '0.16em',
              color: 'var(--text-3)',
              textTransform: 'uppercase',
              fontWeight: 600,
            }}
          >
            Equity NAV
          </div>
          <div
            style={{
              fontFamily: 'var(--font-serif)',
              fontSize: 22,
              fontWeight: 500,
              color: 'var(--text)',
              letterSpacing: '-0.01em',
              lineHeight: 1,
            }}
          >
            {fmt.ngnM(totalEquityNAV)}
          </div>
          <div
            style={{
              fontSize: 10,
              color: 'var(--text-3)',
              marginTop: 3,
            }}
          >
            {slices.length} sector{slices.length === 1 ? '' : 's'}
          </div>
        </div>
      </div>

      {/* Legend table */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {slices.map((s, i) => {
          const color = s.sector === 'Unclassified'
            ? UNCLASSIFIED_COLOR
            : HYBRID_PALETTE[i % HYBRID_PALETTE.length]
          return (
            <div
              key={s.sector}
              style={{
                display: 'grid',
                gridTemplateColumns: '12px 1fr auto auto',
                alignItems: 'center',
                gap: 10,
                paddingBottom: 6,
                borderBottom: i < slices.length - 1 ? '1px solid var(--border-soft)' : 'none',
              }}
            >
              <span
                style={{
                  width: 10,
                  height: 10,
                  borderRadius: 2,
                  background: color,
                  display: 'inline-block',
                }}
              />
              <div>
                <span style={{ fontSize: 12, color: 'var(--text)', fontWeight: 500 }}>
                  {s.sector}
                </span>
                <span style={{ fontSize: 10, color: 'var(--text-3)', marginLeft: 8 }}>
                  {s.count} position{s.count === 1 ? '' : 's'}
                </span>
              </div>
              <span
                className="num-serif"
                style={{
                  fontSize: 13,
                  color: 'var(--text)',
                }}
              >
                {fmt.ngnM(s.value)}
              </span>
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 11,
                  color: 'var(--text-2)',
                  minWidth: 50,
                  textAlign: 'right' as const,
                }}
              >
                {(s.pct * 100).toFixed(1)}%
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
