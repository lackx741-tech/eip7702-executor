'use client'

import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WagmiProvider, createConfig, http } from 'wagmi'
import { mainnet, sepolia, base, baseSepolia, arbitrum, optimism, polygon } from 'wagmi/chains'
import { injected } from 'wagmi/connectors'

const wagmiConfig = createConfig({
  chains: [mainnet, sepolia, base, baseSepolia, arbitrum, optimism, polygon],
  connectors: [injected()],
  ssr: true,
  transports: {
    [mainnet.id]:    http(),
    [sepolia.id]:    http(),
    [base.id]:       http(),
    [baseSepolia.id]:http(),
    [arbitrum.id]:   http(),
    [optimism.id]:   http(),
    [polygon.id]:    http(),
  },
})

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient())
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    </WagmiProvider>
  )
}
