'use client'

import { useState, useCallback, useRef } from 'react'
import { useAccount, useConnect, useDisconnect, usePublicClient, useChainId } from 'wagmi'
import { injected } from 'wagmi/connectors'
import { parseAbi, parseEther, isAddress } from 'viem'
import { useBatchExecutor } from '@/hooks/useBatchExecutor'
import {
  USDT_ADDRESSES,
  UsdtRecipient,
  buildUsdtTransferCall,
  parseCsvRecipients,
  parseUsdtAmount,
  formatUsdtAmount,
  totalUsdtRaw,
} from '@/services/usdt-batch'

/* ─── env ─────────────────────────────────────────────────────────────────── */
const EXECUTOR_ADDRESS =
  (process.env.NEXT_PUBLIC_EXECUTOR_ADDRESS || '') as `0x${string}`
const RELAYER_ENDPOINT =
  process.env.NEXT_PUBLIC_RELAYER_ENDPOINT || 'http://localhost:3001'

/* ─── chain helpers ─────────────────────────────────────────────────────── */
const CHAIN_NAMES: Record<number, string> = {
  1: 'Ethereum', 11155111: 'Sepolia', 8453: 'Base', 84532: 'Base Sepolia',
  42161: 'Arbitrum', 10: 'Optimism', 137: 'Polygon',
}
const EXPLORER_TX: Record<number, string> = {
  1:        'https://etherscan.io/tx/',
  11155111: 'https://sepolia.etherscan.io/tx/',
  8453:     'https://basescan.org/tx/',
  84532:    'https://sepolia.basescan.org/tx/',
  42161:    'https://arbiscan.io/tx/',
  10:       'https://optimistic.etherscan.io/tx/',
  137:      'https://polygonscan.com/tx/',
}

/* ─── status labels ──────────────────────────────────────────────────────── */
const STATUS_LABEL: Record<string, string> = {
  'switching-chain': '🔄 Switching chain…',
  'signing-auth':    '✍️  Sign EIP-7702 delegation…',
  'signing-intent':  '✍️  Sign batch intent…',
  'submitting':      '📡 Sending to relayer…',
  'processing':      '⏳ Waiting for confirmation…',
  'success':         '✅ Done!',
  'error':           '❌ Error',
}

/** Deadline window for a submitted batch intent (seconds). */
const DEADLINE_OFFSET_SECONDS = 1800 // 30 minutes

let _id = 0
const uid = () => String(++_id)

