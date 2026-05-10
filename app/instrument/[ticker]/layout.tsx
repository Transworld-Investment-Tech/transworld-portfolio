// ═══════════════════════════════════════════════════════════════
// app/instrument/[ticker]/layout.tsx (v27az)
// ═══════════════════════════════════════════════════════════════
//
// Mirrors app/portfolio/[id]/layout.tsx pattern: server component
// that mounts the Sidebar. Sidebar.tsx is itself a client component
// that self-fetches its own data (latest price date, etc.), so we
// just render it without props. The instrument route is not tied
// to a single portfolio, so portfolio-scoped sidebar props are
// intentionally absent.
// ═══════════════════════════════════════════════════════════════

import Sidebar from '@/components/shared/Sidebar'

export default function InstrumentLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <Sidebar />
      <div style={{ flex: 1, overflow: 'auto' }}>
        {children}
      </div>
    </div>
  )
}
