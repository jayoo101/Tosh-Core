# Tosh Fair Launchpad v5.0

A 100 % ETH-native fair-launch platform on Uniswap V4: PoG-gated genesis
funding, a discrete fixed-price shelf ladder gated against price manipulation,
a global lifetime referral graph, and a buy-and-burn treasury that rides along on
ordinary swaps when they can afford it, and can be poked by anyone when they
cannot.

> Network: **Robinhood Chain (chain 4663)**, with rehearsals on its testnet
> (46630). See `docs/PRE_MAINNET_CHECKLIST.md` §2 for the decision, the V4
> addresses, and the measured per-launch gas cost, and
> `docs/ROBINHOOD_MIGRATION.md` for what moving to an Arbitrum Orbit L2 took —
> chiefly that `block.number` there is the *L1* height, so the hook reads
> `ArbSys` instead.
> Toolchain: **Foundry** (contracts), **Next.js + wagmi + viem** (frontend),
> **Node** (PoG oracle + tooling).

**There is no SATO token.** v5.0 removed the ERC-20 payment leg entirely —
launch fees, genesis deposits, and shelf purchases are all native ETH. If you
are reading older notes that mention `MockSATO`, `harvestAndBurn`, graduation,
or the `0x2200` hook mask, they describe v3.4/v4.x and no longer apply.

---

## Repository layout

```
Tosh-Core/
├── src/
│   ├── ToshFactory.sol         # Platform singleton: PoG, referrals, launches, deposits
│   ├── ToshLaunchpadHook.sol   # Per-project V4 hook: genesis, pool, shelf ladder, tax
│   ├── ToshLadderTreasury.sol  # Platform-wide buyback reservoir (one-way valve)
│   ├── ToshToken.sol           # ERC-20, minted on demand by its hook only
│   └── libraries/              # HookDeployLib · HookMiner
├── test/                       # forge tests (303 passing, incl. stateful invariants)
├── script/
│   ├── Deploy.s.sol            # Base Sepolia (DeployScript)
│   ├── DeployMainnet.s.sol     # Production, with Safe ownership handoff
│   ├── DeployLocal.s.sol       # anvil
│   ├── VerifyDeployment.s.sol  # Post-deploy invariant check (view-only)
│   └── RecomputeInitcodeHash.s.sol
├── scripts/                    # Node tooling
│   ├── mineHookSalt.js         # CLI CREATE2 salt miner
│   └── extractAbis.js          # out/ → frontend ABI sync
├── docs/                       # PRD, security notes, incident response
├── soat-frontend/              # Next.js dApp
└── foundry.toml
```

---

## 1. Quick start

| Tool    | Min version | Notes                                     |
|---------|-------------|-------------------------------------------|
| Foundry | `1.7.1`     | `forge`, `cast`, `anvil` — via `foundryup` |
| Node.js | `>= 20`     | frontend, PoG oracle, tooling             |

```bash
forge install
forge build
forge test
forge test --isolate
```

Expected: **303 passing**, in both runs.

The second run is not redundant. `forge test` bills a whole test as one
transaction, so storage a test warmed in setup stays warm and later calls look
cheaper than they would on chain; `--isolate` charges each call the way a real
transaction does. Two bugs in this repo were only visible under it — a clone
funded with `transfer()`, whose 2300-gas stipend cannot cover the proxy's
delegatecall, and the piggyback gas gate, whose whole job is to compare a live
gas figure against a constant. CI runs both.

After any contract change, re-sync the frontend ABIs:

```bash
node scripts/extractAbis.js
```

`forge test` pins this: `ToshV5AbiTest` fails if you forget.

There was a matching `extractBytecode.js` alongside it. It is gone: since hooks
became EIP-1167 clones the frontend never reads the hook's creation code, and
the constant it maintained had no importers. The rule below is what replaced
it, and is the better rule.

> **Comment-only edits change the hook's address.** `foundry.toml` leaves
> `bytecode_hash` at its default, so the solc metadata hash is appended to the
> deployed bytecode. Editing a natspec line in `ToshLaunchpadHook.sol` — with
> no change to a single opcode — produces a different initcode hash, which
> means a different mined address and every previously mined salt becomes
> invalid. This only bites during development: once deployed, the factory
> freezes `HOOK_CREATION_CODEHASH` in its constructor, so anything mining
> against a live factory is always consistent with it. Never hardcode an
> initcode hash in tooling; always read it from the deployed factory.

