import { Suspense } from 'react'
import NewPortfolioPageInner from './inner'

export default function NewPortfolioPageInner() {
  return (
    <Suspense fallback={<div className="flex items-center justify-center h-64 text-[#555d72] text-xs">Loading…</div>}>
      <NewPortfolioPageInner />
    </Suspense>
  )
}
