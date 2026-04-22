'use client'
import { useEffect, useState, useCallback } from 'react'
import Link from 'next/link'
import dynamic from 'next/dynamic'
import { supabase } from '@/lib/supabase'
import { fmt } from '@/lib/portfolio'
import Sidebar from '@/components/shared/Sidebar'
import {
  Users, BarChart3, TrendingUp, Plus, RefreshCw,
  ChevronRight, Trash2, AlertTriangle, X,
} from 'lucide-react'

// v20: Hybrid All Portfolios dashboard. Cream canvas, cream cards with
// gold brand bars, Cormorant display type. Portfolio cards carry v19d's
// zero-starting-nav safety (show "Awaiting transactions" / "built from
// transactions" when starting_nav = 0).

const AUMBarChart = dynamic(() => import('@/components/portfolio/AUMBarChart'), { ssr: false })

interface PortfolioWithNAV {
  id: string
  label: string
  name: string
  starting_nav: number
  current_nav: number
  currency: string
  status: string
  valuation_date: string
  clientName: string
  clientCode: string
  nav: number
}

export default function HomePage() {
  const [clients, setClients] = useState<any[]>([])
  const [navMap, setNavMap] = useState<Record<string, number>>({})
  const [loading, setLoading] = useState(true)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [confirmDel, setConfirmDel] = useState<{ id: string; name: string } | null>(null)
  const [confirmArchiveClient, setConfirmArchiveClient] = useState<{ id: string; name: string } | null>(null)
  const [archivingClient, setArchivingClient] = useState<string | null>(null)
  const [stats, setStats] = useState({ totalPortfolios: 0, totalNAV: 0, activeClients: 0 })

  const loadClients = useCallback(async () => {
    setLoading(true)
    const { data } = await supabase
      .from('clients')
      .select('*, portfolios(id, label, name, starting_nav, currency, status, valuation_date)')
      .eq('status', 'active')
      .order('name', { ascending: true })

    if (!data) { setLoading(false); return }

    const allPortfolioIds = data.flatMap((c: any) => (c.portfolios || []).map((p: any) => p.id))

    const [holdingsRes, pricesRes] = await Promise.all([
      supabase.from('holdings').select('portfolio_id, instrument_id, quantity').in('portfolio_id', allPortfolioIds),
      supabase.from('market_prices').select('instrument_id, price').order('price_date', { ascending: false }),
    ])

    const priceMap: Record<string, number> = {}
    for (const p of pricesRes.data ?? []) {
      if (!priceMap[p.instrument_id]) priceMap[p.instrument_id] = p.price
    }

    const navByPortfolio: Record<string, number> = {}
    for (const h of holdingsRes.data ?? []) {
      const price = priceMap[h.instrument_id] ?? 0
      navByPortfolio[h.portfolio_id] = (navByPortfolio[h.portfolio_id] ?? 0) + h.quantity * price
    }
    setNavMap(navByPortfolio)
    setClients(data)

    const totalNAV = Object.values(navByPortfolio).reduce((s, v) => s + v, 0)
    setStats({
      totalPortfolios: data.reduce((s: number, c: any) => s + (c.portfolios?.length || 0), 0),
      totalNAV: totalNAV || data.reduce((s: number, c: any) =>
        s + (c.portfolios || []).reduce((ps: number, p: any) => ps + p.starting_nav, 0), 0),
      activeClients: data.length,
    })
    setLoading(false)
  }, [])

  useEffect(() => { loadClients() }, [])

  async function archiveClient(id: string) {
    setArchivingClient(id)
    await fetch(`/api/clients/${id}`, { method: 'DELETE' })
    setConfirmArchiveClient(null)
    setArchivingClient(null)
    loadClients()
  }

  async function deletePortfolio(id: string) {
    setDeleting(id)
    await fetch(`/api/portfolios/${id}`, { method: 'DELETE' })
    setConfirmDel(null)
    setDeleting(null)
    loadClients()
  }

  const allPortfolios: PortfolioWithNAV[] = clients.flatMap((c: any) =>
    (c.portfolios || []).map((p: any) => ({
      ...p,
      clientName: c.name,
      clientCode: c.code,
      current_nav: navMap[p.id] ?? 0,
      nav: navMap[p.id] ?? p.starting_nav,
    }))
  )

  const totalCurrentNAV = allPortfolios.reduce((s, p) => s + (p.current_nav || 0), 0)

  return (
    <div className="hybrid-page flex">
      <Sidebar />

      <div style={{ flex: 1, overflow: 'auto' }}>
        {/* Delete portfolio modal */}
        {confirmDel && (
          <ConfirmModal
            tone="breach"
            title="Archive portfolio?"
            subtitle="This will hide it from all views"
            target={confirmDel.name}
            body="The portfolio will be archived — holdings, transactions and reports are preserved but it won't appear in the dashboard. This can be reversed in Supabase if needed."
            confirmLabel="Archive portfolio"
            onConfirm={() => deletePortfolio(confirmDel.id)}
            onCancel={() => setConfirmDel(null)}
            busy={deleting === confirmDel.id}
          />
        )}
        {confirmArchiveClient && (
          <ConfirmModal
            tone="warn"
            title="Archive client?"
            subtitle="Client and all portfolios will be hidden"
            target={confirmArchiveClient.name}
            body="This archives the client and all their portfolios. All data (holdings, transactions, reports) is preserved and can be restored in Supabase."
            confirmLabel="Archive client"
            onConfirm={() => archiveClient(confirmArchiveClient.id)}
            onCancel={() => setConfirmArchiveClient(null)}
            busy={archivingClient === confirmArchiveClient.id}
          />
        )}

        <main style={{ padding: '32px 44px 64px', maxWidth: '100%' }}>
          {/* Page header */}
          <div className="page-head">
            <div>
              <div className="eyebrow" style={{ marginBottom: 10 }}>Transworld Asset Management</div>
              <h1
                className="hybrid-serif"
                style={{
                  fontSize: 36,
                  fontWeight: 500,
                  letterSpacing: '-0.005em',
                  lineHeight: 1,
                  color: 'var(--text)',
                }}
              >
                All portfolios
              </h1>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn-h" onClick={loadClients} disabled={loading}>
                <RefreshCw size={12} className={loading ? 'animate-spin' : ''} /> Refresh
              </button>
              <Link href="/admin/portfolios/new" className="btn-h btn-h-primary" style={{ textDecoration: 'none' }}>
                <Plus size={13} /> New portfolio
              </Link>
            </div>
          </div>

          {/* KPI strip */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14, marginBottom: 22 }}>
            <KpiTile
              icon={<Users size={16} style={{ color: 'var(--gold)' }} />}
              label="Active clients"
              value={loading ? '—' : String(stats.activeClients)}
              sub="discretionary mandates"
            />
            <KpiTile
              icon={<BarChart3 size={16} style={{ color: 'var(--gold)' }} />}
              label="Portfolios"
              value={loading ? '—' : `${stats.totalPortfolios} / 25`}
              sub="active portfolios"
            />
            <KpiTile
              icon={<TrendingUp size={16} style={{ color: 'var(--gold)' }} />}
              label={totalCurrentNAV > 0 ? 'Total AUM (current)' : 'Total AUM (starting)'}
              value={loading ? '—' : fmt.ngnB(totalCurrentNAV > 0 ? totalCurrentNAV : stats.totalNAV)}
              sub={totalCurrentNAV > 0 ? 'market value' : 'cost basis'}
            />
          </div>

          {/* Capacity bar */}
          <div className="panel" style={{ marginBottom: 22 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
              <span style={{ fontSize: 12, color: 'var(--text-2)' }}>Portfolio capacity</span>
              <span
                style={{
                  fontSize: 12,
                  fontFamily: 'var(--font-mono)',
                  color: 'var(--text-3)',
                }}
              >
                {stats.totalPortfolios} / 25
              </span>
            </div>
            <div
              style={{
                height: 6,
                background: 'rgba(15, 41, 71, 0.08)',
                borderRadius: 3,
                overflow: 'hidden',
              }}
            >
              <div
                style={{
                  height: '100%',
                  borderRadius: 3,
                  background: 'linear-gradient(90deg, var(--gold), var(--gold-bright))',
                  width: `${Math.min((stats.totalPortfolios / 25) * 100, 100)}%`,
                  transition: 'width 0.7s',
                }}
              />
            </div>
          </div>

          {/* AUM chart */}
          {allPortfolios.filter(p => p.nav > 0).length > 1 && (
            <div className="panel" style={{ marginBottom: 22 }}>
              <div className="panel-header">
                <div className="panel-title">
                  AUM by portfolio — {totalCurrentNAV > 0 ? 'current market value' : 'starting NAV'}
                </div>
                <div className="panel-meta">{allPortfolios.filter(p => p.nav > 0).length} active</div>
              </div>
              <AUMBarChart portfolios={allPortfolios.filter(p => p.nav > 0)} />
            </div>
          )}

          {/* Portfolio grid, grouped by client */}
          {loading ? (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '60px 0', color: 'var(--text-3)', fontSize: 12 }}>
              <RefreshCw size={14} className="animate-spin" style={{ marginRight: 8 }} />
              Loading portfolios…
            </div>
          ) : clients.length === 0 ? (
            <div
              className="panel"
              style={{
                textAlign: 'center',
                padding: '60px 0',
                borderStyle: 'dashed',
              }}
            >
              <Users size={32} style={{ color: 'var(--text-3)', margin: '0 auto 12px' }} />
              <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>No clients yet</div>
              <Link
                href="/admin/clients/new"
                className="btn-h btn-h-primary"
                style={{ marginTop: 12, textDecoration: 'none', display: 'inline-flex' }}
              >
                <Plus size={14} /> Add first client
              </Link>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 32 }}>
              {clients.map((client: any) => (
                <div key={client.id}>
                  {/* Client row */}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      marginBottom: 12,
                      paddingBottom: 10,
                      borderBottom: '1px solid var(--border-soft)',
                    }}
                  >
                    <div
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 4,
                        background: 'var(--gold-soft)',
                        border: '1px solid rgba(176, 139, 62, 0.2)',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        fontSize: 10,
                        fontWeight: 700,
                        color: 'var(--gold)',
                        fontFamily: 'var(--font-mono)',
                      }}
                    >
                      {client.code?.slice(0, 2).toUpperCase()}
                    </div>
                    <span style={{ fontSize: 14, fontWeight: 500 }}>{client.name}</span>
                    <span className="pill pill-hold">{client.type}</span>
                    <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
                      <Link
                        href={`/admin/clients/${client.id}`}
                        style={{
                          fontSize: 11,
                          color: 'var(--text-3)',
                          textDecoration: 'none',
                          display: 'flex',
                          alignItems: 'center',
                          gap: 4,
                          transition: 'color 0.15s',
                        }}
                      >
                        Manage <ChevronRight size={11} />
                      </Link>
                      <button
                        onClick={() => setConfirmArchiveClient({ id: client.id, name: client.name })}
                        className="btn-h"
                        style={{ fontSize: 11, padding: '3px 10px' }}
                        title="Archive client"
                      >
                        <Trash2 size={10} /> Archive
                      </button>
                    </div>
                  </div>

                  {/* Portfolio cards */}
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))',
                      gap: 12,
                    }}
                  >
                    {(client.portfolios || []).map((p: any) => {
                      const currentNAV = navMap[p.id] ?? 0
                      const hasCurrentNAV = currentNAV > 0
                      const hasStartingNav = p.starting_nav > 0
                      const gain = currentNAV - p.starting_nav
                      const gainPct = hasStartingNav ? gain / p.starting_nav : 0

                      return (
                        <div key={p.id} style={{ position: 'relative' }} className="group">
                          <Link
                            href={`/portfolio/${p.id}`}
                            style={{ textDecoration: 'none', color: 'inherit' }}
                          >
                            <div className="portfolio-card">
                              <div
                                style={{
                                  display: 'flex',
                                  justifyContent: 'space-between',
                                  alignItems: 'center',
                                  marginBottom: 10,
                                }}
                              >
                                <div
                                  style={{
                                    width: 30,
                                    height: 30,
                                    borderRadius: 4,
                                    background: 'var(--gold-soft)',
                                    border: '1px solid rgba(176, 139, 62, 0.25)',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'center',
                                    color: 'var(--gold)',
                                    fontWeight: 700,
                                    fontSize: 13,
                                    fontFamily: 'var(--font-serif)',
                                  }}
                                >
                                  {p.label}
                                </div>
                                <span
                                  className={p.status === 'active' ? 'pill pill-ok' : 'pill pill-hold'}
                                  style={{ fontSize: 8 }}
                                >
                                  {p.status}
                                </span>
                              </div>

                              <div
                                style={{
                                  fontSize: 13,
                                  fontWeight: 500,
                                  lineHeight: 1.3,
                                  marginBottom: 10,
                                  color: 'var(--text)',
                                  paddingRight: 20,
                                }}
                              >
                                {p.name}
                              </div>

                              {/* v19d display states preserved */}
                              {hasCurrentNAV && hasStartingNav ? (
                                <>
                                  <div
                                    className="hybrid-serif"
                                    style={{
                                      fontSize: 22,
                                      fontWeight: 500,
                                      color: 'var(--text)',
                                      letterSpacing: '-0.01em',
                                      lineHeight: 1,
                                    }}
                                  >
                                    {fmt.ngnM(currentNAV)}
                                  </div>
                                  <div
                                    style={{
                                      marginTop: 6,
                                      fontSize: 11,
                                      fontFamily: 'var(--font-mono)',
                                      color: gain >= 0 ? 'var(--pos)' : 'var(--neg)',
                                    }}
                                  >
                                    {gain >= 0 ? '+' : ''}{fmt.ngnM(gain)} ({gain >= 0 ? '+' : ''}{(gainPct * 100).toFixed(1)}%)
                                  </div>
                                  <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 3 }}>
                                    from {fmt.ngnM(p.starting_nav)} start
                                  </div>
                                </>
                              ) : hasCurrentNAV && !hasStartingNav ? (
                                <>
                                  <div
                                    className="hybrid-serif"
                                    style={{
                                      fontSize: 22,
                                      fontWeight: 500,
                                      color: 'var(--text)',
                                      letterSpacing: '-0.01em',
                                      lineHeight: 1,
                                    }}
                                  >
                                    {fmt.ngnM(currentNAV)}
                                  </div>
                                  <div
                                    style={{
                                      marginTop: 6,
                                      fontSize: 11,
                                      fontFamily: 'var(--font-mono)',
                                      color: 'var(--pos)',
                                    }}
                                  >
                                    +{fmt.ngnM(currentNAV)}
                                  </div>
                                  <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 3 }}>
                                    built from transactions
                                  </div>
                                </>
                              ) : !hasCurrentNAV && hasStartingNav ? (
                                <div
                                  style={{
                                    fontSize: 11,
                                    fontFamily: 'var(--font-mono)',
                                    color: 'var(--text-3)',
                                    marginTop: 4,
                                  }}
                                >
                                  {fmt.ngnM(p.starting_nav)} start
                                </div>
                              ) : (
                                <div
                                  style={{
                                    fontSize: 11,
                                    color: 'var(--text-3)',
                                    marginTop: 4,
                                    fontStyle: 'italic',
                                  }}
                                >
                                  Awaiting transactions
                                </div>
                              )}

                              {p.valuation_date && (
                                <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 10 }}>
                                  Val. {fmt.date(p.valuation_date)}
                                </div>
                              )}
                            </div>
                          </Link>

                          <button
                            onClick={e => {
                              e.preventDefault()
                              setConfirmDel({ id: p.id, name: p.name })
                            }}
                            style={{
                              position: 'absolute',
                              top: 10,
                              right: 10,
                              width: 22,
                              height: 22,
                              borderRadius: 3,
                              background: 'transparent',
                              border: 'none',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              cursor: 'pointer',
                              color: 'var(--text-3)',
                              opacity: 0,
                              transition: 'opacity 0.15s, color 0.15s',
                              zIndex: 10,
                            }}
                            className="delete-hover"
                            onMouseEnter={e => {
                              e.currentTarget.style.color = 'var(--neg)'
                            }}
                            onMouseLeave={e => {
                              e.currentTarget.style.color = 'var(--text-3)'
                            }}
                            title="Archive portfolio"
                          >
                            <Trash2 size={12} />
                          </button>
                        </div>
                      )
                    })}

                    <Link
                      href={`/admin/portfolios/new?client=${client.id}`}
                      style={{ textDecoration: 'none', color: 'inherit' }}
                    >
                      <div
                        style={{
                          border: '1px dashed var(--border-strong)',
                          borderRadius: 5,
                          padding: 20,
                          minHeight: 140,
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                          justifyContent: 'center',
                          textAlign: 'center',
                          color: 'var(--text-3)',
                          transition: 'border-color 0.15s, color 0.15s',
                          cursor: 'pointer',
                        }}
                        onMouseEnter={e => {
                          e.currentTarget.style.borderColor = 'var(--gold)'
                          e.currentTarget.style.color = 'var(--gold)'
                        }}
                        onMouseLeave={e => {
                          e.currentTarget.style.borderColor = 'var(--border-strong)'
                          e.currentTarget.style.color = 'var(--text-3)'
                        }}
                      >
                        <Plus size={18} style={{ marginBottom: 6 }} />
                        <div style={{ fontSize: 11 }}>Add portfolio</div>
                      </div>
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          )}
        </main>
      </div>

      {/* Show delete button on hover — scoped CSS */}
      <style jsx>{`
        .group:hover .delete-hover { opacity: 1 !important; }
      `}</style>
    </div>
  )
}

