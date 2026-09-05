# Tosh Protocol — Security Audit Dossier

**Version:** v5.0 (pre-mainnet)
**Status:** 🟡 **SCOPE FROZEN — NO AUDIT ENGAGED YET**
**Owner:** Protocol Engineering
**Companion documents:** `docs/INCIDENT_RESPONSE.md`, `jayoo101/tosh-status` → `MANUAL_INTERACTION.md` (public),
`docs/PRD-v5.0.md`

> **What this document is.** The package handed to an external auditor at
> kickoff, and the place their findings come back to. It exists so the audit
> starts from a written scope and a written set of assumptions rather than from
> a repo link and a phone call.
>
> **What this document is not.** Evidence that an audit happened. Sections 6
> through 8 are empty scaffolding. **Do not deploy to mainnet while §6 still
> reads "none".** The unaudited state is the honest state until an auditor's
> signed report replaces it.

---

## 0. Audit status board

| Field | Value |
|-------|-------|
| Audit firm | `<TBD>` |
| Engagement window | `<TBD>` |
| Commit hash under review | `<TBD — fill at kickoff, freeze the branch>` |
| Report delivered | ❌ |
| All Critical / High resolved | ❌ |
| Remediation re-review passed | ❌ |
| Public report URL | `<TBD>` |

**Mainnet gate.** Every row above must be ✅ before `script/DeployMainnet.s.sol`
runs against a production RPC. This table is the single checklist; if it
disagrees with anyone's memory, the table wins.

---

## 1. Scope

### 1.1 In scope

| Contract | Path | Notes |
|----------|------|-------|
| `ToshFactory` | `src/ToshFactory.sol` | Singleton. Ownable2Step + Pausable + ReentrancyGuard. Deploys hooks via CREATE2, holds the blacklist, the PoG quota ledger, and the platform kill switches. |
| `ToshLaunchpadHook` | `src/ToshLaunchpadHook.sol` | One per project. Uniswap V4 hook. Holds genesis ETH, seeds the pool at launch, runs the Phase-2 shelf ladder, and owns the refund path. Largest attack surface in the system. |
| `ToshLadderTreasury` | `src/ToshLadderTreasury.sol` | Platform-wide buyback reservoir. One-way valve: no `withdraw`, `sweep`, `rescue`, or `delegatecall` by design. |
| `ToshToken` | `src/ToshToken.sol` | ERC-20 minted on demand by its own hook only. |
| `src/libraries/HookDeployLib.sol` | | CREATE2 deployment helper (contains the one `assembly` block on the deploy path). |
| `src/libraries/HookMiner.sol` | | Salt mining for the V4 hook-flag address mask `0x20CC`. |

### 1.2 Out of scope

- `lib/**` — Uniswap v4-core, v4-periphery, OpenZeppelin, forge-std. Vendored
  dependencies, audited upstream. **Pin the exact commits at kickoff** so the
  auditor reviews the same bytecode we deploy.
- `soat-frontend/**` — the Next.js UI. Reviewed separately; a frontend
  compromise is covered by `docs/INCIDENT_RESPONSE.md` §2, not here.
- The off-chain PoG signing service, **except** for the on-chain signature
  verification path in `ToshFactory` (`registerPoG`, `_verifyPoGSignature`),
  which is firmly in scope.

### 1.3 Build configuration the auditor must reproduce

```toml
solc            = "0.8.26"
via_ir          = true
optimizer       = true
optimizer_runs  = 200
```

`via_ir = true` is **not** optional — the contracts hit "stack too deep"
without it. Any auditor tooling that disables IR (notably `forge coverage`,
which silently overrides the profile) needs `--ir-minimum`; see the coverage
note in `foundry.toml`.

> **Comment-only edits change the hook's address.** `bytecode_hash` is left at
> its default, so solc metadata rides in the deployed bytecode and a natspec
> edit produces a different initcode hash — and therefore a different mined
> hook address. Freeze the audit branch completely, including comments.

---

## 2. Trust model

### 2.1 Trusted roles

| Role | Held by (mainnet) | Can do | Explicitly cannot do |
|------|-------------------|--------|----------------------|
| **Factory owner** | Gnosis Safe, 2-of-N | `pause`/`unpause` (new launches only), `haltLadderMinting` (≤ 7 days, auto-expiring), `setBlacklist`/`liftBlacklist`, `setPogSigner`, fee and cap setters | Touch a deployed hook's funds. Stop refunds. Stop deposits into a live round. Stop swaps, claims, or LP on a launched project. |
| **PoG signer** | Off-chain service; production key in Vercel encrypted env, a new EOA distinct from the deployer (`PRE_MAINNET_CHECKLIST.md` §4.1). Not KMS. | Sign quota attestations up to `maxPogAllocationLimit` | Move any funds. Worst case is self-issued deposit quota. |
| **Treasury owner** | Gnosis Safe | `addLadderToken` / `removeLadderToken`, `setFactory` (one-shot) | Withdraw ETH. There is no exit but buyback-and-burn. |
| **Project creator** | Project's EOA | `launch()` within the 7-day `LAUNCH_WINDOW` | Access depositor funds. Refunds are unconditional on their inaction. |
| **Project admin** | Project's EOA | `changeProjectAdmin` | Anything on the money path. `projectTreasury` never receives funds in v5. |

### 2.2 Assumptions the auditor should challenge

These are the load-bearing beliefs. If any is false, the security argument
collapses, so each is stated plainly rather than buried in a comment:

1. **The owner cannot reach depositor money.** Once `createLaunch` returns,
   the hook is closed to the factory owner. `refund()` and `claimGenesis()`
   have no owner-controlled gate at all.
2. **A failed genesis always refunds.** If `softCap` is not met by
   `genesisDeadline`, or the creator never calls `launch()` inside
   `LAUNCH_WINDOW`, every depositor can withdraw their exact deposit.
   `canRefund()` is the single authority for this and is not pausable.
3. **`pause()` is narrow and known to be narrow.** It stops `createLaunch` and
   `registerPoG`. It does **not** stop `deposit` into an already-open round.
   This is deliberate (see `INCIDENT_RESPONSE.md` §2 Step 2) and is the one
   place where the runbook was historically wrong.
4. **The ladder halt cannot trap funds.** `haltLadderMinting` stops
   `mintBondingCurve` and nothing else, capped at `MAX_HALT_DURATION` (7 days),
   and lapses without an owner transaction.
5. **The treasury is a one-way valve.** ETH enters from taxes and fees and
   leaves only as a buy-and-burn to `0xdEaD`. There are two doors into that
   path and neither one chooses anything: `autoPiggybackBuyback` (`onlyHook`,
   called from `afterSwap`) and `pokeBuyback` (permissionless). Both land in
   the same `_runPiggyback`, which takes its venue from the hook, its size from
   the reservoir balance, its order from the round-robin cursor, and its price
   bound from the TWAP. A caller picks only *when*.

   `pokeBuyback` is open on purpose. The gas gate in `afterSwap` means a trade
   that cannot afford a buyback no longer attempts one, so the reservoir can no
   longer rely on trading alone to deploy it; without a second door, a market
   running tight gas limits would have stalled the buyback with no recourse.
6. **CREATE2 hook addresses are unforgeable.** The factory freezes
   `HOOK_CREATION_CODEHASH` in its constructor, so a mined salt is only ever
   valid against the initcode that factory was built with.

### 2.3 Known-and-accepted design surfaces

Documented in the contract natspec and exercised by `test/ToshV5Attack.t.sol`.
The auditor should confirm the *bound* on each, not that it is absent:

| Surface | Bound we believe holds |
|---------|------------------------|
| TWAP manipulation of the shelf price gate | `TWAP_WINDOW = 1800s`; gate is a ceiling (`PRICE_CEILING_BPS = 10_500`), so manipulation can only *block* mints, never underprice them. |
| Hookless parallel V4 pools for the same token | Anyone can open one. It carries no tax and no ladder; the canonical pool is the one the hook seeded. Documented at `ToshLaunchpadHook.sol:1157`. |
| Owner curation of buyback targets | `addLadderToken` accepts only tokens this factory launched and derives the pool from the token's own hook — the owner cannot point buybacks at a pool they control. |
| Referral self-farming | Costs the attacker PoG quota on the referrer address; `REFERRAL_BPS = 1000`. |
| Launch-block shelf-0 rounding | `SameBlockMintForbidden` guards the first block. |
| Buyback sandwiching | `MAX_BUYBACK_SQRT_DEVIATION_BPS = 1000` caps the executable deviation. The width is bracketed by `test_probeG2_bandEdgeSitsWhereTheConstantSaysItDoes` (fills at 500 bps, refuses at 1200 bps), so the constant cannot drift in either direction unnoticed. Note the prize per leg is `max(1 ETH, 10 % of reservoir) / 3` — the 0.33 ETH quoted in the natspec is its floor, not a bound. **The cap does not apply for the first `TWAP_WINDOW` (1800 s) after `launch()`** — see the OPEN item below. A second way to widen the band, recurring at any point in a pool's life rather than only at its start, was closed in §5.2 #2: a quiet pool's TWAP used to fossilise at a stale era, leaving the floor slack after a drawdown. |
| **ACCEPTED, HELD OFF CHAIN — buyback is unbounded in a pool's first 1800 s** | **Please challenge this one.** `_buybackSqrtFloor` returns `MIN_SQRT_PRICE + 1` (no bound) while `twapSqrtPriceX96()` reads 0, which is exactly the window from `launch()` until `TWAP_WINDOW` has elapsed. One-shot and not attacker-re-enterable (`_prevCheckpointTs` only rolls forward onto a checkpoint already a full window old), but during it a listed token has no anti-sandwich control at all, on the pool whose liquidity is thinnest. `test_probeG3_immatureTwapLeavesTheBuybackUnbounded` measures it on one pool parked 1500 bps out: with no TWAP the full 3.33 ETH leg clears and 0.93 ETH of it is recovered by whoever parked the price; with the TWAP live the identical deviation is refused outright. `pokeBuyback` has no cooldown, so it is per block, and the leg is `balance / 30`, so the prize scales with the reservoir. The natspec used to defend this with "the reservoir would stall permanently", which is the cost of the *`catch`* branch (a hook that never answers), not of this one — here refusing would cost a deferral of at most 30 minutes via the existing `BuybackSkipped` path. **We chose not to change the contract.** The exposure is instead held shut by an operational rule — do not list a token until its TWAP matures — because reaching the state at all requires `addLadderToken`, which is owner-only. Recorded in three places so it cannot be lost: the rule and its cost in `addLadderToken`'s natspec, the two fallbacks separated in `_buybackSqrtFloor`'s natspec so the weaker one can no longer inherit the stronger one's justification, and `STATE-07` in `monitoring/alerts.json` polling `twapSqrtPriceX96()` on every listed token every 5 minutes. **Residual risk, stated plainly:** this is a procedural control on a privileged key, so it is exactly as strong as the runbook and the alert pipeline, and weaker than the one-line code change that would make it unreachable. An auditor who thinks that trade is wrong should say so. |
| `unchecked` increments | `ToshFactory.sol:524`, `ToshLaunchpadHook.sol:1033/1104/1144` — all loop counters bounded by `TIER_COUNT` / array length. |
| Transient storage for the piggyback flag | `ToshLadderTreasury.sol:461/503`, `tload`/`tstore`. Requires the chain to support EIP-1153. |

### 2.4 Deliberate omissions

Do not report these as findings; report them only if the reasoning is wrong:

- **No `withdraw` / `sweep` / `rescue` on the treasury.** Marked `AUDIT GREP`
  at `ToshLadderTreasury.sol:48-53`. Stuck ETH is the accepted cost of removing
  the rug vector entirely.
- **No minter kill-switch on `ToshToken`** (`ToshToken.sol:116`). The only
  minter is the hook, fixed at construction.
- ~~**`platformTreasury` is on no money path.**~~ **NO LONGER TRUE — audit it.**
  It receives `ToshLaunchpadHook.PLATFORM_SWAP_FEE_BPS` (30 bps) of the ETH
  input of every buy, on every pool. It is `immutable` on the factory with no
  setter, and the same address is baked into the hook implementation as
  `platformFeeRecipient`; the hook's copy is what actually performs the `take`.
  Two things are worth an auditor's attention rather than a pass: (a) the buy
  leg's two `take`s must sum to exactly the hook delta declared to V4, or the
  pool becomes untradeable rather than merely mispaying, which is why the
  reservoir's share is `tax - platformCut` and not its own floor division; (b) the
  recipient is paid by a raw `poolManager.take` on a path with no `try/catch`,
  so a recipient that can revert on receipt bricks every buy platform-wide.
  This closed PRD wart ⚠️ 8.2 and re-closed audit finding M-2 by removing the
  mutability rather than the inflow.
- **`block.timestamp` comparisons.** Every one is against a 3–72 hour genesis
  window or a 7-day launch window; validator drift cannot move either.
  `forge lint` flags 18 of these in `src/` — 11 in `ToshFactory`, 7 in
  `ToshLaunchpadHook`; `foundry.toml` records why they are accepted.

### 2.5 Narrowing casts — triaged

`forge lint` reports 19 `unsafe-typecast` warnings in `src/`, at 12 locations.
They are the opposite of §2.4: every one is a place where Solidity truncates in
silence rather than reverting. This section says, for each, what stops the
truncation — so the auditor's hours go to disagreeing with the reasoning rather
than to reconstructing it.

