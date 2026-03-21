# EIP-7702 Executor — Foundry

Solidity smart contracts for the EIP-7702 Executor system. When delegated, the executor runs with `address(this)` == the user's EOA for the full duration of the transaction.

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

## Prerequisites

- [Foundry](https://book.getfoundry.sh/getting-started/installation) — install with `curl -L https://foundry.paradigm.xyz | bash && foundryup`
- Git (for submodules)

> **Note for Copilot coding agent:** the sandbox must allow outbound access to `foundry.paradigm.xyz` and `binaries.soliditylang.org` to install Foundry and the Solidity compiler.

## Install

```bash
git submodule update --init --recursive
```

## Build

```bash
forge build
```

## Test

```bash
forge test -vvv
```

## Deploy — Testnet

```bash
forge script script/DeployTestnet.s.sol \
  --rpc-url $RPC_URL \
  --broadcast \
  --private-key $PRIVATE_KEY
```

## Deploy — Mainnet (deterministic CREATE2 address)

```bash
forge script script/Deploy.s.sol \
  --rpc-url $RPC_URL \
  --broadcast \
  --private-key $PRIVATE_KEY
```

## Transaction Flow

1. User signs EIP-7702 authorization (delegate EOA → executor contract)
2. User signs EIP-712 BatchIntent (exact calls + tokens + destination)
3. Relayer sends Type-4 tx with authorizationList to user's EOA
4. EVM runs `executeBatch()` with `address(this)` == user's EOA
5. Protocol calls execute as user's wallet
6. Tokens sweep to destination
7. Delegation revoked atomically

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
