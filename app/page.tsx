'use client'

import { useState, useCallback } from 'react'
import { useAccount, useConnect, useDisconnect, usePublicClient, useChainId } from 'wagmi'
import { injected } from 'wagmi/connectors'
import { parseEther, formatEther } from 'viem'
import { useBatchExecutor } from '@/hooks/useBatchExecutor'
import {
  buildHarvestCall,
  buildGetRewardCall,
  buildClaimCall,
  BatchCall,
} from '@/services/batch-executor'

/* ─── env ─────────────────────────────────────────────────────────────────── */
const EXECUTOR_ADDRESS =
  (process.env.NEXT_PUBLIC_EXECUTOR_ADDRESS || '') as `0x${string}`
const RELAYER_ENDPOINT =
  process.env.NEXT_PUBLIC_RELAYER_ENDPOINT || 'http://localhost:3001'

/* ─── chain helpers ────────────────────────────────────────────────────────── */
const CHAIN_NAMES: Record<number, string> = {
  1: 'Ethereum', 11155111: 'Sepolia', 8453: 'Base', 84532: 'Base Sepolia',
  42161: 'Arbitrum', 10: 'Optimism', 137: 'Polygon',
}
const EXPLORER_TX: Record<number, string> = {
  1: 'https://etherscan.io/tx/',
  11155111: 'https://sepolia.etherscan.io/tx/',
  8453: 'https://basescan.org/tx/',
  84532: 'https://sepolia.basescan.org/tx/',
  42161: 'https://arbiscan.io/tx/',
  10: 'https://optimistic.etherscan.io/tx/',
  137: 'https://polygonscan.com/tx/',
}

/* ─── call entry types ─────────────────────────────────────────────────────── */
type CallEntry =
  | { id: string; type: 'harvest';   farmContract: string }
  | { id: string; type: 'getReward'; stakingContract: string }
  | { id: string; type: 'claim';     rewardContract: string; recipient: string }

let _id = 0
const uid = () => String(++_id)

/* ─── status messages ──────────────────────────────────────────────────────── */
const STATUS_LABEL: Record<string, string> = {
  'switching-chain': '🔄 Switching chain…',
  'signing-auth':    '✍️  Sign EIP-7702 delegation…',
  'signing-intent':  '✍️  Sign batch intent…',
  'submitting':      '📡 Sending to relayer…',
  'processing':      '⏳ Waiting for confirmation…',
  'success':         '✅ Done!',
  'error':           '❌ Error',
}

