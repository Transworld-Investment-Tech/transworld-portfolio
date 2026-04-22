'use client'
import { useRef, useEffect } from 'react'
import { Chart, BarElement, CategoryScale, LinearScale, Tooltip, BarController } from 'chart.js'

// v20: Hybrid-palette AUM bar chart. Hardcoded gradient palette overrides
// the legacy SLEEVE_COLOURS import so the chart always matches the
// hybrid brand. Deletion candidate once all portfolio colors are
// centralised in v20c.
const HYBRID_PALETTE = [
  '#b08b3e', // gold (primary brand)
  '#0a1f3a', // navy
  '#2d6e4e', // green
  '#c9a556', // gold-bright
  '#a67c2a', // warn gold
  '#5c6573', // text-2 slate
]

Chart.register(BarElement, CategoryScale, LinearScale, Tooltip, BarController)

interface PortfolioBar {
  label: string
  name: string
  nav: number
  clientName: string
}

export default function AUMBarChart({ portfolios }: { portfolios: PortfolioBar[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const chartRef = useRef<Chart | null>(null)

  useEffect(() => {
    if (!canvasRef.current || !portfolios.length) return
    if (chartRef.current) chartRef.current.destroy()

    const sorted = [...portfolios].sort((a, b) => b.nav - a.nav).slice(0, 12)

    chartRef.current = new Chart(canvasRef.current, {
      type: 'bar',
      data: {
        labels: sorted.map(p => `${p.clientName.split(' ')[0]} ${p.label}`),
        datasets: [{
          data: sorted.map(p => Math.round(p.nav / 1e6 * 100) / 100),
          backgroundColor: sorted.map((_, i) => HYBRID_PALETTE[i % HYBRID_PALETTE.length] + 'cc'),
          borderColor: sorted.map((_, i) => HYBRID_PALETTE[i % HYBRID_PALETTE.length]),
          borderWidth: 1,
          borderRadius: 3,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#fffbf2',
            borderColor: 'rgba(15, 41, 71, 0.12)',
            borderWidth: 1,
            titleColor: '#0f2947',
            bodyColor: '#5c6573',
            titleFont: { family: 'DM Sans, system-ui, sans-serif', size: 12, weight: 600 },
            bodyFont:  { family: 'DM Sans, system-ui, sans-serif', size: 11 },
            padding: 10,
            callbacks: {
              title: items => sorted[items[0].dataIndex]?.name ?? '',
              label: ctx => ` NAV: ₦${(ctx.parsed.y ?? 0).toFixed(2)}M`,
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            ticks: {
              color: '#5c6573',
              font: { size: 10, family: 'DM Sans, system-ui, sans-serif' },
            },
            border: { color: 'rgba(15, 41, 71, 0.12)' },
          },
          y: {
            grid: { color: 'rgba(15, 41, 71, 0.06)' },
            ticks: {
              color: '#8a8f9a',
              font: { size: 10, family: 'DM Sans, system-ui, sans-serif' },
              callback: v => `₦${v}M`,
            },
            border: { display: false },
          },
        },
      },
    })

    return () => { chartRef.current?.destroy() }
  }, [portfolios])

  if (!portfolios.length) return null

  return (
    <div style={{ position: 'relative', height: 200 }}>
      <canvas ref={canvasRef} />
    </div>
  )
}
