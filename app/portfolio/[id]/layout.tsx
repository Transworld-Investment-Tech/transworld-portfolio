import { supabaseAdmin } from '@/lib/supabase'
import Sidebar from '@/components/shared/Sidebar'

// v20c: added `type` to the client select and forwarded it as clientType so
// the Sidebar's "Current mandate" eyebrow reflects the real client type
// (discretionary / advisory / internal) instead of always falling back to
// "Discretionary".
export default async function PortfolioLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ id: string }>
}) {
  const { id } = await params
  const db = supabaseAdmin()
  const { data: portfolio } = await db
    .from('portfolios')
    .select('id, label, name, client:clients(name, code, type)')
    .eq('id', id)
    .single()

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        portfolioId={id}
        portfolioName={portfolio?.name}
        portfolioLabel={portfolio?.label}
        clientName={(portfolio?.client as any)?.name}
        clientType={(portfolio?.client as any)?.type}
      />
      <div className="flex-1 overflow-auto">
        {children}
      </div>
    </div>
  )
}