/* ═══════════════════════════════════════════════════════════════════════════ */
export default function Page() {
  const { address, isConnected } = useAccount()
  const { connect, isPending: isConnecting } = useConnect()
  const { disconnect } = useDisconnect()
  const chainId = useChainId()
  const publicClient = usePublicClient()

  /* ── form state ── */
  const [callEntries, setCallEntries]       = useState<CallEntry[]>([])
  const [sweepTokens, setSweepTokens]       = useState<string[]>([])
  const [sweepNative, setSweepNative]       = useState(true)
  const [destination, setDestination]       = useState('')
  const [maxFeeEth, setMaxFeeEth]           = useState('0.001')

  /* ── input staging ── */
  const [farmInput, setFarmInput]           = useState('')
  const [stakingInput, setStakingInput]     = useState('')
  const [claimContract, setClaimContract]   = useState('')
  const [claimRecipient, setClaimRecipient] = useState('')
  const [tokenInput, setTokenInput]         = useState('')

  const { execute, status, txHash, error, reset } = useBatchExecutor({
    executorContractAddress: EXECUTOR_ADDRESS,
    relayerEndpoint:         RELAYER_ENDPOINT,
  })

  /* ── add/remove helpers ── */
  const addHarvest = () => {
    if (!farmInput.trim()) return
    setCallEntries(prev => [...prev, { id: uid(), type: 'harvest', farmContract: farmInput.trim() }])
    setFarmInput('')
  }
  const addGetReward = () => {
    if (!stakingInput.trim()) return
    setCallEntries(prev => [...prev, { id: uid(), type: 'getReward', stakingContract: stakingInput.trim() }])
    setStakingInput('')
  }
  const addClaim = () => {
    if (!claimContract.trim()) return
    setCallEntries(prev => [...prev, { id: uid(), type: 'claim', rewardContract: claimContract.trim(), recipient: claimRecipient.trim() || (address ?? '') }])
    setClaimContract(''); setClaimRecipient('')
  }
  const removeCall = (id: string) => setCallEntries(prev => prev.filter(c => c.id !== id))

  const addToken = () => {
    if (!tokenInput.trim()) return
    setSweepTokens(prev => [...prev, tokenInput.trim()])
    setTokenInput('')
  }
  const removeToken = (i: number) => setSweepTokens(prev => prev.filter((_, idx) => idx !== i))

  /* ── execute ── */
  const handleExecute = useCallback(async () => {
    if (!address || !publicClient) return

    const calls: BatchCall[] = callEntries.map(e => {
      if (e.type === 'harvest')   return buildHarvestCall(e.farmContract as `0x${string}`, address)
      if (e.type === 'getReward') return buildGetRewardCall(e.stakingContract as `0x${string}`)
      return buildClaimCall(e.rewardContract as `0x${string}`, (e.recipient || address) as `0x${string}`)
    })

    let maxFeeWei: bigint
    try { maxFeeWei = parseEther(maxFeeEth || '0.001') } catch { maxFeeWei = parseEther('0.001') }

    // Use the EOA's pending nonce: this ensures we account for in-flight transactions
    // and gives the exact value the EVM will check against the EIP-7702 authorization tuple.
    const accountNonce = await publicClient.getTransactionCount({ address, blockTag: 'pending' })

    await execute({
      calls,
      sweepTokens:   sweepTokens as `0x${string}`[],
      sweepNative,
      destination:   (destination.trim() || address) as `0x${string}`,
      maxFeeWei,
      deadline:      BigInt(Math.floor(Date.now() / 1000) + 1800), // 30 min
      nonce:         BigInt(accountNonce),
      targetChainId: chainId,
    })
  }, [address, publicClient, callEntries, sweepTokens, sweepNative, destination, maxFeeEth, chainId, execute])

  const explorerUrl = txHash ? (EXPLORER_TX[chainId] ?? '') + txHash : null
  const isRunning   = !['idle', 'success', 'error'].includes(status)
  const isReady     = isConnected && (callEntries.length > 0 || sweepTokens.length > 0 || sweepNative)

  /* ══════════════════════════════════════════════════════════════════════════ */
  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '2rem 1rem' }}>

      {/* header */}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <div>
          <h1 style={{ fontSize: '1.4rem', fontWeight: 700, letterSpacing: '-0.02em' }}>EIP-7702 Executor</h1>
          <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginTop: 2 }}>
            Batch harvest &amp; sweep via one-time EOA delegation
          </p>
        </div>

        {isConnected ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <span className="pill">{CHAIN_NAMES[chainId] ?? `Chain ${chainId}`}</span>
            <span className="pill" title={address}>{address?.slice(0, 6)}…{address?.slice(-4)}</span>
            <button className="btn-ghost btn-sm" onClick={() => disconnect()}>Disconnect</button>
          </div>
        ) : (
          <button
            className="btn-primary"
            disabled={isConnecting}
            onClick={() => connect({ connector: injected() })}
          >
            {isConnecting ? 'Connecting…' : 'Connect Wallet'}
          </button>
        )}
      </header>

      {/* not-connected splash */}
      {!isConnected && (
        <div className="card" style={{ textAlign: 'center', padding: '3rem 1.5rem' }}>
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🔐</div>
          <h2 style={{ marginBottom: '0.5rem' }}>Connect your wallet to get started</h2>
          <p style={{ color: 'var(--muted)', fontSize: '0.875rem', marginBottom: '1.5rem' }}>
            Requires MetaMask or Rabby with EIP-7702 support (or any EIP-1193 wallet).
          </p>
          <button className="btn-primary" disabled={isConnecting} onClick={() => connect({ connector: injected() })}>
            {isConnecting ? 'Connecting…' : 'Connect Wallet'}
          </button>
        </div>
      )}

      {/* executor not configured warning */}
      {isConnected && !EXECUTOR_ADDRESS && (
        <div className="card" style={{ borderColor: 'var(--warn)', marginBottom: '1.5rem', background: 'rgba(245,158,11,0.07)' }}>
          <p style={{ color: 'var(--warn)', fontSize: '0.875rem' }}>
            ⚠️ <strong>NEXT_PUBLIC_EXECUTOR_ADDRESS</strong> is not set. Deploy the contract first, then add its address to <code>.env.local</code>.
          </p>
        </div>
      )}

      {isConnected && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>

          {/* ── Protocol Calls ── */}
          <div className="card">
            <p className="section-title">Protocol Calls</p>

            {/* harvest */}
            <div style={{ marginBottom: '1.25rem' }}>
              <label>farm.harvest(address) — rewards sent to your wallet</label>
              <div className="row">
                <input value={farmInput} onChange={e => setFarmInput(e.target.value)} placeholder="Farm contract address 0x…" onKeyDown={e => e.key === 'Enter' && addHarvest()} />
                <button className="btn-ghost btn-sm" style={{ whiteSpace: 'nowrap' }} onClick={addHarvest}>+ Add</button>
              </div>
            </div>

            {/* getReward */}
            <div style={{ marginBottom: '1.25rem' }}>
              <label>staking.getReward() — Synthetix-style staking</label>
              <div className="row">
                <input value={stakingInput} onChange={e => setStakingInput(e.target.value)} placeholder="Staking contract address 0x…" onKeyDown={e => e.key === 'Enter' && addGetReward()} />
                <button className="btn-ghost btn-sm" style={{ whiteSpace: 'nowrap' }} onClick={addGetReward}>+ Add</button>
              </div>
            </div>

            {/* claim */}
            <div>
              <label>contract.claim(recipient) — generic reward claim</label>
              <div className="row" style={{ marginBottom: '0.4rem' }}>
                <input value={claimContract} onChange={e => setClaimContract(e.target.value)} placeholder="Reward contract 0x…" />
                <input value={claimRecipient} onChange={e => setClaimRecipient(e.target.value)} placeholder="Recipient (default: you)" />
                <button className="btn-ghost btn-sm" style={{ whiteSpace: 'nowrap' }} onClick={addClaim}>+ Add</button>
              </div>
            </div>

            {/* call list */}
            {callEntries.length > 0 && (
              <div style={{ marginTop: '1rem', display: 'flex', flexDirection: 'column', gap: '0.4rem' }}>
                {callEntries.map((e, i) => (
                  <div key={e.id} className="row" style={{ justifyContent: 'space-between', background: 'var(--surface)', borderRadius: 6, padding: '0.4rem 0.75rem' }}>
                    <span className="mono">
                      [{i + 1}] {e.type === 'harvest' ? `harvest  ${e.farmContract}` : e.type === 'getReward' ? `getReward  ${e.stakingContract}` : `claim  ${e.rewardContract}  →  ${e.recipient || address}`}
                    </span>
                    <button className="btn-danger" onClick={() => removeCall(e.id)}>✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* ── Sweep Settings ── */}
          <div className="card">
            <p className="section-title">Sweep Settings</p>

            {/* native sweep */}
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.6rem', cursor: 'pointer', marginBottom: '1.25rem' }}>
              <input type="checkbox" checked={sweepNative} onChange={e => setSweepNative(e.target.checked)} style={{ width: 'auto', cursor: 'pointer' }} />
              <span style={{ fontSize: '0.875rem', color: 'var(--text)' }}>Sweep native balance (ETH / BNB / MATIC) minus relayer fee</span>
            </label>

            {/* erc-20 tokens */}
            <div>
              <label>ERC-20 tokens to sweep</label>
              <div className="row" style={{ marginBottom: '0.6rem' }}>
                <input value={tokenInput} onChange={e => setTokenInput(e.target.value)} placeholder="Token contract address 0x…" onKeyDown={e => e.key === 'Enter' && addToken()} />
                <button className="btn-ghost btn-sm" style={{ whiteSpace: 'nowrap' }} onClick={addToken}>+ Add</button>
              </div>
              {sweepTokens.length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                  {sweepTokens.map((t, i) => (
                    <span key={i} className="tag">
                      {t.slice(0, 6)}…{t.slice(-4)}
                      <button className="btn-danger" style={{ marginLeft: 6 }} onClick={() => removeToken(i)}>✕</button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* ── Execution Settings ── */}
          <div className="card">
            <p className="section-title">Execution Settings</p>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
              <div>
                <label>Destination address (default: your wallet)</label>
                <input value={destination} onChange={e => setDestination(e.target.value)} placeholder={address ?? '0x…'} />
              </div>
              <div>
                <label>Max relayer fee (ETH)</label>
                <input type="number" step="0.0001" min="0" value={maxFeeEth} onChange={e => setMaxFeeEth(e.target.value)} placeholder="0.001" />
              </div>
            </div>
          </div>

          {/* ── Status / Progress ── */}
          {status !== 'idle' && (
            <div className="card" style={{ borderColor: status === 'success' ? 'var(--success)' : status === 'error' ? 'var(--error)' : 'var(--primary)' }}>
              <p style={{ fontWeight: 600, marginBottom: '0.5rem' }}>{STATUS_LABEL[status] ?? status}</p>

              {status === 'error' && error && (
                <p style={{ color: 'var(--error)', fontSize: '0.875rem' }}>{error}</p>
              )}

              {status === 'success' && txHash && (
                <div>
                  <p style={{ fontSize: '0.875rem', color: 'var(--muted)', marginBottom: '0.4rem' }}>Transaction hash:</p>
                  <p className="mono" style={{ marginBottom: explorerUrl ? '0.6rem' : 0 }}>{txHash}</p>
                  {explorerUrl && <a href={explorerUrl} target="_blank" rel="noopener noreferrer">View on Explorer ↗</a>}
                </div>
              )}

              {(status === 'success' || status === 'error') && (
                <button className="btn-ghost btn-sm" style={{ marginTop: '0.75rem' }} onClick={reset}>Reset</button>
              )}
            </div>
          )}

          {/* ── Execute Button ── */}
          <button
            className="btn-primary"
            style={{ padding: '0.85rem', fontSize: '1rem', borderRadius: 'var(--radius)' }}
            disabled={isRunning || !isReady || !EXECUTOR_ADDRESS}
            onClick={handleExecute}
          >
            {isRunning
              ? (STATUS_LABEL[status] ?? 'Working…')
              : 'Execute Batch'}
          </button>

          {!isReady && (
            <p style={{ textAlign: 'center', color: 'var(--muted)', fontSize: '0.8rem', marginTop: '-0.75rem' }}>
              Add at least one protocol call or enable native sweep to proceed.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
