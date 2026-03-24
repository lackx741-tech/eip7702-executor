import {
  encodeFunctionData,
  parseAbi,
  keccak256,
  encodeAbiParameters,
  parseAbiParameters,
  concat,
  pad,
  toRlp,
} from 'viem'
import { BrowserProvider } from 'ethers'

/** Minimal EIP-1193 provider interface used by EIP-7702 wallets */
interface EIP1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>
}

declare global {
  interface Window {
    ethereum?: EIP1193Provider
  }
}

export interface BatchCall {
  target: `0x${string}`
  value:  bigint
  data:   `0x${string}`
}

export interface BatchIntentParams {
  user:         `0x${string}`
  calls:        BatchCall[]
  sweepTokens:  `0x${string}`[]
  sweepNative:  boolean
  destination:  `0x${string}`
  maxFeeWei:    bigint
  deadline:     bigint
  nonce:        bigint
}

export const BATCH_INTENT_TYPES = {
  BatchIntent: [
    { name: 'user',        type: 'address' },
    { name: 'destination', type: 'address' },
    { name: 'callsHash',   type: 'bytes32' },
    { name: 'tokensHash',  type: 'bytes32' },
    { name: 'sweepNative', type: 'bool'    },
    { name: 'maxFeeWei',   type: 'uint256' },
    { name: 'deadline',    type: 'uint256' },
    { name: 'nonce',       type: 'uint256' },
  ],
} as const

/** Harvest rewards from a generic farm contract */
export function buildHarvestCall(farmContract: `0x${string}`, userAddress: `0x${string}`): BatchCall {
  return {
    target: farmContract,
    value:  0n,
    data:   encodeFunctionData({
      abi: parseAbi(['function harvest(address to)']),
      functionName: 'harvest',
      args: [userAddress],
    }),
  }
}

/** Synthetix-style staking getReward() */
export function buildGetRewardCall(stakingContract: `0x${string}`): BatchCall {
  return {
    target: stakingContract,
    value:  0n,
    data:   encodeFunctionData({
      abi: parseAbi(['function getReward()']),
      functionName: 'getReward',
    }),
  }
}

/** Uniswap V3 collect LP fees */
export function buildUniV3CollectCall(
  positionManager: `0x${string}`,
  tokenId:         bigint,
  recipient:       `0x${string}`
): BatchCall {
  return {
    target: positionManager,
    value:  0n,
    data:   encodeFunctionData({
      abi: parseAbi([
        'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) returns (uint256, uint256)'
      ]),
      functionName: 'collect',
      args: [{ tokenId, recipient, amount0Max: 2n ** 128n - 1n, amount1Max: 2n ** 128n - 1n }],
    }),
  }
}

/** Generic claim(address recipient) */
export function buildClaimCall(rewardContract: `0x${string}`, recipient: `0x${string}`): BatchCall {
  return {
    target: rewardContract,
    value:  0n,
    data:   encodeFunctionData({
      abi: parseAbi(['function claim(address recipient)']),
      functionName: 'claim',
      args: [recipient],
    }),
  }
}

/** Hash calls array — must match Solidity _hashCalls() */
export function hashCalls(calls: BatchCall[]): `0x${string}` {
  if (calls.length === 0) return keccak256('0x')
  const hashes = calls.map(c =>
    keccak256(encodeAbiParameters(
      parseAbiParameters('address, uint256, bytes32'),
      [c.target, c.value, keccak256(c.data)]
    ))
  )
  return keccak256(concat(hashes))
}

/** Hash sweep tokens array — must match Solidity abi.encodePacked() */
export function hashTokens(tokens: `0x${string}`[]): `0x${string}` {
  if (tokens.length === 0) return keccak256('0x')
  return keccak256(concat(tokens.map(t => pad(t, { size: 20 }))))
}

/**
 * Sign a BatchIntent using ethers.js.
 * Uses ethers.js instead of viem because viem 2.44+ blocks EOA as verifyingContract.
 * In EIP-7702, user's EOA IS the verifyingContract — this is correct and intentional.
 */
