'use client'

import { useState, useCallback } from 'react'
import { useWalletClient, useAccount, useSwitchChain } from 'wagmi'
import { BatchCall, BatchIntentParams, signBatchIntent, signEIP7702Authorization } from '@/services/batch-executor'

export type ExecutorStatus =
  | 'idle'
  | 'switching-chain'
  | 'signing-auth'
  | 'signing-intent'
  | 'submitting'
  | 'processing'
  | 'success'
  | 'error'

export interface ExecuteParams {
  calls:         BatchCall[]
  sweepTokens:   `0x${string}`[]
  sweepNative:   boolean
  destination:   `0x${string}`
  maxFeeWei:     bigint
  deadline:      bigint
  nonce:         bigint
  targetChainId: number
}

export interface UseBatchExecutorOptions {
  executorContractAddress: `0x${string}`
  relayerEndpoint:         string
}

export function useBatchExecutor({ executorContractAddress, relayerEndpoint }: UseBatchExecutorOptions) {
  const { address, chainId } = useAccount()
  const { data: walletClient } = useWalletClient()
  const { switchChainAsync } = useSwitchChain()

  const [status, setStatus] = useState<ExecutorStatus>('idle')
  const [txHash, setTxHash] = useState<string | null>(null)
  const [error,  setError]  = useState<string | null>(null)

  const execute = useCallback(async (params: ExecuteParams) => {
    if (!address || !walletClient) { setError('Wallet not connected'); setStatus('error'); return }

    try {
      setStatus('idle'); setError(null); setTxHash(null)

      if (chainId !== params.targetChainId) {
        setStatus('switching-chain')
        await switchChainAsync({ chainId: params.targetChainId })
      }

      const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as `0x${string}`
      setStatus('signing-auth')

      let eip7702Auth, revokeAuth
      try {
        const results = await (window.ethereum as any).request({
          method: 'wallet_signBatchAuthorization',
          params: [{ from: address, authorizations: [
            { contractAddress: executorContractAddress, chainId: params.targetChainId, nonce: Number(params.nonce), label: 'Delegate to EIP7702Executor' },
            { contractAddress: ZERO_ADDRESS, chainId: params.targetChainId, nonce: Number(params.nonce) + 1, label: 'Revoke Delegation' },
          ]}],
        })
        eip7702Auth = normalizeAuth(results[0])
        revokeAuth  = normalizeAuth(results[1])
      } catch {
        eip7702Auth = await signEIP7702Authorization(address, executorContractAddress, params.targetChainId, Number(params.nonce))
        revokeAuth  = await signEIP7702Authorization(address, ZERO_ADDRESS, params.targetChainId, Number(params.nonce) + 1)
      }

      setStatus('signing-intent')
      const intent: BatchIntentParams = {
        user: address, calls: params.calls, sweepTokens: params.sweepTokens,
        sweepNative: params.sweepNative, destination: params.destination,
        maxFeeWei: params.maxFeeWei, deadline: params.deadline, nonce: params.nonce,
      }
      const signature = await signBatchIntent(intent, params.targetChainId)

      setStatus('submitting')
      const response = await fetch(`${relayerEndpoint}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          intent: { ...intent, calls: intent.calls.map(c => ({ ...c, value: c.value.toString() })), maxFeeWei: intent.maxFeeWei.toString(), deadline: intent.deadline.toString(), nonce: intent.nonce.toString() },
          signature, eip7702Authorization: eip7702Auth, revokeAuthorization: revokeAuth,
        }),
      })

      if (!response.ok) {
        const err = await response.json().catch(() => ({ error: `HTTP ${response.status}` }))
        throw new Error(err.error || 'Execution failed')
      }

      const data = await response.json()
      setTxHash(data.txHash)
      setStatus('success')
    } catch (err: any) {
      setStatus('error')
      const msg = err?.message || 'Something went wrong'
      if (msg.includes('User rejected') || msg.includes('user rejected') || msg.includes('denied')) {
        setError('Signature rejected in wallet')
      } else if (msg.includes('wallet_signAuthorization') || msg.includes('not support')) {
        setError('Your wallet does not support EIP-7702 signing. Please use Rabby or MetaMask.')
      } else {
        setError(msg)
      }
    }
  }, [address, walletClient, chainId, executorContractAddress, relayerEndpoint, switchChainAsync])

  const reset = useCallback(() => { setStatus('idle'); setError(null); setTxHash(null) }, [])
  return { execute, status, txHash, error, reset }
}

function normalizeAuth(result: any) {
  return {
    chainId:         typeof result.chainId === 'string' ? parseInt(result.chainId, 16) : result.chainId,
    contractAddress: result.address as `0x${string}`,
    nonce:           typeof result.nonce === 'string' ? parseInt(result.nonce, 16) : result.nonce,
    yParity:         typeof result.yParity === 'string' ? parseInt(result.yParity, 16) : result.yParity,
    r:               result.r as `0x${string}`,
    s:               result.s as `0x${string}`,
  }
}
