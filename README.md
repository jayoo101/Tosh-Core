# Tosh Fair Launchpad v5.0

A 100 % ETH-native fair-launch platform on Uniswap V4: PoG-gated genesis
funding, a discrete fixed-price shelf ladder gated against price manipulation,
a global lifetime referral graph, and a self-driving buy-and-burn treasury that
rides along on ordinary swaps.

> Network: **Base Sepolia (chain 84532)** for testnet, Base mainnet (8453) ready.
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
├── test/                       # forge tests (218 passing)
├── script/
│   ├── Deploy.s.sol            # Base Sepolia (DeployScript)
│   ├── DeployMainnet.s.sol     # Production, with Safe ownership handoff
│   ├── DeployLocal.s.sol       # anvil
│   ├── VerifyDeployment.s.sol  # Post-deploy invariant check (view-only)
│   └── RecomputeInitcodeHash.s.sol
├── scripts/                    # Node tooling
│   ├── mineHookSalt.js         # CLI CREATE2 salt miner
│   ├── extractAbis.js          # out/ → frontend ABI sync
│   └── extractBytecode.js      # out/ → frontend bytecode sync
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
```

Expected: **218 passing**.

After any contract change, re-sync the frontend artifacts:

```bash
node scripts/extractBytecode.js
node scripts/extractAbis.js
```

`forge test` pins this: `test_hookBytecode_inSyncWithArtifact` fails if you
forget.

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
     │ launch fee, 1 % shelf cut,   │ 0.7 % buy-side tax
     │ orphaned referral commission │
     ▼                              ▼
        ToshLadderTreasury  ──buy & burn──▶  0xdead
```

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
| In-flight tax          | 0.7 % | ETH → treasury, tokens → burned  |
| Pool fee               | 0.3 % | third-party LPs (native V4)      |

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

**Buyback.** Every swap pokes `autoPiggybackBuyback()`. Once the treasury holds
1 ETH (`TRIGGER_STEP`), that swap carries a buyback: `max(1 ETH, 10% of
balance)` is split across the next 3 ladder tokens (`BATCH_SIZE`) in
round-robin order, market-bought, and sent straight to `0xdead`.

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
# Base Sepolia
forge script script/Deploy.s.sol:DeployScript \
  --rpc-url $BASE_SEPOLIA_RPC --broadcast --verify \
  --etherscan-api-key $BASESCAN_API_KEY -vvvv

# Local
anvil
forge script script/DeployLocal.s.sol:DeployLocal --fork-url http://127.0.0.1:8545 --broadcast
```

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

### Base Sepolia (84532) periphery

| Contract        | Address                                      |
|-----------------|----------------------------------------------|
| V4 PoolManager  | `0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408` |
| PositionManager | `0x4b2c77d209d3405f41a037ec6c77f7f5b8e2ca80` |
| StateView       | `0x571291b572ed32ce6751a2cb2486ebee8defb9b4` |
| Permit2         | `0x000000000022D473030F116dDEE9F6B43aC78BA3` |

Permit2 is the same canonical address on every chain. For Base mainnet, take
the rest from <https://docs.uniswap.org/contracts/v4/deployments>.

---

## 7. Environment variables

Copy `.env.example` to `.env`. Never commit it.

```dotenv
PRIVATE_KEY=0x...
BASE_SEPOLIA_RPC=https://sepolia.base.org
BASE_MAINNET_RPC=https://mainnet.base.org
BASESCAN_API_KEY=...
V4_POOL_MANAGER=0x05E73354cFDd6745C338b50BcFDfA3Aa6fA03408
POG_SIGNER_ADDRESS=0x...
PLATFORM_TREASURY=0x...
FACTORY_ADDRESS=0x            # filled in after the first deploy
POG_SIGNER_PRIVATE_KEY=0x...  # backend only
```

Frontend (`soat-frontend/.env.local`):

```dotenv
NEXT_PUBLIC_FACTORY_ADDRESS=0x...
NEXT_PUBLIC_CHAIN_ID=84532
NEXT_PUBLIC_POSITION_MANAGER=0x...   # optional; Sepolia fallback is baked in
NEXT_PUBLIC_STATE_VIEW=0x...         # optional; Sepolia fallback is baked in
NEXT_PUBLIC_BASE_SEPOLIA_RPC=https://sepolia.base.org
POG_SIGNER_PRIVATE_KEY=0x...  # server-side only, never NEXT_PUBLIC_
```

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
- **The buyback poke is fault-isolated.** `afterSwap` wraps it in `try/catch`,
  so a treasury that does not recognise a hook degrades to "no buybacks"
  instead of reverting every swap and stranding the genesis liquidity.
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

See `docs/` for the PRD, the long-form security notes, and the incident
response playbook, plus the natspec in each source file.

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

---

## License

MIT — see SPDX headers in each source file.
