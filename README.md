# EIP-7702 Executor

Self-custodial batch execution via EIP-7702 delegation. Users sign an exact intent (which calls to run, which tokens to sweep, destination, max fee, deadline); a relayer submits the Type-4 transaction. The user's EOA temporarily becomes the executor for exactly one transaction, then the delegation is atomically revoked.

---

## How It Works

```
1. User signs EIP-7702 authorization  →  delegate EOA → EIP7702Executor
2. User signs EIP-712 BatchIntent     →  exact calls + tokens + destination + fee
3. Relayer submits Type-4 tx          →  with authorizationList (delegate + revoke)
4. EVM runs executeBatch()            →  address(this) == user's EOA
5. Protocol calls run as user's wallet, rewards land directly in their EOA
6. ERC-20 tokens swept to destination
7. Native balance minus fee swept to destination
8. Delegation revoked atomically (second auth sets code → zero address)
```

---

## Quick Start

### Step 1 — Deploy the Contract

```bash
cd executor
cp .env.example .env
# Fill in: RELAYER_ADDRESS (the relayer's wallet), PRIVATE_KEY (deployer), SEPOLIA_RPC_URL

forge install                    # install dependencies
forge build                      # compile
forge test -vvv                  # run tests

# Deploy to Sepolia
forge script script/DeployTestnet.s.sol \
  --rpc-url $SEPOLIA_RPC_URL \
  --broadcast --verify -vvvv
```

Copy the deployed contract address from the output.

---

### Step 2 — Start the Relayer

```bash
cd relayer
npm install
cp .env.example .env
# Fill in: RELAYER_PRIVATE_KEY (must match RELAYER_ADDRESS used in Step 1)
# Optionally add RPC URLs for each chain

npm run dev        # development (hot reload)
# npm start        # production
```

The relayer starts on `http://localhost:3001`. Verify:

```bash
curl http://localhost:3001/health
# {"status":"ok","relayerAddress":"0x..."}
```

---

### Step 3 — Start the Frontend

```bash
# In the repo root
npm install
cp .env.example .env.local
# Fill in:
#   NEXT_PUBLIC_EXECUTOR_ADDRESS=<address from Step 1>
#   NEXT_PUBLIC_RELAYER_ENDPOINT=http://localhost:3001

npm run dev
```

Open [http://localhost:3000](http://localhost:3000), connect MetaMask or Rabby, and execute!

---

## Project Structure

```
eip7702-executor/
├── executor/                        # Solidity smart contract (Foundry)
│   ├── src/EIP7702Executor.sol      # Core executor (205 lines)
│   ├── test/EIP7702Executor.t.sol   # Foundry tests
│   └── script/Deploy*.s.sol        # Deployment scripts
│
├── src/                             # TypeScript utilities
│   ├── services/batch-executor.ts   # EIP-712 signing, EIP-7702 auth, call builders
│   └── hooks/useBatchExecutor.ts    # React hook orchestrating the full flow
│
├── app/                             # Next.js frontend (App Router)
│   ├── layout.tsx
│   ├── providers.tsx                # wagmi + react-query
│   └── page.tsx                     # Full UI
│
└── relayer/                         # Node.js HTTP relay server
    └── src/index.ts                 # POST /execute + GET /health
```

---

## Wallet Support

The hook tries three methods in order, falling back automatically:

| Method | Wallet |
|--------|--------|
| `wallet_signBatchAuthorization` | Modern MetaMask / Rabby (batch) |
| `wallet_signAuthorization` | Rabby, newer MetaMask |
| `eth_sign` (manual RLP hash) | Any EIP-1193 wallet |

---

## Supported Chains

Ethereum · Sepolia · Base · Base Sepolia · Arbitrum · Optimism · Polygon

---

## Security

- The user signs the **exact** calls, tokens, destination, fee, and deadline — the relayer cannot modify any field.
- The contract verifies the EIP-712 signature on-chain; the relayer also pre-validates before spending gas.
- Nonces prevent replay: `usedNonces[user][nonce]` is set after execution.
- Delegation is revoked atomically in the same Type-4 tx (second auth sets code → zero address).
- Protected by `ReentrancyGuard` and `SafeERC20`.