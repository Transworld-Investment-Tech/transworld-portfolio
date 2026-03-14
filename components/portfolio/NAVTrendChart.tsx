'use client'
import { useRef, useEffect } from 'react'
import { Chart, LineElement, PointElement, CategoryScale, LinearScale, Tooltip, Filler, LineController } from 'chart.js'
import { fmt } from '@/lib/portfolio'

Chart.register(LineElement, PointElement, CategoryScale, LinearScale, Tooltip, Filler, LineController)

interface NAVPoint { nav_date: string; nav_value: number }

export default function NAVTrendChart({ data, startingNAV }: { data: NAVPoint[]; startingNAV: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const chartRef  = useRef<Chart | null>(null)

  useEffect(() => {
    if (!canvasRef.current || !data.length) return
    if (chartRef.current) chartRef.current.destroy()

    const sorted = [...data].sort((a, b) => a.nav_date.localeCompare(b.nav_date))
    const labels = sorted.map(d => new Date(d.nav_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }))
    const values = sorted.map(d => Math.round(d.nav_value / 1e4) / 100)
    const isPositive = (values[values.length - 1] ?? startingNAV / 1e6) >= startingNAV / 1e6

    chartRef.current = new Chart(canvasRef.current, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data: values,
          borderColor: isPositive ? '#00d4a4' : '#ff5c7a',
          borderWidth: 2,
          backgroundColor: isPositive ? 'rgba(0,212,164,0.08)' : 'rgba(255,92,122,0.08)',
          fill: true,
          tension: 0.35,
          pointRadius: 0,
          pointHoverRadius: 4,
          pointHoverBackgroundColor: isPositive ? '#00d4a4' : '#ff5c7a',
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
            callbacks: { label: ctx => ` NAV ₦${ctx.parsed.y.toFixed(2)}M` }
          }
        },
        scales: {
          x: { grid: { display: false }, ticks: { color: '#555d72', font: { size: 10 }, maxTicksLimit: 8 } },
          y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#555d72', font: { size: 10 }, callback: v => `₦${v}M` } }
        }
      }
    })

    return () => { chartRef.current?.destroy() }
  }, [data, startingNAV])

  if (!data.length) {
    return (
      <div className="flex items-center justify-center h-32 text-[#555d72] text-xs">
        No NAV history yet. Log NAV entries to see the trend.
      </div>
    )
  }

  return <div style={{ position: 'relative', height: 160 }}><canvas ref={canvasRef} /></div>
}
