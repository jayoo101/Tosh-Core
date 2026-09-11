# Tosh Fair Launchpad v5.0 — Product Requirements Document (PRD)

> **What this document is.** A **reverse-extracted** product requirements document. It is not a design blueprint; it is what falls out of reading the current code in the `Tosh-Core` repository line by line, written so that a product owner can check, claim by claim, whether "the implementation matches what was intended".
>
> **How this was evidenced.** The bulk of it is pure static reading; the later revision passes (including the §8.26–8.31 red-team work and the §8.32–8.34 gas re-check) were run against `forge build` / `forge test`, and every gas number in them comes from an actual `forge test --isolate --gas-report` measurement rather than an estimate. Every constant and function name carries its source file; **most of the early line-number citations have already rotted**, because the clone refactor and storage packing moved a great deal of code around — trust the symbol names, not the line numbers.
>
> **Annotation conventions:**
> - **⚠️ Needs confirmation** — something that objectively exists in the code but may not match product intuition. Every entry is collected in chapter 8.
> - **No basis found in the code** — something I could not find support for in the code, and will not invent.
>
> **Scope reviewed:** `src/` (4 core contracts + 3 libraries), `script/` (5 deployment scripts), `test/` (10 test files, of which `ToshV5*.t.sol` is the v5.0 acceptance suite), `soat-frontend/` (the Next.js dApp).
>
> The three numbers above were once written as 2 libraries and 14 test files — the library count missed `ToshCloneLib.sol`, which the EIP-1167 clone refactor added, and the test-file count is the old value from before the suites were merged into the `ToshV5*` family. Counts like these rot naturally in a document, and they rot without raising an error.

---

## Table of contents

