'use client'
import { useRef, useEffect } from 'react'
import { Chart, BarElement, CategoryScale, LinearScale, Tooltip, Legend, BarController } from 'chart.js'
import type { Holding } from '@/lib/portfolio'

Chart.register(BarElement, CategoryScale, LinearScale, Tooltip, Legend, BarController)

export default function IncomeChart({ holdings }: { holdings: Holding[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const chartRef  = useRef<Chart | null>(null)

  useEffect(() => {
    if (!canvasRef.current) return
    if (chartRef.current) chartRef.current.destroy()

    const months = Array.from({ length: 12 }, (_, i) => {
      const d = new Date(); d.setMonth(d.getMonth() + i + 1)
      return d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' })
    })

    const ntbs   = holdings.filter(h => h.instrument?.type === 'NTB')
    const bonds  = holdings.filter(h => h.instrument?.type === 'Bond')
    const stocks = holdings.filter(h => h.instrument?.type === 'Stock')

    const monthlyNTB   = ntbs.reduce((s, h) => s + h.quantity * (h.latest_price ?? h.avg_cost) * (h.instrument?.coupon_pct ?? 0) / 100 / 12, 0)
    const monthlyBond  = bonds.reduce((s, h) => s + h.quantity * (h.latest_price ?? h.avg_cost) * (h.instrument?.coupon_pct ?? 0) / 100 / 12, 0)
    const monthlyDiv   = stocks.reduce((s, h) => {
      const ann = h.quantity * (h.latest_price ?? h.avg_cost) * (h.instrument?.coupon_pct ?? 0) / 100
      return s + ann / 4 / 3 // quarterly dividend approximation
    }, 0)

    chartRef.current = new Chart(canvasRef.current, {
      type: 'bar',
      data: {
        labels: months,
        datasets: [
          { label: 'NTB income',   data: months.map(() => Math.round(monthlyNTB / 1000)),  backgroundColor: 'rgba(167,139,250,0.75)', stack: 'a', borderRadius: 2 },
          { label: 'Bond income',  data: months.map(() => Math.round(monthlyBond / 1000)), backgroundColor: 'rgba(45,212,191,0.75)',  stack: 'a', borderRadius: 2 },
          { label: 'Dividends',    data: months.map(() => Math.round(monthlyDiv / 1000)),  backgroundColor: 'rgba(96,165,250,0.75)',  stack: 'a', borderRadius: 2 },
        ]
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
            callbacks: { label: ctx => ` ${ctx.dataset.label}: ₦${(ctx.parsed.y ?? 0).toLocaleString()}K` }
          }
        },
        scales: {
          x: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#555d72', font: { size: 10 } }, stacked: true },
          y: { grid: { color: 'rgba(255,255,255,0.04)' }, ticks: { color: '#555d72', font: { size: 10 }, callback: v => `₦${v}K` }, stacked: true }
        }
      }
    })

    return () => { chartRef.current?.destroy() }
  }, [holdings])

  const ntbIncome  = holdings.filter(h => h.instrument?.type === 'NTB').reduce((s, h) => s + h.quantity * (h.latest_price ?? h.avg_cost) * (h.instrument?.coupon_pct ?? 0) / 100, 0)
  const bondIncome = holdings.filter(h => h.instrument?.type === 'Bond').reduce((s, h) => s + h.quantity * (h.latest_price ?? h.avg_cost) * (h.instrument?.coupon_pct ?? 0) / 100, 0)
  const divIncome  = holdings.filter(h => h.instrument?.type === 'Stock').reduce((s, h) => s + h.quantity * (h.latest_price ?? h.avg_cost) * (h.instrument?.coupon_pct ?? 0) / 100, 0)

  return (
    <div>
      {/* Legend + summary */}
      <div className="flex flex-wrap gap-4 mb-4">
        {[
          { label: 'NTB income', color: 'rgba(167,139,250,0.75)', val: ntbIncome },
          { label: 'Bond income', color: 'rgba(45,212,191,0.75)', val: bondIncome },
          { label: 'Dividends', color: 'rgba(96,165,250,0.75)', val: divIncome },
        ].map(item => (
          <div key={item.label} className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ background: item.color }} />
            <span className="text-[11px] text-[#8a91a8]">{item.label}</span>
            <span className="text-[11px] font-mono text-[#555d72]">
              ₦{(item.val / 1e6).toFixed(2)}M p.a.
            </span>
          </div>
        ))}
        <div className="ml-auto text-[11px] font-mono text-[#a78bfa]">
          Total: ₦{((ntbIncome + bondIncome + divIncome) / 1e6).toFixed(2)}M p.a.
        </div>
      </div>
      <div style={{ position: 'relative', height: 200 }}>
        <canvas ref={canvasRef} />
      </div>
    </div>
  )
}