---

## 2. Architecture

Four contracts. The factory is a singleton; one hook and one token are deployed
per project; the treasury is shared by the whole platform.

```
ToshFactory  ──creates──▶  ToshToken + ToshLaunchpadHook   (one pair per project)
     │                              │
     │ launch fee, 1 % shelf cut,   │ 0.70 % of the 1.00 % buy-side tax
     │ orphaned referral commission │
     ▼                              ▼
        ToshLadderTreasury  ──buy & burn──▶  0xdead

                                    │ the other 0.30 % of the buy-side tax
                                    ▼
                            platformTreasury   (platform revenue, not burned)
```

The sell-side tax is not split: the full 1.00 % of a sell's token input is
burned on contact, so the platform is only ever paid in ETH. `platformTreasury`
is immutable and has no setter — see §3.

| Role               | Who        | Can do                                                        |
|--------------------|------------|---------------------------------------------------------------|
| Platform owner     | Safe       | pause new launches, curate the buyback ladder, set caps/fees   |
| `creator`          | EOA        | call `launch()` on their own project                           |
| `projectAdmin`     | EOA/Safe   | receives 99 % of shelf proceeds; may rotate itself             |
| Genesis depositor  | anyone     | deposit ETH in Phase 1, claim tokens after launch, or refund   |
| Referrer           | anyone     | earns 10 % of every deposit by a wallet bound to them          |
| Retail LP          | anyone     | add/remove liquidity in the project pool                       |

---

## 3. Token economics

Total supply is 21,000,000, split into a genesis block and a bonding ladder.

| Bucket                 | Amount       | Destination                                  |
|------------------------|--------------|----------------------------------------------|
| `GENESIS_CLAIM_SUPPLY` | 4,620,000    | 55 % — claimed pro rata by genesis depositors |
| `GENESIS_LP_SUPPLY`    | 3,780,000    | 45 % — seeded full-range into the V4 pool     |
| `BONDING_MAX`          | 12,600,000   | Phase-2 shelf ladder (4000 × 3,150)           |

Genesis is 40 % of the cap and the ladder the remaining 60 %. That ratio is the
primary control on early inflation: the ladder releases a *fraction* of itself
as price climbs (see below), so the only way to shrink the number of fresh
tokens hitting the market on the way up is to shrink the ladder and hand the
difference to genesis, where the supply is already priced in and circulating.

The 55/45 split inside genesis is what gives depositors an immediate 10 % paper
premium: 90 % of the raise (after the referral slice) buys 45 % of the genesis
block, so the pool opens above the depositors' average cost. It is a ratio, not
a pair of magnitudes, so resizing the genesis block leaves the premium at
exactly 1.10.

**Pricing.** `p0 = lpEth * 1e18 / GENESIS_LP_SUPPLY` is the pool's opening
price. The ladder starts one notch above it at
`shelfP0 = p0 * 10500 / 10000`, and each of the 4000 shelves is 0.19025 % dearer
than the last (`TIER_STEP_E18 = 1_001_902_508_266_805_824`, chosen so the last
shelf is exactly 2000× the first).

**Issuance schedule.** Equal-size shelves release `log(R) / log(SPAN)` of the
ladder by the time the market trades at `R×` the ladder base. Widening the span
from 1000× to 2000× trims that curve without touching the supply split, but the
logarithm flattens it — the split does the heavy lifting:

| Config                  | Released at 2× | As % of `GENESIS_SUPPLY` |
|-------------------------|----------------|--------------------------|
| 20/80 split, 1000× span | 1,688,400      | 40.2 %                   |
| 20/80 split, 2000× span | 1,533,000      | 36.5 %                   |
| **40/60 split, 2000× span** | **1,149,750** | **13.7 %**           |

**Read that denominator carefully.** `GENESIS_SUPPLY` is 8.4 M, but 3.78 M of it
is sealed in the genesis LP position — the hook owns that position and has no
code path that removes liquidity — so it is supply that exists and never trades.
The percentages above are the right basis for comparing the three *configurations*
against each other, and the wrong basis for asking how much the market has to
absorb. Against the tradeable float:

