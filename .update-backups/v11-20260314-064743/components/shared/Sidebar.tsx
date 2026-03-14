'use client'
import { usePathname, useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'
import {
  LayoutDashboard, BarChart3, Users, FileText,
  Settings, LogOut, ChevronRight, TrendingUp,
  Activity, PlusCircle, ShieldCheck
} from 'lucide-react'
import clsx from 'clsx'

interface NavItem {
  href: string
  label: string
  icon: React.ReactNode
  exact?: boolean
  badge?: string
}

interface SidebarProps {
  portfolioName?: string
  portfolioLabel?: string
  clientName?: string
  portfolioId?: string
}

export default function Sidebar({ portfolioName, portfolioLabel, clientName, portfolioId }: SidebarProps) {
  const pathname = usePathname()
  const router = useRouter()

  const isActive = (href: string, exact = false) =>
    exact ? pathname === href : pathname.startsWith(href)

  async function handleLogout() {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const mainNav: NavItem[] = [
    { href: '/', label: 'All portfolios', icon: <LayoutDashboard size={15} />, exact: true },
    { href: '/admin', label: 'Admin panel', icon: <ShieldCheck size={15} /> },
  ]

  const portfolioNav: NavItem[] = portfolioId ? [
    { href: `/portfolio/${portfolioId}`, label: 'Overview', icon: <BarChart3 size={15} />, exact: true },
    { href: `/portfolio/${portfolioId}/holdings`, label: 'Holdings', icon: <Activity size={15} /> },
    { href: `/portfolio/${portfolioId}/transactions`, label: 'Transactions', icon: <TrendingUp size={15} /> },
    { href: `/portfolio/${portfolioId}/reports`, label: 'AI Reports', icon: <FileText size={15} /> },
    { href: `/portfolio/${portfolioId}/settings`, label: 'Portfolio settings', icon: <Settings size={15} /> },
  ] : []

  return (
    <aside className="w-56 bg-[#13161d] border-r border-white/[0.07] flex flex-col flex-shrink-0 h-screen sticky top-0">
      {/* Logo */}
      <div className="px-5 py-5 border-b border-white/[0.07]">
        <Link href="/" className="flex items-center gap-2.5">
          <div className="w-7 h-7 rounded-lg bg-[#a78bfa]/10 border border-[#a78bfa]/20 flex items-center justify-center flex-shrink-0">
            <svg width="14" height="14" viewBox="0 0 28 28" fill="none">
              <path d="M4 22 L14 6 L24 22" stroke="#a78bfa" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"/>
              <circle cx="14" cy="6" r="2" fill="#a78bfa"/>
            </svg>
          </div>
          <div>
            <div className="text-[9px] font-bold tracking-[0.12em] text-[#a78bfa] uppercase leading-none mb-0.5">Transworld AM</div>
            <div className="text-xs font-semibold text-[#e8eaf0] leading-none">Portfolio Intel</div>
          </div>
        </Link>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4">
        {/* Main nav */}
        <div className="mb-4">
          {mainNav.map(item => (
            <Link key={item.href} href={item.href}>
              <div className={clsx('sb-item', { 'active': isActive(item.href, item.exact) })}>
                {item.icon}
                <span>{item.label}</span>
                {item.badge && <span className="ml-auto badge badge-ntb text-[9px]">{item.badge}</span>}
              </div>
            </Link>
          ))}
        </div>

        {/* Portfolio-specific nav */}
        {portfolioId && (
          <>
            <div className="px-2 mb-2">
              <div className="text-[9px] font-bold tracking-widest text-[#555d72] uppercase mb-1">Current portfolio</div>
              <div className="text-[11px] text-[#8a91a8] truncate">{clientName}</div>
              <div className="flex items-center gap-1.5 mt-0.5">
                <span className="w-4 h-4 rounded bg-[#a78bfa]/10 border border-[#a78bfa]/20 text-[#a78bfa] text-[9px] font-bold flex items-center justify-center flex-shrink-0">{portfolioLabel}</span>
                <span className="text-xs font-medium text-[#e8eaf0] truncate">{portfolioName}</span>
              </div>
            </div>
            <div className="h-px bg-white/[0.06] mb-3" />
            {portfolioNav.map(item => (
              <Link key={item.href} href={item.href}>
                <div className={clsx('sb-item', { 'active': isActive(item.href, item.exact) })}>
                  {item.icon}
                  <span>{item.label}</span>
                </div>
              </Link>
            ))}
          </>
        )}
      </nav>

      {/* Footer */}
      <div className="px-3 py-3 border-t border-white/[0.07]">
        <button onClick={handleLogout}
          className="sb-item w-full text-left text-[#555d72] hover:text-[#ff5c7a]">
          <LogOut size={14} />
          <span>Sign out</span>
        </button>
      </div>
    </aside>
  )
}