**The anchors here are source text, not line numbers.** The rows are generated
from `forge lint src --json` and pinned by `scripts/checkLintFindings.mjs`
against `lint-baseline.json`, which is a CI gate. A cast that appears,
disappears or changes shape fails the build with a pointer back to this
section; code motion does not. The counts stated below are cross-checked
against the tool by that same gate, so prose and code cannot disagree.

> **Why the gate exists.** Until 2026-09-04 this was a hand-maintained
> inventory, and it had rotted the way hand-maintained inventories do. It
> carried a row for a `uint48` swap-block stamp that `forge lint` does not
> report, and it was missing a third `BalanceDelta` site, so it described four
> delta casts where the code has six. The two errors cancelled. The total still
> read 19, so the total still reconciled, and a reader checking the arithmetic
> would have found nothing wrong — which is why nobody opened the table for a
> week. An auditor handed that map pays to redraw it.

#### A — lossless by construction; no bound is relied on (10 of 19)

The Uniswap V4 `BalanceDelta` idiom `uint256(uint128(-x))`, under a branch that
has already established the sign. In checked 0.8.26 arithmetic `-x` on an
`int128` reverts at `type(int128).min`, so the negation yields a strictly
positive `int128`; narrowing a positive `int128` to `uint128` is exact, and the
widening to `uint256` cannot lose. There is nothing here to bound — only the
sign guard, and every one sits within three lines of its cast.

| Site | Cast | Sign guard |
|------|------|------------|
| `ToshLaunchpadHook._skimUnspecifiedInput` | `uint256(uint128(-inputDelta))` (2) | `if (inputDelta >= 0) return 0;` |
| `ToshLaunchpadHook` add-liquidity settle | `uint256(uint128(-d0))` (2) | `if (d0 < 0)` |
| `ToshLaunchpadHook` add-liquidity settle | `uint256(uint128(-d1))` (2) | `if (d1 < 0)` |
| `ToshLadderTreasury._buyAndBurn` | `uint256(uint128(-owed))` (2) | `owed < 0 ? … : 0` |
| `ToshLadderTreasury._buyAndBurn` | `uint256(uint128(out))` (2) | `if (out > 0)` |

#### B — a revert in the same function (3 of 19)

`ToshCloneLib.cloneInitcode` packs three of its five immutable args into narrow
fields and checks all three before it does:

- `uint128(softCap)`, `uint128(perWalletCap)` — `revert CapTooLargeToPack()`.
- `uint32(genesisDuration)` — `revert DurationTooLargeToPack()`.

The duration guard is the interesting one and the comment at the site explains
why it was added: `initcodeHash` is a public view the frontend mines salts
against, so two durations that pack to the same `uint32` hash the same, and a
salt mined for the value you passed would predict the address of a launch
committed to a different one, with nothing anywhere saying so. The deployment
path itself was never at risk — `initializeToken` rejects any duration outside
its three rungs.

#### C — the compiler makes it unreachable (1 of 19)

`ToshLadderTreasury._buybackSqrtFloor`, `uint160(floor)`:

```solidity
uint256 floor = (uint256(twapSqrt) * (BPS_DENOMINATOR - MAX_BUYBACK_SQRT_DEVIATION_BPS)) / BPS_DENOMINATOR;
return floor > unbounded ? uint160(floor) : unbounded;
```

Both operands of the subtraction are `constant`, so it is a compile-time
constant expression. A deviation above `BPS_DENOMINATOR` does not produce a
wide multiplier — it fails to compile. The multiplier is therefore at most 1,
`floor <= twapSqrt`, and `twapSqrt` is already a `uint160`. Present value is
1 000 bps against a 10 000 denominator. No test is offered for this one because
the failure mode is a build error, and a test cannot be reached past it.

#### D — bounded by constants the suite pins (3 of 19)

`ToshLaunchpadHook`, the single `LadderState` SSTORE:

```solidity
tierIndex: uint16(tierIndex), tierSold: uint88(sold), minted: uint96(uint256(st.minted) + tokenAmount)
```

| Field | Ceiling | Field holds |
|-------|---------|-------------|
| `tierIndex` | `TIER_COUNT` = 4 000 | `uint16` — 65 535 |
| `tierSold` | `TIER_SIZE` = 3.15e21 | `uint88` — 3.09e26 |
| `minted` | `BONDING_MAX` = 1.26e25 | `uint96` — 7.92e28 |

Held at runtime by `revert LadderExhausted()` and `revert
ExceedsTierRemaining()` on the `TIER_COUNT` fence, and by the rollover that
resets `sold` at `TIER_SIZE`. The third is worth one extra step because it is a
running sum rather than a fenced index: the mint loop is `while (filled <
tokenAmount)` with a fence inside it, so it either fills exactly `tokenAmount`
or reverts — `st.minted + tokenAmount` is realised issuance, not a request, and
`TIER_COUNT × TIER_SIZE` caps it at `BONDING_MAX`.

The constant relationships are pinned by
`test_ladderStateWidthsFitTheirConstants`, which fails if any of the three
outgrows its field.

#### E — bounded by an invariant, not by a check (1 of 19)

`ToshLaunchpadHook._twapSqrtPriceX96`, `int24(delta / int56(uint56(span)))`.

The quotient is a time-weighted mean of ticks over the window, and every
instantaneous tick is in `[MIN_TICK, MAX_TICK]` = ±887 272, comfortably inside
`int24`'s ±8 388 608. So the mean fits — **provided `delta` and `span` measure
the same window.** That is an invariant rather than a guard, and it is the one
row in this section where an auditor is being asked to check a property rather
than to re-read a nearby `if`.

The invariant holds today because `_prevCheckpointTs` and
`_prevCheckpointCumulative` are written together in the only two places either
is written: the roll inside `_writeObservation` writes the pair on consecutive
statements, and the launch seed writes the timestamp into a fresh EIP-1167
clone whose cumulative is still zero, which agrees. Nothing in the type system
enforces the pairing. A future edit that rolls one without the other makes
`delta` cover a longer span than `span` names, and the quotient can then exceed
the tick range and truncate silently.

