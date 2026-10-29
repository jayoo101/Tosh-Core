# ToshX v3

**A fair-launch protocol on PancakeSwap Infinity hooks: an Agent ID–gated GENESIS sale, a pool that opens at 2P, a 10,000-shelf ladder above it whose revenue is mostly added back to the pool, and a buy-only bid market before launch.**

[![tests](https://github.com/jayoo101/Tosh-Core/actions/workflows/test.yml/badge.svg)](https://github.com/jayoo101/Tosh-Core/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

| | |
|---|---|
| Network | BNB Smart Chain `56`; v3 deployed 2026-10-29 at block 130,426,789 |
| Quote assets | BNB (held as WBNB) or BSC USDT — one factory each, both 18 decimals |
| Supply | 2.1 billion per project: 180M sold in GENESIS, 90M opening the pool, 1.83B on the ladder |
| Site | [toshx.xyz](https://toshx.xyz) |
| Whitepaper | [`docs/WHITEPAPER_zh.md`](docs/WHITEPAPER_zh.md) |
| Addresses | [`deployments/v3-56.json`](deployments/v3-56.json) — source verified on Sourcify (exact match) and BscScan |

**[Security policy](SECURITY.md)** · **[Frontend](soat-frontend/README.md)**

If this document and the source disagree, the source wins.

---

## Lifecycle

1. **Create.** A project applies through the site; after review, a signer of
   the platform Safe lists it with `createLaunch` through the factory's
   `ToshLaunchGateway`, setting the hard cap H, the per-Agent-ID allowance and
   the GENESIS duration (3, 24 or 72 hours). The token and hook are EIP-1167
   clones. There is no launch fee.
2. **GENESIS.** Only wallets holding a Binance Agent ID can buy, read on chain
   from the Agent ID registry — no off-chain signer. Up to 180,000,000 tokens
   are sold on a linear curve from P = H ÷ 225,000,000 to 1.5P, so a sell-out
   raises exactly H. Every buy is final; there are no refunds. 20 % of each
   payment goes to the project fund and 80 % is held for the pool. Before
   launch the token only moves between registered ordinary wallets.
3. **Bid market.** Alongside GENESIS, `ToshBidBook` takes escrowed buy orders
   for the token. There are no asks; holders sell into bids. Buyer and seller
   each pay a 1 % fee on fills, and a bid that falls below 90 % of the latest
   GENESIS price stops being fillable.
4. **Launch.** After sell-out or the deadline, the Circuit NFT holder has 48
   hours to call `launch()`; after that anyone can. The pool opens at 2P with
   the held funds and `0.8 × raised ÷ 2P` tokens (90,000,000 on a sell-out),
   its liquidity is locked permanently, and unsold GENESIS tokens are burned.
5. **Trading.** Buys pay a 1 % tax — 0.60 % to the project's Circuit vault,
   0.40 % to buyback-and-burn through `ToshLadderTreasury` — and sells pay a
   1 % tax that is burned. The pool fee is 0.20 %.
6. **Ladder.** 10,000 fixed-price shelves start at 2P and rise about 0.346 %
   each (×10¹⁵ end to end), each 183,000 × raised ÷ H tokens. A shelf is for
   sale only once the price reference — the lower of spot and the 30-minute
   TWAP — has reached it, and only to Agent ID holders, within a lifetime
   allowance per ID per project. Shelf revenue splits 80 % to `ToshAutoLp`,
   which buys the token and adds both sides to the project's pool as
   permanent liquidity, 19 % to the Circuit vault and 1 % to the treasury.

## Contracts

v3 lives in `src/v3/`; the contracts it shares with v2 are in `src/`.

| Contract | Role |
|---|---|
| `ToshFactoryV3` | Creates launches for one quote asset; owned by its `ToshLaunchGateway`; tracks shelf spend per Agent ID |
| `ToshLaunchpadHookV3` | Per-launch Infinity hook: GENESIS sale, launch, swap tax, shelf ladder, TWAP |
| `ToshTokenV3` | The launched token (`MAX_SUPPLY` 2.1B), with the pre-launch transfer rule |
| `ToshAutoLp` | One per quote asset, no owner: turns 80 % of shelf revenue into locked pool liquidity, deferring when the price cannot be trusted |
| `ToshHookLensV3` | Read-only aggregation for the frontend, including shelf quotes |
| `ToshBidBook` | Shared pre-launch bid market; no owner |
| `ToshLadderTreasury` | Buyback-and-burn reservoir; its only outbound path burns |
| `CircuitNFT` / `CircuitRevenueVault` | The project's control NFT and the vault its revenue accrues to |
| `ToshLaunchGateway` | Factory owner on the Safe's behalf: any current Safe signer can list a project; every other owner action goes through the Safe |

`script/DeployV3.s.sol` deploys the bid book, the lens, and one factory,
treasury, `ToshAutoLp` and gateway per quote asset, and writes the addresses to
`deployments/v3-<chainid>.json`. `scripts/v2SafeAccept.mjs <chainid> --v3 --handoff`
prepares the Safe batch that accepts ownership afterwards. On `56` the
treasuries are owned by the 2-of-3 Safe `0x02DE4629129D104C63329D13A6Ca67E43db7B310`
and each factory by its gateway.

v2 (`src/`, `script/DeployV2.s.sol`, `deployments/v2-56.json`) is still deployed
but lists no new projects and never listed one. v1 is in git history up to
commit `7cebff2e`.

## Build and test

```bash
forge build
forge test                      # unit, fuzz and invariant suites in test/v2 and test/v3
BSC_RPC=... forge test --match-contract 'ForkV2BscTest|ForkV3BscTest|ToshV5ForkInfinityTest'
```

The compiler settings and remappings in `foundry.toml` are part of each
contract's metadata, so changing them changes deployed bytecode; read the
comments there first. `scripts/precheck.ps1` runs the fast local checks, and CI
(`.github/workflows/test.yml`) runs those plus the Slither and Aderyn triage
gates described in [`docs/AUDIT.md`](docs/AUDIT.md).

## Documentation

| Document | What it covers |
|---|---|
| [`docs/WHITEPAPER_zh.md`](docs/WHITEPAPER_zh.md) | Whitepaper (v8.0, protocol v3): every mechanism, parameter and address |
| [`docs/V3_LADDER_AUTOLP_DESIGN_zh.md`](docs/V3_LADDER_AUTOLP_DESIGN_zh.md) | The v3 design: supply, the 10,000-shelf ladder, the Agent ID shelf gate, `ToshAutoLp` |
| [`docs/TOSHX_V2_AGENTID_UPGRADE_zh.md`](docs/TOSHX_V2_AGENTID_UPGRADE_zh.md) | The v2 design v3 builds on: Agent ID access, the GENESIS curve, the bid book, launch and fund flows |
| [`docs/TOSHX_V2_AGENTIC_WALLET_GUIDE_zh.md`](docs/TOSHX_V2_AGENTIC_WALLET_GUIDE_zh.md) | Using the app through a Binance Agentic Wallet |
| [`docs/TOSHX_V2_FRONTEND_USER_zh.md`](docs/TOSHX_V2_FRONTEND_USER_zh.md) | The user-facing frontend design |
| [`docs/PANCAKESWAP_INFINITY.md`](docs/PANCAKESWAP_INFINITY.md) | Why and how the hook runs on PancakeSwap Infinity |
| [`docs/AUDIT.md`](docs/AUDIT.md) | Static analysis baselines and dispositions |
| [`SECURITY.md`](SECURITY.md) | Reporting channel, scope, and verification anchors |

## License

MIT — see [LICENSE](LICENSE) and the SPDX headers in each source file.
