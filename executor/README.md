# EIP-7702 Executor

A complete smart contract executor for EIP-7702. When delegated, it behaves exactly like a smart contract wallet — `address(this)` IS the user's EOA for the duration of the transaction.

## How It Works

EIP-7702 (Ethereum Pectra upgrade) allows an EOA to temporarily set its code to point to a smart contract for a single transaction. This means:

- `address(this)` == user's EOA address
- Calling `farm.harvest(address(this))` sends rewards directly to the user's wallet
- `IERC20(token).balanceOf(address(this))` reads the user's actual balance
- No approvals, no proxies — the EOA literally IS the contract

## Capabilities

| Feature | Description |
|---|---|
| Native sweep | Sweep ETH/BNB/MATIC minus relayer fee |
| ERC-20 sweep | Transfer any token balance to destination |
| Harvest rewards | Call farm/staking contracts as the user's wallet |
| Collect LP fees | Uniswap V3 collect as the user's wallet |
| Batch calls | N protocol calls atomically |
| Self-custodial | User signs exact calls — relayer cannot change them |

## Transaction Flow

1. User signs EIP-7702 authorization (delegate EOA → executor contract)
2. User signs EIP-712 BatchIntent (exact calls + tokens + destination)
3. Relayer sends Type-4 tx with authorizationList to user's EOA
4. EVM runs executeBatch() with address(this) == user's EOA
5. Protocol calls execute as user's wallet
6. Tokens sweep to destination
7. Delegation revoked atomically

## Prerequisites

- [Foundry](https://book.getfoundry.sh/getting-started/installation)

## Setup

```bash
cd executor
forge install OpenZeppelin/openzeppelin-contracts
forge install foundry-rs/forge-std
forge build
forge test -vvv
```

## Deploy to Sepolia

```bash
cp .env.example .env
# Edit .env with your RELAYER_ADDRESS and PRIVATE_KEY

source .env
forge script script/Deploy.s.sol \
  --rpc-url $SEPOLIA_RPC_URL \
  --broadcast \
  --verify \
  -vvvv
```

## Deploy to All Chains (same address via CREATE2)

Run against each chain RPC. The CREATE2 salt ensures identical address on every chain:

```bash
# Base
forge script script/Deploy.s.sol --rpc-url $BASE_RPC_URL --broadcast --verify -vvvv

# Arbitrum
forge script script/Deploy.s.sol --rpc-url $ARBITRUM_RPC_URL --broadcast --verify -vvvv

# Optimism
forge script script/Deploy.s.sol --rpc-url $OPTIMISM_RPC_URL --broadcast --verify -vvvv
```

## After Deployment: Update Frontend

In your Next.js app:
```env
NEXT_PUBLIC_EXECUTOR_ADDRESS=0xYOUR_DEPLOYED_ADDRESS
NEXT_PUBLIC_RELAYER_ENDPOINT=https://your-relayer.com
```

## Security

- Only the trusted `relayer` address can call `executeBatch()`
- EIP-712 signatures commit to exact calls, tokens, destination, and fee
- Nonces prevent replay attacks
- Deadlines prevent stale signatures
- Delegation revoked atomically after execution

## Supported Protocols (examples)

- Any farm with `harvest(address to)`
- Any staking with `getReward()`
- Uniswap V3 `collect(CollectParams)`
- Generic `claim(address recipient)`
- Any protocol that sends funds to `msg.sender` or `address(this)`
