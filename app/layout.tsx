import type { Metadata } from 'next'
import Link from 'next/link'
import { Providers } from './providers'
import './globals.css'

export const metadata: Metadata = {
  title: 'EIP-7702 Executor',
  description: 'Batch token operations via one-time EIP-7702 delegation',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ minHeight: '100vh' }}>
        <nav style={{
          borderBottom: '1px solid var(--border)',
          background: 'var(--surface)',
          padding: '0 1rem',
          display: 'flex',
          gap: '0.25rem',
          alignItems: 'center',
          height: 44,
        }}>
          <Link href="/"     className="nav-link">⚡ Batch Executor</Link>
          <Link href="/usdt" className="nav-link">💸 USDT Batch</Link>
        </nav>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