1. [Product overview and positioning](#1-product-overview-and-positioning)
2. [System architecture and role definitions](#2-system-architecture-and-role-definitions)
3. [Token economics and the asset-flow model](#3-token-economics-and-the-asset-flow-model)
4. [Product lifecycle and business flows](#4-product-lifecycle-and-business-flows)
5. [Security and anti-manipulation mechanisms](#5-security-and-anti-manipulation-mechanisms)
6. [Frontend and user-interaction specification](#6-frontend-and-user-interaction-specification)
7. [Appendix: constants, events and error codes](#7-appendix-constants-events-and-error-codes)
8. [Closed items](#8-closed-items)

---

## 1. Product overview and positioning

### 1.1 In one sentence

Tosh Fair Launchpad v5.0 is a **100% ETH-native** fair-launch platform. Each project gets its own dedicated Hook contract on **Uniswap V4** as its launch engine, which puts all three phases — "genesis raise → pool creation and launch → secondary market plus discrete ladder issuance" — on chain, and converts trading friction into deflationary pressure through a **platform-wide buy-and-burn flywheel**.

### 1.2 What problem it solves

The code comments state the design motivation bluntly (`src/ToshLaunchpadHook.sol:41-125`, `src/ToshFactory.sol:20-35`). Restated in product terms:

| # | Problem with the usual launchpad | What v5.0 does | Code reference |
|---|---|---|---|
| 1 | You have to buy the platform token (SATO or similar) before you can take part, which adds a barrier to entry and exposes everyone to whoever is running the platform token | ETH-native end to end: launch fees, genesis deposits, shelf mints, buyback ammunition, refunds — all native ETH. The factory does not even store SATO's address any more | `src/ToshFactory.sol:59-62`; `src/ToshLaunchpadHook.sol:43-46` |
| 2 | The team holds a large pre-mine, a block explorer shows one address holding 100% of supply, and the community will not go near it | On-demand minting. Launch mints only the 8.4M genesis block; the remaining 12.6M is minted trade by trade as the shelves sell | `src/ToshToken.sol:44-60`, `mint` @ `src/ToshToken.sol:168-174` |
| 3 | The team can mint from the cheap end of the curve and dump back into the pool, draining the genesis ETH | Three layers of price gating: a same-block minting ban, a `min(spot, TWAP)` reference price, and a 105% ceiling. Phase 2 is **shut entirely** for the launch block — enforced by `launch()` stamping `lastSwapBlock` itself rather than by boundary arithmetic (see §8.26) | `ToshLaunchpadHook.launch()` / `mintBondingCurve`; tests `test_ladderOpensLockedAtLaunch` + `test_ladderOpensLockedAtLaunch_acrossRaiseSizes` |
| 4 | Genesis participants are underwater the moment the pool opens (opening price ≤ what they paid) | The 55/45 split of genesis supply produces, arithmetically, **exactly 10%** of paper premium at launch; shelf 0 stacks another 5% on top, for 15.5% combined | `GENESIS_CLAIM_SUPPLY` / `GENESIS_LP_SUPPLY` @ `src/ToshLaunchpadHook.sol`; test `test_genesisPremium_isExactlyTenPercent` @ `test/ToshV5.t.sol` |
| 5 | The pool is locked forever, retail neither dares nor is able to LP, and pool fees accrue to a position nobody can claim | v5.0 **removes** `BEFORE_REMOVE_LIQUIDITY` from the address mask (0x22CC → 0x20CC), so retail LPs come and go freely; the genesis position is locked structurally, by "ownership plus the absence of any code path that removes" | `src/ToshLaunchpadHook.sol:129-136`, `1642-1667` (`beforeRemoveLiquidity`); test `test_retailLp_canAddAndRemoveWithoutTouchingGenesis` @ `test/ToshV5.t.sol` |
| 6 | Deflation depends on an off-chain bot harvesting, which carries MEV risk and running costs | Piggyback buybacks: the `afterSwap` of a trade on a Tosh pool buys a slice and burns it to `0xdead` on its way out, **when there is gas to spare**; one leg per trade, with `max(1 ETH, 10% of balance)` divided by `BATCH_SIZE` to spread the spend. No off-chain component — but also no guarantee any longer that a trade will carry a buyback with it; the backstop is the permissionless `pokeBuyback()` (see §4.9, 8.32) | `afterSwap` @ `src/ToshLaunchpadHook.sol`; `autoPiggybackBuyback` / `pokeBuyback` @ `src/ToshLadderTreasury.sol` |
| 7 | The platform treasury can be drained by the owner | The treasury is a **one-way valve**: no `withdraw` / `sweep` / `rescue` / `delegatecall`, and the recipient on its only outbound path, `_buyAndBurn`, is hard-coded to `0xdead` | `src/ToshLadderTreasury.sol:129`, `522-567` |

### 1.3 Target users

| User | What they want | What the product gives them |
|---|---|---|
| **Project creator (creator)** | To launch a token with a real pool and credible rules at minimum cost | A 0.01 ETH launch fee; three genesis durations to choose from; 99% of shelf revenue to `projectAdmin`; the rules frozen into immutables at deployment |
| **Genesis depositors** | An early low price plus definite downside protection | A structural 10% launch premium; a 100% penalty-free refund if the soft cap is missed or the 7-day zombie window times out |
| **Secondary-market traders** | A pool with depth and no hidden rake | Full-range genesis liquidity locked permanently; total friction of **1.30%** (0.30% to LPs + 1.00% protocol tax, of which 0.70% is buy-and-burn and 0.30% platform revenue) |
| **Retail LPs** | To earn pool fees without being locked in | The 0.30% pool fee is settled natively by V4; withdraw whenever you like; the UI ships a minimal full-range panel |
| **Referrers** | A cut for bringing people in | A platform-wide lifetime binding: 10% of **every** genesis deposit the referee ever makes goes to the referrer (⚠️ see 8.3: the official UI does not currently pass a referrer) |
| **Platform owner** | A platform that can be operated but cannot misbehave | Can tune the launch fee / soft cap / quotas / cooldown / blacklist / pause / buyback curation; **cannot** move a single wei of anyone's money |

### 1.4 How this differs from the usual launchpad, in summary

- **Not bonding-curve-only.** v5.0 has a **real Uniswap V4 pool** — created the moment Phase 1 ends — and the ladder shelf (Phase 2) is a primary issuance channel running **in parallel with the pool**, gated in reverse by the pool's own price. That is a structurally different thing from the pump.fun pattern of "trade inside the curve, create the pool only on graduation".
- **Not a continuous tan(z) curve.** v4.x's Taylor-expanded tangent curve is deleted and replaced by 4000 **discretely priced shelves** (`TIER_COUNT = 4000`, 3,150 tokens per tier, +0.19025% between tiers, spanning 2000× end to end). The price is evaluated in closed form by fast exponentiation rather than by repeated multiplication, which avoids 4000 rounds of truncation drift (`src/ToshLaunchpadHook.sol`).
- **Sell pressure is burned outright.** On the sell side, **1.0%** of the tokens are `take`n straight to `0xdead` inside `beforeSwap` — they never enter the reservoir, need no buyback round trip, and **are not shared with the platform** (`_skimInputTax` @ `src/ToshLaunchpadHook.sol`).
- **Most of the platform's income is not profit, but it is no longer all of it.** Three pipes — launch fees, the 1% shelf slice, and orphaned referral commission — **still flow 100%** into `ToshLadderTreasury`, where the only permitted use is buy-and-burn. The 1.0% ETH tax on the buy side, however, is **split 70/30**: 70 bps to `ToshLadderTreasury` (exactly as much as before the split) and 30 bps to `platformTreasury` as platform maintenance revenue (`PLATFORM_SWAP_FEE_BPS` @ `src/ToshLaunchpadHook.sol`, `src/ToshLadderTreasury.sol:23-29`).

  > **This line used to read "all four pipes flow into `ToshLadderTreasury`, where the only permitted use is buy-and-burn", and that sentence is now false.** It is the load-bearing trust claim of the entire design, so it gets no careful wording here: the platform now takes 30 bps of ETH out of every buy as its own revenue, and that money is not bought back, not burned, and is the platform's to spend. The absolute amount reaching the buyback engine has not changed (still 70 bps of the buy); what changed is that a trader's total friction went from 1.00% to 1.30% — the extra 30 bps is new, not moved out of the buyback. The full decision and what it costs are in §2.2.5.1.

---

## 2. System architecture and role definitions

### 2.1 Where each of the four contracts' responsibilities end

```
                             ┌────────────────────────────────────────────┐
                             │    Platform singletons (one per chain)     │
                             └────────────────────────────────────────────┘

   ┌──────────────────────────────────┐   setFactory (one-shot)   ┌────────────────────────────────────┐
   │           ToshFactory            │──────────────────────────▶│         ToshLadderTreasury         │
   │  Ownable2Step + Pausable         │                           │            Ownable2Step            │
   │  + ReentrancyGuard               │◀──registeredHooks()───────│  (one-way valve / buyback engine)  │
   │                                  │◀──tokenToHook()───────────│                                    │
   │ · createLaunch (CREATE2)         │                           │ · receive() — ETH from four pipes  │
   │ · registerPoG (signed quota)     │    launchFee(0.01 ETH)    │ · addLadderToken curation (owner)  │
   │ · deposit — genesis gateway      │──────────────────────────▶│ · autoPiggybackBuyback(onlyHook)   │
   │ · globalReferrers referral graph │                           │ · pokeBuyback() permissionless     │
   │ · blacklist / cooldown / pause   │                           │ · unlockCallback → _runPiggyback   │
   │                                  │                           │ · _buyAndBurn → 0xdead             │
   │                                  │                           │ · piggybackActive() transient lock │
   └──────────┬───────────────────────┘                           └─────────────┬──────────────────────┘
              │ CREATE2 clone (EIP-1167, 121 bytes)                             │ swap/settle/take
              │ + initializeToken                                               │ (borrowed frame, or its own unlock)
              ▼                                                                 ▼
   ┌─────────────────────────────────────────────────────────────┐   ┌──────────────────────┐
   │            ToshLaunchpadHook (one per project)              │──▶│  Uniswap V4          │
   │            IHooks + IUnlockCallback                         │◀──│  PoolManager         │
   │                                                             │   │  (ETH / TOKEN pool)  │
   │  Phase 1 · deposit / refund / launch                        │   └──────────────────────┘
   │  Phase 2 · mintBondingCurve / quoteMint                     │              ▲
   │            claimGenesis / claimReferralReward               │              │ 0.30% pool fee
   │  Hook callbacks · beforeInitialize / beforeSwap             │              │ to LPs (retail included)
   │                   afterSwap / beforeRemoveLiquidity         │              │
   │  Hook-local TWAP oracle (V4 core has no observation buffer) │              │
   └──────────┬──────────────────────────────────────────────────┘              │
              │ mint() (sole MINTER_ROLE)                                       │
              ▼                                                                 │
   ┌─────────────────────────────────────────────────────────────┐              │
   │            ToshToken (one per project)                      │──────────────┘
   │            ERC20 + AccessControl                            │
   │  MAX_SUPPLY = 21,000,000e18 (hard-checked on every mint)    │
   │  DEFAULT_ADMIN_ROLE never granted → nobody can change roles │
   └─────────────────────────────────────────────────────────────┘

   Helper libraries (stateless):
   · src/libraries/HookDeployLib.sol — DELEGATECALLed by the factory; isolates the hook creationCode
     so the factory stays inside EIP-170's 24KB; provides deployHook / computeInitcodeHash
   · src/libraries/HookMiner.sol     — CREATE2 address prediction + V4 mask check (REQUIRED_FLAGS = 0x20CC)
```

**Key call relationships (in chronological order)**

| # | Caller → callee | Function | Notes | Line |
|---|---|---|---|---|
| 1 | Deployer → Treasury | `constructor` | Must be deployed before the factory (which takes it as an immutable constructor argument) | `script/Deploy.s.sol:51` |
| 2 | Deployer → Factory | `constructor(poolManager, pogSigner, platformTreasury, ladderTreasury)` | Also computes `HOOK_CREATION_CODEHASH`, and DELEGATECALLs `HookDeployLib.deployImplementation` to burn `platformTreasury` into the hook implementation's `platformFeeRecipient` immutable at the same time. **The two addresses come from one source, both are immutable, and neither has a setter** — this is the only structural guarantee against "the factory reads the new address while swaps keep paying the old one" | `src/ToshFactory.sol` |
| 3 | owner → Treasury | `setFactory` | **One-shot**; closes the loop. Leave the loop open and every buyback silently does nothing | `src/ToshLadderTreasury.sol` |
| 4 | creator → Factory | `createLaunch{value: fee}` | CREATE2-deploys the hook clone → CREATE-deploys the token clone → `token.initialize(hook, name, symbol)` → `hook.initializeToken(token, projectAdmin)` | `src/ToshFactory.sol` |
| 5 | Depositor → Factory → Hook | `deposit{value}` → `hook.deposit(user, boundReferrer)` | Eligibility checks all live in the factory, bookkeeping all lives in the hook | `src/ToshFactory.sol` → `src/ToshLaunchpadHook.sol` |
| 6 | creator → Hook → PoolManager | `launch()` → `initialize` + `unlock` → `unlockCallback` → `modifyLiquidity` | Pool creation plus the injection of full-range genesis liquidity | `launch` / `_addInitialLiquidity` @ `src/ToshLaunchpadHook.sol` |
| 7 | Any trader → PoolManager → Hook | `beforeSwap` / `afterSwap` | Skim the tax, write the oracle, poke the piggyback | `beforeSwap` / `afterSwap` @ `src/ToshLaunchpadHook.sol` |
| 8 | Hook → Treasury | `autoPiggybackBuyback{gas: avail - TAIL_RESERVE}()` (wrapped in `try/catch`, and only attempted when `gasleft() >= PIGGYBACK_MIN_GAS`) | Fault isolation plus gas isolation: a treasury that blows up must not blow up the trade, and an expensive buyback must not push the trade out of gas (8.32) | `afterSwap` @ `src/ToshLaunchpadHook.sol` |
| 8b | **Any address → Treasury** | `pokeBuyback()` → `poolManager.unlock("")` → `unlockCallback` | The permissionless liveness backstop. The gas gate in step 8 means trades no longer guarantee that the reservoir gets drained, and this is the only outlet that does not depend on a swap | `pokeBuyback` @ `src/ToshLadderTreasury.sol` |
| 9 | Treasury → PoolManager | `swap` / `sync` / `settle` / `take` | The piggyback path **does not call `unlock`** (it is already inside someone else's frame); the `pokeBuyback` path **opens its own frame**, because there is no swap to borrow | `_buyAndBurn` @ `src/ToshLadderTreasury.sol` |
| 10 | Treasury → Factory | `registeredHooks` / `tokenToHook` | Authenticate where a poke came from; validate the provenance of a curated token | `onlyHook` / `addLadderToken` @ `src/ToshLadderTreasury.sol` |
| 11 | Treasury → Hook | `getPoolKey()` / `launched()` | The venue for a buyback is looked up from the hook, **not supplied by the owner**; after storage packing, `launched()` is the only reliable way to tell whether a project has launched | `addLadderToken` @ `src/ToshLadderTreasury.sol` |

### 2.2 Role permission inventory

#### 2.2.1 Platform owner (`ToshFactory` + `ToshLadderTreasury`, Ownable2Step)

| Can do | Function | Constraint | Line |
|---|---|---|---|
| Pause / resume the factory | `pause` / `unpause` | **Affects only two entry points, `createLaunch` and `registerPoG`.** `deposit` has no `whenNotPaused` — a genesis round already under way keeps taking money (⚠️ 8.12) | `src/ToshFactory.sol` |
| Halt / resume the ladder | `haltLadderMinting` / `resumeLadderMinting` | **The only brake that reaches a launched project**, and it reaches nothing but `mintBondingCurve`. Each halt is `≤ MAX_HALT_DURATION = 7 days` and expires on its own (`HaltDurationTooLong`); `hook == address(0)` halts everything, otherwise only that project. It does not affect swaps / LP / `claimGenesis` / `claimReferralReward` / `refund` — **it can cost a buyer an opportunity, it cannot cost anyone a balance**. See §11 D3 | `src/ToshFactory.sol` `haltLadderMinting` |
| Rotate the PoG signer | `setPogSigner` | Non-zero | `src/ToshFactory.sol` |
| ~~Rotate `platformTreasury`~~ | ~~`setPlatformTreasury`~~ | **Deleted.** That address now receives 30 bps of ETH from every buy, and a mutable fee-flow target is precisely audit finding M-2; so it became `immutable`, and rotating it means redeploying the factory (see §2.2.5) | — |
| Adjust the launch fee | `setLaunchFee` | Zero is allowed; protected by the caller's `expectedFee` slippage check | `src/ToshFactory.sol` |
| Adjust the re-deposit cooldown | `setCooldownDuration` | `≤ MAX_COOLDOWN = 7 days`; at 0 the per-(wallet, hook) throttle is simply off. It does **not** govern the PoG quota window (⚠️ 8.25) | `src/ToshFactory.sol` |
| Adjust the PoG quota window | `setQuotaWindowDuration` | `≤ MAX_COOLDOWN = 7 days`; a **separate dial** from the cooldown, and the one whose 0 matters: at 0 there is nothing to anchor a refill to and the quota degenerates into a lifetime budget (⚠️ 8.25) | `src/ToshFactory.sol` |
| Adjust the default soft cap | `setDefaultSoftCap` | `≥ MIN_SOFT_CAP_PROD = 0.01 ether`, to keep `p0` from truncating to 0 | `src/ToshFactory.sol` |
| Adjust the per-wallet cap | `setMaxPogAllocationLimit` | **Must be non-zero** (`InvalidPogLimit`); affects only projects created afterwards. The value is snapshotted into every new hook's constructor, and that constructor requires `_perWalletCap > 0`, so zeroing it wrecks `createLaunch` platform-wide with `DeployFailed` — to stop accepting projects, use `pause()` (see §8.27) | `src/ToshFactory.sol` `setMaxPogAllocationLimit` |
| Blacklist / unblacklist in bulk | `setBlacklist` / `liftBlacklist` | ≤ 200 per batch; `banDuration == type(uint256).max` means permanent | `src/ToshFactory.sol` |
| Curate the buyback ladder | `addLadderToken` / `removeLadderToken` | The token must be registered with this platform's `tokenToHook` and already launched | `src/ToshLadderTreasury.sol` |
| Bind treasury ↔ factory | `setFactory` | One-shot, cannot be re-pointed | `src/ToshLadderTreasury.sol` |

| **Cannot do** | Why |
|---|---|
| Take any ETH out of the treasury | The treasury has no `withdraw`/`sweep`/`rescue`/`delegatecall`; the only outbound path, `_buyAndBurn`, has `0xdead` hard-coded as its recipient (`src/ToshLadderTreasury.sol:522-567`). Test `test_ladderTreasury_hasNoWithdrawPath` @ `test/ToshV5.t.sol` |
| Point buyback money at a pool they control | `addLadderToken` accepts only launched tokens from this platform, and the pool key is looked up from the hook (`src/ToshLadderTreasury.sol`). Test `test_ladderTreasury_ownerCannotRedirectSpendToOwnPool` @ `test/ToshV5.t.sol` |
| Change the economic parameters of a launched project | `softCap` / `perWalletCap` / `genesisDuration` are all hook immutables, snapshotted at creation (`src/ToshLaunchpadHook.sol`). Test `test_setDefaultSoftCap_doesNotAffectExistingHooks` @ `test/ToshV5Factory.t.sol` |
| Change `ToshToken`'s roles | `DEFAULT_ADMIN_ROLE` was never granted to anyone, so `grantRole`/`revokeRole` are permanently unusable (`constructor` / `initialize` @ `src/ToshToken.sol`) |
| **Block** any particular buyback | `autoPiggybackBuyback` accepts calls only from registered hooks (`onlyHook`), and the owner calling it directly reverts with `OnlyHook`; `pokeBuyback()` is permissionless, so the owner cannot stop anyone from triggering it. Test `test_autoPiggybackBuyback_rejectsNonHookCallers` @ `test/ToshV5.t.sol` |
| Pause **trading** on a launched project (swaps / LP / claims / refunds) | No switch reaches it (⚠️ 8.12) |

#### 2.2.2 Project creator (creator)

- **Is:** the `msg.sender` of `createLaunch`, written into the hook's `creator` immutable (`src/ToshLaunchpadHook.sol`).
- **Sole exclusive power:** calling `launch()` to open the pool (`src/ToshLaunchpadHook.sol`, `OnlyCreator`).
- **Cannot:** change `projectAdmin` (that is `projectAdmin`'s own power), launch early (`block.timestamp >= genesisDeadline` is required, ⚠️ 8.7), refund themselves, or remove genesis liquidity.
- Takes part in deriving the CREATE2 salt: `finalSalt = keccak256(abi.encode(msg.sender, hookSalt))` (`createLaunch` @ `src/ToshFactory.sol`), so **the salt is bound to the creator** — a salt somebody else mined is worthless to you.

#### 2.2.3 Project admin (projectAdmin)

| Can do | Function | Line |
|---|---|---|
| Claim 99% of Phase-2 shelf revenue | Received passively (`_sendEth` inside `mintBondingCurve`) | `src/ToshLaunchpadHook.sol` |
| Hand the role to a new wallet / multisig | `changeProjectAdmin(newAdmin)` | `src/ToshLaunchpadHook.sol` |

- **Cannot:** mint tokens (the sole `MINTER_ROLE` is the hook itself), touch genesis ETH, touch the genesis LP, or launch.
- Is the **only mutable** payout address in the hook (every other one is immutable).

#### 2.2.4 Project treasury (projectTreasury)

- A constructor argument, `require`d non-zero, written into an immutable (`constructor` / `projectTreasury` @ `src/ToshLaunchpadHook.sol`).
- **⚠️ 8.1: nowhere in the contracts does anything transfer to `projectTreasury`, or even read it.** Its entire function is (a) to be one member of the CREATE2 initcode tuple and therefore to influence the hook address, and (b) to serve as on-chain-readable "project multisig" metadata. The frontend hard-binds it to the creator's connected wallet and renders it read-only (`soat-frontend/src/app/launch/page.tsx:468`, `622-629`).

#### 2.2.5 Platform treasury (platformTreasury)

- An **immutable** constructor argument of the factory (`platformTreasury` @ `src/ToshFactory.sol`), with **no setter**.
- **Receives 0.30% of the ETH input of every buy** (`PLATFORM_SWAP_FEE_BPS` @ `src/ToshLaunchpadHook.sol`), which is the platform's only income not promised to buy-and-burn. **⚠️ 8.2 closes as a result** — this address genuinely used to sit on no money path at all, and that statement no longer holds.
- Launch fees, the Phase-2 1% shelf slice, and orphaned referral commission **still go entirely** through `ladderTreasury`; not a wei of them lands here.
- **The sell side gives it nothing.** A sell's input is the project's own token, and the full 1.0% is burned — the reasoning is in §2.2.5.1.
- The same address has a second immutable copy inside the hook implementation, `platformFeeRecipient` (burned in by `HookDeployLib.deployImplementation` from the same constructor argument). **The hook's copy is the one that actually gets paid; the factory's copy is only a readable record.** The two must be equal, and `script/VerifyDeployment.s.sol` and `test_platformTreasury_matchesHookPlatformFeeRecipient` each pin that once.
- **It must accept ETH unconditionally.** The hook pays it by native transfer via `poolManager.take`, and that path has **no fault isolation** (unlike `autoPiggybackBuyback`, which has its `try/catch`): a `receive()` that reverts does not mean one missed fee, it means **every buy in every pool on the platform fails**. A multisig (Safe) is fine; a `receive()` with conditional logic in it is not.
- It still doubles as the sentinel filler address in `getLiveHookInitcodeHash` (`src/ToshFactory.sol`), but that is no longer the reason it exists.

##### 2.2.5.1 Decision record: the buy-side tax goes 0.70% → 1.00% and splits 70/30

**What changed.** `TAX_BPS` went from 70 to 100. `POOL_FEE` is untouched, still 0.30% and still entirely to third-party LPs. The 1.00% on a buy (ETH as input) is split into two `take`s: 70 bps to `ladderTreasury`, 30 bps to `platformFeeRecipient`. The 1.00% on a sell (the token as input) is **not** split and burns in full to `0xdead`.

**The cost, stated plainly.** A trader's total friction rises from **1.00% to 1.30%**. That is a real increase in user cost, not a change of accounting convention. The buyback engine's take has not shrunk (still 70 bps of the buy, and `TRIGGER_STEP` still fires at roughly 143 ETH of buy volume); the extra 30 bps is added to the trader's bill outright. The §1.4 promise that "platform income is not profit" is therefore **partly void**, and this document has rewritten that line directly rather than talking its way around it.

**Why the sell side is not split.** A sell's input is the project's own token. Handing the platform a proportional cut would have it steadily accumulating an illiquid position in every single project — projects it is supposed to stay neutral about, and positions it could ultimately only realise by dumping them back into their own pools. Burning the whole thing keeps two things at once: the sell side stays purely deflationary, and the platform's books hold nothing but ETH.

**Why the payout address is immutable.** In v4.x this field was mutable and it collected fees, which is exactly audit finding **M-2** (the factory owner can redirect a live fee stream). v5.0 rerouted all platform income to `ladderTreasury`, and M-2 was closed by **cutting off the inflow**. The inflow is back, so this time what gets cut off is the **mutability**: `setPlatformTreasury` is deleted and the field is `immutable`. There is a second reason, which is to prevent divergence — the hook implementation burns the same address into its own `platformFeeRecipient` at construction, and if the factory's copy were mutable, an operator could change the factory, read back the new value, and have every swap still paying the old address, with nothing on chain to contradict them. **One address, set once, agreeing in both places.**

**What did not change.** The base asymmetry between exact-input and exact-out is still there (exact-output's effective rate is 100/1.01 = 99.0 bps). That gap widened from 0.5 bps to 1 bps as the rate rose, and it remains inside the range where it is not worth an extra division — the reasoning is in `TAX_BPS`'s natspec.

#### 2.2.6 Genesis depositor

| Can do | When | Function | Line |
|---|---|---|---|
| Deposit | Inside the genesis window, with PoG quota, not blacklisted, not in cooldown, not over the per-wallet cap | `factory.deposit{value}(hook, referrer)` | `src/ToshFactory.sol` |
| Refund in full | The soft cap was missed, or the 7-day zombie window has passed | `hook.refund()` | `src/ToshLaunchpadHook.sol` |
| Claim a pro-rata share of the 4,620,000 tokens | After launch, once | `hook.claimGenesis()` | `src/ToshLaunchpadHook.sol` |

- **Cannot:** claim twice (the `genesisShareClaimed` boolean), claim after refunding (`refund` requires `!launched`, so the two paths are mutually exclusive), or refund after launch.

#### 2.2.7 Secondary-market trader

- Swaps on the V4 pool like anyone else. Each swap pays **1.30%** in friction: 0.30% `POOL_FEE` to LPs (settled natively by V4), and 1.00% `TAX_BPS` to the protocol (`POOL_FEE` / `TAX_BPS` @ `src/ToshLaunchpadHook.sol`). Where the protocol's 1.00% goes depends on direction: a **buy** splits it into 0.70% for the buyback reservoir plus 0.30% of platform revenue; a **sell** burns the whole 1.00% and splits nothing (`PLATFORM_SWAP_FEE_BPS`, see §2.2.5.1).
- No whitelist, no quota, no cooldown, no blacklist — the pool layer is wide open (the blacklist only bites on `factory.deposit`).

#### 2.2.8 Referrer

- The binding lives in the factory's `globalReferrers`: **platform-wide, for life, written exactly once** (`ToshFactory.globalReferrers` / `_recordReferral`).
- **Four** silent-rejection paths (they do not revert, so a dead link cannot become a denial of service; and a rejected binding is not a rejected deposit — the commission falls into `orphanReferral` and becomes buyback fuel): already bound / referrer is the zero address / self-referral / **the referrer has no PoG quota of their own** (`ToshFactory._recordReferral`).
- The last of those is an anti-sybil measure added late in v5.0. `referrer != user` is only one address deep: a second wallet of your own gets you back 10% of every deposit, and that wallet originally needed no quota, no deposit, and no history at all. Requiring `pogQuota[referrer] > 0` **does not stop** a determined sybil (nothing on chain can); what it does is move the judgement to the only place capable of making it — the PoG oracle: every alt has to clear the same attestation a depositor does, and the signer can price it, rate-limit it, or refuse to sign off chain. This is a cost, not a wall (see §8.28). Test `test_probeJ_referralSelfFarmViaSecondWallet`.
- Commission = 10% of each genesis deposit the referee makes, credited to `referralAccrued` at `deposit` time and withdrawable after launch (`deposit` / `claimReferralReward` @ `src/ToshLaunchpadHook.sol`).
- **A failed genesis owes the referrer nothing:** refunds return 100%, commission is only ever really honoured at `launch()`, and `referralAccrued` simply becomes permanently unclaimable (`refund` @ `src/ToshLaunchpadHook.sol`).

#### 2.2.9 Retail LP

- Uses **their own** V4 position (or that of the router/posm they went through) and is free to `modifyLiquidity` up or down (`beforeRemoveLiquidity` @ `src/ToshLaunchpadHook.sol`).
- Earns the 0.30% pool fee, credited to the position natively by V4; Tosh has no distribution code.
- **Cannot** touch the genesis position: V4 keys positions to `msg.sender`, the genesis position belongs to the hook, and the hook's `unlockCallback` only ever recognises `ACTION_ADD_LIQUIDITY` (`unlockCallback` @ `src/ToshLaunchpadHook.sol`). Test `test_genesisLiquidityIsPermanentlyLocked` @ `test/ToshV5.t.sol`.

---

## 3. Token economics and the asset-flow model

### 3.1 Supply split

| Layer | Constant | Amount | Share of 21M | Purpose | Line |
|---|---|---|---|---|---|
| Hard cap | `ToshToken.MAX_SUPPLY` | 21,000,000e18 | 100% | checked on every `mint` | `src/ToshToken.sol` |
| Genesis block | `GENESIS_SUPPLY` | 8,400,000e18 | 40% | minted to the hook in a single call at launch | `src/ToshLaunchpadHook.sol` |
| ├ Claim side | `GENESIS_CLAIM_SUPPLY` | 4,620,000e18 | 22% (**55%** of the genesis block) | claimed by depositors pro rata to what they put in | `src/ToshLaunchpadHook.sol` |
| └ Pool side | `GENESIS_LP_SUPPLY` | 3,780,000e18 | 18% (**45%** of the genesis block) | injected full-range into the pool and locked permanently | `src/ToshLaunchpadHook.sol` |
| Phase-2 ladder | `BONDING_MAX = TIER_COUNT × TIER_SIZE` | 12,600,000e18 | 60% | 4000 tiers × 3,150 tokens | `src/ToshLaunchpadHook.sol` |

The arithmetic closes: 8,400,000 + 12,600,000 = 21,000,000, exactly the hard cap. Test `test_supplyPartitioning` @ `test/ToshV5Guards.t.sol`.

**40 / 60 instead of 20 / 80 is the master knob for suppressing early inflation.** Equal-sized shelves release a `log(R)/log(SPAN)` **fraction** of Phase-2 at a market price of `R×`, and that fraction depends only on the span, not on how large Phase-2 is. So the only way to reduce the **absolute number of tokens** thrown at the market on the way up is to shrink Phase-2 itself and hand the difference to the genesis block — that supply is already priced and already circulating at launch, and constitutes no new sell pressure. Three generations of configuration, compared at the 2× point:

| Configuration | Released at 2× | Share of `GENESIS_SUPPLY` |
|---|---|---|
| 20/80 + 1000× span | 1,688,400 | 40.2% |
| 20/80 + 2000× span | 1,533,000 | 36.5% |
| **40/60 + 2000× span (current)** | **1,149,750** | **13.7%** |

**⚠️ Mind that denominator.** `GENESIS_SUPPLY` is 8.4M, but **3.78M of it is sealed permanently inside the genesis LP position** — the hook holds that position and has no code path that removes liquidity — supply that exists but never trades. The percentages above are good for comparing the three **configurations** against each other; they are not an answer to "how much does the market have to swallow". Against the genuinely tradable float:

| Denominator at 2× | Tokens | Share |
|---|---|---|
| `GENESIS_SUPPLY` (8.4M, locked LP included) | 1,149,750 | 13.7% |
| The 4.62M claim float — the part that actually trades | 1,149,750 | **24.9%** |
| Total float after release (4.62M + 1.15M) | 1,149,750 | **19.9%** |

So 40/60 is a real improvement on 20/80 (36.5% → 13.7% is a like-for-like comparison), but at twice the launch price the market still has to absorb **roughly a fifth to a quarter of the active float**. If ~10% of float is a hard target, the span or the split has to move again (see §11, open decision D1).

Pinned by `test_earlyReleaseSchedule_isSetByTheSupplySplit` @ `test/ToshV5.t.sol`: 2× unlocks exactly 365 tiers = 1,149,750 tokens, **asserted against all three denominators at once**, so touching any one knob forces a fresh account of the other two — a change that improves the headline number while making the float number worse fails here rather than shipping.

The 10% opening premium is **unaffected**: it is set by the **ratio** 55 : 45 against the 10% referral commission (`(0.9 / 3.78) × 4.62 = 1.10`), and is independent of the absolute size of the genesis block.

> **⚠️ 8.16**: `ToshToken`'s comment still said Phase-2 was "asymptotic to BONDING_MAX … converges to (but never reaches) MAX_SUPPLY". That is a property of the v4.0 tangent curve. v5.0's discrete ladder is **4000 × 3,150 = 12.6M, exactly clearable**, so total supply **can genuinely reach** 21M. (The comment was corrected as part of this change.)

### 3.2 Funds flow: genesis raise → the pool

```
  Total depositor contributions  R  =  totalEthDeposited
        │
        ├─── 10% (REFERRAL_BPS = 1000) carved off every deposit in deposit
        │      ├── with referrer  → referralAccrued[referrer] += 10% (claimable after launch)
        │      └── no referrer    → orphanReferral += 10%
        │                           └── forwarded in full to ladderTreasury at launch() (buyback ammunition)
        │
        └─── 90%  =  lpEth  =  R − (totalReferralReserved + orphanReferral)
                 │
                 └── injected full-range into the V4 pool with GENESIS_LP_SUPPLY (3.78M), locked permanently
```

Where the code lives: the commission is carved in `deposit`; `lpEth` is computed and the orphaned commission transferred out in `launch`; pool creation injects in `_addInitialLiquidity` — all in `src/ToshLaunchpadHook.sol`. Test `test_orphanReferralIsForwardedToLadderTreasuryAtLaunch` @ `test/ToshV5.t.sol`.

**The key point**: referrer or no referrer, from the pool's point of view **only ever 90% goes in**. That is the precondition for the 10% premium being a structural constant rather than something that floats with the referral rate.

### 3.3 Pricing: p0, shelfP0, and where the 10% premium comes from

```
p0      = lpEth × 1e18 / GENESIS_LP_SUPPLY            // launch() @ src/ToshLaunchpadHook.sol
shelfP0 = p0 × SHELF_PREMIUM_BPS / 10000
        = p0 × 10500 / 10000
        = p0 × 1.05                                    // launch() @ src/ToshLaunchpadHook.sol
```

**The arithmetic behind the 10% premium** (already given in the contract comments, `GENESIS_CLAIM_SUPPLY` / `GENESIS_LP_SUPPLY` @ `src/ToshLaunchpadHook.sol`):

```
Depositor cost basis   P_raise = R / GENESIS_CLAIM_SUPPLY = R / 4,620,000
Pool opening price     p0      = 0.9R / GENESIS_LP_SUPPLY  = 0.9R / 3,780,000

p0 / P_raise = (0.9 / 1.89) × 2.31 = 1.10   (exact)
```

That is: **the 55/45 split plus the 10% referral rate — those three numbers together determine this 1.10**. Move any one of them and the premium moves. The test pins the **relationship** rather than a hard-coded price, using `assertApproxEqRel(…, 1e12)`, and checks alongside it that `shelfP0 = 1.155 × cost basis` (`test_genesisPremium_isExactlyTenPercent` @ `test/ToshV5.t.sol`).

**Why the shelf sits another 5% higher** (`SHELF_PREMIUM_BPS` / `PRICE_CEILING_BPS` @ `src/ToshLaunchpadHook.sol`):

- `SHELF_PREMIUM_BPS` is **deliberately set equal to** `PRICE_CEILING_BPS` (both 10500). The 1.05 on each side of the gating condition `shelfP0 · STEP^i ≤ REF × 1.05` therefore cancels, and the condition collapses to:

  ```
  shelf i unlocks  ⟺  REF ≥ p0 · STEP^i
  (REF = min(spot, TWAP) once the window has matured; min(spot, p0) before that)
  ```

- Three consequences:
  1. **The opening exposure collapses to nothing**. Were the shelf level with the pool, the ceiling would leave shelves 0..25 (81,900 tokens — `ln(1.05)/ln(STEP) ≈ 25.7`, so 26 shelves of 3,150) mintable in the launch block. One notch above it, only shelf 0 can ever be in range at the open. **What actually shuts the launch block, though, is not this arithmetic but the same-block mint lockout**: at launch `spot == p0` only up to the truncation in `_toSqrtPriceX96` / `_sqrtPriceToEthPerToken`, and the gate's `>` is strict, so shelf 0 sits precisely *on* the boundary and is admitted or refused according to which side of `p0` the round-tripped spot lands — a function of the raise size, not of the design (this is §8.26). So `launch()` stamps `lastSwapBlock` itself, and `mintBondingCurve` and `maxMintable()` both read that stamp: Phase 2 is closed outright for the launch block at **every** raise size, and lifts from the next block, only once the market holds at or above the genesis price. Measured, `maxMintable() == 0` — see `test_ladderOpensLockedAtLaunch` and `test_ladderOpensLockedAtLaunch_acrossRaiseSizes` @ `test/ToshV5.t.sol`.
  2. **Mint-and-dump loses money along the whole ladder**, because the buyer always pays 5% over market (test `test_sweepAndDumpIsLossMaking` @ `test/ToshV5.t.sol`, which asserts a loss > 5% of cost).
  3. Stacked on the genesis premium, shelf 0 = depositor cost × 1.155, so Phase-2 issuance never cuts below the genesis depositors' cost line.

  > **⚠️ 8.9**: That "cancellation" means shelves in fact unlock **flush with the market price**, not "only once the price is 5% above market". The nominal 5% is a minting premium (against the market price at the same instant), not an unlock buffer. It protects against the instantaneous arbitrage of "mint, then dump immediately"; it does **not** protect against the lagged arbitrage of "the price runs up first and the low shelves become deep in the money" (see 5.6).

### 3.4 Ladder geometry

| Parameter | Value | Meaning | Line |
|---|---|---|---|
| `TIER_COUNT` | 4000 | number of tiers | `src/ToshLaunchpadHook.sol` |
| `TIER_SIZE` | 3,150e18 | quota per tier (4000 × 3,150 = 12.6M) | `src/ToshLaunchpadHook.sol` |
| `TIER_STEP_E18` | `1_001_902_508_266_805_824` | step (1e18 fixed point) | `src/ToshLaunchpadHook.sol` |
| Rise per tier | +0.19025% | `STEP − 1` | same as above |
| Span end to end | ≈ 2000× | `STEP^3999 ≈ 2000` | `src/ToshLaunchpadHook.sol` |
| How it is evaluated | `tierPriceAt(i) = mulDiv(shelfP0, STEP^i, 1e18)`, exponentiation by squaring, O(log i) | about 12 `mulDiv` pairs at the top tier, rather than 3999 successive multiplications | `src/ToshLaunchpadHook.sol` |
| Tiers crossable per transaction | `MAX_TIERS_PER_TX = 32` | **a gas limit, not a safety limit**; sized against `ln(1.05)/ln(STEP) ≈ 25.7` so that the 105% ceiling, and not the leg count, is the binding constraint | `src/ToshLaunchpadHook.sol` |

**Why the span is 2000× and not 1000×**: release under equal-sized shelves goes as `log(R)/log(SPAN)` — the market has to reach `SPAN^x` before an `x` **fraction** of the ladder unlocks. The span is the only knob that lowers early inflation without touching the supply split, but the logarithm flattens it: the denominator goes from `ln 1000 = 6.91` to `ln 2000 = 7.60`, which buys about a 9% improvement. The real work is done by the 40 / 60 supply split (see 3.1); the span merely shaves one more cut off the top.

The release schedule under the current configuration (4000 tiers × 3,150 tokens, 2000× span):

| Market price | Tiers unlocked | Tokens released | Share of the 8.4M genesis | Share of the 12.6M ladder | **Share of the 4.62M claim float** |
|---|---|---|---|---|---|
| 1.2× | 96 | 302,400 | 3.6% | 2.4% | 6.5% |
| 1.5× | 214 | 674,100 | 8.0% | 5.4% | 14.6% |
| **2×** | 365 | **1,149,750** | **13.7%** | 9.1% | **24.9%** |
| 3× | 579 | 1,823,850 | 21.7% | 14.5% | 39.5% |
| 5× | 848 | 2,671,200 | 31.8% | 21.2% | 57.8% |
| 10× | 1213 | 3,820,950 | 45.5% | 30.3% | 82.7% |
| 100× | 2425 | 7,638,750 | 90.9% | 60.6% | 165.3% |
| 2000× | 4000 | 12,600,000 | 150.0% | 100.0% | 272.7% |

The last column is the only one that answers "who is going to buy this": the denominators of the other two both contain supply that does not trade (3.78M of the 8.4M is locked in the LP; the 12.6M is the not-yet-minted ladder itself).

**The span knob cannot squeeze early release down by another order of magnitude** — what is left is to make the per-tier quota grow geometrically with price (`size(i) ∝ SIZE_STEP^i`, which at 2× could push it to a single-digit percentage of the genesis float). That design would cut what a single order can buy in the low-price region to roughly 1/4 of today's, and after evaluation it has not been adopted for now.

**Why the step and the tier count are coupled**: the comment states it outright — `STEP = 2000^(1/(TIER_COUNT-1)) = exp(ln 2000 / 3999) ≈ 1.001902508` — so the span is the chosen invariant and the step is re-derived to hit it; neither may be edited alone. The literal `TIER_STEP_E18 = 1_001_902_508_266_805_824` is **fitted** so that `_powE18(STEP, 3999) ≈ 2000e18` under the contract's own floor `mulDiv`, rather than being a rounded floating-point `exp`. Nor can the span be pulled arbitrarily high — a naive `1.2^3999 ≈ 1e317` would overflow `uint256` long before the ladder emptied, whereas ×2000 leaves the top rung about 202 bits of headroom on a typical raise (`TIER_STEP_E18` @ `src/ToshLaunchpadHook.sol`).

**Why prices are not stored**: materialising 4000 tiers as storage structs would burn millions of gas, and "cache the current price, advance by multiplication" drifts away from the closed form after 4000 truncating steps. So `tierPriceAt()` is the **single source of price** for the mint hot path, for `quoteMint`, and for every view (`tierPriceAt` @ `src/ToshLaunchpadHook.sol`). The paginated `getTiers()` view also recomputes tier by tier rather than walking the sequence forward, on the grounds that "a 1 wei gap between the displayed price and the executed price is a support ticket" (`getTiers` @ `src/ToshLaunchpadHook.sol`).

### 3.5 Full fee schedule

| Fee | Constant | Value | Charged on | Destination | Line |
|---|---|---|---|---|---|
| Launch fee | `ToshFactory.launchFee` | **0.01 ETH live on 4663**; the constructor default in `src/` is 0.1 ETH (owner-adjustable, may be 0) | creator | `ladderTreasury` (buyback ammunition) | `launchFee` / `createLaunch` @ `src/ToshFactory.sol` |
| Referral commission | `REFERRAL_BPS` | 10% (1000 bps) | every genesis deposit | the referrer; no referrer → `ladderTreasury` | `REFERRAL_BPS` / `deposit` @ `src/ToshLaunchpadHook.sol` |
| Phase-2 platform cut | `PLATFORM_TAX_BPS` | **1%** (100 bps) | shelf proceeds | `ladderTreasury` | `PLATFORM_TAX_BPS` / `mintBondingCurve` @ `src/ToshLaunchpadHook.sol` |
| Phase-2 project cut | the remainder | **99%** | shelf proceeds | `projectAdmin` | `mintBondingCurve` @ `src/ToshLaunchpadHook.sol` |
| Swap tax (protocol) | `TAX_BPS` | **1.00%** (100 bps) | the **input** of every swap (by buy/sell direction, not by the specified currency) | buys, ETH → split (see the next two rows); sells, tokens → `0xdead` (**not split, the full amount**) | `TAX_BPS` / `beforeSwap` / `afterSwap` @ `src/ToshLaunchpadHook.sol` |
| └ Buyback reservoir share | `TAX_BPS - PLATFORM_SWAP_FEE_BPS` | **0.70%** (70 bps) | a buy's ETH input | `ladderTreasury` (buy-and-burn) | `_skimInputTax` @ `src/ToshLaunchpadHook.sol` |
| └ **Platform maintenance cut** | `PLATFORM_SWAP_FEE_BPS` | **0.30%** (30 bps) | a buy's ETH input (**buys only**) | `platformFeeRecipient` = `ToshFactory.platformTreasury`, **platform revenue, not burned** | `PLATFORM_SWAP_FEE_BPS` / `_skimInputTax` @ `src/ToshLaunchpadHook.sol` |
| Pool fee (LP) | `POOL_FEE` | **0.30%** (3000, in V4 units) | every swap | LPs (settled natively by V4, no Tosh code) | `POOL_FEE` @ `src/ToshLaunchpadHook.sol` |
| **Total trader friction** | — | **1.30%** | — | 0.30 to LPs + 0.70 to buyback + 0.30 to the platform | `POOL_FEE` / `TAX_BPS` @ `src/ToshLaunchpadHook.sol` |

> The two `take` calls must sum to **exactly** `tax`: both call sites declare a single hook delta of `tax` to V4, so taking less reverts the swap with `CurrencyNotSettled`, and taking more draws on funds the hook was never credited. Which is why the buyback share is written `tax - platformCut` and **not** as its own second multiplication by 70/10000 — two independent floor divisions of the same base are not guaranteed to sum back to a third. The dust that rounding produces therefore always favours the buyback and never the platform (`_skimInputTax`'s comment works through a 110 wei example; `testFuzz_buyTax_splitAlwaysConservesTheCreditedTax` pins this invariant).

**How friction was redistributed from v4.x to v5.0**: v4.x charged a 1% pool fee + a 1% tax = 2%, and the pool-fee half was dead weight — the only LP was the permanently locked genesis position, and nobody could collect from it. v5.0 cut total friction to 1.00% and gave the pool fee a genuine claimant (`src/ToshLaunchpadHook.sol:73-84`). The platform maintenance cut then lifted total friction to **1.30%** — still below v4.x's 2%, but 30 bps above the first v5.0 revision. This is a real increase in user cost; the decision and the reasoning are in §2.2.5.1.

**The swap tax skims the input by buy/sell direction, not by the currency on the specified side.** Exact-input settles in `beforeSwap`; exact-output settles in `afterSwap`, topping up the delta against the unspecified input (the mask includes `AFTER_SWAP_RETURNS_DELTA`).

| Trade shape | `amountSpecified` | `zeroForOne` | Which side is skimmed | Destination | Callback |
|---|---|---|---|---|---|
| Buy (exact-input) | negative | true | ETH input | 70 bps→`ladderTreasury` + 30 bps→`platformFeeRecipient` | `beforeSwap` |
| Sell (exact-input) | negative | false | token input | 100 bps→`0xdead` (not split) | `beforeSwap` |
| Buy (exact-output) | positive | true | ETH input | 70 bps→`ladderTreasury` + 30 bps→`platformFeeRecipient` | `afterSwap` |
| Sell (exact-output) | positive | false | token input | 100 bps→`0xdead` (not split) | `afterSwap` |

So an aggregator that builds every buy as "N tokens out" still cannot leave the treasury with 0 ETH. Tests: `test_buyTax_splitsOnePercentEthBetweenReservoirAndPlatform`, `test_sellTax_burnsTheFullOnePercentOfTokensInPlace`, `test_buyTax_exactOutputSkimsEthNotTokens`, `test_sellTax_exactOutputBurnsTokensNotEth`, `testFuzz_buyTax_splitAlwaysConservesTheCreditedTax`, `test_platformSwapFeePaid_firesOnBuysAndNeverOnSells`.

### 3.6 The treasury's four inbound pipes

`src/ToshLadderTreasury.sol:23-29` lists them explicitly:

1. the **70 bps share** of the buy-side ETH tax from every Tosh pool (the tax itself is 1.00%; the other 30 bps is the platform cut and **does not come here** — see §2.2.5.1);
2. **project launch fees** from `ToshFactory`;
3. **orphaned referral commission** (the 10% of deposits that arrived with no referrer);
4. the **1% platform cut** of every shelf mint.

The sell-side tax **never reaches here** — those tokens are burned in place by the hook and need no reservoir at all (`src/ToshLadderTreasury.sol:28-29`).

---

## 4. Product lifecycle and business flows

### 4.1 State Machine Overview

| State | Test (on-chain) | Available operations | Exit condition |
|---|---|---|---|
| **S0 Not created** | — | `createLaunch` | deployment succeeds |
| **S1 Genesis raise open** | `!launched && block.timestamp < genesisDeadline` | `deposit` | `genesisDeadline` reached |
| **S2 Awaiting launch** | `!launched && ts ≥ genesisDeadline && total ≥ softCap && ts ≤ deadline+7d` | `launch()` (creator) | `launch()` succeeds → S4; past 7 days → S3b |
| **S3a Genesis failed** | `!launched && ts > genesisDeadline && total < softCap` | `refund()` | terminal |
| **S3b Zombie timeout** | `!launched && ts > genesisDeadline + LAUNCH_WINDOW(7d)` | `refund()` | terminal (`launch()` reverts `LaunchWindowExpired` from here on) |
| **S4 Launched / ladder running** | `launched == true` | `claimGenesis` / `claimReferralReward` / `mintBondingCurve` / pool swaps / retail LP | `currentTierIndex == TIER_COUNT` → S5 |
| **S5 Ladder exhausted** | `currentTierIndex >= TIER_COUNT` | pool swaps / retail LP (`mintBondingCurve` reverts `LadderExhausted`) | terminal |

The code behind these tests: `canRefund()`, the preconditions in `launch()`, and the preconditions in `refund()` — all three in `src/ToshLaunchpadHook.sol`.

> **⚠️ 8.13**: the two status bits `refundEnabled` / `zombieRefundEnabled` are set lazily inside `refund()` and carry an event (`src/ToshLaunchpadHook.sol`), but they are **never read as a gating condition anywhere**. The real gate is `softCapFailed || zombieExpired`, recomputed on every call. They are pure event marker bits.

### 4.2 Creating a launch — `createLaunch`

**Signature** (`src/ToshFactory.sol`):

```solidity
function createLaunch(
    string calldata name,
    string calldata symbol,
    address projectTreasury,
    address projectAdmin,
    bytes32 hookSalt,
    uint256 expectedFee,
    uint256 genesisDuration
) external payable whenNotPaused nonReentrant returns (address token, address hook)
```

**Execution order**:

| Step | Action | Failure error | Line |
|---|---|---|---|
| 1 | `projectTreasury != 0`, `projectAdmin != 0` | `"zero treasury"` / `InvalidAdmin` | 355-356 |
| 2 | Fee slippage guard: reject if `launchFee > expectedFee` | `FeeChanged` | 358-359 |
| 3 | `msg.value >= fee` | `InsufficientLaunchFee` | 360 |
| 4 | Name/symbol non-empty | `EmptyName` | 363 |
| 5 | **The (name, symbol) tuple is not already taken**: `nameKey = keccak256(abi.encode(name, symbol))` | `NameTaken` | 364-365 |
| 6 | Derive the creator-bound salt `finalSalt = keccak256(abi.encode(msg.sender, hookSalt))` | — | 367 |
| 7 | **Freeze the two platform dials** into the initcode: `launchSoftCap = defaultSoftCap`, `launchWalletCap = maxPogAllocationLimit` | — | 371-372 |
| 8 | Compute the initcode hash of the hook's EIP-1167 clone (**6-field tuple**) and predict the address: `ToshCloneLib.initcodeHash` | — | 374-385 |
| 9 | **Mask check**: `HookMiner.isValidHookAddress(predicted)`, requiring the low 14 bits to carry `0x20CC` | `InvalidHookSalt` | 386 |
| 10 | `ToshCloneLib.deployHook` (CREATE2 on the 131-byte clone initcode, so the deployer is the factory itself) | `DeployFailed` | 388-400 |
| 11 | `ToshCloneLib.deployBareClone(tokenImplementation)` (a 45-byte argument-free proxy, CREATE not CREATE2) → `token.initialize(hook, name, symbol)` (grants `MINTER_ROLE`, writes name/symbol to storage) → `hook.initializeToken(token, projectAdmin)` | — | 402-404 |
| 12 | Register: `registeredHooks[hook] = true`, `tokenToHook[token] = hook`, `nameTaken[nameKey] = true` | — | 406-408 |
| 13 | Append to the registry + emit `LaunchCreated` | — | 410-413 |
| 14 | Launch fee forwarded to `ladderTreasury`; any overpayment refunded to `msg.sender` | `EthTransferFailed` | 416-421 |

**The 6-field clone tuple** (`cloneInitcode` / `initcodeHash` / `deployHook` @ `src/libraries/ToshCloneLib.sol`, order is fixed):

```
1. implementation   (address)   the one shared ToshLaunchpadHook every clone delegates to
                               — the only field that is not per-project
2. creator          (address)   = msg.sender
3. projectTreasury  (address)   project multisig, metadata only
4. softCap          (uint128)   this project's soft cap (snapshot), narrowed to fit
5. perWalletCap     (uint128)   this project's per-wallet cap (snapshot), narrowed to fit
6. genesisDuration  (uint32)    genesis window length (one of 3h / 24h / 72h)
```

**Every project is an EIP-1167 clone, not a fresh copy of the hook.** The initcode is 131 bytes — a 10-byte creation stub, the canonical 45-byte proxy body carrying the implementation address, and the 76 bytes of immutable args that fields 2–6 pack into — and the clone reads those args back out of its own runtime bytecode with `EXTCODECOPY`, which is a warm access and therefore as cheap as the constructor immutables it replaces. Fields 2–6 are precisely the five the front end passes to the public view `factory.hookInitcodeHash(projectTreasury, creator, softCap, perWalletCap, genesisDuration)`; the implementation is supplied by the factory.

**All six go into the initcode hash**, so a change to any one of them invalidates every salt already mined; the front end clears an already-mined salt on each trigger that can move one (see 6.5). What decides membership is stated in `ToshCloneLib`'s comment: **a value the creator cannot predict while mining the salt off-chain cannot be an immutable arg** — which is why `genesisDeadline` (`block.timestamp + genesisDuration`) stays in storage and only the *duration* is packed.

**Three of the nine fields the old constructor tuple carried are gone from the hash, and this note is where that lands.** `poolManager`, `factoryAddr` and `ladderTreasury` are identical for every launch, so they are ordinary immutables on the shared implementation and cost nothing per project; `projectAdmin` is mutable by design and is applied by `initializeToken`, so it no longer moves the mined address (see 6.5, where the frontend still clears the salt on an admin edit and no longer needs to). `HookDeployLib` survives, but only to hold `deployImplementation` and `creationCodeHash` — it is called once per platform, from the factory's constructor, and no longer builds a per-project initcode at all. Its own comment states the migration cost outright: the initcode changed shape completely, from `creationCode ++ abi.encode(9 args)` to a 131-byte clone stub, so **every previously mined salt is stale and every off-chain miner has to regenerate** (`src/libraries/HookDeployLib.sol`). `soat-frontend/src/app/lib/hookMiner.ts` carries the TypeScript mirror of the same six fields (`computeCloneInitcode` / `computeHookInitcodeHash`), and `scripts/checkHookMinerTuple.mjs` pins it to the Solidity.

**The CREATE2 mask `0x20CC`** (`src/libraries/HookMiner.sol`):

| Bit | Value | Flag | Purpose |
|---|---|---|---|
| 13 | `0x2000` | `BEFORE_INITIALIZE` | pool-creation front-running defence (only the hook's own `launch()` may create the pool) |
| 7 | `0x0080` | `BEFORE_SWAP` | exact-input tax |
| 6 | `0x0040` | `AFTER_SWAP` | oracle write + piggyback poke + exact-output tax |
| 3 | `0x0008` | `BEFORE_SWAP_RETURNS_DELTA` | skim the specified amount (= input) |
| 2 | `0x0004` | `AFTER_SWAP_RETURNS_DELTA` | skim the unspecified amount (= input, exact-output) |
| — | total `0x20CC` | | |

**Deliberately unset**: `BEFORE_REMOVE_LIQUIDITY` (bit 9), so retail LPs can withdraw freely.

⚠ The mask went `0x2200` → `0x20C8` → `0x20CC`. The Solidity miner and the TS miner must agree, or `createLaunch` reverts `InvalidHookSalt`.

### 4.3 Phase 1 — the genesis raise

#### 4.3.1 Three genesis durations

| Constant | Value | Front-end label | Positioning copy (front end) | Line |
|---|---|---|---|---|
| `DURATION_FAST` | 3 hours | "3 Hours / Fast" | "Momentum play — hits the cap fast or fails fast." | `src/ToshLaunchpadHook.sol` |
| `DURATION_STANDARD` | 24 hours | "24 Hours / Standard" | "Covers every timezone once. The default." | `src/ToshLaunchpadHook.sol` |
| `DURATION_SLOW` | 72 hours | "72 Hours / Slow" | "Maximum reach for a wider raise." | `src/ToshLaunchpadHook.sol` |

Front-end constant mirror + copy: `soat-frontend/src/app/lib/hookMiner.ts:41-43`, `soat-frontend/src/app/launch/page.tsx:104-108`. The default is `GENESIS_DURATION_STANDARD` (`soat-frontend/src/app/launch/page.tsx:411`).

**Why a closed set rather than a free `uint256`** (`DURATION_FAST` / `DURATION_STANDARD` / `DURATION_SLOW` @ `src/ToshLaunchpadHook.sol`): the duration is an immutable parameter, baked into the clone's own bytecode, and therefore also part of the initcode hash and of the mined address. An open range would let a creator mine a salt against a 1-second window (nobody has time to deposit, genesis fails immediately, refunds open at once) or a 100-year window (deposits locked in with no refund path). Three coarse tiers keep the choice commercially meaningful while closing both degenerate ends.

**The EIP-1167 clone refactor moved where this is checked**, and the reason is worth remembering. A clone runs no constructor, so the check moved into the one-shot initialiser `initializeToken` @ `src/ToshLaunchpadHook.sol`: read `genesisDuration()`, compare it against each of the three constants, and revert `InvalidDuration` otherwise. It is **deliberately not in the factory** — the comment says so explicitly: the value is read out of the clone's own bytecode, whereas validating the factory's argument would only prove what the factory *intended* to bake in, never what the mined address actually committed to. A duration outside the three tiers means the salt was mined against a configuration this contract will not honour, so it is rejected before it can take its first deposit.

Tests: `test_initializeToken_acceptsTheThreeAllowedWindows` and `test_initializeToken_rejectsUnlistedWindow` @ `test/ToshV5Guards.t.sol`, `test_createLaunch_rejectsSaltMinedForAnotherWindow` @ `test/ToshV5Factory.t.sol`.

#### 4.3.2 PoG (Proof-of-Gas / Goodwill) quota and signature registration

> Note: the contract comments call `registerPoG` "Proof-of-Gas" (`registerPoG` @ `src/ToshFactory.sol`), consistent with the front end and the README; the name "Proof of Goodwill" appears only in this document and exists nowhere in `src/`.

**Signature digest** (`registerPoG` @ `src/ToshFactory.sol`), a six-field tuple for replay protection:

```
digest = toEthSignedMessageHash(keccak256(abi.encode(
    msg.sender,      // binds the wallet
    maxAlloc,        // quota granted (ETH-wei)
    nonce,           // increments, anti-replay
    deadline,        // expiry
    address(this),   // binds the factory
    block.chainid    // binds the chain
)))
require(digest.recover(signature) == pogSigner)
```

**Check order** (`registerPoG` @ `src/ToshFactory.sol`):

| Check | Error | Notes |
|---|---|---|
| `deadline ≤ now + MAX_SIG_VALIDITY(24h)` | `SignatureTooLong` | blocks long-lived signatures |
| `now ≤ deadline` | `SignatureExpired` | |
| `nonce == pogNonces[sender]` | `NonceConflict` | strict ordering, no skipping |
| `maxAlloc ≤ maxPogAllocationLimit` | `ExceedsGlobalPogLimit` | **no silent clamp** — rejected outright (test `test_registerPoG_noSilentClamp` @ `test/ToshV5Factory.t.sol`) |
| signature recovers to `pogSigner` | `InvalidSignature` | |

**Quota ratchets up, never down**: `if (maxAlloc > pogQuota[sender]) pogQuota[sender] = maxAlloc;` (`registerPoG` @ `src/ToshFactory.sol`). ⚠️ **8.10**: an owner who later lowers `maxPogAllocationLimit` **does not** claw back quota already registered.

✅ **8.11 (resolved)**: `registerPoG` used to carry `whenNotPaused` and **no blacklist check**, so a blacklisted wallet could still register or raise its PoG quota while only `deposit` was stopped. The check is now the **first statement of the function** — ahead of the validity window, the nonce and the signature recovery — and reverts `IsBlacklisted`, exactly as `deposit` does (`registerPoG` @ `src/ToshFactory.sol`). Test `test_registerPoG_rejectsBlacklisted`.

**How the quota window works** (`quotaWindowEnd` / `quotaSpent` / `_rollQuotaWindow` @ `src/ToshFactory.sol`):

- PoG quota is a **per-window budget**, not a lifetime one: a wallet may spend at most `pogQuota` within each `quotaWindowDuration` window (24 hours by default), and once the window lapses it zeroes out and reopens.
- **A refund does not restore window quota** — deliberately: pulling your money out ought to cost you your slot for the round, or a deposit-then-refund loop could recycle one wallet's quota indefinitely (`quotaSpent` @ `src/ToshFactory.sol`). Test `test_pogQuota_isNotRestoredByRefund` @ `test/ToshV5.t.sol`.
- ✅ **8.25 (resolved)**: the cooldown length and the quota-window length used to be one dial. They are **two independent dials** now, each declared and set on its own — `cooldownDuration` (default 24 hours, `setCooldownDuration`) throttles re-deposits per (wallet, hook), and `quotaWindowDuration` (default 24 hours, `setQuotaWindowDuration`) governs how long a wallet's PoG spend ledger lasts (`src/ToshFactory.sol`). The degeneracy keys on the **second** of them: with `quotaWindowDuration == 0` there is no window to anchor a refill to, so `_rollQuotaWindow` returns `quotaSpent` immediately and the quota becomes a **lifetime budget** (`_rollQuotaWindow` @ `src/ToshFactory.sol`). `cooldownDuration == 0` switches off the re-deposit throttle and nothing else — a platform can now run a cool-off without a refill, or a refill without a cool-off. See 8.14 (new).

#### 4.3.3 Depositing — `deposit`

**Factory-side gates** (`src/ToshFactory.sol:442-468`; the listed order is the execution order):

| # | Check | Error |
|---|---|---|
| 1 | `msg.value != 0` | `ZeroAmount` |
| 2 | `registeredHooks[hook]` | `HookNotRegistered` |
| 3 | Not inside a blacklist period | `IsBlacklisted` |
| 4 | `pogQuota[sender] != 0` | `NoPogQuota` |
| 5 | The (wallet, hook) cooldown has elapsed | `CooldownActive` |
| 6 | After rolling the window, `alreadyIn + amount ≤ pogQuota` | `QuotaExceeded` |
| 7 | Set the new cooldown (if `cooldownDuration > 0`) | — |
| 8 | **Bind the referral before reading it back**, so a first-time depositor's own link takes effect on this very deposit | — |
| 9 | Book `quotaSpent` / `totalGenesisDeposited`, forward the ETH to the hook | — |

**Hook-side gates** (`src/ToshLaunchpadHook.sol:624-654`):

| # | Check | Error |
|---|---|---|
| 1 | `msg.sender == factory` | `OnlyFactory` |
| 2 | `tokenInitialized` | `NotInitialized` |
| 3 | `block.timestamp < genesisDeadline` | `GenesisExpired` |
| 4 | `msg.value != 0` | `ZeroAmount` |
| 5 | **Per-wallet cap**: `ethDeposited[user] + amount ≤ perWalletCap` | `PerWalletCapExceeded` |

**How the two quota layers divide the work** (`src/ToshFactory.sol:430-436`):
- `pogQuota` is a **platform-level budget across projects**, refilled per window.
- `perWalletCap` is a **single-project ceiling**, enforced against the **snapshot taken at creation**, so that a later turn of the platform's dials cannot change the terms of a raise already in flight (`src/ToshLaunchpadHook.sol:692-694`). Test `test_perWalletCap_isSnapshottedAtProjectCreation` @ `test/ToshV5.t.sol`.

**The soft cap** is the hook's `softCap` immutable, snapshotted from `factory.defaultSoftCap` (10 ETH by default, `src/ToshFactory.sol:217`), with a floor of `MIN_SOFT_CAP_PROD = 0.01 ether`. That floor exists for exactly one reason — to prevent `p0` from truncating: `GENESIS_LP_SUPPLY = 3.78e24`, so the moment `lpEth < 3,780,000` wei, `p0` divides to 0 and the entire ladder collapses into a free-mint zone (`src/ToshFactory.sol:102-109`). Defence in depth: `launch()` also carries `require(p0 > 0)` (`src/ToshLaunchpadHook.sol:679-681`).

**There is no hard cap**: **no basis was found in the code** for any over-subscription rejection. Deposits can keep coming after the soft cap is met, right through to the end of the window, bounded only by `perWalletCap` and the PoG quota.

### 4.4 Launch — `launch()`

**Four preconditions** (`src/ToshLaunchpadHook.sol:704-710`):

| Check | Error |
|---|---|
| `msg.sender == creator` | `OnlyCreator` |
| `block.timestamp >= genesisDeadline` | `GenesisActive` |
| `!launched` | `AlreadyLaunched` |
| `totalEthDeposited >= softCap` (and `!= 0`) | `SoftCapNotMet` / `ZeroAmount` |
| `block.timestamp <= genesisDeadline + LAUNCH_WINDOW(7d)` | `LaunchWindowExpired` |

> **⚠️ 8.7**: even if the soft cap is met and overshot early, the creator **must still wait out the entire genesis window** (3/24/72 hours) before launching. This runs against the product intuition that "soft cap met means launchable", and it is inconsistent with the front end's phase logic, which switches to the "bonding" panel the moment the soft cap is met (⚠️ 8.6).

**Six-step execution** (`src/ToshLaunchpadHook.sol:712-765`):

```
1. launched = true                                          // set before any reentrancy
2. commissionPool = totalReferralReserved + orphanReferral
   lpEth = totalEthDeposited − commissionPool               // i.e. 90% × R
   require(lpEth > 0)
3. p0 = lpEth × 1e18 / GENESIS_LP_SUPPLY   require(p0 > 0)
   shelfP0 = p0 × 10500 / 10000
4. projectToken.mint(address(this), GENESIS_SUPPLY)          // 8.4M
5. pool creation: currency0 = address(0) (ETH, always first)
                  currency1 = projectToken
                  fee = POOL_FEE(3000), tickSpacing = 200, hooks = this
   sqrtPriceX96 = _toSqrtPriceX96(lpEth, GENESIS_LP_SUPPLY)  // integer square root
   poolManager.initialize(key, sqrtPriceX96)                 // fires beforeInitialize, self only
   poolManager.unlock(ACTION_ADD_LIQUIDITY) → unlockCallback
     → modifyLiquidity(tickLower=-887200, tickUpper=+887200, +liquidity, salt=0)
     → currency0 debt settled with msg.value; currency1 debt via safeTransfer + settle
6. seed the oracle: lastTick = getTickAtSqrtPrice(sqrtPriceX96)
                    lastObservationTs = _prevCheckpointTs = _curCheckpointTs = now
7. forward all of orphanReferral to ladderTreasury, zero it, emit OrphanReferralForwarded
8. emit Launched(totalEth, lpEth, liquidity, sqrtPriceX96, p0)
```

**Why the genesis liquidity is locked without needing a callback** (the `beforeRemoveLiquidity` comment in `src/ToshLaunchpadHook.sol`, together with what `unlockCallback` actually does): V4 attributes every position to the address that called `modifyLiquidity` (`Pool.ModifyLiquidityParams.owner = msg.sender`). The genesis position belongs to the hook, and the hook's `unlockCallback` recognises only `ACTION_ADD_LIQUIDITY`, and only with a strictly positive delta. Nobody — not the creator, not the owner — can address that position. The lock is therefore **structural**, rather than resting on a callback that reverts, which is why `BEFORE_REMOVE_LIQUIDITY` was deleted from the mask instead of being softened into a conditional revert.

**The `platformTreasury` snapshot is gone** (`src/ToshLaunchpadHook.sol:714-718`): v4.x snapshotted `platformTreasury` here so that a later change by the factory owner could not redirect the Phase-2 fee flow (the M-2 fix). v5.0 needs no snapshot **here** — the Phase-2 1% slice goes to `ladderTreasury`, which is an immutable constructor argument, so the redirection vector on this path does not exist at the bytecode level.

> **Where M-2 stands now (updated)**: `platformTreasury` has since returned to the money path — it takes 30 bps of the ETH on every buy (`PLATFORM_SWAP_FEE_BPS`). That **reopens the surface M-2 described**, so what was removed this time is not the inflow but the **mutability**: `setPlatformTreasury` is deleted, the factory's field is now `immutable`, and the same address is burned into the hook implementation's `platformFeeRecipient` at construction. Put differently, M-2 is now held closed by "the address cannot change" rather than by "the address receives nothing". The per-launch snapshot is consequently still redundant — not because there is no fee flow, but because the source itself is already immutable. See §2.2.5.1.

> **⚠️ 8.14**: at pool creation `getLiquidityForAmounts` takes the minimum of the two sides (`src/ToshLaunchpadHook.sol:2006-2012`), so both the ETH and the tokens actually consumed are ≤ the amounts offered, and the dust stays in the hook. Likewise, the truncation dust in `claimGenesis` (`allocation = CLAIM_SUPPLY × dep / total`, `src/ToshLaunchpadHook.sol:1341-1353`) leaves a minute residue in the hook permanently. The contract has **no sweep path whatsoever**. This is the same trade-off as the treasury's "one-way valve", except that on the hook side it was never documented.

### 4.5 The failure path — `refund()`

**Two gates** (`src/ToshLaunchpadHook.sol:657-693`):

| Gate | Test | Event |
|---|---|---|
| Soft cap not met | `ts > genesisDeadline && totalEthDeposited < softCap` | `GenesisFailed(totalEthRaised)` (on the first trigger) |
| Zombie window lapsed | `ts > genesisDeadline + LAUNCH_WINDOW(7 days)` | `ZombieRefund(totalEthRaised)` (on the first trigger) |

What the second gate means as a product: even with the soft cap met, if the creator does not launch within 7 days, depositors can withdraw in full. It closes off the "raise the money and vanish" route.

**The refund is 100% of `ethDeposited[msg.sender]`** (`src/ToshLaunchpadHook.sol:1227-1252`). The 10% commission carve is only realised at `launch()`, so a failed genesis owes referrers nothing and `referralAccrued` simply becomes permanently unclaimable (`claimReferralReward` requires `launched`, `src/ToshLaunchpadHook.sol:1362-1373`).

**CEI order**: `ethDeposited[msg.sender] = 0` first (EFFECTS), then the event marker bits, then `_sendEth` last (INTERACTIONS), with `nonReentrant` wrapped around the whole thing (`src/ToshLaunchpadHook.sol:1227-1252`, `2207-2210`).

**A pause does not affect refunds**: the test `test_pause_doesNotBlockRefund` @ `test/ToshV5Factory.t.sol` pins this down explicitly (the other face of ⚠️ 8.12: this is a good thing, but it also shows how narrow the pause's reach is).

### 4.6 Phase 2 — ladder minting

#### 4.6.1 `mintBondingCurve(uint256 tokenAmount) payable returns (uint256 ethCharged)`

**Execution flow** (`src/ToshLaunchpadHook.sol:847-926`):

```
Preconditions: initialized · nonReentrant · launched · tokenAmount != 0

Gate 1 (same-block lock): block.number <= lastSwapBlock  →  revert SameBlockMintForbidden
                                                            // line 858
tierIndex = currentTierIndex
tierIndex >= TIER_COUNT  →  revert LadderExhausted    // line 861

Gates 2+3 (reference price and ceiling, hoisted out of the loop, since no leg can move them):
    ceiling = _safeReferencePrice() × 10500 / 10000    // line 865

Loop (one leg per tier):
    tierIndex >= TIER_COUNT      →  revert ExceedsTierRemaining   // line 873
    ++legs > MAX_TIERS_PER_TX(32) →  revert SpanTooManyShelves     // line 874
    tierPrice = tierPriceAt(tierIndex)
    tierPrice > ceiling          →  revert TierPriceAboveCeiling   // line 877
    room  = TIER_SIZE − sold
    take  = min(tokenAmount − filled, room)
    legCost = tierPrice × take / 1e18       // floored per leg, worst case 1 wei/leg in the buyer's favour
    emit TierMinted(buyer, tierIndex, tierPrice, take, legCost)
    tier sells out → sold=0, ++tierIndex, emit TierAdvanced

Payment check: cost == 0 → ZeroAmount; msg.value < cost → InsufficientPayment

EFFECTS: _ladderState = { tierIndex, tierSold, minted + tokenAmount }  // one SSTORE, one slot

INTERACTIONS:
    platformCut = cost × 1% → ladderTreasury      // line 914-917
    projectCut  = cost − platformCut → projectAdmin // line 918
    projectToken.mint(msg.sender, tokenAmount)      // line 920
    change = msg.value − cost → back to msg.sender  // line 922-923
```

**Why spanning tiers is allowed** (`src/ToshLaunchpadHook.sol:831-841`): a shelf mint issues straight from the token contract and routes the ETH directly to `projectAdmin`/`ladderTreasury`, **never touching the pool**, so it cannot move `spot`; and the TWAP is only a function of past fills. The anti-spike reference price is therefore **constant** for the whole call, which makes re-checking the ceiling on every leg exactly equivalent to checking it once against the highest tier. Sweeping N tiers in one fill reaches the **same end state at the same total price** as N single-tier fills in the same block, so splitting was never a safety property — only a gas tax the buyer pays. The test `test_tierMint_spanIsEquivalentToSequentialShelfBuys` @ `test/ToshV5.t.sol` nails this invariant down.

**`MAX_TIERS_PER_TX = 32` is a gas bound, not a safety bound**: a buyer who hits it reaches the identical end state by sending a second transaction **in the same block**. It exists purely to stop a single call from looping hundreds of times (every leg recomputes `tierPriceAt`, O(log i)) and running out of gas. It is 32 rather than the original 16 because, once the market has caught up with the cursor, the 105% ceiling clears `ln(1.05)/ln(STEP) ≈ 25.7` tiers at once — at 16 the leg count would bind before the ceiling did, making every ordinary buyer pay a second transaction's gas for nothing. The test `test_tierMint_legCapBindsWhenMarketRunsAhead` @ `test/ToshV5.t.sol` verifies explicitly that "splitting into two transactions reaches the state that was rejected".

#### 4.6.2 `quoteMint(uint256) view returns (uint256 ethCost)`

Mirrors **every check and every leg of arithmetic** in `mintBondingCurve` (`src/ToshLaunchpadHook.sol:1531-1569`, `1421-1519`). The design intent is stated plainly: a successful quote is a mint the contract will accept in the next block at **exactly the same price**. The duplication is deliberate — a shared helper would have to either allocate a per-leg array or walk the loop twice in order to emit the events. `testFuzz_QuoteMatchesMintAcrossSpans` pins the two loops to each other (comment at `931-937`; the test file is `test/ToshV5Fuzz.t.sol`).

Note: `quoteMint` is `view` but **does revert** (`LadderExhausted` / `ExceedsTierRemaining` / `SpanTooManyShelves` / `TierPriceAboveCeiling` / `ZeroAmount`). The front end has to handle the revert rather than read it as a zero return.

#### 4.6.3 `maxMintable() view returns (uint256)`

Folds **every quantity limit** a buyer can hit into a single number (`src/ToshLaunchpadHook.sol:976-1000`): what remains on the current tier, plus every following tier still under the 105% ceiling, plus the end of the ladder, plus `MAX_TIERS_PER_TX`. Returns 0 while the gate is shut. The UI's "max" button is sized from this rather than from a guess at `TIER_SIZE`. The test `test_maxMintable_isTheExactAcceptedBoundary` @ `test/ToshV5.t.sol` asserts that "one more wei-token reverts".

#### 4.6.4 View interfaces at a glance

| Function | Returns | Line |
|---|---|---|
| `tierPriceAt(i)` | price of tier i (ETH-wei per whole token); returns 0 for `i >= TIER_COUNT` | `1401-1404` |
| `getTier(i)` | `Tier{price, totalAmount, soldAmount}` | `1424-1435` |
| `getTiers(start, count)` | a paged window (4000 tiers = 12,000 words, impossible to return in one call) | `1444-1466` |
| `tierCount()` / `tierRemaining()` / `bondingRemaining()` / `currentBondingPrice()` | counts and the current price | `1468-1487` |
| `tierStatus()` | `(tierIndex, tierPrice, remaining, spotPrice, twapPrice, ceiling, unlocked)` — **everything the UI needs to render the price gate** | `1497-1520` |
| `getPoolKey()` / `hasClaimed(user)` / `claimableReferral(referrer)` | pool key / claim flag / claimable commission | `1522-1533` |
| `satoDeposited(user)` / `totalSatoDeposited()` | **v4.x compatibility shims**, aliasing `ethDeposited` / `totalEthDeposited` respectively | `1535-1546` |

> **⚠️ 8.15**: `phase2Minted` is an independent accumulator (`phase2Minted += tokenAmount`), a second set of books alongside `currentTierIndex`/`currentTierSold`. On the normal path the two agree, but the comment on the `ExceedsTierRemaining` error says to "read `bondingRemaining()` and shrink the order" (`src/ToshLaunchpadHook.sol:942`, `789-807`), whereas the actual trigger condition is `tierIndex >= TIER_COUNT` (the ladder's tiers are exhausted). The view the error points at is not the same quantity as the condition that fired it.

### 4.7 Claiming the genesis share — `claimGenesis()`

`src/ToshLaunchpadHook.sol:769-781`:

| Check | Error |
|---|---|
| `launched` | `NotLaunched` |
| `!genesisShareClaimed[sender]` | `AlreadyClaimed` |
| `ethDeposited[sender] != 0` | `NoDeposit` |

```
allocation = GENESIS_CLAIM_SUPPLY × ethDeposited[sender] / totalEthDeposited
```

Note that the denominator is `R`, the **total raise including the 10% commission** — which is precisely the definition that puts a depositor's cost basis at `R / 4,620,000` (consistent with the derivation in 3.3). `nonReentrant`, and `genesisShareClaimed` is set before the `safeTransfer`.

### 4.8 Withdrawing referral commission — `claimReferralReward()`

`src/ToshLaunchpadHook.sol:783-801`:

| Check | Error |
|---|---|
| `launched` | `NotLaunched` |
| `referralAccrued[sender] != 0` | `NoReferralReward` |

**Deliberately not time-vested** (`src/ToshLaunchpadHook.sol:785-789`): the amount is already proportional to the funds each referee genuinely brought in, and a launched project has no mechanism to claw it back.

### 4.9 Platform-treasury piggyback buyback — `autoPiggybackBuyback()` and `pokeBuyback()`

**Two trigger paths, one shared `_runPiggyback()`**:

1. **Piggyback (gas-gated)**: a swap on a Tosh pool → the hook's `afterSwap` → when `ladderTreasury.balance >= PIGGYBACK_TRIGGER_STEP` **and** `gasleft() >= PIGGYBACK_MIN_GAS` (260,000), `try ... autoPiggybackBuyback{gas: gasleft() - PIGGYBACK_TAIL_RESERVE}()`.
2. **Permissionless direct poke**: any address → `treasury.pokeBuyback()` → `poolManager.unlock("")` → `unlockCallback` → `_runPiggyback()`.

**Why the gas gate has to exist**: the buy tax is `take`n into the treasury inside `beforeSwap`, so one trade can be **unarmed when it starts and armed by the time it reaches `afterSwap`**. That means the trade charged for running the buyback is precisely the one that pushed the reserve past the threshold — and its wallet estimated gas against an unarmed pool. This is not "a transaction signed inside an unlucky window", it is **deterministically one trade per cycle**. Measured, a leg is about 125k and the post-gate tail about 70k, and neither is in the estimate.

`try/catch` cannot save it: once the sub-call has exhausted its gas, the 63/64 rule leaves the outer frame one sixty-fourth, which is not enough to finish `afterSwap` plus closing the V4 frame. So the gate does two things — **skip when the headroom is short**, and **physically withhold the tail's share with `{gas: avail - PIGGYBACK_TAIL_RESERVE}`**, so that however expensive a leg gets it cannot eat into it.

The cost is liveness: trading no longer guarantees that the reserve gets drained. `pokeBuyback()` is the backstop, deliberately open to everyone, because gating it on the owner would be inviting back the very liveness dependency just removed. It transfers no ETH to the caller and chooses nothing — the venue comes from the hook, the size from the balance, the order from the round-robin cursor, and the price is bounded by the same TWAP floor. The only thing it can decide is **when**, and the cursor makes that uninteresting.

**A skipped poke emits no event at all.** Skipping is the normal case, and logging it would charge every trader for the privilege. So this blind spot can only be found by polling the balance — see `STATE-06` in `monitoring/alerts.json`.

**The fault-isolation reasoning is spelled out in detail** (`src/ToshLaunchpadHook.sol:1145-1153`): the buyback is something this trade does for the platform **on the way past**, never a precondition of the trade itself. Without the `try/catch`, a treasury that does not recognise us (`setFactory` never wired up, or a hook deployed by a second factory that can never pass the one-shot binding registration) would revert `onlyHook` on **every single** trade, which would strand the genesis liquidity in the contract permanently with no recovery path whatsoever. A swallowed revert also rolls back that frame's V4 deltas and transient marker bits, so the trade continues on clean books. On failure it emits `PiggybackPokeFailed(treasury)` — **persistent emissions of this event mean the treasury no longer recognises this hook**.

**Treasury-side execution** (`_runPiggyback()`, shared by both entry points):

| Step | Action | Notes |
|---|---|---|
| 0 | Entry-point authorisation | `autoPiggybackBuyback` is `onlyHook` (else `OnlyHook`) and additionally requires `poolManager.isUnlocked()`; `pokeBuyback` has no authorisation but opens its own unlock frame, and reverts `NotArmed` instead of returning silently when unarmed |
| 1 | `piggybackActive()` already set → **silent return** | stay passive when a nested Tosh pool pokes us |
| 2 | `spend = _nextSpendAmount()`, 0 → return | `max(TRIGGER_STEP, balance × SPEND_BPS/10000)`, i.e. `max(1 ETH, 10% of the balance)` |
| 3 | `ladderTokens.length == 0` → return | nothing curated |
| 4 | `count = min(total, LEGS_PER_POKE)` | **`LEGS_PER_POKE = 1`**: one leg per poke |
| 5 | `perToken = spend / BATCH_SIZE` | **`BATCH_SIZE = 3` is now only the spend divisor, no longer the legs per poke** |
| 6 | Set the transient marker `_setPiggyback(true)` | EIP-1153 `tstore` |
| 7 | Rotate `count` times: `try this.executeBuyAndBurn(token, perToken) catch { emit BuybackSkipped }` | per-leg fault isolation; the external self-call lets a revert roll that leg's V4 deltas back completely, leaving the ETH in the reserve for the next cycle |
| 8 | `currentCursor = (cursor + count) % total` | advance the rotation |
| 9 | `_setPiggyback(false)`; `emit PiggybackExecuted(perToken*count, count, newCursor)` | `count` is now always 1, so the event fires three times as often for the same ETH |

**Why steps 4 and 5 are two separate numbers**: they used to be one number — three legs per poke, which amounted to making one buyer pay for three V4 swaps on the platform's behalf (about 125k each, measured). A 578,809 gas peak put in front of somebody who estimated 217k.

Split apart, each poke runs a single leg, but `perToken` is still divided by `BATCH_SIZE`, so **not a wei less ETH reaches each pool** — three transactions cover the same three pools. The peak drops to 362,884.

Keeping the divisor at 3 is the premise on which this is free: divide by 1 instead and the same cycle pours three times the ETH into a single genesis pool, where at that thinness the extra slippage buys fewer tokens to burn — trading execution quality for gas, which is not worth it.

**A single leg — `_buyAndBurn`** (`_buyAndBurn` in `src/ToshLadderTreasury.sol`):

```
swap(key, { zeroForOne: true,                            // ETH(currency0) → token(currency1)
            amountSpecified: -int256(ethIn),             // negative = exact input
            sqrtPriceLimitX96: _buybackSqrtFloor(key) }) // TWAP-anchored price floor
sync(native) ; settle{value: spent}()                    // pay only what the pool actually took
take(currency1, DEAD_ADDRESS, bought)                    // tokens straight to 0xdead
emit BuybackBurned(token, spent, bought)
```

**Where the slippage floor came from — a piece of reasoning that got overturned** (the `_buyAndBurn` and `_buybackSqrtFloor` comments in `src/ToshLadderTreasury.sol`): an earlier revision did indeed pass `MIN_SQRT_PRICE + 1` (i.e. no bound at all), on the grounds that "the output is burned, so an unfavourable price merely burns fewer tokens — no victim, and no extractable MEV". **That reasoning misses who is paying**: a sandwicher can buy ahead of the piggyback, let this leg fill at the inflated price, and then sell the tokens back into the bid it has just manufactured. Nothing is stolen from any user, but the reserve's ETH buys fewer tokens to burn and the difference lands in the attacker's pocket — **the deflation the tax was collected to deliver is skimmed away**. The victim is not some counterparty; it is the burn itself.

So every leg now carries a floor: `_buybackSqrtFloor` = `hook.twapSqrtPriceX96() × (1 - MAX_BUYBACK_SQRT_DEVIATION_BPS / 10000)`, i.e. **0.9 × the TWAP's sqrt price** (`MAX_BUYBACK_SQRT_DEVIATION_BPS = 1000`).

- **Anchored to the TWAP rather than slot0**: spot is the very quantity a sandwich displaces, so a spot-relative floor moves along with the attack and constrains nothing. Against the TWAP, once a front-run has dragged the price past the floor, this leg can only fill partially or falls straight into `BuybackSkipped`, leaving the attacker holding inventory with no exit.
- **It must `settle` the `spent` the pool actually took, not the `ethIn` it offered**: a binding floor means a partial fill, and paying against `ethIn` would leave the contract holding an unclaimed credit, which hits the unlock frame's all-deltas-zero check and reverts the entire swap of the innocent trader who happened to trigger the piggyback. Whatever goes unspent stays in the reserve for the next cycle.
- **With the TWAP absent it falls back to unbounded**: when the hook has no TWAP yet (the first window after launch, `twapSqrtPriceX96()` returns 0) or does not answer this interface at all, `_buybackSqrtFloor` returns `MIN_SQRT_PRICE + 1`. Refusing to buy is the worse failure — the reserve would stall permanently on any pool whose hook predates this interface.

**This is a "bound", not an "elimination"**: the 0.9 applies to the sqrt price, which converted to ETH-per-token means the pool is allowed to sit roughly 23% above the TWAP before the leg stops filling. `test_probeG_sandwichThePiggyback` @ `test/ToshV5Attack.t.sol` is a **measurement** probe (it records the edge, it asserts nothing), and it makes the point that the extractable size grows linearly with the reserve: `spend = max(1 ETH, 10% of the reserve)`, and with only one token listed that whole cheque lands in the same pool. `docs/SECURITY_AUDIT.md` accordingly records this item as "`MAX_BUYBACK_SQRT_DEVIATION_BPS = 1000` bounds the executable deviation" rather than as closed.

**How this relates to the off-chain harvest bot**: what allowed the bot to be deleted was not "there is no slippage floor" but that the piggyback path **never reverts** — every leg is wrapped in `try/catch`, and a failure just does `emit BuybackSkipped` and leaves the ETH for the next cycle. It is precisely because that fault isolation exists that adding the floor is free: a leg that violates the floor is skipped rather than taking an innocent trader's swap down with it.

**Key behaviour**: `_runPiggyback` **never reverts on a "not ready" condition** — the piggyback entry point sits in the hot path of ordinary user swaps, and a revert here would make the pool untradeable. Every precondition is an early return. `pokeBuyback` is the sole exception: it reverts `NotArmed`, because that is nobody's hot path and the caller has a right to know the call did nothing.
>
> **⚠️ 8.22**: the provenance check in `addLadderToken` settles "which pool the money is spent in"; it **does not settle "which projects enjoy the buyback"**. The owner can still list only their own or affiliated projects, or use `removeLadderToken` to exclude a project from the rotation permanently. That is the trust boundary of the curation power itself.

**Curation checks** (`src/ToshLadderTreasury.sol:200-226`):

| Check | Error |
|---|---|
| `token != 0` | `ZeroAddress` |
| Not already listed | `TokenAlreadyListed` |
| `factory != 0` | `FactoryNotSet` |
| `factory.tokenToHook(token) != 0` — **a token launched on this platform** | `TokenNotLaunchedHere` |
| `hook.launched()` — the pool must be open | `PoolNotLaunched` |
| `hook.twapSqrtPriceX96()` answers, and answers `!= 0` | `TwapNotMature` |
| `key.currency0.isAddressZero()` — ETH must be currency0 | `InvalidPoolKey` |
| `key.currency1 == token` | `InvalidPoolKey` |
| `key.hooks == hook` | `InvalidPoolKey` |

Liveness is asked for directly rather than inferred. It used to ride on the shape of the key — an unlaunched hook returned all zeros and failed the `currency1` arm with `InvalidPoolKey` — but the hook now restates its key from constants and `projectToken`, which is well-formed from the moment the token is set and therefore before launch. Hence the explicit `launched()` check and its own error, so "wrong platform" and "too early" are distinguishable; the second is a wait, not a mistake.

`TwapNotMature` is the same shape of answer and was added on 2026-09-11. `_buybackSqrtFloor` anchors the buyback's anti-sandwich bound to the hook's TWAP and treats both a zero reading and a reverting getter as "no reference, fill unbounded", so a token listed inside its first `TWAP_WINDOW` had no price bound on its buyback legs at all. That was held shut by an operational rule until the rule became the weaker half of the trade; see `SECURITY_AUDIT.md` §2.3 and `test_probeG3_immatureTwapIsRefusedAtListing`. Both doors are refused here, the reverting one included, because a getter that will not answer cannot be shown to have a bound. **The live treasury predates this check and cannot be given it** — `ToshFactory.ladderTreasury` is `immutable` and is baked into the hook implementation every launch clones — so there the rule and `STATE-07` are still the control.

**`removeLadderToken`** uses swap-and-pop to keep the array compact, which scrambles the rotation order — the comment calls that acceptable: the cursor only has to stay in range and be fair over the long run, not stay stable across a delisting (see `removeLadderToken` in `src/ToshLadderTreasury.sol`).

---

## 5. Security and anti-manipulation mechanisms

### 5.1 The triple price gate

| Gate | Mechanism | What it stops | Line |
|---|---|---|---|
| **1. Same-block mint ban** | Any swap on this pool writes `lastSwapBlock = block.number` in `afterSwap`; **`launch()` stamps it too**; `mintBondingCurve` reverts `SameBlockMintForbidden` outright when `block.number <= lastSwapBlock` | Flash-loan pump, mint in the same block, unwind. The price gate never sees that price before the flash loan closes. The `launch()` stamp closes the launch block deterministically at every raise size (§8.26) | `afterSwap` / `launch` / `mintBondingCurve` |
| **2. `min(spot, slow leg)` reference price** | `_safeReferencePrice()`: once the TWAP window has matured it takes `min(spot, TWAP)`; while the window is short of `TWAP_WINDOW` (including `twap == 0`) it takes `min(spot, p0)` rather than trusting a short-window stub | Pumping spot does not move the reference price; a two-block pump in the first 30 minutes after launch opens shelf 0 at most, and cannot clear a full run of tiers | `_safeReferencePrice` |
| **3. The 105% ceiling** | A tier's price must be `≤ 1.05 × reference price` | A tier unlocks only after the secondary market has **genuinely and durably** risen. The ladder is **pulled up** by real demand, not **pushed up** by the issuer | `PRICE_CEILING_BPS` / `mintBondingCurve` |

`maxMintable()` is bound by gate 1 as well (it returns 0 while `block.number <= lastSwapBlock`), because what it means is "how much can be bought right now" and the UI's max button reads it directly — offering a size the very next call is certain to reject only produces a failed transaction. `quoteMint` **deliberately** leaves the check out: a quote is a promise about the unit price a mint will pay in the next block, and the same-block lock says nothing about unit price.

Test coverage: `test_tierMintAntiSpikeAndCeiling` @ `test/ToshV5.t.sol` (gates 1 and 3, end to end); `test_tierMint_twapDefeatsASingleBlockPump` (a single-block pump under a matured window is stopped by the TWAP); `test_preTwapWindow_capsReferenceAtP0AgainstATwoBlockPump` (`min(spot, p0)` in the launch window stops a two-block pump); `test_ladderOpensLockedAtLaunch_acrossRaiseSizes` (the launch lock holds at every raise size from 1–10 ETH).

**Hook-local TWAP oracle** (`src/ToshLaunchpadHook.sol:418-430`, `1268-1328`):

Uniswap V4 core ships **no** observation buffer (V3 had one), so the hook accumulates `tick × elapsed` itself on every `afterSwap`:

```
_writeObservation():
    elapsed = now − lastObservationTs
    if elapsed > 0:
        tickCumulative += lastTick × elapsed
        lastObservationTs = now
        if now − _curCheckpointTs >= TWAP_WINDOW(1800s):
            _prev ← _cur ; _cur ← (now, tickCumulative)   // roll the checkpoint
    lastTick = poolManager.getSlot0(poolId).tick

_getTWAPPrice():
    span = now − _prevCheckpointTs ;  span < TWAP_WINDOW → return 0
    cumNow = tickCumulative + lastTick × (now − lastObservationTs)
    avgTick = (cumNow − _prevCheckpointCumulative) / span
    // Round toward negative infinity, matching Uniswap V3's OracleLibrary, so truncation never biases the TWAP upward
    if delta < 0 && delta % span != 0: avgTick--
    clamp to [MIN_TICK, MAX_TICK]
    return _sqrtPriceToEthPerToken(getSqrtPriceAtTick(avgTick))
```

**Keeping two rolling checkpoints rather than a full ring buffer** holds the per-swap cost at "one cold SSTORE per window" instead of "one on every trade" (`src/ToshLaunchpadHook.sol:1277-1280`).

> **⚠️ 8.20**: the price of that is **a realised window that floats between [1800, 3600) seconds** (`TWAP_WINDOW` natspec). `_getTWAPPrice()` returns 0 while `span < TWAP_WINDOW`; a short non-zero window (the first few seconds after launch) is not a TWAP, and is no longer reported as one. `_safeReferencePrice` takes `min(spot, p0)` under the same condition instead of trusting spot or the stub. A two-block pump in the first 30 minutes after launch therefore cannot push the ceiling open. Test `test_preTwapWindow_capsReferenceAtP0AgainstATwoBlockPump`.
>
> **⚠️ 8.29 (the TWAP's depth is this constant)**: the checkpoint rolls on "the first swap landing >= `TWAP_WINDOW` after `_cur`", and **anyone may supply that swap**. Hold the price for one window, poke with a dust swap, and the average converges on the manipulated level — measured at the old 600s setting, roughly 10 minutes was enough to bring the TWAP within 0.001% of the manipulated spot and open the full run of tiers. With two checkpoints there is no structural fix: **the depth simply is `TWAP_WINDOW`**. So the constant is a **price**, not a guarantee; 1800s triples the hold an attacker has to fund while still letting an honestly rallying market open its own ladder within the hour. Going deeper means a full ring buffer (a substantial rewrite, and it pushes the cost back to "one SSTORE per trade"). `test_probeB_twapReanchorSpeed` pins this behaviour down, and any retuning has to restate what it bought.
>
> **⚠️ 8.30 (the TWAP's two consumers now agree)**: `twapSqrtPriceX96()` used to return a reading whenever `span > 0` — a "one-second average" one second after launch. `_safeReferencePrice` never trusted it (it caps against `p0` until the window matures), but the treasury's `_buybackSqrtFloor` did, and that function treats 0 as its designed fallback: "no reference yet, fill this cycle unbounded". So the immature stub was **strictly worse than the fallback it should have got** — it anchored the anti-sandwich floor to a number a single swap could set. An unmatured window now returns 0 unconditionally, and both consumers agree on when a TWAP exists.

**Price conversion** (`src/ToshLaunchpadHook.sol:1330-1341`): ETH is currency0, `sqrtPriceX96 = sqrt(token/ETH) × 2^96`, so `ethPerToken = 2^192 / sqrtPriceX96²`. Evaluated as two `mulDiv` steps, because `sqrtPriceX96²` overflows uint256 at the top of the tick range.

### 5.2 EIP-1153 transient-storage reentrancy lock, and piggyback recursion suppression

**Two layers of lock**:

1. **OpenZeppelin `ReentrancyGuard` (persistent storage)**: the hook inherits `ReentrancyGuard` (`src/ToshLaunchpadHook.sol:145`, `1223-1519`), and `nonReentrant` covers `refund` / `launch` / `claimGenesis` / `claimReferralReward` / `mintBondingCurve`. The factory inherits it too and covers `createLaunch` / `deposit` (`src/ToshFactory.sol:37`, `657-717`, `740-766`).

2. **EIP-1153 transient flag (`tstore`/`tload`)**: the treasury parks a recursion guard in slot `0x546f73685069676779626163b1000001` (`src/ToshLadderTreasury.sol:79-85`, `359-363`, `385-389`). The reason for transient storage is that "the flag is only meaningful within the current transaction".

**Why recursion suppression is necessary** (`src/ToshLadderTreasury.sol:160-166`): a piggyback buys through **other** Tosh pools, and those pools' hooks would otherwise tax the buyback and **re-trigger a nested piggyback**. So the hook reads `piggybackActive()` early in both `beforeSwap` and `afterSwap`, and goes **fully passive** while it is set (`src/ToshLaunchpadHook.sol:1720`, `1774`):

```solidity
if (sender == ladderTreasury || _piggybackActive()) { /* zero delta, no tax, no poke */ }
```

`sender == ladderTreasury` is the first layer (swaps the treasury initiates itself are exempt outright); `_piggybackActive()` is the second (recursion across hooks). `test_piggyback_isolatesAFaultyLadderLeg` @ `test/ToshV5.t.sol` verifies that one broken leg cannot take down an innocent trader's swap.

### 5.3 The CREATE2 mask guarantees the hook's permission bits

See the mask table in 4.2. The essentials:

- V4's `PoolManager` uses the low 14 bits of the address to decide which callbacks to invoke. The mask `0x20CC` is the combination that gets this hook's five active permission bits actually called (four callbacks + `AFTER_SWAP_RETURNS_DELTA`).
- Beyond checking `REQUIRED_FLAGS`, `isValidHookAddress` re-checks V4's own consistency rule (a return-delta bit must have its matching action bit) (`src/libraries/HookMiner.sol:79-90`).
- The factory runs this check against the predicted address **before** deploying and reverts `InvalidHookSalt` if it fails, so it never deploys a hook V4 would never call (`src/ToshFactory.sol:385-386`).
- Tests `test_minedHookAddress_carriesV5FlagMask` @ `test/ToshV5.t.sol` and `test_hookMiner_requiredFlagsAre0x20CC` @ `test/ToshV5Guards.t.sol:215-219`.

**Pool-creation front-running defence**: `beforeInitialize` requires `sender == address(this)` and otherwise reverts `UnauthorizedInitialization` (`beforeInitialize` in `src/ToshLaunchpadHook.sol`). The pool can therefore **only** be created from inside the hook's own `launch()`; an outsider cannot get in first and stand this pool up at a different opening price. Test `test_beforeInitialize_revertsForExternalSender` @ `test/ToshV5Guards.t.sol`.

### 5.4 Permanently locked genesis liquidity, and isolation from retail LPs

Covered in detail in 4.4. Additional points:

- **The lock does not come from a callback.** It comes from "V4 attributes positions by `msg.sender`, and the hook has no removal code path". `beforeRemoveLiquidity` is now nothing but a pass-through, and V4 does not even call it (that bit is not set in the mask) (`beforeRemoveLiquidity` in `src/ToshLaunchpadHook.sol`).
- Retail LPs use **their own** position key; adding and withdrawing never touch the genesis position. `test_retailLp_canAddAndRemoveWithoutTouchingGenesis` @ `test/ToshV5.t.sol` asserts separately that genesis liquidity is unchanged after the add and after the withdrawal.
- `TICK_SPACING = 200` exists to keep `TICK_LOWER/UPPER = ∓887200` aligned and the genesis range unchanged. The cost is that retail LPs can only place range bounds on a grid of roughly 2% — the comment concedes this is "coarse but workable for a freshly launched token" (`src/ToshLaunchpadHook.sol:304-308`).

### 5.5 The treasury's one-way valve

`src/ToshLadderTreasury.sol:37-51` sets out a **greppable audit checklist** (which must produce zero matches in that file):

```
· function withdraw    — absent by design
· function sweep       — absent by design
· function rescue      — absent by design
· delegatecall         — absent by design
· .transfer( / .call{value  outside _buyAndBurn — absent by design
```

The only code path that moves ETH out is `_buyAndBurn`, whose output currency is hard-wired to `DEAD_ADDRESS`. The owner's power is confined to "curating which tokens sit on the ladder".

`executeBuyAndBurn` is `external` purely so that `_runPiggyback` (shared by the piggyback and `pokeBuyback` entry points) can use `try/catch` for per-leg fault isolation; the `onlySelf` modifier guarantees nobody but the contract itself can call it. Test `test_executeBuyAndBurn_isNotCallableExternally` @ `test/ToshV5.t.sol`.

### 5.6 Known property one: the shelf-arbitrage window (explicitly accepted as a product decision)

> **This section records the situation as it stands; it does not claim it is "solved".**

**Mechanism**: the 105% gate is a **ceiling, not a floor**. It refuses only shelves priced **above** `min(spot, TWAP) × 1.05`, and says **nothing at all** about shelves priced **below** the reference. Therefore:

- After the market has risen on its own, the low shelves (`tierPriceAt(0)`, `tierPriceAt(1)`…) sit **deep in the money**.
- The cursor advances 0.190% per 3,150 tokens sold, while **a single swap can push the price up by any amount**. The ladder cannot keep up with the market.
- So anyone — **not just the project** — can sweep those in-the-money shelves and dump them back into the pool at a profit.

**The corresponding assertion in the code** (`test/ToshV5.t.sol`, test name `test_sweepIsProfitableOnceTheMarketHasRunAhead`):

The test's natspec says so without flinching; the substance of the original:

> "The 105% gate is a ceiling, not a floor. It refuses shelves priced ABOVE `min(spot, TWAP)` and says nothing about shelves priced below, so appreciation leaves the low shelves in the money. That spread is the entire incentive to sweep, and sweeping is how the ladder tracks a market that has moved: the cursor advances 0.190% per 3,150 tokens while a single swap can move price by any amount.
>
> The cost is real and is borne by holders — the sweeper's exit drains pool ETH and pushes price back toward the cursor, which caps how far a rally can durably run. **This is an accepted trade, not an oversight.** If it is ever revisited, the fix is a floor on the charged unit price (`max(tierPriceAt(i), min(spot, TWAP))`), which needs no change to the shelf ledger."

The test runs the arbitrage for real through a `FreeRider` contract (which holds and spends its own ETH, avoiding the accounting mismatch `vm.prank` introduces — see `test_sweepIsProfitableOnceTheMarketHasRunAhead` @ `test/ToshV5.t.sol`), asserts `address(rider).balance > before`, and pins the magnitude with `assertLt(profit, cost * 2)` (so a future pricing change cannot **quietly widen** the window).

**Measured figures (from the product side's measurement run)**:

| Scenario | Sweep cost | Net profit | Return | Privilege |
|---|---|---|---|---|
| Market pumps first with 0.5 ETH; an outside arbitrageur sweeps and dumps back into the pool | 0.0689 ETH | 0.0683 ETH | ≈ **+99%** | **None whatsoever** |
| The same operation, run by the project (which earns the 99% shelf rebate) | 0.0689 ETH | 0.1366 ETH | ≈ **+198%** | Only `projectAdmin`'s rebate |

> **No basis found in the code for these three specific numbers.** The repository holds only a qualitative assertion (`assertGt(balance, before)`) and a magnitude bound (`profit < cost × 2`); `test_sweepIsProfitableOnceTheMarketHasRunAhead` uses `_openLadder(hook, 0.5 ether)`, the same 0.5 ETH pump size (`test/ToshV5.t.sol`) as the table's setup, but the exact cost and profit values are the output of one measurement run, not an assertion checked into the repository. If regression protection is wanted, freeze these three numbers — or a lower bound on their ratios — into assertions.

**The product decision, reported faithfully**:

1. This is a mechanism that was **explicitly accepted**, not an oversight.
2. It is **what drives the shelves to track the market price** — without that spread the cursor would never catch a market that has already run.
3. The cost is **a soft cap on the token price**: the arbitrageur's exit drains pool ETH and pushes the price back toward the cursor, limiting how far a rally can durably run.
4. That cost is borne by **LPs and secondary-market holders**.
5. Because the project earns the 99% shelf rebate, the same operation returns roughly twice what it does for an outside arbitrageur. The rebate does not change whether the arbitrage works, it only magnifies the project's take.
6. **If it is ever to be narrowed**: the fix is a market floor on the charged unit price, `max(tierPriceAt(i), min(spot, TWAP))`. That changes only how a single leg is priced and **needs no change to the shelf ledger** (the semantics of `currentTierIndex` / `currentTierSold` / `phase2Minted` are untouched).

**The contrast: when sweeping loses money** (`test_sweepAndDumpIsLossMaking` @ `test/ToshV5.t.sol`). When the market has **not** run ahead of the ladder, a sweep must lose. The reason is structural: shelf minting never touches the pool, so it cannot drag spot up behind it; the buyer pays at least 1.05× the market price and then has to push that same market **down** with their own size in order to sell, and that is before the 1.30% of round-trip friction. The assertion is "the loss must be > 1/20 of the cost" (a substantive loss, not a marginal one).

**Only the two tests together are the full product statement**: mint-and-dump on the spot always loses; lagged arbitrage (where the market rises first) reliably pays. The first is a security property, the second is a cost of the design.

### 5.7 Known property two: the trust boundary around treasury curation

**Where it stands (the part that is fixed)**: `addLadderToken` now **enforces provenance on the token** — it must be a project registered in this platform's `tokenToHook` and **already launched** — and the buyback pool's `PoolKey` is **read back from the hook rather than supplied by the owner** (`src/ToshLadderTreasury.sol:318-355`).

**The attack path that was closed** (for the original comment, see the `addLadderToken` notes in `src/ToshLadderTreasury.sol`): earlier versions let the owner pass an arbitrary `PoolKey` alongside the token, validating only currency ordering. That **silently punched through the one-way valve**: the owner could mint a worthless ERC-20, pair it in a hookless pool where they were the only liquidity provider, list it on the ladder, and have every 1 ETH buyback settle into their own position — **skimming a little on each trigger**, while the chain showed nothing but perfectly ordinary `BuybackBurned` events.

**Two facts now make the venue unforgeable**:
1. `tokenToHook` proves the token was launched by this platform;
2. the `PoolKey` is read back from that hook, so the ETH can only be spent in the deep genesis pool that hook itself polices.

Both rest on `factory`, **which is exactly why its binding has to be one-shot** — a re-pointable factory would hand the answers to both of those questions back to the owner (`src/ToshLadderTreasury.sol:193-196`).

Tests: `test_ladderCuration_rejectsForeignTokens` @ `test/ToshV5.t.sol`; `test_ladderTreasury_ownerCannotRedirectSpendToOwnPool` @ `test/ToshV5.t.sol` (whose natspec goes out of its way to note that "probing for a `withdraw` selector proves nothing; the real extraction route is redirecting where the spend goes").

**The trust boundary that remains (⚠️ 8.22)**: provenance checking answers **"which pool the money is spent in"**, not **"which projects get the buybacks"**. The owner can still:
- list only their own projects or those of affiliates;
- use `removeLadderToken` to exclude a project from the rotation permanently;
- influence `currentCursor`'s rotation order through listing order (the swap-and-pop in `removeLadderToken` scrambles the order, as the comment concedes).

This is the boundary of the **curation power itself**, not something code can remove. Narrowing it is a governance job (replace the owner with a multisig or DAO; `script/DeployMainnet.s.sol:97-102` already enforces `PROD_OWNER_SAFE != deployer` and does a two-step handover).

### 5.8 Other security design

| Mechanism | Notes | Line |
|---|---|---|
| `ToshToken` has no `DEFAULT_ADMIN_ROLE` | The constructor grants no role at all, and `initialize` grants only `MINTER_ROLE` to the hook. The result: **no address can call `grantRole`/`revokeRole`**, and the only change left is the hook calling `renounceRole` on itself | `src/ToshToken.sol:74`, `151-164` |
| Hard cap checked on every mint | `totalSupply() + amount > MAX_SUPPLY` → `MaxSupplyExceeded` | `src/ToshToken.sol:111-114` |
| **No** kill-switch (deliberately) | There used to be a `renounceMinterRole()`, written into the docs as an emergency escape hatch. In fact only `MINTER_ROLE` could call it, that role belonged solely to the hook, and the hook had no code path that called it — unreachable by anyone on a deployed system. Its test passed only because it forged the hook as the caller. Better deleted than kept as a safety control that does not exist: supply is capped mint by mint by `MAX_SUPPLY` inside `mint`, and nobody has to intervene | `ToshToken.mint` (the comment at the end of the file records why it was deleted) |
| `Ownable2Step` | Both the factory and the treasury use a two-step handover; the Safe has to call `acceptOwnership` itself | `src/ToshFactory.sol:36`; `src/ToshLadderTreasury.sol:62` |
| Launch-fee slippage protection | The `expectedFee` parameter stops the owner front-running a fee increase | `src/ToshFactory.sol:339-341`, `358-359` |
| Name-squatting defence | The `(name, symbol)` tuple is claimed once and for all | `src/ToshFactory.sol:143`, `364-365`, `408` |
| Creator-bound salt | `finalSalt = keccak256(abi.encode(creator, rawSalt))` — somebody else's salt is worthless in your hands | `createLaunch` in `src/ToshFactory.sol` |
| `SafeCast.toInt128(tax)` | The one value handed back to V4's flash accounting gets a checked cast; a silent truncation would misreport the tax taken | `src/ToshLaunchpadHook.sol:1118-1120` |
| TWAP rounds toward negative infinity | Matches Uniswap V3's `OracleLibrary`, so truncation never biases the TWAP upward | `_twapSqrtPriceX96` in `src/ToshLaunchpadHook.sol` |
| Post-deployment invariant sweep script | `VerifyDeployment.s.sol` asserts 6 classes of invariant, including `treasury.factory() == factory` (left unwired, it silently switches off every buyback in that deployment) | `script/VerifyDeployment.s.sol:55-109` |
> **⚠️ 8.12**: `Pausable` covers only **two** entry points on the factory — `createLaunch` and `registerPoG`.
>
> **`deposit` is not one of them.** It carries `nonReentrant` only, not `whenNotPaused` (`deposit` in `src/ToshFactory.sol`), so **a genesis round that is already open keeps taking money during a pause**. That is deliberate, and it is the same principle that keeps refunds unpausable: a round the platform has already opened its doors to collect on must not be cut off midway by an owner's switch. `test_pause_doesNotBlockDepositIntoALiveRound` and `test_pause_doesNotBlockRefund` @ `test/ToshV5Factory.t.sol` pin both sides of it.
>
> This entry long read, wrongly, as "three entry points, including `deposit`", and §2 Step 2 of the incident runbook copied the error straight across. **The cost of an error like this is a wrong call during an incident** — the responder believes hitting pause has stopped deposits coming in, and it has not. Corrected along with the rest after the v5.0 red-team review.
>
> **On the hook side, `launch` / `mintBondingCurve` / `claimGenesis` / `claimReferralReward` / `refund`, along with every swap and LP operation on the pool, are unaffected by `pause()`.**
>
> **Partly superseded by D3**: `pause()`'s coverage is unchanged, but the platform now has a separate brake, `haltLadderMinting`, which can stop **ladder minting** on an already-launched project, and nothing else. It expires automatically within 7 days, can be scoped per project, and touches no user-balance path. So "there is no protocol-level circuit breaker at all" no longer holds. The accurate statement is: **the platform can stop selling the ladder; it cannot stop trading, cannot stop claims, cannot stop refunds**. See §11 D3.

---

## 6. Frontend and user-interaction specification

Stack: Next.js (App Router) + wagmi v2 + viem. The target chain is decided by `NEXT_PUBLIC_CHAIN_ID`, and three are supported: **Robinhood Chain (4663)** as the settlement mainnet, **Robinhood Chain testnet (46630)** for public staging, and **Foundry (31337)** as the local devnet. Chain names and "is this a throwaway environment" are derived without exception (see 6.3); components never carry the literals. What this chapter previously said — "target chain: Base Sepolia (84532), mainnet nominally Ethereum" — is void in its entirety.

### 6.1 Page and component inventory

| Path | Role | Notes |
|---|---|---|
| `soat-frontend/src/app/page.tsx` | Home | Extremely thin; forwards to the directory home |
| `soat-frontend/src/app/launch/page.tsx` | **Launchpad** (Genesis Console) | 34KB. Form + three genesis-duration tiers + client-side salt mining + Immutable Pact sidebar |
| `soat-frontend/src/app/projects/page.tsx` | Project list | Now nothing but a `redirect()`; the directory/radar view has moved to `soat-frontend/src/components/directory/` (`AgentDirectoryHome.tsx` and friends) |
| `soat-frontend/src/app/projects/[address]/page.tsx` | Project detail | Mounts `ProjectTerminal` |
| `soat-frontend/src/components/ProjectTerminal/` | **Project terminal** (the canonical implementation, now split into a directory) | `index.tsx` holds the phase state machine and the batched reads; one file per panel (`GenesisPanel`, `BondingPanel`, `LiquidityPanel`, `RefundPanel`, `AwaitingLaunchPanel`, `GenesisClaimPanel`, `ReferralPanel`, `QuotaLedger`, `HeroStats`, `ShelfLadder`, `PogScanButton`), plus `phase.ts` / `format.ts` / `pogAuthCache.ts` |
| `soat-frontend/src/app/admin/page.tsx` | Owner Command Center (51KB) | Soft cap / launch fee / quota / cooldown / blacklist / signers, all through the factory's owner functions |
| `soat-frontend/src/components/UserDrawer.tsx` | Personal sovereignty console | PoG quota, cooldown matrix, assets already participated in, plus the `claimGenesis` entry point |
| `soat-frontend/src/components/NetworkGuard.tsx` + `NetworkGuardClient.tsx` | Network guard | See 6.3 |
| `soat-frontend/src/app/api/pog/*`, `sign-allocation`, `admin/config`, `projects` | Server routes | PoG signing (the server holds the private key), directory sync, admin config |

**Shared layer**:

| File | Responsibility |
|---|---|
| `soat-frontend/src/lib/contracts.ts` | **The single source of truth**: addresses, chain ID, and the constant guardrails mirrored over from Solidity. The `src/app/lib/contracts.ts` re-export shim that used to sit alongside it has been deleted |
| `soat-frontend/src/app/lib/abis.ts` | FACTORY/HOOK/ERC20 ABIs. The second copy that used to exist at `src/abis/index.ts` (identical content) has been deleted; this is now the only one |
| `soat-frontend/src/app/lib/hookMiner.ts` | The CREATE2 miner in TypeScript (a mirror of Solidity's `HookMiner`) |
| `soat-frontend/src/lib/v4Math.ts` | The slice of V4 fixed-point math the LP panel needs |
| `soat-frontend/src/lib/lpActions.ts` | posm action payload encoding |
| `soat-frontend/src/lib/useLpPosition.ts` | Retail LP data layer (position discovery) |
| `soat-frontend/src/app/lib/useTosh.ts` | wagmi wrappers for `createLaunch` / `registerPoG` (two isolated slots) |
| `soat-frontend/src/components/ui/actionGate.tsx` | The one gate in front of every write button in the app: `useActionGate` (wallet / network / busy / permission / business blockers, short-circuiting in that order), `revertOrder`, `ActionButton`. Replaces the CTA state machine each page used to hand-roll |
| `soat-frontend/src/components/ui/useTxAction.ts` | `useTxAction`: dispatch and lifecycle for a single write transaction. Replaces the former `src/app/lib/useContractActions.ts` (a four-in-one wrapper over deposit / claim / refund / mint, deleted) |

### 6.2 Constant guardrails mirrored from Solidity

The file header of `soat-frontend/src/lib/contracts.ts` (`:10-12`) says what these constants are **for**: they are audit-cliff guards the UI MUST honour locally, so that the wallet popup **never opens for an obviously doomed transaction**.

| Constant | Value | Mirrored from | Line |
|---|---|---|---|
| `MIN_SOFT_CAP_PROD` | `10n ** 16n` (0.01 ETH) | `Factory.MIN_SOFT_CAP_PROD` | `:114` |
| `GENESIS_SUPPLY` | 8,400,000e18 | `Hook.GENESIS_SUPPLY` | `:117` |
| `GENESIS_CLAIM_SUPPLY` | 4,620,000e18 | `Hook.GENESIS_CLAIM_SUPPLY` | `:117` |
| `GENESIS_LP_SUPPLY` | 3,780,000e18 | `Hook.GENESIS_LP_SUPPLY` | `:117` |
| `BONDING_MAX` | 12,600,000e18 | `Hook.BONDING_MAX` | `:118` |
| `TIER_COUNT` | 4000 | `Hook.TIER_COUNT` |
| `TIER_SIZE` | 3,150e18 | `Hook.TIER_SIZE` |
| `PRICE_CEILING_BPS` | 10,500 | `Hook.PRICE_CEILING_BPS` | `:125` |
| `MAX_TIERS_PER_TX` | 32 (the comment insists on "read the on-chain `maxMintable()` first") | `Hook.MAX_TIERS_PER_TX` | `:128-133` |
| `TIER_STEP_E18` / `LADDER_SPAN` | `1_001_902_508_266_805_824` / 2000 | `Hook.TIER_STEP_E18` | `:149-155` |
| `TICK_LOWER` / `TICK_UPPER` | ∓887,200 | `Hook.TICK_LOWER/UPPER` | `:63-64` |
| `POOL_FEE` / `TICK_SPACING` | 3000 / 200 | `Hook.POOL_FEE/TICK_SPACING` | `:65-66` |
| `ADMIN_BATCH_MAX` | 200 | the `require` in `Factory.setBlacklist` | `:135` |
| `REQUIRED_FLAGS` | `0x20CC` | `HookMiner.REQUIRED_FLAGS` | `hookMiner.ts:6` |
| `GENESIS_DURATION_*` | 10,800 / 86,400 / 259,200 seconds | `Hook.DURATION_*` | `hookMiner.ts:41-43` |

**On-chain addresses, and which of them the environment can move** (`POOL_MANAGER` / `POSITION_MANAGER` / `PERMIT2` / `STATE_VIEW` @ `soat-frontend/src/lib/contracts.ts`) — one is a source constant and three are `envAddress(...)` lookups with a fallback, so the header cannot say "hard-coded" of the table as a whole; 8.24 below has the split:

| Constant | Address | Remarks |
|---|---|---|
| `POOL_MANAGER` | `0x8366a39CC670B4001A1121B8F6A443A643e40951` | **Deliberately not env-bound** — a wrong PoolManager silently mis-CREATE2s every single hook, so it gets no escape hatch and a cutover here is a reviewed source change. Uniswap deployed V4 on Robinhood themselves and 4663 and 46630 **share the address**, so unlike the Base era there is no testnet/mainnet split to get wrong and a rehearsal exercises the production value |
| `POSITION_MANAGER` | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` | The retail LP entry point. Same address on 4663 and 46630, 23,877 bytes of runtime on each, so the fallback is correct on either without an override |
| `PERMIT2` | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | Canonical on every chain, overridable only just in case. Present on both Robinhood chains |
| `STATE_VIEW` | `0xF3334192D15450CdD385c8B70e03f9A6bD9E673b` | Read-only `getSlot0`, so the LP panel sizes a deposit off the real `sqrtPriceX96` rather than a derived spot. Same address on both Robinhood chains |

> **This table used to list the Base-era addresses**, and all three of the movable ones had changed: `POOL_MANAGER` read `0x05E73354…`, `POSITION_MANAGER` `0x4b2c77d2…`, `STATE_VIEW` `0x571291b5…`, and the posm remark still warned about a Base Sepolia deployment built against the wrong PoolManager. `eth_getCode` returns `0x` for all three on 4663 — they are not contracts on the chain this product now runs on. Only Permit2 was unaffected, by being canonical everywhere. A stale address table is the specific thing that misleads someone checking a cutover, which is how PM-C7 went wrong for a day; the four above were read out of `contracts.ts` and each confirmed to carry runtime on 4663.

Only `FACTORY_ADDRESS` (required; a missing value throws at module load, before any component renders) and `LADDER_TREASURY_ADDRESS` (optional) come from the environment.

> **⚠️ 8.24 (substantially narrowed)**: the `NetworkGuard` half no longer holds — it reads `TARGET_CHAIN_ID` now, and the chain ID together with every piece of chain-name copy is driven by `NEXT_PUBLIC_CHAIN_ID`. Of the four addresses, only `POOL_MANAGER` is hard-coded on purpose (the comment spells out why: a wrong one silently mis-CREATE2s, so it gets no environment-variable escape hatch); `POSITION_MANAGER` / `PERMIT2` / `STATE_VIEW` all go through `envAddress(...)` and fall back to the Robinhood addresses when unset. **The accurate statement is: switching chains is an environment change, and only switching PoolManager is a code change.**

### 6.3 Wallet connection and the `NetworkGuard` network guard

`NetworkGuard()` in `soat-frontend/src/components/NetworkGuard.tsx`:

- An SSR/CSR mount guard (`mounted` state) to avoid a hydration mismatch.
- Render condition: `mounted && isConnected && chainId !== TARGET_CHAIN_ID`. When disconnected, or already on the right chain, it **returns null** — it does not hold space.
- It shows an amber strip: `Wrong network — Tosh settles on {MAINNET_CHAIN_LABEL}` + `; staging runs on {ACTIVE_CHAIN_LABEL}` appended only when `IS_TESTNET` + `. Switch to continue.`, with a `switchChainAsync({ chainId: TARGET_CHAIN_ID })` button whose failure is swallowed by `.catch(() => {})`. That conditional append is necessary: on a mainnet build both labels hold the same value, so appending unconditionally would read "settles on Robinhood Chain; staging runs on Robinhood Chain".
- The launchpad page carries a guard layer of its own on top: when `isWrongNetwork`, `useActionGate` swaps the primary CTA for `Switch to {ACTIVE_CHAIN_LABEL}`, and `handleLaunch` still calls `switchChainAsync` itself and waits 300ms before broadcasting.

**Chain names are derived without exception, never written as literals.** All of this copy comes out of `soat-frontend/src/lib/chain.ts` (`MAINNET_CHAIN_LABEL` / `ACTIVE_CHAIN_LABEL` / `IS_TESTNET` / `CHAIN_BYLINE` / `CHAIN_STATUS_BADGE` / `CHAIN_POSITIONING` / `CHAIN_STAGING_NOTE`), and `soat-frontend/scripts/checkChainCopy.mjs` evaluates the whole set once per chain on all three (4663 / 46630 / 31337) — looking only at the chain you are currently on finds nothing, because the wrong copy only ever appears on the chain you are not running. The same guard makes a second pass as an AST literal scan: no string, template or JSX text under `src/` may contain a retired chain name (`base sepolia`, `basescan`, `sepolia`), nor hard-code the name of the current settlement chain outside `chain.ts`. Comments are out of scope, so that historical notes like this one can go on being written.
- Every write is bound to the target chain, so wagmi refuses outright on the wrong chain rather than broadcasting to it. **The binding point has been pulled in from the individual call sites to a single place**: `useTxAction` (`soat-frontend/src/components/ui/useTxAction.ts`) injects `chainId: TARGET_CHAIN_ID` uniformly inside `send` / `sendAsync`, and **deliberately keeps `chainId` out of the `TxRequest` type** — a caller can neither forget it nor override it. Every panel in ProjectTerminal and in admin goes through this path; the two slots in `useTosh.ts`, `createLaunch` and `registerPoG`, still carry `chainId: TARGET_CHAIN_ID` in their own `writeContract` calls.

### 6.4 The launchpad form (`/launch`)

**Form fields** (`soat-frontend/src/app/launch/page.tsx`):

| Field | State | Notes | Line |
|---|---|---|---|
| Agent Name | Editable | Required | `:609-614` |
| Ticker (Symbol) | Editable, auto-uppercased | Required | `:615-621` |
| Project Treasury | **Read-only, locked to the connected wallet** | `treasury = address` (`:468`) | `:622-629` |
| Project Admin | Editable, prefilled with the connected wallet | Validated with `isAddress`; an amber hint when it differs from the wallet | `:630-652` |
| **Genesis Window** | Three-tier segmented control | See below | `:653-661` |
| Logo | Optional, off-chain directory only | File upload via `LogoField` → `POST /api/projects/logo`, or a pasted URL. The URL is inside the directory attestation, so an in-flight upload blocks Deploy. | Token card, always visible |
| Manifesto / Website / Twitter / Telegram | Optional, off-chain directory only | Goes through `POST /api/projects` | collapsed details |
| Acknowledgement checkbox | Must be ticked before the form can be submitted, and only becomes tickable once the dials have been read | Restates **four** things: the launch fee, the **minimum raise** (the page's word for the soft cap throughout the consent copy), a genesis window that cannot close early, and the full refund if the raise misses or the 7-day window to open trading expires unused. There is no mention of the cooldown anywhere on this page | `:696-714` |

**The tick binds to the numbers, not to the act of ticking.** `ackedTerms` holds `{ fee, softCap }` — the values that were on screen when the box was checked — and `ack` is only true while both still equal the live readings. The comment says why a `boolean` was wrong: it made consent portable between different pacts, so a tick could outlive the numbers it was given for. For the same reason the box is disabled until the dials are readable, because with `feeDisplay` and `softCapDisplay` falling back to an em dash the pact rendered as "I accept the immutable pact: — ETH launch fee, — ETH minimum raise" beside a box that could still be ticked — never signable, since the deploy button was already gated on `dialsReady`, but a consent statement presenting blanks as terms all the same.

**The three-tier genesis-duration segmented control** — it is **not** an extracted component (the `GenesisWindowSelect` this section used to name does not exist); it is an inline block of `role="radiogroup" aria-label="Genesis window"` inside `soat-frontend/src/app/launch/page.tsx`, with the selection logic in `pickWindow`:

- `role="radiogroup"` plus three `role="radio"` buttons, with `aria-checked` set correctly (accessibility is in place).
- The copy above the control is the card's own subtitle, `"Immutable. The window runs to completion even if the soft cap fills in minutes."` — this section used to quote it as `"immutable once deployed"`, a string that appears nowhere in the source. It is the warning 8.1 (new) called for: the window does not end early on reaching the soft cap.
- Each tier shows its positioning line underneath (see the table in 4.3.1).
- Defaults to `GENESIS_DURATION_STANDARD` (24h).

**The Immutable Pact sidebar** (`:194-230`, `:472-481`) — a sticky panel in the right column, and **the distinction it draws is the point of it**: a card of things that can never change, and beside that a readout of things that can.

The card is headed `Immutable rules`, subtitled "Unalterable the moment your launch confirms.", and holds **four** `<PactRule>` items — a kicker, a title and a body each:

| Kicker | Title | Body |
|---|---|---|
| 40% (`shareOf(GENESIS_SUPPLY, TOTAL_SUPPLY)`) | `8.4M genesis` | 4.62M claimable to depositors · 3.78M locked as genesis LP |
| 60% (`shareOf(BONDING_MAX, TOTAL_SUPPLY)`) | `12.6M ladder` | `{TIER_COUNT}` equal shelves across a `{LADDER_SPAN}`× span — 4000 and 2000, read from the mirrored constants. "Unsold supply can never be reminted" |
| 10% | `Genesis premium` | Splitting genesis 55/45 between claims and pool liquidity opens the market at 1.10× what depositors paid |
| 7 days | `Unopened raise refunds in full` | If trading is never opened after a successful raise, every depositor reclaims 100% of their ETH. No penalty, no haircut |

Underneath, in a separate `CardWell`, sits a readout headed `Live factory dials`: launch fee / soft cap / per-wallet cap / network, each rendered from a live read and falling back to an em dash when the factory has not answered. **These are dials, not rules** — the platform owner can retune all three of the numbers, which is exactly why they are not in the card above; what freezes them for a given project is the snapshot taken at `createLaunch`, not the sidebar.

The list this section used to give had eight entries and crossed the boundary in both directions: the launch fee, the genesis soft cap and the per-wallet cap are live dials rather than immutable rules; the genesis window is stated on its own card (see the segmented control above) rather than as a rule; "target mainnet" is not on the page at all; there is no per-wallet-cap **rule**; and the ladder rule reads 4000 shelves, not "2 000-shelf ladder". The amber refund note it described as sitting below the rules is gone too — refunds are now rule four itself, and what sits below the dials is a "What this costs you" readout (launch fee due now, the gas to create, the gas to open the pool later) followed by the "No proxy, no admin key, no upgrade" line that 8.17 calls for.

**The primary CTA is no longer this page's own state machine.** The `LaunchCTA` this section used to describe, and its `feeMode` (`'loading' | 'insufficient' | 'broadcasting' | 'confirmed' | 'launch'`), are both gone; the deploy button is driven by the shared `useActionGate` / `revertOrder` / `ActionButton` @ `soat-frontend/src/components/ui/actionGate.tsx`, exactly like every other write button in the app.

`useActionGate` handles the preconditions common to every page first, short-circuiting in this order of priority:

| Order | Condition | `kind` | Button |
|---|---|---|---|
| 1 | `!hydrated` | `connect` | `Connect Wallet` (disabled) |
| 2 | `requiresWallet && !isConnected` | `connect` | `Connect Wallet` / `Connecting…`, clickable to start connecting |
| 3 | `requiresNetwork && isWrongNetwork` | `switch` | `Switch to {ACTIVE_CHAIN_LABEL}`, clickable to switch chains |
| 4 | `busy` | `busy` | `Awaiting signature…` / `Confirming…` |
| 5 | The ambient permission gate has not cleared | `blocked` | `[read_only]` and the like (`ambient-gate`) |
| 6 | First hit in `blockersInRevertOrder` | `blocked` | See the table below |
| 7 | Everything clear | `ready` | `Deploy — {fee} ETH` |

Row 1 **deliberately produces a determinate value before hydration**, so the server markup matches the client's first frame — it replaces the `mounted` flag each surface used to carry for itself. Row 3's label reads from `ACTIVE_CHAIN_LABEL`, which is why the old copy "Switch to Base Sepolia" was both a hard-coded literal and the wrong chain.

**This page's own blockers** (`blockersInRevertOrder`):

| `id` | Locked label | Trigger |
|---|---|---|
| `identity` | `Name the token first` | Name / ticker / a valid admin are not all present — they are frozen into the token the moment it deploys |
| `dials-unread` | `Reading the terms…` | The launch fee, the minimum raise and the per-wallet cap have not been read yet |
| `dials-unreachable` | `Factory unreachable` | The factory does not answer on the target chain; signing against an unknown fee either fails or overpays |
| `ack` | `Acknowledge the pact` | Not ticked |
| `insufficient-fee` | `Need {X} ETH` | Balance short of **the launch fee plus estimated gas at the current fee rate** |
| `mining` | `Finding your pool address…` | Salt mining is running in the browser |
| `confirmed` | `Launch confirmed` | Already on chain; the directory listing is running in the background |

Note the substantive difference between `insufficient-fee` and the old `feeMode`: it computes `launch fee + createGas`, whereas the old version only compared `ethBalance < launchFeeWei` — a wallet with exactly enough for the fee but nothing left for gas sailed through the old logic and then failed in the wallet.

**After submission**: it parses the `LaunchCreated` event out of the receipt to get `token`/`hook`; if that parse fails it falls back to `launchCount()` + `launches(count-1)` to read the last entry. Off-chain directory sync now **requires a signature**: `buildProjectAttestationMessage` (which binds `chainId` and `txHash`) is signed through `signMessageAsync` and submitted along with `POST /api/projects`. Refusing to sign costs the listing only, not the launch — the token is on chain regardless, and `rememberProject` has already written it into this browser's cache, so the redirect still lands on a page with something on it. The status strip shows `Syncing… / ✓ Directory synced / Directory sync deferred`.

### 6.5 Client-side salt mining and cache-invalidation conditions

**Salt mining is no longer a step the user takes on their own.** The `handleMineSalt` this section used to describe, and the `!saltLocked → "Mine a hook salt first"` rung on the primary CTA, are both gone. The function now is `mineSalt` @ `soat-frontend/src/app/launch/page.tsx`, called internally by `handleLaunch` — the user clicks "Deploy" once and mining runs to completion as one link in that chain, during which the gate shows the `mining` blocker `Finding your pool address…`.

**The flow** (`mineSalt`):

```
1. Preconditions: address && publicClient && adminAddr all ready
2. Read three on-chain values live (not the cached useReadContracts results, to avoid staleness):
     liveSoftCap   = factory.defaultSoftCap()
     liveWalletCap = factory.maxPogAllocationLimit()
     initcodeHash  = factory.hookInitcodeHash(
                        treasury, creator,
                        liveSoftCap, liveWalletCap, genesisDuration)
3. mineHookSalt(FACTORY_ADDRESS, address, initcodeHash)
     for i = 0 .. 500_000:
         rawSalt   = i, zero-padded to 32 bytes
         finalSalt = keccak256(abi.encode(creator, rawSalt))
         addr      = "0xff" ++ factory ++ finalSalt ++ initcodeHash → keccak → take low 20 bytes
         if isValidHookAddress(addr): return { rawSalt, finalSalt, hookAddress }
     otherwise throw "no valid salt found within 500000 attempts"
4. setSalt(rawSalt) + setPredictedHook(hookAddress)
```

Miner implementation: `soat-frontend/src/app/lib/hookMiner.ts:128-143` (`computeCreate2Address` @ `:17-24`, `isValidHookAddress` @ `:27-35`, `deriveFinalSalt` @ `:105-115`). It is a line-by-line mirror of Solidity's `HookMiner`, including all four return-delta consistency rules.

**The load-bearing design choice**: `initcodeHash` is **read back off the factory on chain** (`factory.hookInitcodeHash(...)`) instead of being recomputed locally in the frontend. That eliminates an entire class of problem: "bytecode snapshot goes stale → you mine a dead salt".

> **This paragraph is itself worth a note.** It used to carry a parenthetical: "though `test/ToshV5Bytecode.t.sol` still guards that snapshot, which shows it is still depended on elsewhere." That inference was wrong, and wrong in a thoroughly typical way — **the existence of a guard was taken as evidence of being depended on**. In fact no file has ever imported `HOOK_BYTECODE`; it is a leftover from before the EIP-1167 clone refactor, after which the hook's initcode carries the implementation contract's address and the frontend never touches the hook's creation code at all.
>
> The cost was not zero: that guard, its extraction script, the CI step, the permission opened for it in `foundry.toml`, and three comments claiming it was critical (one of them auto-generated, so an edit gets written straight back) together produced several hours of red CI and a full round of metadata investigation. The snapshot, the guard, the script and the associated comments were all deleted on 2026-09-03; see `PRE_MAINNET_CHECKLIST.md` §6.2.

**`projectAdmin` is no longer in this hash**, and the comment spells out why: the hook is an EIP-1167 clone whose immutable args are only `creator` / `projectTreasury` / `softCap` / `perWalletCap` / `genesisDuration`; the admin is mutable by design and is written in at initialisation, so it no longer moves the mined address. The old version of this section listed six parameters here (including `adminAddr`).

**Cache-invalidation conditions** (the frontend clears an already-mined salt on each of these; three of the four are genuinely inside the initcode hash and the second is not — the row says so, and this line no longer claims otherwise):

| Trigger | Handling | Line |
|---|---|---|
| **The connected wallet changes** (`address`) | `setSalt('')` + `setPredictedHook('')`. The comment marks it `CRITICAL`: `address` is passed into `hookInitcodeHash` as both `projectTreasury` and `creator`, so a new wallet is a new hash | `:437-444` |
| **The Project Admin input changes** | Same as above, cleared directly in `onChange` — but **this one is now redundant**: the admin is no longer in the initcode hash, so changing it does not invalidate the salt, and clearing it merely throws away one mining run. Harmlessly conservative, but not necessary. | `:620-623` |
| **Genesis Window switched** | Cleared inside `pickWindow` (which returns early when `next === genesisDuration`, so it cannot clear by accident) | — |
| **The factory soft cap / wallet cap is retuned by the owner between "mine" and "submit"** | Mining records both values into `saltCaps`; the moment a `useEffect` finds them disagreeing with the latest reading it clears the salt and `saltCaps`, and shows `Factory soft cap / wallet cap changed — the next deploy will grind a fresh salt.` | — |

**That last row was once listed in this section as an invalidation that had not been built**, with the claim that the frontend offers no retry hint and the user has to re-mine by hand. It has been built: the `saltCaps` snapshot plus that `useEffect` exist for precisely this. The on-chain backstop is still in place — hit it for real and `createLaunch` reverts `InvalidHookSalt`, a behaviour pinned by `test_createLaunch_revertsWhenSoftCapRotatedAfterMining` @ `test/ToshV5Factory.t.sol` — it is just no longer what has to tell the user.

**`createLaunch` call parameters** (`soat-frontend/src/app/lib/useTosh.ts:78-98`):

```ts
writeA({
  functionName: 'createLaunch',
  args: [name, symbol, projectTreasury, projectAdmin, hookSalt, expectedFee, genesisDuration],
  value: expectedFee,      // Same as expectedFee: both the slippage cap and the actual payment
  gas:   6_000_000n,       // Explicit gas ceiling, bypassing eth_estimateGas
  chainId: TARGET_CHAIN_ID,
})
```

The reason for the explicit `gas` is written in the comment: bypass `eth_estimateGas` so the RPC cannot throw a misleading "exceeds block gas limit" while simulating a revert. Foundry reports roughly 3.7M gas for this call, so 6M leaves ample headroom.

`useTosh` uses **two independent `useWriteContract` slots** — A for `createLaunch`, B for `registerPoG` — so that the two flows' `hash`/`isPending`/`error` can never contaminate each other. This section previously recorded "two comments contradicting each other" (the header said slot A was `createLaunch + registerPoG` while slot B belonged to `contribute`): **that contradiction is gone**; the header comment now agrees with what the two slots actually carry, and there is no `contribute` flow.

One more repaired trap is worth keeping on record: `isSuccess` on `useWaitForTransactionReceipt` only means **a receipt arrived**, not that `createLaunch` succeeded — viem resolves a transaction that landed on chain and then reverted just as cleanly. `revertedA`/`receiptErrorA` here were once discarded outright, so a reverted launch displayed as "Confirmed" while an RPC failure left the toast spinning forever. Both are now folded into the outward-facing `error`, which reports `Reverted on-chain — createLaunch was rejected by the factory.`

### 6.6 The `ProjectTerminal` project terminal

#### 6.6.1 Batched on-chain reads

`bulkContracts` inside `ProjectTerminal()` in `soat-frontend/src/components/ProjectTerminal/index.tsx` pulls 15 items in a single `useReadContracts` (12s polling):

`totalEthDeposited`, `launched`, `p0`, `phase2Minted`, `canRefund`, `genesisDeadline`, `softCap`, `BONDING_MAX`, `currentBondingPrice`, `ethDeposited(user)`, `factory.pogQuota(user)`, `factory.eligibility(user, hook)`, `factory.userLaunchCooldownEnd(user, hook)`, `shelfP0`, `factory.blacklistedUntil(user)`.

`projectToken` is read on its own with `staleTime: Infinity` — it is fixed at deployment, so polling it every 12s is waste (the `useReadContract` immediately following `bulkContracts` in the same file).

The type is declared explicitly as `ContractFunctionParameters[]` rather than left to inference: HOOK_ABI runs to about 130 entries, and wagmi's per-item mapped type blows past TypeScript's instantiation-depth limit (the reason sits in the comment above the `bulkContracts` declaration).

#### 6.6.2 The phase state machine

`resolvePhase` @ `soat-frontend/src/components/ProjectTerminal/phase.ts` now has **four** phases, and no longer infers launch from the soft cap:

```ts
export type Phase = 'genesis' | 'awaiting_launch' | 'bonding' | 'refund'

if (launched) return 'bonding'
if (canRefund) return 'refund'
if (genesisDeadline === 0n || BigInt(nowSec) < genesisDeadline) return 'genesis'
const zombie = BigInt(nowSec) >= genesisDeadline + LAUNCH_WINDOW_SECONDS
return totalEthDeposited >= softCap && softCap > 0n && !zombie ? 'awaiting_launch' : 'refund'
```

| Phase | Badge copy (`PHASE_BADGE` @ `HeroStats.tsx`) | Panels rendered |
|---|---|---|
| `genesis` | `Genesis` (ok, live) | `GenesisPanel` + countdown |
| `awaiting_launch` | `Awaiting launch` (warn, live) | `AwaitingLaunchPanel` |
| `bonding` | `Ladder` (info, live) | `BondingPanel`, with `LiquidityPanel` appended when `launched` is true |
| `refund` | `Refund open` (danger, not live) | `RefundPanel` |

**A disconnected wallet does not meet a gate of its own.** The `ConnectGate` this section used to name does not exist: `isConnected` is handed **to each panel individually** as a prop (`isConnected={wConnected}`), where each panel's own `useActionGate` turns it into a "connect a wallet first" blocker reason. A disconnected visitor therefore sees the complete read-only terminal, not a turnstile. Only two whole-page early returns are real: a missing `hook_address` renders a `HOOK BINDING MISSING` card, and **an unsynced clock** holds the entire terminal body behind a skeleton. The latter is a deliberate precondition — the comment in `phase.ts` states that if `nowSec` is `CLOCK_UNSYNCED` (0), every comparison below it reads as "the window is still open", so a genesis round that has already failed resolves back to `'genesis'` and lays the deposit panel over a dead raise.

> **⚠️ 8.6 — fixed; the record is kept here.** The old `resolvePhase` used a single clause, `totalEthDeposited >= softCap`, to mean "enter bonding" as well, breaking two rules at once; the comment in `phase.ts` writes both of them down:
> - The ladder shelf does not exist at all before `launch()` runs, and reaching the soft cap does **not** open it, while the creator cannot call `launch()` until after the genesis deadline — showing the ladder panel early hands the user a mint button that can do nothing but revert `NotLaunched`;
> - Deposits stay open across the whole genesis window, the soft cap is a **floor, not a ceiling**, and closing the deposit panel the instant it is touched nails every raise to its own minimum.
>
> That interval is now carried by a separate `awaiting_launch` phase with `AwaitingLaunchPanel`. A `zombie` test went in at the same time: once `LAUNCH_WINDOW_SECONDS` has elapsed on top of the deadline, the hook opens `refund()` to everybody, and reading the soft cap in isolation would strand the user on a panel that says "refunds are open" with no refund button anywhere on the page.

#### 6.6.3 The `GenesisPanel` genesis panel

`soat-frontend/src/components/ProjectTerminal/GenesisPanel.tsx`.

**Local guardrails** (which stop the transaction before the wallet opens) use the same `useActionGate` / `revertOrder` / `ActionButton` abstraction as the admin panels; `blockersInRevertOrder` runs in this order:

| # | `id` | Locked label | Trigger |
|---|---|---|---|
| 1 | `amount-invalid` | `Check the amount` | The input is not a number that can be sent as ETH |
| 2 | `amount-zero` | `Enter an amount` | `amountWei === 0n` |
| 3 | `blacklisted` | `Wallet blocked` | The address is on the blacklist |
| 4 | `unattested` | `Gas check required` | The wallet has no PoG record yet, so it has no quota to spend |
| 5 | `cooldown` | `Cooldown · HH:MM:SS` | `cooldownEnd > nowSec` |
| 6 | `quota-exceeded` | `Over your limit` | Exceeds the quota remaining in the current window |
| 7 | `window-closed` | `Funding closed` | The genesis window has closed |
| 8 | `wallet-cap` | `Over the wallet cap · N ETH left` | Exceeds this project's per-wallet holding cap |
| 9 | `balance` | `Not enough ETH` | Insufficient balance |

**This order is arranged against the chain, not against the screen**, and the comment makes the reasoning explicit: `factory.deposit` rejects in exactly the order "blacklist → no quota → cooldown → over quota" before handing off to `hook.deposit`, which checks the window first and the per-wallet cap second. The cascade it replaced put `onCooldown` after `quotaBreached`, so a wallet that was both in cooldown and over budget was told "you have used up your quota for this window" when the transaction would actually have reverted `CooldownActive` — turning "you have no quota left" into the opposite of "wait 24 hours".

`armed = gate.verdict.kind === 'ready'`. The amount input carries a separate terse red-boxed label (`NOT A NUMBER` / `ABOVE YOUR REMAINING WINDOW` / `ABOVE THIS PROJECT'S WALLET CAP` / `ABOVE YOUR BALANCE`) which speaks only to the number just typed; the full reason and its remedy are left to the gate to state uniformly below the button, and the three wallet-level states (banned, no PoG, window closed) each get their own separate callout above the input, so they are not repeated here.

**UI elements**: the genesis progress bar (`totalEthDeposited / softCap`), `QuotaLedger` (three readings — deposited across hooks / quota / this transaction's projection, going red when the projection is over), the ETH balance and cooldown readouts, the amount input with its `max` button, and `PogScanButton` (which triggers server-side signing → `registerPoG`). When the soft cap has been reached while the window is still open, the top of the panel shows `→ OVERSUBSCRIBED · SOFT CAP CLEARED, DEPOSITS STAY OPEN UNTIL THE WINDOW ENDS` — the second bullet of 8.6 (the soft cap is a floor, not a ceiling) landing in the UI.

**Sending the transaction** (`submitDeposit`, through `useTxAction({ action: 'deposit' })`):

```ts
sendDeposit({
  address: FACTORY_ADDRESS, abi: FACTORY_ABI,
  functionName: 'deposit',
  // Resolved at send time, not at render time
  args: [p.hookAddress, resolveReferrerNow(p.userAddress)],
  value: amountWei,
})
```

The referrer is resolved **at send time** rather than render time, and the comment gives the reason: the factory binds a referrer to a wallet once and permanently, while on the first frame after mount `p.referrer` is still the zero-address sentinel — reading it at render time would burn the referral relationship of a first contribution to empty, for good.

> **✅ 8.3 (resolved)**: the referrer was once hard-coded to `ZERO_ADDRESS`, and the consequence was that 10% of every genesis contribution made through the official UI went to the platform treasury via `orphanReferral` — a fully implemented contract feature bypassed wholesale by the frontend. It is now wired through:
> - `<ReferralCapture/>` (mounted in `app/layout.tsx`) parses `?ref=<address>` on any page load and persists it;
> - `useBoundReferrer` (`soat-frontend/src/lib/useReferral.ts`) returns the locally captured value (first link wins; a self-referral clears the slot), or `ZERO_ADDRESS` when there is none. It **does not read the on-chain `referrerOf`** — that view exists only in the ABI and the frontend has never called it; nor does it need to, because `deposit` internally takes `globalReferrers[msg.sender]` as authoritative and `_recordReferral` returns immediately for an already-bound wallet, so a stale local value cannot overwrite an existing on-chain binding and the chain remains authoritative throughout;
> - `ProjectTerminal` passes that address as `deposit`'s second argument.
>
> **One boundary that still has to be understood**: the referrer must hold PoG quota themselves (`pogQuota[referrer] > 0`), or `_recordReferral` declines to bind and the commission goes through `orphanReferral` as before. That is the threshold against "spin up a second wallet and farm your own commission", not a bug; `ReferralPanel` gives an explicit hint to a sharer who has not qualified yet, so they do not assume their link is already earning.

> **✅ 8.4 (resolved)**: `claimReferralReward()` is now wired up in `ProjectTerminal`'s `ReferralPanel`, with `TxLine` echoing the broadcast state.

#### 6.6.4 The `BondingPanel` ladder panel — quoting and minting

`:969-1176`.

**The quote pipeline**:

```
1. tierStatus() polled (8s) → take unlocked (the 7th return value)
2. maxMintable() polled (8s) → exceedsMax = tokenAmountWei > maxMintable
   The comment is explicit: the ceiling on a single mint is not TIER_SIZE but
   maxMintable() — it folds together three limits, the 105% gate, the end of
   the ladder, and MAX_TIERS_PER_TX (:991-993)
3. quotable = tokenAmountWei > 0 && !exceedsMax
4. quoteMint(tokenAmountWei) polled (8s, enabled only while quotable)
5. isDust = quotable && !quoteFailed && ethCost === 0n        // L-01 dust guard
6. maxEthCost = ethCost + ethCost × SLIPPAGE_BPS / 10000      // +0.5%
7. insufficientBal = maxEthCost > ethBalance
8. gateLocked = tokenAmountWei > 0 && !unlocked
9. awaitingFirstUnlock = gateLocked && phase2Minted === 0n     // "by design" vs "broken"
```

**The 0.5% slippage buffer and the contract's change refund** (`:65-67`, `:1017`, `:1048-1054`, `:1143-1145`):

- `SLIPPAGE_BPS = 50n`; the comment verbatim: "Padded into the on-chain quote and sent as `msg.value`; excess ETH is refunded by the hook."
- `msg.value = maxEthCost` (with the 0.5% padding in it), which the UI states outright at the foot of the quote card: `msg.value = {maxEthCost} wei · excess refunded`.
- The matching refund on the contract side: `change = msg.value - cost; if (change > 0) _sendEth(msg.sender, change)` (`src/ToshLaunchpadHook.sol:922-923`).
- Why the buffer is necessary: `quoteMint` is a read of the previous block while `mintBondingCurve` executes in the next one, and if somebody gets in ahead and eats the remainder of the current tier in between, the actual fill crosses into a more expensive tier. 0.5% covers that slip; beyond it, the call reverts `InsufficientPayment`.

**The guardrail order in `handleMint`** (`:1039-1058`), each rung with its own locked label:

| # | Check | Error copy / locked label |
|---|---|---|
| 1 | Connected | "Connect wallet" |
| 2 | `tokenAmountWei > 0` | `[enter_amount]` |
| 3 | `!exceedsMax` | `"Exceeds what one call can serve — max X right now"` / `[exceeds_max_per_call]` |
| 4 | `!awaitingFirstUnlock` | `"Shelf 0 sits 5% over the pool — the ladder opens once the market holds at or above P₀"` / `[awaiting_market_above_p0]` |
| 5 | `!gateLocked` | `"105% price gate is locked — wait for spot/TWAP"` / `[gate_locked]` |
| 6 | `!isDust` | `[invalid_amount]` |
| 7 | `!insufficientBal` | `"Insufficient ETH for quoted cost + slippage"` / `[insufficient_eth]` |

Row 4 is especially worth noting: the comment explains why it is kept apart from row 5 — **before anyone has minted, a closed gate is the designed opening state, not a fault** — so the copy states the fact instead of raising an alarm (`:1021-1023`). This maps directly onto the `SHELF_PREMIUM_BPS == PRICE_CEILING_BPS` design in 5.1/3.3.

**The `ShelfLadder` subcomponent** (`:440-539`):

- Reads `tierStatus()` (all 7 tuple members are used) plus `getTiers(windowStart, 5)`, with the window centred on the current tier (`windowStart = max(tierIndex - 2, 0)`, `:464`).
- The top bar shows `GATE OPEN` / `GATE LOCKED · 105%`.
- Four readouts: ACTIVE SHELF `#i / 4000` (the denominator read straight off the on-chain `TIER_COUNT`), SHELF PRICE, REMAINING, and 105% CEILING (in the fluo colour when unlocked).
- A fill bar for the current tier.
- A 5-row tier table: `#index / price / sold% / LIVE|CLEARED|QUEUED`.
- The bottom bar: `P₀ = … / spot = … / twap = …` (the three prices set side by side, so users can read the gating logic for themselves).

**Four readout strips** (`:1084-1097`): `P₀ · POOL OPEN`, `SHELF 0 · +5%` (hint: "mint premium over market"), `ACTIVE SHELF` (hint: `X× ladder base`), and `PHASE-2 MINTED` (`phase2Minted / bondingMax`, hint: `4000 shelves × 3.15K`, i.e. `TIER_COUNT × TIER_SIZE`).

Note that `premiumRaw` is computed against **`shelfP0`** and not `p0` (`:1063-1066`); the comment's reason: "Measured against the LADDER base rather than the pool's opening price, so the flat 5% mint premium does not masquerade as ladder progress."

**Event stream: the project terminal does not have one.** This section previously described a `RecentEventsTicker` subscribing to `Deposited` / `TierMinted` / `Refunded` with basescan links — it does not exist, and there is no `useWatchContractEvent` anywhere in `BondingPanel`. The only live event stream in the whole app is the `TxFeedMarquee` marquee on the **directory home** @ `soat-frontend/src/components/TxFeedMarquee.tsx`, mounted dynamically through `EventTickerStrip` (`ssr: false`, because it runs on a WebSocket subscription — the wrapper was called `A2AFeed` until the v0 redesign on 2026-09-11 renamed it for what it is; it now sits directly under the hero, beside a `HeroFeedPanel` that lists launches rather than events): it subscribes to three **factory** events, `LaunchCreated` / `PoGRegistered` / `GenesisDeposit`, holds a `RING_LIMIT` 24-entry ring buffer, deduplicates then prepends and trims, and renders the whole strip twice head-to-tail for seamless scrolling, pausing on hover. It carries **no explorer links**, which makes that basescan claim wrong three times over: wrong component name, wrong event names, and a link that never existed — and, while we are here, the chain has been 4663 for some time and the explorer is Blockscout, not basescan.

#### 6.6.5 The `LiquidityPanel` minimal full-range retail LP panel

`:1197-1456`. The panel's header comment (`:1178-1189`) sets out the scoping: the hook deliberately leaves `BEFORE_REMOVE_LIQUIDITY` outside its mask, so retail LPs could always come and go freely — **what was missing was a front door**: a posm position is an ERC-721 hidden behind the Permit2 approval dance, not something a retail user assembles by hand. **The scope is deliberately one range only**: the same full range as the genesis position. A range selector would mean teaching users to understand ticks, and concentrated-liquidity LPs already have purpose-built tools.

**Depositing ETH + token**:

```
1. useLpPoolState(token, hook) → sqrtPriceX96, totalLiquidity (read via STATE_VIEW)
2. tokenNeeded = pairedAmount1(sqrtPriceX96, ethWei)     // rounds up
3. ethMax   = ethWei      × 1.005
   tokenMax = tokenNeeded × 1.005                        // the same 0.5% padding
4. liquidity = liquidityForAmounts(sqrtPriceX96, ethWei, tokenNeeded)  // takes the binding side
5. encodeMintPayload → posm.modifyLiquidities(unlockData, deadline) with value: ethMax
```

The rounding direction of `pairedAmount1` is **deliberate** (`soat-frontend/src/lib/v4Math.ts:123-140`): "Rounds UP: under-quoting the token side makes the mint revert on the `amount1Max` guard." Correspondingly, `amountsForLiquidity` rounds down, "matching what the pool actually pays out on a burn, so the panel never shows a number the user cannot withdraw" (`:82-87`).

`SQRT_PRICE_LOWER = 4_310_618_292n` / `SQRT_PRICE_UPPER = 1_456_195_216_270_955_103_206_513_029_158_776_779_468_408_838_535n` are what `TickMath.getSqrtPriceAtTick(∓887200)` actually returned when run against v4-core, not floating-point approximations (`soat-frontend/src/lib/v4Math.ts:1-18`).

Those two constants, plus the three functions `amountsForLiquidity` / `liquidityForAmounts` / `pairedAmount1`, are validated by `soat-frontend/scripts/checkV4Math.ts` (`npm run guard:v4math`, running in `frontend.yml`) against vectors recorded from real Foundry runs. Drift here throws no exception; all it does is make the panel quote an amount the pool will not accept — and the mint reverts on `amount1Max` only after the user has already signed two Permit2 approvals.

**posm action payload** (`soat-frontend/src/lib/lpActions.ts`):

| Operation | Opcode sequence | Notes | Line |
|---|---|---|---|
| Deposit | `MINT_POSITION(0x02)` + `SETTLE_PAIR(0x0d)` + `SWEEP(0x14)` | `SWEEP` returns whatever ETH the pool did not take, so the caller can send `amount0Max` as `msg.value` without worrying | `:41-76` |
| Withdraw | `BURN_POSITION(0x03)` + `TAKE_PAIR(0x11)` | Closes the position and pays out both sides | `:78-100` |

The file's header comment (`:1-21`) explains why these have to be standalone pure functions rather than inlined into the component:
- `CalldataDecoder.decodeActionsRouterParams` enforces **strict** ABI encoding — it recomputes every offset, and any deviation reverts, including the legal-but-non-canonical layouts some encoders emit;
- `decodeMintParams` reads its fields at **hard-coded calldata offsets**, so the parameter list must produce exactly the head layout it expects (the `PoolKey` tuple is static and occupies slots 0..4, which is why `hookData` lands in slot 11).
- Both properties are pinned by a complementary pair of guards, **both of which are now wired into CI**:
  - `soat-frontend/scripts/checkLpActions.ts` (`npm run guard:lpactions`, running in `frontend.yml`) drives the real viem encoder and inspects the payload it emits byte by byte;
  - `scripts/checkLpActionsAbi.mjs` (running in `test.yml`, because it has to read `lib/`) parses `CalldataDecoder.sol` / `Actions.sol` from `lib/v4-periphery` and `PoolKey.sol` from `lib/v4-core`, and requires the literals in the guard above, along with `V4_ACTIONS` and `MINT_PARAM_SPEC`, to line up item for item with the real Solidity.

  Why this has to be split in half: the first half is the only one that can check the real encoder's output, but it can only compare against the offsets written down in its own file — it is **not** asserting against the real decoder. At one point it was even checking opcodes by comparing `V4_ACTIONS` against `V4_ACTIONS` (the very thing that encoded the payload), so any value whatsoever would have passed. Measured: shift every offset in `decodeMintParams` inside `lib/v4-periphery` by one slot and it still reports "All posm payload invariants hold". The second half is what closes that hole. Neither half is dispensable.

  (History: `checkLpActions.ts` and `checkV4Math.ts` both used to print `npx tsx` on their usage line, and `tsx` has never been a dependency of this repo, so neither one could run and neither was wired into CI — the same shape as the `checkHookMinerTuple.mjs` incident recorded in `.github/workflows/test.yml`. They now run through `soat-frontend/scripts/runTsGuard.mjs`, which transpiles them with the `typescript` already in the repo, so no new dependency was introduced; `npm run guards` runs all three frontend-side guards in one command.)

**The three-step Permit2 approval walkthrough** (`:1355-1365`) — only one step is live at a time, so the CTA always states exactly "what the next signature does" instead of throwing three buttons at the user at once:

```
if (!isConnected)          → "Connect wallet to provide liquidity" (disabled)
if (!tokenAddress)         → "Token not resolved yet" (disabled)
if (ethWei <= 0)           → "Enter an ETH amount" (disabled)
if (ethInvalid)            → "Invalid amount" (disabled)
if (insufficientEth)       → "Insufficient ETH" (disabled)
if (insufficientToken)     → "Insufficient {SYMBOL}" (disabled)
if (needsErc20Approval)    → "Step 1 of 3 — approve {SYMBOL} for Permit2"
                              → token.approve(PERMIT2, MAX_UINT160)
if (needsPermit2Approval)  → "Step 2 of 3 — let Permit2 fund the position manager"
                              → PERMIT2.approve(token, POSITION_MANAGER, MAX_UINT160,
                                                now + 30 days)
else                       → "Step 3 of 3 — deposit into the pool"
                              → posm.modifyLiquidities(..., value: ethMax)
```

How approval state is determined (`:1249-1252`):
- `needsErc20Approval = tokenMax > 0 && erc20.allowance(user, PERMIT2) < tokenMax`
- `needsPermit2Approval = tokenMax > 0 && (!posmAllowance || posmAllowance[0] < tokenMax || posmAllowance[1] <= nowSec)` — a Permit2 allowance is a `uint160` and **carries its own expiry**, so the amount and the expiry both have to be checked (`:1192-1195`).

Constants: `MAX_UINT160 = 2^160 - 1`, `PERMIT2_TTL_SECONDS = 30 days`, `TX_DEADLINE_SECONDS = 20 minutes` (`:1193-1195`).

**Withdrawal** (`:1334-1351`):

```ts
encodeBurnPayload({
  tokenId,
  amount0Min: amount0 − amount0 × 50 / 10000,   // 0.5% downside protection
  amount1Min: amount1 − amount1 × 50 / 10000,
})
```

> **⚠️ 8.23**: `amount0` / `amount1` are computed by the frontend locally with `amountsForLiquidity(sqrtPriceX96, liquidity)`. If the `sqrtPriceX96` the RPC returns lags the true on-chain price (12s polling), that 0.5% slippage floor either makes the withdrawal revert or is purely decorative — because the baseline it is measured from is itself wrong.

**Position discovery** (`soat-frontend/src/lib/useLpPosition.ts`) — the file header states the difficulty very plainly (`:6-20`): a V4 position is an ERC-721 held by posm, and **posm is not `ERC721Enumerable`** — there is no `tokenOfOwnerByIndex`, and periphery offers no "positions by owner + pool" view either. So the panel reconstructs and merges from two sources:

1. posm's `Transfer(_, to = user, id)` logs. Authoritative, but public RPCs rate-limit log queries and cap their range, so this runs inside a bounded look-back window and is allowed to fail silently. The window is **derived from the chain's block time and then capped by a call budget**: `LOG_TARGET_WINDOW_MS` asks for a fortnight, `LOG_PAGE_BUDGET = 24` is what a scan is allowed to spend at `LOG_PAGE_SIZE = 50,000` blocks a page, and `lookbackPlan()` returns whichever is smaller along with how long it actually covers. On Robinhood mainnet the budget binds: 1.2M blocks, **33 hours**.
2. The `localStorage` cache this UI writes on every mint (`rememberLpPosition`, `:41-52`). It covers two cases: "just minted, and the RPC's log index has not caught up", and "the look-back window has already rolled past the mint".

> **This was a flat `LOG_LOOKBACK_BLOCKS = 600_000`, explained as "Base blocks are ~2s, so this is roughly a fortnight", and both halves had stopped being true** (fixed in code, commit d60db68). The chain is Robinhood, measured at **0.101 s/block** — viem's chain definition says `blockTime: 100` — so 600,000 blocks was about **17 hours**, not a fortnight. Nothing announced the change, because a block count cannot: it goes on meaning blocks while the time it stands for shrinks twentyfold.
>
> The second half was worse. 600,000 blocks at 50,000 a page is twelve sequential `eth_getLogs` calls, and the mainnet endpoint returns `Too Many Requests` on roughly the **seventh**. So this scan did not merely return a short window — it **threw partway through, every time**, landing in the `catch` and leaving discovery to the localStorage cache alone while the panel reported a degraded RPC. The same limit took the on-chain watcher blind for a full pass (see `docs/ONCHAIN_MONITORING.md` and `SECURITY_AUDIT.md` §5.28, where 250 ms was the interval measured to be clean). Pacing is now per page rather than around the whole walk — `LOG_MIN_INTERVAL_MS = 250`, with `LOG_MAX_RETRIES = 3` and exponential `LOG_BACKOFF_MS` on a rate-limit specifically — so a 429 on page seven backs off and continues instead of discarding the six pages already earned.
>
> **And the panel now states its coverage even when the scan succeeds**, via `lpScanCoverageLabel()`: "Position discovery scans the last 33 hours of transfers." Succeeding is not the same as being complete, and a position minted before the window and not held in this browser's cache is simply absent from the list with nothing to distinguish it from having no position at all. Only the failure case used to say anything, which is the case that needed it least — it at least announced itself.
>
> **"Scan further back" is not the fix, and it is worth writing down why**, because it is the first thing anyone proposes. The two ways out of a bounded scan are enumeration and a walk, and neither is available: posm is not `ERC721Enumerable` — confirmed against the live contract, `supportsInterface(0x780e9d63)` returns **false**, so there is no `tokenOfOwnerByIndex` to iterate — and `nextTokenId()` is already past **2.25M**, so brute-forcing the id space is not a walk anyone can afford either. What is left is a bounded log scan plus a local cache, which is what this is; the honest move is to size the window against the endpoint's real limits and then **say what it covers**.

**Every candidate is verified on chain** (`ownerOf` == user, `getPoolAndPositionInfo().hooks` == this hook, `getPositionLiquidity() != 0`, `:165-181`), so a stale or malicious cache entry costs at most one wasted read and can never compute a wrong balance.

A failed log scan sets `degraded = true` (`soat-frontend/src/lib/useLpPosition.ts`) and the panel shows a degraded notice (the `degraded` branch in `ProjectTerminal/LiquidityPanel.tsx`): "this RPC would not serve position logs, so only positions minted from this browser are listed. Your other positions are safe on-chain and remain withdrawable through any Uniswap V4 interface."

**Four readout strips** (`:1373-1386`): POOL DEPTH · ETH / POOL DEPTH · {SYMBOL} (hint: "all LPs incl. genesis") / MY POSITION · ETH / MY POSITION · {SYMBOL} (hint: "withdrawable any time"). The open-position list gives one row each, `#tokenId · X ETH + Y SYMBOL`, with a `Withdraw` button.

Panel subtitle: `"Uniswap V4 PositionManager · full range · 0.30% pool fee accrues to LPs"` (`:1371`).

#### 6.6.6 The `RefundPanel` refund panel

`:1462-1510`. Subtitle: `"hook.refund() — soft-cap not met OR zombie window elapsed · full claim, no penalty"`. The locked label reads `[no_deposit]` when `ethDeposited === 0n`, and `[claim_refund]` otherwise.

#### 6.6.7 Contract entry points the frontend does not cover

| Contract function | Frontend state | Impact |
|---|---|---|
| `hook.launch()` | **⚠️ 8.5: no UI entry point at all.** A repo-wide search for `functionName: 'launch'` hits nothing but ABI JSON | The creator has to open the market themselves with `cast send` / Etherscan / a script of their own. This is the **critical path** of the entire lifecycle, and it has not been productised |
| `hook.claimReferralReward()` | **⚠️ 8.4: no UI entry point** | Referral commission cannot be claimed through the UI (and, given 8.3, none actually accrues) |
| `hook.changeProjectAdmin()` | No UI entry point | Rotating the admin requires sending a transaction by hand |
| `treasury.addLadderToken()` / `removeLadderToken()` | No UI entry point (`/admin` carries only the factory's owner functions — see the 13 `functionName` occurrences in `soat-frontend/src/app/admin/page.tsx`) | Buyback curation requires sending transactions by hand |
| `hook.claimGenesis()` | ✅ Present in `UserDrawer`, dispatched through `useTxAction` @ `soat-frontend/src/components/ui/useTxAction.ts` | — |

### 6.7 The PoG signing path (frontend ↔ server)

| Stage | Location | Notes |
|---|---|---|
| Session authorisation signature | `ProjectTerminal/PogScanButton.tsx` + `ProjectTerminal/pogAuthCache.ts`, `buildPoGScanAuthMessage` (`soat-frontend/src/lib/contracts.ts`) | Message format `"Tosh PoG Scan Request\nAddress: {addr}\nTimestamp: {ms}"`; the signature is cached in `sessionStorage` with TTL `POG_SESSION_AUTH_TTL_MS = 1,800,000` (30 minutes) |
| Server-side issuance | `soat-frontend/src/app/api/sign-allocation/route.ts`, `api/admin/config/route.ts`, `app/lib/pogQuota.ts`, `app/lib/onchainNonce.ts` | The server holds `POG_SIGNER_PRIVATE_KEY`; the nonce is read live from the chain via `factory.pogNonces(sender)` (as described in README §5) |
| On-chain submission | `useTosh.registerPoG` (`:103-118`) | `args: [maxAlloc, deadline, nonce, signature]` |

---

## 7. Appendix: constants, events and error codes

### 7.1 Constants reference table

#### `ToshLaunchpadHook`

| Constant | Value | Line |
|---|---|---|
| `GENESIS_SUPPLY` | 8,400,000e18 (40% of the hard cap) | 139 |
| `GENESIS_CLAIM_SUPPLY` | 4,620,000e18 (55% of the genesis allocation) | 161 |
| `GENESIS_LP_SUPPLY` | 3,780,000e18 (45% of the genesis allocation) | 162 |
| `TIER_COUNT` | 4000 | 165 |
| `TIER_SIZE` | 3,150e18 | 169 |
| `BONDING_MAX` | 12,600,000e18 (60% of the hard cap) | 172 |
| `TIER_STEP_E18` (internal) | 1,001,902,508,266,805,824 (2000× span) | 186 |
| `MAX_TIERS_PER_TX` | 32 | 200 |
| `DURATION_FAST` / `_STANDARD` / `_SLOW` | 3h / 24h / 72h | 214-216 |
| `LAUNCH_WINDOW` | 7 days | 218 |
| `REFERRAL_BPS` | 1000 (10%) | 226 |
| `PLATFORM_TAX_BPS` | 100 (1%) | 230 |
| `TAX_BPS` | 100 (1.00%) | 239 |
| `PLATFORM_SWAP_FEE_BPS` | 30 (0.30%) | **Carved out of** `TAX_BPS`, not stacked on top of it; buys only. Buyback share = `TAX_BPS - PLATFORM_SWAP_FEE_BPS` = 70 bps |
| `BPS_DENOMINATOR` (internal) | 10,000 | 241 |
| `PRICE_CEILING_BPS` | 10,500 (105%) | 247 |
| `SHELF_PREMIUM_BPS` | 10,500 (105%) | 279 |
| `TWAP_WINDOW` | 1800 (seconds; the measured window drifts within [1800, 3600)) | 284 |
| `POOL_FEE` | 3000 (0.30%) | 302 |
| `TICK_SPACING` | 200 | 309 |
| `TICK_LOWER` / `TICK_UPPER` (internal) | −887,200 / +887,200 | 311-312 |
| `DEAD_ADDRESS` | `0x…dEaD` | 314 |
| `ACTION_ADD_LIQUIDITY` (internal) | 1 | 316 |
| `PIGGYBACK_TRIGGER_STEP` | 1 ether | A local copy of the treasury's `TRIGGER_STEP`, saving one cross-contract read; `test_piggybackTriggerMirrorsTheTreasury` pins the two together so they cannot drift |
| `PIGGYBACK_MIN_GAS` | 260,000 | The minimum `gasleft()` a poke needs. Calibration in 8.34 — it spent time at 230,000 and was raised back |
| `PIGGYBACK_TAIL_RESERVE` | 100,000 | The share physically withheld for the tail (the `afterSwap` return + the V4 frame close + router settlement, measured at roughly 70k) |

**Phase-2 ladder state is packed**: `currentTierIndex` / `currentTierSold` / `phase2Minted` were three public `uint256` fields that each occupied a slot of their own; they are now merged into the internal struct `LadderState { uint16 tierIndex; uint88 tierSold; uint96 minted; }` (one slot, 25 bytes). The three public getters are retained by hand, so the **ABI is unchanged**. The widths are proved by the constants in this table — `TIER_COUNT ≤ 65,535`, `TIER_SIZE ≤ 2^88`, `BONDING_MAX ≤ 2^96` — and held by `test_ladderStateWidthsFitTheirConstants`: Solidity does not check explicit downcasts, so a constant that outgrew its field would **truncate silently** rather than revert, and the consequence is a ladder that puts already-sold shelves back on sale. `mintBondingCurve` accordingly drops from 197,195 to 173,550.

#### `ToshFactory`

| Constant / default | Value | Line |
|---|---|---|
| `MAX_SIG_VALIDITY` | 24 hours | 42 |
| `MAX_COOLDOWN` | 7 days | 43 |
| `MIN_SOFT_CAP_PROD` | 0.01 ether | 55 |
| `cooldownDuration` (default) | 24 hours | 75 |
| `quotaWindowDuration` (default) | 24 hours | A **separate dial** from the cooldown; see 8.25 |
| `launchFee` (default) | 0.1 ether | 78 |
| `maxPogAllocationLimit` (default) | 0.1 ether | 89 |
| `defaultSoftCap` (default) | 10 ether | 92 |
| Blacklist batch limit | 200 | 264, 273 |

**This table reads `src/`, and for `launchFee` `src/` is no longer what 4663
charges.** The constructor default is still `0.1 ether` and the line reference
above is correct, but the live value has been `0.01 ether` since 2026-09-10,
set by the owner Safe rather than by an edit (`setLaunchFee`, Safe nonce 3,
tx `0x4fbd140d…`). The source was deliberately left alone: it only takes effect
at construction, the factory was deployed long before, so editing it would
change nothing on chain while forfeiting the byte-for-byte reproducibility that
PM-C4's verification rests on. §3.5 carries the live number; every other
`0.1 ether` on this page is the *other* dial with the same value,
`maxPogAllocationLimit`, which has not moved.

#### `ToshLadderTreasury` / `ToshToken` / `HookMiner`

| Constant | Value | Description |
|---|---|---|
| `TRIGGER_STEP` | 1 ether | Arming threshold |
| `SPEND_BPS` | 1000 | Each cycle deploys `max(TRIGGER_STEP, balance × 10%)` (8.10) |
| `BATCH_SIZE` | 3 | **The sharding divisor**: `perToken = spend / BATCH_SIZE`. No longer the number of legs per poke |
| `LEGS_PER_POKE` | 1 | Legs per poke. Splitting it off from the row above is the fix from 8.33 |
| `MAX_BUYBACK_SQRT_DEVIATION_BPS` | 1000 | TWAP floor, in sqrt terms (≈19% in price terms) |
| `_PIGGYBACK_SLOT` | `0x546f73685069676779626163b1000001` | EIP-1153 transient marker |
| `MAX_SUPPLY` | 21,000,000e18 | `ToshToken.sol:53` |
| `MINTER_ROLE` | `keccak256("MINTER_ROLE")` | `ToshToken.sol:47` |
| `REQUIRED_FLAGS` | `0x20CC` | `HookMiner.sol:64-65` |
| `ALL_HOOK_MASK` | `0x3FFF` | `HookMiner.sol:46` |

### 7.2 Events reference table

| Contract | Event | Line |
|---|---|---|
| Hook | `TokenInitialized` / `Deposited` / `Launched` / `GenesisFailed` / `ZombieRefund` / `Refunded` / `GenesisShareClaimed` | 440-446 |
| Hook | `ReferralAccrued` / `ReferralClaimed` / `OrphanReferralForwarded` / `ProjectAdminChanged` | 447-450 |
| Hook | `TierMinted(buyer, tierIndex, tierPrice, tokensOut, ethIn)` / `TierAdvanced(newTierIndex, newTierPrice)` | 453-458 |
| Hook | `BuyTaxToTreasury(ethAmount)` / `PlatformSwapFeePaid(recipient, ethAmount)` / `SellTaxBurned(tokenAmount)` / `PiggybackPokeFailed(treasury)` | 461-469 |
| Factory | `LaunchCreated` / `Blacklisted` / `PoGRegistered` / `GenesisDeposit` / `ReferralBound` | 147-158 |
| Factory | `PogSignerUpdated` / `LaunchFeeUpdated` / `LaunchFeeForwarded` / `CooldownDurationUpdated` / `DefaultSoftCapUpdated` / `MaxPogAllocationLimitUpdated` / `QuotaWindowReset` | 159-168 |

**`BuyTaxToTreasury` now carries only 70 bps, not the whole tax.** The name did not change (changing it would break the matching in every existing indexer), but the meaning did: the other 30 bps of a buy is reported separately by `PlatformSwapFeePaid`, **from within the same swap**. Summing `BuyTaxToTreasury` as "total buy-side tax" under-reports by 30%. `SellTaxBurned` is the other way round — sells are not split, and it carries the full 1.00%.

**`TreasuryUpdated` has been deleted.** It was the companion event of `setPlatformTreasury`, and that function no longer exists, so this event **can never fire again**. Any alert rule still listening for it is a silently dead rule (`monitoring/alerts.json` has dropped the corresponding entry and added a rule for `PlatformSwapFeePaid`).

| Treasury | `FactorySet` / `LadderTokenAdded` / `LadderTokenRemoved` / `TaxReceived` / `PiggybackExecuted` / `BuybackBurned` / `BuybackSkipped` | 110-123 |

**`PiggybackExecuted` fires at a different rate now**: after `LEGS_PER_POKE = 1` it is emitted once per leg rather than once per three legs. The same ETH, three times the events — an alert rule whose thresholds were tuned to the old cadence will read this as a buyback storm.

**There is no "poke was skipped" event**, and that is deliberate: skipping is the normal case, and logging it would make every trader pay for the record. Reserve sitting idle because of the gas gate is therefore invisible to any event subscription; the only way to see it is `STATE-06` polling the balance.

### 7.3 Error codes reference table (for frontend copy)

#### Hook (`src/ToshLaunchpadHook.sol:475-527`)

| Error | Trigger | Suggested copy |
|---|---|---|
| `OnlyPoolManager` / `OnlyFactory` / `OnlyCreator` / `Unauthorized` | Wrong caller | Internal error |
| `NotInitialized` / `AlreadyInitialized` | Token not bound / already bound | Internal error |
| `GenesisActive` | `launch()` before the genesis window closed | "The genesis window has not closed yet" |
| `GenesisExpired` | Still depositing after the window closed | "Genesis has closed" |
| `AlreadyLaunched` / `NotLaunched` | Wrong phase | — |
| `AlreadyClaimed` / `NoDeposit` | Already claimed / no contribution | — |
| `SoftCapNotMet` | Launching before the soft cap is met | "Soft cap not met" |
| `LaunchWindowExpired` | Past the 7-day zombie window | "The launch window has expired; depositors can refund" |
| `InvalidDuration` | Genesis duration not in {3h,24h,72h} | "Genesis duration must be 3/24/72 hours" |
| `InvalidAdmin` | `projectAdmin == 0` | "The project admin cannot be the zero address" |
| `LadderExhausted` | All 4000 tiers sold out | "The ladder is exhausted" |
| `ExceedsTierRemaining` | The order runs past the end of the ladder | "Order exceeds remaining supply" (⚠️ 8.15) |
| `SpanTooManyShelves` | Spans more than `MAX_TIERS_PER_TX` (32) tiers | "Send it as two transactions; the end state is the same" |
| `SameBlockMintForbidden` | There has already been a swap in this block | "Wait one block" |
| `TierPriceAboveCeiling` | Tier price > 105% of the reference price | "The price gate is locked; waiting for the secondary market to catch up" |
| `InsufficientPayment` | `msg.value < cost` | "Not enough slippage allowance; re-quote" |
| `NoReferralReward` | No accrued commission | — |
| `PerWalletCapExceeded` | Over this project's per-wallet cap | "You have reached this project's per-wallet cap" |
| `EthTransferFailed` / `UnknownAction` / `UnauthorizedInitialization` / `ZeroAmount` | — | — |

#### Factory (`src/ToshFactory.sol:172-195`)

`IsBlacklisted` / `NoPogQuota` / `QuotaExceeded` / `CooldownActive` / `InvalidSignature` / `NonceConflict` / `SignatureExpired` / `SignatureTooLong` / `HookNotRegistered` / `InvalidHookSalt` / `DeployFailed` / `ZeroAmount` / `InvalidAdmin` / `ExceedsGlobalPogLimit` / `InvalidSoftCap` / `NameTaken` / `EmptyName` / `InsufficientLaunchFee` / `FeeChanged` / `EthTransferFailed`

#### Treasury

`OnlyHook` / `OnlySelf` / `OnlyPoolManager` / `FactoryAlreadySet` / `FactoryNotSet` / `ZeroAddress` / `TokenAlreadyListed` / `TokenNotListed` / `TokenNotLaunchedHere` / `InvalidPoolKey` / `PoolNotLaunched` / `NotArmed` / `PiggybackInProgress`

Three are worth spelling out on their own:

| Error | When | User-facing copy |
|---|---|---|
| `NotArmed` | `pokeBuyback()` while the reserve is below `TRIGGER_STEP`, or the listing is empty | "The treasury has not accumulated enough yet; there is nothing to trigger" |
| `PiggybackInProgress` | A buyback is already running in the same call stack | "A buyback is already in progress" |
| `PoolNotLaunched` | `addLadderToken` listing a project that has not `launch()`ed yet. Different from `InvalidPoolKey` — the hook exists and the `PoolKey` is well-formed, there is simply no pool behind it yet. Since storage packing removed `_poolKey`, `getPoolKey()` no longer returns zero for an unlaunched project, so this check now reads `launched()` explicitly | "This project has not launched yet" |

#### Token (`src/ToshToken.sol:67-69`)

`OnlyFactory` / `AlreadyInitialized` / `MaxSupplyExceeded`

### 7.4 Deployment script cross-reference

| Script | Purpose | Key actions |
|---|---|---|
| `script/Deploy.s.sol` | Base Sepolia | Treasury → Factory → `setFactory`; prints `getLiveHookInitcodeHash` plus six follow-up steps (including "the mask is now 0x20CC", "createLaunch is now payable", "deposit is now payable, no approve needed") |
| `script/DeployMainnet.s.sol` | Production | Every env var mandatory, none defaulted; enforces `PROD_OWNER_SAFE != deployer`; two-step handover of the factory and the treasury; prints `HOOK_CREATION_CODEHASH` / `LIVE_INITCODE_HASH` / three wei-level defaults plus 6 CRITICAL NEXT STEPS |
| `script/DeployLocal.s.sol` | anvil | Anvil account #0; `V4_POOL_MANAGER` defaults to an `address(1)` stub (enough to exercise the factory-level flows: PoG, referral binding, eligibility) |
| `script/VerifyDeployment.s.sol` | Post-deployment invariant sweep | 6 classes of assertion, including `treasury.factory() == factory`, `!paused()`, and same-block reproducibility of `initcodeHash`; supports strict cross-checking against `EXPECTED_OWNER` / `EXPECTED_POG_SIGNER` / `EXPECTED_PLATFORM_TREASURY` |
| `script/RecomputeInitcodeHash.s.sol` | Re-seeding the frontend miner | Read-only; exports paste-ready JSON; states explicitly that "this is the hash for the 24h STANDARD window; the 3h/72h hashes differ, and the miner has to be rebuilt for whichever window the creator chose" |

### 7.5 Test suite to requirements mapping (v5.0 acceptance)

| Requirement | Test | Location |
|---|---|---|
| 10% genesis premium (as a relationship, not a hard-coded number) | `test_genesisPremium_isExactlyTenPercent` | `test/ToshV5.t.sol` |
| The ladder is fully closed at launch | `test_ladderOpensLockedAtLaunch` | `:858` |
| Ladder geometry (4000 tiers × 3,150 each = 12.6M, over a 2000× span) | `test_tierLadder_geometryIsWellFormed` | `:688` |
| Early release schedule (2× unlocks 365 tiers = 1.14975M = 13.7% of the genesis float) | `test_earlyReleaseSchedule_isSetByTheSupplySplit` | `test/ToshV5.t.sol` |
| Spanning tiers ≡ buying them one at a time | `test_tierMint_spanIsEquivalentToSequentialShelfBuys` | `:755` |
| `maxMintable()` is the exact boundary | `test_maxMintable_isTheExactAcceptedBoundary` | `:789` |
| The leg cap is about gas, not safety | `test_tierMint_legCapBindsWhenMarketRunsAhead` | `:816` |
| Minting and immediately dumping loses money | `test_sweepAndDumpIsLossMaking` | `:885` |
| **Sweeping is profitable once the market has run ahead (the accepted cost)** | `test_sweepIsProfitableOnceTheMarketHasRunAhead` | `:932` |
| Same-block lock + the 105% gate | `test_tierMintAntiSpikeAndCeiling` | `:967` |
| TWAP defeats a single-block pump | `test_tierMint_twapDefeatsASingleBlockPump` | `:1006` |
| In the launch window the reference price is capped at p0 | `test_preTwapWindow_capsReferenceAtP0AgainstATwoBlockPump` | `:899` |
| The 1% buy-side tax splits into 0.7% to the reservoir + 0.3% to the platform | `test_buyTax_splitsOnePercentEthBetweenReservoirAndPlatform` | `test/ToshV5.t.sol` |
| The sell-side tax burns the full 1% in place, with no split | `test_sellTax_burnsTheFullOnePercentOfTokensInPlace` | `test/ToshV5.t.sol` |
| Genesis LP is permanently locked | `test_genesisLiquidityIsPermanentlyLocked` | `:613` |
| Retail LPs can enter and exit freely without touching genesis | `test_retailLp_canAddAndRemoveWithoutTouchingGenesis` | `:633` |
| Round-robin piggyback buyback | `test_treasuryPiggybackRoundRobin` | `:1110` |
| A single faulty leg is isolated | `test_piggyback_isolatesAFaultyLadderLeg` | `:1173` |
| One leg per poke, and the whole ladder still gets covered | `test_piggybackRunsOneLegPerPokeAndStillCoversTheLadder` | 8.33 |
| The marginal gas of one leg, and it does not grow with ladder length | `test_gas_piggybackCostPerLeg` | 8.33 |
| **When the budget is tight the buyback yields and the trade survives** | `test_piggybackSkipsRatherThanKillingTheTrade` | 8.32 |
| **The trade that tips the threshold settles on its own estimate** | `test_piggybackSparesTheTradeThatTipsIt` | 8.32 |
| An honestly estimated trade still carries the buyback (the gate is not set too high) | `test_piggybackStillRidesAProperlyEstimatedSwap` | 8.34 |
| Permissionless `pokeBuyback()` deploys without needing a swap | `test_pokeBuyback_deploysWithoutASwap` | 8.32 |
| `pokeBuyback` reverts explicitly when unarmed / when the list is empty | `test_pokeBuyback_revertsWhenUnarmed` / `_revertsWithAnEmptyLadder` | 8.32 |
| The fuzz handler really can reach `pokeBuyback` (the invariants are not spinning idle) | `test_handlerCanReachPokeBuyback` | 8.32 |
| The packed field widths still fit their respective constants | `test_ladderStateWidthsFitTheirConstants` | §7.1 |
| The treasury has no withdrawal path | `test_ladderTreasury_hasNoWithdrawPath` | `:1196` |
| **The owner cannot redirect spending into their own pool** | `test_ladderTreasury_ownerCannotRedirectSpendToOwnPool` | `:1216` |
| Curation rejects foreign tokens / unlaunched projects | `test_ladderCuration_rejectsForeignTokens` / `test_ladderCuration_rejectsUnlaunchedProjects` | `:1089` / `:1099` |
| PoG quota is not restored by a refund | `test_pogQuota_isNotRestoredByRefund` | `:425` |
| PoG quota refills on its window | `test_pogQuota_refillsAfterTheCooldownWindow` | `:450` |
| The per-wallet cap is snapshotted at project creation | `test_perWalletCap_isSnapshottedAtProjectCreation` | `:396` |
| Global referral persists / self-referral is ignored | `test_globalReferralPersistence` / `_selfReferralIsIgnored` | `:497` / `:524` |
| Orphaned commission is forwarded to the treasury | `test_orphanReferralIsForwardedToLadderTreasuryAtLaunch` | `:537` |
| Mask = `0x20CC` | `test_minedHookAddress_carriesV5FlagMask` / `test_hookMiner_requiredFlagsAre0x20CC` | `:314` / `Guards` |
| The three windows accepted / an unlisted window rejected / a cross-window salt rejected | `Guards:184` / `Guards:206` / `Factory:928` | — |
| The supply partition closes / the 21M hard cap | `test_supplyPartitioning` / `test_tokenMaxSupply_is21M` | `Guards:458` / `:464` |
| Minting rights are permanently frozen at the Hook | `test_token_minterSetIsFrozenAtOneAddress` | `Guards` |

---

## 8. Closed items

> Every item in this chapter is closed. The closure records keep the original numbering so they can be traced back. Line numbers reflect the state of the files after the 2026-08-25 landing.

### 8.0 Closed items (original number → disposition)

| Original | Item | Disposition |
|--------|------|------|
| 8.1 | `projectTreasury` is pure metadata | **Keep the code, fix the doc**. It is a member of the CREATE2 constructor tuple, so renaming or removing it would invalidate every salt already mined (so would editing a comment — see 8.13), and the economic gain would be zero. The natspec now states plainly that "this address never receives funds; for the money, look at `projectAdmin` and `ladderTreasury`" |
| 8.2 | `platformTreasury` has no fund flow either | **Closed — but not by documentation, by giving it a fund flow.** The original disposition was "fix the doc": mark it as v4.x legacy and off the money path in five places — the `ToshFactory` natspec, `.env.example`, `.env.production.example`, the admin panel heading, and `INCIDENT_RESPONSE.md`. This field now collects 0.30% of the ETH input of every buy (`PLATFORM_SWAP_FEE_BPS`), which is the platform's maintenance revenue, so **all five of those notes have been reverted**; it is no longer a legacy field. Follow-on disposition: since a mutable fee recipient is precisely audit item M-2, `setPlatformTreasury` and `TreasuryUpdated` have been deleted, the field is now `immutable`, and it shares a source with the hook implementation's `platformFeeRecipient`. See §2.2.5.1 |
| 8.3 | Referrer hard-coded to the zero address | **Fixed**. New `soat-frontend/src/lib/useReferral.ts`: `?ref=` validation + checksumming + localStorage first-write-wins; `<ReferralCapture/>` is mounted in the root layout, so a landing on any page captures it; a self-referral clears the stored value at spend time rather than being ignored, so a user who tests their own link does not permanently occupy their one binding slot |
| 8.4 | `claimReferralReward()` has no UI | **Fixed**. `ReferralPanel` reads `claimableReferral` and shows as soon as a wallet is connected (shown even at zero commission, otherwise users cannot find their own link) |
| 8.5 | `hook.launch()` has no UI | **Fixed**. `AwaitingLaunchPanel` gives the creator a dedicated entry point and states plainly that if they do not launch, everyone is refunded after 7 days |
| 8.6 | The phase switches wrongly at "soft cap met, not yet launched" | **Fixed**. New `awaiting-launch` phase; the contribution panel now looks only at the window, not at the soft cap, and on oversubscription shows a notice without closing the entrance |
| 8.9 | The 105% gate cancels out the 5% premium | **Accepted as designed**. Product confirmed that this is exactly the mechanism by which the shelf tracks the market price. The behaviour is pinned by `test_sweepIsProfitableOnceTheMarketHasRunAhead`. The quantitative precision is still not there — see 8.7 |
| 8.11 | `registerPoG` does not check the blacklist | **Fixed**. The blacklist test is now the first statement of the function, ahead of the validity window, the nonce and the signature recovery, so a blacklisted wallet can neither register nor raise its quota (`registerPoG` @ `src/ToshFactory.sol`). The same defect was raised again independently as 8.4 (new) and closed there; both numbers point at one fix, and the numbering is kept so either can be traced back. `test_registerPoG_rejectsBlacklisted` |
| 8.16 | `ToshToken` comments say supply is asymptotic | **Fixed**. The discrete ladder, 4000 × 3,150, clears exactly, so total supply can genuinely reach 21M; the comment has been rewritten |
| 8.17 | `ToshToken` natspec still at v4.0 | **Fixed**. Rewritten wholesale. **`renounceMinterRole()` was deleted at the same time**: `MINTER_ROLE` belongs solely to the hook, and the hook has no code path that calls it, no delegatecall and no arbitrary-call forwarding, so once deployed nobody can trigger it — the original test passed only because `vm.prank(address(hook))` forged the caller. A safety control that is documented, backed by a test, and does not actually exist is more dangerous than none. It is replaced by `test_token_minterSetIsFrozenAtOneAddress`, which verifies that the vacant `DEFAULT_ADMIN_ROLE` slot freezes the minter set permanently. **Minting rights being non-migratable and un-proxied is a deliberate Immutable Pact**: a logic flaw cannot be patched by swapping in a v5.1 Hook, and an unsold ladder can never be minted a second time. Declared prominently in the `ToshToken` natspec, in the README, and in the "Immutable Pact" callout on the launch page |
| 8.18 | README still at v3.4 | **Fixed**. Rewritten wholesale for v5.0 |
| 8.19 | The launchpad says 98% | **Fixed**, changed to 99% |
| 8.26 | PoG naming is inconsistent | **Merged into 8.15**, standardised on Proof-of-Gas |
| 8.27 | `useTosh` slot comments contradict each other | **Fixed**, the comment now reads `Slot A: createLaunch` |
| — | `LiquidityPanel` is unreachable | **This document originally failed to report it**. It hangs off the `full` variant of `ProjectTerminal`, while the only call site passes `action-only`, which made the entire add/remove-liquidity feature unclickable for users. It has been moved into the branch that actually renders, and the unreachable `full` variant (259 lines) deleted |
| 8.1 (new) | `launch()` has to wait out the full window | **Kept**. Consistent with "deposits stay open for the whole window, with no hard cap". A warning has been added beside the duration picker on `/launch`, and the confirmation checkbox also states that the window will not end early on reaching the soft cap |
| 8.2 (new) | Trade tax routes on the specified side | **Loop closed**. exact-input still skims the input in `beforeSwap`; exact-output tops up the Delta on the unspecified input in `afterSwap` (mask `0x20C8` → `0x20CC`). However a buy is constructed, 1.0% of the ETH is skimmed away (70 bps to the treasury + 30 bps to the platform), and every sell burns tokens. `test_buyTax_exactOutputSkimsEthNotTokens` / `test_sellTax_exactOutputBurnsTokensNotEth` |
| 8.3 (new) | `pogQuota` only ratchets up, never down | **Kept**. Tightening risk controls is not retroactive. The README and the `registerPoG` natspec now say so: lowering `maxPogAllocationLimit` does not claw back quota already registered |
| 8.4 (new) | `registerPoG` does not check the blacklist | **Fixed**. Aligned with `deposit`; a blacklisted wallet can neither register nor raise its quota. `test_registerPoG_rejectsBlacklisted` |
| 8.5 (new) | Platform pause does not reach the hook or the pool | **Accepted, later partly revised by D3**. The reach of `pause()` is unchanged, and "trading, claiming and refunding on a launched project cannot be interfered with by the platform" still holds; but D3 adds a separate brake that **only stops ladder minting, expires automatically after 7 days, and can be scoped per project**, for incident response when shelf pricing itself turns out to be defective. `INCIDENT_RESPONSE.md` needs to pick up this new boundary |
| 8.6 (new) | `refundEnabled` is written but never read | **Keep the code, fix the comment**. It is now identified as an event-deduplication marker; the authoritative state is `canRefund()` |
| 8.7 (new) | No quantified protection on the shelf arbitrage window | **Pinned**. The upper bound in `test_sweepIsProfitableOnceTheMarketHasRunAhead` tightened from `2×` to `1.5×`. The comment on the `ExceedsTierRemaining` error now points at `maxMintable()` |
| 8.8 (new) | Early after launch the TWAP degenerates into pure spot | **Loop closed**. When `span < TWAP_WINDOW` (including `twap == 0`), `_safeReferencePrice = min(spot, p0)`, so a two-step pulse can push open shelf 0 at most. `test_preTwapWindow_capsReferenceAtP0AgainstATwoBlockPump` |
| 8.9 (new) | Hook dust has no sweep path | **Keep it with no sweep** (the same trade-off as the treasury's one-way valve), with magnitude assertions added: ETH dust `< 0.001 ether`, token dust `< 1e18` |
| 8.10 (new) | The piggyback always spends a flat 1 ETH | **Changed to deploying 10% of the balance, with a 1 ETH floor**. `SPEND_BPS = 1000`. `test_piggyback_spendsTenPercentOnceThePotIsFull` |
| 8.11 (new) | Buyback curation is a single owner point | **Accepted, handled by governance**. The deploy script already enforces that the owner is a Safe and that handover is two-step. `INCIDENT_RESPONSE.md` records the curation policy: FIFO listing, and `removeLadderToken` used only for hostile or broken pools |
| 8.12 (new) | LP exit slippage is computed on a lagging price | **Tolerance is user-adjustable, default 1%**. `LiquidityPanel` offers four settings: 0.5 / 1 / 2 / 5% |
| 8.13 (new) | On-chain addresses and chainId hard-coded in the source | **Split apart**. `POOL_MANAGER` stays hard-coded (a wrong one would silently mis-CREATE2); `POSITION_MANAGER` / `PERMIT2` / `STATE_VIEW` / `NEXT_PUBLIC_CHAIN_ID` come from environment variables, falling back to Base Sepolia |
| 8.14 (new) | The cooldown and the quota window are the same knob | **Split into two independent parameters**. `cooldownDuration` governs the per-(wallet, hook) re-deposit cooldown; `quotaWindowDuration` governs the PoG quota window. At `= 0` the quota degenerates into a lifetime budget, which affects only the second knob |
| 8.15 (new) | PoG naming is inconsistent | **Standardised on Proof-of-Gas**. Contract natspec, README and frontend all agree |
| 8.26 | PoG naming is inconsistent | Merged into 8.15, closed |

### 8.26–8.31 — Added by the red-team adversarial review (late v5.0)

The six items below come from a review pass conducted from an attacker's point of view; every PoC lands in `test/ToshV5Attack.t.sol`. **No path was found that steals user funds or breaks the 21M hard cap**; the findings cluster in the economic design, in governance leverage, and in the gap between what the documentation claims and what the code actually does.

| Number | Item | Disposition |
|---|---|---|
| 8.26 (red team) | **"The ladder is locked at launch" is a 1-wei coin flip** | **Fixed**. The natspec says Phase 2 is fully closed at launch, but `shelfP0` and `ceiling` are the same `(x * 10500) / 10000` expression applied to `p0` and to `min(spot, p0)` respectively, the gate uses a strict `>`, and shelf 0 sits exactly on the boundary — whether it opens depends on which side of `p0` spot lands on after the round-trip truncation through `_toSqrtPriceX96` / `_sqrtPriceToEthPerToken`, and that depends on **the amount raised**: sweeping 1–24 ETH, only the 10 ETH point was open, and the original test happened to run exactly one raise size. The fix is for `launch()` to stamp `lastSwapBlock` itself, reusing the same-block lock to close the launch block outright — which holds for every raise size, costs the buyer nothing but one block, and leaves the pricing algebra untouched. Consequential fix: `maxMintable()` previously ignored the same-block lock and would report a quantity that the next call was certain to reject. `test_ladderOpensLockedAtLaunch_acrossRaiseSizes` / `test_probeA_shelfZeroInLaunchBlock` |
| 8.27 (red team) | **`setMaxPogAllocationLimit(0)` bricks launches platform-wide** | **Fixed**. The value is snapshotted into every new hook's constructor, and that constructor does `require(_perWalletCap > 0)`, so zeroing it makes the CREATE2 construction revert and scraps `createLaunch` with `DeployFailed` for **every single** creator — out of a switch documented as "affects new projects only", and with nothing in either the signature or the event to reveal it. `InvalidPogLimit` now rejects zero, so the failure surfaces at the governance call rather than inside every creator's transaction. The frontend blocks it in parallel and has replaced the "0 = freeze registration" error copy. `test_probeK_zeroPogLimitBricksCreateLaunch` |
| 8.28 (red team) | **Referral commission can be self-farmed with a second wallet** | **Fixed (mitigated)**. `_recordReferral` only blocked `referrer == user`, while the natspec claimed this prevented "anyone from farming their own 10%". That is one address deep: use a second wallet of your own, and that wallet needs no quota, no contribution and no history whatsoever — this is not a referral programme, it is a 10% secret discount for insiders, paid for by the orphaned referral commission that only the uninformed hand over. It now requires `pogQuota[referrer] > 0`. **This does not stop a determined sybil** (a referrer is fundamentally just an address, and the chain cannot tell), but it moves the judgement to the only place that can make it: the PoG oracle. See §2.2.8. `test_probeJ_referralSelfFarmViaSecondWallet` |
| 8.29 (red team) | **TWAP depth is exactly `TWAP_WINDOW`** | **Mitigated (by parameter)**. See ⚠️ 8.29 and 8.30 in §5.1. `TWAP_WINDOW` 600 → 1800; `twapSqrtPriceX96()` returns 0 on an unfilled window, matching the `_safeReferencePrice` convention. **There is no structural fix** — going deeper requires a ring buffer; see pending decision D4 in §11 |
| 8.30 (red team) | **The treasury's "one-way valve" governs custody, not beneficiaries** | **Mitigated**. `ToshLadderTreasury` claims that "neither the owner, nor the hook, nor the factory can move a single wei out" — that sentence is true, but it is very easily read as a claim about beneficiaries. The funds really are burned, but the owner can use `removeLadderToken` to narrow the listing down to a single token and thereby point all of the buy pressure at a book they hold, using the treasury as price support. `perToken` used to be `spend / count`, so a narrow list would receive **the same cheque, concentrated**; it is now `spend / BATCH_SIZE`, which leaves steady-state behaviour (≥3 listings) completely unchanged and bites only on an artificially narrowed list. What needs saying clearly: at that pool depth the real rate limiter is `_buybackSqrtFloor` — however large the reserve, a single leg can only push the price as far as the TWAP floor before it stops filling, and the divisor is the defence in depth behind it. (After 8.33 cut legs per poke to 1, deploying the same amount of ETH takes three times as many pokes, but neither the per-leg allowance nor this floor changed, so the conclusion here is unaffected.) The natspec and the admin panel copy have both been made honest. **No timelock was added** — see pending decision D2 in §11. `test_probeL_ownerDirectsEntireReservoirAtOneMarket` |
| 8.31 (red team) | **The same token can be given a hookless parallel pool** | **No on-chain fix; documentation changed**. V4 only speaks for pools that name it, and `beforeInitialize` can only block pools bound to this hook. Anyone can open a hookless ETH/token pool on the same ERC-20, bypassing the 1.0% tax, feeding nothing to the oracle and supplying nothing to the buyback; the token is a plain ERC-20 with no transfer hook, so the contract layer has no way to prevent this, and does not attempt to. **The thing to remember is not the tax that gets away**, but that `_safeReferencePrice` is **single-venue** — it reads this pool and nothing else. Liquidity migrating out thins the very book the anti-spike gate rests on, and so lowers the cost of levering it. The genesis position is locked in this pool forever, which is why this pool stays the deepest, and why the reference price means anything at all. `test_probeH_hooklessParallelPool` |

**Low severity, accepted as they stand** (all recorded in code comments): dust swaps below 143 wei escape the tax through rounding (not economically viable); the minting rounding edge where 1 wei buys 799,999 wei-token (not amplifiable); a dump temporarily freezes the ladder until arbitrage fills it back in (the settled cost of the `min(spot, TWAP)` design); 186 wei-token of genesis residue (the same trade-off as 8.9 (new)).

**Defences that held up under attack**: the atomic sandwich around the treasury buyback (`_buybackSqrtFloor` means the treasury always buys **after** the attacker's dump, never before); the supply hard cap closes and is exact; the hook permission mask `0x20CC` is correct; `refund()` and `launch()` are mutually exclusive; CEI and the reentrancy guards (OZ `nonReentrant` + the V4 unlock pattern) are solid.

### 8.32–8.34 — Added by the gas cost review

The three items below come from a review pass aimed at "what does the user actually pay, and can they end up paying it for nothing". 8.32 is the only **correctness defect** in the round; the other two are pure cost items.

| Number | Item | Disposition |
|---|---|---|
| 8.32 | **The piggyback kills the very trade that tips the threshold** | **Fixed**. The buy tax is `take`n into the treasury in `beforeSwap`, so a transaction can begin unarmed and be armed by the time `afterSwap` runs — and the one charged with running the buyback is exactly the one that pushed the reserve over the threshold, having estimated its gas against an unarmed pool. This is not an unlucky probabilistic window; it is **one deterministic transaction every cycle**. `try/catch` does not help: once the sub-call OOGs, the 63/64 rule leaves the outer frame only a sixty-fourth, not enough to finish `afterSwap` plus the V4 frame close, and the trade dies along with the buyback. The fix is a `PIGGYBACK_MIN_GAS` headroom gate plus a hard `{gas: avail - PIGGYBACK_TAIL_RESERVE}` ceiling — the tail's share is **physically withheld**, not estimated, so however expensive a leg gets, all that can happen is that it is skipped. The cost is liveness, which the permissionless `pokeBuyback()` backstops, with `STATE-06` polling added. `test_piggybackSkipsRatherThanKillingTheTrade` / `test_piggybackSparesTheTradeThatTipsIt` / `test_pokeBuyback_deploysWithoutASwap` |
| 8.33 | **Three legs per poke, peaking at 579k** | **Fixed**. See §4.9: `LEGS_PER_POKE` split off from `BATCH_SIZE`, one leg per poke, sharding divisor unchanged. Peak 578,809 → 362,884, with the amount reaching each pool unchanged. `test_gas_piggybackCostPerLeg` |
| 8.34 | **A gate calibrated too high silently decommissions the entire piggyback mechanism — and then the correction overshot the floor** | **Fixed, and the fix was reversed; the value is back at 260,000.** The original finding stands: gas-dependent control flow breaks `eth_estimateGas`, because in simulation the limit is generous, the buyback branch is taken and reports 333k, while in the real run only "the limit minus the ~147k already spent" is left by the time execution reaches the poke — so raising this constant raises the buffer a wallet must attach, and at 260,000 an earlier revision measured 22%. The conclusion drawn from it — **lower it to 230,000, which drops the buffer to 12%, and err low, because too low only wastes a doomed poke while too high retires the mechanism** — did not survive the next measurement, and this document recorded it as though it had. **The two failures are only asymmetric above the floor.** One leg is `PIGGYBACK_TAIL_RESERVE` plus its own cost, so the floor is a measurement, not a preference: measured on Robinhood 46630 against the live V4 singleton and a real launched pool, one leg costs **156,153** gas (4.8% above the 148,986 the same leg measures locally under `--isolate`), which puts the floor on 4663 at `100_000 + 156_153 = 256_153`. A gate at 230,000 sits **below** it: the poke is admitted, forwarded 130k, and handed a leg that needs ~149k, so it runs out, `try/catch` swallows it, and no buyback happens either way — the trade survives and the wasted 130k is invisible, because a buyback that did not happen is indistinguishable from the unarmed case that is this branch's normal state. So the floor is the target rather than a bound to sit above, and 260,000 is the next round number over it. **What it costs the reader:** ~5 more points of wallet buffer (the engage test reads 20% where it read 15% at 230,000), which means `afterSwap` skips the piggyback more often and the reservoir leans harder on the permissionless `pokeBuyback()` — some of the engagements the lower gate appeared to buy were real, so this is a genuine trade and not a free correction. `test_piggybackStillRidesAProperlyEstimatedSwap` now asserts **both** bounds structurally (`MIN_GAS ≤ TAIL_RESERVE + one measured leg + headroom`, and no lower than the floor) — it was the missing lower bound that let the value sit under the floor unnoticed; `test_piggybackSkipsRatherThanKillingTheTrade` pins the skip side. All four gas samples and the probe contract are in §F.7 of `docs/ROBINHOOD_MIGRATION.md` |

**Two test defects found along the way** (neither affects the contracts): a deterministic test used `vm.assume` to paper over a fixture that never accumulated 1 ETH — in a non-fuzz test `assume` cannot resample, it can only hang the test outright; and a fuzz counterexample of `3150e18 + 1` left a tail block of just 1 wei after splitting, whose cost rounded down to 0 and hit the anti-dust guard, which is **the contract behaving correctly and the test's decomposition strategy being undefined on that input** — the domain was narrowed rather than the guard bypassed.

**Added to CI**: `forge test --isolate` as a second gate. In normal mode any storage the setup touched stays warm for the whole run, so every later call is cheaper than it would be on chain; the two accounting modes give 15% and 45% for the same test. Two bugs so far were catchable only under isolate.

---

The 8.1–8.15 series in this chapter has no open items left. Of the red team's additions, 8.26–8.31, items 8.29–8.31 retain **open questions that need a product decision** — see §11. The gas review's additions, 8.32–8.34, are all closed.

---

## 11. Decision record

The four items below are not defects; they are **trade-offs that product has already ruled on**. What this section records is the decision itself, the reasoning, where it lands, and **the conditions under which it should be revisited** — that last one above all: a decision with no revisit condition written down has made the assumptions of the day permanent.

All four were settled in one pass after the v5.0 red-team review. D1 and D3 changed code; D2 and D4 are explicit decisions to hold the current behaviour — **"hold" is a decision, not the absence of one**, so it is placed on the record here just the same.

**Ownership of the watch (PM-E6, 2026-09-08):** the revisit conditions for all four are watched by the Deployer / Primary Operator. No separate role is created. Naming a watcher is not the same as having watched; the revisit conditions themselves are unchanged.

---

### D1 · Parameter freeze: accepting a 24.9% early release

**Decision: freeze [2000× span / 4000 tiers / equal flat allocation / 8.4M genesis + 12.6M shelf], and stop pushing the early release down any further.**

| Parameter | Fixed value |
|---|---|
| `GENESIS_SUPPLY` | 8,400,000e18 (Claim 4.62M + LP 3.78M) |
| `BONDING_MAX` | 12,600,000e18 |
| `TIER_COUNT` | 4000 |
| `TIER_SIZE` | 3,150e18 (equal per tier) |
| `TIER_STEP_E18` | 1,001,902,508,266,805,824 |
| `MAX_TIERS_PER_TX` | 32 |

**The cost, stated plainly:** at 2×, 1,149,750 tokens are released. That is 13.7% of `GENESIS_SUPPLY`, 24.9% of the **tradable claim float**, and 19.9% of total circulating float after the release (§3.1 and §3.4 define all three measures). The target originally proposed was ~10% of the float; **that target was not met, and the decision is to stop chasing it**.

**Why:** the 40/60 split cutting 36.5% down to 13.7% is a real improvement on a like-for-like measure, and the remaining gap could only be closed by widening the span or shrinking Phase 2 further — both of which are worse than the problem they fix. With equal-sized tiers the release fraction is `log(R) / log(SPAN)`, so the span's marginal effect on the early release is logarithmic (1000×→2000× moves the release at 2× only from 36.5% to 34.9%; the split is what actually does the work), while the cost is that the entire mid-to-late curve gets flattened. Shrinking Phase 2 further would carve into the only supply the market can price, pushing the project back into the old problem where the genesis float decides everything.

**Where it lands:** `test_ratifiedParameterSet_isFrozen` @ `test/ToshV5.t.sol` pins the six literals in one place, as the **single gate** on any change to the economic model; `test_earlyReleaseSchedule_isSetByTheSupplySplit` pins the release fraction on all three measures at once, so if any one of them changes the other two have to be restated.

**Revisit if:** the first real projects show sustained sell-pressure collapse around 2× (that is, the 24.9% turns out to be more than the market can absorb), or the span or the split has to change for some other reason — in which case reopen this item along with it.

---

### D2 · Treasury curation: no timelock, rely on the multisig process

**Decision: `addLadderToken` / `removeLadderToken` stay owner-controlled and effective immediately; no timelock is introduced.**

**Why:** the two mitigations from 8.30 (`perToken` divided by `BATCH_SIZE`, and `_buybackSqrtFloor` rate-limiting per window) have already downgraded "drain the reserve at will into a single book" to "a slow tilt, rate-limited per window", and what remains is a **governance-surface risk, not a code-surface one**. A timelock buys nothing symmetric here: it does not stop a determined owner (who simply waits 48 hours), but it does force a 48-hour delay exactly when an emergency delisting is genuinely needed (say a listed project's pool has gone wrong and continuing to buy back means sending money into a broken pool). And since the owner ends up as a Safe multisig, the multisig's own propose-and-approve flow already provides the layer of "changes are visible and need several people to agree" — which is the same thing a timelock is bought for.

**Premise (confirmed):** the final owner of both the Factory and the LadderTreasury is a **Safe multisig, 2/N or stricter**. **This decision rests entirely on that premise** — the multisig's propose-and-approve flow is the protection this decision substitutes for a timelock, and if the premise does not hold, neither does the decision.

**Where it lands:** no code change. The `ToshLadderTreasury` natspec and the G4 copy in the admin panel now note honestly that "curation is not neutral; it is an economic knob".

**Revisit if:** ① the owner structure degrades to a single EOA or a 1/N multisig — **a timelock must be added immediately** and this decision lapses automatically; ② the treasury reserve grows substantially beyond the pool depth of any single listed project — at that point the absolute effect of concentration outgrows what the sqrt floor can rate-limit; ③ once the ownership handover is complete, the actual N and threshold should be recorded in `INCIDENT_RESPONSE.md`, so that the premise can be audited rather than passed along by word of mouth.

---

### D3 · Protocol-level circuit breaker: a new bounded ladder halt switch

**Decision: add `haltLadderMinting` / `resumeLadderMinting`, the one and only platform brake that can reach a launched project. This revises the promise recorded in §8.5 (new) that "a launched project cannot be interfered with by the platform at all".**

**Why open this door at all:** `pause()` deliberately stops no launched project, and that boundary is a core platform promise, but it left a gap worth closing — **if shelf pricing itself is found to be defective, every running project keeps selling supply through that defect, and the only remedy available is polite persuasion**. This is not a theoretical risk: this red-team round found 8.26 (the launch lock is a coin flip) in the pricing gate itself.

**Why it did not turn into a veto:** three properties keep the new trust assumption bounded:

1. **It touches `mintBondingCurve` and nothing else.** Pool swaps, retail LPs, `claimGenesis`, `claimReferralReward` and `refund` are all unaffected. **A halt can cost a buyer an opportunity; it can never cost anyone a balance** — no user funds are ever withheld by it.
2. **It expires on its own.** Every halt carries a deadline no further out than `MAX_HALT_DURATION` (7 days). An owner who turns bad, is compromised, or simply disappears **cannot lock Phase 2 shut permanently**; the worst case is a rolling halt that has to be renewed publicly on chain once a week. That is the difference between a break-glass hammer and a kill switch, and it is why the new trust assumption is bounded rather than absolute.
3. **It can be scoped.** `hook == address(0)` halts everything; any other address halts only that one project, so a single market gone wrong does not have to drag the whole platform's Phase 2 down with it.

**Why a separate switch instead of folding it into `pause()`:** merging them would quietly widen what the word "paused" means to every reader and every existing test. The two brakes answer different questions — `pause()` stops the platform from **growing**; this one stops the ladder from **selling**.

**Where it lands:** `ToshFactory.haltLadderMinting` / `resumeLadderMinting` / `ladderMintingHalted`; Guard 0 and the `LadderMintingHalted` error on the hook side; `maxMintable()` reads it too, so the UI and the gate agree; a corresponding module has been added to the admin panel.

**Revisit if:** it goes unused for a year after launch — then reassess whether it is still worth carrying that trust assumption. Conversely, if it is used more than once, that says shelf pricing needs a fix rather than a brake.

---

### D4 · TWAP depth: keep 1800s and two checkpoints, no ring buffer

**Decision: `TWAP_WINDOW` stays at 1800 seconds; it is not rebuilt into a full ring buffer.**

**The cost, stated plainly:** the oracle's manipulation depth **is exactly** `TWAP_WINDOW`. An attacker who holds the price up for 30 minutes and then rolls the checkpoint with a dust swap gets the average to converge on the manipulated price (§8.29; `test_probeB_twapReanchorSpeed` pins this behaviour). Going from 600s to 1800s triples the cost of holding that position, but that is **raising the price, not changing the shape**.

**Why:** a full ring buffer would decouple depth from per-transaction cost, at the price of a substantial rewrite and of pushing gas from "one cold SSTORE per window" back to something close to "one per swap" — a cost borne by **every honest trader**, to defend against an attacker who must first fund holding the price up for half an hour out of their own pocket and then, having done so, still face the 105% premium before they can mint. Raising `TWAP_WINDOW` further is a linear price increase with zero engineering, but it equally slows the rate at which a **genuinely** rising market opens the ladder, and 30 minutes is already close to the inflection point of that trade-off.

**Where it lands:** no code change. The `TWAP_WINDOW` natspec now says outright that "this constant is the entire depth of the oracle; read it as a price, not as a guarantee".

**Revisit if:** a real price-holding manipulation occurs (as opposed to a theoretical one), or the economics of ladder minting change (for example `SHELF_PREMIUM_BPS` being lowered, so that minting after a manipulation becomes genuinely profitable) — what actually stops the attack today is the 105% premium, not the oracle, and the moment that layer thins, this must be reopened.

---

## Appendix: evidentiary limits of this document

- The round of changes behind §8.26–8.31 and §11 **has been run** through `forge build` and `forge test`, and the frontend through `npm run build` and `npm run lint` (all clean). After §11 was settled (D1 parameter freeze + D3 ladder halt) the rerun came to 250/250 passing; two cases were then added, `test_ladderHalt_cannotHoldAFailedGenesisHostage` and `test_ladderHalt_blocksNeitherLaunchNorPayouts`, covering "a halt must not hold refunds or payouts hostage", and that round closed at 252/252. Three further rounds of change have happened since — the stateful invariant suite, the EIP-1167 clone refactor, and gas optimisation — and it **currently stands at 303/303 passing** (once in normal mode and once under `--isolate`, both CI gates). Assertions in earlier chapters still rest mostly on static reading.
- **§8.12's "pause covers `deposit`" was disproved by measurement in this round**: `deposit` carries only `nonReentrant`, not `whenNotPaused`. The same error was present in `INCIDENT_RESPONSE.md` §2 Step 2; both have been corrected. This suggests that every other "function X is protected by modifier Y" assertion in this document should be treated as unverified unless a test name is written beside it — **a modifier list is the kind of documentation that most easily goes quietly false through a refactor**.

  **Systematically verified on 2026-09-05, and the conclusion was the opposite of
  what was expected** (`SECURITY_AUDIT.md` §5.17): all 95 externally reachable
  functions in `src/` were enumerated with the modifiers actually attached and
  checked one by one against the eleven assertions in this document, and
  **every modifier assertion is accurate** — `whenNotPaused` covers exactly
  `registerPoG` and `createLaunch`, `nonReentrant` covers exactly the five hook
  entry points and two factory entry points listed here, and `onlySelf` /
  `onlyHook` / `onlyClone` / `onlyPoolManager` are all where they are said to
  be. The seven functions that change state without a modifier each have a
  reason: either the natspec states that being permissionless is deliberate
  (`releaseAbandonedName`, `pokeBuyback`), or there is an equivalent inline
  check (`hook.deposit` and `ToshToken.initialize` test
  `msg.sender != factory`).
  **What had actually rotted was not the assertions but the line numbers**: of
  the 108 `file:line` citations in this document, 23 can be judged
  mechanically, and 22 of those point to the wrong place — all of them
  **above** the true position, which is the signature of numbers written
  against a much shorter, older version of the contracts and never regenerated
  since. Two of them were knocked out of place on the same day `MAX_LAUNCH_FEE`
  was added, so this decay is not a historical legacy: it happens once every
  time a comment is inserted above. `scripts/checkDocLineRefs.mjs` now holds
  this in CI: **when a sentence names the function in backticks beside the line
  number, "only a human knows what it meant" no longer applies** — the document
  has already said it.
- **This item once listed seven test files that had long since ceased to exist** (`ToshLaunchpadHook.t.sol`, `ToshFactory.t.sol`, `ToshFactoryCoverage.t.sol`, `ToshHookCoverage.t.sol`, `ToshPauseBlacklist.t.sol`, `ToshIntegration.t.sol`, `ToshFuzz.t.sol`) — the test suite had already been consolidated into the `ToshV5*` family, and this "not yet read" list was pointing readers at thin air. The test files that actually exist number **10**: `ToshV5.t.sol`, `ToshV5Factory.t.sol`, `ToshV5Guards.t.sol`, `ToshV5Attack.t.sol`, `ToshV5Fuzz.t.sol`, `ToshV5Bytecode.t.sol`, `ToshV5Abi.t.sol`, `ToshV5Invariants.t.sol`, `ToshHookClone.t.sol`, `DeployMainnet.t.sol`. Of those, `ToshV5Fuzz.t.sol` and `DeployMainnet.t.sol` were not read end to end; the rest have been checked against test names or key passages.
  - That list then drifted once more on its own: `ToshV5Invariants.t.sol` (the stateful invariant suite) and `ToshHookClone.t.sol` (EIP-1167 clone layout and argument round-tripping) were both added after it was written, and it reads like a complete enumeration. **The same passage went false a second time for the same reason**, which says more than the first time did — a hand-written file list has no mechanism to alert its author when files are added or removed.
  - **Then it went false a third time** (2026-09-03): after the sentence above saying "the test files that actually exist number 10" was written, `ToshV5ArbSys.t.sol`, `ToshV5Fork.t.sol` and `ToshV5LpMathVectors.t.sol` were added and `ToshV5Bytecode.t.sol` was deleted, so the real count is **12**. **The same passage, the same reason, a third time.** At this point the answer is not to correct the number again — the enumeration itself is the defect. For the current list, run:

    ```bash
    ls test/*.t.sol
    ```

    and treat the table in `docs/SECURITY_AUDIT.md` §4 as authoritative (that table at least lists a case count per file, which makes it harder for a change to drift through silently). **This document no longer maintains a hand-written enumeration of test files.**
- Not read in full: `soat-frontend/src/app/admin/page.tsx` (51KB), `UserDrawer.tsx` (33KB), `useLaunchData.ts`, `pogQuota.ts`, `apiGuard.ts`, and the server routes under `api/` — the PoG issuance path and the admin backend may contain rules this document does not cover.
- Most of the scripts in `scripts/` (`extractAbis.js`, `pogSigner.ts`, `mineHookSalt.js`, `releaseCompare.js`, `checkEncoding.mjs`, `checkHookMinerTuple.mjs`) have not been read; their purpose is inferred purely from how other files reference them. **"Inferring purpose from references" has itself caused one incident**: `extractBytecode.js` used to be on this list, and the conclusion inferred from references ("the snapshot it maintains is relied on by the frontend") was wrong — nothing actually imports it. See the aside in the key-design part of §6.6. This item once listed a `checkLpActions.ts` that does not exist, and it has been removed — it is indeed not under the root `scripts/` but under `soat-frontend/scripts/` (see the posm payload section above). The newly added `checkLpActionsAbi.mjs` under the root `scripts/` has been read in full and is not on this list.
- **⚠️ Line-number anchors have failed systematically.** This document makes heavy use of anchors like `src/ToshLaunchpadHook.sol:857-877`. The red-team round inserted dozens of lines of explanatory natspec into the Hook / Factory / Treasury, and every anchor sitting after an insertion point has shifted. The anchors touched in §1.2, §2.2.8, §5.1 and §8.26–8.31 have been changed to **function names**. In addition, **every line-number anchor pointing into `test/*.t.sol` has had its line number dropped, leaving only the test name** (30 in all, each machine-verified: the function the original line number fell into did not match the test name given on the same line). The anchors pointing into `src/` have still not been recalibrated one by one.
  Line-number anchors are fundamentally unmaintainable in a live codebase — they begin to rot the moment they are written, and they rot without raising an error. **New references should always be anchored to a function name or a test name, never a line number**; treat the existing line numbers as "roughly where it is" rather than as fact.
  `scripts/checkDocAnchors.js` now pins the two **machine-decidable** failure classes, "the file does not exist" and "the line is past the end of the file", as hard failures (`node scripts/checkDocAnchors.js --strict`), and prints the symbol each anchor lands in so that a human can review whether "the landing point still matches".