| Denominator at 2×                          | Amount    | Share   |
|--------------------------------------------|-----------|---------|
| `GENESIS_SUPPLY` (8.4 M, includes locked LP) | 1,149,750 | 13.7 %  |
| Claim float (4.62 M) — what actually trades  | 1,149,750 | **24.9 %** |
| Circulating after release (4.62 M + 1.15 M)  | 1,149,750 | **19.9 %** |

So the 40/60 split is a genuine improvement on 20/80 (36.5 % → 13.7 % is a
like-for-like comparison), and the market still absorbs roughly a fifth to a
quarter of the live float by the time price doubles. If a ~10 % float target is
the requirement, the span or the split has to move further.
`test_earlyReleaseSchedule_isSetByTheSupplySplit` pins all three readings so the
headline number cannot be restated without the other two.

| Fee                    | Rate  | Goes to                          |
|------------------------|-------|----------------------------------|
| Launch fee             | 0.1 ETH | `ladderTreasury` (buyback fuel) |
| Shelf proceeds         | 99 %  | `projectAdmin`                   |
| Shelf platform cut     | 1 %   | `ladderTreasury`                 |
| Referral commission    | 10 %  | referrer, or treasury if unbound |
| In-flight tax (buy)    | 1.0 % of the ETH input | split: 0.7 % → `ladderTreasury`, 0.3 % → `platformTreasury` |
| In-flight tax (sell)   | 1.0 % of the token input | burned to `0xdead` — **not** split |
| Pool fee               | 0.3 % | third-party LPs (native V4)      |
| **Total trader friction** | **1.3 %** | 0.3 % LPs + 0.7 % buyback + 0.3 % platform |

The 0.3 % platform cut is the one fee that is not committed to buyback-and-burn.
It applies to the buy leg only: a sell's input is the project's own token, and
paying the platform in kind would leave it holding illiquid bags of every token
it is meant to be neutral about. `platformTreasury` is an immutable constructor
argument with no setter — redirecting it means deploying a new factory — and it
must accept ETH unconditionally, because the hook pays it with a raw
`poolManager.take` on a path that is not fault-isolated.

---

## 4. Lifecycle

**Create.** `createLaunch(name, symbol, projectTreasury, projectAdmin, rawSalt,
expectedFee, genesisDuration)` — costs 0.1 ETH, reserves the name/symbol pair,
and CREATE2-deploys the hook at a mined address (see §5).

**Phase 1 — genesis.** Depositors call `factory.deposit(hook, referrer)` with
native ETH. The window is chosen at creation from three options and is a hard
deadline; there is no cap that closes it early, so a round keeps accepting
deposits for its whole window even after the soft cap is met.

| Option              | Value    |
|---------------------|----------|
| `DURATION_FAST`     | 3 hours  |
| `DURATION_STANDARD` | 24 hours (default) |
| `DURATION_SLOW`     | 72 hours |

**Launch.** After the deadline, the `creator` calls `hook.launch()`. This seeds
the pool, mints and locks the genesis liquidity full-range, and starts the
oracle. Nothing happens automatically — if the creator never calls it, every
depositor can `refund()` once `LAUNCH_WINDOW` (7 days) lapses.

**Failure paths.** `refund()` opens when the soft cap was missed at the
deadline, or when the 7-day launch window expires without a launch. Use the
`canRefund()` view rather than re-deriving the condition.

**Phase 2 — shelf ladder.** `mintBondingCurve(tokenAmount)` buys from the
active shelf at its fixed price, sweeping up to `MAX_TIERS_PER_TX` (32) shelves
in one call. `quoteMint` mirrors every check and returns the exact cost;
overpayment is refunded.

**Claims.** Genesis depositors call `claimGenesis()` after launch; referrers
call `claimReferralReward()`.

