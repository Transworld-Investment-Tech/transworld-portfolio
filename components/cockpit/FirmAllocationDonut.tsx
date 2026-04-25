'use client'

import { useEffect, useRef } from 'react'
import { Chart, ArcElement, Tooltip, DoughnutController } from 'chart.js'
import { colorForSleeve } from '@/lib/portfolio'

Chart.register(ArcElement, Tooltip, DoughnutController)

// v27 — Firm-wide allocation rollup donut (mirrors AllocationDonut shape)

interface SleeveRollup {
  sleeve_id: string
  name:      string
  ngn:       number
  pct:       number
}

interface Props {
  data: SleeveRollup[]
}

function fmtNgnM(v: number): string {
  if (v >= 1e9) return '\u20a6' + (v / 1e9).toFixed(2) + 'B'
  return '\u20a6' + (v / 1e6).toFixed(2) + 'M'
}

export default function FirmAllocationDonut({ data }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const chartRef = useRef<Chart | null>(null)

  const totalAUM = data.reduce((s, d) => s + d.ngn, 0)

  useEffect(() => {
    if (!canvasRef.current) return
    if (chartRef.current) chartRef.current.destroy()
    if (data.length === 0) return

    chartRef.current = new Chart(canvasRef.current, {
      type: 'doughnut',
      data: {
        labels: data.map(s => s.name),
        datasets: [{
          data: data.map(s => Math.round(s.ngn / 10000) / 100),
          backgroundColor: data.map((s, i) => colorForSleeve(s.sleeve_id, i)),
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
                const sl = data[ctx.dataIndex]
                return ` ${fmtNgnM(sl.ngn)} · ${(sl.pct * 100).toFixed(1)}%`
              },
            },
          },
        },
        animation: { animateRotate: true, duration: 600 },
      },
    })
    return () => { chartRef.current?.destroy() }
  }, [data])

  return (
    <div>
      <div style={{ position: 'relative', height: 220 }}>
        <canvas ref={canvasRef} />
        {data.length > 0 && (
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
              Firm AUM
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
              {fmtNgnM(totalAUM)}
            </div>
          </div>
        )}
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
        {data.map((s, i) => (
          <div key={s.sleeve_id} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
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
              {(s.pct * 100).toFixed(1)}%
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
