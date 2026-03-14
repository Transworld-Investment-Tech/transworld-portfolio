'use client'
import { useRef, useEffect } from 'react'
import { Chart, BarElement, CategoryScale, LinearScale, Tooltip, BarController } from 'chart.js'
import { SLEEVE_COLOURS } from '@/lib/portfolio'

Chart.register(BarElement, CategoryScale, LinearScale, Tooltip, BarController)

interface PortfolioBar {
  label: string
  name: string
  nav: number
  clientName: string
}

export default function AUMBarChart({ portfolios }: { portfolios: PortfolioBar[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const chartRef  = useRef<Chart | null>(null)

  useEffect(() => {
    if (!canvasRef.current || !portfolios.length) return
    if (chartRef.current) chartRef.current.destroy()

    const sorted = [...portfolios].sort((a, b) => b.nav - a.nav).slice(0, 12)
    const colors = Object.values(SLEEVE_COLOURS).map(c => c.hex)

    chartRef.current = new Chart(canvasRef.current, {
      type: 'bar',
      data: {
        labels: sorted.map(p => `${p.clientName.split(' ')[0]} ${p.label}`),
        datasets: [{
          data: sorted.map(p => Math.round(p.nav / 1e6 * 100) / 100),
          backgroundColor: sorted.map((_, i) => colors[i % colors.length] + 'cc'),
          borderColor: sorted.map((_, i) => colors[i % colors.length]),
          borderWidth: 1,
          borderRadius: 4,
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#1a1e28',
            borderColor: 'rgba(255,255,255,0.1)',
            borderWidth: 1,
            titleColor: '#e8eaf0',
            bodyColor: '#8a91a8',
            callbacks: {
              title: (items) => sorted[items[0].dataIndex]?.name,
              label: (ctx) => ` NAV: ₦${ctx.parsed.y.toFixed(2)}M`,
            }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#555d72', font: { size: 10 } } },
          y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#555d72', font: { size: 10 }, callback: v => `₦${v}M` } }
        }
      }
    })

    return () => { chartRef.current?.destroy() }
  }, [portfolios])

  if (!portfolios.length) return null

  return <div style={{ position: 'relative', height: 180 }}><canvas ref={canvasRef} /></div>
}