**Buyback.** Once the treasury holds 1 ETH (`TRIGGER_STEP`) the reservoir is
*armed*, and `max(1 ETH, 10% of balance)` is due to be spent. A poke buys
`spend / BATCH_SIZE` (a third) of that on **one** ladder token, taken in
round-robin order, and sends it straight to `0xdead`. So three pokes cover the
same three pools and deploy the same ETH the old three-legs-in-one-poke version
did — the difference is which trader pays. A leg costs ~125k gas, and billing one
buyer for three of them put a 579k swap in front of somebody who had estimated
217k.

Two things can poke it:

- **`afterSwap`, if the trade can afford it.** Gated on
  `gasleft() >= PIGGYBACK_MIN_GAS`, and the call is capped at
  `gasleft() - PIGGYBACK_TAIL_RESERVE` so the swap always keeps enough to
  finish. Without the gate the trade whose own buy tax tipped the reservoir over
  the trigger was billed for the cycle — deterministically, every cycle, and
  always a trade whose wallet had quoted an unarmed pool. `try/catch` does not
  save it; the 63/64 rule leaves too little behind.
- **`pokeBuyback()`, from anyone.** The liveness backstop, because the gate means
  trading alone no longer guarantees the reservoir empties. It moves no ETH to
  the caller and picks nothing: venue comes from the hook, size from the balance,
  order from the cursor, price from the same TWAP floor as any other leg. The
  only choice it offers is *when*, and the cursor makes that dull.

A skipped poke emits nothing — skipping is the common case and logging it would
bill every trader for the privilege. `STATE-06` in `monitoring/alerts.json` polls
for the resulting silence instead.

---

## 5. Hook salt mining (the CREATE2 puzzle)

Uniswap V4 encodes hook permissions in the hook's own address — combined mask
**`0x20CC`**:

| Flag                        | Bit     | Why                                         |
|-----------------------------|--------:|---------------------------------------------|
| `BEFORE_INITIALIZE`         | `0x2000`| pool-init front-run defence                 |
| `BEFORE_SWAP`               | `0x0080`| exact-input tax (specified = input)         |
| `AFTER_SWAP`                | `0x0040`| oracle + buyback poke + exact-output tax    |
| `BEFORE_SWAP_RETURNS_DELTA` | `0x0008`| skim the specified (input) side             |
| `AFTER_SWAP_RETURNS_DELTA`  | `0x0004`| skim the unspecified (input) side           |

Exact-output cannot be taxed in `beforeSwap` — the input is unspecified and
its size is only known after the swap. Returning a delta from `afterSwap` is
what charges that input, so a router that asks for "N tokens out" still funds
the buyback reservoir instead of burning the output token.

Note what is **not** there: no liquidity flags. The genesis position stays
locked because V4 keys every position to the address that called
`modifyLiquidity` — it belongs to the hook, and the hook exposes no path that
removes it. A reverting `beforeRemoveLiquidity` would only have punished retail
LPs for a guarantee the ownership model already provides.

The factory binds the salt to the caller so nobody can mine an address for
someone else's launch:

```
finalSalt = keccak256(abi.encode(creator, rawSalt))
hookAddr  = CREATE2(factory, finalSalt, hookInitcodeHash)
require((uint160(hookAddr) & 0x20CC) == 0x20CC);
```

The initcode hash covers a **9-field constructor tuple**, so every one of these
inputs changes the address you must mine for:

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
`createLaunch` snapshots whatever they are when the transaction lands, so a
salt mined against stale caps reverts with `InvalidHookSalt`.

> `getLiveHookInitcodeHash()` is **not** usable for mining. It substitutes
> `platformTreasury` for the three address fields as a sentinel, so salts mined
> against it will always revert. It exists only as a reference value for
> tooling.
>
> "Sentinel" describes its role in *this* function only. `platformTreasury` is
> a real payout address — it receives 0.30 % of every buy — so do not read this
> paragraph as saying the value is arbitrary.

### CLI miner

```bash
node scripts/mineHookSalt.js \
  --factory 0x... --creator 0x... --admin 0x... --treasury 0x... \
  --duration 86400
```

`--duration` accepts `10800`, `86400`, or `259200` and defaults to 24 h.

### In the dApp

`soat-frontend/src/app/lib/hookMiner.ts` mines client-side at launch-creation
time so the user signs a single transaction. It reads `hookInitcodeHash` from
chain rather than reconstructing it locally, which keeps it from drifting away
from the contract.

