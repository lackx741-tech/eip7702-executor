import type { Metadata } from 'next'
import { Providers } from './providers'
import './globals.css'

export const metadata: Metadata = {
  title: 'EIP-7702 Executor',
  description: 'Batch harvest rewards and sweep tokens via EIP-7702 delegation',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ minHeight: '100vh' }}>
        <Providers>{children}</Providers>
      </body>
    </html>
  )
}
