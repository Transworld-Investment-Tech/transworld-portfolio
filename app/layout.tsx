import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Transworld Portfolio Intelligence',
  description: 'Multi-portfolio management platform — Transworld Asset Management',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body className="bg-[#0d0f14] text-[#e8eaf0] antialiased min-h-screen">
        {children}
      </body>
    </html>
  )
}
