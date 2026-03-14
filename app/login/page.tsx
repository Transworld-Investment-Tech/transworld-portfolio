import { Suspense } from 'react'
import LoginPageInner from './inner'

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="min-h-screen bg-[#0d0f14] flex items-center justify-center text-[#555d72] text-sm">Loading…</div>}>
      <LoginPageInner />
    </Suspense>
  )
}
