'use client'

import { useEffect, useRef } from 'react'
import { Chart, LineController, LineElement, PointElement, LinearScale, CategoryScale, Filler, Tooltip, type ChartConfiguration } from 'chart.js'

Chart.register(LineController, LineElement, PointElement, LinearScale, CategoryScale, Filler, Tooltip)

// v27 — Firm AUM trend (12-month line chart)

interface AUMTrendPoint {
  date:    string
  aum_ngn: number
}

interface Props {
  data: AUMTrendPoint[]
}

function fmtMonthLabel(iso: string): string {
  const d = new Date(iso + 'T00:00:00Z')
  return d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })
}

function fmtNgnB(v: number): string {
  if (Math.abs(v) >= 1e9) return '\u20a6' + (v / 1e9).toFixed(2) + 'B'
  if (Math.abs(v) >= 1e6) return '\u20a6' + (v / 1e6).toFixed(1) + 'M'
  return '\u20a6' + v.toLocaleString()
}

export default function FirmAUMTrend({ data }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const chartRef = useRef<Chart | null>(null)

  useEffect(() => {
    if (!canvasRef.current) return
    if (chartRef.current) { chartRef.current.destroy(); chartRef.current = null }
    if (data.length === 0) return

    const labels = data.map(d => fmtMonthLabel(d.date))
    const values = data.map(d => d.aum_ngn)

    const config: ChartConfiguration<'line'> = {
      type: 'line',
      data: {
        labels,
        datasets: [{
          label: 'AUM',
          data: values,
          borderColor: '#0f2947',
          backgroundColor: 'rgba(176, 139, 62, 0.10)',
          borderWidth: 2,
          fill: true,
          tension: 0.25,
          pointRadius: ((ctx: any) => ctx.dataIndex === values.length - 1 ? 5 : 3) as any,
          pointHoverRadius: 6,
          pointBackgroundColor: ((ctx: any) => ctx.dataIndex === values.length - 1 ? '#c9a556' : '#0f2947') as any,
          pointBorderColor: '#fffbf2',
          pointBorderWidth: 1.5,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 350 },
        scales: {
          x: {
            grid: { color: 'rgba(15, 41, 71, 0.04)' },
            ticks: { color: '#5c6573', font: { size: 11, family: 'DM Sans' } },
          },
          y: {
            grid: { color: 'rgba(15, 41, 71, 0.06)' },
            ticks: {
              color: '#5c6573',
              font: { size: 11, family: 'DM Sans' },
              callback: (v) => fmtNgnB(Number(v)),
            },
            beginAtZero: true,
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: 'rgba(10, 31, 58, 0.96)',
            titleColor: '#c9a556',
            bodyColor: '#e8d9b5',
            padding: 11,
            displayColors: false,
            titleFont: { family: 'DM Sans', size: 12, weight: 600 },
            bodyFont:  { family: 'DM Sans', size: 11 },
            callbacks: {
              title: (items) => items[0].label,
              label: (item) => fmtNgnB(Number(item.parsed.y)),
            },
          },
        },
      },
    }
    chartRef.current = new Chart(canvasRef.current, config)
    return () => { chartRef.current?.destroy(); chartRef.current = null }
  }, [data])

  return (
    <div style={{ position: 'relative', height: 240 }}>
      <canvas ref={canvasRef} />
      {data.length === 0 && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--text-3)',
            fontSize: 12,
          }}
        >
          No NAV history yet
        </div>
      )}
    </div>
  )
}