export async function signBatchIntent(intent: BatchIntentParams, chainId: number): Promise<`0x${string}`> {
  const ethersProvider = new BrowserProvider(window.ethereum as Parameters<typeof BrowserProvider>[0])
  const signer = await ethersProvider.getSigner()

  const sig = await signer.signTypedData(
    {
      name: 'EIP7702Executor',
      version: '1',
      chainId,
      verifyingContract: intent.user,
    },
    { BatchIntent: [...BATCH_INTENT_TYPES.BatchIntent] },
    {
      user:        intent.user,
      destination: intent.destination,
      callsHash:   hashCalls(intent.calls),
      tokensHash:  hashTokens(intent.sweepTokens),
      sweepNative: intent.sweepNative,
      maxFeeWei:   intent.maxFeeWei,
      deadline:    intent.deadline,
      nonce:       intent.nonce,
    }
  )

  return sig as `0x${string}`
}

/** Sign EIP-7702 authorization to delegate EOA to executor contract */
export async function signEIP7702Authorization(
  userAddress:     `0x${string}`,
  contractAddress: `0x${string}`,
  chainId:         number,
  nonce:           number
) {
  const result = await window.ethereum!.request({
    method: 'wallet_signAuthorization',
    params: [{ from: userAddress, contractAddress, chainId, nonce }],
  }) as Record<string, unknown>
  return {
    chainId:         typeof result.chainId === 'string' ? parseInt(result.chainId, 16) : result.chainId,
    contractAddress: result.address as `0x${string}`,
    nonce:           typeof result.nonce === 'string' ? parseInt(result.nonce, 16) : result.nonce,
    yParity:         typeof result.yParity === 'string' ? parseInt(result.yParity, 16) : result.yParity,
    r:               result.r as `0x${string}`,
    s:               result.s as `0x${string}`,
  }
}

/**
 * Fallback: sign an EIP-7702 authorization for wallets that do NOT support the
 * `wallet_signAuthorization` RPC method (e.g. MetaMask without native EIP-7702 support).
 *
 * EIP-7702 authorization signing hash:
 *   keccak256(0x05 || rlp([chainId, contractAddress, nonce]))
 *
 * We obtain the raw signature via `eth_sign`, which signs a bare 32-byte hash
 * without any additional prefix — unlike `personal_sign` which would corrupt the hash.
 * MetaMask and every EIP-1193 wallet support `eth_sign` even when they lack
 * dedicated EIP-7702 signing methods.
 */
export async function signEIP7702AuthorizationFallback(
  userAddress:     `0x${string}`,
  contractAddress: `0x${string}`,
  chainId:         number,
  nonce:           number
) {
  // RLP integers must use minimal big-endian encoding (no leading zeros); 0 → empty bytes.
  const toRlpInt = (n: number): `0x${string}` => {
    if (n === 0) return '0x'
    const hex = n.toString(16)
    return `0x${hex.length % 2 === 0 ? hex : `0${hex}`}` as `0x${string}`
  }

  // Build the EIP-7702 payload: 0x05 magic byte followed by RLP([chainId, address, nonce])
  const rlpPayload  = toRlp([toRlpInt(chainId), contractAddress, toRlpInt(nonce)])
  const signingHash = keccak256(concat(['0x05', rlpPayload]))

  // eth_sign: raw hash signing — the wallet signs exactly the 32-byte hash provided.
  let rawSig: `0x${string}`
  try {
    rawSig = await window.ethereum!.request({
      method: 'eth_sign',
      params: [userAddress, signingHash],
    }) as `0x${string}`
  } catch (err: any) {
    throw new Error(`Failed to sign EIP-7702 authorization via eth_sign: ${err?.message ?? err}`)
  }

  // Compact signature layout: r (32 bytes) || s (32 bytes) || v (1 byte)
  // Byte offsets within the hex string (each byte = 2 hex chars, plus "0x" prefix of 2):
  const HEX_PREFIX   = 2   // length of "0x"
  const BYTES_R      = 32  // r occupies bytes 0–31  → chars HEX_PREFIX to HEX_PREFIX + 64
  const BYTES_S      = 32  // s occupies bytes 32–63 → chars HEX_PREFIX + 64 to HEX_PREFIX + 128
  const R_START      = HEX_PREFIX
  const R_END        = R_START + BYTES_R * 2
  const S_END        = R_END   + BYTES_S * 2
  const r       = `0x${rawSig.slice(R_START, R_END)}`  as `0x${string}`
  const s       = `0x${rawSig.slice(R_END,   S_END)}`  as `0x${string}`
  const v       = parseInt(rawSig.slice(S_END, S_END + 2), 16)
  const yParity = v >= 27 ? v - 27 : v   // normalise legacy v (27/28 → 0/1)

  return { chainId, contractAddress, nonce, yParity, r, s }
}
