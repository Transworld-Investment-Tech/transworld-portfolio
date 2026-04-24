'use client'
import { useEffect, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import Link from 'next/link'
import { supabase } from '@/lib/supabase'

// v20: Hybrid sidebar — navy #0a1f3a × muted gold text × Cormorant logo mark.
// v21b-3b: Added "Broker files" entry to the admin section (/admin/broker).
//
// Footer shows a live staleness dot based on the most recent market_prices
// row. "Fresh" if any price within 3 days, "Stale" otherwise.

interface SidebarProps {
  portfolioName?: string
  portfolioLabel?: string
  clientName?: string
  clientType?: string
  portfolioId?: string
}

export default function Sidebar({
  portfolioName,
  portfolioLabel,
  clientName,
  clientType,
  portfolioId,
}: SidebarProps) {
  const pathname = usePathname()
  const router = useRouter()
  const [latestPriceDate, setLatestPriceDate] = useState<string | null>(null)

  const isActive = (href: string, exact = false) =>
    exact ? pathname === href : pathname.startsWith(href)

  // Freshness footer — query the newest market_prices.price_date and compare
  useEffect(() => {
    supabase
      .from('market_prices')
      .select('price_date')
      .order('price_date', { ascending: false })
      .limit(1)
      .maybeSingle()
      .then(({ data }) => {
        if (data?.price_date) setLatestPriceDate(data.price_date)
      })
  }, [])

  function stalenessInfo() {
    if (!latestPriceDate) return { cls: 'none', text: 'No prices yet' }
    const d = new Date(latestPriceDate + 'T00:00:00Z')
    const today = new Date()
    today.setUTCHours(0, 0, 0, 0)
    const days = Math.floor((today.getTime() - d.getTime()) / 86_400_000)
    const fmt = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })
    if (days <= 3) return { cls: 'fresh', text: `All prices fresh · ${fmt}` }
    return { cls: 'stale', text: `Prices ${days}d old · ${fmt}` }
  }

  async function handleLogout() {
    await supabase.auth.signOut()
    router.push('/login')
  }

  const mainNav = [
    { href: '/', label: 'All portfolios', icon: '▦', exact: true },
    { href: '/admin', label: 'Admin panel', icon: '◉', exact: true },
    { href: '/admin/prices', label: 'Market prices', icon: '⟡' },
    { href: '/admin/broker', label: 'Broker files', icon: '▣' },
    { href: '/watchlist',      label: 'NGX Watchlist',   icon: '❈' },
  { href: '/admin/aliases',        label: 'Ticker aliases',  icon: '⇄' },
  { href: '/admin/import-prices', label: 'Import prices',  icon: '⇪' },
  ]

  const portfolioNav = portfolioId ? [
    { href: `/portfolio/${portfolioId}`, label: 'Overview', icon: '◈', exact: true },
    { href: `/portfolio/${portfolioId}/holdings`, label: 'Holdings', icon: '▤' },
    { href: `/portfolio/${portfolioId}/transactions`, label: 'Transactions', icon: '⇅' },
    { href: `/portfolio/${portfolioId}/reports`, label: 'AI Reports', icon: '✦' },
    { href: `/portfolio/${portfolioId}/settings`, label: 'Portfolio settings', icon: '⚙' },
  ] : []

  const stale = stalenessInfo()
  const displayType = (clientType || 'Discretionary').charAt(0).toUpperCase() + (clientType || 'discretionary').slice(1)

  return (
    <aside
      style={{
        width: 232,
        flexShrink: 0,
        background: 'var(--sidebar-bg)',
        color: 'var(--sidebar-text)',
        display: 'flex',
        flexDirection: 'column',
        position: 'sticky',
        top: 0,
        height: '100vh',
        fontFamily: 'var(--font-sans)',
      }}
    >
      {/* Logo */}
      <Link href="/" style={{ textDecoration: 'none', color: 'inherit' }}>
        <div
          style={{
            padding: '24px 20px 22px',
            borderBottom: '1px solid rgba(232, 217, 181, 0.1)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 4,
              border: '1px solid var(--gold)',
              color: 'var(--gold-bright)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontFamily: 'var(--font-serif)',
              fontSize: 22,
              fontWeight: 400,
              letterSpacing: '-0.02em',
              flexShrink: 0,
            }}
          >
            T
          </div>
          <div>
            <div
              style={{
                fontSize: 9,
                letterSpacing: '0.22em',
                fontWeight: 600,
                color: 'var(--gold)',
                textTransform: 'uppercase',
                marginBottom: 3,
              }}
            >
              Transworld I&S
            </div>
            <div
              style={{
                fontFamily: 'var(--font-serif)',
                fontSize: 16,
                fontWeight: 500,
                color: 'var(--sidebar-text)',
                letterSpacing: '0.01em',
              }}
            >
              Portfolio Intel
            </div>
          </div>
        </div>
      </Link>

      {/* Main nav */}
      <ul style={{ listStyle: 'none', padding: '12px 12px 4px', margin: 0 }}>
        {mainNav.map(item => (
          <li key={item.href} style={{ margin: 0 }}>
            <Link href={item.href} style={{ textDecoration: 'none', color: 'inherit' }}>
              <NavItem
                icon={item.icon}
                label={item.label}
                active={isActive(item.href, item.exact)}
              />
            </Link>
          </li>
        ))}
      </ul>

      {/* Current portfolio section */}
      {portfolioId && (
        <>
          <div
            style={{
              padding: '18px 20px 8px',
              fontSize: 9,
              letterSpacing: '0.2em',
              fontWeight: 600,
              color: 'var(--sidebar-text-3)',
              textTransform: 'uppercase',
            }}
          >
            Current mandate
          </div>

          <div
            style={{
              margin: '4px 16px 8px',
              padding: '14px',
              background: 'rgba(232, 217, 181, 0.04)',
              border: '1px solid rgba(232, 217, 181, 0.08)',
              borderRadius: 6,
            }}
          >
            <div
              style={{
                fontSize: 9,
                letterSpacing: '0.18em',
                color: 'var(--gold)',
                fontWeight: 600,
                textTransform: 'uppercase',
                marginBottom: 4,
              }}
            >
              {displayType}
            </div>
            {clientName && (
              <div style={{ fontSize: 11, color: 'var(--sidebar-text-2)', marginBottom: 4 }}>
                {clientName}
              </div>
            )}
            <div
              style={{
                fontFamily: 'var(--font-serif)',
                fontSize: 16,
                fontWeight: 500,
                color: 'var(--sidebar-text)',
                lineHeight: 1.2,
              }}
            >
              {portfolioName || `Portfolio ${portfolioLabel || ''}`}
            </div>
          </div>

          <ul style={{ listStyle: 'none', padding: '4px 12px', margin: 0 }}>
            {portfolioNav.map(item => (
              <li key={item.href} style={{ margin: 0 }}>
                <Link href={item.href} style={{ textDecoration: 'none', color: 'inherit' }}>
                  <NavItem
                    icon={item.icon}
                    label={item.label}
                    active={isActive(item.href, item.exact)}
                  />
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}

      {/* Footer — freshness + sign out */}
      <div
        style={{
          marginTop: 'auto',
          padding: '14px 20px',
          borderTop: '1px solid rgba(232, 217, 181, 0.1)',
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
        }}
      >
        <div
          style={{
            fontSize: 11,
            color: 'var(--sidebar-text-3)',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span className={`staleness-dot ${stale.cls}`} />
          <span>{stale.text}</span>
        </div>
        <button
          onClick={handleLogout}
          style={{
            background: 'transparent',
            border: 'none',
            textAlign: 'left',
            padding: 0,
            fontSize: 11,
            color: 'var(--sidebar-text-3)',
            cursor: 'pointer',
            fontFamily: 'inherit',
            display: 'flex',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <span>↪</span>
          <span>Sign out</span>
        </button>
      </div>
    </aside>
  )
}

function NavItem({
  icon,
  label,
  active,
}: {
  icon: string
  label: string
  active: boolean
}) {
  return (
    <div
      style={{
        padding: '9px 12px 9px 14px',
        marginLeft: -4,
        marginBottom: 1,
        fontSize: 13,
        color: active ? 'var(--gold-bright)' : 'var(--sidebar-text-2)',
        background: active ? 'rgba(176, 139, 62, 0.08)' : 'transparent',
        borderRadius: 4,
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        borderLeft: active ? '2px solid var(--gold)' : '2px solid transparent',
        fontWeight: active ? 500 : 400,
        transition: 'color 0.15s, background 0.15s',
      }}
      onMouseEnter={e => {
        if (!active) {
          e.currentTarget.style.color = 'var(--sidebar-text)'
          e.currentTarget.style.background = 'rgba(232, 217, 181, 0.04)'
        }
      }}
      onMouseLeave={e => {
        if (!active) {
          e.currentTarget.style.color = 'var(--sidebar-text-2)'
          e.currentTarget.style.background = 'transparent'
        }
      }}
    >
      <span
        style={{
          width: 14,
          height: 14,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          opacity: active ? 1 : 0.7,
        }}
      >
        {icon}
      </span>
      <span>{label}</span>
    </div>
  )
}
