import { supabaseAdmin } from '@/lib/supabase'
import Sidebar from '@/components/shared/Sidebar'

// v21k: Consolidated client view layout.
// Renders Sidebar with clientName/clientType but NO portfolioId —
// sidebar shows main nav only, no "Current mandate" section.
// Follows same async-params pattern as app/portfolio/[id]/layout.tsx.
export default async function ClientLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ clientId: string }>
}) {
  const { clientId } = await params
  const db = supabaseAdmin()
  const { data: client } = await db
    .from('clients')
    .select('id, name, code, type')
    .eq('id', clientId)
    .single()

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar
        clientName={client?.name}
        clientType={client?.type}
      />
      <div className="flex-1 overflow-auto">
        {children}
      </div>
    </div>
  )
}
