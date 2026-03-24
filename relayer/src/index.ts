import 'dotenv/config'
import express from 'express'
import cors from 'cors'
import { rateLimit } from 'express-rate-limit'
import {
  createWalletClient,
  http,
  encodeFunctionData,
  verifyTypedData,
  keccak256,
  encodeAbiParameters,
  parseAbiParameters,
  concat,
  pad,
  type Chain,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import {
  mainnet, sepolia, base, baseSepolia,
  arbitrum, optimism, polygon,
} from 'viem/chains'

/* ─── env ─────────────────────────────────────────────────────────────────── */
const RELAYER_PRIVATE_KEY = process.env.RELAYER_PRIVATE_KEY as `0x${string}`
const PORT = Number(process.env.PORT ?? 3001)

if (!RELAYER_PRIVATE_KEY || RELAYER_PRIVATE_KEY === '0x') {
  console.error('RELAYER_PRIVATE_KEY is required in .env')
  process.exit(1)
}

/* ─── chain map ─────────────────────────────────────────────────────────── */
const CHAIN_MAP: Record<number, { chain: Chain; rpcUrl?: string }> = {
  1:        { chain: mainnet,    rpcUrl: process.env.MAINNET_RPC_URL },
  11155111: { chain: sepolia,    rpcUrl: process.env.SEPOLIA_RPC_URL },
  8453:     { chain: base,       rpcUrl: process.env.BASE_RPC_URL },
  84532:    { chain: baseSepolia,rpcUrl: process.env.BASE_SEPOLIA_RPC_URL },
  42161:    { chain: arbitrum,   rpcUrl: process.env.ARBITRUM_RPC_URL },
  10:       { chain: optimism,   rpcUrl: process.env.OPTIMISM_RPC_URL },
  137:      { chain: polygon,    rpcUrl: process.env.POLYGON_RPC_URL },
}

/* ─── ABI for executeBatch(BatchIntent,bytes) ────────────────────────────── */
const EXECUTOR_ABI = [
  {
    name: 'executeBatch',
    type: 'function',
    stateMutability: 'payable',
    inputs: [
      {
        name: 'intent',
        type: 'tuple',
        components: [
          { name: 'user',        type: 'address'   },
          { name: 'calls',       type: 'tuple[]',  components: [
            { name: 'target', type: 'address' },
            { name: 'value',  type: 'uint256' },
            { name: 'data',   type: 'bytes'   },
          ]},
          { name: 'sweepTokens', type: 'address[]' },
          { name: 'sweepNative', type: 'bool'      },
          { name: 'destination', type: 'address'   },
          { name: 'maxFeeWei',   type: 'uint256'   },
          { name: 'deadline',    type: 'uint256'   },
          { name: 'nonce',       type: 'uint256'   },
        ],
      },
      { name: 'sig', type: 'bytes' },
    ],
    outputs: [],
  },
] as const

/* ─── EIP-712 types (must match batch-executor.ts + Solidity) ──────────── */
const BATCH_INTENT_TYPES = {
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

/* ─── hash helpers (must match batch-executor.ts + Solidity) ───────────── */
function hashCalls(calls: { target: string; value: bigint; data: string }[]): `0x${string}` {
  if (calls.length === 0) return keccak256('0x')
  const hashes = calls.map(c =>
    keccak256(encodeAbiParameters(
      parseAbiParameters('address, uint256, bytes32'),
      [c.target as `0x${string}`, c.value, keccak256(c.data as `0x${string}`)]
    ))
  )
  return keccak256(concat(hashes))
}

function hashTokens(tokens: string[]): `0x${string}` {
  if (tokens.length === 0) return keccak256('0x')
  return keccak256(concat(tokens.map(t => pad(t as `0x${string}`, { size: 20 }))))
}

/* ─── Express app ──────────────────────────────────────────────────────── */
const app = express()
app.use(cors())
app.use(express.json())

// Rate-limit the /execute endpoint: max 10 requests per minute per IP.
// This prevents abuse and protects the relayer wallet's ETH balance from drain attacks.
const executeLimiter = rateLimit({
  windowMs:         60 * 1000, // 1 minute
  max:              10,
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          { error: 'Too many requests — please wait a minute and try again.' },
})

app.get('/health', (_req, res) => {
  const account = privateKeyToAccount(RELAYER_PRIVATE_KEY)
  res.json({ status: 'ok', relayerAddress: account.address })
})

app.post('/execute', executeLimiter, async (req, res) => {
  const { chainId, intent, signature, eip7702Authorization, revokeAuthorization } = req.body

  /* ── validate input presence ── */
  if (!intent || !signature || !eip7702Authorization || !revokeAuthorization) {
    res.status(400).json({ error: 'Missing required fields: intent, signature, eip7702Authorization, revokeAuthorization' })
    return
  }

  /* ── resolve chain — prefer explicit chainId body field; fall back to auth ── */
  const targetChainId = chainId != null ? Number(chainId) : Number(eip7702Authorization.chainId)
  if (!targetChainId) {
    res.status(400).json({ error: 'chainId is required (pass it in the request body or ensure eip7702Authorization.chainId is set)' })
    return
  }
  const chainConfig   = CHAIN_MAP[targetChainId]
  if (!chainConfig) {
    res.status(400).json({ error: `Unsupported chainId: ${targetChainId}` })
    return
  }

  try {
    /* ── parse intent (bigints were serialised as strings) ── */
    const parsedIntent = {
      user:        intent.user                as `0x${string}`,
      calls:       (intent.calls ?? []).map((c: { target: string; value: string; data: string }) => ({
        target: c.target as `0x${string}`,
        value:  BigInt(c.value),
        data:   c.data   as `0x${string}`,
      })),
      sweepTokens: (intent.sweepTokens ?? []) as `0x${string}`[],
      sweepNative: Boolean(intent.sweepNative),
      destination: intent.destination         as `0x${string}`,
      maxFeeWei:   BigInt(intent.maxFeeWei),
      deadline:    BigInt(intent.deadline),
      nonce:       BigInt(intent.nonce),
    }

    /* ── verify BatchIntent EIP-712 signature ── */
    const signatureValid = await verifyTypedData({
      address:     parsedIntent.user,
      domain: {
        name:              'EIP7702Executor',
        version:           '1',
        chainId:           targetChainId,
        verifyingContract: parsedIntent.user, // EOA is the verifying contract in EIP-7702
      },
      types:       BATCH_INTENT_TYPES,
      primaryType: 'BatchIntent',
      message: {
        user:        parsedIntent.user,
        destination: parsedIntent.destination,
        callsHash:   hashCalls(parsedIntent.calls),
        tokensHash:  hashTokens(parsedIntent.sweepTokens),
        sweepNative: parsedIntent.sweepNative,
        maxFeeWei:   parsedIntent.maxFeeWei,
        deadline:    parsedIntent.deadline,
        nonce:       parsedIntent.nonce,
      },
      signature: signature as `0x${string}`,
    })

    if (!signatureValid) {
      res.status(400).json({ error: 'Invalid BatchIntent signature' })
      return
    }

    /* ── check deadline ── */
    if (BigInt(Math.floor(Date.now() / 1000)) > parsedIntent.deadline) {
      res.status(400).json({ error: 'BatchIntent deadline has expired' })
      return
    }

    /* ── build wallet client ── */
    const account      = privateKeyToAccount(RELAYER_PRIVATE_KEY)
    const walletClient = createWalletClient({
      account,
      chain:     chainConfig.chain,
      transport: http(chainConfig.rpcUrl || undefined),
    })

    /* ── build authorizationList ── */
    const authorizationList = [
      {
        address:  eip7702Authorization.contractAddress as `0x${string}`,
        chainId:  Number(eip7702Authorization.chainId),
        nonce:    Number(eip7702Authorization.nonce),
        r:        eip7702Authorization.r        as `0x${string}`,
        s:        eip7702Authorization.s        as `0x${string}`,
        yParity:  Number(eip7702Authorization.yParity) as 0 | 1,
      },
      {
        address:  revokeAuthorization.contractAddress as `0x${string}`,
        chainId:  Number(revokeAuthorization.chainId),
        nonce:    Number(revokeAuthorization.nonce),
        r:        revokeAuthorization.r         as `0x${string}`,
        s:        revokeAuthorization.s         as `0x${string}`,
        yParity:  Number(revokeAuthorization.yParity) as 0 | 1,
      },
    ] as const

    /* ── send the EIP-7702 Type-4 transaction ── */
    const txHash = await walletClient.sendTransaction({
      to:   parsedIntent.user,   // user's EOA now has executor code via EIP-7702
      data: encodeFunctionData({
        abi:          EXECUTOR_ABI,
        functionName: 'executeBatch',
        args:         [parsedIntent, signature as `0x${string}`],
      }),
      value:             0n,
      authorizationList,
    })

    console.log(`[execute] chain=${targetChainId} user=${parsedIntent.user} tx=${txHash}`)
    res.json({ txHash })

  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[execute] error:', msg)
    res.status(500).json({ error: msg })
  }
})

app.listen(PORT, () => {
  const account = privateKeyToAccount(RELAYER_PRIVATE_KEY)
  console.log(`EIP-7702 Relayer running on port ${PORT}`)
  console.log(`Relayer address: ${account.address}`)
  console.log(`Supported chains: ${Object.keys(CHAIN_MAP).join(', ')}`)
})
