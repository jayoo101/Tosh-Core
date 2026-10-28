# ToshX v2

**A fair-launch protocol on PancakeSwap Infinity hooks: an Agent ID–gated GENESIS sale, a pool that opens at 2P, a 4,000-shelf ladder above it, and a buy-only bid market before launch.**

[![tests](https://github.com/jayoo101/Tosh-Core/actions/workflows/test.yml/badge.svg)](https://github.com/jayoo101/Tosh-Core/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

| | |
|---|---|
| Network | BNB Smart Chain `56`; rehearsals on testnet `97` |
| Quote assets | BNB (held as WBNB) or BSC USDT — one factory each, both 18 decimals |
| Site | [toshx.xyz](https://toshx.xyz) |
| Design | [`docs/TOSHX_V2_AGENTID_UPGRADE_zh.md`](docs/TOSHX_V2_AGENTID_UPGRADE_zh.md) |

**[Security policy](SECURITY.md)** · **[Frontend](soat-frontend/README.md)**

If this document and the source disagree, the source wins.

---

## Lifecycle

1. **Create.** A project applies through the site; after review, a signer of
   the platform Safe lists it with `createLaunch` through the factory's
   `ToshLaunchGateway`, setting the hard cap, the per-Agent-ID allowance and
   the GENESIS duration. The token and hook are EIP-1167 clones.
2. **GENESIS.** Only wallets holding a Binance Agent ID can buy, read on chain
   from the Agent ID registry — no off-chain signer. The price rises linearly
   with the amount sold. Every buy is final; there are no refunds. 20 % of each
   payment goes to the project fund and 80 % is held for the pool. Before
   launch the token only moves between registered ordinary wallets.
3. **Bid market.** Alongside GENESIS, `ToshBidBook` takes escrowed buy orders
   for the token. There are no asks; holders sell into bids. Fills carry a 1 %
   fee, and a bid that falls below 90 % of the latest GENESIS price stops being
   fillable.
4. **Launch.** After sell-out or the deadline, the Circuit NFT holder has 48
   hours to call `launch()`; after that anyone can. The pool opens at 2P with
   the held funds, its liquidity is locked permanently, and unsold GENESIS
   tokens are burned.
5. **Trading.** The pool trades freely with a 1 % swap tax. The shelf ladder
   sells fixed-price tranches above 2P as the price reaches them; shelf revenue
   goes to the Circuit NFT's vault and to buyback-and-burn through
   `ToshLadderTreasury`.

## Contracts

| Contract | Role |
|---|---|
| `ToshFactory` | Creates launches for one quote asset; owned by its `ToshLaunchGateway` |
| `ToshLaunchpadHook` | Per-launch Infinity hook: GENESIS sale, launch, swap tax, shelf ladder |
| `ToshToken` | The launched token, with the pre-launch transfer rule |
| `ToshBidBook` | Shared pre-launch bid market |
| `ToshLadderTreasury` | Buyback-and-burn reservoir; its only outbound path burns |
| `CircuitNFT` / `CircuitRevenueVault` | The project's control NFT and the vault its shelf revenue accrues to |
| `ToshHookLens` | Read-only aggregation for the frontend |
| `ToshLaunchGateway` | Factory owner on the Safe's behalf: any current Safe signer can list a project; every other owner action goes through the Safe |

`script/DeployV2.s.sol` deploys the bid book, the lens, and one factory,
treasury and gateway per quote asset, and writes the addresses to
`deployments/v2-<chainid>.json`. `scripts/v2SafeAccept.mjs` prepares the Safe
transactions that accept ownership afterwards.

## Build and test

```bash
forge build
forge test                      # unit, fuzz and invariant suites in test/v2
BSC_RPC=... forge test --match-contract 'ForkV2BscTest|ToshV5ForkInfinityTest'
```

The compiler settings and remappings in `foundry.toml` are part of each
contract's metadata, so changing them changes deployed bytecode; read the
comments there first. `scripts/precheck.ps1` runs the fast local checks, and CI
(`.github/workflows/test.yml`) runs those plus the Slither and Aderyn triage
gates described in [`docs/AUDIT.md`](docs/AUDIT.md).

## Documentation

| Document | What it covers |
|---|---|
| [`docs/TOSHX_V2_AGENTID_UPGRADE_zh.md`](docs/TOSHX_V2_AGENTID_UPGRADE_zh.md) | The v2 design: Agent ID access, the GENESIS curve, the bid book, launch and fund flows |
| [`docs/TOSHX_V2_FRONTEND_USER_zh.md`](docs/TOSHX_V2_FRONTEND_USER_zh.md) | The user-facing walkthrough |
| [`docs/TOSHX_V2_AGENTIC_WALLET_GUIDE_zh.md`](docs/TOSHX_V2_AGENTIC_WALLET_GUIDE_zh.md) | Using the app through an agentic wallet |
| [`docs/WHITEPAPER_zh.md`](docs/WHITEPAPER_zh.md) | Whitepaper |
| [`docs/PANCAKESWAP_INFINITY.md`](docs/PANCAKESWAP_INFINITY.md) | Why and how the hook runs on PancakeSwap Infinity |
| [`docs/AUDIT.md`](docs/AUDIT.md) | Static analysis baselines and dispositions |
| [`SECURITY.md`](SECURITY.md) | Reporting channel, scope, and verification anchors |

## License

MIT — see [LICENSE](LICENSE) and the SPDX headers in each source file.
