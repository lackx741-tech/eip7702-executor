import {
  encodeFunctionData,
  parseAbi,
  keccak256,
  encodeAbiParameters,
  parseAbiParameters,
  concat,
  pad,
} from 'viem'
import { BrowserProvider } from 'ethers'

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
  const ethersProvider = new BrowserProvider((window as any).ethereum)
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
  const result = await (window.ethereum as any).request({
    method: 'wallet_signAuthorization',
    params: [{ from: userAddress, contractAddress, chainId, nonce }],
  })
  return {
    chainId:         typeof result.chainId === 'string' ? parseInt(result.chainId, 16) : result.chainId,
    contractAddress: result.address as `0x${string}`,
    nonce:           typeof result.nonce === 'string' ? parseInt(result.nonce, 16) : result.nonce,
    yParity:         typeof result.yParity === 'string' ? parseInt(result.yParity, 16) : result.yParity,
    r:               result.r as `0x${string}`,
    s:               result.s as `0x${string}`,
  }
}
