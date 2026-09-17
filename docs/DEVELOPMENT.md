# Development guide

How to build, test, deploy and operate this repository. For what the protocol
*is* and why it is built this way, read the [README](../README.md).

**[README / protocol spec](../README.md)** · **[toshx.xyz](https://toshx.xyz)** ·
**[Security policy](../SECURITY.md)**

| | |
|---|---|
| Network | BNB Smart Chain — chain `56` (mainnet, **not yet deployed**) / chain `97` (testnet, live) |
| AMM | PancakeSwap Infinity CL (`Vault` + `CLPoolManager`) |
| Factory (97) | [`0xB224f26a323320376c0b4C6a3228533FA63E5bBd`](https://testnet.bscscan.com/address/0xB224f26a323320376c0b4C6a3228533FA63E5bBd) |
| Treasury (97) | [`0x79de222644E8BBeea6FC55815CCBE9FF136D7674`](https://testnet.bscscan.com/address/0x79de222644E8BBeea6FC55815CCBE9FF136D7674) |
| Governance | 2-of-3 Gnosis Safe, `Ownable2Step` on both singletons |
| Supply per project | 21,000,000 hard cap, enforced on every mint |
| Trader friction | 1.30% total — 0.30% to LPs, 0.70% buy-and-burn, 0.30% platform |
| Verification | Etherscan v2 / BscScan — blocked on an API key; do not claim 56 is verified |
| Tests | 387 across 16 suites, including stateful invariants and adversarial probes |
| Toolchain | Foundry · Next.js + wagmi + viem · Node |

> There is no platform token. Launch fees, genesis deposits and shelf purchases
> are all native BNB. Notes mentioning `MockSATO`, `harvestAndBurn`, graduation
> or the `0x2200` / `0x20CC` hook address mask describe v3.4/v4.x / Uniswap V4
> and no longer apply. Infinity registers permissions via
> `getHooksRegistrationBitmap()`.

---

## What the protocol guarantees

These are structural properties, not policies — each one is a consequence of
code that exists or code that is absent, and each is checkable from chain.

**Depositors always have a way out.** If the creator never calls `launch()`
within the 7-day `LAUNCH_WINDOW` after genesis closes, every depositor reclaims
100% of their native coin with no penalty. Missing the raise target does not fail the
round — time-up is what opens `launch()`, with whatever was raised. "Raised the
money and vanished" is not a state that can trap funds.

**The pool opens above what depositors paid.** The 55/45 split of genesis supply
makes the opening price exactly 1.10× the depositors' average cost, and shelf 0
sits a further 5% above that. This is arithmetic, not a target price — a test
pins the identity, so changing the split or the referral rate fails the suite
rather than quietly shipping a different premium.

**Nobody holds a pre-mine.** `launch()` mints only the 8.4M genesis block. The
remaining 12.6M is minted shelf by shelf as it sells.

**Genesis liquidity cannot be withdrawn — by anyone.** Infinity keys positions to
their creator; the genesis position belongs to the hook, and the hook has no
code path that removes liquidity. The lock comes from ownership plus absence,
not from a callback that could be edited. Third-party LPs use their own
positions and come and go freely.

**The treasury cannot be drained.** `ToshLadderTreasury` has no `withdraw`, no
`sweep`, no `rescue` and no `delegatecall`. Its only outbound path buys on a
Tosh pool and sends the tokens to `0xdead`. The owner chooses which tokens are
in the buyback rotation; the owner cannot choose where the native coin goes.

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
p0      = lpNative / GENESIS_LP_SUPPLY          pool opening price
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

**Failure paths.** `refund()` opens only when the 7-day launch window expires
without a launch. Missing the raise target does not fail the round. Use the
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
spend across Ethereum, Arbitrum, Optimism, Base and Robinhood; below the band's
floor (seeded at 0.025 ETH) it is refused, and above it the quota is converted at
the live rate (seeded at 0.5 ETH of quota per 1 ETH of gas), capped by the
band's own ceiling (seeded at 0.5 ETH), then clamped on-chain by
`maxPogAllocationLimit()` (0.5 ETH) regardless of what the oracle signed.

### The band, and why the three dials move together

Floor, rate and ceiling are one object — `PogBand` in
`soat-frontend/src/app/lib/pogQuota.ts` — because they are not independent. The
gas cap the scanner stops counting at is *derived*, `ceiling / rate`, so raising
the rate shrinks how much history is worth scanning. A band is incoherent if the
floor sits above that derived cap: every wallet would then be refused for having
too little gas while the scanner refuses to count any more.

`pogBandProblem()` is the single predicate that catches this, and both the admin
endpoint and `assertPogBandCoherent()` at module load run it. The live values
live in `pogParams.ts` (Upstash-backed, in-memory fallback for local dev); the
`DEFAULT_*` constants in `pogQuota.ts` are only seeds for a cold store.

Rotating any dial goes through the same owner-signed path as the rate always
did — `POST /api/admin/config` with `newRate`, `newFloorWei`, `newMaxAllocWei`,
each optional and each covered by the owner's signature. Omitted dials are
signed as the literal `keep`, so an unsigned dial cannot be smuggled in
alongside a signed one. `scripts/rotateGasRate.mjs --floor 0.02
--max-alloc 0.4 --rate 0.5` builds, prints and submits the message for a Safe
owner.

One asymmetry to keep in mind: the endpoint reads the factory's live
`maxPogAllocationLimit` and refuses any `newMaxAllocWei` above it. Raising the
off-chain ceiling therefore means raising the on-chain dial first, otherwise the
oracle would sign attestations that `registerPoG` reverts. Lowering is always
allowed.

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

## On-chain monitor

`monitoring/watch.mjs` is run-once. `.github/workflows/watch.yml` is the host:
it resumes from branch `watcher-state`, files findings, and persists the
checkpoint. Two facts that are not knobs on that workflow:

**GitHub's scheduler is not a cadence.** Measured 2026-09-13, a cron asking
for four passes an hour delivered 0.269. Changing the interval from hourly to
every 15 minutes moved that rate from 0.27 to 0.269. The `schedule:` entry is
leftover best-effort. The detection interval is whatever hits
`repository_dispatch` of type `watch`.

`POST/GET /api/watch-ping` is that button. It does not run the watcher — the
checkpoint must stay on `watcher-state` under the workflow's concurrency
group. It posts the dispatch. Auth is `Authorization: Bearer <CRON_SECRET>`
(or `x-cron-secret`). Vercel Hobby can only cron the route daily
(`vercel.json` does that at 06:11 UTC). A 15-minute bar needs a host that is
not Hobby and not GitHub's pool:

```bash
# every 15 minutes, from cron-job.org or a laptop
curl -H "Authorization: Bearer $CRON_SECRET" https://toshx.xyz/api/watch-ping

# same dispatch, no Vercel in the path
node scripts/pingWatch.mjs
```

Set `CRON_SECRET` and `WATCH_DISPATCH_TOKEN` on the Vercel project as
Sensitive. The token is a fine-grained PAT with **Contents: write** on
`jayoo101/Tosh-Core` — a different PAT from `ALERT_REPO_TOKEN` (that one files
into `tosh-alerts`). Unset, the route refuses rather than firing an
unauthenticated dispatch.

Contents, not Actions, and the names invite the opposite guess. GitHub splits
the two dispatch endpoints across permissions: `repository_dispatch`, which
this route posts, is `POST /repos/{owner}/{repo}/dispatches` under Contents,
while Actions: write buys `POST .../actions/workflows/{id}/dispatches`, which
is `workflow_dispatch` — a different trigger this route never calls. A token
granted Actions: write authenticates, is refused by GitHub, and surfaces as
`/api/watch-ping` returning 502 while the ping itself looks accepted.

**The public 4663 RPC 429s on the seventh identical `eth_getLogs`.** A pass
that issued one request per topic0 walked into that ceiling; workflow run
`34196807435` missed P0 governance logs that way. The watcher now ORs topic0s
into three queries (factory, treasury, address-less hook events). 250 ms
pacing plus adaptive backoff after a 429 absorbs a transient. They do not
remove the ceiling. A keyed URL in `MONITOR_RPC` does. `watch.mjs` prints
that on stderr when the secret still points at
`rpc.mainnet.chain.robinhood.com`.

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

### Salts: there is nothing left to mine

Under Uniswap V4 a hook's permissions were read out of the low bits of its own
address, so a launch had to arrive with a salt whose CREATE2 address carried the
`0x20CC` mask — about one salt in 32, hence a miner on both the Solidity and the
frontend side. Infinity asks the contract instead, via
`getHooksRegistrationBitmap()`, and `CLPoolManager.initialize` refuses a pool
whose `PoolKey.parameters` disagrees with the answer. The permission set is still
pinned to the key, by equality rather than by address arithmetic.

So `HookAddress.find`, `isValidHookAddress`, the fourteen flag constants and
`InvalidHookSalt` are all gone, and so is `scripts/mineHookSalt.js`. A salt's
only remaining job is to be unused.

The factory still binds it to the caller, which is what stops one creator
front-running another's predicted address:

```
finalSalt = keccak256(abi.encode(creator, rawSalt))
hookAddr  = CREATE2(factory, finalSalt, hookInitcodeHash)
```

A hook is a 131-byte EIP-1167 clone, so the initcode hash covers five immutable
args rather than a nine-field constructor tuple:

```solidity
bytes32 initHash = factory.hookInitcodeHash(
    projectTreasury,
    creator,
    factory.defaultSoftCap(),          // snapshotted at createLaunch time
    factory.maxPogAllocationLimit(),   // snapshotted at createLaunch time
    genesisDuration                    // 3h / 24h / 72h
);
```

`projectAdmin` is not in it: it is mutable by design and is applied by
`initializeToken`, after the address is fixed.

Read `defaultSoftCap` and `maxPogAllocationLimit` **live from the factory** and
pass the same values to `createLaunch` as `expectedSoftCap` / `expectedWalletCap`
— they are checked for equality and the launch reverts `CapsChanged` otherwise.
That equality check is now the only thing standing where `InvalidHookSalt` used
to stand, and it is narrower: see the note below.

> ⚠ **A wrong initcode layout is now a SILENT failure.** It used to yield a
> stale prediction whose re-rolled address failed the permission mask, so
> `createLaunch` reverted on essentially every launch. With no mask the same
> drift deploys successfully at an address the UI cannot name — the project page,
> the directory row and the pool link all point at an empty address, and nothing
> reverted to say so. `scripts/checkCloneInitcodeTuple.mjs` (static) and
> `scripts/e2eLaunchFlow.mjs` (dynamic) are between them the whole of the
> protection the mask used to provide for free. Both are wired into
> `precheck.ps1` and CI; neither may be dropped.

> `getLiveHookInitcodeHash()` substitutes `platformTreasury` for the address
> fields as a sentinel, so it does not describe any real launch. It exists only
> as a reference value for tooling. "Sentinel" describes its role in that
> function only — `platformTreasury` is a real payout address.

In the dApp, `soat-frontend/src/app/lib/hookAddress.ts` picks a random 32-byte
salt and predicts where it lands, reading `hookInitcodeHash` from chain rather
than reconstructing it locally. Random rather than counting up from zero: the
mask used to make an early collision vanishingly unlikely, and without it the
first free salt for a given creator is `0x00..00` every time, so two launches
with the same dials and window would predict the same address and the second
CREATE2 would fail.

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

`docs/MAINNET_REDEPLOY.md` is the step-by-step for a **re**deploy, which is a
different job from a first deploy: it covers what a new factory strands on the
old one, the order the Safe calls have to land in, and the point after which
backing out stops being free.

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
BSC_RPC=https://...                 # keyed endpoint; also read by the fork suite
BSC_TESTNET_RPC=https://...
TARGET_CHAIN_ID=97                  # 56 for production, once it is deployed
INFINITY_CL_POOL_MANAGER=0x36A12c70c9Cf64f24E89ee132BF93Df2DCD199d4  # 97; 56 is 0xa0Ff…058b
INFINITY_VAULT=0x...
POG_SIGNER_ADDRESS=0x...
PLATFORM_TREASURY=0x...
FACTORY_ADDRESS=0x            # filled in after the first deploy
POG_SIGNER_PRIVATE_KEY=0x...  # backend only
```

Frontend (`soat-frontend/.env.local`):

```dotenv
NEXT_PUBLIC_FACTORY_ADDRESS=0x...
NEXT_PUBLIC_CHAIN_ID=97              # 56 for production, once it is deployed
BSC_RPC=https://...                  # server-side only; where a KEYED endpoint goes
# NEXT_PUBLIC_RPC_URL=              # leave unset in production; see below
POG_SIGNER_PRIVATE_KEY=0x...         # server-side only, never NEXT_PUBLIC_
```

`NEXT_PUBLIC_CHAIN_ID` must name a chain `src/lib/chain.ts` registers. It throws
at boot for an unknown id rather than falling back, because a UI silently
pointed at a chain nobody asked for is worse than one that will not start.

A paid RPC endpoint goes in `BSC_RPC` (or `BSC_TESTNET_RPC`) and nowhere else.
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

### Function region

`vercel.json` pins `"regions": ["hnd1"]` (Tokyo). This is not a preference — it
is where the data is. Both stores every API route touches live in AWS
`ap-northeast-1`:

| Dependency | Region | How to re-check |
|---|---|---|
| Supabase | `ap-northeast-1` | Project Settings → General → Region — on the project `NEXT_PUBLIC_SUPABASE_URL` names, which is not the only one in that org |
| Upstash | `ap-northeast-1` | resolve the REST hostname, match the IP against `ip-ranges.amazonaws.com` |

Vercel defaults new projects to `iad1` (Washington D.C.) on the assumption that
your data is on the US East Coast. Ours is not, and nobody had overridden the
default, so every request crossed the Pacific twice: once for the rate-limiter
round trip and once for the query. `/api/projects` budgets
`REGISTRY_READ_DEADLINE_MS` (1200 ms in production) for the directory read;
a trans-Pacific round trip plus a cold TLS handshake spent that budget before
Postgres was reached, and roughly a third of production calls returned 503
`registry unreachable`. Moving the functions to the data removed both hops:
p90 over the live endpoint went from 2111 ms to 562 ms and the 503s stopped.
That measurement, rather than the dashboard reading above, is what actually
establishes the two are co-located.

If either store is ever migrated, move this region with it. The failure mode is
not an error at the boundary — it is an intermittent timeout that looks like the
database is down.

### Hosting tier

On 2026-09-14 a project in the same Supabase org was found paused, with the
dashboard offering Pro as the remedy — so that org is on the free tier. Confirm
which plan backs the project this deployment actually reads
(`NEXT_PUBLIC_SUPABASE_URL` names it) before trusting anything below, because
the free tier caps three things that surface as site outages rather than as
billing warnings:

| Limit | What it looks like from outside |
|---|---|
| Pauses after about a week with no activity | Postgres stops. `/api/projects` 503s on every request until someone resumes it from the dashboard. |
| Small shared instance | Query latency climbs back past `REGISTRY_READ_DEADLINE_MS`. Identical symptom to the region bug above, and the region fix cannot help a second time — the function is already co-located. |
| Metered storage egress | Project logos are served straight from `…supabase.co/storage/…`, so they draw on the same allowance the database does. |

The pause is the one worth naming, because it is the only failure here that
arrives during quiet periods rather than busy ones, and quiet is exactly when
nobody is watching. Note also that the directory degrades rather than dies:
`useDirectoryProjects` enumerates launches from the factory on chain and treats
the registry as an overlay, so a stopped database costs logos, descriptions and
links — not the listing itself.

Current plan limits are on Supabase's pricing page; they move, so read them
there rather than trusting a number copied into this file.

### Watcher RPC

`MONITOR_RPC` is a paid keyed endpoint (dRPC Growth) as of 2026-09-15. It had
been the public 4663 URL, and half the passes were scanning nothing: every
`eth_getLogs` refused on the first attempt through all four retries, `eth_call`
answering normally alongside. `monitoring/rpc.mjs` carries the measurements — the
short version is that the public endpoint meters by source IP, a GitHub runner
shares its range with every other runner, and no request interval buys back an
allowance a neighbour has already spent.

Two things follow that are worth knowing before touching this.

**A free keyed tier is not a substitute, however it is marketed.** A pass needs
`eth_getLogs` over the ~8,700 blocks it spans, and free tiers cap that range
rather than the rate: QuickNode Discover at 5 blocks, Alchemy Free at 10, dRPC
Free refusing 8,700 outright while its error names a 10,000 limit. Chunking is
not a way around a 10-block cap — it is ~2,600 requests a pass, ~250,000 a day.
The public endpoint is the only one with no range cap at all, which is why this
worked for as long as it did and why the failure, when it arrived, looked like
nothing to do with ranges.

**The watcher now depends on a prepaid balance, which is new.** Credits are
bought up front and do not expire; a pass costs three `eth_getLogs` plus the
state reads, at 20 CU each, so $6 of credit is on the order of a year at the
15-minute cadence. Read the real number off the dRPC dashboard rather than
trusting that arithmetic. When the balance does run out the monitor goes blind
again — but not quietly: it is the same refusal shape as before, so WATCHER-04
fires, the job goes red, and a finding is filed. That is the one reassuring thing
about this dependency, and it is worth not undoing.

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
│   └── libraries/              # HookDeployLib · HookAddress · ToshCloneLib
├── test/                       # 373 tests, incl. stateful invariants and test_probe* adversarial cases
├── script/                     # Foundry deploy + verification scripts
├── scripts/                    # Node tooling: salt miner, ABI sync, launch audit, guards
├── monitoring/                 # alerts.json + watcher
├── docs/                       # This file. Protocol overview is README.md, disclosure is SECURITY.md
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