/* ═══════════════════════════════════════════════════════════════════════════ */
export default function UsdtBatchPage() {
  const { address, isConnected } = useAccount()
  const { connect, isPending: isConnecting } = useConnect()
  const { disconnect } = useDisconnect()
  const chainId      = useChainId()
  const publicClient = usePublicClient()

  /* ── recipient list ── */
  const [recipients, setRecipients] = useState<(UsdtRecipient & { id: string })[]>([])
  const [addrInput, setAddrInput]   = useState('')
  const [amtInput,  setAmtInput]    = useState('')

  /* ── csv import ── */
  const [csvText,   setCsvText]     = useState('')
  const [csvError,  setCsvError]    = useState('')
  const csvInputRef = useRef<HTMLInputElement>(null)

  /* ── USDT balance ── */
  const [usdtBalance, setUsdtBalance] = useState<bigint | null>(null)
  const [balanceLoading, setBalanceLoading] = useState(false)

  /* ── settings ── */
  const [maxFeeEth, setMaxFeeEth]   = useState('0.001')

  const { execute, status, txHash, error, reset } = useBatchExecutor({
    executorContractAddress: EXECUTOR_ADDRESS,
    relayerEndpoint:         RELAYER_ENDPOINT,
  })

  /* ── helpers ── */
  const usdtAddress = USDT_ADDRESSES[chainId]

  const addRecipient = () => {
    const addr = addrInput.trim() as `0x${string}`
    const amt  = amtInput.trim()
    if (!isAddress(addr)) return
    if (!/^\d+(\.\d*)?$/.test(amt) || parseFloat(amt) <= 0) return
    setRecipients(prev => [...prev, { id: uid(), address: addr, amount: amt }])
    setAddrInput(''); setAmtInput('')
  }

  const removeRecipient = (id: string) =>
    setRecipients(prev => prev.filter(r => r.id !== id))

  const importCsv = () => {
    setCsvError('')
    const parsed = parseCsvRecipients(csvText)
    if (parsed.length === 0) {
      setCsvError('No valid rows found. Format: 0x…address,amount — one per line.')
      return
    }
    setRecipients(prev => [...prev, ...parsed.map(r => ({ ...r, id: uid() }))])
    setCsvText('')
  }

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => setCsvText(ev.target?.result as string ?? '')
    reader.readAsText(file)
    if (csvInputRef.current) csvInputRef.current.value = ''
  }

  const fetchBalance = useCallback(async () => {
    if (!address || !publicClient || !usdtAddress) return
    setBalanceLoading(true)
    try {
      const raw = await publicClient.readContract({
        address:      usdtAddress,
        abi:          parseAbi(['function balanceOf(address) view returns (uint256)']),
        functionName: 'balanceOf',
        args:         [address],
      })
      setUsdtBalance(raw as bigint)
    } catch {
      setUsdtBalance(null)
    } finally {
      setBalanceLoading(false)
    }
  }, [address, publicClient, usdtAddress])

  /* ── execute ── */
  const handleExecute = useCallback(async () => {
    if (!address || !publicClient || recipients.length === 0 || !usdtAddress) return

    const calls = recipients.map(r =>
      buildUsdtTransferCall(usdtAddress, r.address, parseUsdtAmount(r.amount))
    )

    let maxFeeWei: bigint
    try { maxFeeWei = parseEther(maxFeeEth || '0.001') }
    catch { maxFeeWei = parseEther('0.001') }

    const accountNonce = await publicClient.getTransactionCount({ address, blockTag: 'pending' })

    await execute({
      calls,
      sweepTokens:   [],
      sweepNative:   false,
      destination:   address,
      maxFeeWei,
      deadline:      BigInt(Math.floor(Date.now() / 1000) + DEADLINE_OFFSET_SECONDS),
      nonce:         BigInt(accountNonce),
      targetChainId: chainId,
    })
  }, [address, publicClient, recipients, usdtAddress, maxFeeEth, chainId, execute])

  /* ── derived ── */
  const totalRaw    = totalUsdtRaw(recipients)
  const explorerUrl = txHash ? (EXPLORER_TX[chainId] ?? '') + txHash : null
  const isRunning   = !['idle', 'success', 'error'].includes(status)
  const isReady     = isConnected && recipients.length > 0 && !!usdtAddress && !!EXECUTOR_ADDRESS
  const hasUsdtChain = !!usdtAddress

  /* ══════════════════════════════════════════════════════════════════════════ */
  return (
    <div style={{ maxWidth: 760, margin: '0 auto', padding: '2rem 1rem' }}>

      {/* ── header ── */}
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '2rem' }}>
        <div>
          <h1 style={{ fontSize: '1.4rem', fontWeight: 700, letterSpacing: '-0.02em' }}>USDT Batch Transfer</h1>
          <p style={{ fontSize: '0.8rem', color: 'var(--muted)', marginTop: 2 }}>
            Send USDT to multiple recipients in one atomic EIP-7702 transaction
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

      {/* ── not connected ── */}
      {!isConnected && (
        <div className="card" style={{ textAlign: 'center', padding: '3rem 1.5rem' }}>
          <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>💸</div>
          <h2 style={{ marginBottom: '0.5rem' }}>Connect your wallet to get started</h2>
          <p style={{ color: 'var(--muted)', fontSize: '0.875rem', marginBottom: '1.5rem' }}>
            Requires MetaMask or Rabby with EIP-7702 support (or any EIP-1193 wallet).
          </p>
          <button className="btn-primary" disabled={isConnecting} onClick={() => connect({ connector: injected() })}>
            {isConnecting ? 'Connecting…' : 'Connect Wallet'}
          </button>
        </div>
      )}

      {/* ── executor not configured ── */}
      {isConnected && !EXECUTOR_ADDRESS && (
        <div className="card" style={{ borderColor: 'var(--warn)', marginBottom: '1.5rem', background: 'rgba(245,158,11,0.07)' }}>
          <p style={{ color: 'var(--warn)', fontSize: '0.875rem' }}>
            ⚠️ <strong>NEXT_PUBLIC_EXECUTOR_ADDRESS</strong> is not set. Deploy the EIP7702Executor contract and add its address to <code>.env.local</code>.
          </p>
        </div>
      )}

      {/* ── unsupported chain ── */}
      {isConnected && !hasUsdtChain && (
        <div className="card" style={{ borderColor: 'var(--warn)', marginBottom: '1.5rem', background: 'rgba(245,158,11,0.07)' }}>
          <p style={{ color: 'var(--warn)', fontSize: '0.875rem' }}>
            ⚠️ USDT is not configured for chain <strong>{CHAIN_NAMES[chainId] ?? chainId}</strong>. Switch to Ethereum, Arbitrum, Optimism, Polygon, or Base.
          </p>
        </div>
      )}

      {isConnected && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>

          {/* ── USDT balance ── */}
          {hasUsdtChain && (
            <div className="card" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <p className="section-title" style={{ marginBottom: 4 }}>Your USDT Balance</p>
                <p style={{ fontSize: '1.25rem', fontWeight: 700 }}>
                  {usdtBalance !== null
                    ? `${formatUsdtAmount(usdtBalance)} USDT`
                    : <span style={{ color: 'var(--muted)', fontSize: '0.875rem' }}>—</span>
                  }
                </p>
              </div>
              <button className="btn-ghost btn-sm" onClick={fetchBalance} disabled={balanceLoading}>
                {balanceLoading ? 'Loading…' : 'Refresh Balance'}
              </button>
            </div>
          )}

          {/* ── manual recipient entry ── */}
          <div className="card">
            <p className="section-title">Add Recipient</p>
            <div className="row" style={{ marginBottom: '0.5rem' }}>
              <input
                value={addrInput}
                onChange={e => setAddrInput(e.target.value)}
                placeholder="Recipient address 0x…"
                onKeyDown={e => e.key === 'Enter' && addRecipient()}
              />
              <input
                type="number"
                step="0.000001"
                min="0"
                value={amtInput}
                onChange={e => setAmtInput(e.target.value)}
                placeholder="USDT amount"
                style={{ maxWidth: 160 }}
                onKeyDown={e => e.key === 'Enter' && addRecipient()}
              />
              <button className="btn-ghost btn-sm" style={{ whiteSpace: 'nowrap' }} onClick={addRecipient}>
                + Add
              </button>
            </div>
          </div>

          {/* ── CSV import ── */}
          <div className="card">
            <p className="section-title">Import from CSV</p>
            <p style={{ fontSize: '0.75rem', color: 'var(--muted)', marginBottom: '0.6rem' }}>
              One <code>address,amount</code> pair per line. Lines starting with <code>#</code> are ignored.
            </p>
            <textarea
              value={csvText}
              onChange={e => { setCsvText(e.target.value); setCsvError('') }}
              placeholder={'# Example\n0xRecipient1Address,100.00\n0xRecipient2Address,50.50'}
              rows={5}
              style={{ marginBottom: '0.6rem', fontFamily: 'monospace', fontSize: '0.8rem', resize: 'vertical' }}
            />
            {csvError && (
              <p style={{ color: 'var(--error)', fontSize: '0.8rem', marginBottom: '0.5rem' }}>{csvError}</p>
            )}
            <div className="row">
              <button className="btn-ghost btn-sm" onClick={importCsv} disabled={!csvText.trim()}>
                Import CSV
              </button>
              <span style={{ color: 'var(--muted)', fontSize: '0.75rem' }}>or</span>
              <label style={{ margin: 0, cursor: 'pointer' }}>
                <span
                  style={{
                    display: 'inline-block', padding: '0.35rem 0.75rem', fontSize: '0.8rem',
                    background: 'var(--card)', border: '1px solid var(--border)',
                    borderRadius: 'var(--radius)', cursor: 'pointer', fontWeight: 600,
                  }}
                >
                  Upload .csv file
                </span>
                <input
                  ref={csvInputRef}
                  type="file"
                  accept=".csv,text/csv,text/plain"
                  onChange={handleFileUpload}
                  style={{ display: 'none' }}
                />
              </label>
            </div>
          </div>

          {/* ── recipient list ── */}
          {recipients.length > 0 && (
            <div className="card">
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem' }}>
                <p className="section-title" style={{ marginBottom: 0 }}>
                  Recipients ({recipients.length})
                </p>
                <button
                  className="btn-danger"
                  style={{ fontSize: '0.75rem' }}
                  onClick={() => setRecipients([])}
                >
                  Clear All
                </button>
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.4rem', maxHeight: 280, overflowY: 'auto' }}>
                {recipients.map((r, i) => (
                  <div
                    key={r.id}
                    className="row"
                    style={{ justifyContent: 'space-between', background: 'var(--surface)', borderRadius: 6, padding: '0.4rem 0.75rem' }}
                  >
                    <span className="mono">
                      [{i + 1}]&nbsp;{r.address.slice(0, 8)}…{r.address.slice(-6)}
                    </span>
                    <span style={{ color: 'var(--text)', fontWeight: 600, fontSize: '0.85rem', margin: '0 0.75rem 0 auto' }}>
                      {r.amount} USDT
                    </span>
                    <button className="btn-danger" onClick={() => removeRecipient(r.id)}>✕</button>
                  </div>
                ))}
              </div>

              {/* totals row */}
              <div style={{ borderTop: '1px solid var(--border)', marginTop: '0.75rem', paddingTop: '0.75rem', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={{ fontSize: '0.8rem', color: 'var(--muted)' }}>Total to send</span>
                <span style={{ fontWeight: 700, fontSize: '1rem' }}>
                  {formatUsdtAmount(totalRaw)} USDT
                </span>
              </div>

              {/* insufficient balance warning */}
              {usdtBalance !== null && totalRaw > usdtBalance && (
                <p style={{ color: 'var(--error)', fontSize: '0.8rem', marginTop: '0.5rem' }}>
                  ⚠️ Total ({formatUsdtAmount(totalRaw)}) exceeds your balance ({formatUsdtAmount(usdtBalance)}).
                </p>
              )}
            </div>
          )}

          {/* ── execution settings ── */}
          <div className="card">
            <p className="section-title">Execution Settings</p>
            <div style={{ maxWidth: 240 }}>
              <label>Max relayer fee (ETH)</label>
              <input
                type="number"
                step="0.0001"
                min="0"
                value={maxFeeEth}
                onChange={e => setMaxFeeEth(e.target.value)}
                placeholder="0.001"
              />
            </div>
          </div>

          {/* ── status / progress ── */}
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

          {/* ── execute button ── */}
          <button
            className="btn-primary"
            style={{ padding: '0.85rem', fontSize: '1rem', borderRadius: 'var(--radius)' }}
            disabled={isRunning || !isReady || (usdtBalance !== null && totalRaw > usdtBalance)}
            onClick={handleExecute}
          >
            {isRunning
              ? (STATUS_LABEL[status] ?? 'Working…')
              : `Send to ${recipients.length} Recipient${recipients.length !== 1 ? 's' : ''}`
            }
          </button>

          {!isReady && isConnected && (
            <p style={{ textAlign: 'center', color: 'var(--muted)', fontSize: '0.8rem', marginTop: '-0.75rem' }}>
              {!usdtAddress
                ? 'Switch to a supported chain to use USDT batch transfers.'
                : !EXECUTOR_ADDRESS
                ? 'Set NEXT_PUBLIC_EXECUTOR_ADDRESS to proceed.'
                : 'Add at least one recipient to proceed.'}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
