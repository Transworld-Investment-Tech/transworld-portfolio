'use client'
import { useRef, useEffect } from 'react'
import { Chart, ArcElement, Tooltip, DoughnutController } from 'chart.js'
import { fmt } from '@/lib/portfolio'

// v20: Hybrid-palette composition donut. Hardcoded sleeve colors override
// whatever SLEEVE_COLOURS in lib/portfolio ships with, so this component
// always renders on-brand regardless of legacy values. When lib/portfolio
// is rewritten in v20b/v20c, this map can be removed.
const HYBRID_SLEEVE_COLORS: Record<string, string> = {
  liq: '#0a1f3a', // navy
  eq:  '#b08b3e', // muted gold
  fi:  '#2d6e4e', // muted green
}
const FALLBACK_PALETTE = ['#b08b3e', '#0a1f3a', '#2d6e4e', '#a67c2a', '#c9a556']

Chart.register(ArcElement, Tooltip, DoughnutController)

interface Sleeve {
  sleeve_id: string
  name: string
  val: number
  act: number
  target_pct: number
  status: string
}

function colorForSleeve(id: string, idx: number): string {
  return HYBRID_SLEEVE_COLORS[id] ?? FALLBACK_PALETTE[idx % FALLBACK_PALETTE.length]
}

export default function AllocationDonut({
  sleeves,
  totalNAV,
}: {
  sleeves: Sleeve[]
  totalNAV: number
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const chartRef = useRef<Chart | null>(null)

  useEffect(() => {
    if (!canvasRef.current) return
    if (chartRef.current) chartRef.current.destroy()

    chartRef.current = new Chart(canvasRef.current, {
      type: 'doughnut',
      data: {
        labels: sleeves.map(s => s.name),
        datasets: [{
          data: sleeves.map(s => Math.round(s.val / 10000) / 100),
          backgroundColor: sleeves.map((s, i) => colorForSleeve(s.sleeve_id, i)),
          borderWidth: 2,
          borderColor: '#fffbf2',      // hybrid card bg for clean separation
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
                const sl = sleeves[ctx.dataIndex]
                return ` ${fmt.ngnM(sl.val)} · ${fmt.pct(sl.act)}`
              },
            },
          },
        },
        animation: { animateRotate: true, duration: 600 },
      },
    })

    return () => { chartRef.current?.destroy() }
  }, [sleeves, totalNAV])

  return (
    <div>
      <div style={{ position: 'relative', height: 220 }}>
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
            Total NAV
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
            {fmt.ngnM(totalNAV)}
          </div>
        </div>
      </div>

      {/* Legend */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: '8px 18px',
          marginTop: 16,
          justifyContent: 'center',
        }}
      >
        {sleeves.map((s, i) => (
          <div
            key={s.sleeve_id}
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: 2,
                background: colorForSleeve(s.sleeve_id, i),
                display: 'inline-block',
                flexShrink: 0,
              }}
            />
            <span style={{ fontSize: 11, color: 'var(--text-2)' }}>{s.name}</span>
            <span
              style={{
                fontSize: 11,
                fontFamily: 'var(--font-mono)',
                color: 'var(--text-3)',
              }}
            >
              {fmt.pct(s.act)}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
