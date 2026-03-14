import Sidebar from '@/components/shared/Sidebar'

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex-1 overflow-auto">
        {children}
      </div>
    </div>
  )
}