// ─── Subcomponents ──────────────────────────────────────────

function KpiTile({
  icon, label, value, sub,
}: {
  icon: React.ReactNode
  label: string
  value: string
  sub: string
}) {
  return (
    <div
      style={{
        background: 'var(--card)',
        border: '1px solid var(--border)',
        borderRadius: 5,
        padding: '18px 20px',
        display: 'flex',
        alignItems: 'center',
        gap: 14,
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          width: 32,
          height: 2,
          background: 'var(--gold)',
        }}
      />
      <div
        style={{
          width: 34,
          height: 34,
          borderRadius: 5,
          background: 'var(--gold-soft)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
        }}
      >
        {icon}
      </div>
      <div>
        <div
          style={{
            fontSize: 10,
            letterSpacing: '0.16em',
            color: 'var(--text-3)',
            textTransform: 'uppercase',
            fontWeight: 600,
            marginBottom: 4,
          }}
        >
          {label}
        </div>
        <div
          className="hybrid-serif"
          style={{
            fontSize: 22,
            fontWeight: 500,
            letterSpacing: '-0.01em',
            lineHeight: 1,
            color: 'var(--text)',
          }}
        >
          {value}
        </div>
        <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 4 }}>{sub}</div>
      </div>
    </div>
  )
}

function ConfirmModal({
  tone,
  title,
  subtitle,
  target,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
  busy,
}: {
  tone: 'breach' | 'warn'
  title: string
  subtitle: string
  target: string
  body: string
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
  busy: boolean
}) {
  const color = tone === 'breach' ? 'var(--neg)' : 'var(--warn)'
  const bg = tone === 'breach' ? 'rgba(166, 59, 59, 0.1)' : 'rgba(166, 124, 42, 0.12)'
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(10, 31, 58, 0.5)',
      }}
    >
      <div
        style={{
          background: 'var(--card)',
          border: '1px solid var(--border)',
          borderRadius: 5,
          padding: 24,
          width: 400,
          boxShadow: '0 10px 40px rgba(10, 31, 58, 0.25)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 }}>
          <div
            style={{
              width: 36,
              height: 36,
              borderRadius: 5,
              background: bg,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              flexShrink: 0,
            }}
          >
            <AlertTriangle size={18} style={{ color }} />
          </div>
          <div>
            <div className="hybrid-serif" style={{ fontSize: 18, fontWeight: 500, color: 'var(--text)' }}>
              {title}
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>{subtitle}</div>
          </div>
          <button
            onClick={onCancel}
            style={{
              marginLeft: 'auto',
              background: 'transparent',
              border: 'none',
              color: 'var(--text-3)',
              cursor: 'pointer',
            }}
          >
            <X size={16} />
          </button>
        </div>
        <div
          style={{
            padding: '10px 12px',
            background: 'var(--bg-soft)',
            borderRadius: 4,
            marginBottom: 14,
            fontSize: 13,
            color: 'var(--text-2)',
          }}
        >
          {target}
        </div>
        <div style={{ fontSize: 12, color: 'var(--text-2)', marginBottom: 18, lineHeight: 1.5 }}>
          {body}
        </div>
        <div style={{ display: 'flex', gap: 10 }}>
          <button
            onClick={onConfirm}
            disabled={busy}
            className="btn-h"
            style={{ background: color, color: 'white', borderColor: color }}
          >
            {busy ? <RefreshCw size={12} className="animate-spin" /> : <Trash2 size={12} />}
            {confirmLabel}
          </button>
          <button onClick={onCancel} className="btn-h">
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
