import { supabaseAdmin } from '@/lib/supabase'
import Sidebar from '@/components/shared/Sidebar'

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
    .select('id, label, name, client:clients(name, code)')
    .eq('id', id)
    .single()

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        portfolioId={id}
        portfolioName={portfolio?.name}
        portfolioLabel={portfolio?.label}
        clientName={(portfolio?.client as any)?.name}
      />
      <div className="flex-1 overflow-auto">
        {children}
      </div>
    </div>
  )
}