Two adjacent facts, so they are not re-derived: division by zero is excluded by
the `span < TWAP_WINDOW` early return above it, and the
`int56(lastTick) * int56(uint56(nowTs - lastObservationTs))` product on the
preceding line has roughly 9× headroom (3.8e15 against `int56`'s 3.6e16) and
reverts rather than truncates if it ever runs out.

#### F — bounded by the ETH supply (1 of 19)

`ToshLadderTreasury._buyAndBurn`, `-int256(ethIn)`. For `int256(ethIn)` to wrap
negative — handing V4 an exact-**output** swap where an exact-input was meant —
`ethIn` would have to exceed 2^255 wei. That is 5.8e76 against a total ETH
supply near 1.2e26. Bounded by physics rather than by code, which is a fine
place to leave it; one line of an auditor's time confirming that `ethIn`
descends from `address(this).balance` rather than from a caller closes it.

#### What `forge lint` does not report

The 19 above are the tool's output, not the complete set of narrowing casts in
`src/`. At forge 1.7.1 it is silent on all eight clock and block-height
narrowings, which is why the old inventory could carry a `uint48` row the tool
had stopped producing without anything noticing:

| Site | Cast | Ceiling |
|------|------|---------|
| `ToshLaunchpadHook.sol` — launch seed (3), `_writeObservation`, `_twapSqrtPriceX96` (2), TWAP span | `uint32(block.timestamp)` (6) | 2106-02-07 |
| `ToshLaunchpadHook.sol` — Phase-2 lockout, `afterSwap` | `uint48(_blockNumber())` (2) | 2.8e14 blocks ≈ 890 000 years at Robinhood Chain's 100 ms |

The `uint48` height ceiling is not a real one and the storage comment at
`ToshLaunchpadHook.sol:818` does that arithmetic. The `uint32` second ceiling
in 2106 **is** dated, and the disposition is that it fails loudly rather than
quietly: the two places that consume these stamps take checked `uint32`
differences (`nowTs - lastObservationTs`, `nowTs - _prevCheckpointTs`), so the
first observation after the wrap underflows and reverts the TWAP path instead
of reporting a wrong average. Worth an auditor confirming, since it is the
difference between a dead oracle and a lying one.

Two singleton findings `forge lint` reports outside `src/` —
`erc20-unchecked-transfer` and `divide-before-multiply` — are both in `test/`
and neither is on a production path. The CI gate scopes itself to `src/` for
that reason.
---

## 3. Asset flow — where the money actually is

The auditor's shortest path to the important code. At any moment, user ETH
sits in exactly one of these places:

```
  user wallet
      │  factory.deposit{value}(hook, referrer)      ← NOT pausable
      ▼
  hook balance  ─────────────────────────────────────┐
      │                                              │
      │  hook.launch()  (creator, within 7 days)     │  hook.refund()
      │                                              │  (any depositor, if
      ▼                                              │   canRefund() is true)
  ├─ Uniswap V4 pool (LP, locked)                    │
  ├─ referralAccrued[referrer]  → claimReferralReward│
  └─ ladderTreasury (platform tax)                   ▼
             │                                  user wallet
             │  two doors in, one way out:
             │    · autoPiggybackBuyback()  ← onlyHook, from afterSwap,
             │                                 gas-gated and gas-capped
             │    · pokeBuyback()           ← permissionless, opens its own
             │                                 unlock frame
             ▼
        buy token → burn to 0xdEaD          (no other exit exists)
```

Both doors run the same `_runPiggyback()`, so the second one widens *who* can
trigger a buyback and *when* — never where the ETH goes or how much of it moves.
That is the property to attack: `pokeBuyback` is unauthenticated by design, and
its safety rests entirely on the caller controlling none of venue, size, order or
price floor.

**The two questions that matter most.** An auditor short on time should spend
it here:

1. Can any path leave ETH in a hook that `refund()` and `launch()` both
   cannot reach — i.e. can funds get stranded?
2. Can `launch()` be made to seed the pool on terms that let the caller
   extract more than they put in (price manipulation at seeding, reentrancy
   through V4's `unlockCallback`, or the shelf-0 boundary)?

---

## 4. Test coverage handed to the auditor

`forge test` — **327 passing**, and again under `forge test --isolate`, which
bills each call the way a real transaction would rather than letting storage
touched in setup stay warm for the rest of the test. Both runs are CI gates.

A further **8 fork tests** run only when `ROBINHOOD_RPC` is set and report as
SKIPPED otherwise, so the headline count is 327 or 335 depending on whether the
runner has an endpoint. They are listed below but excluded from the 327
deliberately: a number that changes with a credential is not a number.

| File | Tests | Focus |
|------|------:|-------|
| `test/ToshV5Factory.t.sol` | 101 | Pause, blacklist, PoG quota/cooldown/nonce, launch fee, name registry, ownership. |
| `test/ToshV5.t.sol` | 80 | Happy paths: genesis → launch → claim → shelf ladder → refund; ladder halt. Also the gas budgets and the piggyback gas gate. |
| `test/ToshV5Guards.t.sol` | 70 | Access control and phase guards across every external entry point. |
| `test/ToshHookClone.t.sol` | 18 | EIP-1167 clone layout, immutable-arg round-trip, per-clone isolation, salt mining, deployment gas. |
| `test/ToshV5Attack.t.sol` | 16 | The §2.3 surfaces, adversarially. |
| `test/ToshV5Invariants.t.sol` | 14 | **Stateful invariants** for §2.2 items 1, 2 and 5. See below. |
| `test/ToshV5Abi.t.sol` | 8 | Drift between the contracts and everything that binds to them by name rather than by type: 3 pin `abis.ts` to the Foundry artifacts, 5 pin the duck-typed cross-contract interfaces to the implementations that answer them (§5.7). |
| `test/ToshV5ArbSys.t.sol` | 7 | `_blockNumber()` on an Arbitrum Orbit chain: that the hook stamps the **L2** height rather than `block.number`'s L1 one, and that it still falls back correctly where `ArbSys` is absent. Two contracts, with and without the precompile etched. |
| `test/ToshV5Fuzz.t.sol` | 6 | Property fuzzing, 256 runs per property. |
| `test/ToshV5LpMathVectors.t.sol` | 4 | Fixed vectors for the V4 liquidity math, checked against independently computed expectations. |
| `test/DeployMainnet.t.sol` | 2 | Deploy script, including the forced Safe ownership handoff. |
| `test/ToshV5Fork.t.sol` | 8 | **Live chain 4663**, skipped without `ROBINHOOD_RPC`. Lifecycle against the deployed V4 singleton; a buy through the deployed UniversalRouter; the router's calldata layout pinned against the chain. See §4.2. |

### 4.1 Stateful invariant suite

Every other file above asserts a property under a call sequence *its author
chose*. `test/ToshV5Invariants.t.sol` asserts properties under sequences nobody
chose: a handler exposes deposits, refunds, launches, claims, project creation,
**real V4 swaps in both directions**, ladder curation, two scales of time travel
and **every owner-only switch** (`pause`, `haltLadderMinting`, `setBlacklist`,
`setPogSigner`, `setLaunchFee`, `setDefaultSoftCap`,
`setMaxPogAllocationLimit`), and the fuzzer composes them in arbitrary order.
Configured at 128 runs × depth 100 in `foundry.toml` (12 800 calls per
invariant); the whole file runs in ~10 s.

| Invariant | §2.2 claim | What it pins |
|---|---|---|
| `invariant_unlaunchedHookCanPayEveryRefund` | 2 | Every unlaunched hook holds enough ETH to pay **all** outstanding deposits at once. |
| `invariant_refundabilityNeverRevokes` | 2 | `canRefund()` is a latch — once open, the exit cannot close, and such a round can never later launch. |
| `invariant_ownerCannotMoveTheDepositLedger` | 1 | `ethDeposited` matches a ghost ledger written only by user deposits and user refunds. |
| `invariant_perHookCapsAreFrozen` | 1 | Each round's `softCap` / `perWalletCap` never move after it opens, across arbitrary platform retunes. |
| `invariant_treasuryOnlyLosesEthToBuybacks` | 5 | The treasury's balance never falls except on a buyback — a swap that carried one, or a `pokeBuyback()`. No owner action, deposit, refund, claim, retune or re-curation dents it. |
| `invariant_treasuryOutflowAlwaysBurns` | 5 | Every wei that leaves the treasury is matched by tokens arriving at `0xdead` in the same call. |
| `invariant_burnedSupplyNeverReturns` | 5 | No token ever leaves the burn address, so "burned" means destroyed rather than parked. |
| `invariant_ownerNeverHoldsValue` | 1, 5 | The owner's ETH balance stays zero and it never comes to hold a project token, under any sequence. |

#### Why the treasury invariants changed shape

The earlier revision of this suite asserted that the ladder treasury's balance
was **monotone**, and that was a weak claim dressed as a strong one: the
treasury's only egress is `autoPiggybackBuyback`, which is `onlyHook` and fires
exclusively from a hook's `afterSwap` — and the handler could not swap. The
invariant held because the payout path was unreachable, not because it was safe.

With swaps in the fuzzer's hands the reservoir fills from the 70 bps reservoir
share of the 1% buy-side tax (the other 30 bps is the platform's cut and never
reaches this balance),
crosses `TRIGGER_STEP`, and real ETH leaves on arbitrary sequences while the
owner is simultaneously re-curating the ladder. So the claim is now split into
the two halves that are actually load bearing: outflow may happen **only** on a
buyback, and every wei of it must be matched by a burn. The second is the one
that holds `addLadderToken`'s venue-derivation defence to account — an owner who
could point the reservoir at a pool they control would move ETH without burning
anything, which is exactly what `invariant_treasuryOutflowAlwaysBurns` measures.

`pokeBuyback` was added to the handler for the same reason swaps were. It is
permissionless and it is the only egress that runs with no swap anywhere in the
call, so leaving it out would have recreated the original mistake one layer along
— an invariant passing over the newest payout path in silence. It is driven by a
random actor holding no role, because that is the threat model: whatever an
arbitrary caller can extract by choosing the moment, they must extract nothing.
`test_handlerCanReachPokeBuyback` pins that the handler actually lands one, since
a registered action whose preconditions always fail is indistinguishable from
coverage.

Reachability is asserted deterministically rather than hoped for:
`test_handlerCanReachBuybackAndBurn` arms the reservoir the way production does
(launch fees plus swap tax, **no `vm.deal` to the treasury**), fires a swap, and
requires that the treasury balance fell and the burn pile grew.

§2.2 items **3** (`pause()` is narrow) and **4** (the ladder halt cannot trap
funds) have no invariant of their own, but they are not untested here either:
`pause`/`unpause` and `haltLadderMinting`/`resumeLadderMinting` are both in the
fuzzer's hands throughout, so if either could hold a refund hostage, the
solvency and latch invariants above are what would fail. That is weaker than a
dedicated invariant and is listed as covered-by-implication, not covered.

Two properties are worth flagging to the auditor because they are *derived*, not
obvious from reading a single function:

- **Referral reserve does not compete with refunds.** `deposit` accrues the 10%
  commission as bookkeeping without moving ETH, and `claimReferralReward` is
  gated on `launched`. So a failed round owes referrers nothing and the entire
  hook balance stays available to depositors. The solvency invariant subtracts
  nothing for `totalReferralReserved` on purpose — **if someone ever makes
  referral claimable pre-launch, that invariant is what breaks.**
- **Refundability is monotone because `refund()` does not decrement
  `totalEthDeposited`.** Past the deadline deposits are closed, so the gross
  figure is frozen and the `softCapFailed` term cannot flip back. That is load
  bearing: were the total decremented, refunds by early exiters could push a
  round back across the soft cap and shut the exit on whoever was slower.

Two things an auditor should know about how the suite is built, since both are
places this class of test usually goes quietly wrong:

- `fail_on_revert = false` is required — a random sequence legitimately hits
  phase guards on most calls. That setting means an all-reverting run would
  report a serene pass, so coverage is asserted separately and deterministically
  in the four `test_handler*` tests, which drive the handler by hand and fail
  loudly if any entry point stops taking effect. Those assertions deliberately
  do **not** live in `afterInvariant`, where shrinking reduces the
  counterexample to one call and makes the report meaningless.
- The handler never calls `vm.deal`. Actors are funded once in `setUp`, so the
  ether in the system is fixed and the solvency invariant is checked against a
  balance the test cannot top up. This extends to the treasury: the buyback
  invariants are exercised against a reservoir filled by launch fees and swap
  tax, never by a top-up, because topping up the pot under test would also fake
  the accounting the outflow audit compares against.
- Action *targets* are phase-selected (a deposit aims at a round still in
  genesis, a listing at one already launched), and several selector weights are
  tuned. Both were forced by measurement rather than chosen for elegance: with
  uniform targets the fuzzer reached 4 deposits and 0 launches per run, and with
  listing and delisting at equal weight the ladder measured empty at the end of
  every run — which makes `autoPiggybackBuyback` return early on `total == 0`
  and would have left the two new treasury invariants vacuously true. This
  narrows only *what* each action aims at, never *whether* it is allowed to
  fail: the contracts' own guards still decide that, and an unsatisfiable phase
  falls back to a uniform pick so the guard-rejection paths stay sampled.

### 4.2 Fork suite — the deployment that is actually there

`test/ToshV5Fork.t.sol`, against **Robinhood Chain (4663)**, unpinned. Every
other suite runs against a `PoolManager` this repository compiles and deploys
itself. That is the same source, but it is not the same bytecode and it is never
the same surrounding state. Four things only a fork can answer:

1. The 24,009-byte singleton on chain accepts a hook address our miner produced,
   under **its** compiled copy of the flag-validation rules rather than ours.
   That it is 24,009 bytes — the same length as Ethereum's — is itself the
   cheapest evidence that Robinhood runs the v4-core build we compile against.
2. `initialize` and the genesis liquidity mint work against a singleton that
   already holds live pools — our pool id does not collide, and our accounting
   does not disturb what is already there.
3. The periphery addresses §2.2 of the checklist hard-codes are the addresses
   that are really there, checked against the chain rather than against
   off-chain sources that can all be stale at once.
4. `ArbSys` is registered at `0x64`. The hook decides once, in its constructor,
   whether to read the chain's height from `ArbSys` or from `block.number`, and
   it decides on `extcodesize`. Every other test of that branch supplies its own
   answer with `vm.etch`; this one reads the chain, so the premise underneath
   the mocks is checked against the thing it models.

Two things about this fork are **not** faithful, both tooling rather than choice,
and both worth knowing before reading a green run as more than it is:

- **Unpinned.** The public endpoint retains state for under seventeen minutes at
  100 ms blocks, so a `FORK_BLOCK` constant goes stale before review. A failure
  describes the chain as it was that morning.
- **`ArbSys` is mocked.** Foundry does not implement it; the fork faithfully
  copies the chain's one-byte stub at `0x64`, so `_hasArbSys` reads true and
  every call through it reverts. `_installArbSys` etches an implementation
  seeded from the forked header. Removing the etch kills five of the eight
  tests, so it is visibly load-bearing. What it costs: under a fork
  `block.number` already *is* the L2 height, so the two agree and this suite
  cannot catch a regression back to `block.number`. That is
  `test/ToshV5ArbSys.t.sol`'s job, where the two are forced apart.

The buy goes through the **deployed UniversalRouter**, not v4-core's
`PoolSwapTest`. That distinction produced the one finding worth carrying out of
this work — and the migration inverted it, which is the more instructive shape:

> Ethereum's UniversalRouter **predates** this repository's copy of
> v4-periphery: `IV4Router.ExactInputSingleParams` in `lib/` carries a sixth
> `minHopPriceX36` field its decoder knows nothing about, **inserted between
> `amountOutMinimum` and `hookData`** rather than appended. So the fork test
> hand-rolled the deployed 5-field tuple.
>
> Robinhood's router is the same stock Uniswap contract from a **newer** build.
> It has six fields. It agrees with `lib/`, the hand-roll became the wrong one,
> and the test now imports the library struct. **The trap did not go away, it
> changed sign** — and nothing in either type system relates the two layouts on
> either chain.

**The failure mode is worse than a revert, and narrower than "every field after
`poolKey`".** Both layouts place every field up to and including
`amountOutMinimum` at the same offset, so those decode correctly. The decoder is
a raw pointer cast — `swapParams := add(params.offset, calldataload(params.offset))`
— with no length check, so a wrong-length tuple is reinterpreted rather than
rejected.

Measured on Ethereum, against a faithful replica of that 5-field decoder being
fed the 6-field tuple:

| `minHopPriceX36` | `currency0` | 5-field decoder |
| --- | --- | --- |
| non-zero | any | reverts, no returndata |
| zero | non-zero | reverts, no returndata |
| zero | zero (native ETH) | **does not revert** — `hookData` decodes as empty |

Measured on Robinhood, against the **live** 6-field decoder being fed the 5-field
tuple — the mirror case, and the one that now applies:

> **Does not revert.** Seven of the fork suite's eight tests stay green under the
> wrong encoding, including the exact-70-bps tax assertion. The decoder reads the
> short tuple's `hookData` offset (`0x120` = 288) as `minHopPriceX36`; nonzero,
> so the price check *runs*, but 288 in X36 fixed point is 4.2e-9 and any real
> price clears it. It then reads the tail's length word, `0`, as the `hookData`
> offset, which points back at `currency0` — zero for native ETH — and decodes
> an empty `hookData`. Correct amounts, silently dropped `hookData`.

Both directions land on the same row: every pool this protocol creates is
native-ETH/token, so `currency0` is zero and we are always in the quiet case. An
ERC20 `currency0` would read an address as a length and die loudly, which would
be the good outcome.

The consequence for testing is the part worth internalising: **the expensive
against-the-real-chain suite does not catch this on its own.** It needed a test
written specifically to discriminate — `test_fork_deployedRouterReadsTheSixthField`
forces the sixth field to `type(uint256).max` and asserts the revert, and it is
the only test in the file the wrong encoding kills.

`scripts/checkV4RouterTuple.mjs` is the standing guard, wired into
`.github/workflows/test.yml`. Inverted at the cutover along with the finding: it
now requires the fork test to *import* the vendored struct rather than restate
it, requires the vendored struct to still **match** the deployed layout (and
reports the first divergent head slot when it stops), checks the vendored
decoder's minimum-length floor against its own field count, and constrains what
non-test sources may do with router calldata.

That last check is the one that matters going forward, and it was relaxed once —
carefully — when `script/RehearseTestnet.s.sol` began driving real buys through
the live router on testnet. It read "nothing outside `test/` builds this at all",
which the rehearsal made untenable. The premise was never really "no callers"
though; it was "no caller this guard cannot relate to the deployed layout", so a
`.sol` file encoding the vendored `IV4Router.ExactInputSingleParams` is now
allowed, because checks 2–3 already pin that struct.

The two cases that carry the risk still fail, and all three mutations were run to
confirm it: a hand-rolled `struct ExactInputSingleParams` anywhere, a `.sol` file
touching the router without the vendored struct, and **any** TypeScript reference
— the frontend swaps nothing today, and the day a swap panel is added it would be
hand-building this tuple in a language with no access to the Solidity type, which
is the silent hazard the guard exists for.

Worth reading the trace once (`forge test --match-test
test_fork_buyThroughRealUniversalRouter -vvvv`): the router calls `unlock` on
the singleton, the singleton calls back into the router, and only then does
`swap` reach `beforeSwap` with `sender` set to the router. The 100 bps tax is
asserted as an exact equality rather than `> 0`, because the failure that costs
money is not "no tax" but "wrong tax". Each side of the buy-leg split is
asserted at its own rate (70 bps to the reservoir, 30 to the platform) and so is
their sum: against the real singleton, the sum is the assertion that says the
split still settles, since a pair that does not add back to the declared hook
delta reverts `CurrencyNotSettled` rather than mispaying. A companion test sends an unsatisfiable
`amountOutMinimum` and confirms the router reverts with
`V4TooLittleReceived(min, received)` where `received` is the **post-tax** figure
— i.e. the router's slippage check sees the amount the hook actually left, so a
trader cannot be walked past a bound they did not clear.

Running it needs only `ROBINHOOD_RPC`; the public endpoint serves the tip fine,
and the tip is all an unpinned fork asks for.

**Known coverage gaps, stated up front rather than discovered:**

- Fuzz depth is 256 runs per property — adequate for CI, thin for an
  invariant-hunting engagement. Ask for a higher run count during audit; the
  invariant suite likewise deserves a long soak (`FOUNDRY_INVARIANT_RUNS`) at a
  depth well past 100.
- Swap coverage in the invariant handler is now real but **thin per run**. A
  measured run reaches roughly 6 buys, 2 sells, one ladder listing and one
  buyback cycle inside its 100 calls, because a buyback is several actions deep
  past launch (fund → launch → list → accumulate 1 ETH → swap). The invariants
  are exercised rather than vacuous, but this specific path deserves a long soak
  at higher depth during the engagement, not just the CI budget.
- The shelf ladder (`mintFromShelf`) has no invariant action. Its price gates
  are covered by the unit and attack suites only, so the tier-boundary and
  same-block-lockout logic is not composed against arbitrary sequences.
- Fork coverage exists but is **narrow by design**. `test/ToshV5Fork.t.sol` runs
  the launch lifecycle and a buy against the Uniswap V4 singleton actually
  deployed at `0x8366a39CC670B4001A1121B8F6A443A643e40951` on Robinhood Chain,
  and the buy goes through the **deployed UniversalRouter** rather than v4-core's
  `PoolSwapTest`. That closes what this list previously called its largest gap,
  and it closed it with a finding worth restating: the deployed router and this
  repository's `lib/v4-periphery` disagree about whether
  `IV4Router.ExactInputSingleParams` has five fields or six, and which one is
  ahead **depends on the chain** — Ethereum's router is behind `lib/`, Robinhood's
  is level with it. Encoding against the wrong one produces calldata the live
  router misdecodes, and on a native-ETH pool it misdecodes *without reverting*,
  silently dropping `hookData`. §4.2 has the measurements in both directions. A
  sweep of the frontend, `scripts/`, `script/` and non-test `src/` found one
  other producer, and it is on the pinned path: `script/RehearseTestnet.s.sol`
  drives the testnet rehearsal's buy through the vendored struct. Nothing else
  encodes it — the UI buys through `hook.mintBondingCurve`, LPs through the V4
  position manager, and `ToshLadderTreasury._buyAndBurn` calls
  `poolManager.swap` inside its own unlock frame.
  `scripts/checkV4RouterTuple.mjs` keeps that true.

  What the fork suite does NOT cover, and an auditor should not assume:
  sells, the ladder and buyback engines, refunds, and every adversarial case.
  Those stay on the local `PoolManager`. The fork tests answer "does the real
  deployment accept us", not "is the logic right" — eight tests against a live
  node cannot be the place a state machine is explored, and an unpinned fork
  makes them a reading rather than a standing guarantee.
- **`ArbSys` is mocked inside the fork**, so the suite is faithful about the
  value `_blockNumber()` returns and mute about the divergence that motivates
  it. See §4.2. The divergence itself is covered by `test/ToshV5ArbSys.t.sol`.
- The suite skips rather than fails when `ROBINHOOD_RPC` is unset, which is how
  CI sees it unless the secret is configured. Read a green CI run as "the fork
  tests were not contradicted", and check the run log for `SKIP` before
  treating them as evidence.

---

## 5. Pre-audit hygiene checklist

Complete before the auditor starts, so their hours go to logic rather than to
telling us things CI could have:

- [x] `forge build --sizes` — every DEPLOYED contract under the 24 KB EIP-170
      limit. Tightest margin is `HookDeployLib` at 2,953 B, then
      `ToshLaunchpadHook` at 3,978 B. Both lost ~230 B to the `PIGGYBACK_MIN_GAS`
      work in `ROBINHOOD_MIGRATION.md` §F.7; the margin is shrinking and is worth
      watching rather than assuming. Note `forge build --sizes` also lists
      `CloneDeployer` at **−3,061 B**, i.e. over the limit: it is a test helper
      in `test/ToshHookClone.t.sol` that embeds a full hook creation code, it is
      never deployed, and Foundry does not distinguish test contracts in that
      table. Read the table with that in mind rather than as a pass/fail.
- [x] `forge test` — 350/350 green, and 350/350 again under
      `forge test --isolate`. Both are CI gates in `.github/workflows/test.yml`,
      and that workflow now also asserts the COUNT: a floor of 350 and an
      equality check between the two runs. Added because an interrupted build
      leaves an artifact with a complete ABI and empty bytecode, which forge
      reports as "no tests found" for that suite and skips — the whole main suite
      went missing once and the run stayed green at 256. A passing `forge test`
      was not, until this, evidence that the tests ran.
      The floor is only useful while it tracks the suite. It sat at 335 against
      349 actual until 2026-09-04, i.e. 14 tests of slack, which is enough to
      lose a whole suite without tripping — the exact failure it was built for.
      Raising it is part of adding tests, not a separate chore, and it moved to
      350 in the same commit as the §5.7 mutex test. 350 holds even without
      `ROBINHOOD_RPC`, because forge counts a `vm.skip`'d test in its total;
      that was measured, not assumed.
      The count rose from 305 with the regression tests for the two contract
      defects in §5.2, the `genesisDuration` guard in §5.3, and
      `ToshV5Abi.t.sol` — three tests pinning `abis.ts` to the Foundry
      artifacts and five pinning the duck-typed cross-contract interfaces to
      the implementations that answer them (§5.7 explains why the latter are a
      test rather than an `is` clause).
- [x] Fork tests against the live V4 deployment — 8/8 green against Robinhood
      Chain mainnet, re-verified 2026-08-27 (§4.2). Foundry still reports these
      as SKIPPED rather than failed when `ROBINHOOD_RPC` is unset, but
      `test.yml` no longer lets that pass: on the canonical repository a missing
      secret, a zero-pass run, or a partial skip are each a hard failure, and the
      tolerance is scoped to forks. The secret is not set yet, so that CI step is
      red rather than falsely green, and this box means "verified by hand". The
      suite is unpinned, so it is a reading of the chain on a date rather than a
      reproducible artifact — §4.2 says why. To reproduce:

      ROBINHOOD_RPC=https://rpc.mainnet.chain.robinhood.com forge test --match-contract ToshV5ForkTest -vv
- [x] `forge fmt --check` clean — CI gate.
- [x] `forge lint` triaged, and now a CI gate. The 18 `block.timestamp`
      findings in `src/` stay accepted under §2.4. The 19 narrowing casts are
      no longer merely inventoried: §2.5 disposes of each one by what actually
      stops the truncation — 10 lossless by construction under a sign guard,
      3 by a revert in the same function, 1 unreachable past a compile-time
      constant, 3 by constants the suite pins, 1 by an invariant that is stated
      rather than enforced, and 1 by the size of the ETH supply. Only the
      invariant row asks the auditor to check a property rather than to
      re-read a nearby guard, and it says so.
      `scripts/checkLintFindings.mjs` pins the finding SET against
      `lint-baseline.json` by source text rather than by line number, and fails
      if §2.5's prose disagrees with the tool. Written because §2.5 had already
      drifted while its total still reconciled — the note in that section says
      how. Five mutations verified: a new cast, a cast removed, two-on-one-line
      becoming one, and a contradicting count each fail the build; pure line
      drift does not.
- [x] Slither run, output triaged into this document, and now a CI gate — 71
      findings across 66 contracts, every one dispositioned in §5.7. No code
      changed as a result; the findings that needed real verification are
      recorded with the reasoning rather than waved off, and the single High is
      noise.
      The gate is `scripts/checkSlitherFindings.mjs` against
      `slither-baseline.json`, Slither pinned to 0.11.6. Added on 2026-09-04
      because re-running the tool showed the section had gone stale in both
      available directions at once: the dark tax had added three
      `reentrancy-events` nobody had triaged, and the table had never summed to
      its own total because a detector was missing a row. Six mutations
      verified, including a detector losing its row and a new finding appearing
      in `src/`; pure line drift does not fail.
- [x] Frontend artifacts in sync (`scripts/extractAbis.js` produces no
        diff) — CI gate.
- [x] Frontend behaviour tests — 50 across five suites, covering the server
      code where §5.2–§5.4 found defects. Every suite mutation-tested against
      the original bug. CI gate via `npm test` in
      `.github/workflows/frontend.yml`. Scope and limits in §5.5.
- [ ] Audit branch frozen, commit hash written into §0
- [x] `lib/**` dependency commits pinned and listed for the auditor — §5.6.
      All four (plus the nested solmate) recorded with commit, date and release
      status; the compiled surface of each is enumerated. One drift corrected:
      solmate was checked out at `main` head rather than the revision v4-core
      pins.
- [x] `npm audit` clean at high/critical in `soat-frontend` — fixed 9 → 0, and
      held by the `npm audit --audit-level=high` job in
      `.github/workflows/frontend.yml`. See §5.1. Note the one gap in that
      gate: if npm's audit endpoint is unreachable the step warns and passes
      rather than failing, so a green run means "no advisories found OR the
      registry could not be asked". The step prints a `::warning::` in the
      second case; §5.1 records why it is not fatal.

### 5.1 Frontend dependency posture

Out of scope for the contract audit, but it is the other half of the attack
surface a user actually loads, so the state is recorded here rather than left
to `npm audit` output nobody reads.

**2026-08-26.** Nine advisories were open against `next@16.2.6`, all in the
range `>=16.0.0 <16.2.11`. Fixed by upgrading to `16.2.12` — the smallest
change that clears the range, chosen over npm's suggested `16.3.3` to keep the
pre-mainnet delta minimal.

Reachability of the nine in *this* app, checked rather than assumed:

| Advisory class | Reachable here? |
|---|---|
| Middleware / proxy bypass (Turbopack + single locale) | **No** — the app has no `middleware.ts` at all. |
| Server Action DoS / SSRF / unbounded edge payload / Server Function endpoint disclosure | **No** — no `'use server'` anywhere; the app uses Route Handlers, not Server Actions. |
| Image Optimization DoS via SVG | **No** — `ProjectLogo` renders a plain `<img>`; `next/image` is never imported, so the optimizer is not in any request path. |
| Cache confusion of response bodies for requests with bodies | **Plausibly yes** — `/api/projects`, `/api/sign-allocation` and `/api/admin/config` all take POST bodies. This was the one worth acting on quickly. |
| SSRF in rewrites via attacker-controlled destination hostname | **Worth noting** — Sentry's `tunnelRoute: "/monitoring"` is implemented as a rewrite, though to a fixed destination. |

The remaining transitive advisories (`postcss`, `sharp`, `js-yaml`,
`brace-expansion`, `nanoid`, `@babel/core`, `ws`) are pinned up through an
`overrides` block in `soat-frontend/package.json`, each to the lowest patched
version **within the same major** so nothing takes a breaking bump:

- `ws` was the only one on a runtime path at all, via `viem`. Even there the
  RPC transport is HTTP-only (`http()` / `fallback()` in `providers.tsx`) — no
  `webSocket()` transport exists in the app, so no socket is ever opened.
- `sharp` is an optional `next` dependency for image optimization, which this
  app never invokes (see the table above).
- The rest are build-time tooling: they process first-party CSS and config, not
  attacker input.

**Result: 9 → 0 advisories.** `npm audit --audit-level=high` now runs as its own
CI job so a regression is a red check, not a discovery.

**2026-09-04 — the gate no longer fails on npm's outages.** The job went red
because npmjs.org answered the audit endpoint with 503, which says nothing
about this tree. `npm audit` exits non-zero for both "found advisories" and
"could not look", and only the first is ours; a gate that goes red on someone
else's downtime is one people re-run without reading, which is how a real
regression would slip past it. The step now separates the two: findings stay
fatal, an unreachable registry emits a `::warning::` and passes. The cost is
stated plainly — a green run means "no advisories found OR the registry could
not be asked", so a run whose annotations carry that warning has not actually
checked anything.

> **Caveat worth stating.** `next` vendors some dependencies inside its own
> published tarball (`next/dist/compiled/**`). `overrides` cannot reach those,
> and `npm audit` cannot see them either. A clean audit means the resolvable
> tree is clean; it is not a claim about Next's vendored copies. Those move only
> when Next itself is upgraded, which is the actual reason to keep it current.

**Refresh, same day.** With the audit already clean, every dependency was taken
to the newest version inside its declared semver range — `next` 16.2.12 →
16.3.3, `viem` 2.48.11 → 2.55.19, `wagmi` 3.6.14 → 3.7.6, `@supabase/supabase-js`
2.105.4 → 2.112.4, plus `@tanstack/react-query`, `lucide-react`, `tailwindcss`
and the `@types/*` packages. Still 0 advisories, and `npm run verify`
(types, lint, four guards, production build) is green on the new tree. Taking
16.3.3 now also closes the vendored-copy gap the caveat above describes, which
the deliberately minimal 16.2.12 bump had left open.

Four packages were deliberately left behind, because each is a major with its
own migration and none of them is a security fix:

| Package | Held at | Latest | Why held |
|---|---|---|---|
| `typescript` | 5.9.3 | 7.0.2 | Major. Wants its own pass with the full `tsc --noEmit` surface. |
| `eslint` | 9.39.5 | 10.9.1 | Major; flat-config and rule-set changes, and `eslint-config-next` has to move with it. |
| `@types/node` | 20.19.43 | 26.3.0 | Should track the deployed Node runtime, not npm's latest. |
| `react` / `react-dom` | 19.2.4 | 19.2.8 | Pinned EXACTLY in `package.json`, which is a deliberate "do not float" — patch bumps here are a decision, not a refresh. |

### 5.2 Internal pre-audit review — found and fixed

Recorded here rather than in §6 on purpose: §6 belongs to the external auditor
and must keep saying "no audit has been performed" until one has been. This is
the self-review that precedes it. It is included because three of the four
defects below were invisible to the existing test suite in the same way — a
test asserted the property against the one code path that was correct — and an
auditor deciding where to spend their hours should know which parts of our
coverage have already been shown to mislead.

| # | Severity | Location | Defect | Regression test |
|---|----------|----------|--------|-----------------|
| 1 | High | `src/ToshLaunchpadHook.sol` `afterSwap` | Treasury buybacks skipped the same-block mint lockout stamp. | `ToshV5.t.sol::test_pokeBuyback_shutsTheSameBlockMintLockout`, plus `invariant_everySwapShutsTheMintLockout` |
| 2 | Medium | `src/ToshLaunchpadHook.sol` `_twapSqrtPriceX96` | The realised TWAP window had no upper bound on a quiet pool. | `ToshV5Attack.t.sol::test_probeB2_quietPoolTwapDoesNotFossilise` |
| 3 | High | `soat-frontend/src/lib/chain.ts`, `app/providers.tsx` | `process.env[name]` is never inlined, so every `NEXT_PUBLIC_*` override was silently ignored in the browser. | `scripts/checkPublicEnv.mjs` (CI guard) |
| 4 | High | `soat-frontend/src/app/api/projects/route.ts` | Project metadata could be written by anyone, so the displayed identity of a launch could be front-run. | Signature + on-chain receipt verification; see below |
**1 — buyback swaps were invisible to the mint gate.** `afterSwap` exempts
`sender == ladderTreasury` so the hook does not tax and recurse into its own
buyback. The exemption sat above `_lastSwapBlock = block.number`, so it skipped
the stamp as well as the tax. `pokeBuyback()` is permissionless, has no
cooldown, and performs a real swap, so any address could move spot repeatedly
inside one block with the hook recording nothing, then mint against the raised
`_safeReferencePrice()` ceiling in that same block. Measured: spot ×5.15 in one
block, `maxMintable` 0 → 100,800e18, mint executed. Fixed by moving the stamp
and the oracle write above the exemption; neither can recurse.

The coverage lesson is the part worth handing over. Five tests assert the
lockout and all five drive the pool with a router swap — the one sender that
was always stamped. The suite read as though the lockout was thoroughly pinned,
and the branch it could not reach was the broken one.

**2 — the TWAP window had no upper bound.** The header claimed a realised
window in `[TWAP_WINDOW, 2 × TWAP_WINDOW)`. The checkpoint rolls when a swap
arrives, never on the clock, so the true bound is the inter-trade interval —
measured at 608,400 s (7.04 days) on a weekly-traded pool, and a pool that
merely pauses for two windows already exceeds the stated ceiling. Because
`_buybackSqrtFloor` anchors every leg at `0.9 × twapSqrt`, a fossilised average
put the floor above spot and the treasury skipped every leg, with a measured
first fill on **day 105** — starving exactly the thinly traded token the
buyback exists to support. The mirror case after a drawdown leaves the band far
wider than `MAX_BUYBACK_SQRT_DEVIATION_BPS` names.

Clamping `span` was rejected as a fix: `delta` accumulates over the whole
period, so dividing it by a truncated span reports an average that never
occurred. Instead `_twapSqrtPriceX96` now short-circuits to `lastTick` when no
swap has landed for a full window, which is not an approximation — a flat
window's average is its price. Reaching that branch still requires holding a
price against arbitrage for a full window, the same assumption the oracle
already rests on.

`test_probeB_twapReanchorSpeed` could not see this: its fixture hand-feeds dust
swaps at `t0 + w` and `t0 + 2w + 1`, which is precisely the pattern that keeps
the window inside the documented bracket.

**3 — public environment overrides never reached the browser.** Two helpers
took a variable name and did `process.env[name]`. Next.js inlines `NEXT_PUBLIC_*`
by substituting the literal source text `process.env.NEXT_PUBLIC_FOO`, so a
computed access is never substituted and `process.env` is an empty object on the
client. Both helpers returned their fallback in every build ever shipped.

It passes types, lint and `next build`; it works under `next dev` and in every
route handler, because those run in Node against a real `process.env`; and the
fallbacks are the Base Sepolia addresses, so staging behaved correctly. The one
moment it would have surfaced is the mainnet cutover, where an operator
following PM-B4 would ship a bundle whose LP panel still encoded calls to a
Sepolia PositionManager. No runtime assertion can catch this — the value is
discarded at build time — so the guard is a source-level one.

**4 — project metadata was unauthenticated.** `POST /api/projects` accepted any
body. The row it writes is what the directory and project page render, and
`tx_hash` is unique, so no overwrite was needed: an attacker watching for
`LaunchCreated` could POST that hash first with their own site and links, after
which the real creator's request returned `{ duplicate: true }`. The page would
then serve attacker-controlled links under the real project's name, with
nothing on it looking wrong.

The route now resolves the txHash to its receipt, requires a successful
`LaunchCreated` log emitted **by the factory address**, and takes the token,
hook, name and symbol from that log rather than from the body. Authorisation is
a `personal_sign` recovered against the `creator` in the event, over a message
built by `src/lib/projectAttestation.ts` — one module imported by both the route
and the launch page, so the two halves of the scheme cannot drift. RPC failure
returns 503 rather than a 4xx, so "we could not check" is never filed as "the
caller lied".

### 5.3 Second sweep — Medium and below

The same review continued past the four defects in §5.2. Nothing here is a
contract issue that changes an auditor's threat model, and none of it is
exploitable for value; it is recorded so the delta between §5.2's commit and
the audit commit is legible rather than "assorted fixes".

| # | Severity | Location | Defect |
|---|----------|----------|--------|
| 5 | Medium | `api/sign-allocation`, `api/admin/config` | The owner-signed exchange-rate rotation was inert. |
| 6 | Medium | `api/projects/lookup` | The one route with no rate limit and no CORS, and a miss costs up to three RPC round-trips. |
| 7 | Medium | `app/lib/apiGuard.ts` `readJsonBody` | The body cap buffered the whole body before measuring it, and counted UTF-16 units rather than bytes. |
| 8 | Medium | `app/lib/apiGuard.ts` `clientIp` | The rate-limit bucket was keyed on the leftmost `X-Forwarded-For` entry, which the client supplies. |
| 9 | Medium | `ProjectTerminal/LiquidityPanel.tsx` | A second receipt watcher gated on `isSuccess`, so a reverted transaction ran the success path. |
| 10 | Low | `LiquidityPanel`, `UserDrawer`, `getProject`, `projectCache` | Unresolved and failed reads were coalesced into definite statements about the user's balance or a project's existence. |
| 11 | Nit | `ToshCloneLib.sol` | `genesisDuration` truncated to `uint32` with no range check, unlike the two caps beside it. |

**5 — the rate rotation controlled nothing.** The live Proof-of-Gas exchange
rate was a module-scoped `let` inside `api/admin/config/route.ts` with no
exported accessor, so `api/sign-allocation` — the only route that turns a rate
into a signed `maxAlloc` — could not read it and used the compile-time default.
The full owner-signature apparatus (nonce monotonicity, five-minute expiry,
`factory.owner()` recovery) therefore gated a variable whose only reader was the
matching GET. A rotation reported success, the GET echoed the new number, the
admin panel showed green, and no issued attestation changed.

It also drifted against the offline signer, which reads the live value via
`fetchGasToSatoRate`, so after any rotation the two signers issued different
`maxAlloc` for the same wallet — and raising the rate past
`factory.maxPogAllocationLimit` would make CLI-issued attestations revert
`ExceedsGlobalPogLimit` while web-issued ones kept working. Two comments
asserted byte-identical output and "lockstep"; both have been corrected in
place. The rate now lives in `app/lib/gasToSatoRate.ts`, shared through the same
Upstash store as the rate limiter, because a rotation that lands on one instance
is the same failure one layer down.

**8 — the rate limit was one header away from off.** `X-Forwarded-For` is
appended to by each hop, so the leftmost entry is whatever the client claimed.
Behind a proxy that appends rather than overwrites — nginx with
`proxy_add_x_forwarded_for`, or any direct-to-Node deployment — a fresh random
value per request meant a fresh full bucket per request, including on
`/api/sign-allocation`. Not exploitable on Vercel or Cloudflare, which normalise
the header; the point is that the limiter's correctness silently depended on the
deploy target. Platform headers are now preferred, and XFF is counted from the
right by `RATE_LIMIT_TRUSTED_PROXY_HOPS`.

**10 — the UI stated pending reads as facts.** A cluster rather than one bug,
and the shared shape is `?? 0n` / `?? false` on a read that has not landed: a
funded LP was told "the wallet holds 0", a depositor on a launched project was
shown no claim when one `useReadContracts` leg failed, and an RPC outage
rendered "No launch at this address" for a real, funded project. Each is now
either gated behind an explicit blocker, marked degraded, or — for the lookup
route — separated into `found` / `not-found` / `unavailable` so a 503 cannot be
displayed as a denial.

**11 — `genesisDuration` truncated in silence.** Not exploitable: the hook
rejects any duration outside its three rungs, and `hookInitcodeHash` truncated
identically so the predicted and deployed addresses agreed. It is recorded
because `initcodeHash` is a public view the frontend mines salts against, and
two durations hashing the same means a caller can mine against a value the
launch will not commit to with nothing saying so. Now
`DurationTooLargeToPack`, matching the `CapTooLargeToPack` guard on the two
caps beside it. Pinned by
`ToshHookClone.t.sol::test_genesisDurationAboveUint32Reverts`, which asserts
the deploy path and the hash path separately.

**Considered and deliberately not changed.** Exact-output swaps realise 99.0 bps
of the trader's total outlay where exact-input realises 100 — the exact-input tax
is inclusive of the specified amount, the exact-output tax is charged on top of
the pool's input. Closing the basis point means grossing up by
`100 / (10_000 - 100)`, which buys little and leaves `TAX_BPS` meaning something
other than what it says. The choice is now stated in the natspec on `TAX_BPS` so
it reads as a decision rather than an oversight. The gap was 0.5 bps while the
rate was 70; it widened to 1 bps when the rate went to 100, because it is
second-order in the rate itself. Still below the threshold where it earns the
division.

---

### 5.4 Third sweep — the chain the server was actually talking to

Found by exercising §5.3's fixes against a running instance rather than reading
them. `/api/projects/lookup` answered `503 unavailable` for an address that
plainly exists on the local devnet. The three-state return was working exactly
as designed; what it had surfaced was that the server was reading a different
chain than the one it was configured for.

| # | Severity | Location | Defect |
|---|----------|----------|--------|
| 12 | High | `api/projects`, `api/admin/config`, `app/lib/getProject.ts`, `app/lib/onchainNonce.ts` | Endpoint chosen by a Sepolia-biased expression while the client was bound to `targetChain`, so a mainnet build could authenticate against Sepolia. |
| 13 | Medium | `app/providers.tsx` | Same selection bug in the browser transport, where `rank: true` can actively prefer the wrong-chain leg. |
| 14 | Medium | `app/lib/getProject.ts` | The chain fallback threw on every devnet lookup: viem's `foundry` chain declares no Multicall3 and anvil predeploys none. |
| 15 | Nit | `.env.production.example` | The mainnet cutover sheet told the operator to set a Sepolia-named variable to an Ethereum-mainnet URL. |

**12 — the listing authentication in §5.2 was only as strong as the chain it
read.** Four modules picked an endpoint themselves, all with the same shape:

```
process.env.BASE_SEPOLIA_RPC
  ?? process.env.NEXT_PUBLIC_BASE_SEPOLIA_RPC
  ?? 'https://sepolia.base.org'
```

paired with `createPublicClient({ chain: targetChain, … })`. The chain bound to
the client and the chain its transport reached were chosen by different
expressions, and nothing kept them agreeing. A mainnet deployment that sets no
RPC at all reads Base Sepolia, because that is the hardcoded default; one that
carries a `BASE_SEPOLIA_RPC` in the deploy shell does the same, and Next's env
loader will not override an already-present variable, so `.env.production`
loses that race in silence. This machine was in exactly that state, which is
what produced the 503.

`POST /api/projects` decodes `LaunchCreated` from a transaction receipt and
treats the creator in it as the authority for a directory listing. Read that
receipt on the wrong chain and the check still passes honestly — the caller
really is the creator of that launch, and the signature really does verify —
but the launch is a *Sepolia* launch, minted for free, and the row lands in the
mainnet directory carrying attacker-chosen links. That is the phishing vector
§5.2 closed, one chain over and cheaper to mount. `api/admin/config` reads
`factory.owner()` the same way, and `onchainNonce` signs PoG attestations
against a nonce fetched the same way.

Selection now lives in `app/lib/serverRpc.ts`, which binds chain and transport
together and cannot return an endpoint for a chain other than the one asked
for: a variable whose name commits it to a chain is consulted only when that
chain is the target, and every fallback is keyed by chain id.
`NEXT_PUBLIC_RPC_URL` names no chain and remains the universal override. That
makes the mistake unrepresentable given correct values, but not given a wrong
value under a right name, so the two call sites whose answer *authorises*
something — the listing receipt and the admin owner check — additionally assert
`eth_chainId` against `targetChain.id` and fail closed. `scripts/checkServerRpc.mjs`
pins both halves in CI; it was mutation-tested by reintroducing the original
expression, which it rejects on both counts.

**14 — the fallback nobody could have tested.** `client.multicall` does not
degrade per call when the chain has no Multicall3: it throws before issuing
anything. viem's `foundry` chain declares none and anvil does not predeploy
one, so every chain-fallback lookup failed wholesale on the devnet — the one
environment where this path is routinely exercised, since staging has a
populated registry that answers first. Before §5.3 it surfaced as a confident
`404 No launch at this address`; after, as a `503`. Two plain reads replace the
batched one, which costs a round trip on two calls and works on every chain.
All four states are now confirmed against a live instance: `200` for a real
launch by token and by hook address, `404` for a well-formed absent address,
`400` for a malformed one, and `503` only when the chain genuinely cannot be
reached.

**Verified rather than reasoned about.** §5.3's `clientIp` change was also only
typechecked, so it was exercised the same way: 100 concurrent requests carrying
100 distinct spoofed leftmost `X-Forwarded-For` values shared one bucket and
were throttled, while 100 distinct proxy-appended hops each received their own
and none were.

### 5.5 The frontend now has a test suite

The finding in §5.4 was not subtle, and three sweeps of reading missed it. It
surfaced within minutes of pointing `curl` at a running instance. The
generalisable part is that `tsc`, `eslint` and `next build` all pass on a
server that is talking to the wrong chain — the property is invisible to every
check the frontend had, because all of them are static and the value is read
from the environment at module load.

Until now `soat-frontend` had no test runner and no test files at all; the five
`check*.mjs` guards are source-text checks, which pin "nobody may write this
expression again" but say nothing about behaviour. So everything verified by
hand in §5.4 was verified exactly once and nothing held it.

Vitest, in a Node environment because everything covered is server code. 47
tests over five suites:

| Suite | Pins |
|---|---|
| `app/lib/serverRpc.test.ts` | An endpoint returned for chain X belongs to chain X, chain-named variables are inert off their chain, and a client's `chain` and `transport` always agree. |
| `app/lib/apiGuard.test.ts` | A caller cannot obtain a private rate-limit bucket by choosing a header, genuinely distinct callers still get their own, and the body cap is bytes enforced during the read. |
| `app/lib/getProject.test.ts` | `not-found` and `unavailable` stay distinct, and no name or `created_at` is ever fabricated. |
| `api/projects/lookup/route.test.ts` | The three states become 200/404/503 with the right `Cache-Control`, and a malformed address costs no RPC call. |
| `api/projects/route.test.ts` | The registry query carries a deadline and the deadline stays short; an unreachable registry is 503 and uncacheable, while an empty one is still a cacheable 200 (§5.8). |

Every suite was mutation-tested: the original defect was reintroduced into the
production file and the tests were confirmed to fail, then the file restored.
Reverting `clientIp` to the leftmost `X-Forwarded-For` entry fails three tests
in both directions at once — the spoofer stops being throttled *and* distinct
clients start sharing a bucket, which is why both assertions exist, since a
fix that merely ignored the header would satisfy either one alone. Reverting
the body cap to a UTF-16 count fails the astral-plane case. Collapsing
`unavailable` into `not-found` fails three. Making chain-named variables global
again fails eight of twelve.

Two of those tests were themselves fixed after failing to discriminate. The
byte-cap fixture originally sent a string body, which makes undici set
`Content-Length`, so the route's fast path returned 413 before the meter ran
and the test passed against the bug it was written for; it now streams a body
with no declared length, and throws if the header appears. The suites are wired
into `npm run verify` and the frontend CI job, and both `check*.mjs` guards now
skip `*.test.ts` — a test naming an endpoint as its expected value is not a
module choosing one, and a template variable that only a test mentions is still
one no shipped code reads.

What this does not cover: React components, the wallet transaction paths, and
the remaining API routes. These suites are where §5.2–§5.4 and §5.8 actually
found bugs.

### 5.6 Vendored dependencies — exact revisions

Reproduce this tree with:

    git submodule update --init --recursive

| Path | Commit | Date | Release? |
|---|---|---|---|
| `lib/forge-std` | `620536fa5277db4e3fd46772d5cbc1ea0696fb43` | 2026-04-29 | **yes** — `v1.16.1` |
| `lib/openzeppelin-contracts` | `8b010f923a0f81599a3f8bab309a47ec99c62764` | 2026-05-07 | no — `master` head |
| `lib/v4-core` | `46c6834698c48bc4a463a86d8420f4eb1d7f3b75` | 2026-04-02 | no — 21 commits past `v4.0.0` |
| `lib/v4-periphery` | `9dafaaecc1e2e1e824eda9d941085f96517d827b` | 2026-04-02 | no — `main` head |
| `lib/v4-core/lib/solmate` | `4b47a19038b798b4a33d9749d25e570443520647` | (nested) | no — pinned by v4-core |

Remotes are the canonical upstreams in `.gitmodules`: `foundry-rs/forge-std`,
`OpenZeppelin/openzeppelin-contracts`, `Uniswap/v4-core`,
`Uniswap/v4-periphery`, and `transmissions11/solmate` beneath v4-core.

**Three of the four are not releases.** Only `forge-std`, which is test-only,
sits on a tag. The two Uniswap dependencies and OpenZeppelin are pinned to
branch commits, so "we use v4-core v4.0.0" would be wrong by 21 commits and
there is no version string to compare against an advisory feed. The commits
above are the only meaningful identifiers.

**What is actually compiled.** 125 sources reach the build; most of each
dependency does not. Review scope, by origin:

| Origin | Files in the compile graph |
|---|---|
| `src/` (Tosh) | 7 |
| `test/` (Tosh) | 14 |
| `lib/v4-core/src` | 49 |
| `lib/openzeppelin-contracts` | 27 |
| `lib/forge-std` | 20 |
| `lib/v4-periphery/src` | 1 |
| solmate | 1 (`src/auth/Owned.sol`) |

The OpenZeppelin surface is the conventional one — `Ownable`/`Ownable2Step`,
`AccessControl`, `ERC20` + `SafeERC20`, `Pausable`, `ReentrancyGuard`, `ECDSA`
+ `MessageHashUtils`, `Math`/`SafeCast`/`SignedMath`, and their interfaces.
Nested copies of forge-std and OpenZeppelin exist under `lib/v4-core/lib/` but
compile nothing: the top-level remappings in `foundry.toml` win, so there is
exactly one version of each in the build.

**One drift found and corrected.** `lib/v4-core/lib/solmate` was checked out at
`89365b88` (`main` head) while v4-core pins `4b47a190`, and the pinned commit
had never been fetched — the submodule had been cloned at the branch tip rather
than at the recorded revision. So this working tree was not what its own
recorded state describes, and an auditor running the command above would have
built something different from what was tested here.

Impact was nil, but only checkably so. Exactly one solmate file enters the
graph, `src/auth/Owned.sol`, reached through `PoolManager`/`ProtocolFees`; the
delta between the two revisions in that file is one line, the SPDX identifier
(`AGPL-3.0-only` → `MIT`). No Tosh-deployed contract imports solmate at all.
The submodule has been restored to `4b47a190` and the suite re-run from a
forced rebuild: 320/320, including the hook-bytecode sync test.

**Benign noise an auditor will otherwise chase.** `git status` inside
`lib/forge-std` and `lib/openzeppelin-contracts` reports ~21 modified files.
Every one is a `100755 => 100644` mode change on a `.py`, `.js` or `.sh` file
from a Windows checkout that cannot represent the executable bit. No `.sol`
file in any dependency differs from its upstream commit — verified with
`git status --porcelain -- '*.sol'` across all four, which is empty in each.

### 5.7 Slither triage

```
slither --version   # 0.11.6
slither . --filter-paths "lib/|test/|script/" --json slither.json
node scripts/slitherTriage.mjs --full
```

66 contracts, 102 detectors, **71 findings**. The JSON is ~8.6 MB and gitignored;
regenerate it with the command above. `scripts/slitherTriage.mjs` groups a run
by impact and detector, which is the form worth re-reading: on a later run the
signal is a count that moved, not the seventeenth `timestamp` note.

**Re-run 2026-08-27**, after `PIGGYBACK_MIN_GAS` changed and `_nextSpendAmount`
became `virtual` (`ROBINHOOD_MIGRATION.md` §F.7). Identical to the run before
it — the expected result for a constant and a keyword, recorded only so the
next re-run had a dated baseline to move against.

**Re-run 2026-09-04, and it had moved.** 71 findings, 1 high / 24 medium /
27 low / 19 informational, across 66 contracts. Two defects surfaced, and only
one of them is about the code:

- **The dark tax went in untriaged.** `_skimInputTax` landed after the
  2026-08-27 run, and Slither reads it as three `reentrancy-events`. Nobody
  re-ran, so a new function on the money path sat in the audit package with
  nothing said about it. The claim this section exists to make is "every
  finding has been looked at", and that claim expires on the next commit unless
  something re-checks it. Dispositioned below.
- **The table never summed to its own total.** Its rows came to 68 against a
  prose figure of 70, because `low-level-calls` had no row at all. The impact
  split counted those two findings, the table did not, and nothing compared the
  three summaries of one run against each other. Also below.

Both are now held by `scripts/checkSlitherFindings.mjs`, a CI gate against
`slither-baseline.json`. It keys each finding by (detector, file, enclosing
scope) rather than by line, so code motion is invisible to it, and it fails if
a row below disagrees with the run, if the prose totals disagree, or — the
check that would have caught `low-level-calls` — if any detector fires without
some row naming it. Slither is pinned to 0.11.6 there and here, because
detector counts move between releases and a baseline against an unstated
version means nothing.

**Nothing here changed the code.** That is a claim worth being suspicious of,
so the findings that could plausibly have been real are written up with the
verification, and the reason the reentrancy cluster is structurally invisible
to Slither is stated rather than assumed.

| Detector | Impact | n | Disposition |
|---|---|---|---|
| `weak-prng` | High | 1 | False positive — floor-division rounding, no randomness. Below. |
| `incorrect-equality` | Medium | 5 | False positive — all are `== 0` guards, with no manipulable intermediate. |
| `reentrancy-no-eth` | Medium | 3 | False positive — guarded, but by mechanisms Slither does not model. Below. |
| `unused-return` | Medium | 8 | Accepted — V4 `settle`/`initialize`/`getSlot0` returns genuinely unneeded; `modifyLiquidity` destructures the delta it uses and drops `feesAccrued`, zero on a fresh position. |
| `uninitialized-local` | Medium | 6 | Accepted — loop accumulators (`filled`, `cost`, `sold`, `legs`) whose intended initial value is zero. An explicit `= 0` costs gas and says nothing. |
| `divide-before-multiply` | Medium | 2 | Reviewed against real magnitudes, bounded, not changed. Below. |
| `timestamp` | Low | 17 | Already inventoried in §2.4 — the genesis clock and the TWAP window, both intentionally wall-clock. |
| `reentrancy-events` / `reentrancy-benign` | Low | 8 | Accepted — event ordering only; no state a caller can observe or act on. Three of the eight are the dark tax and are new since 2026-08-27. Below. |
| `calls-loop` | Low | 2 | Accepted — the piggyback loop is bounded by `LEGS_PER_POKE` and every leg is `try/catch` fault-isolated. |
| `assembly` | Info | 9 | Expected — transient-storage mutex, hook-address bit checks, clone initcode. |
| `missing-inheritance` | Info | 3 | Accepted — the three interfaces are consumed cross-contract; declaring inheritance adds a vtable for nothing. |
| `low-level-calls` | Info | 2 | Accepted — the two identical `_sendEth` helpers. Deliberate, and the alternative is worse. Below. |
| `naming-convention`, `too-many-digits`, `cyclomatic-complexity` | Info | 5 | Style. `_PIGGYBACK_SLOT`'s literal is a namespaced transient slot, meant to be unreadable as a number. |

**`weak-prng` (High) is the detector firing on a `%` inside a condition.**

```solidity
if (delta < 0 && (delta % int56(uint56(span)) != 0)) avgTick--;
```

That is the floor-division correction from Uniswap V3's `OracleLibrary`.
Solidity truncates toward zero, so a negative cumulative delta must be adjusted
down by one tick or the TWAP is biased upward — and upward is the direction
that matters, since this TWAP is the buyback floor. No randomness, and nothing
a proposer can influence beyond the tick history already covered under
`timestamp`. The highest-impact finding in the run is therefore noise.

**The three `reentrancy-no-eth` findings are each guarded, for different
reasons.** Worth spelling out, because the reason Slither misses them differs:

- `ToshFactory.createLaunch` is `nonReentrant`, and both callees
  (`ToshToken.initialize`, `hook.initializeToken`) are contracts the factory
  itself just CREATE2-deployed. With no attacker-controlled callee on the path,
  the late `nameTaken[nameKey] = true` is unreachable as a double registration.
- `ToshLaunchpadHook.launch` is `nonReentrant`. Its callees are the project
  token and the V4 `PoolManager`, whose `unlock` re-enters this hook's own
  `unlockCallback`. The cross-function partner Slither names, `deposit`, is
  indeed not `nonReentrant` — but reaching it needs a callee willing to call
  it, and this path has none.
- `ToshLadderTreasury` does not inherit `ReentrancyGuard` at all, which is why
  this one deserved the closest look. Its mutex is transient storage:
  `_setPiggyback` / `piggybackActive` are `tstore` / `tload` on
  `_PIGGYBACK_SLOT`, `pokeBuyback` reverts `PiggybackInProgress` while it is
  set, and `_runPiggyback` returns early on it. The flag is raised before the
  loop, so the `currentCursor` write happens under it. Slither's reentrancy
  detectors model storage, not transient storage, and cannot see the guard.

  **Handoff note.** Every reentrancy finding against `ToshLadderTreasury` is a
  finding against that flag, so the property to attack is whether
  `_PIGGYBACK_SLOT` can read clear while a leg is still in flight. Note also
  that the treasury's safety leans on every callee being either the
  `PoolManager` or an owner-curated Tosh token: the ladder is `onlyOwner`, so
  admitting a non-Tosh ERC20 would put an attacker-controlled callee inside the
  loop, and the transient flag is then the only thing between that and
  `currentCursor`.

  **Coverage gap on that flag — found while re-checking this section on
  2026-08-27, closed on 2026-09-04.** The mutex has two layers and the suite
  only reached one. Ladder tokens are themselves Tosh tokens, so every leg in
  `test_treasuryPiggybackRoundRobin` and `test_piggyback_isolatesAFaultyLadderLeg`
  swaps through another Tosh pool and exercises the OUTER layer — the hook
  reading `_piggybackActive()` in `beforeSwap` / `afterSwap` and going passive.
  That layer returns before it ever pokes the treasury, so `_runPiggyback`'s own
  `if (piggybackActive()) return;` was reached by no test at all.

  It is defence in depth rather than dead code, and it is the layer that matters
  precisely in the non-Tosh-callee scenario above, where the outer layer does not
  exist — so the untested line was the one guarding the case this section itself
  identifies as the dangerous one. The note used to end "not constructible from
  the current fixtures". It is constructible by etching:
  `registeredHooks` is keyed by ADDRESS, not by code, so replacing a listed
  hook's code models a listing that goes bad without forging a registration,
  which is also the honest threat model given `addLadderToken` is `onlyOwner`
  and checks provenance.

  `test_piggyback_innerMutexHoldsAgainstAReentrantLadderHook` now does that: a
  listed hook whose `beforeSwap` calls `autoPiggybackBuyback` from inside the
  leg it is being paid by. It asserts the re-entry happened exactly once, that
  the leg still bought and burned, that only one `PiggybackExecuted` was
  emitted, and that the flag is clear on the way out.

  Two mutations verified, and what they produce is worth recording because it
  is not the obvious answer. Deleting the guard, and separately inverting it,
  does not merely permit a second cycle: the nested call re-reads the unchanged
  cursor, swaps the same pool, re-enters `beforeSwap` again, and recurses until
  the leg dies — at which point `try`/`catch` swallows the whole thing as
  `BuybackSkipped`. Nothing is bought and the hostile hook's own counter rolls
  back with the leg. **A single bad listing would turn every poke into a no-op
  for the token at the cursor, and the round-robin would never get past it.**
  That is the cost of the missing line, and it is larger than "an event fires
  twice".

**The three new `reentrancy-events` are the dark tax, and they are log
ordering.** All three are in `ToshLaunchpadHook._skimInputTax`, and all three
say the same thing: a `poolManager.take` precedes the event that reports it.

| Recipient of the `take` | Event emitted after |
|---|---|
| `ladderTreasury`, currency0 | `BuyTaxToTreasury` |
| `platformFeeRecipient`, currency0 | `PlatformSwapFeePaid` |
| `DEAD_ADDRESS`, currency1 | `SellTaxBurned` |

The events are telemetry. Nothing on chain reads them, and no state is written
after the calls, so re-entering reorders logs and does nothing else — the same
disposition the other five in this cluster carry.

What deserves an auditor's time at this site is not the log ordering, and §2.4
already names it: `platformFeeRecipient` is paid by a raw `take` on a path with
no `try`/`catch`, so a recipient that reverts on receipt bricks every buy on
every pool. Slither does not report that. It is why PM-C9 exists, and why
`test/ToshV5.t.sol` now pins both ends of it — a Safe-style recipient costs
29,944 gas and passes, a reverting recipient fails the buy.

**`low-level-calls` — the two `_sendEth` helpers, deliberate.**

```solidity
function _sendEth(address to, uint256 amount) internal {
    (bool ok,) = payable(to).call{value: amount}("");
    if (!ok) revert EthTransferFailed();
}
```

Byte-identical in `ToshFactory` and `ToshLaunchpadHook`. Eight call sites
between them — refunds, referral claims, change, and fee routing — spread over
five functions (`refund`, `launch`, `claimReferralReward`, `mintBondingCurve`,
`createLaunch`), every one of them `nonReentrant`.

The detector fires on the `.call` itself, and both alternatives it implies are
worse here: `transfer` and `send` cap the callee at 2 300 gas, which this
repository has measured as too little for a Safe-style recipient. Using either
would mean the platform treasury could not be a Safe, which is the arrangement
PM-C9 settled on.

Two things the detector cannot see. The boolean **is** checked, and reverts
with `EthTransferFailed`. The return data is dropped on purpose: there is
nothing to interpret, and bubbling it would let a hostile recipient choose this
contract's revert reason. What remains is that the call forwards all remaining
gas, and that exposure is held by the `nonReentrant` above rather than by
anything at this line.

**`divide-before-multiply` in `launch()` — reviewed against real magnitudes,
deliberately left alone.**

```solidity
p0      = (lpEth * 1e18) / GENESIS_LP_SUPPLY;   // GENESIS_LP_SUPPLY = 3_780_000e18
shelfP0 = (p0 * SHELF_PREMIUM_BPS) / BPS_DENOMINATOR;
```

`p0`'s truncation is carried into `shelfP0`. Concretely `p0` reduces to
`lpEth / 3.78e6`, so a 1 ETH raise gives `p0 ≈ 2.65e11` and the lost sub-unit
is a relative error near `4e-12`; larger raises shrink it further, and
`require(p0 > 0)` blocks the degenerate end. Pushing the relative error even to
`1e-6` would need `lpEth ≈ 3.78e12` wei, far below any soft cap.

Folding it to `lpEth * 1e18 * SHELF_PREMIUM_BPS / (GENESIS_LP_SUPPLY *
BPS_DENOMINATOR)` removes the double truncation, and is the change to make if
this file is opened for another reason. It is not worth making on its own:
`shelfP0` feeds the ladder base price, so the edit changes
`ToshLaunchpadHook`'s deployed bytecode, which moves the implementation address
on redeploy and so changes `hookInitcodeHash` and every salt mined against it.
A bytecode change and a re-mine against a `1e-12` price rounding, immediately
before an audit freeze, is the wrong side of that trade.

The second instance — `perToken * count` in `_runPiggyback`'s
`PiggybackExecuted` — is not a defect: `count` legs each received `perToken`,
so the product is what was actually committed. Emitting `spend` would be wrong,
since the remainder stays in the reservoir.

### 5.8 Fourth sweep — what an unreachable registry costs

Opened by a report that the site "keeps erroring". The dev server log had two
distinct signatures in it, and only one of them was real. Both are recorded,
because separating them was most of the work.

**Real: a Supabase call had no stopping condition.** Severity: Medium
(availability). supabase-js ships no default timeout *and* retries four times
with backoff. Measured against a host whose TLS handshake was being reset —
each attempt failed in ~1.65 s, and the call settled after **13.9 s**:

| Call site | Ceiling before | Behaviour |
|---|---|---|
| `getProject` → registry read | `Promise.race` vs `setTimeout`, 1.2 s | Bounded the *wait*, not the query. The four-attempt chain kept running behind an answer nobody was reading. |
| `GET /api/projects` | none | 500 after 14 s, on every request. |
| `POST /api/projects` | none | Could hold the publish step open for 14 s with the user's launch already mined and their gas already spent. |

The fix is `.abortSignal(AbortSignal.timeout(…))` on all three, which bounds the
operation rather than the wait on it; measured settling at 1200 ms and 3003 ms
against those deadlines exactly. `GET /api/projects` went from **14,047 ms to
1,254 ms**.

A per-request timeout in `global.fetch` was tried first and is worth recording
because it looked right and did nothing: every individual attempt failed well
inside it, and the time was going into the retry chain *between* attempts. That
is the whole reason this needed measuring rather than reasoning — the obvious
fix targeted the wrong layer, and would have shipped looking like a fix.

The status code changed with it. `GET /api/projects` returned **500**, which
says "your request was bad"; the request was fine and the dependency was not.
It now returns **503** with `Cache-Control: no-store` and `Retry-After: 5`,
matching the distinction `lookup` already draws between 404 and 503 — and
`no-store` matters, or one CDN edge holds a five-second outage for every
visitor behind it.

Guarded by `scripts/checkSupabase.mjs`, wired into `guards`, CI and
`precheck.ps1`. A source guard rather than a test because the defect was not a
wrong value anywhere — it was a question two of three call sites never asked,
and the fourth one added will not ask it either. Six behaviour tests in
`api/projects/route.test.ts` pin the rest; all were mutation-tested by
reverting each fix in the production file (503→500, deadline removed, deadline
widened to 12 s) and confirming the suite goes red.

**Not real: the `removeChild` crashes were the inspection tool.** The log was
full of `NotFoundError: Failed to execute 'removeChild'` reaching the global
error boundary — the black "Console offline." page — preceded by a React
hydration mismatch pointing at `AgentDirectoryHome.tsx:120`. The codebase
already carries five separate `ssr: false` workarounds with `removeChild` in
their comments, so a sixth cause would have been an easy story to believe.

The hydration diff named the mismatched attribute: `data-cursor-ref="e5"`,
injected into the DOM by the browser-automation snapshot used to inspect the
page. Loading the same routes without it produces no hydration warning and no
`removeChild`, on every route. Nothing was changed for this, and the five
existing workarounds were left alone — they predate this and may well have had
the same cause, but that is a separate question from the one asked here.

**Also not the app: the dependency was unreachable for an environment reason.**
`fkrkxqrkilmmqxbfvajk.supabase.co` resolved to `198.18.0.7`, inside the RFC 2544
benchmarking range that local proxies use for fake-IP DNS; the dev server was
bound to `198.18.0.1` from the same mechanism. TCP connected and TLS was reset.
That is a proxy on the development machine, not a defect — but it is what made
the missing deadline visible, and a real Supabase incident would present
identically in production.

---

### 5.9 Fifth sweep — the misconfiguration with no symptoms

Found while pointing the frontend at the freshly deployed 46630 factory for the
first time. Not a vulnerability; it is recorded because the cost of the failure
is entirely in diagnosis, and because it is the second occurrence of a class the
first fix was supposed to have closed.

The admin console rendered every single on-chain readout as an em dash. Nothing
else was wrong with it: no console error, no error boundary, no failed request,
and the RPC answering HTTP 200 to roughly 150 calls. The page was
indistinguishable from a correct console pointed at a chain where nothing has
happened yet.

`NEXT_PUBLIC_FACTORY_ADDRESS` was exported in the shell that started the dev
server. Next's loader skips any key already present in `process.env`, so
`.env.local` never applied and editing it changed nothing. Reads went to an
address holding no code, returned `0x`, decoded to `undefined`, and each panel
rendered its empty state. Diagnosing it needed RPC calldata dumped to notice the
`to:` field was an address nobody had configured. The one legible clue was an
asymmetry on the same page: `NEXT_PUBLIC_LADDER_TREASURY` was *not* shadowed, so
the treasury address rendered correctly while the factory did not.

The existing defence could not fire. After the first occurrence `contracts.ts`
gained a shape check rejecting the precompile range, which is where that
incident's value (`0x00…01`) fell. This one was `0x11…11` — the placeholder
`.github/workflows/frontend.yml` and `scripts/runTsGuard.mjs` deliberately set
so a checkout with no deployment can prerender. Widening the regex is therefore
unavailable: CI depends on that exact value being accepted. Shape was the wrong
property to test.

Two guards, because the two questions are answerable at different times.
Provenance is decidable before the server starts: `scripts/checkEnvShadow.mjs`
runs from `predev`, compares the keys `.env.local` actually declares against the
ambient environment, and refuses to start on a conflict, naming the variable and
the command that clears it. It exits silently where there is no `.env.local`, so
CI and production builds are untouched. Presence of code is only answerable
against a live chain, so `components/FactoryGuard.tsx` does one `eth_getCode`
and renders a strip when the answer is empty; it treats a transport error as no
verdict rather than an alarm, so a rate-limited public endpoint cannot raise a
false alarm. It is a strip rather than a block deliberately — a visitor to a
project page cannot fix a deployment, and the public pages degrade into empty
states that look exactly like a quiet chain.

Both were verified in both directions: the strip appears for `0x11…11` and stays
absent for the real factory, and the startup guard fails on a shadowed key,
passes on a clean shell, honours `TOSH_ALLOW_ENV_SHADOW=1`, and exits 0 with no
`.env.local` present so the CI workflow's job-level variables stay in charge.

The same session cross-checked the whole console against `cast` on 46630 —
launch fee, soft cap, PoG ceiling, both durations, owner, signer and the live
initcode hash all agree — and confirmed the project page reads a real launched
project entirely from chain, with no registry involved.

---

### 5.10 Sixth sweep — two fixes that reopened what they closed

A parallel review of the off-chain surface, run 2026-09-04. Its two High
findings share a shape worth naming, because it is the shape a checklist is
blind to: both sit in code written *specifically* to fix an earlier version of
the same bug, both carry a header comment that accurately describes the original
attack, and both had a passing test whose assertion pointed the wrong way. The
box was ticked, the reasoning was written down and correct, and the defect
survived underneath it.

**H-1 · The rate limiter still let a caller choose its own bucket.**
`clientIp` in `app/lib/apiGuard.ts` keys every bucket, including the one in
front of `/api/sign-allocation`. Its previous defect — trusting the leftmost,
caller-supplied `X-Forwarded-For` entry — was fixed by preferring "platform
headers the edge sets itself and strips from client input", listed as
`cf-connecting-ip`, `x-vercel-forwarded-for`, `true-client-ip`, and consulted in
that order.

A header is only unspoofable if the edge that sets it is in front. This app
deploys to Vercel and nothing else: `.vercel/project.json` names the project,
and there is no `vercel.json`, no `wrangler.toml`, no `_headers`, and no
Cloudflare configuration anywhere in the tree — `cf-connecting-ip` appears in
exactly two files, `apiGuard.ts` and its test. Vercel does not set, strip, or
overwrite Cloudflare's headers, so `cf-connecting-ip` arrived verbatim from the
caller *and* was consulted first, ahead of the one header that is genuinely
trustworthy here. One extra header per request bought a fresh full bucket on
every route: the identical defect, one header over.

The test could not fire. `prefers a platform header over anything in
X-Forwarded-For` held `cf-connecting-ip` **constant** and varied XFF, so it
asserted precedence — which is true, and is exactly what made the bypass
invisible. The attacker-controlled input was the fixture.

Fixed by making trust a deployment fact rather than a code guess.
`x-vercel-forwarded-for` is preferred outright; other edges' headers are read
only when `RATE_LIMIT_EDGE` names the edge that sets them, and unset means
nobody, which is the true answer here. Nothing at request time distinguishes
"Cloudflare wrote this" from "the caller typed it", so inference is not
available and was not attempted. Two tests replace the one: the bypass case now
varies the attacker-controlled header and requires throttling, and its mirror
requires that a deployment genuinely behind Cloudflare can still say so rather
than pooling every visitor into one bucket.

**H-2 · One creator signature authorised unlimited rows for one launch.**
`POST /api/projects` validates `txHash` against `/^0x[0-9a-fA-F]{64}$/` and
inserted it in whatever casing arrived. Uniqueness of `(chain_id, tx_hash)` is
what the route leans on for "one launch, one row", and Postgres compares `text`
byte for byte — so a hash with *k* hex letters had 2^k spellings, each a
distinct key naming one transaction.

What made that reachable rather than untidy is the signing side.
`lib/projectAttestation.ts` lowercases the hash before building the message, so
one genuine signature from the real creator validates against every casing of
their own hash. An attacker who watched any creator publish once could replay
that creator's own signature with the hash recased and own a second row for the
same launch. The directory renders every row it gets back. That is precisely the
squat the file's own header describes and claims to have closed: "keyed by a
txHash that can only ever be inserted once, so a replay reproduces a row that
already exists." The claim was load-bearing for the decision to omit a nonce.

Fixed by canonicalising immediately after validation, before the chain read, the
message build, the log line and the insert. Lowercase rather than an arbitrary
choice: it is what the signed message already uses, what `viem` returns from
`getTransactionReceipt`, and what existing rows hold.

**Alongside them**, `GET /api/projects` was an unauthenticated, uncached
`select('*')` with no ceiling, returning whole rows including free-text
`description`. It is the multiplier that turned H-2 from defacement into
availability loss — response size was a function of how many rows anyone had
managed to insert, and `REGISTRY_READ_DEADLINE_MS` converts a large enough table
into a 503 for every visitor rather than a slow page. Now capped at 500 rows,
sized as a bound on the failure and not as a paging scheme; a directory that
legitimately approaches it needs real pagination and should not find that out by
silently dropping projects.

All three are pinned by mutation testing in the manner of §5.7: reintroducing
each defect fails a named test (4/4 caught), and the pair of guards on
`RATE_LIMIT_EDGE` covers both directions so the fix cannot degenerate into
"ignore those headers forever".

**A product decision with an audit consequence — resolved 2026-09-05.** The same
review flagged that `scanGasHistoryForWallet` in `api/sign-allocation/route.ts`
was `void userAddress; return MOCK_CHAIN_GAS` — a constant four-row table summing
to 0.033 ETH, so every address that cleared the gates received an identical
attestation. At the seeded rate of 0.1 that is 0.0033 ETH, 3.30 % of the
`MAX_ALLOC_ETH_WEI` ceiling; the ceiling is only reached if the rotatable rate
is raised past 3.0303. The uniformity was the finding, not the magnitude: §2.1
describes the PoG signer as attesting to gas history, and with the mock in place
there was no history being attested, so the trust model claimed a bound the code
did not supply.

The seam now holds a real scan. `app/lib/gasHistory.ts` sums the fees an address
actually paid across Ethereum, Arbitrum, Optimism, Base and Robinhood 4663 via
Blockscout, and `computeMaxAllocFromWei` bands the result between a 0.05 ETH
floor (below which the allocation is zero) and a 1 ETH cap. **The floor is the
part that matters to this dossier**: it is the first thing in the design that
makes a second claim cost anything. A fresh address is free, but making one
*eligible* takes 0.05 ETH of historical fees on a public chain, and history
cannot be manufactured retroactively. That does not make the mechanism
Sybil-proof — an attacker who has already spent gas across many addresses is
credited for each — but it replaces "headcount is the only rationing" with a
priced floor, which is a different threat model and a much duller one.

Three residual limits, recorded rather than fixed, in decreasing order of
interest to a reviewer:

1. **Optimism and Base under-count.** Those two are read through Blockscout v1
   `txlist`, which reports `gasUsed × gasPrice` and omits the OP-stack L1 data
   fee. Heavy senders on those chains are credited less than they spent. The
   direction is safe (nobody is over-credited) and the cap bounds the error's
   effect on supply, so it is documented in `PRE_MAINNET_CHECKLIST.md` §6.4
   rather than chased.
2. **Robinhood 4663 depends on someone else's bot policy.** That Blockscout
   instance sits behind Cloudflare, which answers Node's default `fetch` with a
   403 challenge and a browser `User-Agent` without one. If the policy tightens,
   the scan fails closed on that chain — the safe direction, but an availability
   dependency on a third party that no contract change can remove.
3. **Only outbound transactions count.** Blockscout's aggregate
   `gas_usage_count` was rejected as the source because it also sums gas from
   transactions an address merely *received*, which measures popularity rather
   than spend and would have been trivially inflatable by anyone willing to send
   an address dust.

**The abuse surface the scan introduces, and what bounds it.** A scan reads five
public hosts that charge nothing and owe us nothing, and it fails closed, so
losing access to them is a denial of service on genesis allocation. Wallet auth
does not bound this: it proves control of the address named, but keypairs are
free, so every fresh address is a fresh cache key and therefore a real five-chain
read, and a rented proxy pool multiplies the per-IP bucket by however many IPs
were rented. `/api/pog-scan` therefore runs the scan as a job behind a 1-hour
result cache, an in-flight join, a 240/hour global ceiling and 6/hour per
address, with the last two charged only when a scan will really run so that
polling and cache hits stay free. Ten tests; nine mutations including the
ordering of the two ceilings and a `force` path that used to delete the cached
result *before* consulting them, all caught.

One residual trap was removed rather than documented: `totalGasEth()` still
defaulted its argument to `MOCK_CHAIN_GAS`, so a caller who forgot to pass a scan
result silently received the fixture — the original defect, still armed after the
mock stopped being wired in. The default is gone; omission is now a compile
error.

**Triage of the Medium and Low items.** Three were reported for the paths that
did run. Each was re-derived from source rather than accepted, and two of the
three moved severity in the process.

*Zero-margin attestation TTL — confirmed, and the sharpest of the three.*
`registerPoG` bounds the deadline on both sides:

```solidity
if (deadline > block.timestamp + MAX_SIG_VALIDITY) revert SignatureTooLong();
if (block.timestamp > deadline)                    revert SignatureExpired();
```

The route signed `deadline = serverNow + ATTESTATION_TTL_SEC` with
`ATTESTATION_TTL_SEC` set to 24 h — exactly `MAX_SIG_VALIDITY`. Both ceiling
terms cancel and the upper check reduces to `serverNow > block.timestamp`, so
every attestation this deployment issued was valid only while the signing host's
clock sat at or behind the timestamp of the block that mined the registration.
Reported as Low; it is really an availability defect with a total failure mode.
It does not degrade — it reverts 100 % of registrations for as long as the skew
lasts, triggered by a host clock one second fast or by a sequencer whose
timestamps lag wall time, and it surfaces as `SignatureTooLong`, which points at
the signature rather than at a clock. Fixed by signing a 23 h deadline: the
window exists for human-paced wallet flows, where the hour is free, and it buys
tolerance for any skew below an hour in the direction that breaks. Three
mutations — zero margin, a one-second margin, and a TTL past the ceiling — all
fail the new test.

*Caller-chosen contract address in the digest — confirmed, but not Medium.*
`contractAddress` arrived in the body, was validated only by `isAddress`, and
was signed into the digest's `contract_` field. It is not exploitable at the
factory: line 511 hashes `address(this)`, so a signature naming any other
address cannot recover there and is worth nothing to whoever requested it. What
it did make the endpoint is a service that would sign "the Tosh oracle attests
that *wallet* may claim *amount* at *any address you name*" — inert only while
no second contract trusts `pogSigner`, and the pre-authorisations would already
exist on the day one did. Pinned to the configured factory, which the honest
client (`PogScanButton.tsx`) has always sent. It also closes a smaller present
issue: the value was passed to `fetchPogNonce`, making every request an
`eth_call` to a caller-chosen address on the server's own RPC credentials. Both
directions mutation-tested.

*Unbounded `setDefaultSoftCap` / `setMaxPogAllocationLimit` — confirmed as
written, not fixed, and deliberately so.* Both are floored and neither is
capped: `setDefaultSoftCap` rejects below `MIN_SOFT_CAP_PROD`,
`setMaxPogAllocationLimit` rejects only zero. Both are `onlyOwner`, and the
owner is the 2-of-3 Safe, so this is not an unprivileged path. It is recorded
rather than closed for two reasons. Contracts under `src/` are frozen for the
engagement (§0), and a ceiling is precisely the kind of change that should not
land between freezing the scope and handing over the commit hash. And the
interesting part is not the missing bound in isolation but that
`maxPogAllocationLimit` is the *on-chain backstop on the off-chain oracle* — the
last thing standing between a compromised or simply wrong signer and the token
supply. It therefore compounds with PM-F9 above, and still does now that the
oracle reads real chains rather than a constant table: the off-chain band
(`POG_GAS_CAP_WEI` × the seeded rate = `MAX_ALLOC_ETH_WEI`) is checked for
coherence at boot by `assertPogBandCoherent()`, but that check only sees the three
TypeScript constants. Raising the on-chain dial through this uncapped setter
therefore loosens the backstop without anything off-chain noticing or objecting,
which is the direction that matters — the dial can be widened silently but not
narrowed silently, since narrowing it makes `registerPoG` revert loudly. The pair
is worth an auditor's attention as one question rather than two. Flagged for the
engagement; no code change.

**Scope.** This sweep covered the off-chain surface only: API routes, RLS
posture, the PoG signing path, and the factory/clone libraries. The
`ToshLaunchpadHook` and `ToshLadderTreasury` reviews queued alongside it did not
run, so §1.1's "largest attack surface in the system" remains covered only by
§5.7's Slither pass and the test suite, not by this sweep.

---

## 6. Findings

> **Populate from the auditor's report. One subsection per finding, using
> their IDs — do not renumber.** An empty section here means unaudited, and
> unaudited means no mainnet deploy.
>
> Static analysis does not belong here. Slither's 70 findings are triaged in
> **§5.7**, under pre-audit hygiene, and adding them to this section would put
> tool output under the auditor's numbering.

**Findings to date: none — no audit has been performed.**

| ID | Severity | Title | Status | Resolution |
|----|----------|-------|--------|------------|
| — | — | — | — | — |

Severity ladder used for triage:

| Severity | Definition | Required response |
|----------|------------|-------------------|
| **Critical** | Direct, unconditional loss of user or treasury funds. | Fix + re-review. Blocks mainnet. |
| **High** | Loss of funds under attacker-reachable preconditions, or permanent freeze. | Fix + re-review. Blocks mainnet. |
| **Medium** | Griefing, temporary DoS, or loss bounded to the attacker's own funds. | Fix or written acceptance signed by the protocol owner. |
| **Low** | Deviation from best practice, no exploit path. | Fix if cheap; otherwise record here. |
| **Informational** | Style, gas, documentation. | Optional. |

### 6.x `<AUDIT-ID>` — `<title>`

<!-- Template. Copy per finding.
**Severity:** Critical | High | Medium | Low | Informational
**Location:** `src/<File>.sol:<line>`
**Status:** Open | Fixed | Acknowledged (accepted risk)

**Description.** <auditor's words, verbatim>

**Our response.** <what we changed, or why we accept it>

**Fix commit:** `<hash>`
**Regression test:** `test/<File>.t.sol::test_<name>` — must fail on the
buggy commit and pass on the fix.
**Re-review:** <auditor's confirmation>
-->

---

## 7. Remediation log

| Date | Finding | Commit | Regression test | Re-reviewed |
|------|---------|--------|-----------------|-------------|
| — | — | — | — | — |

---

## 8. Sign-off

Mainnet deployment requires all four signatures. An unsigned row is a blocker,
not a formality.

| Party | Name | Date | Signature |
|-------|------|------|-----------|
| Lead auditor | | | |
| Protocol engineering lead | | | |
| Safe signer (outside engineering) | | | |
| Operations / on-call lead | | | |

**Post-audit obligations.** Any code change after sign-off — including a
comment, which changes the hook address — invalidates the reviewed commit.
Either re-engage the auditor for a delta review or deploy the reviewed commit
unmodified.

---

*Last updated: 2026-08-26 — initial scaffold. §§6–8 are intentionally empty;
they are filled by an engagement that has not yet been booked.*
