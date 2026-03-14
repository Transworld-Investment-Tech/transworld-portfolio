'use client'
import { useRef, useEffect } from 'react'
import { Chart, ArcElement, Tooltip, DoughnutController } from 'chart.js'
import { fmt, SLEEVE_COLOURS } from '@/lib/portfolio'

Chart.register(ArcElement, Tooltip, DoughnutController)

interface Sleeve {
  sleeve_id: string
  name: string
  val: number
  act: number
  target_pct: number
  status: string
}

export default function AllocationDonut({ sleeves, totalNAV }: { sleeves: Sleeve[]; totalNAV: number }) {
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
          backgroundColor: sleeves.map(s => SLEEVE_COLOURS[s.sleeve_id]?.hex || '#555d72'),
          borderWidth: 2,
          borderColor: '#13161d',
          hoverBorderColor: '#1a1e28',
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '68%',
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#1a1e28',
            borderColor: 'rgba(255,255,255,0.1)',
            borderWidth: 1,
            titleColor: '#e8eaf0',
            bodyColor: '#8a91a8',
            padding: 10,
            callbacks: {
              label: (ctx) => {
                const sl = sleeves[ctx.dataIndex]
                return ` ${fmt.ngnM(sl.val)} · ${fmt.pct(sl.act)}`
              }
            }
          }
        },
        animation: { animateRotate: true, duration: 600 }
      }
    })

    return () => { chartRef.current?.destroy() }
  }, [sleeves, totalNAV])

  return (
    <div>
      <div className="relative" style={{ height: 200 }}>
        <canvas ref={canvasRef} />
        <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
          <div className="text-[10px] text-[#555d72] mb-0.5">Total NAV</div>
          <div className="text-lg font-semibold font-mono">{fmt.ngnM(totalNAV)}</div>
        </div>
      </div>
      {/* Legend */}
      <div className="flex flex-wrap gap-x-4 gap-y-2 mt-4">
        {sleeves.map(s => {
          const col = SLEEVE_COLOURS[s.sleeve_id]
          return (
            <div key={s.sleeve_id} className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-sm flex-shrink-0" style={{ background: col?.hex }} />
              <span className="text-[11px] text-[#8a91a8]">{s.name}</span>
              <span className="text-[11px] font-mono text-[#555d72]">{fmt.pct(s.act)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
