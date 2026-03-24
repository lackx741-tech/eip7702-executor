import { encodeFunctionData, parseAbi, isAddress } from 'viem'
import { BatchCall } from './batch-executor'

/* ─── USDT contract addresses per chain ────────────────────────────────────── */
export const USDT_ADDRESSES: Record<number, `0x${string}`> = {
  1:        '0xdAC17F958D2ee523a2206206994597C13D831ec7', // Ethereum mainnet
  11155111: '0xaA8E23Fb1079EA71e0a56F48a2aA51851D8433D0', // Sepolia (Tether USD test token)
  42161:    '0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9', // Arbitrum One
  10:       '0x94b008aA00579c1307B0EF2c499aD98a8ce58e58', // Optimism
  137:      '0xc2132D05D31c914a87C6611C10748AEb04B58e8F', // Polygon
  8453:     '0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2', // Base
  84532:    '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // Base Sepolia (USDC used as test stable)
}

/** USDT uses 6 decimal places on all EVM chains */
export const USDT_DECIMALS = 6

export interface UsdtRecipient {
  /** Checksummed EVM address of the USDT recipient */
  address: `0x${string}`
  /** Human-readable USDT amount, e.g. "100.50" */
  amount: string
}

/** Parse a human-readable USDT amount into raw on-chain units (6 decimals). */
export function parseUsdtAmount(amount: string): bigint {
  const trimmed = amount.trim()
  if (!/^\d+(\.\d*)?$/.test(trimmed)) throw new Error(`Invalid USDT amount: "${trimmed}"`)
  const dotIdx  = trimmed.indexOf('.')
  const whole   = dotIdx === -1 ? trimmed : trimmed.slice(0, dotIdx)
  const fraction = dotIdx === -1 ? '' : trimmed.slice(dotIdx + 1)
  const paddedFraction = fraction.padEnd(USDT_DECIMALS, '0').slice(0, USDT_DECIMALS)
  return BigInt(whole || '0') * BigInt(10 ** USDT_DECIMALS) + BigInt(paddedFraction || '0')
}

/** Format raw on-chain USDT units into a human-readable string. */
export function formatUsdtAmount(raw: bigint): string {
  const divisor  = BigInt(10 ** USDT_DECIMALS)
  const whole    = raw / divisor
  const fraction = raw % divisor
  return `${whole}.${fraction.toString().padStart(USDT_DECIMALS, '0')}`
}

/**
 * Build a single ERC-20 transfer() call targeting one USDT recipient.
 * The call is executed *from* the user's EOA via EIP-7702's executeBatch,
 * so no `transferFrom` approval is needed — the EOA itself is the sender.
 */
export function buildUsdtTransferCall(
  usdtAddress: `0x${string}`,
  recipient:   `0x${string}`,
  rawAmount:   bigint,
): BatchCall {
  return {
    target: usdtAddress,
    value:  0n,
    data:   encodeFunctionData({
      abi:          parseAbi(['function transfer(address to, uint256 amount) returns (bool)']),
      functionName: 'transfer',
      args:         [recipient, rawAmount],
    }),
  }
}

/**
 * Parse a CSV string (one `address,amount` pair per line) into UsdtRecipient[].
 * Lines starting with `#` are treated as comments and skipped.
 * Only the first comma on each line is used as the delimiter.
 */
export function parseCsvRecipients(csv: string): UsdtRecipient[] {
  return csv
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const commaIdx = line.indexOf(',')
      if (commaIdx === -1) return null
      const address = line.slice(0, commaIdx).trim()
      const amount  = line.slice(commaIdx + 1).trim()
      // Reject extra commas (malformed lines like "0x…,100,extra")
      if (amount.includes(',')) return null
      return { address: address as `0x${string}`, amount }
    })
    .filter((r): r is UsdtRecipient =>
      r !== null &&
      isAddress(r.address) &&
      /^\d+(\.\d*)?$/.test(r.amount) &&
      parseFloat(r.amount) > 0
    )
}

/** Sum all recipient amounts into a single raw bigint for balance checks. */
export function totalUsdtRaw(recipients: UsdtRecipient[]): bigint {
  return recipients.reduce((sum, r) => sum + parseUsdtAmount(r.amount), 0n)
}
