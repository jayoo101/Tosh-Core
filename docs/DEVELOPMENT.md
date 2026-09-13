# Development guide

How to build, test, deploy and operate this repository. For what the protocol
*is* and why it is built this way, read the [README](../README.md).

**[README / protocol spec](../README.md)** · **[toshx.xyz](https://toshx.xyz)** ·
**[Security policy](../SECURITY.md)**

| | |
|---|---|
| Network | Robinhood Chain — chain `4663` (Arbitrum Orbit L2, ETH-denominated gas) |
| Factory | [`0x2920ca7E9fcD85491D699e1f9Ae2CAa65Cfb2892`](https://explorer.mainnet.chain.robinhood.com/address/0x2920ca7E9fcD85491D699e1f9Ae2CAa65Cfb2892) |
| Treasury | [`0x255722226720914eF5B2CD54647f21f584BD4Ea2`](https://explorer.mainnet.chain.robinhood.com/address/0x255722226720914eF5B2CD54647f21f584BD4Ea2) |
| Governance | 2-of-3 Gnosis Safe, `Ownable2Step` on both singletons |
| Supply per project | 21,000,000 hard cap, enforced on every mint |
| Trader friction | 1.30% total — 0.30% to LPs, 0.70% buy-and-burn, 0.30% platform |
| Verification | Sourcify + Blockscout, independently, on all five contracts |
| Tests | 373 across 15 suites, including stateful invariants and adversarial probes |
| Toolchain | Foundry · Next.js + wagmi + viem · Node |

> There is no platform token. Launch fees, genesis deposits and shelf purchases
> are all native ETH. Notes mentioning `MockSATO`, `harvestAndBurn`, graduation
> or the `0x2200` hook mask describe v3.4/v4.x and no longer apply.

---

## What the protocol guarantees

These are structural properties, not policies — each one is a consequence of
code that exists or code that is absent, and each is checkable from chain.

**Depositors always have a way out.** If the soft cap is missed, or if the
creator never calls `launch()` within the 7-day `LAUNCH_WINDOW`, every depositor
reclaims 100% of their ETH with no penalty. "Raised the money and vanished" is
not a state that can trap funds.

**The pool opens above what depositors paid.** The 55/45 split of genesis supply
makes the opening price exactly 1.10× the depositors' average cost, and shelf 0
sits a further 5% above that. This is arithmetic, not a target price — a test
pins the identity, so changing the split or the referral rate fails the suite
rather than quietly shipping a different premium.

**Nobody holds a pre-mine.** `launch()` mints only the 8.4M genesis block. The
remaining 12.6M is minted shelf by shelf as it sells.

**Genesis liquidity cannot be withdrawn — by anyone.** V4 keys positions to
their creator; the genesis position belongs to the hook, and the hook has no
code path that removes liquidity. The lock comes from ownership plus absence,
not from a callback that could be edited. Third-party LPs use their own
positions and come and go freely.

**The treasury cannot be drained.** `ToshLadderTreasury` has no `withdraw`, no
`sweep`, no `rescue` and no `delegatecall`. Its only outbound path buys on a
Tosh pool and sends the tokens to `0xdead`. The owner chooses which tokens are
in the buyback rotation; the owner cannot choose where the ETH goes.

**Contracts are not upgradeable.** `ToshToken` never grants
`DEFAULT_ADMIN_ROLE`, so `MINTER_ROLE` is frozen on the project's hook forever.
No proxy, no `migrateMinter`. Unsold ladder supply can never be re-minted
somewhere else.

**Phase 2 cannot be minted down into the pool.** Three independent gates: a mint
may not share a block with a swap, the reference price is `min(spot, TWAP)`, and
a shelf only unlocks within 105% of that reference. `launch()` arms the
same-block lock itself, so the launch block is shut deterministically rather
than by boundary arithmetic.

---

## Economics

### Supply

| Bucket | Constant | Amount | Share |
|---|---|---|---|
| Hard cap | `MAX_SUPPLY` | 21,000,000 | 100% |
| Genesis | `GENESIS_SUPPLY` | 8,400,000 | 40% |
| ├ claimed pro rata by depositors | `GENESIS_CLAIM_SUPPLY` | 4,620,000 | 55% of genesis |
| └ seeded full-range into the pool | `GENESIS_LP_SUPPLY` | 3,780,000 | 45% of genesis |
| Shelf ladder | `BONDING_MAX` | 12,600,000 | 60% |

8,400,000 + 12,600,000 = 21,000,000. A fully sold ladder lands exactly on the
cap rather than approaching it.

### Pricing

```
p0      = lpEth / GENESIS_LP_SUPPLY          pool opening price
shelfP0 = p0 × 1.05                          first shelf
shelf i = shelfP0 × TIER_STEP^i              4000 shelves, +0.19025% each, 2000× end to end
```

`TIER_STEP_E18 = 1_001_902_508_266_805_824`, chosen so the last shelf is exactly
2000× the first. Prices are evaluated in closed form by fast exponentiation, not
by 4000 successive multiplications, so there is no accumulated truncation drift.

A shelf unlocks only when `shelfP0 × STEP^i ≤ min(spot, TWAP) × 1.05`.
`SHELF_PREMIUM_BPS` and `PRICE_CEILING_BPS` are deliberately the same `10500`,
so the two 1.05 factors cancel and the condition carries no magic number.

### Fees

| Fee | Rate | Destination |
|---|---|---|
| Launch fee | `launchFee()` — currently **0.01 ETH** | `ladderTreasury` (buyback fuel) |
| Shelf proceeds | 99% | `projectAdmin` |
| Shelf platform cut | 1% | `ladderTreasury` |
| Referral commission | 10% of each deposit | referrer(s), or the treasury if unbound |
| Swap tax — buy | 1.00% of the ETH input | 0.70% → `ladderTreasury`, 0.30% → `platformTreasury` |
| Swap tax — sell | 1.00% of the token input | burned to `0xdead`, not split |
| Pool fee | 0.30% | third-party LPs, settled natively by V4 |
| **Total trader friction** | **1.30%** | 0.30% LPs + 0.70% burn + 0.30% platform |

The launch fee is an owner-tunable parameter with a `MAX_LAUNCH_FEE` = 10 ETH
ceiling and zero permitted; read `launchFee()` rather than trusting this table.

**The 0.30% platform cut is the one fee not committed to buy-and-burn.** It is
platform operating revenue, it applies to the buy leg only, and
`platformTreasury` is an immutable constructor argument with no setter —
redirecting it requires deploying a new factory. Paying the platform on the sell
leg would mean paying it in each project's own token, leaving it holding
illiquid positions in tokens it is supposed to be neutral about.

### Referrals

10% of each genesis deposit is carved off — always exactly 10%, which is what
keeps the opening premium a structural constant rather than a function of who
referred whom. The same 10% splits across two slots:

| Slot | Share of the carve | Of the deposit | Binding |
|---|---|---|---|
| Project referrer | 80% (`PROJECT_REFERRAL_SHARE_BPS`) | 8% | once per wallet, per project |
| Lifetime referrer | the remaining 20% | 2% | once per wallet, platform-wide, permanent |

The split is expressed as a share of the carve rather than of the deposit, which
is what lets it be retuned without touching `REFERRAL_BPS` — and therefore
without moving the opening premium.

`deposit` takes one referrer argument and offers it to both registries; each
accepts only if its own slot is empty. Bindings are permanent, a stale link is
silently ignored rather than reverting, and self-referral is ignored. An empty
slot sends its leg to the treasury as buyback fuel. Commission accrues at
deposit and unlocks at `launch()`; a failed genesis refunds depositors in full
and never pays commission.

---

## Architecture

Two platform singletons; one hook and one token per project.

```
ToshFactory  ──creates──▶  ToshToken + ToshLaunchpadHook   (one pair per project)
     │                              │
     │ launch fee, 1% shelf cut,    │ 0.70% of the 1.00% buy-side tax
     │ orphaned referral commission │
     ▼                              ▼
        ToshLadderTreasury  ──buy & burn──▶  0xdead

                                    │ the other 0.30% of the buy-side tax
                                    ▼
                            platformTreasury   (platform revenue)
```

| Contract | Instances | Responsibility |
|---|---|---|
| `ToshFactory` | one per chain | `createLaunch` (CREATE2), `registerPoG`, genesis deposit gateway, referral graph, blacklist / cooldown / pause |
| `ToshLadderTreasury` | one per chain | receives four revenue pipes, curates the buyback roster, `autoPiggybackBuyback` / `pokeBuyback`, `_buyAndBurn` → `0xdead` |
| `ToshLaunchpadHook` | one per project | Phase 1 deposit / refund / launch; Phase 2 shelf mint / claims; V4 callbacks; hook-local TWAP oracle |
| `ToshToken` | one per project | ERC-20, hard cap checked on every mint, minted only by its own hook |

Hooks are deployed as EIP-1167 clones (121 bytes) at CREATE2 addresses, which is
what makes one dedicated hook per project affordable. Per-project rules are
frozen as immutables at deployment.

| Role | Who | Can do |
|---|---|---|
| Platform owner | Safe | pause new launches, curate the buyback roster, tune caps and fees, halt shelf minting for ≤ 7 days |
| `creator` | EOA | call `launch()` on their own project |
| `projectAdmin` | EOA / Safe | receive 99% of shelf proceeds; may rotate itself |
| Genesis depositor | anyone eligible | deposit in Phase 1, claim after launch, or refund |
| Referrer | anyone | earn commission on deposits bound to them |
| Retail LP | anyone | add and remove liquidity in the project pool |

---

## Lifecycle

**Create.** `createLaunch(name, symbol, projectTreasury, projectAdmin, rawSalt,
expectedFee, genesisDuration)` reserves the name/symbol pair and CREATE2-deploys
the hook at a mined address. `expectedFee` is the caller's slippage cap against
the owner moving `launchFee` underneath them.

**Phase 1 — genesis.** Depositors call `factory.deposit(hook, referrer)` with
native ETH. The window is a hard deadline chosen at creation; the soft cap is a
floor, not a ceiling, so a round keeps accepting deposits for its whole window
after the cap is met.

| Option | Value |
|---|---|
| `DURATION_FAST` | 3 hours |
| `DURATION_STANDARD` | 24 hours (default) |
| `DURATION_SLOW` | 72 hours |

**Launch.** After the deadline the `creator` calls `hook.launch()`, which splits
the raise, mints the genesis block, initialises the pool, locks full-range
liquidity, seeds the oracle and shuts Phase 2 for the launch block. Nothing is
automatic — if the creator never calls it, `refund()` opens once `LAUNCH_WINDOW`
(7 days) lapses.

**Failure paths.** `refund()` opens when the soft cap was missed at the
deadline, or when the 7-day launch window expires without a launch. Use the
`canRefund()` view rather than re-deriving the condition.

**Phase 2 — shelf ladder.** `mintBondingCurve(tokenAmount)` buys from the active
shelf at its fixed price, sweeping up to `MAX_TIERS_PER_TX` (32) shelves in one
call. `quoteMint` mirrors every check and returns the exact cost; overpayment is
refunded.

**Claims.** Genesis depositors call `claimGenesis()` after launch; referrers call
`claimReferralReward()` per project, or use the aggregated ledger at
`/referrals`.

**Buyback.** Once the treasury holds `TRIGGER_STEP` (1 ETH) the reservoir is
armed and `max(1 ETH, 10% of balance)` is due. One poke spends
`spend / BATCH_SIZE` on one roster token in round-robin order and sends it to
`0xdead`, under a TWAP-relative floor
(`MAX_BUYBACK_SQRT_DEVIATION_BPS` = 1000). Two things poke it:

- **`afterSwap`, when the trade can afford it** — gated on
  `gasleft() >= PIGGYBACK_MIN_GAS` and capped at
  `gasleft() - PIGGYBACK_TAIL_RESERVE`, so a swap always keeps enough gas to
  finish. Without the gate, the trade whose own tax armed the reservoir paid for
  the whole cycle, every cycle.
- **`pokeBuyback()`, from anyone** — the liveness backstop, since the gas gate
  means trading alone no longer guarantees the reservoir empties. It moves no ETH
  to the caller and chooses nothing but the timing: venue comes from the hook,
  size from the balance, order from the cursor, price floor from the same TWAP.

A skipped poke emits nothing, because skipping is the common case and logging it
would bill every trader for the privilege. `STATE-06` in
`monitoring/alerts.json` polls for the resulting silence instead.

---

## Eligibility: Proof-of-Gas

Genesis deposits are quota-gated. The oracle sums an address's historical gas
spend across Ethereum, Arbitrum, Optimism, Base and Robinhood; below
`POG_GAS_FLOOR_WEI` (0.05 ETH) it is refused, and above it the quota is
converted at the live rate and clamped on-chain by `maxPogAllocationLimit()`
(0.1 ETH) regardless of what the oracle signed.

`registerPoG(maxAlloc, deadline, nonce, signature)` consumes an EIP-191
signature over:

```
keccak256(abi.encode(sender, maxAlloc, nonce, deadline, factory, chainId))
```

All six fields are signed, and the factory hashes with `address(this)`, so a
signature naming another factory cannot be recovered at this one.
`POST /api/sign-allocation` ignores any caller-supplied nonce and reads the live
on-chain nonce before signing, so a replay cannot be arranged by asking for a
convenient one.

This anchors the cost of "one fresh wallet, one fresh quota" to gas an attacker
has already burned on major chains — a history that cannot be fabricated.

Quotas are a platform-wide budget spent across all projects, refilling once per
`quotaWindowDuration`. Refunds never credit back. Lowering
`maxPogAllocationLimit` does not claw back quotas already issued.
`cooldownDuration` is a separate per-(wallet, hook) throttle.

---

## Build and test

| Tool | Min version | Notes |
|---|---|---|
| Foundry | `1.7.1` | `forge`, `cast`, `anvil` — via `foundryup` |
| Node.js | `>= 20` | frontend, PoG oracle, tooling |

```bash
forge install
forge build
forge test
forge test --isolate
```

Expected: **373 passing** in both runs. CI runs both.

The second run is not redundant. `forge test` bills a whole test as one
transaction, so storage warmed in setup stays warm and later calls look cheaper
than they would on chain; `--isolate` charges each call the way a real
transaction does. Two bugs here were only visible under it — a clone funded with
`transfer()`, whose 2300-gas stipend cannot cover the proxy's delegatecall, and
the piggyback gas gate, whose entire job is to compare a live gas figure against
a constant.

After any contract change, re-sync the frontend ABIs:

```bash
node scripts/extractAbis.js
```

`ToshV5AbiTest` fails if you forget.

> **Comment-only edits change the hook's address.** `foundry.toml` leaves
> `bytecode_hash` at its default, so the solc metadata hash is appended to the
> deployed bytecode. Editing a natspec line in `ToshLaunchpadHook.sol` — with no
> change to a single opcode — produces a different initcode hash, a different
> mined address, and invalidates every previously mined salt. This only bites
> during development: once deployed, the factory freezes
> `HOOK_CREATION_CODEHASH` in its constructor. Never hardcode an initcode hash
> in tooling; always read it from the deployed factory.

### Auditing a live launch

```bash
node scripts/auditLaunch.mjs <hook address>
```

Reads a launched hook, its token and its V4 pool, and checks them against the
arithmetic `launch()` performs — pool state comes out of the PoolManager's
storage via `extsload`, not through the app's read path.

---

## Hook salt mining

Uniswap V4 encodes hook permissions in the hook's own address. Combined mask
**`0x20CC`**:

| Flag | Bit | Why |
|---|---:|---|
| `BEFORE_INITIALIZE` | `0x2000` | pool-init front-run defence |
| `BEFORE_SWAP` | `0x0080` | exact-input tax (specified = input) |
| `AFTER_SWAP` | `0x0040` | oracle + buyback poke + exact-output tax |
| `BEFORE_SWAP_RETURNS_DELTA` | `0x0008` | skim the specified (input) side |
| `AFTER_SWAP_RETURNS_DELTA` | `0x0004` | skim the unspecified (input) side |

Exact-output cannot be taxed in `beforeSwap` — the input is unspecified and its
size is only known after the swap. Returning a delta from `afterSwap` is what
charges that input, so a router asking for "N tokens out" still funds the
treasury instead of burning the output token.

Note what is absent: no liquidity flags. The genesis position stays locked
through ownership, so a reverting `beforeRemoveLiquidity` would only have
punished retail LPs for a guarantee the ownership model already provides.

The factory binds the salt to the caller, so nobody can mine an address for
someone else's launch:

```
finalSalt = keccak256(abi.encode(creator, rawSalt))
hookAddr  = CREATE2(factory, finalSalt, hookInitcodeHash)
require((uint160(hookAddr) & 0x20CC) == 0x20CC);
```

The initcode hash covers a 9-field constructor tuple, so each of these changes
the address you must mine for:

```solidity
bytes32 initHash = factory.hookInitcodeHash(
    projectTreasury,
    creator,
    projectAdmin,
    factory.defaultSoftCap(),          // snapshotted at createLaunch time
    factory.maxPogAllocationLimit(),   // snapshotted at createLaunch time
    genesisDuration                    // 3h / 24h / 72h
);
```

Read `defaultSoftCap` and `maxPogAllocationLimit` **live from the factory**.
`createLaunch` snapshots whatever they are when the transaction lands, so a salt
mined against stale caps reverts with `InvalidHookSalt`.

> `getLiveHookInitcodeHash()` is **not** usable for mining. It substitutes
> `platformTreasury` for the three address fields as a sentinel, so salts mined
> against it always revert. It exists only as a reference value for tooling.
> "Sentinel" describes its role in that function only — `platformTreasury` is a
> real payout address.

```bash
node scripts/mineHookSalt.js \
  --factory 0x... --creator 0x... --admin 0x... --treasury 0x... \
  --duration 86400
```

`--duration` accepts `10800`, `86400` or `259200`, and defaults to 24h. In the
dApp, `soat-frontend/src/app/lib/hookMiner.ts` mines client-side so the user
signs a single transaction, reading `hookInitcodeHash` from chain rather than
reconstructing it locally.

---

## Deployment

Order matters: the treasury deploys first because the factory takes its address
as an immutable, then the treasury is pointed back at the factory. `setFactory`
is **one-shot** — it is what proves a roster token's provenance, so it must
never become re-pointable.

```bash
# Robinhood Chain testnet (46630)
forge script script/Deploy.s.sol:DeployScript \
  --rpc-url $ROBINHOOD_TESTNET_RPC --broadcast --verify \
  --verifier blockscout \
  --verifier-url https://explorer.testnet.chain.robinhood.com/api -vvvv

# Local
anvil
forge script script/DeployLocal.s.sol:DeployLocal --fork-url http://127.0.0.1:8545 --broadcast
```

Each script asserts `block.chainid` before broadcasting, so pointing one at the
wrong RPC aborts instead of deploying. Verification is Blockscout and needs no
API key — chain 4663 appears on neither Etherscan v2's multichain host nor
Basescan.

**Production.** `DeployMainnet.s.sol` initiates an `Ownable2Step` transfer to
`PROD_OWNER_SAFE` for both singletons. The transfer is not complete when the
script finishes — the Safe must call `acceptOwnership()` on each. Verify with:

```bash
forge script script/VerifyDeployment.s.sol:VerifyDeploymentScript --rpc-url $RPC
```

Do not announce the factory while `pendingOwner() != address(0)`.

### Robinhood Chain periphery

Uniswap deployed V4 here themselves, and **mainnet (4663) and testnet (46630)
share every address** — so a testnet rehearsal exercises the production address
book unchanged.

| Contract | Address |
|---|---|
| V4 PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| PositionManager | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` |
| StateView | `0xF3334192D15450CdD385c8B70e03f9A6bD9E673b` |
| V4Quoter | `0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94` |
| UniversalRouter | `0x8876789976dEcBfCbBbe364623C63652db8C0904` |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

Each was confirmed by reading its code size on both chains, not by citation. The
UniversalRouter is stock Uniswap from the `Uniswap/contracts` monorepo, but a
newer build than Ethereum mainnet's: its `IV4Router.ExactInputSingleParams`
carries the six-field shape with `minHopPriceX36`. That matters to anything
hand-encoding router calldata.

---

## Environment

Copy `.env.example` to `.env`. Never commit it.

```dotenv
PRIVATE_KEY=0x...
ROBINHOOD_RPC=https://rpc.mainnet.chain.robinhood.com   # also read by the fork suite
ROBINHOOD_TESTNET_RPC=https://rpc.testnet.chain.robinhood.com
TARGET_CHAIN_ID=4663
V4_POOL_MANAGER=0x8366a39CC670B4001A1121B8F6A443A643e40951
POG_SIGNER_ADDRESS=0x...
PLATFORM_TREASURY=0x...
FACTORY_ADDRESS=0x            # filled in after the first deploy
POG_SIGNER_PRIVATE_KEY=0x...  # backend only
```

Frontend (`soat-frontend/.env.local`):

```dotenv
NEXT_PUBLIC_FACTORY_ADDRESS=0x...
NEXT_PUBLIC_CHAIN_ID=46630           # 4663 for production
ROBINHOOD_RPC=https://...            # server-side only; where a KEYED endpoint goes
# NEXT_PUBLIC_RPC_URL=              # leave unset in production; see below
POG_SIGNER_PRIVATE_KEY=0x...         # server-side only, never NEXT_PUBLIC_
```

`NEXT_PUBLIC_CHAIN_ID` must name a chain `src/lib/chain.ts` registers. It throws
at boot for an unknown id rather than falling back, because a UI silently
pointed at a chain nobody asked for is worse than one that will not start.

A paid RPC endpoint goes in `ROBINHOOD_RPC` and nowhere else.
`NEXT_PUBLIC_RPC_URL` is read first by both `providers.tsx` and `serverRpc.ts`,
so a keyed URL there ships the key in every bundle **and** preempts the
server-side variable — the paid node stays billed and never called.
`npm run check:secrets` enforces both halves.

---

## Frontend

```bash
cd soat-frontend
npm install
npm run dev
```

| Route | Purpose |
|---|---|
| `/` | Directory and genesis dashboard |
| `/launch` | Create a launch — duration picker, client-side salt mining |
| `/projects` | All launches |
| `/projects/<addr>` | Project terminal: deposit, launch, mint, claim, LP |
| `/referrals` | Aggregated referral ledger and per-project claims |
| `/admin` | Owner command center |

```bash
npx tsc --noEmit
npx eslint src --ext .ts,.tsx
npm run test
```

---

## Documentation

| Document | What it covers |
|---|---|
| [`README.md`](../README.md) | The protocol spec: economics, lifecycle, fees, governance, and the design tradeoffs |
| [`SECURITY.md`](../SECURITY.md) | Reporting channel, scope, verification anchors, and what the response process can honestly promise |
| [`tosh-status/MANUAL_INTERACTION.md`](https://github.com/jayoo101/tosh-status/blob/main/MANUAL_INTERACTION.md) | Driving the protocol with `cast` when the frontend is down; lives in the status-page repo so it stays reachable during an outage |

---

## Repository layout

```
Tosh-Core/
├── src/
│   ├── ToshFactory.sol         # Platform singleton: PoG, referrals, launches, deposits
│   ├── ToshLaunchpadHook.sol   # Per-project V4 hook: genesis, pool, shelf ladder, tax
│   ├── ToshLadderTreasury.sol  # Platform-wide buyback reservoir (one-way valve)
│   ├── ToshToken.sol           # ERC-20, minted on demand by its hook only
│   └── libraries/              # HookDeployLib · HookMiner · ToshCloneLib
├── test/                       # 373 tests, incl. stateful invariants and test_probe* adversarial cases
├── script/                     # Foundry deploy + verification scripts
├── scripts/                    # Node tooling: salt miner, ABI sync, launch audit, guards
├── monitoring/                 # alerts.json + watcher
├── docs/                       # Whitepaper, PRD, security, monitoring, runbooks
├── soat-frontend/              # Next.js dApp
└── foundry.toml
```

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `createLaunch` reverts `InvalidHookSalt` | Salt mined against stale `defaultSoftCap` / `maxPogAllocationLimit` / duration. Re-read live values and re-mine. |
| `createLaunch` reverts `FeeChanged` | Owner moved `launchFee` past your `expectedFee` cap. Re-read and retry. |
| `createLaunch` reverts `NameTaken` | Name/symbol already reserved. If that round died, `releaseAbandonedName(hook)` frees it. |
| `mintBondingCurve` reverts `NotLaunched` | The creator has not called `launch()` yet. |
| `mintBondingCurve` reverts `SameBlockMintForbidden` | A swap landed in this block. Wait one block. |
| `mintBondingCurve` reverts on the price gate | The market has not risen to meet the shelf. This is the gate working. |
| `launch` reverts `LaunchWindowExpired` | More than 7 days since the deadline; depositors can `refund()`. |
| `deposit` reverts `QuotaExceeded` | Platform-wide PoG budget spent for this window. Wait out `quotaWindowDuration`. |
| `deposit` reverts `PerWalletCapExceeded` | Per-project cap snapshotted at creation, separate from the PoG budget. |
| `addLadderToken` reverts `TokenNotLaunchedHere` | Only tokens launched by the bound factory can be listed. |
| `addLadderToken` reverts `InvalidPoolKey` / `PoolNotLaunched` | The hook exists but has not run `launch()`, so there is no pool yet. |
| `addLadderToken` reverts `TwapNotMature` | The pool's TWAP has not matured; listing is refused until it answers. |
| Treasury holds ≥ 1 ETH and nothing burns | Not a fault. Swaps are skipping the poke on the gas gate. Call `pokeBuyback()` — permissionless. `STATE-06` watches for this. |
| `pokeBuyback` reverts `NotArmed` | Reservoir below `TRIGGER_STEP`, or the roster is empty. |
| `pokeBuyback` reverts `PiggybackInProgress` | A buyback is already mid-flight in this call stack. Retry after it settles. |
| Every swap on a pool reverts | Check `treasury.factory()` is wired. This now degrades to skipped buybacks rather than bricking pools. |

---

## License

MIT — see [LICENSE](../LICENSE) and the SPDX headers in each source file.
