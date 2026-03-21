# EIP-7702 Executor

A complete EIP-7702 executor system that lets an EOA temporarily behave as a smart contract wallet for a single transaction. `address(this)` **IS** the user's EOA — no proxies, no approvals.

## Repo Structure

```
eip7702-executor/
├── executor/          # Solidity smart contracts (Foundry)
│   ├── src/           # EIP7702Executor.sol
│   ├── test/          # Foundry tests
│   └── script/        # Deploy scripts
└── src/               # TypeScript frontend
    ├── services/      # batch-executor.ts — call builders & signing helpers
    └── hooks/         # useBatchExecutor.ts — React hook
```

See [`executor/README.md`](executor/README.md) for full Foundry setup and deploy instructions.

## Quick Start — TypeScript Frontend

```bash
npm install
npm run build       # compile TypeScript → dist/
npm run dev         # watch mode with tsx
npm run typecheck   # type-check without emitting
```

## Quick Start — Solidity / Foundry

```bash
git submodule update --init --recursive
cd executor
forge build
forge test -vvv
```