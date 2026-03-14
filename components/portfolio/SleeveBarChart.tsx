'use client'
import { fmt, SLEEVE_COLOURS } from '@/lib/portfolio'
import clsx from 'clsx'

interface Sleeve {
  sleeve_id: string
  name: string
  val: number
  act: number
  target_pct: number
  min_pct: number
  max_pct: number
  status: 'OK' | 'BREACH' | 'OVER'
}

export default function SleeveBarChart({ sleeves }: { sleeves: Sleeve[] }) {
  const maxPct = 0.65 // scale bars to this max

  return (
    <div className="space-y-4">
      {sleeves.map(s => {
        const col = SLEEVE_COLOURS[s.sleeve_id]
        const fillW = Math.min((s.act / maxPct) * 100, 100)
        const tgtW  = (s.target_pct / maxPct) * 100
        const minW  = (s.min_pct / maxPct) * 100
        const maxW  = (s.max_pct / maxPct) * 100
        const isBreached = s.status !== 'OK'

        return (
          <div key={s.sleeve_id}>
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-sm" style={{ background: col?.hex }} />
                <span className="text-xs text-[#8a91a8]">{s.name}</span>
              </div>
              <div className="flex items-center gap-2">
                <span className={clsx('text-xs font-mono font-medium', {
                  'text-[#00d4a4]': s.status === 'OK',
                  'text-[#ff5c7a]': s.status === 'BREACH',
                  'text-[#f5a623]': s.status === 'OVER',
                })}>
                  {fmt.pct(s.act)}
                </span>
                <span className={`badge badge-${s.status.toLowerCase()} text-[9px]`}>{s.status}</span>
              </div>
            </div>

            {/* Bar track */}
            <div className="relative h-2 bg-white/[0.05] rounded-full overflow-visible">
              {/* Allowed range shading */}
              <div className="absolute top-0 h-full rounded-full opacity-20"
                style={{ left: `${minW}%`, width: `${maxW - minW}%`, background: col?.hex }} />
              {/* Fill bar */}
              <div className="absolute top-0 left-0 h-full rounded-full transition-all duration-500"
                style={{ width: `${fillW}%`, background: isBreached ? (s.status === 'BREACH' ? '#ff5c7a' : '#f5a623') : col?.hex }} />
              {/* Target marker */}
              <div className="absolute top-[-3px] w-0.5 h-[14px] rounded-full bg-white/40"
                style={{ left: `${tgtW}%`, transform: 'translateX(-50%)' }} />
            </div>

            <div className="flex justify-between mt-1">
              <span className="text-[10px] text-[#555d72]">Range {fmt.pct(s.min_pct)}–{fmt.pct(s.max_pct)}</span>
              <span className="text-[10px] text-[#555d72]">Target {fmt.pct(s.target_pct)} · {fmt.ngnM(s.val)}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