---

## 6. Deployment

Order matters: the treasury is deployed first because the factory takes its
address as an immutable, then the treasury is pointed back at the factory.
`setFactory` is **one-shot** — it is what proves a ladder token's provenance,
so it must never become re-pointable.

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

Verification is Blockscout and takes no API key — chain 4663 appears on neither
Etherscan v2's multichain host nor Basescan.

Each script asserts `block.chainid` before broadcasting, so pointing one at the
wrong RPC aborts instead of deploying.

**Production.** `DeployMainnet.s.sol` initiates an `Ownable2Step` transfer to
`PROD_OWNER_SAFE` for both the factory and the treasury. The transfer is *not*
complete when the script finishes — the Safe must call `acceptOwnership()` on
each contract. Verify with:

```bash
forge script script/VerifyDeployment.s.sol:VerifyDeploymentScript --rpc-url $RPC
```

Do not announce the factory while `pendingOwner() != address(0)`.

### Robinhood Chain periphery

Uniswap deployed V4 here themselves, and **mainnet (4663) and testnet (46630)
share every address** — so a testnet rehearsal exercises the production address
book unchanged, and there is no cutover edit to get wrong.

| Contract        | Address                                      |
|-----------------|----------------------------------------------|
| V4 PoolManager  | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| PositionManager | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` |
| StateView       | `0xF3334192D15450CdD385c8B70e03f9A6bD9E673b` |
| V4Quoter        | `0x8Dc178eFB8111BB0973Dd9d722ebeFF267c98F94` |
| UniversalRouter | `0x8876789976dEcBfCbBbe364623C63652db8C0904` |
| Permit2         | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

Each was confirmed by reading its code size on both chains, not by citation.
The UniversalRouter is stock Uniswap — verified source on Blockscout, from the
`Uniswap/contracts` monorepo — but a *newer* build than Ethereum mainnet's, and
its `IV4Router.ExactInputSingleParams` carries the six-field shape with
`minHopPriceX36`. That matters to anything hand-encoding router calldata; see
`docs/ROBINHOOD_MIGRATION.md`.

---

## 7. Environment variables

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

There is no explorer API key: Blockscout does not use one.

Frontend (`soat-frontend/.env.local`):

```dotenv
NEXT_PUBLIC_FACTORY_ADDRESS=0x...
NEXT_PUBLIC_CHAIN_ID=46630           # 4663 for production
NEXT_PUBLIC_POSITION_MANAGER=0x...   # optional; the Robinhood address is baked in
NEXT_PUBLIC_STATE_VIEW=0x...         # optional; the Robinhood address is baked in
ROBINHOOD_RPC=https://...            # server-side only; where a KEYED endpoint goes
# NEXT_PUBLIC_RPC_URL=              # leave unset in production; see below
POG_SIGNER_PRIVATE_KEY=0x...  # server-side only, never NEXT_PUBLIC_
```

`NEXT_PUBLIC_CHAIN_ID` must name a chain `src/lib/chain.ts` registers. It no
longer falls back to a default for an unknown id — it throws at boot, because a
UI silently pointed at a chain nobody asked for is worse than one that will not
start.

A paid RPC endpoint goes in `ROBINHOOD_RPC` and nowhere else. `NEXT_PUBLIC_RPC_URL`
is read first by *both* `providers.tsx` and `serverRpc.ts`, so putting a keyed URL
there ships the key in every bundle **and** preempts the server-side variable — the
paid node stays configured, stays billed, and is never called. Leave it unset: its
value was identical to viem's own Robinhood default, which `providers.tsx` appends
unconditionally, so the browser loses nothing. `npm run check:secrets` enforces
both halves, and asserts the Vercel row is stored Sensitive rather than merely
encrypted, because an RPC key travels in the URL path.

---

## 8. PoG oracle

`registerPoG(maxAlloc, deadline, nonce, signature)` consumes an EIP-191
signature over:

```
keccak256(abi.encode(sender, maxAlloc, nonce, deadline, factory, chainId))
```

Quotas are denominated in **ETH-wei** and clamped on-chain by
`maxPogAllocationLimit` (default 0.1 ETH) regardless of what the oracle signs.
The quota is a platform-wide budget spent across all projects and refills once
per `quotaWindowDuration` window; refunds never credit it back.  Lowering
`maxPogAllocationLimit` does not claw back quotas already on the books.
`cooldownDuration` is a separate per-(wallet, hook) deposit throttle.

The Next.js route at `POST /api/pog` ignores any caller-supplied nonce and
reads `factory.pogNonces(sender)` live from chain before signing.

---

## 9. Frontend

```bash
cd soat-frontend
npm install
npm run dev
```

| Route              | Purpose                                              |
|--------------------|------------------------------------------------------|
| `/`                | Directory + genesis dashboard                        |
| `/launch`          | Create a launch (duration picker, client-side mining) |
| `/projects`        | Radar view of all launches                           |
| `/projects/<addr>` | Project terminal: deposit, launch, mint, claim, LP   |
| `/admin`           | Owner command center                                 |

Checks:

```bash
npx tsc --noEmit
npx eslint src --ext .ts,.tsx
```

---

## 10. Security notes

- **Triple price gate on Phase 2.** A mint may not share a block with a swap
  (`SameBlockMintForbidden`, which `launch()` also arms so the launch block
  itself is shut); the reference price is `min(spot, TWAP)` once a full
  `TWAP_WINDOW` has elapsed, and `min(spot, p0)` until then — a two-block pump
  cannot fabricate a ceiling against a stub TWAP; and a shelf only unlocks when
  its price is within 105 % of that reference (`PRICE_CEILING_BPS`).
- **`TWAP_WINDOW` is the oracle's manipulation depth, not a guarantee.** The
  hook keeps two rolling checkpoints rather than a ring buffer, and anyone may
  supply the swap that rolls them, so an attacker who holds a pumped price for
  one window and then pokes with dust drags the average onto it — measured at
  the old 600 s setting, ~10 minutes of hold moved the TWAP to within 0.001 % of
  a manipulated spot. The window is therefore a price, and it is set to 1800 s
  (realised span floats in [30 min, 60 min)) to make that hold cost real money.
  `test_probeB_twapReanchorSpeed` pins the behaviour so a future retune has to
  restate what it bought.
- **The 105 % gate is a ceiling, not a floor.** It refuses shelves priced above
  the market and says nothing about shelves priced below it, so an appreciated
  market leaves the low shelves in the money and profitable to sweep. This is
  deliberate — it is the mechanism by which the ladder tracks a market that has
  moved — and is pinned by
  `test_sweepIsProfitableOnceTheMarketHasRunAhead`. The cost is borne by
  holders, and it caps how far a rally durably runs.
- **Treasury is a one-way valve.** No `withdraw`, `sweep`, `rescue`, or
  `delegatecall`. The only path that moves ETH out is `_buyAndBurn`, whose
  output is hard-wired to `0xdead`. Crucially, `addLadderToken` derives the
  buyback venue from the token's own hook and refuses tokens this platform did
  not launch — without that, the owner could list a token they minted, pair it
  in a pool they alone provide liquidity to, and drain the reservoir one
  trigger at a time.
- **The buyback poke is fault-isolated, and gas-isolated.** `afterSwap` wraps it
  in `try/catch`, so a treasury that does not recognise a hook degrades to "no
  buybacks" instead of reverting every swap and stranding the genesis liquidity.
  `try/catch` alone was not enough, though: it cannot contain an out-of-gas
  child, because the 63/64 rule leaves the caller too little to recover with. So
  the poke is also capped at `gasleft() - PIGGYBACK_TAIL_RESERVE` and skipped
  below `PIGGYBACK_MIN_GAS`, which withholds the swap's remaining work
  physically rather than by estimate. The residual risk moves from "trades
  revert" to "the reservoir idles", and `pokeBuyback()` answers that.
- **Pause is narrow by design.** It stops `createLaunch` and `registerPoG`; it
  does **not** gate `deposit`, because a genesis round fails by missing its soft
  cap and gating deposits would hand the owner a unilateral veto over projects
  the platform already took money for.
- **Genesis liquidity is permanently locked** in the hook, and retail LP
  positions are structurally separate from it.
- **The Immutable Pact: contracts are not upgradeable.** `ToshToken` never
  grants `DEFAULT_ADMIN_ROLE`, so `MINTER_ROLE` is frozen on the project's
  Hook forever. There is no proxy and no `migrateMinter`. A logic bug cannot
  be patched by pointing the token at a v5.1 Hook; unsold ladder supply can
  never be reminted elsewhere. This is the load-bearing decentralisation
  invariant, not an oversight — the launch page's Immutable Pact states it
  in those words.
- **CREATE2 mask `0x20CC`** is enforced on every hook address, so a hook can
  never be deployed with permissions it was not designed for. The extra
  `AFTER_SWAP_RETURNS_DELTA` bit is what lets exact-output buys still fund
  the treasury.

See the natspec in each source file, plus `docs/`:

| Document | What it covers |
|----------|----------------|
| `docs/PRE_MAINNET_CHECKLIST.md` | **What must be true before mainnet.** The canonical gate list, and the definition of the `#N` item numbers cited in code comments. |
| `docs/SECURITY_AUDIT.md` | Audit scope, trust model, test coverage, findings log. |
| `docs/INCIDENT_RESPONSE.md` | Playbooks for when something is already wrong. |
| `docs/ONCHAIN_MONITORING.md` | What to alert on, and why. Config-as-code in `monitoring/alerts.json`, CI-guarded against drift. |
| [`tosh-status/MANUAL_INTERACTION.md`](https://github.com/jayoo101/tosh-status/blob/main/MANUAL_INTERACTION.md) | Driving the protocol with `cast` when the frontend is down. Lives in the public status-page repo, because it is linked to users during an outage and this repository is private. |
| `docs/PRD-v5.0.md` | Product spec, state machine, and the D1–D4 accepted risks. |

---

## 11. Common gotchas

| Symptom                                            | Fix                                                                          |
|----------------------------------------------------|------------------------------------------------------------------------------|
| `createLaunch` reverts `InvalidHookSalt`           | Salt mined against stale `defaultSoftCap` / `maxPogAllocationLimit` / duration. Re-read live values and re-mine. |
| `createLaunch` reverts `FeeChanged`                | Owner moved `launchFee` past your `expectedFee` cap. Re-read and retry.       |
| `createLaunch` reverts `NameTaken`                 | Name/symbol already reserved. If that round died, `releaseAbandonedName(hook)` frees it. |
| `mintBondingCurve` reverts `NotLaunched`           | The creator has not called `launch()` yet.                                    |
| `mintBondingCurve` reverts `SameBlockMintForbidden`| A swap landed in this block. Wait one block.                                  |
| `mintBondingCurve` reverts on the price gate       | The market has not risen to meet the shelf. This is the gate working.         |
| `launch` reverts `LaunchWindowExpired`             | More than 7 days since the deadline; depositors can `refund()`.               |
| `deposit` reverts `QuotaExceeded`                  | Platform-wide PoG budget spent for this window. Wait out `quotaWindowDuration`. |
| `deposit` reverts `PerWalletCapExceeded`           | Per-project cap snapshotted at creation, separate from the PoG budget.        |
| `addLadderToken` reverts `TokenNotLaunchedHere`    | Only tokens launched by the bound factory can be listed.                      |
| `addLadderToken` reverts `InvalidPoolKey`          | The project exists but has not run `launch()`, so it has no pool yet.         |
| Every swap on a pool reverts                       | Check `treasury.factory()` is wired. Historically this bricked pools outright; it now degrades to skipped buybacks. |
| `addLadderToken` reverts `PoolNotLaunched`         | Distinct from `InvalidPoolKey`: the hook exists and its key is well-formed, but `launched()` is still false. |
| Treasury holds ≥ 1 ETH and nothing is being burned | Not a fault. Swaps are skipping the poke on the gas gate. Call `pokeBuyback()` — permissionless, no role needed. This is what `STATE-06` watches for. |
| `pokeBuyback` reverts `NotArmed`                   | Reservoir below `TRIGGER_STEP`, or the ladder roster is empty. Nothing to do.  |
| `pokeBuyback` reverts `PiggybackInProgress`        | A buyback is already mid-flight in this call stack. Retry after it settles.    |

---

## License

MIT — see SPDX headers in each source file.
