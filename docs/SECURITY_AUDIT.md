# Tosh Protocol — Internal Security Review Dossier

**Version:** v5.0 (pre-mainnet)
**Status:** 🟠 **INTERNAL REVIEW ONLY — NO EXTERNAL AUDIT, BY DECISION (2026-09-06)**
**Owner:** Protocol Engineering
**Companion documents:** `docs/INCIDENT_RESPONSE.md`, `jayoo101/tosh-status` → `MANUAL_INTERACTION.md` (public),
`docs/PRD-v5.0.md`

> **What this document is.** The record of every security review this protocol
> has actually had, all of it internal: the scope, the assumptions, twenty-eight
> numbered sweeps of `src/` and its settings, the static-analysis triage, and
> the disposition of everything each sweep found.
>
> **What this document is not, and this is the load-bearing sentence.** Evidence
> that anyone outside this team has read this code. Nobody has. That is not a
> gap waiting to be filled — as of 2026-09-06 it is a **decision**, recorded in
> §0 with what it costs.

---

## 0. Review status, and the decision not to buy an external audit

**Decided 2026-09-06: this protocol ships to mainnet without a third-party
audit, permanently.** Not deferred, not pending budget, not waiting for a
calendar slot. `PM-A1`, `PM-A2` and `PM-A3` in `docs/PRE_MAINNET_CHECKLIST.md`
are retired as N/A rather than left open, because leaving them open would keep
describing an intention that no longer exists.

**The decision is absolute, including after an incident.** It is not a
pre-mainnet cost decision that quietly reverses the first time funds are lost.
`docs/INCIDENT_RESPONSE.md` §7 previously required paid hourly review of any
code-level patch by the external auditor; that item is rewritten to an internal
rule — mutate the regression test, have a second engineer who did not write the
patch sign the post-mortem by name, and disclose in the public post-mortem that
the fix had no external review. That section names itself the weakest step in
its own list, which is accurate.

**Nothing replaces the gate.** The previous version of this section said every
row of an engagement board had to be ✅ before `script/DeployMainnet.s.sol` could
run against a production RPC. That gate is removed and **not** substituted — no
bug bounty stands in for it, and no staged deposit cap limits early exposure
while confidence accumulates. Mainnet proceeds on the strength of internal
review alone. This is written down so that a reader who finds no external gate
here later cannot mistake its absence for an oversight; it was chosen.

### 0.1 What the decision actually costs

Internal review and external audit do not buy the same thing, and the
difference is not effort or rigour — it is whose imagination bounds the result.
Everything in §5 is a search for problems *we were able to conceive of*. An
audit is bought precisely for the complement of that set. Declining to buy it
does not shrink the complement; it only means nothing is looking there.

Concretely unreviewed by anyone outside this team:

| Surface | Size |
|---|---|
| Contracts in scope (§1.1) | 4 contracts + 2 libraries |
| Externally reachable functions | 95, enumerated with their modifiers in §5.17 |
| Largest single attack surface | `ToshLaunchpadHook` — holds genesis ETH, seeds the pool, runs the ladder, owns the refund path |
| Value at risk on day one | Unbounded by design, per the paragraph above: no deposit cap staging was adopted |

The class of finding this most plausibly forgoes is the one every sweep in §5
shares a blind spot for: an interaction between two mechanisms that are each
correct alone. §5.11 (ladder pricing against exact-output third-party routers)
and §5.13 (the read nobody was charged for) are both that shape, and both were
found only because someone went looking on a hunch. There is no reason to think
the supply of such interactions is exhausted, and internal review has no
systematic way to enumerate them.

**The document names its own strongest example.** §2.3's first accepted surface
— the buyback being unbounded in a pool's first `TWAP_WINDOW` — is annotated
"**Please challenge this one**", and closes by saying an auditor who thinks the
trade is wrong should say so. That surface is held shut by an operational rule on
an owner-only key rather than by code, which the row itself calls "exactly as
strong as the runbook and the alert pipeline, and weaker than the one-line code
change that would make it unreachable". The invitation to disagree with that
choice is now open to nobody. It is the clearest single instance of what §0
costs, and it is a live acceptance, not history.

### 0.2 What internal review did produce

Stated precisely, because the honest argument for this decision rests on it
being substantial — not on it being equivalent to an audit, which it is not.

| Evidence | State |
|---|---|
| Numbered review sweeps of `src/` and the settings surface | 30 (§5.1–§5.34) |
| Source-to-chain fingerprint of the deployed hook implementation | Done 2026-09-08 — §5.26 by hand, automated in §5.30. `RecomputeInitcodeHash.s.sol` asserts `keccak256(type(ToshLaunchpadHook).creationCode)` against on-chain `HOOK_CREATION_CODEHASH` and reverts on mismatch. On-demand against a live RPC, deliberately not a CI gate (§5.28). |
| Foundry tests | 363, with a CI floor equal to the suite |
| Frontend tests | 188, same |
| Slither findings triaged and dispositioned | 71 (1H / 24M / 27L / 19I) across 66 contracts, re-checked on every push |
| Narrowing casts disposed of by the bound each rests on | 19, gated in CI |
| Mutation testing | Applied to every guard and fix in §5.10 onward; each sweep records its counts and its survivors |
| Deepest search actually run | Invariants 1.28 M calls each (100× CI), fuzz 4 M runs total (1,953× CI) — §5.19, no violations |

Two things about that table are worth saying plainly. First, the mutation
counts are what make it more than a list of activity: a test that cannot fail is
indistinguishable from no test, and §5.14 through §5.18 each caught a case where
a verification tool was silently not running. Second, none of it addresses §0.1.
A suite measures the questions it was written to ask.

### 0.3 Severity ladder — still in force, now self-enforced

The ladder in §6 is retained for findings this team makes, and Critical / High
still block a mainnet deploy. What changed is that nobody outside the team
checks whether the rule was followed. It is now an internal commitment rather
than a gate somebody else holds.

### 0.4 Deferrals that just lost their owner

The expensive part of cancelling an engagement is not the sections that talk
about auditors — those are cosmetic and were rewritten in the same pass. It is
the work that earlier sweeps explicitly **handed forward** to it. Each item
below reads as settled in the section that wrote it, because a named future
owner is indistinguishable from a plan. That owner no longer exists, so each is
re-assigned here or is recorded as abandoned in as many words.

| Deferred | Where it was parked | Now |
|---|---|---|
| Fuzz depth above 256 runs; invariant soak past depth 100 | §4, "ask for a higher run count during audit" | **Reassigned to us and done 2026-09-06 — §5.19.** It needed machine time, not a vendor. Invariants at 512 × 2500 (100× CI, 1.28 M calls each) and fuzz at 500,000 runs per property (1,953× CI): no violations. Its real output was correcting how this suite's coverage counters are read. Now recurring daily as `.github/workflows/soak.yml`, so this row is closed rather than merely done once. |
| Anything requiring a live adversarial fork | §5.11, "staying with the engagement" | **Abandoned.** No internal substitute is planned. The 8 fork tests in §4 exercise the live V4 singleton on happy and router paths, not an adversary. |
| The 6 assumptions in §2.2, challenged by someone who did not write them | §2.2, its whole purpose | **Abandoned, and this is the largest single loss.** Restated in §2.2 so a reader does not take the list for a reviewed list. |
| Whether the PoG-quota compounding in PM-F9 is exploitable in composition | §5.10, "still the auditor's question" | **Abandoned as an external question.** The bound is derived internally and tested; nobody will attack it. |
| The tier ladder as an economic model — is a 2,000× span over 4,000 rungs the right shape? | §5.11 | **Unchanged.** This was never an audit deliverable; it is a question about markets, and it was mis-parked. |
| §4's per-file test table, hand-maintained | Nowhere — found while rewriting §4 today | **Fixed 2026-09-06.** `scripts/checkTestTable.mjs` recounts from `forge test --list` and fails if a row, the 355/8/363 header arithmetic, or a file the table does not name has drifted. The CI floor still owns the total; this owns the per-file numbers that sat next to it rotting. |

**And one premise, now void everywhere.** Three places in §5 decline a code
change because "`src/` is frozen for the engagement". That freeze had exactly
one basis and it is gone. Pre-mainnet, `src/` is not frozen by anything: salt
mining reads `hookInitcodeHash` from the factory at runtime, so changing hook
source before deployment costs a rebuild and nothing else. §5.15 already
demonstrated this by bounding two setters the day after §5.10 declined to on
freeze grounds.

A real freeze does apply, but **only after** `script/DeployMainnet.s.sol` runs:
the deployed factory bakes `HOOK_CREATION_CODEHASH` into its constructor (§2.2
item 6), so once it exists on mainnet, editing `src/ToshLaunchpadHook.sol` —
including a comment, which moves the metadata hash and therefore the initcode
hash — desynchronises every address that factory predicts. The two live
decisions that appealed to the wrong freeze are re-disposed in place, at §5.11.

### 0.5 How to read the rest of this document

§§1–5 were written while an engagement was still the plan, and about twenty
places in them address an auditor directly: "the auditor should confirm the bound
on each", "worth an auditor confirming", "an auditor short on time should spend
it here". **Those sentences are left standing on purpose.** They are the record
of which claims their own author considered least self-evident, and that is
useful information — scrubbing the word would delete the signal and pretend the
document was always written for this decision.

Read them as annotations rather than as plans. Where such a sentence deferred
actual work rather than merely flagging a claim, it is listed in §0.4; nothing
outside that table is waiting on anybody.

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
  dependencies, audited upstream. **The exact commits are pinned** — §5.6 — so
  that the bytecode reviewed in §5 is the bytecode deployed.
- `soat-frontend/**` — the Next.js UI. Reviewed separately; a frontend
  compromise is covered by `docs/INCIDENT_RESPONSE.md` §2, not here.
- The off-chain PoG signing service, **except** for the on-chain signature
  verification path, which is firmly in scope. That path is
  `ToshFactory.registerPoG` and nothing else: the digest is built and recovered
  inline there (`src/ToshFactory.sol:511-513`), and a bad signature leaves as
  `InvalidSignature()`. This used to name a helper called
  `_verifyPoGSignature`, which has never existed in `src/` — see §5.12.

### 1.3 Build configuration the deployed bytecode depends on

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

### 2.2 Assumptions nobody outside this team has challenged

These are the load-bearing beliefs. If any is false, the security argument
collapses, so each is stated plainly rather than buried in a comment.

> Per §0 these were going to be handed to an auditor precisely so that someone
> who did not write them would try to break them. That is not happening. Each
> is now supported only by the derivation printed next to it and by the tests
> cited — which is to say, by the same reasoning that produced it.

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
Each is bounded rather than absent, and the bound is the thing to check. Nobody
outside this team has checked one (§0.1):

| Surface | Bound we believe holds |
|---------|------------------------|
| TWAP manipulation of the shelf price gate | `TWAP_WINDOW = 1800s`; gate is a ceiling (`PRICE_CEILING_BPS = 10_500`), so manipulation can only *block* mints, never underprice them. |
| Hookless parallel V4 pools for the same token | Anyone can open one. It carries no tax and no ladder; the canonical pool is the one the hook seeded. Documented at `ToshLaunchpadHook.sol:1157`. |
| Owner curation of buyback targets | `addLadderToken` accepts only tokens this factory launched and derives the pool from the token's own hook — the owner cannot point buybacks at a pool they control. |
| Referral self-farming | Costs the attacker PoG quota on the referrer address; `REFERRAL_BPS = 1000`. |
| Launch-block shelf-0 rounding | `SameBlockMintForbidden` guards the first block. |
| Buyback sandwiching | `MAX_BUYBACK_SQRT_DEVIATION_BPS = 1000` caps the executable deviation. The width is bracketed by `test_probeG2_bandEdgeSitsWhereTheConstantSaysItDoes` (fills at 500 bps, refuses at 1200 bps), so the constant cannot drift in either direction unnoticed. Note the prize per leg is `max(1 ETH, 10 % of reservoir) / 3` — the 0.33 ETH quoted in the natspec is its floor, not a bound. **The cap does not apply for the first `TWAP_WINDOW` (1800 s) after `launch()`** — see the OPEN item below. A second way to widen the band, recurring at any point in a pool's life rather than only at its start, was closed in §5.2 #2: a quiet pool's TWAP used to fossilise at a stale era, leaving the floor slack after a drawdown. |
| **FIXED IN SOURCE 2026-09-11; LIVE DEPLOYMENT STILL HELD OFF CHAIN — buyback is unbounded in a pool's first 1800 s** | **Please challenge this one.** `_buybackSqrtFloor` returns `MIN_SQRT_PRICE + 1` (no bound) while `twapSqrtPriceX96()` reads 0, which is exactly the window from `launch()` until `TWAP_WINDOW` has elapsed. One-shot and not attacker-re-enterable (`_prevCheckpointTs` only rolls forward onto a checkpoint already a full window old), but during it a listed token has no anti-sandwich control at all, on the pool whose liquidity is thinnest. `test_probeG3_immatureTwapIsRefusedAtListing` measures it on one pool parked 1500 bps out: with no TWAP the full 3.33 ETH leg clears and 0.93 ETH of it is recovered by whoever parked the price; with the TWAP live the identical deviation is refused outright. `pokeBuyback` has no cooldown, so it is per block, and the leg is `balance / 30`, so the prize scales with the reservoir. The natspec used to defend this with "the reservoir would stall permanently", which is the cost of the *`catch`* branch (a hook that never answers), not of this one — here refusing would cost a deferral of at most 30 minutes via the existing `BuybackSkipped` path. **We chose not to change the contract, and reversed that on 2026-09-11.** `addLadderToken` now reads `twapSqrtPriceX96()` and reverts `TwapNotMature` unless it answers non-zero, so the state is unreachable through the only door that leads to it. What reversed the decision was not a new finding but publication: `monitoring/alerts.json` went public with the repository, and `STATE-07`'s `check` field names the quantity to poll while its `why` field prices the prize — which makes a procedural control resting on a single key the wrong half of this trade to keep. **The live treasury cannot be given the gate.** `ToshFactory.ladderTreasury` is `immutable` and is baked into the hook implementation every launch clones, so replacing `0x99aD248dD15498957B864Fd79917F0E103Aa78F7` means replacing the platform and stranding the launch already pointed at it; the gate therefore arrives with the next deployment. Until then the exposure stays held shut by the operational rule — do not list a token until its TWAP matures — because reaching the state at all requires `addLadderToken`, which is owner-only. Recorded in four places so it cannot be lost: the rule and its cost in `addLadderToken`'s natspec, the two fallbacks separated in `_buybackSqrtFloor`'s natspec so the weaker one can no longer inherit the stronger one's justification, `STATE-07` in `monitoring/alerts.json` polling `twapSqrtPriceX96()` on every listed token, and — added 2026-09-11, because a rule recorded four times and checked zero times before the signature was still the gap this row was really describing — `scripts/preflightLadderListing.mjs`, which a signer runs against the token in front of them and which answers `safe to sign` or `DO NOT SIGN`. It also reports whether the treasury it is pointed at enforces the rule itself, so the two regimes cannot be confused; `docs/SIGNER_BRIEF.md` is where the signer is actually told to run it. **Residual risk, stated plainly:** this is a procedural control on a privileged key, so it is exactly as strong as the runbook and the alert pipeline, and weaker than the one-line code change that would make it unreachable. An auditor who thinks that trade is wrong should say so. **That paragraph is kept in the past tense it was written in, because it is still the live deployment's position and will be until the next one.** Two things it did not anticipate: the gate also refuses a hook whose getter REVERTS, which is the second of `_buybackSqrtFloor`'s two doors to unbounded and was never covered by the operational rule at all; and `_buybackSqrtFloor` still takes that door at poke time, so the gate establishes only that the getter answered once, at listing. We assess that door as unreachable on chain — `nowTs - _prevCheckpointTs` cannot underflow where time only moves forward — and pre-disclose it in `SECURITY.md` rather than leave it as a comment here. |
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

> **Corrected 2026-09-05 (§5.11).** "Fails loudly" is true of ONE consumer and
> was written as though it were true of the path. `_safeReferencePrice` calls
> `_twapSqrtPriceX96()` directly, so the wrap reverts and Phase-2 minting stops —
> loud, as claimed. But `ToshLadderTreasury._buybackSqrtFloor:613-619` wraps the
> same call in `try/catch` and returns `MIN_SQRT_PRICE + 1` — **unbounded** — from
> the `catch`. On that path the wrap is exactly the lying oracle this paragraph
> contrasts itself against: the anti-sandwich bound disappears and buybacks keep
> filling. The horizon is 2106 and the severity is Informational, but the shape is
> not: a reverting TWAP is a LOSS OF A SAFETY BOUND, and two separate consumers
> treated it as benign. The second one, `STATE-07`, is a live defect and is fixed
> in §5.11.

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

## 4. Test coverage

`forge test` — **361 passing**, and again under `forge test --isolate`, which
bills each call the way a real transaction would rather than letting storage
touched in setup stay warm for the rest of the test. Both runs are CI gates.

A further **12 fork tests** run only when `ROBINHOOD_RPC` is set and report as
SKIPPED otherwise, so the passing count is 361 or 373 depending on whether the
runner has an endpoint. They are listed below but excluded from the 361
deliberately: a number that changes with a credential is not a number. The CI
floor is immune to that distinction because it reads forge's `(N total tests)`,
which counts a skipped test — so the gate is 373 either way, measured rather
than assumed in `.github/workflows/test.yml`.

Which rows those 12 are is now derived from whether the file reads
`ROBINHOOD_RPC`, not from whether its name contains "Fork".
`ToshV5FirstLaunchRehearsal.t.sol` skips on a missing endpoint exactly as
`ToshV5Fork.t.sol` does, and the filename rule had put its 4 into the 361 —
the bucket this paragraph defines as the count that holds without a credential.
The arithmetic still reconciled, so nothing was red; the passing figure was
simply four too high, which is the shape of drift `checkTestTable.mjs` exists
to catch.

Not all 12 run on a green CI, and the two suites differ here. `test.yml`'s
live-V4 step selects `--match-contract ToshV5ForkTest`, so the rehearsal's 4
skip on every push even with the secret present. Wiring them in would couple
the check to live mainnet dials — it asserts the current `pogSigner()` and the
three dial bounds — so a rotation would go red on an unrelated commit. Left as
an on-demand suite deliberately; the floor is what notices if it is deleted.

> **Every number below is re-measured by `scripts/checkTestTable.mjs` against
> `forge test --list`, on every push.** The table had drifted 28 tests low while
> §5.10 through §5.15 landed, and it had never summed to its own header: the
> rows totalled 326 against a stated 327. Both defects are the exact shape §5.7
> and §2.5 were each caught with — a total that reconciles against nothing. The
> guard that was recorded as unfixed in §0.4 is that script.

| File | Tests | Focus |
|------|------:|-------|
| `test/ToshV5Factory.t.sol` | 112 | Pause, blacklist, PoG quota/cooldown/nonce, launch fee, name registry, ownership. Also the four bounded setters (§5.14, §5.15). |
| `test/ToshV5.t.sol` | 93 | Happy paths: genesis → launch → claim → shelf ladder → refund; ladder halt. Also the gas budgets and the piggyback gas gate. |
| `test/ToshV5Guards.t.sol` | 72 | Access control and phase guards across every external entry point. |
| `test/ToshHookClone.t.sol` | 18 | EIP-1167 clone layout, immutable-arg round-trip, per-clone isolation, salt mining, deployment gas. |
| `test/ToshV5Attack.t.sol` | 17 | The §2.3 surfaces, adversarially. |
| `test/ToshV5Invariants.t.sol` | 15 | **Stateful invariants** for §2.2 items 1, 2 and 5. See below. |
| `test/ToshV5Abi.t.sol` | 8 | Drift between the contracts and everything that binds to them by name rather than by type: 3 pin `abis.ts` to the Foundry artifacts, 5 pin the duck-typed cross-contract interfaces to the implementations that answer them (§5.7). |
| `test/DeployMainnet.t.sol` | 8 | Deploy script, including the forced Safe ownership handoff and the distinct-role refusals. |
| `test/ToshV5ArbSys.t.sol` | 7 | `_blockNumber()` on an Arbitrum Orbit chain: that the hook stamps the **L2** height rather than `block.number`'s L1 one, and that it still falls back correctly where `ArbSys` is absent. Two contracts, with and without the precompile etched. |
| `test/ToshV5Fuzz.t.sol` | 7 | Property fuzzing, 256 runs per property. |
| `test/ToshV5LpMathVectors.t.sol` | 4 | Fixed vectors for the V4 liquidity math, checked against independently computed expectations. |
| `test/ToshV5Fork.t.sol` | 8 | **Live chain 4663**, skipped without `ROBINHOOD_RPC`. Lifecycle against the deployed V4 singleton; a buy through the deployed UniversalRouter; the router's calldata layout pinned against the chain. See §4.2. |
| `test/ToshV5FirstLaunchRehearsal.t.sol` | 4 | **Live chain 4663**, skipped without `ROBINHOOD_RPC`. Binds the *deployed* factory rather than a fresh one and runs the whole lifecycle at the 0.01 ETH production floor — the cap every other suite launches above. Pins `totalEthDeposited == softCap()` exactly, `shelfP0() == 2_499_999_999`, the stale-dial salt rejection, and that a lone depositor takes the entire 22% genesis tranche. See §4.3. |

The table is tests. One check that is not a test, and that this table therefore
cannot carry: whether the deployed hook implementation's `HOOK_CREATION_CODEHASH`
matches `keccak256` of this tree's creation bytecode. That comparison now lives
in `script/RecomputeInitcodeHash.s.sol`, which asserts like-with-like against
a live RPC and reverts on mismatch. It is on-demand, not CI: the 4663 public
endpoint rate-limits a tight request loop (§5.28), and putting a live probe
on every push is how the watcher reported success while blind. First automated
run 2026-09-08, recorded in §5.30; the original hand check is §5.26.

### 4.1 Stateful invariant suite

Every other file above asserts a property under a call sequence *its author
chose*. `test/ToshV5Invariants.t.sol` asserts properties under sequences nobody
chose: a handler exposes deposits, refunds, launches, claims, project creation,
**real V4 swaps in both directions**, the retail shelf mint (`mintBondingCurve`),
ladder curation, two scales of time travel
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

- Fuzz depth is 256 runs per property — adequate for CI, thin for
  invariant hunting. A higher run count and a long invariant soak
  (`FOUNDRY_INVARIANT_RUNS`) at a depth well past 100 were going to be asked of
  an auditor; per §0.4 that became ours to run, and **it was run on 2026-09-06 —
  see §5.19.** Nothing failed. It is now a daily job,
  `.github/workflows/soak.yml`, rather than a one-off or a per-push cost.
- Swap coverage in the invariant handler is real, and **how thin it is per run
  depends entirely on depth**, which is measured in §5.19 rather than sampled
  once here. A buyback is several actions deep past launch (fund → launch → list
  → accumulate 1 ETH → swap), so at depth 100 a sampled run reached 5 buys and
  1 sell; at depth 1000 the same invariant reached 75 and 38.

  > This bullet used to read "a measured run reaches roughly 6 buys, 2 sells, one
  > ladder listing and one buyback cycle inside its 100 calls." That number came
  > from `afterInvariant()`, which logs the **last run only** — one sample out of
  > `runs` — so it was a sample presented as a property of the suite. §5.19
  > describes how far wrong that reading can go.
- The shelf ladder (`mintBondingCurve`) now has an invariant action
  (`mintShelf`, 2026-09-06). The UI never talks to the V4 router; this is the
  retail buy. Its price gates, same-block lockout and halt are composed against
  the same owner switches the rest of the handler already holds. Reachability
  is pinned by `test_handlerCanReachMintShelf` so a swallowed `catch` cannot
  hide an action that never lands.
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

### 4.3 First-launch rehearsal — the production floor, before it was load-bearing

`test/ToshV5FirstLaunchRehearsal.t.sol`, against **Robinhood Chain (4663)**,
unpinned, and against the **deployed** factory rather than one this tree
compiles. §4.2's suite forks the chain and then `new`s its own factory, which
tests the source; this binds the contract that holds the money.

It exists because of a gap that mattered exactly once. The lowest soft cap any
suite here had ever launched at was 1 ETH, and the first mainnet launch was
planned at 0.01 ETH, the production floor. At that cap only the arithmetic had
been checked — `test_smallestReachableShelfP0_stillStepsTheLadder` derives
minShelfP0 = 2,499,999,999 and a 4,756,270-wei step, §5.11 — and it did so on a
bare `new`'d hook. The full genesis → deposit → launch path at the floor had
never been executed anywhere, so the mainnet attempt would have been its first
execution.

1. `test_rehearsal_liveFactoryIsWhatWeThinkItIs` states the premise as assertions instead of
   trusting it: chain id 4663, code at the factory, `owner()` is the 2-of-3
   Safe, `pogSigner()` is the live signer, not paused, and all three dial
   bounds. Nothing later in the file is worth reading unless this one holds.
2. `test_rehearsal_fullLifecycleAtTheSoftCapFloor` pins two numbers exactly:
   `totalEthDeposited == softCap()` with no dust, and `shelfP0()` at
   2,499,999,999 — the value §5.11 reaches by a different route, which is why
   asserting it a second way is not redundant.
3. `test_rehearsal_saltMinedAgainstStaleDialsIsRejected` mines a salt, moves a dial, then
   expects `InvalidHookSalt`. `createLaunch` bakes `defaultSoftCap` and
   `maxPogAllocationLimit` into the clone's initcode, so a dial that moves
   between mining and sending invalidates the salt — and on mainnet that dial
   was moved by a Safe transaction shortly before the launch.
4. `test_rehearsal_loneDepositorTakesTheWholeGenesisTranche` asserts the entire
   `GENESIS_CLAIM_SUPPLY` — 4,620,000e18, 22% of `MAX_SUPPLY` — reaches a single
   depositor who fills the cap alone. That is pro-rata distribution working, not
   a defect, and it is written down so that nobody meets it first on a project
   with outside money in it.

**One deliberate deviation, and it is the only one.** `setPogSigner` is
repointed at a test key inside the rehearsal's Safe step, because the live
signer's key is not in this repository and must not be. Everything else —
factory, pool manager, `ArbSys`, owner, dial bounds — is the live article, and
§4.2's `ArbSys` caveat applies here unchanged: it is etched, for the same reason
and at the same cost.

**What it does not cover** is §4.2's list, plus one of its own: it never
exercises the frontend. The mainnet launch was driven with `cast`, so
`/launch`'s pre-flight — the live fee re-read and the revert decoding — was not
on that path at all.

**Vindicated by the event it was written for.** The launch went out on
2026-09-10 at block 59,514,785 for 498,529 gas, and `shelfP0()` read
2,499,999,999 on chain — a third independent agreement on that number, after
§5.11's arithmetic and this file. `totalEthDeposited` equalled `softCap()`
exactly at 1e16, the pool came up with the expected key holding roughly
`GENESIS_LP_SUPPLY`, and the exercise cost 0.010094 ETH end to end.

It is not selected by `test.yml`'s live-V4 step, deliberately — see §4.

---

## 5. Hygiene checklist and review sweeps

Originally scoped as work to finish *before* an auditor started, so their hours
would go to logic rather than to telling us things CI could have. With §0's
decision it is no longer a preparation for anything — it is the review itself,
which is why §5.2 onward grew from a checklist into thirty numbered sweeps:

- [x] `forge build --sizes` — every DEPLOYED contract under the 24 KB EIP-170
      limit. Tightest margin is `HookDeployLib` at 2,953 B, then
      `ToshLaunchpadHook` at 3,978 B. Both lost ~230 B to the `PIGGYBACK_MIN_GAS`
      work in `ROBINHOOD_MIGRATION.md` §F.7; the margin is shrinking and is worth
      watching rather than assuming. Note `forge build --sizes` also lists
      `CloneDeployer` at **−3,061 B**, i.e. over the limit: it is a test helper
      in `test/ToshHookClone.t.sol` that embeds a full hook creation code, it is
      never deployed, and Foundry does not distinguish test contracts in that
      table. Read the table with that in mind rather than as a pass/fail.
- [x] `forge test` — 351/351 green, and 351/351 again under
      `forge test --isolate`. Both are CI gates in `.github/workflows/test.yml`,
      and that workflow now also asserts the COUNT: a floor of 351 and an
      equality check between the two runs. Added because an interrupted build
      leaves an artifact with a complete ABI and empty bytecode, which forge
      reports as "no tests found" for that suite and skips — the whole main suite
      went missing once and the run stayed green at 256. A passing `forge test`
      was not, until this, evidence that the tests ran.
      The floor is only useful while it tracks the suite. It sat at 335 against
      349 actual until 2026-09-04, i.e. 14 tests of slack, which is enough to
      lose a whole suite without tripping — the exact failure it was built for.
      Raising it is part of adding tests, not a separate chore: it moved to 350
      with the §5.7 mutex test and to 351 with the §5.11 ladder-monotonicity
      test. The floor holds even without `ROBINHOOD_RPC`, because forge counts a
      `vm.skip`'d test in its total; that was measured, not assumed.
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
- ⬜ ~~Audit branch frozen, commit hash written into §0~~ — **retired
      2026-09-06 by §0.** There is no engagement to freeze a branch for, and §0
      no longer has a commit-hash field to write into. This was the only
      unticked box in this list, so the list is now 10 of 10 that still apply
      rather than 10 of 11. It is left visible instead of deleted: a checklist
      that shortens itself when an item is abandoned is a checklist that reads
      as complete for the wrong reason.
- [x] `lib/**` dependency commits pinned and listed — §5.6.
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
| solmate | 1 (`lib/solmate/src/auth/Owned.sol`) |

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

66 contracts, 102 detectors, **74 findings** — 1 high / 26 medium / 27 low /
20 informational. Those are the CURRENT numbers, and they live here rather than
in the newest re-run note below because `checkSlitherFindings.mjs` reads the
first total and the first split it finds in this section. The dated notes below
are a history and must keep the numbers they were written with; this line is
the one that moves. The JSON is ~8.6 MB and gitignored; regenerate it with the
command above. `scripts/slitherTriage.mjs` groups a run by impact and detector,
which is the form worth re-reading: on a later run the signal is a count that
moved, not the seventeenth `timestamp` note.

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

**Re-run 2026-09-11, and it moved for the opposite reason.** 72 findings, 20 of
them informational — one more than 2026-09-04, and this time the guard above is
what noticed, on the push that caused it rather than weeks later. The new
finding is `cyclomatic-complexity` on `ToshLadderTreasury.addLadderToken`, and
it is the direct cost of closing §2.3: the TWAP gate added there is a
`try/catch` around `twapSqrtPriceX96()` with a zero check inside, which takes
the function to ten `revert` sites across nine `if`s and one `try/catch` and
carries it over Slither's threshold.

**Dispositioned: accepted, and the trade is the point.** The only thing this
finding can be acted on by is splitting the function, and splitting a listing
precondition away from the listing is how a precondition stops being checked.
The body is nothing but preconditions — a flat sequence of guards, each with
its own error, in an order that is load bearing rather than tidy: the
`launched()` check has to precede the TWAP check, because an unlaunched hook
does not report 0, it reports `2**96` from the "flat for a full window" branch
and would walk straight through. Cyclomatic complexity is the wrong axis to
optimise on a function whose entire job is to refuse.

Worth separating from every other row in the table below. Those are findings
that were already there, being looked at. This one is a finding this repository
created deliberately, on the same day, with the argument in the commit that
created it and in `addLadderToken`'s natspec.

**Re-run 2026-09-12, and both new findings are in code written that day.**
74 findings, 26 of them medium. The referral carve was split 8 % to a
per-project referrer and 2 % to a lifetime slot, and `deposit()` grew the
arithmetic that does it. Slither reads two things in it:

- `uninitialized-local` on `deposit.reserved`, which is `uint256 reserved;`
  with no `= 0`. Accepted on the same grounds as the four loop accumulators
  already in the table: a value-type local is zero-initialised by the language,
  so the declaration is not missing anything. This is the row where the count
  is the only honest thing to update.
- `divide-before-multiply` on `deposit`, which is a correct reading of the
  code and **not** a defect. It is treated separately below, because the reason
  it is left alone is not the reason the two in `launch()` are.

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
| `uninitialized-local` | Medium | 7 | Accepted — loop accumulators (`filled`, `cost`, `sold`, `legs`) whose intended initial value is zero, plus `deposit.reserved` since 2026-09-12. An explicit `= 0` costs gas and says nothing. |
| `divide-before-multiply` | Medium | 3 | Reviewed against real magnitudes, bounded, not changed. Two in `launch()`, one in `deposit()` since 2026-09-12. Below. |
| `timestamp` | Low | 17 | Already inventoried in §2.4 — the genesis clock and the TWAP window, both intentionally wall-clock. |
| `reentrancy-events` / `reentrancy-benign` | Low | 8 | Accepted — event ordering only; no state a caller can observe or act on. Three of the eight are the dark tax and are new since 2026-08-27. Below. |
| `calls-loop` | Low | 2 | Accepted — the piggyback loop is bounded by `LEGS_PER_POKE` and every leg is `try/catch` fault-isolated. |
| `assembly` | Info | 9 | Expected — transient-storage mutex, hook-address bit checks, clone initcode. |
| `missing-inheritance` | Info | 3 | Accepted — the three interfaces are consumed cross-contract; declaring inheritance adds a vtable for nothing. |
| `low-level-calls` | Info | 2 | Accepted — the two identical `_sendEth` helpers. Deliberate, and the alternative is worse. Below. |
| `naming-convention`, `too-many-digits`, `cyclomatic-complexity` | Info | 6 | Style. `_PIGGYBACK_SLOT`'s literal is a namespaced transient slot, meant to be unreadable as a number. The second `cyclomatic-complexity` is `addLadderToken`, new on 2026-09-11 and the cost of closing §2.3; accepted above rather than here, because it is the only row in this table the repository created on purpose. |

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

**The third instance — `deposit()`, added 2026-09-12 — is a chosen rounding,
not an overlooked one.**

```solidity
uint256 commission  = (amount * REFERRAL_BPS) / BPS_DENOMINATOR;
uint256 projectCut  = (commission * PROJECT_REFERRAL_SHARE_BPS) / BPS_DENOMINATOR;
uint256 lifetimeCut = commission - projectCut;
```

Slither is right that `commission` is a quotient and is then multiplied. The
single-step form, `amount * 800 / BPS_DENOMINATOR`, would be more accurate for
`projectCut` taken alone — and it is rejected on purpose, because the two legs
are not independent quantities. What has to hold exactly is
`projectCut + lifetimeCut == commission`, for every amount, since `launch()`
seeds the LP with the non-commission remainder and a wei of drift in the total
moves the opening premium. Subtracting the second leg rather than computing it
makes that identity hold by construction, for free, at every magnitude.

The price is one wei of slippage in the 80/20 split at dust amounts. At
`amount = 19` wei: `commission = 1`, `projectCut = 0`, `lifetimeCut = 1`, where
a single mulDiv would have given the project referrer the wei instead. Both
forms carve exactly 1 wei in total, which is the invariant that matters; they
disagree only about which of two referrers receives a quantity worth
`2e-18` ETH. Folding the multiply in would trade an exact total for an exact
split, which is the wrong direction.

Unlike the `launch()` case above, there is nothing here to revisit later: this
is not a rounding waiting for a convenient redeploy, it is the arithmetic the
invariant requires.

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
`soat-frontend/src/lib/projectAttestation.ts` lowercases the hash before building the message, so
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

1. **Optimism and Base under-count, by a measured amount.** Those two are read
   through Blockscout v1 `txlist` when a sender is heavy enough to need it, and v1
   reports `gasUsed × gasPrice`, omitting the OP-stack L1 data fee. Quantified
   2026-09-05 against v2's authoritative `fee.value` over 50 transactions per
   chain: Optimism 2.30 % low (49.09 % on its worst single transaction), Base
   0.02 % low, and Ethereum, Arbitrum and Robinhood exact to the wei — the last two
   because Nitro bills L1 cost through an inflated `gasUsed` rather than a separate
   field. The direction is safe (nobody is over-credited), the cap bounds the
   effect on supply, and light senders are unaffected because the one-page v2
   probe prices them exactly.
2. ~~**Robinhood 4663 depends on someone else's bot policy.**~~ **Closed
   2026-09-05, and replaced by a different finding.** The Cloudflare `User-Agent`
   workaround is gone: the scan now reads all five chains through the keyed PRO API
   at `api.blockscout.com/{chainId}/…`, which serves 4663 with no override. What
   replaced it is worse and was found by measurement, not reasoning — see below.
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
result cache, an in-flight join, a global hourly ceiling and 6/hour per address,
with the last two charged only when a scan will really run so that polling and
cache hits stay free. Ten tests; nine mutations including the ordering of the two
ceilings and a `force` path that used to delete the cached result *before*
consulting them, all caught.

**The ceiling was then measured rather than assumed, and it was wrong by 24×.**
The global limit began at 240/hour, reasoned from what five hosts ought to
tolerate. Walking each host up to its actual limit found that unkeyed Arbitrum
and Base advertise `x-ratelimit-limit: 10` on a window near forty minutes and
return 429 on the tenth request — twice, reproducibly. Since every chain must
succeed for a total to be a total, the real unkeyed ceiling is about ten wallets
an hour. Two consequences matter to a reviewer. First, a defence sized by
reasoning about someone else's capacity is not a defence, and the fix was to
derive it from the tier in use so that we refuse with a 503 that says when to
return rather than absorbing a 429 that does not. Second, the retry loop was
*amplifying* the condition it was meant to survive: a 429 was retried three times
on a sub-second backoff against a budget that refills in forty minutes. It now
reads `x-ratelimit-reset` and retries only a window about to turn over. Seven
mutations, all caught, including both directions of that threshold and the case
where a host sends no header at all.

**Then a key was obtained, and three things changed that a reviewer should know
about.** The scan migrated onto the keyed PRO API, which is one host rather than
five and needs no `User-Agent` spoofing, and where a 429 resets in 306 ms rather
than forty minutes. Details and the measured URL shape are in
`PRE_MAINNET_CHECKLIST.md` §6.4.1. The security-relevant parts:

**(a) The scarce resource changed, so the defence had to.** The tier in use is
bounded by credits per day (100,000, at ~20 a call) rather than requests per
second, and a scan costs anywhere from 5 calls to 25 depending on whose wallet it
is. A request-count ceiling cannot bound a cost that varies five-fold, so the
hourly ceiling was demoted to burst control (120/hour) and the real budget is now
enforced against `x-credits-remaining` as the host reports it, refusing new scans
below a 2,000-credit reserve. The reserve is sized to let in-flight scans finish,
because a scan killed halfway spends the credits and produces nothing. The gauge
expires after an hour of quiet, which is the load-bearing part: a reading is only
ever a floor, and without expiry an exhausted value recorded before the daily
reset would refuse every claimant against a refilled budget, indefinitely. Unknown
admits, zero refuses, and the two are never conflated. Nine route tests and eleven
mutations, all caught, including both directions of that conflation.

**(b) An unset key is now a loud failure rather than a quiet one.** Unkeyed, the
PRO API answers 402 on every chain and a wrong key 401. `/api/pog-scan` refuses up
front with a 503 naming the configuration, rather than starting a job that spends
five requests to tell a claimant their gas history could not be read;
`getJson` reports 401/402 as key faults instead of as "could not read Ethereum",
which is the difference between paging someone to look at an environment variable
and paging them to look at a chain.

**(c) The fail-closed rule was inconsistent, and 4663 exposed it.** Within half an
hour of a clean verification the Robinhood leg went to 1/12 availability while
Ethereum stayed at 12/12 on the same key, *and* 4663's own instance was down
simultaneously — so the fault is that chain's indexer and there is nothing to fail
over to. Under the old rule that any unreadable chain fails the whole scan, roughly
nine in ten genesis allocations would have failed. The rules did not agree with each
other: a history longer than the request budget was allowed to yield a flagged
lower bound, while an unreadable chain was fatal, though both are the same
under-count. What differs is how much each can hide, and it is not uniform — an
unreadable Ethereum can conceal 24 ETH, whereas a busy 4663 account's fifty latest
transactions totalled 0.00403 ETH, 8 % of the eligibility floor and 0.4 % of the
cap. So the policy is now per-chain: the four majors stay fatal, Robinhood degrades
to a lower bound that sets `truncated` and is named in the API response so the UI
can say which history is missing. **Adversarially this is sound in the direction
that matters** — someone who could make 4663 appear unreadable would only reduce
their own total, and there is no configuration of this that awards more. Nine
mutations on the policy, all caught, including flipping any major chain to optional
and reporting an unreadable chain as cap-skipped (which would imply the total was
complete).

With that, PM-F9 is closed. What is not closed and now sits on PM-C7: nobody has
clicked the assembled two-phase flow on a real deployment, and the key has to be in
Vercel Production before they can.

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

*Unbounded `setDefaultSoftCap` / `setMaxPogAllocationLimit` — recorded here, then
**closed in §5.15**; the reason given below did not survive the same day.* Both
were floored and neither capped: `setDefaultSoftCap` rejects below
`MIN_SOFT_CAP_PROD`, `setMaxPogAllocationLimit` rejects only zero. Both are
`onlyOwner`, and the owner is the 2-of-3 Safe, so this is not an unprivileged
path. It was recorded rather than closed for two reasons. Contracts under `src/`
are frozen for the engagement (§0), and a ceiling is precisely the kind of change
that should not land between freezing the scope and handing over the commit hash.
And the interesting part is not the missing bound in isolation but that
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
is worth an auditor's attention as one question rather than two.

**Superseded.** The freeze argument above was true when written and false a few
hours later: `setLaunchFee` got `MAX_LAUNCH_FEE` in the same file on the same day,
which left three setters of one kind — one bounded, two not — behind a single
shared explanation. §5.15 closes both and records what choosing the numbers turned
up. The compounding with PM-F9 is unchanged and still the auditor's question; what
is no longer true is that nothing bounds the dial.

**Scope.** This sweep covered the off-chain surface only: API routes, RLS
posture, the PoG signing path, and the factory/clone libraries. The
`ToshLaunchpadHook` and `ToshLadderTreasury` reviews queued alongside it did not
run, so §1.1's "largest attack surface in the system" remains covered only by
§5.7's Slither pass and the test suite, not by this sweep. **That gap is closed
in §5.11.**

---

### 5.11 Seventh sweep — the surface §5.10 admitted it had skipped

`ToshLaunchpadHook` (2,439 lines, 40 external/public members) and
`ToshLadderTreasury` (710 lines, 18) read by hand, 2026-09-05. §5.10 recorded
that this review had been queued and had not run; this is it.

The sweep was directed rather than linear: the properties chosen were custody of
genesis ETH, the phase state machine, the V4 callback surface, the transient
mutex, and the buyback price bound. **One live defect was found, and it is not in
`src/`** — it is in the check that holds a deliberately-accepted `src/` risk shut.

#### The finding — `STATE-07` could be silenced by one failing call, and the silence did not page

`_buybackSqrtFloor` reaches **unbounded** (`MIN_SQRT_PRICE + 1`) by two doors, and
they are eight lines apart:

```solidity
try IToshHookTwap(address(key.hooks)).twapSqrtPriceX96() returns (uint160 twapSqrt) {
    if (twapSqrt == 0) return unbounded;          // door 1 — watched
    ...
} catch {
    return unbounded;                             // door 2 — not watched
}
```

The contract's own natspec is emphatic that the unbounded fallback is held shut
**off chain** — "an operational rule nobody checks is not a control. This is the
check" — and names `STATE-07` as the control. `STATE-07` watched door 1 only.

Two defects, one root:

1. **The loop was fail-open across tokens.** Every read sat on a single outer
   `try`, so one throw — a reverting hook, or a plain RPC hiccup on index 0 —
   aborted the loop and left every LATER token unchecked. A twenty-token ladder
   could be blinded nineteen-twentieths by one bad call, and the output named
   neither the count nor which indices were skipped.

2. **A revert is the same hazard as a zero, and was reported as neither.** Since
   the `catch` returns unbounded exactly as the zero branch does, a hook whose
   `twapSqrtPriceX96()` reverts has no anti-sandwich bound. That case fell into
   the generic handler as `record('STATE-07', 'P1', false, …)` — **hardcoded
   non-paging** — while the identical consequence via door 1 pages at P1. The
   message read "ladder TWAP check failed", which a human parses as "the monitor
   is unwell", not "a listed pool has no price bound right now".

Together: the only control on a risk measured at **0.93 ETH forfeited per leg,
repeatable per block** (`test_probeG3_immatureTwapIsRefusedAtListing`,
`pokeBuyback` has no cooldown) could be turned off by a single reverting call,
without paging anyone.

**Fixed** in `monitoring/watch.mjs`: per-token isolation, a reverting hook now
pages with the same severity as a zero reading and says why the two are the same,
an unresolvable entry names its index and count so a skipped token is never
silent, and the generic handler is narrowed to the one case that really is a
monitor fault — the token list itself being unreadable, where nothing downstream
was checked.

**Verified by 13 assertions** in `monitoring/state07.test.mjs`, which stubs a
three-token ladder — one healthy hook, one that reverts, one reporting zero —
because the ladder is empty on both live chains and the loop body never executes
against a real one. Two of the thirteen are load-bearing: restored to its pre-fix
structure, the script **never reports the zero-TWAP token sitting after the
revert, and pages for nothing at all**, so the other eleven cannot pass
vacuously.

That test file is committed, which no other harness in this repository is. The
reason is the same argument `alerts.json` makes for the check existing at all: an
operational rule nobody checks is not a control, and a control nobody tests is
not one either. It is an operator command rather than a CI gate — it runs the real
script, which reaches an RPC for everything it does not stub.

This also corrects §2.5, which recorded the 2106 `uint32` wrap as failing loudly.
It does, on the mint path. On the buyback path the same `catch` swallows it. See
the note there.

#### Design claims that were checked and hold

Recorded so the engagement does not spend hours re-deriving them, and so that a
future change that breaks one is visible as a change to a claim:

| Claim | Verdict |
|---|---|
| Treasury is a one-way valve — no `withdraw` / `sweep` / `rescue` / `delegatecall` | **Holds.** The only ETH exit is `settle{value: spent}` inside `_buyAndBurn`; the only token exit is `take(…, DEAD_ADDRESS, …)`. No path pays the owner. |
| The transient mutex cannot read clear mid-leg | **Holds.** `_setPiggyback(true)` precedes the loop and `(false)` follows both the loop and the `currentCursor` write; `_buyAndBurn` is reachable only through `executeBuyAndBurn`, which is `onlySelf` and called only from inside that window. |
| A stranger cannot open a second pool naming this hook | **Holds, and on one bit.** `beforeInitialize` reverts unless `sender == address(this)`, and it is only ever called because `BEFORE_INITIALIZE_FLAG (1 << 13)` is in the mask. Decoded: `0x20CC` = bits 13, 7, 6, 3, 2. **This matters because no callback validates the inbound `PoolKey` against `_key()`** — the tax skims in `_skimInputTax` / `_skimUnspecifiedInput` `take` against the `key` they were handed. The mask has already moved twice (`0x2200 → 0x20C8 → 0x20CC`), so the question is whether a third move could drop bit 13 quietly. It cannot: `test_hookMiner_requiredFlagsAre0x20CC` and `test_minedHookAddress_carriesV5FlagMask` assert against the **literal** `0x20CC`, not against `HookMiner.REQUIRED_FLAGS`, so editing the constant turns both red rather than mining a hook the tests then bless. |
| `unlockCallback` cannot be driven by a third party | **Holds.** V4 delivers the callback only to the address that called `unlock`, and the hook's sole `unlock` call site is inside `launch()`. One action code exists; anything else reverts `UnknownAction`. |
| `refund()` and `launch()` cannot both be open | **Holds, and this is why `refund()` does not decrement `totalEthDeposited`.** `softCapFailed` is `totalEthDeposited < softCap()` and `launch()` requires `>=`, so leaving the total frozen is what keeps the two mutually exclusive; decrementing it would let refunds walk the total below the cap and re-open the refund door on a launchable round. The zombie door uses strict `>` against `launch()`'s `<=` on the same instant, so they do not overlap either. |

#### Reported by the sweep, already triaged elsewhere — not new

Listed so they are not re-filed as findings: the unbounded buyback in a pool's
first 1800 s (§2.3, ACCEPTED and held off chain — this sweep's contribution is
that the control holding it now works), owner curation of buyback targets (§2.3,
governance surface: the owner picks markets, never wallets), ETH stranded when
the ladder is emptied (§2.4, the accepted cost of having no sweep), the quiet-pool
TWAP returning `lastTick` (§5.2 #2, deliberate — over a window with no trade
`lastTick` *is* the average, exactly), and same-block mint lockout griefing via a
dust swap (the flip side of §5's finding 1, which made buyback swaps stamp the
lockout on purpose; costs the griefer a swap per block and delays a mint by one
block).

One cosmetic defect, **accepted on its merits rather than on the freeze**:
`PiggybackExecuted` emits `perToken * count` regardless of whether a leg was
skipped or partially filled, so it overstates ETH deployed. `BuybackBurned`
carries the true figure. This matters only for off-chain accounting, and the two
places that consume the event — `STATE-02` and `STATE-06` — use it as a *presence*
signal rather than an amount, so neither is misled.

> Re-checked 2026-09-06 (§0.4), because the original wording was "not worth a
> code change under the freeze" and that reason has evaporated. The disposition
> is unchanged, but it now rests on the two sentences above — a truthful sibling
> event and two consumers that read presence — rather than on a scope freeze.
> Unlike the `MIN_SOFT_CAP_PROD` comment, this one is a payload change in code
> and would need its own test, so it is accepted rather than done.

#### The two areas this sweep first excluded, then covered

The paragraph below originally deferred the tier pricing algebra and the
exact-output tax to the engagement. Both were then done. **Neither produced a
defect**, which is worth recording precisely, because the useful output of a
sweep that finds nothing is the set of numbers nobody has to re-derive.

**Ladder pricing — every rounding runs one way, and the margin is measured.**
`tierPriceAt` is `shelfP0 · STEP^index` by exponentiation-by-squaring over
`FullMath.mulDiv`, which floors. So the price is *understated*, never overstated:
the truncation favours the buyer. On the mint path the same direction holds —
`legCost = (tierPrice · take) / 1e18`, floored, at most 1 wei per leg and bounded
to 32 by `MAX_TIERS_PER_TX` — and it cannot compound into a free mint because
`cost == 0` reverts.

The property that could actually break is **monotonicity**: two adjacent shelves
priced identically would let a buyer clear the upper one at the lower one's price.
The break-even is exact and was computed rather than estimated — at
`shelfP0 = 525` wei the step to shelf 1 rounds to **0 wei**; at 526 it is 1 wei.
The smallest `shelfP0` the system can produce is fixed by
`ToshFactory.MIN_SOFT_CAP_PROD` (0.01 ETH → `p0 = 2.38e9` → `shelfP0 ≈ 2.5e9`),
where the step is **4,756,270 wei**. That is a margin of 4.75 million to one, and
`testFuzz_tierPriceAt_strictlyMonotone` fuzzes the base from `1e6` — itself 2,500×
below the reachable minimum and 1,900× above the break-even. The property is
tested well outside its operating range, and `setDefaultSoftCap`'s floor is what
keeps the operating range where it is (`test_setDefaultSoftCap_rejectsBelowFloor`).

**One finding, in a comment rather than in code.** `MIN_SOFT_CAP_PROD`'s natspec
says it "guards the `p0 = 0` configuration trapdoor" and offers as
defence-in-depth that "the hook's `launch()` also asserts `p0 > 0`". The floor
guards strictly more than that, and the stated backstop does not reach the wider
case. Measured by mutation: dropping the floor to 1 gwei yields `p0 = 238` and
`shelfP0 = 249` — `p0` is non-zero, so `launch()`'s assert passes, yet 249 is
below the 526-wei break-even and shelves 0 and 1 come out at the same price.
So the flattening cliff sits far above the `p0 = 0` cliff, and the only thing
between the system and a flat ladder is the `MIN_SOFT_CAP_PROD` literal itself.
The constant's real job is pinned by the new test, which fails on all four
mutations of the three constants (4/4).

> **Re-disposed 2026-09-06 — the comment is now fixed (§0.4).** This paragraph
> originally ended "`src/` is frozen for the engagement, so the comment is not
> being edited." That freeze was an audit engagement, it has been cancelled, and
> it never bound `src/` pre-mainnet anyway: `ToshFactory` is deployed by nonce
> rather than by CREATE2, so editing its comments moves neither its own address
> nor the `hookInitcodeHash` the salt miner reads at runtime. The natspec on
> `MIN_SOFT_CAP_PROD` now names flattening as the binding cliff and explicitly
> withdraws `launch()`'s `p0 > 0` assert as a backstop for it — the claim this
> sweep found false. Leaving a finding in a document while the contract keeps
> asserting the opposite is how §5.18's drift started.

**The price ceiling can only block, never underprice — and the reason is the
`min`.** §2.3 asserts this; here is why it holds. `_safeReferencePrice()` returns
`min(spot, slow)`, where `slow` is `p0` until the TWAP matures and the TWAP after.
Pushing spot *up* therefore cannot lift the reference above `slow`, so it cannot
admit a shelf the ladder had priced out; pushing spot *down* lowers the reference
and only tightens the gate. Admitting a higher shelf requires moving the TWAP,
which is 1800 s of sustained manipulation — the assumption the design already
declares.

**Exact-output tax — no double charge, and the sign is right.** `beforeSwap`
returns `ZERO_DELTA` whenever `amountSpecified >= 0` and `afterSwap` skims only
when `> 0`, so exactly one of the two taxes any swap; the branches are mutually
exclusive on the sign, not by convention. The settlement was checked against
v4-core rather than assumed: `Hooks.sol:307-312` builds `hookDelta` and applies
`swapDelta = swapDelta - hookDelta`, so the hook's positive return debits the
*swapper*, which is what the natspec claims. The hook's own account nets to zero —
`poolManager.take` debits it by `tax`, the returned `+tax` credits it back — which
is why the unlock settles.

Re-deriving the effective rates from scratch reproduced the figure §5.3 already
records: exact-input pays **100.0 bps** of what the trader hands over, exact-output
**99.01 bps**, because one rate is inclusive of the specified amount and the other
is charged on top of the pool's input. An independent derivation landing on the
documented number is the result worth having here.
`test_buyTax_exactOutputSkimsEthNotTokens` already encodes the same distinction in
code, computing its base as `ethSpent − skim`.

**Scope of this sweep.** By hand, both contracts, the five properties above plus
the two just described. Still NOT covered, and staying with the engagement: the
tier ladder as an *economic* model rather than as arithmetic — whether a 2,000×
span over 4,000 rungs is the right shape for this token's demand curve is a
question about markets, not about `mulDiv` — and anything requiring a live
adversarial fork.

---

### 5.12 Eighth sweep — the rest of `src/`, by hand

`ToshFactory` (855 lines) had never had the treatment §5.11 gave the hook and the
treasury. It had been touched piecemeal — the setter ceilings in §5.10, the
`nonReentrant` note in §3, the signature path named in §1.2 — but never read end
to end, which left the contract that holds ownership, the PoG ledger, the
blacklist, the kill switches and the CREATE2 gate as the last large unswept
surface. Read 2026-09-05, together with `ToshToken` (184), `ToshCloneLib` (320),
`HookMiner` (119) and `HookDeployLib` (79). **With §5.11 this completes a by-hand
pass over all of `src/`.**

**No defect in the contracts. Three in the documents that describe them**, all of
the kind that makes a control unverifiable rather than wrong — and one of the three
was found only after the guard written for the first two was widened.

#### The findings — three documents pointed at symbols that resolve nowhere

§1.2 scoped in "the on-chain signature verification path in `ToshFactory`
(`registerPoG`, `_verifyPoGSignature`)". There is no `_verifyPoGSignature`, in
`src/` or in `test/`, and there never has been: `registerPoG` builds the digest
and recovers it inline in three lines. On its own that is a stale name in a scope
paragraph, worth fixing so an auditor does not go looking for code that is not
there.

What made it worth calling a finding is the second reference.
`INCIDENT_RESPONSE.md` §Q4 — the annual red-team drill against forged PoG
attestations — stated its pass criterion as "all attempts fail at
`_verifyPoGSignature`". **That criterion cannot be observed.** You cannot watch
attempts fail at a function that does not exist, so the drill could be recorded
as passed by anyone who did not go looking, and nothing in the sentence would have
contradicted them. It is the same shape as the `STATE-07` defect in §5.11: not a
control that is wrong, a control whose success condition nobody could actually
check. Q4 had never been run, so nothing false had been recorded — and it has
since been run against the live testnet factory on the strength of the rewritten
criterion: 15 vectors, 22 calls, every one refused, quotas unmoved.
`INCIDENT_RESPONSE.md` §8.4 has the sitting, `scripts/drillQ4.mjs` the harness.
Running it corrected the criterion twice more, both times in my wording rather
than in the contract: it had named only the factory's own errors, missing the
three OpenZeppelin `ECDSA*` reverts that fire from inside `recover` before any
address exists to compare, and its brute-force vector was non-deterministic in a
way that pinning a seed would have hidden.

Both are fixed. §1.2 now names `registerPoG` alone with the file and line of the
recover, and Q4's criterion is now something a drill can actually produce: every
attempt reverts out of `registerPoG` with `InvalidSignature()` — or
`NonceConflict()` / `SignatureExpired()` / `SignatureTooLong()` for a replay or a
stale deadline — and `pogQuota` is unchanged for every address tried. The quota
assertion is the part that makes it a test rather than a log inspection.

**Then the same probe found a second one**, which is what turned this from an
accident into a class. §4's invariant-coverage notes credited the shelf ladder to
`mintFromShelf`; the function is `mintBondingCurve`. The claim it decorated was
still true — there is no shelf-mint action in the invariant handler — so only the
name was wrong, but an auditor checking the claim would have searched for nothing.

Two stale symbols in one pass, in prose no compiler reads, is worth a guard rather
than a correction. `scripts/checkDocSymbols.mjs` extracts every backticked
identifier from the three documents where a dangling name has a security
consequence — the dossier says what to review, the runbook says what to check
under pressure, the monitoring doc says what the alerts mean — and fails the build
on any that resolves nowhere in the tree. 305 identifiers currently pass. Names
the docs mention *because* they are absent (`_headers`, `webSocket()`, and the
findings above) sit in an allowlist that requires a reason per entry; dropping one
turns the build red, which is checked.

**The guard found a third, of a kind not anticipated.** Its first version only
matched lower-case-initial names, which read straight past every custom error —
and Q4's pass criterion in the runbook is built almost entirely out of error
names, so the guard was blind to the very sentences that had just been rewritten.
Widening it to upper-camel names took the checked set from 182 to 261 and
immediately failed on `EthNotTokens`. That one was not a rename: the real test is
`test_buyTax_exactOutputSkimsEthNotTokens`, and a line wrap in §5.11 had split it
across two lines with backticks closed around each half. The first half greps
clean because it is a genuine prefix, so only the second half dangled. It reads
perfectly to a human, cites a test that exists, and points at nothing — the
failure mode a spell-checker cannot see and a compiler never reads.

The guard's first version was itself broken, and its mutation harness is what
found that: naming `_verifyPoGSignature` in its own header comment made the symbol
"exist", so the guard reported clean on the very drift it was written for. It now
excludes its own file. That was not the last of it: the same harness, pointed at
the `EthNotTokens` fix, then found the guard's largest blind spot and a second way
for it to pass on absent symbols. Both are recorded below because each had
survived a round of hardening.

**Blind spot: it checked no test names at all.** The candidate filter dropped any
identifier with an interior underscore, on the reasoning that those are env vars
and `SCREAMING_SNAKE` constants. Every Foundry test is named *test_thing_doesWhat*,
so the rule silently excluded the entire class — and a
cited test name is the most common form of *evidence* in this dossier. "Fixed, see
*test_x*" rests completely on that test existing, which makes a dangling test name
worse than a dangling function name, where the surrounding sentence is usually
narration. A single lower-case letter anywhere already separates the env vars, so
the underscore rule bought nothing. Removing it took the checked set from 261 to
305; all 44 newly-visible names resolve, so no further drift was hiding there, but
the class had been unguarded since the guard was written.

**Second hole: generated artifacts were vouching for deleted code.** With test
names in scope, renaming a real test in `test/` *still* left the build green.
`gasreport.txt` is tracked, 130 KB, and lists the name of every test that existed
when it was last regenerated; `slither-baseline.json` embeds source snippets the
same way. Either one keeps a deleted symbol resolving indefinitely — precisely the
failure the guard exists to prevent, a document citing a test that is gone, passing
because a stale report still mentions it. Regenerating the artifacts is not a fix,
since the next deletion reopens the window until someone regenerates again; they
are now outside the haystack.

**A fourth instance of the original drift, in shipping code.** Chasing why one
mutation would not fail showed `_verifyPoGSignature` still resolving from two
files. One is `scripts/drillQ4.mjs`, narrating the finding, which is expected. The
other was `soat-frontend/src/app/api/sign-allocation/route.ts`, whose comment
asserted that the signing digest "matches the on-chain `_verifyPoGSignature`
recover path" — a claim about the contract, in production code, resting on a
function that never existed. Corrected to name `ToshFactory.registerPoG`. This also
exposes a limit worth stating plainly rather than discovering later: because
"exists somewhere in the tree" counts comments, a genuinely absent symbol can be
vouched for by the very prose describing its absence. The guard cannot close that
without parsing, and pretending otherwise would be the same species of claim
§5.12 is about.

15 of 15 mutations behave as specified — one invented name per gated document to
prove all three are read, one invented *error* name for the class the upper-camel
widening added, one invented *test* name for the class the underscore fix added, a
real test renamed in `test/`, the same rename with a stale `gasreport.txt` still
naming it, one line-wrap split reproducing `EthNotTokens`, one planted in the
guard's own prose to prove the self-exclusion holds, an allowlist pair (covered
name silent, entry dropped goes red), and four controls — a real function, a real
error, a `SCREAMING_SNAKE` env var, and a real test name — that must stay silent,
the last of them there so the widening cannot be paid for in false positives.

**And it had never once run in CI.** Everything above was measured on a laptop.
The guard shelled out to `rg`, ripgrep is not on the GitHub runner image, and so
from the commit that introduced it every push failed with
`check:doc-symbols could not run ripgrep — spawnSync rg ENOENT`: five consecutive
red `CI` runs, while five commit messages and five sweeps of this dossier reported
the guard as green. The step sits late in a seven-minute job behind a fork-test
suite, which is why nobody looked, and the `Frontend` workflow stayed green
throughout, which made the repository look half-healthy rather than broken.

Failing closed was the one thing it got right — the guard did not pretend to pass,
it refused to run, and exit 2 is a distinct code precisely so this case is not
mistaken for a clean sweep. What was wrong is that it depended on a binary nobody
had declared, and that the dependency was invisible on the machine where it was
written. A guard that only runs where its author sits is not a CI guard, and its
findings should not be quoted as if CI had confirmed them.

The haystack is now assembled with `git ls-files`, which the checkout already
depends on: `--cached --recurse-submodules` plus `--others --exclude-standard`,
which is the precise equivalent of what ripgrep scanned — tracked files, plus
untracked ones that are not ignored. That equivalence is load-bearing in both
directions and neither half was obvious. Ripgrep honoured `.gitignore` for free,
which is what kept `.next/` and `out/` out of the haystack; and it descended into
the `lib/` submodules, where `ProtocolFees`, `SignedMath`, `feesAccrued` and
`hookDelta` live. A first version without `--recurse-submodules` reported all four
as invented — four confident, false findings a reviewer would have acted on, which
is why the replacement was diffed against the ripgrep result rather than merely
run.

10 of 10 mutations behave as specified, split deliberately across both directions:
three prove the haystack still reaches `src/`, the `lib/` submodules and
`soat-frontend/`, so the guard can still find things; five prove it refuses to be
vouched for by `gasreport.txt`, a Slither report, its own prose, another gated
document, or gitignored build output — every exclusion re-expressed as a path
regex, and a regex that fails to match its path would have silently re-armed the
holes above while still printing OK; one proves an invented name is still
reported; and one proves an empty haystack is exit 2 rather than a pass.

The mutation harness caught itself first, which is worth recording. Sitting
untracked-but-not-ignored at the repository root made it part of the haystack, so
the sentinel name written as a literal in the harness vouched for itself and all
five "must be reported" cases came back green. That is the same self-reference the
guard's own header describes, met by accident from the other side; the sentinel is
now assembled at runtime so the literal never appears in the file.

`PRD-v5.0.md` and `ROBINHOOD_MIGRATION.md` are deliberately outside the gate — a
stale name in a product spec is a nit, not an unverifiable control — and they are
**not** clean. Running the probe across them found three UI symbols absent from
all of `soat-frontend/`: `feeMode`, `handleDeposit` and `handleMineSalt`, cited
with precise line ranges against a launch page that now exposes a single
`handleLaunch`. Recorded here rather than allowlisted, because an allowlist entry
would make it look handled. Repairing those sections is a product-spec job.

> **Superseded by §5.18.** The reason given above — that the repair is a
> product-spec job, and therefore not this sweep's — was never sized. It came to
> nine stale references, not three, and four of them turned out to be the
> document describing defects the code had already fixed. `PRD-v5.0.md` is now
> gated and chapter 6 is rewritten. `ROBINHOOD_MIGRATION.md` stays outside, for
> the different and better reason that its names are meant to read as history.

#### Six hypotheses that died on contact

Recorded because a dismissed hypothesis is the part of a clean sweep that has
value — it is what the engagement should not have to re-derive.

| Hypothesis | Why it fails |
|---|---|
| PoG attestations replay across chains, contracts, or via signature malleability | The digest is `abi.encode(msg.sender, maxAlloc, nonce, deadline, address(this), block.chainid)` — sender, contract and chain are all in the domain, `abi.encode` leaves no packing ambiguity, and OZ's `recover` rejects a malleable `s`. The nonce is per-sender, strictly sequential, and consumable only by its own sender, so no third party can burn it. |
| `eligibility()` drifts from `_rollQuotaWindow()`, whose logic it re-implements without calling | The mirror matches on all three branches (`duration == 0`, window lapsed, window live). It is also pinned end-to-end rather than by inspection: `test_pogQuota_refillsAfterTheCooldownWindow` reads `eligible == false` before the boundary and `remaining == 0.3 ether` after it, then performs the deposit the view promised. |
| A creator's mined salt can be front-run | `finalSalt = keccak256(abi.encode(msg.sender, hookSalt))`. A thief's `msg.sender` yields a different salt, a different address, and almost certainly one that fails the flag mask. |
| The hook can be made to renounce `MINTER_ROLE`, bricking supply forever | `ToshToken` leaves `DEFAULT_ADMIN_ROLE` vacant, so `renounceRole` is the only surviving door and only the hook may walk through it. The hook has no arbitrary-call surface: the only `.call` in the hook, factory or treasury is `_sendEth`, whose calldata is the empty string, and none of the three contains a `delegatecall`. The Immutable Pact holds. |
| A reverting `receive()` on the ladder treasury blocks `createLaunch` platform-wide | The treasury's `receive()` is a single `emit` with no revert path and no external call, and `_sendEth` forwards all remaining gas. |
| `genesisDuration` truncating to `uint32` lets two durations share an initcode hash | Already fixed: `cloneInitcode` reverts `DurationTooLargeToPack` above `type(uint32).max`, alongside `CapTooLargeToPack` for the two caps. The comment names the real reason — `initcodeHash` is the public view the frontend mines salts against — rather than the deployment. |

**Two observations for the engagement, neither a defect.**

*The mask is checked on a predicted address, never on the deployed one.*
`createLaunch` computes `predictedHook`, gates the V4 flag mask on it, then
CREATE2s through a separate call and compares the result only against
`address(0)` — the two addresses are never checked against each other. They
cannot diverge today, because `initcodeHash` and `deployHook` both derive their
bytes from the one `cloneInitcode` and the factory hands them identical
arguments. But that is an invariant held by convention across two call sites, and
§5.11 established that bit 13 is the single thing stopping a stranger from
opening a second pool against a hook. What actually pins it is a test, not the
contract: `test_minedHookAddress_carriesV5FlagMask` asserts the mask on the
address `createLaunch` really returned.

*Almost every deployed hook carries callback flags nobody asked for.*
`isValidHookAddress` requires the `0x20CC` bits to be SET; it does not require the
other nine low bits to be CLEAR. Enumerating the low 14 bits under the required
mask and V4's two return-delta dependency rules gives 288 legal patterns, of which
exactly one is `0x20CC` alone — so **99.65 % of hooks are deployed at addresses
that enable extra callbacks**, and which ones is a property of the salt the
creator happened to mine. This is harmless only because all ten `IHooks` members
are permissive: three do the real work (bits 13, 7, 6), and the other seven either
return their own selector or, in `beforeRemoveLiquidity`'s case, pass through
deliberately (§5.11's LP-withdrawal claim). It is worth stating plainly because
the tempting "hardening" — making an unused callback revert — would brick launches
non-deterministically, depending on each project's salt, which is close to the
worst failure mode to diagnose. `ToshV5Guards.t.sol:568-612` pins all seven and
turns red first. Note in passing that `beforeRemoveLiquidity` carries
`onlyPoolManager` while the six selector stubs are bare `pure` functions; the
asymmetry costs nothing, since a no-op is no more dangerous for being callable.

**Scope.** By hand, the five files named above. Nothing was added to `test/`:
every contract property this sweep would have pinned already had a test, and that
is the result rather than an omission. What it added instead is one CI guard, over
the documents — which is where the sweep's only defects were.

---

### 5.13 Ninth sweep — the other half of Q4, and the read nobody was charged for

With `src/` reviewed by hand and Q4 drilled (`INCIDENT_RESPONSE.md` §8.4), the
obvious next question is the complement of the one Q4 answers. Q4 shows the chain
refuses a *forged* attestation. It says nothing about whether an attacker can
obtain a **genuine** one for quota they never earned — and that path is entirely
off-chain, in code written after the last sweep: `gasHistory.ts` (784 lines) reads
five explorers to decide a wallet's historical spend, `/api/pog-scan` runs it as a
job, and `sign-allocation` signs whatever the finished job says. If the scan
over-counts, the signature is valid, `registerPoG` accepts it, and every guarantee
Q4 established is beside the point.

#### The over-award question, and why the answer is no

Walked deliberately looking for a way to make the total too large, since the whole
design is stated as "every bound can only under-award":

- **Direction filtering.** v1 `txlist` cannot filter by sender — `filter`,
  `filter_to` and `direction` are accepted and ignored — so the from-side check is
  the module's own, and it is applied on both dialects even where the server
  claims to have done it. Without it the metric would be "gas that happened to
  arrive at this address", which is the error `gas_usage_count` makes and the
  reason it is unused despite costing one call.
- **Window overlap.** `startblock` is inclusive, so the boundary block appears in
  two consecutive windows. Hashes from the previous window's last block are
  remembered and skipped, and the set holds one block rather than the whole
  history. A block wider than `V1_PAGE_SIZE` cannot advance the cursor, which
  terminates as `truncated` — an under-count, in the safe direction.
- **Probe-then-fall-through.** A chain is probed with one exact v2 page and only
  re-walked with v1 if a second page exists. The probe's rows are discarded rather
  than added to the v1 total, so the two fee bases never mix.
- **Cross-chain arithmetic.** The sum is wei of real fees, not transaction counts,
  so the four cheap chains offer no arbitrage against Ethereum: earning a wei of
  credit costs a wei of gas wherever it is spent. With a 1 ETH cap producing at
  most 0.1 ETH of allocation, spending to farm quota loses money by construction.
- **Who can spend the budget on whom.** `POST` requires the same EIP-191 wallet
  signature `sign-allocation` requires, so a scan can only ever be started for an
  address the caller controls; and the job key is `keccak`-free but lower-cased in
  `keyFor()`, so the mixed-case trick that produced H-2 in §5.10 does not recur.
- **Staleness.** `sign-allocation` refuses anything that is not a `done` job
  inside `RESULT_TTL_MS`, so an hour-old figure cannot be signed against.

No over-award path found. That is the sweep's result on the question it set out to
ask, and the reason the finding below is about availability instead.

#### The defect — the one handler in the app with no ceiling

`GET /api/pog-scan` had no rate limit. The comment above it explained why: "the
asymmetry is deliberate — writes cost us money, reads do not."

Reads cost. A GET spends one Upstash command inside `readScanJob` *before* it can
establish that the address is unknown, and two once the job is `done`, because
`present()` reads the live rate through `getGasToSatoRate()` — which has no cache
and goes to Redis on every call. Unauthenticated and unbucketed, this was the
cheapest lever in the application on the one store everything shares.

Which store it is, is what turns a bill into an outage. Upstash also backs the
rate limiter, and `consumeRateLimit` answers a store failure by falling back to
per-instance counting for `BREAKER_COOLDOWN_MS`. In that state `pog-scan:global`
— the 120/hour ceiling sized specifically to protect the Blockscout daily credit
budget — is no longer global at all, because each serverless instance counts
alone. The rest of the chain is already written down in the route's own header:
credits exhausted, `CREDIT_RESERVE` refusing every new scan, and genesis
allocation closed for everybody. The file describes that outcome as "a denial of
service on the launch that we deliver to ourselves", and left the cheapest route
to it unmetered.

It is also inconsistent with the codebase rather than a judgement call. Every
other GET here is throttled, and `admin/config`'s carries a comment describing
this exact case — public data, no auth, "still throttled to fend off scrapers".

**Fixed.** `GET` now charges a `pog-scan-get` bucket before it touches the store,
sized against the client rather than guessed: `PogScanButton` polls every 2 s for
at most 135 s, so roughly 0.5 req/s and ~68 reads per scan, against a bucket of 60
refilling at 10/s. The header's justification was corrected rather than deleted,
because "the data is public" settles authentication and says nothing about
throttling, and conflating the two is what left the hole.

Six tests, and the trap they exist to pin is the fix itself: reusing the POST
bucket — three tokens refilling once a minute — would have throttled a single
scan's own polling on the second request, so a fix for an abuse path would have
broken the ordinary one. That is asserted directly, along with the charge
happening before the store read (otherwise refused requests still cost the thing
being conserved) and the 429 carrying CORS (a refusal a browser cannot read is
indistinguishable from an outage, and the client retries into it). 4 of 4
mutations caught: the bucket deleted, the bucket reused from POST, the charge
moved after the store read, and the refusal returned without CORS. The first
attempt at the third mutation was reported MISSED and was wrong — it inserted the
gate after the address validation but still ahead of the store, so behaviour had
not changed and the tests were right to stay green.

**Scope.** By hand: `gasHistory.ts`, `scanJobStore.ts`, `/api/pog-scan`, and
`sign-allocation`'s allocation-derivation path. Not covered: the arithmetic of
`computeMaxAllocFromWei` and the band coherence it asserts, which §5.9 examined;
and the OP-stack L1-fee shortfall, which is a stated under-count rather than a
defect. One asymmetry noticed and left alone: CI has a floor guard against the
Foundry suite shrinking (351) and none against the frontend suite, which now
stands at 152.

---

### 5.14 Tenth sweep — the settings, as a surface

Every sweep so far has followed a code path. This one followed a *number*: the
platform's configuration, taken as one surface rather than per-file — the owner
setters on the factory and the ladder treasury, the compile-time constants in
`src/`, the constants the frontend restates, and the environment variables. The
question was not "is this value right" but "how many places decide it, and do they
agree".

That framing is what found the defect. Both findings below are the same shape, and
neither is visible from inside a single file.

#### The attestation deadline: one number, two signers, one of them broken

`ToshFactory.registerPoG` bounds the deadline on both sides, and the upper side is
strict:

    if (deadline > block.timestamp + MAX_SIG_VALIDITY) revert SignatureTooLong();

Sign `deadline = signerNow + T` and the bound fails exactly when
`signerNow - block.timestamp > MAX_SIG_VALIDITY - T`. So **the headroom a signer
leaves under the ceiling is the clock skew it tolerates**, and a TTL equal to the
ceiling tolerates none.

`sign-allocation` had worked this out and given itself an hour, with a test and a
long comment explaining why. `computeDeadline()` in `pogQuota.ts` — the shared
helper, and the only thing `scripts/pogSigner.ts` calls — still returned
`nowSec + SIG_VALIDITY_SECONDS`, the ceiling exactly, with no test at all. The
route's comment was therefore true of one signer and false of the other, and had
been since the margin was added.

Measured rather than argued, with `scripts/probeDeadlineMargin.mjs`. The bound is
checked before the nonce and before `recover` — blacklist, then this, then expiry,
then nonce, then the cap, then the signature — so an `eth_call` with a junk
signature reveals which gate a given deadline lands on, and bisecting the deadline
locates the threshold instead of guessing at the timestamp a node uses for a call.
Against the live 46630 factory, from a host whose clock sat 3 s ahead:

| signer | TTL | tolerated skew | gate reached |
|---|---|---|---|
| `computeDeadline()` → `pogSigner.ts` | 86400 s | **0 s** | `SignatureTooLong` |
| `sign-allocation` | 82800 s | 3600 s | `ECDSAInvalidSignature` — gate cleared |

Reaching a *later* revert is what a cleared gate looks like here; reaching
`SignatureTooLong` is the defect, observed, not derived.

The failure mode is worth stating because it is the reason this survived: it is not
a slow path or a degraded one. While the skew lasts, *every* CLI-issued
registration reverts, under an error name that points at the signature's length
rather than at a clock — so nothing in the pipeline names the host that is wrong.

**Fixed** by making the headroom one decision instead of two. `pogQuota.ts` now
exports `ATTESTATION_HEADROOM_SECONDS` and `ATTESTATION_TTL_SECONDS`;
`computeDeadline()` uses the latter, and `sign-allocation` imports it rather than
deriving its own. `assertPogBandCoherent()` gained the deadline relationship
alongside the allocation one, since both are relationships between numbers that
live apart and both have now drifted once. A new `pogQuota.test.ts` (10 tests)
transcribes the on-chain predicate and asserts the tolerated skew equals the
headroom, reads `MAX_SIG_VALIDITY` out of `src/ToshFactory.sol` so the mirror is
verified rather than restated, and asserts the route still imports the shared TTL.
6 of 6 mutations caught, including the original defect and a 1-second headroom that
would satisfy "has margin" while tolerating nothing.

This is the second time these two signers diverged on a number they share; the
first was the exchange rate, in `gasToSatoRate.ts` (§5.9, item 7).

#### Seventeen mirrored constants, four of them checked

`contracts.ts` restates the genesis supply split, the tier ladder, the price
ceiling, the TWAP and launch windows and the genesis durations from
`ToshLaunchpadHook.sol`, plus `MIN_SOFT_CAP_PROD` and `MAX_COOLDOWN` from the
factory; `pogQuota.ts` mirrors `MAX_SIG_VALIDITY`; `hookMiner.ts` keeps a second
copy of the three durations. Of all of it, four values were checked against
Solidity — `TICK_LOWER`, `TICK_UPPER`, `POOL_FEE`, `TICK_SPACING`, by
`checkPoolGeometry.mjs`. The rest were two independent declarations of one number
with nothing comparing them, which is a comment, not a constant.

Nothing throws on that kind of drift, which is what makes it worth a guard:
`GENESIS_LP_SUPPLY` sets the quoted opening price, `TIER_STEP_E18` compounds over
4000 shelves, and a wrong genesis duration mines a salt `createLaunch` rejects as
`InvalidHookSalt` *after* the user has paid to mine it.

**Checked: all seventeen currently agree.** So the new
`soat-frontend/scripts/checkContractConstants.ts` is prophylaxis, not a repair. It
parses the constants out of `src/*.sol` — most are `internal constant` with no
getter, so source is the only way to obtain them without retyping them — and
compares against the TS values *imported*, so what is checked is the number the app
computes rather than a literal sitting near the right name. It also covers the
`users.length <= 200` batch bound that `ADMIN_BATCH_MAX` mirrors, `DEAD_ADDRESS`,
and `hookMiner.ts`'s second copy of the durations against `contracts.ts`. 14 of 14
mutations caught, applied to each side in turn and to every literal form the
evaluator has to understand: `e18`, `N hours`, `0.01 ether`, and
`BONDING_MAX = TIER_COUNT * TIER_SIZE`, where moving `TIER_COUNT` correctly moved
the product too.

One wiring detail nearly made the guard worthless, and it is the failure this repo
has already had twice. `npm run guards` is **not** what CI runs: `frontend.yml`
lists each guard as its own step, deliberately, so a red check names the failing
stage. Adding `guard:constants` to the aggregate script alone would have left it
never executing. It is wired into `frontend.yml` explicitly.

#### Checked and sound

The setter surface behaves as documented. Retroactivity is deliberate and
consistent: `defaultSoftCap` and `maxPogAllocationLimit` are frozen into the hook's
initcode at `createLaunch`, so a retune cannot move the goalposts on an open round,
while `pogSigner`, the cooldown, the quota window and the blacklist are read live
because they are risk controls that should apply immediately. Every duration setter
is capped at 7 days. `pause()` is narrow in the direction that matters — it stops
new launches and new quota, not an in-flight genesis round or a refund.

#### The two smaller findings, closed in a second pass

Both were first recorded here as "noted, not changed". Neither is an exploit and
neither was urgent, which is exactly why they are worth finishing rather than
carrying: they are the kind of item that stays on a list until the list stops
being read.

**`setLaunchFee` was the one setter on the factory with no validation at all** —
no floor, no ceiling, no zero-check — while both duration setters are capped at
`MAX_COOLDOWN` and `setDefaultSoftCap` is floored at `MIN_SOFT_CAP_PROD`. The
failure it admits is not an attack, it is an accident with no undo short of a
second owner transaction: the fee is denominated in wei, and the distance between
`0.1 ether` and `0.1e18 ether` is one keystroke in a Safe transaction builder.
Above the ceiling, `createLaunch` is unaffordable for everyone — a platform-wide
outage produced by a typo.

`MAX_LAUNCH_FEE = 10 ether` now bounds it, with `LaunchFeeTooHigh`. Deliberately
generous, at 100x the 0.1 ETH default, because it guards against an
order-of-magnitude slip rather than against pricing judgement; zero stays legal
and `test_setLaunchFee_allowsZero` pins that. Three Foundry tests cover the
inclusive boundary, the first value above it, and the slip at its real magnitude
(`0.1e18 ether`). The suite floor in `test.yml` moved 351 → 354 with the reason
recorded inline, since a floor that rises without explanation is indistinguishable
from a floor someone edited to make a red check go away.

The part that would have been missed by fixing only the contract: **a bound that
exists only on-chain converts the typo into a reverted owner transaction instead
of an inline refusal**, and the admin panel is precisely where the typo gets typed.
Both other bounded dials are mirrored in `contracts.ts` and enforced in the panel
before the button arms — `belowFloor` naming `InvalidSoftCap`, `overMax` naming
`MAX_COOLDOWN`. `MAX_LAUNCH_FEE` is now mirrored the same way, `LaunchFeePanel`
blocks on `aboveCeiling`, and the mirror is covered by the new
`checkContractConstants.ts` (18 constants now, up from 17) so the copy cannot drift
from the contract it claims to follow.

One incidental wrinkle, recorded because the fix is not obvious from the
diff: adding the ceiling check made the React Compiler unable to preserve
`LaunchFeePanel`'s hand-written `useCallback`, which made it **skip optimizing the
whole component**. The `useCallback` was dropped — no other panel in
`FactoryDials.tsx` used one — which is both the lint fix and the faster outcome.

**The PoG chain allowlist accepted the devnet in production, and was written
twice.** `SUPPORTED_POG_CHAIN_IDS` included `FOUNDRY_CHAIN_ID` unconditionally, so
a deployed build accepted `chainId: 31337` and carried the request as far as an RPC
attempt against loopback before failing 503. That fails closed, and the attestation
digest binds `block.chainid` so a 31337-bound signature is unusable on 4663 — but
"the only thing stopping it is that nothing listens on localhost" is not a control,
and the same decision was also written inline in `onchainNonce.ts` as
`chainId !== TARGET_CHAIN_ID && chainId !== FOUNDRY_CHAIN_ID`. Two copies of one
allowlist is the shape that produced the deadline defect above: tightening either
one alone would have left the other accepting what the first had just refused.

The devnet is now included only when this is not a production build — which also
tightens a deployed *testnet* build, correctly, since it has no loopback node
either — and the list itself is no longer exported, only the predicate and
`supportedPogChainLabel()` for error messages. `onchainNonce.ts` asks
`isSupportedPogChain`. `chain.test.ts` (7 tests) exercises each environment in a
fresh module registry, since the allowlist is computed at load, and its last test
scans the calling modules for a hand-rolled `FOUNDRY_CHAIN_ID` comparison — which
is what stops a third copy appearing next to the next caller that wants one.

9 of 9 mutations caught across the three runners: the ceiling deleted, made
exclusive, and raised past the slip it exists for; the mirror drifted in each
direction; the devnet re-allowed unconditionally; the environment test inverted;
the target chain dropped from its own allowlist; and `onchainNonce.ts` growing a
second allowlist again.

#### The asymmetry two sweeps had only recorded

§5.13 and §5.14 both noted that the Foundry job has had a floor guard against the
suite silently shrinking since it was written, and the frontend job never did.
That is now closed, at a floor of 169.

It is not redundant with the tests passing, and the deadline defect above is the
argument. A suite that stops being *collected* — a renamed file that no longer
matches the include glob, a `describe` that throws at import, a mock that swallows
the module under test — reports success, because "every test that ran, passed" and
"the tests ran" produce the same exit code. `computeDeadline()` had no test file at
all and nothing anywhere said so.

The parse is the part worth verifying rather than trusting, since a floor guard
that cannot read its input either fails on every run or never fires, and passing
once distinguishes neither. Checked against a real captured run plus synthetic
inputs: the coloured summary CI actually emits (the reset code after the closing
paren is why the pattern is not end-anchored), a red run — where the
parenthesised total is still the collected count, which is what the floor is about
— a shrunken suite, and unparseable input, which must yield empty so the
workflow's `-z` test turns it into a loud failure instead of a silent pass. All
eight checks pass, including the floor comparison itself at, below and above the
line.

#### The three dial gates, and why they had no tests

The item left open above — the launch-fee ceiling untested in the UI, along with
`belowFloor` and `overMax` before it — had a cause worth naming rather than an
oversight: the frontend suite could not render a component at all. `vitest.config.mts`
ran everything in Node with `include: ['src/**/*.test.ts']`, and there were zero
`.tsx` tests and no DOM. "Untested affordance" was therefore not a gap in three
files, it was a gap in the harness, and each new bounded dial would have inherited
it.

`FactoryDials.test.tsx` (10 tests) closes it, driving the panels through the real
gate, the real `parseEthInput` and the real `Button`, with only wagmi replaced. The
assertions are on what an operator would actually meet: what the one action button
says, whether it is armed, and whether it carries the reason. Each dial is pinned at
its boundary as well as past it — the launch-fee ceiling and `MAX_COOLDOWN` are
inclusive and the soft-cap floor is a minimum, so the boundary value must stay legal
or the UI and the contract disagree about what is allowed. `test_setLaunchFee_atBoundary`
makes the same claim from the other side. Zero is still pinned as armed on the fee,
since a ceiling must not quietly acquire a floor.

The harness cost one dependency: `happy-dom`, 6 packages against roughly 40 for
`jsdom`. No testing-library — React 19 exports `act` and `react-dom/client` was
already a dependency, so a DOM was the only thing genuinely missing, and
`src/testing/renderClient.tsx` is the rest. The DOM is requested per file by
docblock, so the ~170 Node tests keep the environment they want; the config says why.
This is the same reasoning `scripts/runTsGuard.mjs` applies to not adding a
TypeScript runner.

9 of 9 mutations caught: each of the three blockers deleted, each bound made
exclusive so its boundary is refused, the fee acquiring a floor that rejects zero,
a blocked verdict left clickable — the failure where a panel shows a warning and
arms anyway — and the reason blanked, which is the case where an operator is
refused with no cause given, and telling them they typed wei into a field
denominated in ETH is the entire point.

---

### 5.15 Eleventh sweep — the two setters §5.10 declined to bound

`setDefaultSoftCap` and `setMaxPogAllocationLimit` now have ceilings, 2026-09-05.
Both were on the "recorded, not changed" list, and the reason recorded there had
stopped being true: `setLaunchFee` acquired `MAX_LAUNCH_FEE` the same day, in the
same file, and the shared explanation — `src/` is frozen for the engagement — was
then covering one bounded setter and two unbounded ones. PM-A1 has not started, so
the freeze it appeals to has not happened yet. Either bound all three or say
something true about the two; this is the first.

**Picking the numbers is where the useful part was.** The obvious move was to copy
`MAX_LAUNCH_FEE`'s shape — 100x the default, so 1000 ETH and 10 ETH — and it is
wrong, which this repo can demonstrate about itself. `ToshV5Factory.t.sol`'s
fixture raises the per-wallet limit to **1000 ETH** so the `registerPoG` tests can
work in round numbers, `test_registerPoG_noSilentClamp` needs **300**,
`ToshV5Guards.t.sol` sets 1000, and `batchA-R2-fresh.ps1` sets an **8000 ETH** soft
cap against a local node. A 10-ETH ceiling does not merely fail one test, it
reverts in `setUp` and takes the entire file down. So the bound cannot be a view on
sizing at all; there is no comfortable range to be conservative within.

What is left once sizing is off the table is exactly one class of mistake: **unit
confusion**. `10 ether` typed as `10e18 ether` is eighteen orders of magnitude, and
`MAX_DEFAULT_SOFT_CAP` = `MAX_POG_ALLOCATION_LIMIT` = **1 M ETH** sits far above
any conceivable raise or wallet cap — roughly 1 % of all ETH in existence — while
staying ~1e14 below that slip. `MAX_LAUNCH_FEE` keeps its tight 10 ETH because a
fee above that cannot be a considered choice; the natspec now says why the three
differ, so the next reader does not tidy them into agreement.

**Two things the ceilings deliberately do not do**, both written into the natspec
because a bound invites the wrong inference. A `maxPogAllocationLimit` under its
ceiling is *not* evidence that PoG still limits whales: once the per-wallet cap
reaches the soft cap, one wallet can fund an entire genesis round, and no constant
can enforce that ratio, because `defaultSoftCap` moves independently and coupling
the two would make the result depend on which setter the owner called first. And
the soft-cap ceiling guards a failure that never reverts — a cap no depositor base
can clear does not error, it quietly sentences every launch created afterwards to
refunds, which is why a floor alone was not enough.

8 Foundry tests and 9 component tests, and both halves say out loud that the
suite's own 1000/300/8000 values still pass — the cheapest available evidence that
a tidier bound was the wrong bound, placed where tightening it would fail.

12 of 12 mutations caught, 6 on each side. On the contract: each ceiling deleted,
each `>` made `>=` so the legal boundary is refused, and each constant tightened to
the tidy value — where the PoG one is caught harder than by a test, since it breaks
the fixture and every test in the file dies in `setUp`. On the UI: each blocker
disarmed, each bound made exclusive, the mirrored constant tightened, and the
existing zero blocker disarmed, because the risk in adding a second blocker to that
dial is shadowing the first — and zero is the one that keeps `createLaunch` alive
platform-wide.

**The harness failed before the code did, again.** The first mutation run scored
0/6, every mutation surviving, because `spawnSync` with `shell: true` concatenates
argv without escaping and `--match-test 'a|b'` became a shell pipe — forge's output
went to a command that does not exist, and the harness read an empty string as "no
failures". Six clean bills of health from six runs that never happened. The check
that catches it is now in the harness: a run must contain a `Suite result:` line
and a nonzero tally before its silence is allowed to mean anything, which is the
same lesson as §5.14's `verdictFor` and the doc-symbol harness that vouched for
itself — a verification tool that cannot fail loudly is indistinguishable from the
thing it was built to detect.

### 5.16 Twelfth sweep — the deploy environment, which no guard had ever read

`scripts/preflightMainnet.mjs`, 2026-09-05. Every sweep so far has audited code.
This one audits the **inputs** to the one irreversible action on the roadmap, and
the finding is that they were the least-guarded surface in the repository.

**The gap is a paste.** Two checks already exist either side of it and neither
covers it. `DeployMainnet.s.sol` asserts the chain id and that four roles are
non-zero and mutually distinct. `verifyOwnerSafe.mjs` verifies a Safe deeply —
2-of-3, owners as agreed, SafeL2 and indexed, accepts plain ETH — and then ends by
printing "Safe to set BOTH of these in `.env.production`". Nothing checked that
they were set, or set to that. `.env.production` is gitignored and does not exist
until deploy day, so the file the broadcast actually sources had no guard reading
it at all.

**What `requireDistinctRoles` does not assert is that `PLATFORM_TREASURY` has
code.** PM-C9 wrote this down in as many words — "a personal EOA passes and is
then permanent" — and it stayed a sentence in a checklist rather than a check. The
address takes 0.30 % of the ETH input of every buy on every pool, forever, and is
immutable in two places: the factory and the hook implementation's
`platformFeeRecipient`. Distinctness from the deployer and the PoG signer is
satisfied by *any* third address, including a personal wallet, which is exactly
the mistake a hurried deploy makes.

**The inverse holds for the PoG signer and is worse for being silent.**
`POG_SIGNER_ADDRESS` must *not* have code: `registerPoG` authenticates with
`hash.recover(signature)`, which can only ever yield an EOA, so a contract there
can never match. Nothing reverts at deploy. The factory comes up healthy and every
user registration fails `InvalidSignature` afterwards. `setPogSigner` can repair
it, once somebody works out why nobody can register.

**One cross-layer check nothing else does.** `contracts.ts` hardcodes
`POOL_MANAGER` and its own comment explains why it is deliberately not env-bound:
a wrong one silently mis-computes every hook's CREATE2 address. That makes it two
independent declarations of one address with nothing comparing them — the same
drift `checkContractConstants.ts` exists to prevent, one boundary further out. The
preflight compares them.

**Deep Safe verification is delegated, not reimplemented.** The script shells out
to `verifyOwnerSafe.mjs` against the address *the file names*, which is what turns
"the Safe we blessed on a command line" into "the Safe we are about to deploy
against".

**And it immediately found something the checklist had not asked about.** The
deployer holds **0.001627 ETH** on 4663 and the rehearsal broadcast on disk totals
**14,580,627 gas** — 7.95 M the factory alone. At the quoted 0.38 gwei that is
~0.0056 ETH, so the deployer covers **29 %** of its own deploy. Recoverable, being
only funding, but it is the single item that fails *during* the irreversible step:
a broadcast that runs out part-way leaves some contracts live and the factory
absent or unowned. The check is measured rather than chosen — it sums the receipts
and prices them live — because a hardcoded ETH threshold on a chain whose gas price
moves is wrong in both directions.

**9 scenarios, and the ninth is the one that mattered.** Eight prove refusal: the
treasury as an EOA, the owner as an EOA, the signer as a contract, a real-but-wrong
PoolManager, a role collision, a leftover `REPLACE_ME`, a chain-id mismatch, and no
file at all. The ninth proves **exit 0 is reachable** — after the first eight
passed, everything verified was that it says no, and a gate that can only refuse is
as useless as one that only permits. Running it also confirmed the intended env
layering, since omitting `PRIVATE_KEY` from `.env.production` correctly fell back
to `.env` rather than failing.

**Exit 2 is not exit 1 and not exit 0.** A missing `.env.production`, a leftover
placeholder, an unreachable RPC or a chain-id mismatch exit **2** — could not run.
The same lesson as §5.15's harness and §5.14's `verdictFor`, now applied where it
is most tempting to skip: reading `.env` instead would be *worse* than not running,
because it holds testnet roles where `PLATFORM_TREASURY` and `POG_SIGNER_ADDRESS`
are both the deployer, and it would have reported three confident failures about a
file nobody is deploying.

### 5.17 Thirteenth sweep — the modifier claims held; their citations did not

Prompted by §8.12's own warning in `PRD-v5.0.md`: after a "pause covers `deposit`"
claim was disproved by measurement, that document recorded that **every remaining
"protected by modifier X" assertion without a test name beside it should be treated
as unverified**, because a modifier list is the documentation most likely to rot
quietly through a refactor. This sweep took it up.

**The access control itself is sound, and the claims about it are accurate.** All
95 externally reachable functions in `src/` were enumerated with the modifiers
actually attached, and checked against the PRD's eleven assertions. `whenNotPaused`
guards exactly `registerPoG` and `createLaunch` and nothing else, as claimed;
`nonReentrant` covers exactly the five hook entry points and the two factory ones
the PRD lists; `onlySelf`, `onlyHook`, `onlyClone` and `onlyPoolManager` are where
they are said to be. Seven functions change state with no modifier, and each is
either deliberately permissionless with a natspec reason (`releaseAbandonedName`,
`pokeBuyback`) or carries an equivalent inline check — `hook.deposit` and
`ToshToken.initialize` test `msg.sender != factory`, `changeProjectAdmin` tests
`projectAdmin`, `treasury.unlockCallback` tests `poolManager`. Nothing was found
open that should be closed.

**Two of those seven were artefacts of the tool, and both are worth recording**
because each is the shape of mistake that makes an audit worse than none. The first
extraction used a hand-written list of known modifier names and printed anything
else as "(none)" — so `ToshToken.mint`, which carries `onlyRole(MINTER_ROLE)`,
rendered as an unprotected mint function. A whitelist cannot report a modifier it
has not heard of; the fix was to take everything in the header that is not a
language keyword. The second counted `interface` declarations as functions, which
cannot carry modifiers at all. **A tool that reports a guarded function as
unguarded does not merely waste a reviewer's afternoon — it raises the noise floor
that a real missing modifier would have to be spotted against.**

**What was actually broken was the pointers.** The docs cite source locations as
`path/File.sol:120-134`; there are 108 such citations. Of the 23 that can be
judged mechanically, **22 were wrong** — and all in the same direction, at lines
far above the truth, which is the signature of numbers written against a much
shorter version of the contracts and never regenerated. `PRD-v5.0.md:874` cited
`ToshLaunchpadHook.sol:127` for the five functions carrying `nonReentrant`; they
are at 1183–1421, and line 127 is a comment about price. `ToshFactory.sol:36`,
`354` and `442` were offered for the inheritance, `createLaunch` and `deposit`;
the real lines are 37, 657 and 740.

**Two of them this engagement broke itself, hours earlier.** `PRD-v5.0.md:578`
cited `ToshFactory.sol:92` for `defaultSoftCap` and `45-55` for the `p0`
truncation floor. §5.15 inserted `MAX_LAUNCH_FEE` and `MAX_DEFAULT_SOFT_CAP` above
both, so those two citations now landed inside the new natspec. The decay is not
historical; it happens on any commit that adds a comment.

**A guard for this already existed and had declined to look.**
`scripts/checkDocAnchors.js` fails on a citation past end-of-file and *reports but
tolerates* one that has merely moved, on the stated grounds that "only a human
knows what it meant". That is true in general and false in the common case: when
the sentence names the function in backticks beside the number, the document has
already said what it meant. `scripts/checkDocLineRefs.mjs` decides that subset.
The detail worth keeping is that the tolerated channel had been printing the
defect all along — and the example its own header used to explain the SOFT
category, whether `ToshFactory.sol:442` "still lands anywhere near `deposit`", was
one of the broken citations. It did not.

**The rule took three attempts, and the two rejected ones are the lesson.**
Matching a citation only against the nearest name removed two false positives and
took the coverage with it — 23 checkable citations became 6 of 108, close to
decorative, and four of the cases it stopped checking were defects found minutes
before. Accepting a line as soon as *any* one name was covered then let a mutation
walk straight through: breaking `deposit`'s number left the build green, because
the correct `createLaunch` citation beside it satisfied the line alone. **One
accurate pointer masking a rotten neighbour is the exact failure the guard exists
to remove, so it could not be the rule the guard used.** What survives: every name
on the line must be covered by some citation, resolved against each cited file that
defines it — which is what makes the strict rule usable, since `deposit` exists in
both the factory and the hook.

**7 of 8 mutations caught, and the eighth is why the self-test is there.** Two
survivors on the first pass were mutations of the guard rather than the docs —
deleting its exit code, and skipping its semantic loop — because nothing was
checking the checker. It now runs the real logic over a synthetic line whose
verdict is not in question before reading any document, and exits **2** if that
line does not produce exactly one problem. That converts the disabled-loop
mutation into a hard failure. The last survivor is `process.exit(1)` changed to
`process.exit(0)`, which no guard can catch about itself; that one is the mutation
harness's job, and it is recorded here rather than papered over.

The 71 citations that name no function this guard knows are counted and printed on
every run, not silently dropped — that number is the honest measure of what it
still does not cover.

---

### 5.18 Fourteenth sweep — the document this guard refused to read

§5.12 found three UI symbols named in `PRD-v5.0.md` that exist nowhere in
`soat-frontend/`: `feeMode`, `handleDeposit`, `handleMineSalt`, each cited with a
precise line range against a launch page that had replaced all three. It recorded
them, allowlisted them so the dossier could quote them, and left the drift OPEN
with a reason: gating a product spec is not worth it, because a stale name there
is a spec nit rather than an unverifiable control.

That reasoning had one testable claim in it — that fixing the chapter was a big
job — and nobody had tested it. Adding `PRD-v5.0.md` to the guard's `DOCS` list
costs **nine** stale references, not three. The other six were `ConnectGate`,
`GenesisWindowSelect`, `RecentEventsTicker`, two window tests still cited under the
constructor-era names the EIP-1167 clone refactor had replaced with
`test_initializeToken_acceptsTheThreeAllowedWindows` and
`test_initializeToken_rejectsUnlistedWindow`, and one name the document had
abbreviated in a table to a dangling suffix — the same shape as the `EthNotTokens`
entry above, but of `test_ladderCuration_rejectsUnlaunchedProjects`. Nine is a
morning. Leaving the document ungated is what let three become nine.

**What the nine turned out to be pointing at.** Only two were simple renames. The
rest were load-bearing, and four of them ran the *opposite* way to the drift this
sweep went looking for — the document describing a defect the code no longer has:

| The document said | The code says |
|---|---|
| `constructor` compares the three duration constants | The comparison is in `initializeToken` — a clone runs no constructor. It is deliberately not in the factory: the value is read out of the clone's own bytecode, and checking the factory's argument would attest to what it *meant* to bake in, not to what the mined address commits to |
| `resolvePhase` has three phases, and ⚠️8.6 is a live UI/chain mismatch | Four phases. `awaiting_launch` and `AwaitingLaunchPanel` exist precisely to close 8.6, plus a `zombie` check for the window past it. `phase.ts` records both halves of the original bug in its own comments |
| A `ConnectGate` renders when no wallet is connected | No such gate. `isConnected` is passed into each panel and becomes one blocker among others. The only whole-page early returns are a missing hook binding and — load-bearing — an unsynced clock, because at `nowSec === 0` every deadline comparison reads as "still open" and an expired genesis resolves back to `'genesis'` |
| A per-project `RecentEventsTicker` on `Deposited`/`TierMinted`/`Refunded`, with basescan links | No event feed in the project terminal — that one never existed. One *did* exist on the directory home, `TxFeedMarquee` on three *factory* events with no explorer links, and the v0 redesign removed it together with its `EventTickerStrip` wrapper and its mount in `AgentDirectoryHome`; it is recoverable from `50bc9a7`. So `watchContractEvent` is now in zero files and every live figure is a poll. (The chain has been 4663 with Blockscout for months, so the basescan detail was wrong too.) See PRD §6.6.4, which also records an invalid inference made while auditing this row: `git log --diff-filter=D` finding no delete commit does **not** establish a file never existed, because an uncommitted deletion produces no delete commit either |
| Salt invalidation on the factory's caps changing between mining and submitting is **not done**; the user just gets `InvalidHookSalt` | Done. `mineSalt` snapshots both caps into `saltCaps` and a `useEffect` clears the salt with a message when they move. The on-chain backstop and its test still exist; they are no longer the notification mechanism |
| `hookInitcodeHash` takes six arguments including `adminAddr` | Five. The admin is mutable by design, applied at initialisation, and no longer moves the mined address — so the PRD's "Project Admin changed → salt invalid" row is now describing an invalidation that is real in the code but no longer *necessary* there |
| Two `useTosh` comments contradict each other about slot A and slot B | They agree, and there is no `contribute` flow. What is worth recording instead is that `isSuccess` from `useWaitForTransactionReceipt` means the receipt arrived, not that `createLaunch` worked: a reverted launch once rendered as "Confirmed" |

**A real string, found on the way out.** `app/layout.tsx` set
`metadata.description` ending in the literal `'Currently staging on Base Sepolia
testnet.'`, and it had survived the entire Robinhood Chain migration. Every search
result and link preview named a chain this build has not settled on for months.

`checkChainCopy.mjs` existed and did not catch it, for a reason worth stating: it
evaluates the constants in `chain.ts` once per chain, which is the right shape for
the bug it was built for and cannot see a literal typed into a component. Page
metadata is also not one of the four surfaces it was written around. So the fix is
two-part — the description now derives from `CHAIN_POSITIONING`, and the guard
gained an AST literal scan over `src/`, which rejects:

  1. any abandoned chain name (`base sepolia`, `basescan`, `sepolia`) in a string,
     template chunk or JSX text; and
  2. the **current** settlement chain's name anywhere outside `chain.ts`.

Rule 2 is the one with teeth. Rule 1 alone only ever catches the previous
migration, and always one migration too late; rule 2 makes the next one a build
failure, because the only way left to say the chain's name is to derive it.
Comments are deliberately out of scope — `chain.ts` and `serverRpc.test.ts` both
discuss Base Sepolia at length to explain what changed, and a guard that could not
tell prose from copy would force those explanations to be deleted. 120 files scan
clean.

**Mutations.** Ten, all as expected. On the doc gate: a real PRD symbol renamed to
a near-miss, a cited Foundry test shortened by one word, `resolvePhase` renamed,
`useActionGate` renamed — four caught. The fifth is the one that justifies the
change rather than the code: with `PRD-v5.0.md` removed from `DOCS` again, the
first mutation goes unnoticed, so the one-line edit to that array is load-bearing
and not decoration. On the copy guard: the original Base Sepolia string put back
(caught), the current chain name hard-coded in a component (caught), `basescan` in
a literal (caught), a blanked `MAINNET_CHAIN_LABEL` — which would leave rule 2
comparing every literal against `''` — failing loudly instead of reporting a clean
sweep (caught). And one negative control: the same stale name in a *comment* stays
legal, confirming the scan is not a false-positive machine.

**What this sweep did not do.** The six names now sit in `ALLOW`, and an `ALLOW`
entry is skipped *before* the search runs. If `feeMode` or `ConnectGate` came back
into `soat-frontend/`, this guard would not say so, and the PRD would then be
asserting the absence of something present. Nothing watches for that. The entries
say so.

Chapter 6's line citations were not re-verified. They are written as bare `` `:NNN-NNN` ``
shorthand, which `checkDocLineRefs.mjs` cannot attribute to a file, so roughly
forty of them are unchecked by anything. The passages this sweep rewrote cite by
*name* instead, on that guard's own advice — names are checked and do not rot when
a file grows — but the sections it did not touch still carry numbers nobody has
confirmed.

One class was measured and deliberately left ungated. Docs cite 381 backticked
repository paths; 12 do not resolve against either the repo root or
`soat-frontend/`. Every one was read. Two were ambiguous shorthand and are fixed
(`lib/projectAttestation.ts`, and a solmate path relative to its submodule). The
other ten are correct as written: eight name a file *because it was deleted* —
which is the whole point of the sentence they sit in — one is a path inside
Blockscout's verified-source layout rather than this repository, and one is the
incident runbook recording a dead pointer it had already fixed. A guard here would
need a ten-entry allowlist to defend against zero live defects, and would tax every
future sentence of the form "X no longer exists". Recorded, not built.

---

### 5.19 Fifteenth sweep — the soak §0.4 handed back to us

§0.4 reassigned one deferral from the cancelled engagement to us: a higher fuzz
run count and an invariant soak at depth well past 100. It was the only item on
that list that needed machine time rather than a vendor. Run 2026-09-06.

**What was run, and it found nothing.**

| | CI setting | Soak | Multiple | Result |
|---|---|---|---|---|
| Invariants | 128 runs × 100 depth | **512 × 2500** — 1,280,000 calls per invariant, 9 invariants | 100× | 9/9 pass, 46 min wall, 5.4 CPU-hours |
| Fuzz properties | 256 runs | **500,000 runs** × 8 properties = 4,000,000 | 1,953× | 8/8 pass, 3.5 min |

No violation of any kind, at either scale. That is the headline and it is worth
exactly what it is worth: two orders of magnitude more search against the same
predicates, which cannot find a property nobody wrote.

**The useful output was a correction to how this suite's coverage is read.**

`afterInvariant()` prints twelve action counters, and they are the only evidence
anyone has for whether an invariant run is vacuous. They log the **last run
only** — one sample out of `runs`. Every statement of the form "the suite
reaches N buys" derived from them is a statement about one sequence.

Three conclusions were drawn from those counters during this sweep and all three
were false. They are recorded because the failure is not arithmetic, it is a
category error that the log's format invites, and it has already reached this
document once:

| Claimed from the counters | Refuted by | Actual |
|---|---|---|
| At the CI depth the suite never reaches launch, so the four post-launch invariants are vacuous | Re-reading the same counters on a different invariant at runs=64 | Depth 100 reached **2 launches, 5 buys, 1 sell, 1 listing** |
| The referral commission path is never exercised at any depth | The depth probes | `okClaimReferral` = 1, 1, 2, 1 at depths 100 / 250 / 500 / 1000 |
| Only one launch is reachable per run even at depth 2500 | Same | 2 launches at every probed depth; the soak's 1 was its own last run |

The first of those was measured on `invariant_unlaunchedHookCanPayEveryRefund`
and generalised to the suite. The soak's own nine samples looked like strong
evidence because they agreed with each other almost exactly — hooks 10, creates
7, launches 1, buys 211, sells 80, listings 1, identical across all nine, with
only `ok pokes` (11–17) and `ok owner actions` (640–650) varying. Nine agreeing
samples of the last run of nine tests that share one handler and one selector
table is one observation reported nine times, not nine observations. Why they
agree that closely is not established here.

**§4's coverage bullet was the same error, already in the document.** It read "a
measured run reaches roughly 6 buys, 2 sells, one ladder listing and one buyback
cycle inside its 100 calls" — consistent with the 5 / 1 / 1 measured here at
depth 100, and misleading as a characterisation, since the same invariant reaches
75 buys and 38 sells at depth 1000. Corrected in place.

**The depth knee is 250, and it is measured.** Across depths 100 / 250 / 500 /
1000 on one invariant at runs=64, buys went 5 → 25 → 35 → 75 while deposits went
10 → 13 → 8 → 5. Depth 250 is the last value that improves post-launch
composition without costing genesis composition, because past it a run spends
proportionally more of its calls after the genesis windows have expired. **Depth
trades genesis coverage for post-launch coverage rather than adding coverage** —
which is the part most likely to be forgotten, since raising depth further looks
like more rigour while quietly buying less genesis exercise.

**Where the deep setting ended up: not in `foundry.toml`.** It was raised to 250
there and moved back out the same day. Depth 250 is right on the evidence and
wrong on the invoice: `test.yml` runs the whole suite twice, so it went from
7 m 27 s to 13 m 12 s on every push, in a private repository where Actions minutes
are billed. So `foundry.toml` keeps depth 100 for the fast per-push signal, and
`.github/workflows/soak.yml` runs the deeper search once a day at
`runs = 256, depth = 1000` with fuzz at 100,000 per property, sized to a budget
rather than to ambition. The 512 × 2500 configuration this sweep actually ran is
reachable from that workflow's manual inputs; it is not on the cron, because at
the local-to-CI factor measured here it is hours of billed time per night.

The soak workflow's summary prints the `afterInvariant()` counters with a label
saying they are one sample each and pointing at this section, so the next reader
does not repeat the three retractions above.

**What the nightly actually costs, measured on its first dispatch:** 47 m 14 s of
billed time — build 171 s, invariants 1,787 s, fuzz 819 s. It passed, at 256,000
calls per invariant.

That was estimated beforehand at about 21 minutes, from the 5.4× local-to-CI
factor the depth change implied. The real factor on the invariant step is ~11.5×,
because the runner has a couple of cores where a workstation parallelises nine
invariant tests properly. **Sixth instance, same shape:** a factor measured under
one configuration, used to size another. Recorded here rather than left as a
round number, because ~47 min nightly is ~1,420 billed minutes a month against
the same private-repository allowance that `watch.yml` already draws ~720 from
hourly.

**That cost was accepted on 2026-09-06, daily cadence kept.** The alternatives
were weekly at the same depth (~200 min/month), a trimmed nightly, or cron
removed in favour of manual dispatch. Daily was chosen deliberately, so if the
allowance later becomes a problem the first thing to reach for is the cadence in
`soak.yml`, not the depth — the depth is what §5.19 measured and the cadence is
what nobody is waiting on.

Also worth noting from that run, against the second retraction above: the
counters **varied** between invariants there — launches 2, 3, 3 — where the local
512 × 2500 soak had them identical across all nine. Whatever makes them agree, it
is a property of a configuration and not of the suite, which is the whole reason
they cannot be read as coverage.

Cost, measured on the whole contract at the real `runs = 128` instead of
extrapolated from the runs=64 probe: **7.8 s → 39.5 s** locally, about 5×. The
probe implied 2×, because it timed one invariant where the suite runs nine plus
five unit tests and saturates the cores differently.

**And the local figure is the wrong figure, which is the fifth instance of the
same mistake.** What anyone actually waits on is CI, which runs the whole suite
twice — plain and `--isolate` — on a slower runner. Measured across consecutive
pushes: **7 m 27 s and 7 m 31 s at depth 100, then 13 m 12 s at depth 250.** CI
very nearly doubled. Quoting "39.5 s" as the price of this change would have been
true and useless, in exactly the way the three coverage claims above were true of
one sample.

So the pattern in all five readings is one thing: a number measured under one
configuration, then used to describe another. Whether ~6 extra CI minutes on
every push is worth this depth is a budget question rather than a technical one,
and the alternative worth knowing is that the deep configuration could run on the
existing scheduled workflow instead of on every push.

**Not done, and stated rather than left implied.** The counters still sample one
run, so the instrumentation that this sweep just spent its value correcting is
unchanged. Making them cumulative is not a comment fix: Foundry restores state
between invariant runs, so an in-contract counter cannot accumulate, and the
honest options are a cheatcode-written file or dropping the coverage claims
entirely. Nothing in CI would notice if a future handler change made every run
revert into its `catch` blocks except the five deterministic `test_handler*`
tests, which is what they are for and which the soak did not improve.

### 5.20 Sixteenth sweep — the pre-broadcast gate told you to fund the wrong wallet

Found by doing something mundane: creating `.env.production` ahead of deploy day
instead of on it. Two of its six roles are already decided and independently
verifiable — `PROD_OWNER_SAFE` and `PLATFORM_TREASURY`, both the 2-of-3 Safe —
and there was no reason for them to be pasted for the first time under the time
pressure of an irreversible broadcast. Filling those two and leaving the other
two as `REPLACE_ME` is what exposed the defect.

**What `preflightMainnet.mjs` claimed.** Its header says reading `.env` instead
"would be worse than not running: it holds testnet roles where
`PLATFORM_TREASURY` and `POG_SIGNER_ADDRESS` are both the deployer, so this
would report three real failures about a file that is not the one being
deployed." A second passage says the example's `0xREPLACE_ME_*` values mean "a
half-filled file reads as a set of missing vars rather than as wrong ones."

**What it did.** `loadRoleEnv` reads `.env.production` first, skips `REPLACE_ME`
— and then **falls back to `.env`** for anything still unset. That fallback is
correct for the PM-D4 scripts it was written for and wrong here. So a
half-filled file does not read as missing vars; the gaps silently become testnet
values. The run reported:

```
PRIVATE_KEY            (set)                                        ← .env
POG_SIGNER_ADDRESS     0x73db078fa94607893270079AC8F5c7492aB480cd    ← .env
deployer               0x73db078fa94607893270079AC8F5c7492aB480cd
✗ 2 check(s) failed.  fix: Fund 0x73db078f… with at least 0.010119 ETH more
```

Both failures describe `.env`. The script announced them as findings about the
file the deploy sources.

**Why this one is worse than a wrong message.** The remediation text is a *money
instruction*, and `0x73db078f…` is the testnet deployer that §4.1 of the
checklist forbids reusing on mainnet. An operator following the gate on deploy
day would send real ETH to a wallet that must never sign a mainnet transaction.
And the protection the header describes existed only inside the
`!existsSync('.env.production')` branch — it lapsed at the exact moment you did
what that branch instructs, which is to create the file.

**The fix** is check 0b: every one of the six roles must have come from
`.env.production`, and anything resolved from `.env` makes the script exit 2
(cannot run) naming the variable and its source. The header's false half is
withdrawn in place rather than deleted.

**Mutation tested, 7 assertions, all as expected** — including two positive
controls, because a gate that rejects everything is indistinguishable from one
that works:

| | Scenario | Expected |
|---|---|---|
| P1 | fully-filled `.env.production` | passes 0b, reaches the on-chain checks |
| P2 | same | the funding line names the filled deployer, not `0x73db078f…` |
| B1 | half-filled | exit 2, names the two strayed vars |
| B2 | half-filled | emits no `Fund 0x73db078f…` line at all |
| M1 | gate deleted | the original bug returns — exit 1, funds the testnet wallet |
| M2 | `.env` accepted as a source | stops catching |
| M3 | comparison inverted | rejects a correct file, which P1 proves is not real behaviour |

**The same error was in the checklist.** `PRE_MAINNET_CHECKLIST.md` §3's note
read "the deployer is short of gas … Fund it to at least 2x the measured cost",
with `0x73db078f…` named two sentences earlier — the identical instruction, in
prose, in the document an operator reads first. Rewritten: the mainnet deployer
does not exist yet, so it is not underfunded, it is absent; and the cost was
re-measured the same day at 0.4009 gwei, giving ~0.005845 ETH and ~0.0117 ETH at
the 2x margin.

**What this does not fix.** The gate makes the script refuse a half-filled file;
it does nothing about the two roles themselves, which cannot be filled from a
keyboard — both are new EOAs that do not exist, and the PoG signer's private key
must never be written to a laptop file at all (§4.1).

### 5.21 Seventeenth sweep — two tools that were confidently out of date

Same exercise as §5.20, continued: work through what can be closed without a
key, real ETH or another person. Very little could, and what the attempt found
instead was two more places where a tool's own prose sends you somewhere wrong.

**`verifyOwnerSafe.mjs` had been stale for two days.** Its closing block asked
you to "fill `INCIDENT_RESPONSE.md` §1 with all three signers, and re-run the
§8.2 Q1 drill on 46630 with one of the new signers taking part — that is the
third Q1 criterion, and the only one still unmet." Both halves were false by
2026-09-04. §1 labels Signer #1, #2 and #3 against the addresses they
signature-proved, and §8.3 closed the third criterion the same day, with #3 and
#1 signing all four payloads. Meanwhile the thing that *was* open — a contact
channel for any of the three, which is what PM-D4 and PM-E4 both reduced to —
went unmentioned. That column closed 2026-09-08: the channel is named, the
handles live in the offline vault, and this document does not record them.

The reason this is worth a section rather than a one-line fix: `C1_RUNBOOK.md`
§0 tells you to run that script on deploy day. It would have sent you to
organise a drill that is already done, silently, while the real gap stayed
invisible. That is the same failure shape as §5.20's `Fund 0x73db078f…` — a tool
whose *verdict* is correct and whose *instructions* are not — and it is now the
third instance in two days. The first draft of `C1_RUNBOOK.md` §8 inherited the
same stale claim by copying it, which is how these propagate.

**Two operational documents were never gated.** `check:doc-symbols` covered four
documents. `PRE_MAINNET_CHECKLIST.md` — the launch gate, which names roughly
forty scripts and contracts in its evidence column — was not one of them, nor
was `SIGNER_BRIEF.md`, which is what a Safe signer reads before signing. Four
less operational documents were gated while those two were not, and no argument
had ever been made for the split; it was simply the set that existed when the
guard was written.

Both are now gated, along with `C1_RUNBOOK.md` from the day it was written. The
guard covers **7 documents and 654 identifiers**. Adding the two cost three
`ALLOW` entries — `eth_getTransactionsByAddress`, `trace_filter` and
`arbtrace_filter`, all JSON-RPC method names that §7 of the checklist cites
precisely to record that the Robinhood node does not serve them, the same
category as the existing `master` entry. It found **no drift**, which is the
good outcome and not evidence the exercise was unnecessary.

Each newly gated document was then verified to be *read* rather than merely
listed, by planting a symbol that exists nowhere and confirming the guard fails
— the check that `DOCS` membership actually reaches the scanner.

**What still cannot be done without you**, and this is the honest total: two
EOAs that do not exist (deployer, PoG signer) and ~0.0117 ETH of real funding.
The contact channel and the D1–D4 watcher were named 2026-09-08; they are
operator obligations (handles in the offline vault) and not something this
repository can see. Every remaining open row is the broadcast itself, or
downstream of it.

### 5.22 Eighteenth sweep — a live outage, and a guard stricter than its code

A full pre-mainnet scan on 2026-09-06 found one real external failure and one
guard that reported it wrongly.

**Chain 4663's Blockscout v2 endpoint is returning HTTP 500.** Reproduced five
times over about forty minutes, including a run with nothing else touching the
key: the other four chains answer 200 on both dialects in the same run, credits
sat at 98,240 and the rate limit was never reached, so this is neither quota nor
contention. It is specific to the chain the launchpad settles on, and the key
was recorded on 2026-09-05 as "verified on all five chains before it was
stored" — so this is a regression on the provider's side, one day later.

**It is not a launch blocker, and the reason is a decision made the day before.**
`GAS_SCAN_CHAINS` marks Robinhood `required: false` — the single exception in
that table — so `scanGasHistory` catches the failure, records the chain as zero
with `unavailable: true`, and completes. Every affected claimant is under-awarded
and none over-. The measured size of the under-count is 0.00403 ETH for a busy
4663 account's fifty most recent transactions: 8 % of the 0.05 ETH eligibility
floor, 0.4 % of the 1 ETH cap. The argument recorded for that flag was that
"while 4663 was fatal, its indexer's uptime WAS the uptime of genesis
allocation." That is no longer a hypothetical.

**What was wrong was the guard.** `checkBlockscoutKey.mjs` carried a hand-written
table that said it "mirrors `GAS_SCAN_CHAINS`" and omitted `required` entirely —
two independent declarations of one table with nothing comparing them, which is
the drift shape §2.5 and `checkContractConstants.ts` exist for. It concluded
"This key is NOT usable by the scan as written" and exited 1, on a chain the
scanner deliberately survives. A guard stricter than the code it guards is not
extra safety; here it would have read as "PoG is down" during a 0.4 % degradation.

Fixed the way `preflightMainnet.mjs` handles the mirrored `POOL_MANAGER`:
parsed, not retyped. The script now reads `required` and `execFeeIsWholeFee`
from `gasHistory.ts`, exits 2 on any disagreement between the two tables or if
the table cannot be found at all, and splits its verdict — a required chain
failing is fatal, an optional one is a warning with the measured impact spelled
out.

**Mutation tested, 6 assertions. Two survived the first run, and both were real.**
The live outage served as the fault injector: flipping `required` on that one
row switches the expected verdict without simulating anything.

- **M1 survived** because `results.push()` never carried `required`, so
  `broken.filter(r => r.required)` was empty on every row and *no* chain could
  ever be fatal. That was a bug introduced by this very fix, and nothing in the
  passing baseline would have shown it.
- **M4 survived** because the table regex lacked `\b` and matched
  `GAS_SCAN_CHAINS_RENAMED` as happily as `GAS_SCAN_CHAINS` — a rename would
  have been parsed rather than reported.

Both fixed; 6/6 after.

**Then it became a provider-wide outage, which settled the question.** The
sequence over roughly an hour, all measured:

| Time | State |
|---|---|
| start | 4663 v2 → HTTP 500; other four chains 200 on both dialects |
| +40 min | 4663 v1 → HTTP 500 as well; other four still fine |
| +60 min | **all five chains** → HTTP 521 and timeouts; credits header absent |

HTTP 521 is Cloudflare for "origin is down", and rate limiting answers 429, so
this is `api.blockscout.com` failing rather than the free-tier key being
exhausted. That also disposes of an intermediate theory worth recording because
it was held for a while and was wrong: `gasHistory.live.test.ts` failed
repeatedly on *Ethereum* mid-sweep, and the obvious suspect was self-inflicted
load — several `checkBlockscoutKey.mjs` runs competing for the same 5 req/s key.
Run alone the test had passed in 42 s, and CI was green on the same commit, both
of which fit that theory. The 521s do not. It was the provider degrading the
whole time.

**The severity split got validated live, in both directions,** which no
mutation could have arranged: with only 4663 down the fixed guard exits 0 with
the bounded-degradation warning, and once Ethereum and the other required chains
went with it the same guard exits 1 and says no allocation can be issued at all.

**What this leaves as a standing risk, and it is not a code defect.** Genesis
allocation depends entirely on one external host. When a `required` chain cannot
be read the scan aborts, which is the correct direction — never over-award — but
it means genesis claiming is offline for the duration of someone else's outage.
There is no second provider to fall back to and that is already argued in
`gasHistory.ts`: Etherscan V2's free tier refuses Optimism and Base and does not
index 4663 at any price, and neither do Alchemy or GoldRush. So the exposure is
accepted rather than solved, and it is worth knowing before launch day that a
Blockscout outage postpones genesis rather than corrupting it.

### 5.23 Nineteenth sweep — the runbook named the wrong residue

A paragraph in `C1_RUNBOOK.md` §1 said the key is printed, not typed, so it does
not enter PowerShell's PSReadLine history; it is in the scrollback buffer; close
that window when done. We wrote that. The first clause is true. The rest is a
warning that is precise about the wrong threat, and therefore reads as
reassurance.

**What the paragraph concluded wrongly.** Command history is not the exposure on
this machine. Cursor persists the output of every terminal it manages into
plaintext files at `.cursor/projects/<slug>/terminals/*.txt`. Closing the window
does not remove that file, and the same capture is in the agent conversation.
The inventory of where output lands omitted the editor.

**What following it cost, measured 2026-09-08.** An operator ran
`cast wallet new` twice in the Cursor integrated terminal, verbatim from §1
and §2. Both keypairs landed in that capture and in the transcript. Per
`PRE_MAINNET_CHECKLIST.md` §4.1 and the runbook's own §7 item 7, both EOAs are
burned and cannot be used on mainnet:

- deployer `0xf9D360fC5AC1045d79054a850b05F646939c3366` — funded with
  **0.120292 ETH** on chain 4663 at nonce 0; swept after the exposure. After
  that sweep: nonce 1, **0.000086 ETH** dust. The funds did not come from any
  of the three Safe signers (their balances were unchanged).
- PoG signer `0xE7c1bCbCc5b8bB9B40F6E39C382bA94713588B7a` — held 0.

`.env.production` was untouched: all three `REPLACE_ME` lines still intact. The
blast radius stopped at two keypairs and the sweep gas.

**2026-09-08 update — the dust figure is no longer true.** Current balance is
**0.108286 ETH**, nonce 1. While distributing funding the same day, the
operator sent 0.1082 ETH **back into** this burned address.

| Time (UTC) | From → To | Value |
|---|---|---|
| 03:38:10 | `0x31909A77434e499F3e302293A43050fc4D67D827` → PoG signer `0x0E496Bd5…` | 0.12 ETH |
| 03:54:14 | PoG signer → mainnet deployer `0x4E41CEa9…` | 0.0117 ETH |
| 03:54:49 | PoG signer → **`0xf9D360fC…`** | 0.1082 ETH |

Transaction hashes: the second is
`0x430d85415307a30ebae96f9e6a9d13a734bb1d5658f4c46dfc052d08adcd1a2d`,
the third is
`0x1493863c816eb15018fd36bee7ce9e0ab1086f70e06b775b9cb073f1e22bc7b8`.

The operator described the third as sending "the remainder to another wallet".
The destination was this burned address, whose private key is plaintext in
terminal capture `9.txt`. The funds are recoverable by anyone who reads that
file. Sweeping them is an **open operator action, not done**.

> **2026-09-09 — swept, and it stayed recoverable for about 29 hours.** Balance
> is now 0.000002 ETH, so the value is out. Worth stating what the window was
> rather than only that it closed: the funds sat at an address whose key is in a
> file on disk from 03:54 on 2026-09-08 until the sweep, and nothing would have
> announced a competing withdrawal — the watcher has no alert on this address,
> because it is not a protocol contract and there was never a reason for it to
> hold value. Being unmonitored is the part worth keeping in mind; the loss
> would have been noticed by checking a balance, which is to say eventually.
> The address stays burned and must never be funded again.

A burned address stays a live attractor for as long as it remains in anybody's
address book or paste buffer. This sweep treated burning as terminal; it is
not, because the address outlives the decision.

All three transactions are type-2 with gas limit **25200** (= 21000 × 1.2,
which is `cast`'s default 20% buffer) and `maxPriorityFeePerGas` = **0**. That
is `cast`'s signature rather than a browser wallet's, which established the
key had been used from a CLI and therefore that shell history, not a wallet
vault, was where to look. That scan is §5.32.

**The same shape as §5.20 and §5.22.** A control confident about a model of the
world that had drifted. Advice about where a secret does *not* go is only as
good as its inventory of where output lands.

**The fix** is in the runbook, not in code. Both EOAs are generated in a terminal
the editor does not manage. The deployer snippet writes the key straight into
`.env.production` and echoes only the address; the PoG snippet puts the key on
the clipboard for the Vercel paste and then clears it. The key is never
displayed. The deployer is funded with only the ~0.0117 ETH it needs: its key
must live in a local file (`script/DeployMainnet.s.sol:97` reads it via
`vm.envUint`), so the balance is the exposure. The previous run put roughly ten
times that on it.

This is the third wrong instruction in `C1_RUNBOOK.md`. The git history already
called the `set -a` omission the second.

### 5.24 Twentieth sweep — a sender error reported as an irreversible property of the recipient

`scripts/verifyOwnerSafe.mjs` section 7 probes whether the owner Safe accepts
plain ETH, because that address is also `PLATFORM_TREASURY`: 0.30 % of every
buy on every pool, forever, immutable once the factory is deployed. A recipient
that reverts on receive bricks every buy, via v4-core's `NativeTransferFailed`.
The probe used `estimateGas` of 1 wei `from` the deployer EOA (or `owners[0]`
if that key is unset) and treated **every** estimate failure as a property of
the Safe: "Do NOT use it as PLATFORM_TREASURY".

**What it concluded wrongly.** The failure it was looking at was the sender's.
ethers v6 surfaces `code === 'INSUFFICIENT_FUNDS'` on that error; the node
returns JSON-RPC `-32000` with `have 0 want 1` naming the sender. A brand-new
deployer holds 0, so the node rejects the estimate before it ever evaluates the
recipient. The same family as §5.20 (priced the funding gap against the testnet
deployer), §5.22 (a guard stricter than the scanner it guards) and §5.23 (the
runbook named the wrong residue): a control confident about a model of the
world that had drifted. Here, an error on the sender, reported as a property of
the recipient, about a setting that cannot be rotated.

**Measured on chain 4663 against `https://rpc.mainnet.chain.robinhood.com`,
2026-09-08.** The node identifies as `nitro/v3.11.4-rc.3`. Two facts that were
true when the defect was found, and one that had already moved by the time the
fix ran:

- From a 0 ETH sender (`0xE7c1bCbCc5b8bB9B40F6E39C382bA94713588B7a`, the
  burned PoG EOA of §5.23) to the Safe: `INSUFFICIENT_FUNDS`,
  `have 0 want 1`. This is the defect's input.
- From Signer #3 (`0x3b7ff171A71281b1D77e18ae1A0bC725D69712E6`, 0.089 ETH) to
  the Safe: **27674 gas**. Matches `C1_RUNBOOK.md` §0.
- The live deployer `0x4E41CEa950cF40FA59774B409988D6F9F399E690` now holds
  **0.0117 ETH**, the runbook amount. Direct `estimateGas` from it already
  returns 27674–27675. The brief's "unfunded deployer" was true when measured
  and is not true now; the live path is a pass even without the override
  recovery. The constructed 0 ETH sender is what the classification is tested
  against.

**(a) State overrides on `eth_estimateGas`.** Honoured. Three-argument form
`[tx, 'latest', { [from]: { balance: 100 ETH } }]` from the 0 ETH sender to
the Safe returns **0x6c1a (27674)**. The same override to PoolManager
`0x8366a39CC670B4001A1121B8F6A443A643e40951` returns `CALL_EXCEPTION` /
`execution reverted` — the override funds the sender and still measures the
recipient. Two-argument form `[tx, overrides]` is rejected (`invalid
arguments; neither block nor hash specified`). An override that sets the
balance to `0x0` still returns `INSUFFICIENT_FUNDS`, so the node is not
ignoring the third parameter. ethers v6's `provider.estimateGas` has no
overrides path; the retry is raw `provider.send('eth_estimateGas', …)`.

**(b) Sender choice.** Kept as `roles[0]?.[1] ?? owners[0]` — deployer when
`PRIVATE_KEY` is set. Shopping for a funded `from` would pass on this machine
(Signer #1, `owners[0]`, holds 0.005 ETH; #3, owner 3, holds 0.089) and leave the
next caller, whose deployer is empty and whose owners are too, with the same
misdiagnosis. The failure is not silent: a synthetic-balance hit prints that
the sender could not pay, and that this is not a reason to rotate
`PLATFORM_TREASURY`. If the node will not honour overrides, the check reports
indeterminate (exit 2), not a pass and not "Do NOT use it".

**The three states.** Accepts ETH (report the gas, as before). Rejects ETH
(today's fatal wording, kept, because it is right when it is right). Cannot
be determined (exit 2). Exit 2 follows `preflightMainnet.mjs`'s table: a guard
that cannot run must not be mistaken for one that found nothing, and must not
be mistaken for one that found a problem. `preflightMainnet.mjs` now treats
that exit as `cannotRun` when it is the only finding, and as a distinct
"could not determine" failure — never "rejected" — when other checks have
already failed.

**Mutation tested, 8 assertions. One survived the first run.**

| | Scenario | Expected |
|---|---|---|
| P1 | live funded deployer, healthy Safe | ~27674 gas, exit 0 |
| M1 | 0 ETH sender, healthy Safe, overrides on | 27674 gas, synthetic note, **not** "Do NOT use" |
| M2 | 0 ETH sender, overrides deleted | exit 2, "could not determine", **not** "Do NOT use" |
| M3 | `to` = PoolManager (code, rejects plain ETH) | exit 1, "Do NOT use it as PLATFORM_TREASURY" |
| M4 | `gas > 1n` (the 100000n branch, tripped by 27674) | exit 1, high-gas warning |
| M5 | original catch-all restored, 0 ETH sender | "Do NOT use" returns — the test can fail |
| M6 | `isSenderFundsError` always false, 0 ETH sender | override recovery does not run |
| M7 | `isRecipientRevert` always false, PoolManager | fatal wording lost |

P1, M1–M5 as expected. M6 fell through to exit 2 rather than the original
"Do NOT use", so the misdiagnosis does not come back if the structured
classifier is gutted; the override recovery does. M7 **survived**: a real
reject becomes exit 2 (indeterminate) instead of the fatal wording. It still
does not pass, and it still does not tell anyone to rotate the treasury.
That is the fail-safe default this fix chose — unknown errors must not mint
irreversible advice — and not the §5.22 M1 class, where nothing could be
fatal *and* the output looked like a finding. Left as is; tightening it
reintroduces the catch-all.

M8 (`process.exit(2)` → `process.exit(0)` on the unknowns block) produced a
clean-looking pass with the "could not finish" text still printed. Killed by
reading the exit code, which is the same discipline `C1_RUNBOOK.md` §4
already requires of preflight.

The cascade, against a real exit 2: preflight prints `CANNOT RUN` and exits
2, not `verifyOwnerSafe.mjs rejected PROD_OWNER_SAFE`.

**What this does not fix, and what the brief had already moved on.** Live
preflight is now `✓ clear for C1`. Check 6 prices C1 at ~0.00413 ETH and the
deployer holds 0.0117, over 2×. The instruction to expect that check to fail
was right when the deployer was empty and is not right now. Section 7 no
longer claims the Safe is unusable; it never should have.

**The sweep count itself is now the same shape of defect.** Updating "19
(§5.1–§5.23)" / "nineteen numbered sweeps" / the §6 and §7 range references
is the second time in two commits these four-to-six sites have had to be
hand-updated in lockstep. This document has repeatedly said a total that
reconciles against nothing is a defect, and this count is now demonstrably
one. A guard is warranted. Not built in this sweep.

### 5.25 Twenty-first sweep — a complete mainnet factory with no artefact

PM-C1 broadcast on 2026-09-08. **The pair below stopped being canonical on
2026-09-12**, when the immutable referral split forced a redeploy to factory
`0x2920ca7E9fcD85491D699e1f9Ae2CAa65Cfb2892` and treasury
`0x255722226720914eF5B2CD54647f21f584BD4Ea2` at block 61056709; see §5.35. This
section is left as written because it is the record of that day's sweep, including
the ownership state it found mid-handoff. Chain 4663, blocks
57400516–57400521:

- `ToshFactory` `0xBa9d2E86281b988225Eca383C375215912fb20B9` (10,789 bytes)
- `ToshLadderTreasury` `0x99aD248dD15498957B864Fd79917F0E103Aa78F7` (6,035 bytes)

Five transactions, all `status=0x1`, 9,353,658 gas, 0.0026585890501 ETH.
Ownership is mid-handoff: `owner()` on both is still the deployer
`0x4E41CEa950cF40FA59774B409988D6F9F399E690`, `pendingOwner()` is the Safe
`0x2953957774482efA660921df85A1E7634ccfe27A`. That is PM-C2, in progress,
not closed from this seat.

**How the second deployment was found.** The deployer's nonce is 11.
`broadcast/DeployMainnet.s.sol/4663/run-latest.json` accounts for five
transactions (nonces 6–10). Computing CREATE addresses for nonces 0–10 and
checking each for code found a complete parallel pair from an earlier run:

- Orphan `ToshFactory` `0x96a2A0f43225184d4C47A47Ed8d919233f5c1aBF` — nonce 2, 10,789 bytes
- Orphan `ToshLadderTreasury` `0xbA6c032d0FAacd2A11B86Da7D3c82fbbba1ce4D4` — nonce 1, 6,035 bytes

Verified live against `https://rpc.mainnet.chain.robinhood.com` on 2026-09-08.

**What is live.** The orphan pair is self-consistent and fully wired: the
orphan treasury's `factory()` returns the orphan factory, and the orphan
factory's `ladderTreasury()` returns the orphan treasury. It is not a
half-deployment. `pogSigner()` is the same `0x0E496Bd5…` as the canonical
factory. `owner()` is the deployer and `pendingOwner()` is the same Safe —
the earlier run reached its ownership staging too. `paused()` is **false**.
`createLaunch` (`ToshFactory.sol:676`) is `external payable whenNotPaused
nonReentrant` with no access control; `registerPoG` is likewise
`whenNotPaused` and not `onlyOwner`. The orphan factory is a live, open,
unmonitored launchpad on mainnet.

**What is not in this repository.** `broadcast/DeployMainnet.s.sol/4663/`
contains only `run-latest.json`, which is the second run. The first
deployment exists on chain and nowhere in this tree. Foundry's
`transactions[]` hashes in the surviving artefact are also permuted relative
to `receipts[]` (metadata follows nonce order; hashes follow receipt order);
receipts and live `cast tx` agree with each other.

**What is not a risk.** PoG signatures cannot be replayed onto the orphan
factory. `registerPoG` at `ToshFactory.sol:601` builds the digest as
`keccak256(abi.encode(msg.sender, maxAlloc, nonce, deadline, address(this), block.chainid))`,
so a signature issued for the canonical factory recovers to the wrong hash
on the orphan and reverts `InvalidSignature`. Chain id is the same (4663);
`address(this)` is what binds the signature to one factory.

**Disposition is an operator decision, not this sweep's.** The options in
front of the operator:

1. Pause the orphan factory now with the deployer key, while they still hold
   it. One `onlyOwner` `pause()` call. Closes `createLaunch` and
   `registerPoG`.
2. Leave it, and treat `pendingOwner` as a standing option for the Safe.
3. Have the Safe accept ownership of the orphan and pause it.

The hard constraint: anything that requires the deployer key must happen
**before PM-D1/D3 rotates and destroys it**. After that, only the Safe route
remains. This sweep records the finding and the constraint. It does not
assert which option was chosen.

This is a finding, not a policy note. The last two sweeps were a wrong
residue in a runbook and a sender-funds error reported as a property of the
Safe. This one is an unmonitored mainnet launchpad that the repository did
not know it had.

**The sweep count is now the third consecutive commit to update it by
hand.** §5.24 already said a guard for this count is warranted, after the
second lockstep update in two commits. This is the third. Still not built.

### 5.26 Twenty-second sweep — the single-key window closed, and the orphan paused

PM-C2 executed on 2026-09-08. The canonical pair on chain 4663 now has
`owner()` = Safe `0x2953957774482efA660921df85A1E7634ccfe27A` and
`pendingOwner()` = the zero address, on both contracts. The deployer EOA
`0x4E41CEa950cF40FA59774B409988D6F9F399E690` no longer controls either.
The single-key window §5.25 recorded as mid-handoff is closed.

**How it was sent.** One batched Safe transaction, not two. MultiSendCallOnly
v1.4.1 at `0x9641d764fc13c8B624c04430C7356C1C7C8102e2`, operation = 1
(DELEGATECALL), Safe nonce 0. `safeTxHash`
`0x13602041beeb67d02fb828c79502839a0f2a65a663c43d1d0646bd4c8ec17ea1`.
On-chain tx `0x002ad51544aa6b7377d689bf30f4822e45278a882887bf1fa6f363a95ed4b3eb`,
block 57455937, status success, gasUsed 106151, submitted by signer
`0xC2EA14cE2112B18AFBC78fE78C969b3002F07cbB`. Safe nonce is now 1.

Approving a DELEGATECALL from a Safe is the highest-risk operation type
available, so the target's identity was established independently rather
than assumed from a well-known-address list. MultiSendCallOnly at that
address was confirmed to be the canonical Safe deployment by comparing
its runtime codehash across chains:
`0xecd5bd14a08c5d2122379900b2f272bdf107a7e92423c10dd5fe3254386c9939`,
410 bytes, byte-identical on Ethereum mainnet, Arbitrum One and Base. The
three candidate `safeTxHash` values were read from the Safe's own
`getTransactionHash()` and independently recomputed locally via EIP-712;
all matched. The batch was dry-run through the Safe's own simulateAndRevert,
which delegatecalls the target and reverts with `(success, returndata)`;
the inner success flag came back `true` before any signature was collected.

**The orphan factory is paused.** Option 1 of the three §5.25 listed, taken
while the deployer key still held it. Orphan `ToshFactory`
`0x96a2A0f43225184d4C47A47Ed8d919233f5c1aBF` was paused by the deployer
EOA in tx `0x1cb660941cbaef807c6575d2512eaaa7d3b395751dc4f093d05006bde6f04404`,
block 57435481, status success, gasUsed 30198. `paused()` now returns
`true`. `createLaunch` on the orphan is dead.

Both orphans still have `owner()` = deployer and `pendingOwner()` = the
Safe. That is deliberate and safe: the pending assignment is already on
chain, so the Safe can accept them at any future time even after the
deployer key is burned. §5.31 originally declined that path; the same
section now reverses it. The accept-then-renounce batch **executed
2026-09-09** at nonce 2; both orphans now read `owner()` = zero and
`pendingOwner()` = zero, so nothing below about the deployer still
holding this pair survives — it is kept as the record of the state that
made the batch necessary. The orphan `ToshLadderTreasury`
`0xbA6c032d0FAacd2A11B86Da7D3c82fbbba1ce4D4` has no Pausable at all.
Pausing its factory closes `createLaunch` and therefore any new hook
that could call `autoPiggybackBuyback`. The treasury's remaining live
paths are `onlyOwner` (still the deployer on this pair) and
permissionless `pokeBuyback`, which spends a reservoir on listed tokens
and is inert without either.

**The Q1 drill page is not reusable for this.** Investigated and recorded
so nobody re-investigates. Three independent reasons. The page never
lived in this repository; it was `jayoo101/tosh-status` `/drill/index.html`
and was taken down on 2026-09-04 (commit `4fb65314`, "Q1 drill closed").
`scripts/checkDrillPage.mjs` is designed to pass silently on 404, which
is why CI stayed green. It is hardcoded to testnet 46630, the drill Safe,
and a single testnet factory, in a fixed four-step pause/unpause loop.
And `checkDrillPage.mjs` actively forbids pointing it at production: it
asserts the page's Safe is not the mainnet Safe, and asserts the page
reads nothing from the URL, on the stated grounds that a parameterisable
page turns that origin into a Safe-transaction phishing site.
Repurposing it would have meant defeating a guard written specifically
to prevent that. The correct path was `app.safe.global`.

**Safe infrastructure on 4663 is listed and indexed, not verified as a
way to build a call.** Safe's official config service lists chain 4663 as
Robinhood Chain, shortName robinhood, `l2: true`, transaction service
`https://api.safe.global/tx-service/robinhood`. The Safe is indexed
there as version 1.4.1+L2, threshold 2, 3 owners. Therefore
`https://app.safe.global/home?safe=robinhood:0x2953957774482efA660921df85A1E7634ccfe27A`
works directly. Those facts are still true. What they do not
establish — and what this sitting inferred from them — is that the UI
offers an entry point for constructing an arbitrary call. This
paragraph previously headed that inference as "verified as a UI path"
and closed *"that assumption is now verified rather than hoped for"*.
Indexing and a working home URL do not verify it. The recheck is
§5.29: Transaction Builder is not in chain 4663's Apps registry, the
paste-the-ABI flow is reachable only by a direct appUrl, and the
original heading was the overclaim. It remains load-bearing for the
P0 pause runbook that the Safe is indexed and that the home URL
opens; the construction entry is the URL §5.29 records, not a menu on
that home page.

**`VerifyDeployment.s.sol` was run against the live factory with the
optional strict cross-checks active** (`EXPECTED_OWNER`,
`EXPECTED_POG_SIGNER`, `EXPECTED_PLATFORM_TREASURY` all set). It passed:

```
Factory                 : 0xBa9d2E86281b988225Eca383C375215912fb20B9
Chain ID                : 4663
Owner                   : 0x2953957774482efA660921df85A1E7634ccfe27A
V4 PoolManager          : 0x8366a39CC670B4001A1121B8F6A443A643e40951
PoG signer              : 0x0E496Bd529646770192C7c35c65Ee1BB0e554E1b
Platform Treasury       : 0x2953957774482efA660921df85A1E7634ccfe27A
Hook implementation     : 0x3Ef9373aaeD8abc9FbcD1B8435f858344fF7BfAd
Ladder Treasury         : 0x99aD248dD15498957B864Fd79917F0E103Aa78F7
Launch fee (wei)        : 100000000000000000
Default soft cap (wei)  : 10000000000000000000
Max PoG alloc (wei)     : 100000000000000000
Cooldown duration (sec) : 86400
Paused?                 : false
initcodeHash (live)     : 0x3a706af1817f0f630ccde8389a67d0bffd6a4744f5e4e0dc6e914bb8bd0e91ef
HOOK_CREATION_CODEHASH  : 0xc43a20c91d0f3164cdeb07d8786c61184c105825a9edec30a8df949f41b4d139
```

**Source-to-chain fingerprint, done by hand, never before performed.**
`HOOK_CREATION_CODEHASH` exists so off-chain tooling can prove the
deployed implementation was built from audited source
(`HookDeployLib.creationCodeHash`, stored on the factory at
construction). Nothing in this repository had ever actually performed
that comparison. It has now been done: `keccak256` of the local build's
`out/ToshLaunchpadHook.sol/ToshLaunchpadHook.json` bytecode.object
(21,734 bytes, no unlinked library placeholders) equals the on-chain
`0xc43a20c91d0f3164cdeb07d8786c61184c105825a9edec30a8df949f41b4d139`.
The deployed hook implementation is provably built from the current
source tree.

**Two defects in the script that produced that output, one of which is
the reason the fingerprint had to be done by hand.**

**Defect A.** The usage block in the file's header said that if
`FACTORY_ADDRESS` is in the env you can "just" run the script without
`--sig`. That command fails with `Error: Multiple functions with the
same name 'run' found in the ABI`, because the contract declares both
`run()` and `run(address)`. The working invocation needs `--sig 'run()'`.
The header is corrected in this commit. Comment only; the signatures
are unchanged.

**Defect B.** The summary block prints `initcodeHash (live)` and
`HOOK_CREATION_CODEHASH` on adjacent lines and never compares them.
They are not supposed to be equal: `getLiveHookInitcodeHash()` returns
the clone initcode hash built from sentinel values, while
`HOOK_CREATION_CODEHASH` is the implementation's creation-code
fingerprint. Printing two similar-looking hashes side by side with no
annotation invites an operator to conclude the deployment is broken.
A one-line note is now logged under them. The adjacency is the defect;
comparing them would be a different, wrong check.

**What this sweep did not do, and it is the constant's entire stated
purpose.** The script still has no check that the on-chain
`HOOK_CREATION_CODEHASH` matches the local build. The comparison above
was performed manually. Not implemented here.

**The sweep count is now the fourth consecutive commit to update it by
hand.** §5.24 said a guard is warranted; §5.25 said it was the third
and still not built. This is the fourth. Still not built.

### 5.27 Twenty-third sweep — the status page was still reading the rehearsal chain

PM-C1 deployed the 4663 factory. The public status page in
`jayoo101/tosh-status` kept naming testnet 46630. `checkStatusPage.mjs`
check 6 is the alarm that exists for exactly that: once
`broadcast/*/4663/` appears, a page that still votes testnet is
reporting the `paused()` state of a contract that is not holding user
funds, and it looks healthy while doing so. CI went red. That is the
guard working as designed, not a broken check.

**The page is now pointed at mainnet.** Active `CHAIN` block: name
`Robinhood mainnet · 4663`, RPC `https://rpc.mainnet.chain.robinhood.com`,
explorer `https://robinhoodchain.blockscout.com`, factory
`0xBa9d2E86281b988225Eca383C375215912fb20B9`. The testnet block sits
commented beneath it, the same shape the mainnet placeholders used to
have, so a revert is one edit. `STATUS` / `DETAIL` / `UPDATED`, the
`COPY` object (whose `paused:` wording is byte-compared against
`INCIDENT_RESPONSE.md` Step 4), the `data: '0x5c975abb'` eth_call, and
the `MANUAL_INTERACTION.md` link were not touched. `/sign/` already
named 4663.

**A second defect in the same guard, which the cutover would have
tripped even after a correct swap.** Check 5 votes each of `name`,
`rpc`, `explorer` as testnet / mainnet / unknown via
`/testnet|46630/i` then `/mainnet|4663\b/`, and fails if the three
do not agree or any is unknown. The canonical mainnet explorer
`robinhoodchain.blockscout.com` contains neither `mainnet` nor `4663`,
so it voted unknown. The vanity alias
`explorer.mainnet.chain.robinhood.com` would have voted mainnet on the
substring, and was rejected: a GET of `/address/<factory>` against it
returns 200 and lands on `https://robinhoodchain.blockscout.com/` —
the `/address/…` path is dropped. Every address link on the status
page would then send a responder to the explorer's front page.
`foundry.toml`, `ROBINHOOD_MIGRATION.md`, `C1_RUNBOOK.md` and
`INCIDENT_RESPONSE.md` already treat the Blockscout hostname as
canonical. The vote rule now recognises that exact hostname as
mainnet. Testnet is still matched first, so
`explorer.testnet.chain.robinhood.com` still wins on `testnet` even if
a string somehow contains both. The testnet Blockscout is a different
host entirely.

**`monitoring/alerts.json` placeholders filled** with the same three
mainnet addresses: factory `0xBa9d2E86…`, ladder treasury
`0x99aD248d…`, owner Safe `0x29539577…`. `chainId` was already 4663.
This is documentation, not runtime config: `monitoring/watch.mjs`
reads `alerts.json` for alert specs and state-check ids, and takes
factory / treasury / owner / signer from `MONITOR_*` (or
`NEXT_PUBLIC_*`) environment variables. Filling the placeholders does
not change what the watcher calls.

**What this sweep did not do.** The frontend half of PM-C7 —
`soat-frontend` and `.env.production` still pointing at 46630 — is
still open. The live status page stays red against check 6 until
`tosh-status` is pushed; that is expected, and the guard is not
weakened to paper over it. `ROBINHOOD_MIGRATION.md`'s header still
said "Ownership is mid-handoff (PM-C2)" after C2 closed; that sentence
is corrected in this commit rather than recorded as known drift.

**The sweep count is now the fifth consecutive commit to update it by
hand.** §5.24 said a guard is warranted; §5.25 was the third, §5.26
the fourth. This is the fifth. Still not built.

### 5.28 Twenty-fourth sweep — the mainnet watcher went blind and reported success

PM-E2's configuration cutover is done. GitHub repository variables
`MONITOR_FACTORY` / `MONITOR_TREASURY` / `MONITOR_EXPECTED_OWNER` /
`MONITOR_EXPECTED_POG_SIGNER` and the secret `MONITOR_RPC` point at
chain 4663. A `workflow_dispatch` of `.github/workflows/watch.yml`
(run 34196807435) then produced:

```
[watch] chain 4663 · blocks 56,592,252-57,492,252 · 0 log(s) · 0 hook(s) known · 28 finding(s), 1 paging
watcher exited 1 (28 finding(s))
```

Zero logs. The scan window contained seven. Verified independently
with `eth_getLogs`: factory `0xBa9d2E86281b988225Eca383C375215912fb20B9`
had three logs at 57,400,521 and 57,455,937 (`OwnershipTransferStarted`,
`OwnershipTransferred`); treasury `0x99aD248dD15498957B864Fd79917F0E103Aa78F7`
had four across 57,400,516–57,455,937, including `FactorySet`. Those
are GOV-01, GOV-02, GOV-03, GOV-06, GOV-07 — all P0.

Running `monitoring/watch.mjs` locally against mainnet named the
cause: every `eth_getLogs` after the first handful returned JSON-RPC
`Too Many Requests` (code 429) and was recorded as WATCHER-02,
`page: false`, "these alerts were NOT checked this pass."

**The limiter is on the 4663 public endpoint and was not on 46630.**
Measured 2026-09-08 against `https://rpc.mainnet.chain.robinhood.com`:

- Tight sequential loop of identical `eth_getLogs`, no delay: requests
  1–6 succeed, request #7 returns a JSON-RPC body error `Too Many
  Requests` (code 429). It is not an HTTP 429. Detection that looks at
  `res.status` misses it.
- The same loop with 250 ms between calls: 0 failures in 24.
- Concurrent calls via `Promise.all`: fail immediately.
- Window width is not the constraint. A 1,000,000-block `eth_getLogs`
  is accepted, address-scoped and address-less — the number §7.1
  measured on testnet and treated as an endpoint capability.

That is why the 900k-block rehearsal on 46630 gave false confidence.
The testnet node accepted a tight loop. The code path that trips the
mainnet limiter is "one `eth_getLogs` per topic0, back to back", which
is exactly the event loop in `watch.mjs`. A capability probe that only
asks "will this node answer a million-block filter" cannot see a rate
limit that needs seven identical calls to appear.

Three defects, the second of which is the dangerous one.

**Defect 1 — no throttle, no retry.** `rpc()` was a single `fetch`. A
rate-limited call became WATCHER-02 and those alerts were skipped for
the pass. Fixed in `monitoring/rpc.mjs`, shared by the watcher and the
probe: one in-flight request, 250 ms minimum interval (the interval
that measured 0/24 on this endpoint, this date), and four retries with
exponential backoff (500 ms × 2^attempt) on a JSON-RPC 429 / "Too Many
Requests". Bounded, so a dead endpoint still throws. Other errors are
not retried. A hardcoded sleep with no provenance is what someone
deletes later; the numbers live in the file header next to the
measurement.

**Defect 2 — a blind pass reports as a normal pass.** WATCHER-02 was
`page: false`. Non-paging findings are never filed as issues; they
only print. Run 34196807435 filed exactly one issue (WATCHER-03, the
expected cutover notice) and the job went green, while every P0
governance alert in the window went unchecked. Same failure shape
WATCHER-03 was written to stop — a monitor that scanned nothing,
produced a finding that does not page, and left the scheduler looking
at a healthy run.

The rule, chosen against §6's noise budget rather than as "page on any
RPC hiccup":

- Retry absorbs a transient 429. That is Defect 1. WATCHER-02 is after
  those retries are exhausted.
- If the skipped topic's alerts include any P0, WATCHER-02 pages. An
  unchecked P0 is an outage of the monitor.
- P1/P2-only topics that fail still record WATCHER-02 and still do not
  page. A PARAM-02 miss every cycle would spend the budget that exists
  to keep the P0s unmuted.
- A pass that completed zero log queries is WATCHER-04, which always
  pages: zero logs after a total skip is a blind monitor, not a quiet
  chain. One finding, not one per topic.
- Neither WATCHER-04 nor a P0-blinding WATCHER-02 advances
  `lastBlock`. The cutover pass wrote `lastBlock = head` after scanning
  nothing and made the window unrecoverable from the resume path.

The workflow's `::error::The watcher could not run. It scanned nothing
this pass` did not fire. It is wired to exit code 2, which is "you
configured me wrong" (no factory address, unparseable state file).
This run exited 1 because WATCHER-03 paged, and the next line of the
same step says "1 is something paged, which means the watcher worked"
and deliberately does not fail the job. That is not a wiring typo in
the `if [ "$code" -eq 2 ]` sense — it did what it was written to do —
and it is why a blind-but-WATCHER-03 pass was green. WATCHER-04 now
emits the same `::error::` and fails the scan step; filing still runs
(`always()`, except exit 2) so the issue is not lost to the red X.

**Defect 3 — `probeRpc.mjs` was testnet-shaped and crashed on
mainnet.** It ignored the `MONITOR_*` convention `watch.mjs` uses:
RPC from `argv[2]` / `ROBINHOOD_TESTNET_RPC` / the testnet URL, and
factory/treasury from `NEXT_PUBLIC_*` or hardcoded testnet addresses
`0x2E690A91…` / `0x3Fd38489…`. Invoked with `MONITOR_RPC` pointed at
mainnet it silently probed testnet and reported the testnet deployer
as owner, plus "0 of 24 alerts have matching history". It did print
`note  alerts.json targets chain 4663; this endpoint is 46630`, which
is the only reason this was caught. Invoked correctly against mainnet
it crashed with an unhandled `Too Many Requests (code 429)` from a
`Promise.all` of two `eth_getBlockByNumber`s. It now honours
`MONITOR_RPC` / `MONITOR_FACTORY` / `MONITOR_TREASURY` (`argv[2]` still
wins for the URL), refuses those testnet address fallbacks when the
endpoint's chain does not match `alerts.json`, prints the mismatch as
a banner on both stdout and stderr, and uses the same transport as
the watcher.

**What this sweep did not do.** It did not turn GitHub Issues into a
pager. §7.3 of `ONCHAIN_MONITORING.md` still holds: this host is
best-effort, silent after 60 idle days, and an issue at 03:00 is
detected rather than reported. PM-E2 stays 🟡 for that reason, not
because the re-point has not happened.

**The skipped window will not be swept.** Decided 2026-09-08, and
written here because the decision is invisible in the code and will
otherwise look like the cutover pass ate 900,000 blocks by accident.
That pass advanced `lastBlock` to 57,492,252 while every `eth_getLogs`
was rate-limited. The window it skipped, 56,592,252–57,492,252, holds
the seven governance logs named above: factory
`0xBa9d2E86281b988225Eca383C375215912fb20B9` emitted
`OwnershipTransferStarted` and `OwnershipTransferred`; treasury
`0x99aD248dD15498957B864Fd79917F0E103Aa78F7` emitted
`OwnershipTransferStarted`, `OwnershipTransferred`, and `FactorySet`.
Those map to GOV-01, GOV-02, GOV-03, GOV-06, GOV-07 — all P0.

They will not be filed. They are the deployment and ownership handoff
we performed ourselves — PM-C1 and PM-C2 — and they are already
recorded in this dossier (§5.25, §5.26, and the PM-C rows they closed)
in more detail than an alert would carry. A non-dry re-scan of that
window would open five P0 issues describing actions taken on purpose.
That is precisely how a P0 label stops meaning anything, and §6 of
`ONCHAIN_MONITORING.md` already says so about a different mechanism:
the noise budget exists to keep the P0s unmuted, and spending it on a
firehose of expected events is how they get muted. So the watcher's
observed history on mainnet begins at block 57,492,253. That is a
stated limitation, not an oversight.

**What was done instead.** The transport and paging fix was verified
without filing anything, by a `dry` `workflow_dispatch` of the same
job over a window that contains those seven events (run 34200408580,
`--since 150000`):

```
[watch] chain 4663 · blocks 57,368,530-57,518,530 · 7 log(s) · 0 hook(s) known · 7 finding(s), 7 paging
```

Seven logs where the broken pass saw zero, and zero WATCHER-02
entries. Same CI environment that failed before, so this is a real
verification and not a local-only one.

**Issue hygiene.** All seven open `watcher`-labelled GitHub issues
were closed on 2026-09-08. #20–#25 were artefacts of the 46630
rehearsal, each naming the testnet factory
`0x2E690A91b383eDB21f6b5B4180Cc4a2C905C6BeA`. GitHub issue #26 was the
WATCHER-03 cutover notice, closed because its own stated condition was
met: the following pass (run 34200284533) resumed from the checkpoint
at 57,492,253, scanned 25,382 blocks, and exited 0.

**An address-less `LaunchCreated` that is not ours.** Investigated and
recorded so nobody re-investigates. `probeRpc.mjs`'s address-less
survey of `LaunchCreated` reports one hit on mainnet. It comes from
`0x78936d83771eacaf03a2f78553428f91dd66f5d9`, which is not a
`ToshFactory`: 18,635 bytes of runtime against `ToshFactory`'s 10,789,
`paused()` reverts, and `owner()` returns
`0x35ce119999b7e4da1d34812de64f70ff4d44ea23`, an address unrelated to
this project. It is an unrelated contract on the chain that happens to
share the `LaunchCreated(uint256,address,address,address,string,string)`
signature — exactly the noise the address-less scope was documented to
expect (`ONCHAIN_MONITORING.md` §2.1). LIFE-03 is factory-scoped, so
`watch.mjs` correctly ignores it. Verified alongside it: both of our
factories have emitted `LaunchCreated` zero times and both hold a zero
balance, so nothing is stranded in the paused orphan.

**The sweep count is now the sixth consecutive commit to update it by
hand.** §5.24 said a guard is warranted; §5.25 was the third, §5.26
the fourth, §5.27 the fifth. This is the sixth. Still not built.

### 5.29 Twenty-fifth sweep — the 60-second path opened an app this chain does not list

The question originally asked was whether the Safe could drive
`soat-frontend`'s admin page, so that a signer would not have to leave
the app they already have open in order to pause. The answer is no.
Looking produced a larger problem: the incident playbook's 60-second
path named a menu this chain does not offer.

**Finding A — the connector idea is dead on this chain.** Safe's config
API `https://safe-client.safe.global/v1/chains/4663` returns features:
`BRIDGE`, `EIP1559`, `MULTI_CHAIN_SAFE_ADD_NETWORK`,
`MULTI_CHAIN_SAFE_CREATION`, `NATIVE_SWAPS`, `NATIVE_SWAPS_FEE_ENABLED`,
`PORTFOLIO_ENDPOINT`, `POSITIONS`. It does not include `SAFE_APPS`,
`NATIVE_WALLETCONNECT`, `EIP1271`, or `TX_SIMULATION`. Chain 1 and
chain 8453 both list `SAFE_APPS`, `NATIVE_WALLETCONNECT` and `EIP1271`.
Therefore neither a wagmi `safe()` Safe-App connector nor a
WalletConnect connector can let the Safe drive the admin page. Recorded
so nobody proposes it again in six months.

The corollary: on mainnet the admin page is a read-only console for
everyone, including the three signers. That is tolerable **because**
the Transaction Builder path in Finding B exists. The two findings are
linked — a read-only admin page with no working pause construction
would be a different, worse fact.

**Finding B — the playbook's 60-second path had an untested link.**
`INCIDENT_RESPONSE.md` §1.1, recorded 2026-09-04, concluded *"So
`app.safe.global` is usable and §2 Step 1's paste-the-ABI flow is not
hypothetical."* §5.26, the day PM-C2 landed, restated it as *"Safe
infrastructure on 4663 is now verified as a UI path, not only as
singletons"* and *"that assumption is now verified rather than hoped
for."* Those sentences are now corrected in place in §5.26, matching
§1.1; the quote is the original wording. Both conclusions were drawn
from three true facts: the Safe
contracts are at their canonical addresses, chain 4663 is in Safe's
supported-chain list, and the transaction service answers. None of
those facts establish that the UI offers an entry point for
constructing an arbitrary call. That was the untested link, and it is
the link a responder actually depends on at 03:00.

The 46630 rehearsal did not cover it. §1.1's throwaway Safe and §8.2's
2-of-3 both drove `execTransaction` from a script
(`scripts/drillSafe.mjs`). They proved the contracts will execute an
arbitrary call. They never opened `app.safe.global`'s app surface. This
is the same class of defect as §5.28's blind pass reported success: a
green check measuring something adjacent to the thing that matters.

**What was actually verified**, 2026-09-08, against the real Safe
`0x2953957774482efA660921df85A1E7634ccfe27A` on chain 4663.

The working path is the direct URL

`https://app.safe.global/apps/open?safe=robinhood:0x2953957774482efA660921df85A1E7634ccfe27A&appUrl=https%3A%2F%2Fapps-portal.safe.global%2Ftx-builder`

A Disclaimer / Warning modal appears, stating the application is not in
the default Safe Apps list and naming the source origin
`https://apps-portal.safe.global`. After Continue, the full Transaction
Builder UI loads: a "New Transaction" panel with an address field, an
ABI textarea, and a Custom data toggle that accepts raw `to` / `value`
/ `data` with no ABI at all. The Safe header rendered `0x2953…e27A` and
`2/3`. Observed without connecting a wallet — connecting is only needed
to propose.

The Apps list at
`https://app.safe.global/apps?safe=robinhood:0x2953957774482efA660921df85A1E7634ccfe27A`
does render, and lists exactly those two registry apps. Searching it
for "Transaction Builder" returns, verbatim: *"No Safe Apps found
matching Transaction Builder. Connect to dApps that haven't yet been
integrated with the Safe{Wallet} using WalletConnect."* The
`NATIVE_WALLETCONNECT` feature is absent, so that suggested fallback
does not exist either. The home-page **New transaction** button is
disabled until a wallet is connected, so a responder cannot even
enumerate its options first. There is a "My custom apps" tab with an
"Add custom Safe App" button, which is how the URL above gets
registered once, ahead of time.

`https://safe-client.safe.global/v1/chains/4663/safe-apps` returns
exactly those two apps. Chain 8453 returns 29, including Transaction
Builder. So the app is not in chain 4663's registry; the direct appUrl
is the way in.

**Why we can assert the path works end to end and not merely renders.**
PM-C2 (§5.26) landed as a MultiSendCallOnly v1.4.1 batch at
`0x9641d764fc13c8B624c04430C7356C1C7C8102e2` with `operation` = 1
(DELEGATECALL), Safe nonce 0, on-chain tx
`0x002ad51544aa6b7377d689bf30f4822e45278a882887bf1fa6f363a95ed4b3eb`.
That is the transaction shape Transaction Builder emits. The app is
not merely drawing a form; it has already produced a real, executed
governance transaction on this chain.

**What was fixed.** `INCIDENT_RESPONSE.md` §2 Step 1 no longer says
"New Transaction → Contract Interaction". It opens at the direct URL,
names the Disclaimer modal as expected, puts Custom data (`pause()` =
`0x8456cb59`) ahead of the ABI paste under time pressure, and tells
every signer to register the custom app on their own machine now.
§1.1's 2026-09-04 inference is corrected in place; the contracts, the
supported-chain listing and the transaction services stay on the
record. §2b's mainnet halt line pointed at the same missing menu and
is pointed at the same URL.

**Standing action.** Each of the three signers registers Transaction
Builder via My custom apps → Add custom Safe App, on the machine they
will actually have at 03:00. A bookmark on one laptop is not an
operational control.

**What this sweep did not do.** Nobody has clicked Create Batch → Send
Batch through this UI on 4663 with a wallet connected *as a drill*.
The evidence is a production transaction of the right shape, not a
rehearsal. The natural place to close that is the Q1 drill in
`INCIDENT_RESPONSE.md` §8. A mainnet Q1 would now be a `pause()` /
`unpause()` on a live factory, which is a decision, not a formality.

The drill transaction is now built, verified, and pending signature —
the orphan accept-then-renounce batch recorded in §5.31. It has not
been executed. Safe nonce is still 1, which is the proof. This is not
the drill completing.

> **The drill did complete, 2026-09-09.** That batch executed at nonce 2
> (execution tx `0xba5995e1…`), which closes this paragraph: signers have
> now driven Transaction Builder on chain 4663 end to end, through the
> direct appUrl §5.29 records, using Custom data rather than an ABI
> because the orphans are unverified on Blockscout. That is the same
> sequence the P0 pause runbook asks for, on the same UI, against
> contracts whose bytecode is identical to the canonical pair. What it
> still does not rehearse is `pause()` on a live factory — the batch
> called `acceptOwnership` and `renounceOwnership` — so the decision
> above stands, but the UI-mechanics half of the rehearsal is no longer
> untested. §5.31 also records the one route that does *not* work, which
> the attempt discovered: raw MultiSend calldata pasted into Raw Data
> executes as CALL and reverts.

**The sweep count is now the seventh consecutive commit to update it by
hand.** §5.24 said a guard is warranted; §5.25 was the third, §5.26
the fourth, §5.27 the fifth, §5.28 the sixth. This is the seventh.
Still not built.

### 5.30 Twenty-sixth sweep — the published hashes were live, and the comparison was still a human

PM-C6 closed on 2026-09-08. `RecomputeInitcodeHash.s.sol` was run against
the live factory `0xBa9d2E86281b988225Eca383C375215912fb20B9` on chain
4663, block 57592077, with `--sig 'run(address)'` — the contract declares
both `run()` and `run(address)`, so forge cannot pick an entry point
without it. The two hashes it prints match the values read independently
with `cast` the same day, and the local creation bytecode matches the
on-chain constant:

```
Factory                 : 0xBa9d2E86281b988225Eca383C375215912fb20B9
Chain ID                : 4663
Block                   : 57592077
HOOK_CREATION_CODEHASH  : 0xc43a20c91d0f3164cdeb07d8786c61184c105825a9edec30a8df949f41b4d139
local creationCode hash : 0xc43a20c91d0f3164cdeb07d8786c61184c105825a9edec30a8df949f41b4d139
  MATCH -- keccak256(type(ToshLaunchpadHook).creationCode)
  equals on-chain HOOK_CREATION_CODEHASH.
  This is the implementation creation-code fingerprint.
getLiveHookInitcodeHash : 0x3a706af1817f0f630ccde8389a67d0bffd6a4744f5e4e0dc6e914bb8bd0e91ef
  clone initcode hash with sentinel constructor values.
  Different measurement from HOOK_CREATION_CODEHASH;
  they MUST differ. Not compared, not a mismatch.
Wired V4 PoolManager    : 0x8366a39CC670B4001A1121B8F6A443A643e40951
Wired PoG signer        : 0x0E496Bd529646770192C7c35c65Ee1BB0e554E1b
Wired Platform Treasury : 0x2953957774482efA660921df85A1E7634ccfe27A
Wired Ladder Treasury   : 0x99aD248dD15498957B864Fd79917F0E103Aa78F7
Launch Fee (wei)        : 100000000000000000
Default Soft Cap (wei)  : 10000000000000000000
Per-wallet cap (wei)    : 100000000000000000
```

`extractAbis.js` produced no diff.

The output is committed here rather than as a new file under `broadcast/`.
`RecomputeInitcodeHash` does not broadcast, so there is no
`run-latest.json` to hang it on; the sibling `VerifyDeployment` snapshot
already lives in §5.26 as a dated block, and this is the same kind of
evidence.

**The comparison §5.26 did by hand is now in the script that prints the
constant.** `keccak256(type(ToshLaunchpadHook).creationCode)` is asserted
against on-chain `HOOK_CREATION_CODEHASH` and reverts
`HookCreationCodehashMismatch` on disagreement. That is the method §5.26
used: the artifact's `bytecode.object` is that creation code. The sitting
that recorded the fingerprint also recorded that the script still did not
perform it.

It does not compare `HOOK_CREATION_CODEHASH` to `getLiveHookInitcodeHash()`.
Those measure different things and are supposed to differ — clone initcode
with sentinel constructor values versus the implementation's creation-code
fingerprint. §5.26 Defect B was the adjacency inviting that misreading;
comparing them would be a different, wrong check. The script now labels
each line with which measurement it is, and the only assertion is
like-with-like.

**Not a CI gate, on purpose.** The script needs a live RPC. The 4663
public endpoint rate-limits a tight request loop (§5.28), and putting a
live probe on every push is how the watcher reported success while
blind. On-demand, when a deployment needs a fingerprint.

**A stale pointer of a class this file already tracks.** The script told
the operator, in the header and on the JSON drop-in line, to paste the
output into `soat-frontend/src/app/lib/factoryDeployments.ts`. That file
does not exist. `INCIDENT_RESPONSE.md` §2 Step 1 had the identical name
and was corrected once; its Step 3 now carries the note that a previous
version named a file a responder at 3am would have lost minutes to. The
same wrong filename survived here. Both sites now say there is no file
to paste into: the launch page reads `factory.hookInitcodeHash(...)`
from chain, and the JSON is the published record.

**What this sweep did not do.** It did not write the two hashes into
`.env.production`. That file is gitignored and holds a live private key;
the operator pastes them. The launch page does not need the copy.

**The sweep count is now the eighth consecutive commit to update it by
hand.** §5.24 said a guard is warranted; §5.25 was the third, §5.26
the fourth, §5.27 the fifth, §5.28 the sixth, §5.29 the seventh. This
is the eighth. Still not built.

### 5.31 Twenty-seventh sweep — the custody check never looked for a copy

Closing PM-D1 / PM-D3 assumed the remaining laptop copies in
`soat-frontend/.env.local` were testnet-era values already treated as
burned by `PRE_MAINNET_CHECKLIST.md` §4.1. That is true of one of the
three. It is not true of the other two.

**The assumption that was wrong.** Supabase projects and Upstash
databases are not chain-scoped. There is no testnet copy versus mainnet
copy; they are just projects. The operator confirmed on 2026-09-08 that
Vercel Production points at the same Supabase project
(jurgikqkyqlasayfvvzx) and the same Upstash database
(literate-lynx-73342) as `soat-frontend/.env.local`. Those laptop
copies were never burned testnet artefacts. They are the live
production credentials.

**The scan.** A throwaway diagnostic read the literal values out of
`soat-frontend/.env.local` and searched every terminal capture and
agent transcript under the Cursor project directory — 207 files,
37.5 MB — reporting only whether each literal appeared. It printed no
values and was deleted immediately after the run.

| Credential | Result |
|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` | literal value present in agent transcript `82ef4787-…jsonl` |
| `UPSTASH_REDIS_REST_TOKEN` | literal value present in the same transcript |
| `POG_SIGNER_PRIVATE_KEY` | present in 5 files including terminal capture `968879.txt` — derives to `0x73db078fa94607893270079AC8F5c7492aB480cd`, the testnet-era address already on §5.23's burned list. Known, already-dispositioned, not a new exposure |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | present, and irrelevant — public by design, RLS is the control |
| `BLOCKSCOUT_API_KEY` | not set locally, skipped |

**What the derivation proved in the other direction.** The mainnet PoG
signing key (`0x0E496Bd529646770192C7c35c65Ee1BB0e554E1b`, matching
`factory.pogSigner()`) was not in this corpus. PM-D1's custody rule
held — **for the corpus this sweep searched.** That corpus was terminal
captures and agent transcripts. It omitted shell history. §5.32 found
the live key there, in plaintext. The irony is exact: this sweep
diagnosed `checkSecretStore.mjs` as a check that measured something
adjacent to the thing that mattered, and its own scan then committed
the same error.

**What the two leaked credentials can do.**

`SUPABASE_SERVICE_ROLE_KEY` bypasses row-level security entirely on the
production project. Anyone holding it can rewrite any project's name,
logo and outbound links — a live phishing vector on the production
site. `soat-frontend/.env.production.example` already says this in the
block that defines the variable.

`UPSTASH_REDIS_REST_TOKEN` is not only the rate-limit counter store.
The same two Upstash variables also back the live Proof-of-Gas
exchange rate (`soat-frontend/.env.production.example`, the paragraph
immediately after those variables): without a shared store an
owner-signed rate rotation lands on whichever instance served the
POST, and every other instance keeps signing allocations at the old
rate. Holding the token means being able to write that shared rate.
The rate is the multiplier `sign-allocation` applies to a wallet's
scanned gas when it computes `maxAlloc`, so whoever holds the token
can set how much allocation every wallet can be signed for.

**Severity.** These are local files on the operator's machine. There
was no public disclosure and no on-chain consequence. What is true is
that two live production credentials left the secret store and sat in
plaintext in files that are routinely read by tooling and by AI
agents — including by an agent that was explicitly instructed to
consult that transcript. This repository's own precedent, set in
§5.23, is that a key which reaches a terminal capture or a transcript
is burned rather than reasoned about. The same standard applies here.

**The structural defect.** `npm run check:secrets`
(`soat-frontend/scripts/checkSecretStore.mjs`) verifies that every
credential is in the right store at the right tier. It has never
verified the absence of a copy anywhere else. It was green throughout
this entire episode and would have stayed green indefinitely. PM-D3's
evidence column even claims "no secret in any committed `.env*`" —
true, and it measures committed files, while the exposure was in an
uncommitted one. That is the same shape as §5.28 (a check that
measured something adjacent to the thing that mattered) and §5.29
(an inference drawn from true but insufficient facts).

**The guard.** The same script now asserts that every `secret`-tier
name in `INVENTORY` is absent or empty in the local dotenv files
under `soat-frontend/` (`.env`, `.env.local`, and other `.env*`
siblings, excluding `*.example` templates). Presence of a non-empty
assignment is the entire signal; values are never printed and never
compared. If no such file is present — CI, because `.env.local` is
gitignored — the check reports that local copies were not evaluated,
rather than treating an empty scan as a pass. On this machine the
check is now green (27/27), which is the cleanup of the copies this
sweep found. It is not a clean custody surface: §5.32 is an open
custody defect on a different variable, on the same machine,
dispositioned as accepted rather than fixed. There
is no bypass flag. The failure names the variable, the file, and that
the fix is deletion plus rotation, not deletion alone.

**The deployer key.** The operator has destroyed the mainnet
deployer key `0x4E41CEa950cF40FA59774B409988D6F9F399E690` — deleted it
from `.env.production`, kept no copy, and abandoned its residue rather
than spend a transaction sweeping it. Confirmed 2026-09-08.

Verified on chain 2026-09-08: that address has no authority over the
canonical contracts (`ToshFactory`
`0xBa9d2E86281b988225Eca383C375215912fb20B9` and `ToshLadderTreasury`
`0x99aD248dD15498957B864Fd79917F0E103Aa78F7` are both `owner()` =
Safe `0x2953957774482efA660921df85A1E7634ccfe27A`). It is still the
`owner()` of both orphans: the orphan `ToshFactory`
`0x96a2A0f43225184d4C47A47Ed8d919233f5c1aBF` (paused, balance 0) and
the orphan `ToshLadderTreasury`
`0xbA6c032d0FAacd2A11B86Da7D3c82fbbba1ce4D4` (balance 0, no listed
tokens, no Pausable at all). Deployer nonce is 12.

Destroying the key is the stronger outcome, not a loss. It leaves the
orphan factory permanently paused and the orphan treasury permanently
inert — whereas transferring the orphans to the Safe would have
handed the Safe an `unpause()` it has no use for, and keeping the
key in cold storage preserves a single-key liability for contracts
we never want touched again. What destroying the key made irreversible
is the single-key unpause. The orphan pause itself is §5.26. Done.

**The orphan-disposition reversal.** An earlier paragraph of this
sweep recorded that both orphans have `pendingOwner()` = the Safe, so
the Safe could still `acceptOwnership` after the key is gone, and
that **the decision includes not taking that path.** That is reversed.
The operator had separately chosen to have the deployer call
`renounceOwnership()` on both orphans *before* destroying the key.
The key was destroyed without those two transactions being sent (the
deployer's on-chain nonce confirms it: 12, and no such calls exist).
So the orphans are stranded with a dead owner.

Verified on chain 2026-09-08:

- orphan `ToshFactory` `0x96a2A0f43225184d4C47A47Ed8d919233f5c1aBF`:
  `owner()` = `0x4e41cea9…` (destroyed key), `pendingOwner()` = Safe
  `0x2953957774482efa660921df85a1e7634ccfe27a`
- orphan `ToshLadderTreasury` `0xbA6c032d0FAacd2A11B86Da7D3c82fbbba1ce4D4`:
  identical

The remedy now chosen is precisely the path this sweep said would not
be taken: the Safe performs `acceptOwnership()` then immediately
`renounceOwnership()` on each orphan, atomically in one MultiSend
batch. That is still the correct end state. It produces exactly what
renounce-then-destroy would have produced (`owner()` zero,
`pendingOwner` cleared, the orphan factory permanently unpausable by
anyone), and it no longer depends on a key that no longer exists. The
Safe holds ownership only inside a single atomic transaction.

The batch, built 2026-09-08 and executed 2026-09-09:

| Field | Value |
|---|---|
| Safe | `0x2953957774482efA660921df85A1E7634ccfe27A` (v1.4.1, 2-of-3) |
| Safe nonce | 2 (the first build sat at 1; see below) |
| to | `0x9641d764fc13c8B624c04430C7356C1C7C8102e2` MultiSendCallOnly |
| operation | 1 (DELEGATECALL) |
| value, safeTxGas, baseGas, gasPrice | all 0 |
| gasToken, refundReceiver | zero address |
| `safeTxHash` | `0x389d443c7cdaf6a799f2545e0abb06f530cfcad475a5c016c97649fb80f35587` |
| execution tx | `0xba5995e1dde8f0287422dd327aa10de76d633ad6100cfd6d85cd3bd733cff3b2`, block 58,601,352 |

Four inner calls, in order: orphan factory `acceptOwnership()`
`0x79ba5097`; orphan factory `renounceOwnership()` `0x715018a6`;
orphan treasury `acceptOwnership()`; orphan treasury
`renounceOwnership()`.

The `safeTxHash` was computed by the Safe's own `getTransactionHash()`
via `eth_call` rather than assembled locally, and reproduced
independently. A simulateAndRevert dry run of the delegatecall
returned success = 1, returndatasize = 0 — all four inner calls
pass.

**Status: EXECUTED and verified on chain 2026-09-09.** Both orphans now
read `owner()` = zero and `pendingOwner()` = zero; the orphan factory
also still reads `paused()` = true, so it is stopped and there is no
longer an address that could ever `unpause()` it. The Safe's nonce is 3.
The canonical pair is untouched: factory `0xba9d2e86…` and treasury
`0x99ad248d…` both still read `owner()` = the Safe with `pendingOwner()`
zero, and the factory is not paused.

The `ExecutionSuccess` log carries `safeTxHash`
`0x389d443c…`, matching the hash computed here byte for byte. That is
worth recording for a reason beyond bookkeeping: the batch was created
through Transaction Builder's own batching UI, which assembles the
MultiSend payload itself, and it arrived at the identical hash. The two
independent constructions agreeing is what licenses reading the dry run
above as evidence about the transaction that actually executed.

> **A batch cannot be handed to Transaction Builder as raw calldata.**
> The obvious-looking route — paste the assembled `multiSend(bytes)`
> calldata into the Raw Data field with `to` = MultiSendCallOnly — was
> tried and rejected on evidence: that field produces `operation` = CALL,
> and an `eth_call` of it from the Safe reverts. `multiSend` dispatches
> its inner calls with CALL from whatever context it runs in, so under
> DELEGATECALL `msg.sender` on the orphans is the Safe, which is
> `pendingOwner`, while under a plain CALL it is MultiSendCallOnly, which
> is not, and `acceptOwnership()` refuses. A batch has to be built as a
> batch, through the UI's own batching, so that the Safe SDK emits the
> delegatecall. There is no field in that app for setting `operation`.

**What this sweep's operator actions became.** Confirmed complete on
2026-09-08:

- Supabase service_role key rotated in the console, Vercel Production
  updated, local `.env.local` deleted.
- Upstash Redis token rotated in the console, Vercel Production
  updated, local `.env.local` deleted.
- Local `POG_SIGNER_PRIVATE_KEY` (the burned testnet one) cleaned up.
- Deployer `PRIVATE_KEY` destroyed from `.env.production`.
- `npm run check:secrets` reports 27/27 green.

That is not a clean custody surface. §5.32 is an open custody defect
on a different variable, on the same machine, dispositioned as
accepted rather than fixed.

**The sweep count is now the ninth consecutive commit to update it by
hand.** §5.24 said a guard is warranted; §5.25 was the third, §5.26
the fourth, §5.27 the fifth, §5.28 the sixth, §5.29 the seventh,
§5.30 the eighth. This is the ninth. Still not built.

### 5.32 Twenty-eighth sweep — the generation flow was hardened and the verification step was not

The operator explained that the mainnet PoG signer
`0x0E496Bd529646770192C7c35c65Ee1BB0e554E1b` had on-chain nonce 2
because they had used it to forward ETH to the deployer and move the
remainder onward. Sending a transaction requires the private key to be
loaded into something that can sign it. That is by definition a copy
outside Vercel Production, which is where PM-D1 says it is the only
place the key may exist.

**What triggered the re-check.** A nonce of 2 on the live signer is
not a custody question that can wait. PM-D1's rule is binary: the key
is in Vercel Production, or it has been copied. Nonce 2 is the second
half.

**The scan.** A throwaway diagnostic extracted every 64-hex string
from 208 files (all Cursor terminal captures under
`.cursor/projects/<slug>/terminals/` plus all agent transcripts),
derived the secp256k1 address for each of the 134 distinct
candidates, and compared them against a watchlist of 8 addresses. It
printed only which watched addresses matched, never a value, and was
deleted immediately after the run. 131 of the 134 candidates are
"valid" private keys in the arithmetic sense — any 64-hex below the
curve order is — so the count is meaningless and only watchlist hits
matter.

| Address | Result |
|---|---|
| `0x0E496Bd5…` mainnet PoG signer | clean |
| `0x4E41CEa9…` mainnet deployer | clean |
| the three Safe owners | clean |
| `0xf9D360fC…` and `0xE7c1bCbC…` (§5.23's burned pair) | present in terminal capture `9.txt` — already known and dispositioned |
| `0x73db078f…` (testnet, §5.31) | present in 5 files — already known |

No new exposure in that corpus. This independently confirms §5.31's
conclusion — **for the corpus §5.31 searched.**

**The corpus was incomplete.** Shell history files are not
Cursor-managed and no sweep had ever scanned them. A second scan
covered `%APPDATA%\Microsoft\Windows\PowerShell\PSReadLine\ConsoleHost_history.txt`
and `~/.bash_history`. The entire history corpus contained exactly
one 64-hex literal, and it derives to
`0x0E496Bd529646770192C7c35c65Ee1BB0e554E1b` — the live mainnet PoG
signing key, in plaintext, on disk.

**The leak path, and why it is the exact inverse of §5.23.** The
offending line was `cast wallet address` with the key as a literal
argument. The runbook's generation flow — which is §5.23's own fix —
worked exactly as designed: the key was never displayed, it went
clipboard → Vercel. The break came afterwards, when the operator
pasted the key into that command to confirm which address it derived
to.

§5.23 concluded, correctly at the time, that "command history is not
the exposure on this machine" and that the editor's terminal capture
was. Its fix moved key generation out of the editor into an external
PowerShell. That fix is what made the sentence stop being true: once
generation left the editor, PSReadLine became the exposure. §5.20 and
§5.22 are the shape "a control confident about a model of the world
that had drifted"; this one is narrower and worse — a control that
named the right threat, and then relocated the asset into the threat
it had just excluded. §5.23 inventoried where output lands. Nothing
inventoried where input is typed.

**What the key can do.** Verified on chain: canonical `ToshFactory`
`0xBa9d2E86281b988225Eca383C375215912fb20B9` has `pogSigner()` =
`0x0e496bd5…`, `paused()` = **false**, `maxPogAllocationLimit()` =
**0.1 ether**. Holding the key means being able to sign `registerPoG`
attestations granting any wallet up to 0.1 ETH of quota. The
canonical factory has **zero** launches, so quota currently buys
nothing. It becomes real value the moment PM-C3 announces the
address or PM-C8 lists a token.

The contract anticipated this precisely. The docstring on `pause`
(`src/ToshFactory.sol:404-410`) is the brake written for this event.
It says `registerPoG` stays gated because it "mints new spending
budget against an oracle signature, which is the one thing that
needs a faster brake than `setPogSigner` if the signer key leaks."

**Disposition — accepted deviation, not a fix.** The operator decided
on 2026-09-08 **not to rotate**. The reasoning, recorded honestly, and
the counter-argument, which is the stronger one:

- For: exploitable value is currently zero; rotation costs a Safe
  transaction plus a Vercel update and a redeploy.
- Against: deleting the line does not un-leak the value. Volume
  Shadow Copies, backups, file-recovery tooling and anything that
  synced that file may still hold it. **This repository's own
  precedent, set in §5.23 and reaffirmed in §5.31, is that a key
  which reaches a plaintext capture is burned rather than reasoned
  about. That precedent is not being followed here.**

**The hard gate.** Rotation must happen before PM-C3 (announce the
factory address) or PM-C8 (list a token). Until either lands the leak
has no exploitable value; after either, it does. This is a blocking
precondition, not a recommendation.

> **Reversed on 2026-09-09 — rotation is happening.** The deviation
> above survived exactly as long as the gate did. The operator moved to
> lift PM-C3 and PM-C8 while keeping the key, which is the one
> combination the gate exists to prevent: it is not two independent
> decisions but the conversion event itself, and the leak stops being
> worthless at the moment the pair is applied together. Put that way,
> the "against" bullet this document had already recorded as the
> stronger argument is the one that carried, and the operator chose to
> rotate.
>
> Worth noting what the earlier decision was working from, because it
> was not wrong about cost. It was taken while the Safe path was
> unexercised. It has since executed at nonce 0, a second batch is
> signed and waiting at nonce 1, and `setPogSigner` is a single
> `onlyOwner` call needing no contract redeploy — so the signing round
> that rotation requires is one the signers were assembling anyway.
>
> **And a rotation is five actions, not one, which is the part that
> invites a half-finished job.** Three are obvious: the new key into
> Vercel Production, a frontend redeploy, and `setPogSigner` from the
> Safe. Two are not, and both were found by reading rather than by any
> check:
>
> - `POG_PRIVATE_KEY` is a second legal name for the same key
>   (`loadOracleAccount` reads `POG_SIGNER_PRIVATE_KEY ?? POG_PRIVATE_KEY`),
>   and it was **not in the custody inventory**. Setting the primary and
>   leaving the superseded key in the alias would have left the leaked
>   value live in a store while `check:secrets` printed every row green,
>   which is §5.31's failure repeated on a different name. Now
>   classified `absent` and currently reporting unset, so the gap is
>   closed ahead of the rotation rather than after it.
> - `MONITOR_EXPECTED_POG_SIGNER` is what `STATE-04` compares
>   `factory.pogSigner()` against (`monitoring/watch.mjs:410-416`). It
>   still holds the leaked address, so a rotation that skips it makes
>   the watcher page correctly about the operator's own action — and,
>   worse in the long run, a stale expectation is what would let a
>   rotation nobody authorised go unremarked.
>
> The generation procedure given for the new key drops the step that
> caused this incident rather than making it safer: address and private
> key are taken from a single `cast wallet new`, the address printed and
> the key sent straight to the clipboard, so the pairing holds by
> construction and there is never a reason to run `cast wallet address`
> on a literal. PSReadLine records input, not output, so no command in
> the sequence carries the key. `cast wallet address --interactive`
> exists as the recovery path if an address is lost, and reads the key
> from a hidden child-process prompt rather than the command line — that
> is the derivation route whose absence made pasting the literal the
> natural thing to do, and it was in the tool the whole time.

**Rotation landed 2026-09-09, and verified in five places rather than
one.** `factory.pogSigner()` is
`0x9A1a8C7b7D68d391909F02e8bD5B148b4B95b736`, an EOA at nonce 0 that
holds no balance, carries no code, and collides with none of the eight
addresses this project has reason to know: the old signer, the dead
deployer, the Safe, §5.23's two burned keys and the three Safe owners.
`POG_SIGNER_PRIVATE_KEY` is sensitive and write-only in Vercel
Production with no local dotenv copy, `POG_PRIVATE_KEY` is unset, and
`MONITOR_EXPECTED_POG_SIGNER` carries the new address, so `STATE-04`
compares the live signer against the live expectation instead of a
retired one. The nonce is the property to keep watching: PM-D2 says
this key never sends a transaction, so **0 is not a starting value but
the permanent one**, and nonce 2 on its predecessor is the whole reason
this sweep exists.

**One casualty, and it is a lesson about Safe nonces rather than about
keys.** The orphan accept-then-renounce batch had been signed by both
owners at nonce 1 and was waiting to be executed. `setPogSigner` was
executed first and took nonce 1, because that was simply the next free
slot — and `_nonce` is a field inside the EIP-712 `SafeTx` struct, so
both signatures stopped authorising anything at that moment. Nothing
announced it. A signature does not become invalid in a way anybody is
told about; it just ceases to describe an executable transaction.

The batch was rebuilt at nonce 2 and, as a check on the reconstruction,
hashing the same four calls at nonce **1** reproduces the recorded
`0xffe2da614a1cadfbe531d238b3db9f46ba9580a8fb31f777d8245a8d5d56e14d`
byte for byte — which proves the rebuild is the same batch in a
different position rather than a new one that merely looks similar. The
hash to sign is now
`0x389d443c7cdaf6a799f2545e0abb06f530cfcad475a5c016c97649fb80f35587`,
and `simulateAndRevert` against the Safe returns success for it, run as
a `DELEGATECALL` exactly as `operation = 1` will.

That rebuild was signed and executed the same day (tx `0xba5995e1…`,
block 58,601,352), and the `ExecutionSuccess` log carries
`0x389d443c…` — so the second signing round is spent and the batch is
closed. §5.31 holds the verified end state.

**The generalisation worth keeping:** a Safe queue is not a set of
independent authorisations. Two transactions signed for the same nonce
are mutually exclusive, and executing either silently retires the
other. This repository has now spent two signing rounds on one batch
for that reason. Execute what is signed before starting the next thing,
or plan to re-sign.

A second, smaller lesson from the same batch: **the queue being empty is
not evidence the transaction does not exist, and a locally computed
`safeTxHash` never populates it.** The hash here was produced by
`eth_call` against the Safe's own `getTransactionHash()`, which reads
state and posts nothing; only creating the transaction in the UI submits
it to the Safe Client Gateway. Operators looked at an empty queue and
reasonably asked for execute parameters — which do not exist either,
since a rebuilt hash starts with zero signatures and no key in this
project's tooling is a Safe owner.

**What was actually done.** The single offending history line was
removed programmatically — the line, not the file, so the operator's
other 363 lines of history survive (364 → 363). A re-scan of the
rewritten file confirms 0 occurrences of the key. No value was
printed at any point. The scrub script was deleted after the run.

**The runbook gap.** The generation snippets in `C1_RUNBOOK.md` §§1–2
echo the address and warn against putting the key on a command line.
They never showed a way to derive an address without typing the
literal, which is what made pasting it the natural thing to do. That
omission is corrected in the same sitting as this sweep.

**The sweep count is now the tenth consecutive commit to update it by
hand.** §5.24 said a guard is warranted; §5.25 was the third, §5.26
the fourth, §5.27 the fifth, §5.28 the sixth, §5.29 the seventh,
§5.30 the eighth, §5.31 the ninth. This is the tenth. Still not
built.

---

### 5.33 Twenty-ninth sweep — a deploy flag that could not have worked, and a checklist row that assumed it had

**PM-C4 was not "probably done, needs confirming". It was not done, and
the mechanism it relied on has never been able to work on this chain.**

The row read that way because `--verify` was in the mainnet broadcast
command, and because the *testnet* contracts on 46630 are verified — so
the flag demonstrably works in general, and the only apparent gap was
that nobody had opened the page. Checked 2026-09-09 in a real browser:
both `0xBa9d2E86…` and `0x99aD248d…` show a **Verify & publish** button
with creation and deployed bytecode and nothing else. No contract name,
no compiler metadata, no Read/Write tabs — the state Blockscout renders
for an address it has no source for.

**Why the flag failed, and why it failed silently.** Every path under
`https://robinhoodchain.blockscout.com/api` is behind a Cloudflare
`managed` challenge. Measured directly: `GET /api/v2/smart-contracts/…`
and `GET /api?module=contract&action=getsourcecode&…` both return 403
with the `Just a moment...` interstitial, while `GET /` and
`GET /address/…` return 200. Re-running `forge verify-contract` here
reproduces it exactly — foundry receives that HTML where it expects JSON
and reports:

```
Failed to deserialize response: expected value at line 1 column 1
Error: Failed to obtain contract ABI for 0xBa9d2E86…
```

That is the shape of the problem worth keeping. The message names a
parse failure, not an access failure, so it reads as a transient or
malformed reply rather than a wall that will still be there tomorrow.
During a broadcast it appears after the deployment output, when the
transactions have already succeeded and attention is on the addresses.
A flag that cannot work, failing in the vocabulary of a flag that
usually works, is close to the worst available outcome: it produced a
checklist row that said *confirm this* when the honest row was *this has
not started*.

**The asymmetry that makes it fixable.** The HTML surface is not
challenged, so a human with a browser can complete the verification
form. Nothing can be automated past that point from here, which is why
`scripts/genVerifyInput.mjs` produces files rather than making a call.

Two details in that script are load-bearing and were each learned the
expensive way:

- **Standard JSON, not flattened source.** `foundry.toml` sets
  `via_ir = true`. The flattened flow submits a file and a few form
  fields with nowhere to declare that, so the explorer recompiles
  through the non-IR pipeline, gets different bytecode, and reports a
  mismatch — which looks like the source being wrong rather than the
  submission format being wrong. Standard JSON carries `viaIR`, the
  optimizer runs, the EVM version and the remappings inside the
  document.
- **UTF-8, written explicitly.** PowerShell's `>` emits UTF-16LE. The
  first attempt produced a 1,053,286-byte file where the correct one is
  537,408, and the only symptom before upload is the size.

**What licenses verifying now rather than redeploying.** `src/`,
`foundry.toml` and the `lib/` submodule pointers are byte-identical to
deploy commit `d0220e2` — confirmed by `git diff`, empty on all three.
This is the deploy-time freeze doing its job: it is why the four known-
wrong comments in `src/` were left in place rather than corrected, and
this row is the payoff for that discipline. Correcting them would have
changed the metadata hash and made the deployed bytecode unverifiable
against any tree we still have.

**What this says about the other rows.** PM-C4's evidence column asked
for "public verified source at the deployed address" and the row was
filled in against *the command that was supposed to produce it*. That
substitution — recording the action instead of the outcome — is the same
error as §5.28's blind watcher pass reporting green, and the same as the
PM-C2 batch being reported complete when signatures had been gathered
but nothing executed. Three instances now, in three different systems.
The common shape is that the confirming step is manual and the acting
step is automated, so the act leaves a trace and the confirmation does
not.

**Outcome, same day.** Both contracts verified through the browser form
and both read **exact match**, not partial: `ToshFactory` at 23:18:07
and `ToshLadderTreasury` at 23:26:10, `v0.8.26+commit.8a97fa7a`,
cancun, optimizer on / 200 runs, MIT, constructor arguments decoded,
Read/Write tabs live.

**The explorer's verdict was then checked rather than accepted, and it
is what turned up the rest of this section.** The treasury's banner
adds *"verified using Blockscout Bytecode Database"*, which means the
source was matched out of a store of previously-verified bytecode
rather than necessarily from the upload — a different provenance than
"we submitted this and it compiled to that". So the claim that matters
was tested independently of the explorer: a deploy transaction's input
is `creationCode ++ abi.encode(constructorArgs)`, so stripping the
encoded arguments off the tail leaves a prefix that must equal
`forge inspect <target> bytecode`.

`ToshLadderTreasury` matched byte for byte on the first attempt. The
other two comparisons each failed first and each failure was
informative:

- **`transactions[].hash` in `run-latest.json` does not belong to the
  entry it sits in.** `transactions[1]` is the `ToshFactory` CREATE and
  carries `0xbcec476c…`, which on chain is a 36-byte
  `setFactory(address)` call at deployer nonce 8. The real factory
  CREATE is `0x0eed646b…` at nonce 7, filed under `transactions[4]` and
  labelled a treasury CALL. `receipts[]` **is** positionally aligned and
  is the authoritative mapping — `receipts[1].transactionHash` is the
  factory. Everything else on those entries (`contractAddress`,
  `arguments`, `transactionType`) is correct; only `hash` is permuted.
  Any runbook, dossier or script that quotes a deploy hash out of
  `transactions[]` is quoting the wrong transaction, and the mistake is
  invisible because the hash is well-formed and the transaction exists.
- **`ToshFactory` links an external library**, so its creation code
  carries an unlinked `__$ee832620f4ff53cb02e60c6040e1893895$__`
  placeholder where the address goes. Substituting the address gives an
  exact match. That placeholder is how the third contract was found.

**There is a third contract on mainnet, and nothing outside the
broadcast log knew it.** `src/libraries/HookDeployLib.sol:HookDeployLib`
is deployed at `0x873E0841bc0d8F87102E2a2862a0d32D1b890462`. Its
deployed code is 22,152 bytes and equals this tree's
`deployedBytecode` at every byte except a single contiguous 20-byte
field at offset 65, which on chain holds the library's own address and
locally is zeroes — solc's self-address field, patched in at deploy.
Substituting it yields an exact match, so the library is this tree too.

Why it was invisible is structural rather than careless: `forge script`
deploys libraries through the canonical CREATE2 proxy
`0x4e59b44847b379578588920cA78FbF26c0B4956C`, not as a transaction from
the deployer. So it is not a `CREATE` entry in `transactions[]`, the
deployer's nonce sequence runs 6–10 with no gap to notice, and every
count of what this project put on mainnet said two contracts.
`HookDeployLib` is discussed at length elsewhere in this document and in
`PRD-v5.0.md` — its size, its `assembly` block, its role — but its
deployed address appears in exactly one place in the repository, and
PM-C4's evidence column named two addresses.

**It is not a live surface, and that is verified rather than reasoned
from the source.** Both call sites (`ToshFactory.sol:378` and `:383`)
are inside the constructor, and the deployed factory's *runtime* code
contains **zero** occurrences of the library address — checked against
`eth_getCode`. Nothing the factory does now can reach it. The residual
value in verifying it is the audit trail: `deployImplementation` is what
burned `platformTreasury` into the hook implementation's
`platformFeeRecipient`, which is immutable, has no setter, and takes
0.30 % of the ETH input of every buy on every pool forever. A reader
tracing where that value came from ends up at this library, and until
2026-09-11 found unnamed bytecode. That was the whole of PM-C4's
remaining 🟡. The library verified that day at 02:23:12Z as a full
match — `is_fully_verified` true, `is_partially_verified` false — so
the trail now terminates in named source, and the row is ✅.

A corroborating detail worth keeping: the library's page shows **4
internal transactions** and 0 external ones. Two `DELEGATECALL`s per
factory construction (`creationCodeHash` and `deployImplementation`)
means exactly two factories have ever been constructed on 4663 — the
canonical one and the orphan of §5.26. That is independent evidence
against a third, unnoticed factory, which §5.28 had to reason about from
event topics.

**One defect in this section's own tooling, fixed here.**
`--show-standard-json-input` emits `settings.libraries` **empty**, and
Blockscout accepted the factory anyway by matching the placeholder
positionally against whatever bytes are on chain. The verification is
sound, but the submission relied on a verifier heuristic and the
resulting page does not record which library the factory was linked
against. `scripts/genVerifyInput.mjs` now fills the field from the
broadcast log's `libraries` entry — and fills it *only* where the file
is actually among that document's sources and is not the contract being
verified, because a first pass wrote it into all three and both of the
other two are wrong: the treasury does not import HookDeployLib at all
(absent from its 25 sources, and solc may reject a link naming a source
it was not given), and a library does not link against itself.

**The sweep count is now the eleventh consecutive commit to update it
by hand.** Still not built. It is worth noting that a guard here would
not have caught this one either: no CI runner can read that explorer
past Cloudflare, so verification status is not machine-checkable from
anywhere this project controls. That is a genuine limit rather than an
unbuilt guard, and it means PM-C4 will stay a human check. What *is*
machine-checkable, and now demonstrated, is the stronger claim
underneath it — that the deployed bytecode reproduces from this tree.
An explorer saying "verified" is a statement about what a third party
recompiled; reproducing the creation code locally is a statement about
the bytes themselves, and it does not require the explorer to be up,
honest, or reachable.

---

## 6. Findings

> **This section was reserved for an external report, and by §0 there will not
> be one. It stays because the severity ladder below is still the vocabulary
> every §5 sweep triages against, and §0.3 points here.**
>
> Internal findings are **not** collected here. They live where they were found,
> in the sweep that found them — §5.2 through §5.32 — each with its fix commit,
> its regression test, and its mutation counts. Moving them into a register
> would separate each finding from the reasoning that produced it, which is the
> part worth keeping when nobody external is reading either.
>
> Static analysis is not here either: Slither's 74 findings are triaged in
> **§5.7**.

**External findings to date: none, and none expected.** Previously this line
read "none — no audit has been performed", which described a schedule. It now
describes a decision; see §0.

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

**Retired 2026-09-06.** This table paired external findings with their fixes and
their re-review. Two of its three columns had no source once §0 was decided, and
the third — the fix — is already recorded per finding in §5, next to the
regression test that pins it and the mutation run that proves the test can fail.
A second copy would drift from the first; §5.18 is what that costs.

Internal fixes are found by their sweep: §5.2 and §5.3 for the first two passes,
§5.8 through §5.32 for the numbered ones.

---

## 8. Sign-off

Mainnet deployment requires all three signatures. An unsigned row is a blocker,
not a formality.

| Party | Name | Date | Signature |
|-------|------|------|-----------|
| Protocol engineering lead | | | |
| Safe signer (outside engineering) | | | |
| Operations / on-call lead | | | |

> **A fourth row read "Lead auditor" and was removed by §0, not satisfied.**
> The three that remain are the same three as before and are not a substitute
> for it — per §0 nothing is. Note what the remaining rows have in common: all
> three sign from inside the project. The "outside engineering" qualifier on the
> Safe signer is the widest the reviewing circle now gets.

**Obligations at deploy time.** Any change to `src/ToshLaunchpadHook.sol` after
the factory is deployed — including a comment, which moves the metadata hash and
therefore the initcode hash — desynchronises every address that factory predicts,
because `HOOK_CREATION_CODEHASH` is baked into its constructor. This was
previously filed as a post-audit obligation; it is not an audit artefact at all
but a property of CREATE2, and it now binds from the deploy transaction rather
than from a sign-off date. Before deployment there is no such constraint (§0.4).

> **What the freeze has stranded, now that it is in force.** C1 ran, so this
> paragraph is live for the first time, and the reconciliation of `PRD-v5.0.md`
> against the tree (commits `4e8f4ff`, `2b38b2b`) surfaced four things inside
> `src/` that are known to be wrong or unfinished and **cannot be corrected for
> the life of this deployment**:
>
> | Location | Says | Should say |
> |---|---|---|
> | `src/ToshLaunchpadHook.sol:385` | shelves 0..25 are `109 200` tokens | `81,900`. The range is right; the total is 26 × `4,200`, the per-tier size retired by the 40/60 split, where `TIER_SIZE` is now `3_150e18` |
> | `src/ToshLaunchpadHook.sol:1814` | a piggyback leg needs `~125k` | `156,153`, measured on 4663 against the live V4 singleton (§F.7 of `ROBINHOOD_MIGRATION.md`) |
> | `src/ToshLadderTreasury.sol:107` | `~125k each, measured` | the same figure, rotted the same way |
> | `src/ToshLadderTreasury.sol:32` | a three-character Chinese gloss, parenthesised after "gives a ride" | nothing — it is the last Han text in the repository outside two matcher literals, and it survived the translation pass by being unreachable rather than by being wanted |
>
> None is a behaviour defect: every one of them is prose describing a constant
> that is itself correct, so they mislead a reader and not the machine. The two
> `~125k` figures are the more troublesome pair, because `PRD-v5.0.md` §4.9
> cites them and therefore agrees with them — the document and the comments are
> consistent with each other and both disagree with `PIGGYBACK_MIN_GAS`, whose
> own natspec carries the measurement. That is the shape §5.32's calibration
> reversal already cost us once.
>
> **So the usual precedence inverts here, and it is worth saying out loud** — a
> reader who finds a comment and a document disagreeing will believe the comment,
> because source normally outranks prose. For these four the document is the
> authority, for the plain reason that it can be corrected and they cannot.
>
> The freeze is enforced rather than agreed: `RecomputeInitcodeHash.s.sol:161`
> reverts `HookCreationCodehashMismatch` when the local creation code stops
> matching the constant baked into the live factory, so anyone editing one of
> these comments learns at the next fingerprint check. That is the guard working.
> Blockscout verification of the deployed implementation (PM-C4) breaks on the
> same edit. If `src/` is ever legitimately reopened by a redeploy, these four
> are the queue and all four are one-line changes.

---

### 5.34 Thirtieth sweep — a manual step that could not be taken, and the half of it a machine could take instead

The open item was "click the two-phase PoG flow through once on this
deployment". It had survived several sittings as a pending task. It was not
pending; it was **impossible**, and nobody had checked which.

The PoG button renders only inside a project page in the genesis phase
(`ProjectTerminal/index.tsx:247`). The mainnet factory has never launched
anything. Its complete log history since deploy is **four events, all
governance** — `OwnershipTransferred` twice (construction, then the PM-C2
accept), `OwnershipTransferStarted` once, `PogSignerUpdated` once for the
§5.32 rotation — and **zero `LaunchCreated`** (`0xac89f904…`). No launch means
no hook, no hook means no project page, and no project page means no button.
The instruction had been unactionable since the moment it was written, and
carrying it as a task misrepresented a precondition as effort. The lesson is
narrow and repeatable: a manual step should be checked for *reachability*
before it is checked for completion, because an unreachable step looks exactly
like a neglected one on a checklist.

**What could be automated was, and it moved more than expected.** The scan
stage needs no gas history to exercise — only a valid auth signature — so it
was driven with a throwaway in-memory key against production:

```
POST /api/pog-scan            -> 202 running
GET  /api/pog-scan?address=   -> done in 2.7 s, 1 poll
  eligible          false
  totalGasWei       0
  floorWei          50000000000000000
  truncated         false
  unavailableChains []
```

An ineligible verdict is the **pass**, not the failure: reaching a verdict at
all means the Blockscout credential is present in the runtime, the job store is
reachable, and all five chains were read — `unavailableChains` empty is the
load-bearing field, because a missing credential answers 503 "not configured"
and an unreachable chain names itself there and silently under-counts a real
user. The 2.7 s against a documented 10–23 s is consistent rather than
suspicious: an address with no history has nothing to page through. Combined
with the §5.32 probe, which reached the 409 scan-check and so proved the key
loads and `pogNonces()` reads from 4663, everything in the pipeline is now
confirmed on production except the two things that genuinely require a funded
wallet: that the loaded key is the *same* key the factory accepts, and that
`registerPoG` accepts its signature.

**The first of those two is no longer invisible until it costs someone gas.**
`sign-allocation` has always returned `issuer` — the address derived from the
loaded key, i.e. who actually signed — and the client had always discarded it,
destructuring only the four fields the verifier consumes. It now reads
`factory.pogSigner()` and refuses to send when the two disagree, naming the
drift as a deployment fault. Previously a Vercel key that had drifted from the
on-chain signer — exactly what a half-finished rotation leaves behind, since
the key lives in one system and the address in another — surfaced as
`InvalidSignature()` from `registerPoG` (`ToshFactory.sol:603`), after the
transaction was signed and the gas spent, in an error naming the signature
rather than the configuration.

Two limits belong on the record rather than in a commit message. It runs on the
client, so it is **diagnosis, not enforcement**; `registerPoG` verifies the
signature itself and stays the only thing that decides. And a missing `issuer`
or an unreadable `pogSigner()` deliberately falls through to that verdict
instead of blocking, because a client-side guard may convert a confusing
failure into a clear one but must never invent a failure the chain would not
have produced. The comparison target was confirmed live: `pogSigner()` on 4663
reads `0x9A1a8C7b7D68d391909F02e8bD5B148b4B95b736`.

**Two assumptions about the first launch, both wrong on first statement.** The
`launchFee` — 0.1 ETH when this was written, lowered to **0.01 ETH** later the
same day by an owner Safe call rather than a source edit (recorded in
`PRE_MAINNET_CHECKLIST.md` under the first-launch note) — does not return to
the operator. It is forwarded to
`ladderTreasury`, not `platformTreasury` (`ToshFactory.sol:731`), and
`ToshLadderTreasury` has no `withdraw`, `sweep`, or `rescue` — its header
states the absence as a design choice at lines 42–51, and the only exit is
`pokeBuyback` spending on a listed token, of which there are none. The fee is
therefore genuinely spent, as reservoir seed capital, and is not a refundable
test cost; the arithmetic was initially done as though it were recycled into
the Safe. Zeroing `setLaunchFee` to avoid it is permitted and is the wrong
trade, since it opens a free-launch window on a live permissionless factory
whose address is about to be published. A test **deposit** is a different
matter and is cleanly recoverable: the default soft cap is 10 ETH, a small
deposit cannot reach it, and `refund()` opens once the genesis deadline passes
with `softCapFailed` (`ToshLaunchpadHook.sol:1227`).

**One suspected cross-layer mismatch, checked and cleared.** The scan response
advertises `capWei` of 1 ETH while the on-chain `maxPogAllocationLimit()` is
0.1 ETH, and `registerPoG` reverts `ExceedsGlobalPogLimit` on any `maxAlloc`
above it (`ToshFactory.sol:599`) — which reads like an attestation the chain
would refuse. It is not. `POG_GAS_CAP_WEI` caps the *input*, historical gas
spend, and at the 0.1 rate maps onto `MAX_ALLOC_ETH_WEI`, the *output*
allocation ceiling, which equals the on-chain limit
(`pogQuota.ts:100`, `:184`, `:229`). The two numbers measure different
quantities and `assertPogBandCoherent()` exists precisely to stop the three
from drifting apart (`pogQuota.ts:98`). Recorded as a negative result because
the shape of the near-miss is worth keeping: an input cap and an output cap
denominated in the same unit will keep inviting this reading.

**Incidental, found while preparing the commit.** `soat-frontend/src/app/admin/page.tsx`
was sitting modified in the working tree with a whitespace-only reindent that
`git diff -w` confirmed carried no logic and that left the nesting less
readable than before — a stray auto-format from an earlier sitting. Reverted
rather than committed. Worth a line only because a whitespace-only diff in a
file this sensitive is indistinguishable at a glance from a real change to an
`onlyOwner` console, and an unexplained modified file is how one gets swept
into an unrelated commit.

**Still open after this sweep:** the two-phase walkthrough, now correctly gated
on the first real launch rather than listed as a standalone errand — it is a
step inside that launch, which also first exercises `createLaunch`, the genesis
panel, and `deposit`. `HookDeployLib` `0x873E0841…` was still unverified at the
close of this sweep, with inputs prepared; it verified 2026-09-11 as an exact
match, closing PM-C4.

---

*Last updated: 2026-09-08 — reframed from an external-audit package to the
internal review record it actually is, after the decision in §0 not to engage a
third-party auditor. §6 retains only its severity ladder and §7 is retired;
both explain why in place. §§0.4 and 0.5 are new and are the parts to read
first: 0.4 lists the work that lost its owner when the engagement was cancelled,
and 0.5 says how to read the twenty-odd sentences in §§1–5 that still address an
auditor. §5.23 records the 2026-09-08 runbook instruction that named the wrong
residue and put two keys into the editor's terminal capture. §5.24 records the
ETH-accept probe that blamed the Safe for an empty sender and told the operator
not to use it as PLATFORM_TREASURY. §5.25 records the orphan factory found on
chain 4663 after C1: a complete earlier deployment with no artefact in this
repository, `paused()` false, `createLaunch` open. §5.26 records the same-day
close of that finding: the orphan factory paused, PM-C2 accepted on both
canonical contracts, and the source-to-chain fingerprint of the hook
implementation. §5.27 records the status-page cutover the armed guard had
been failing CI for: the page now names 4663, the vote rule recognises
the canonical Blockscout hostname, and `alerts.json` placeholders are
filled. §5.28 records the first mainnet watcher pass: 0 logs over a
window that held seven P0 governance events, because the 4663 RPC
rate-limits a tight `eth_getLogs` loop and WATCHER-02 did not page.
The skipped window is left unswept on purpose — those seven logs are
the PM-C1/C2 handoff already in §§5.25–5.26 — so observed history on
4663 begins at block 57,492,253. §5.29 records that the 60-second
pause path in `INCIDENT_RESPONSE.md` named a Transaction Builder this
chain's Apps registry does not list; the working entry is a direct
appUrl, verified 2026-09-08 against the real Safe, and the 2026-09-04
inference that contracts-plus-tx-service implied a working paste-the-ABI
UI is corrected in §1.1 and in place in this file's §5.26. §5.30 records
the close of PM-C6: `RecomputeInitcodeHash.s.sol` run against the live
factory, the source-to-chain fingerprint now asserted in that script
rather than by hand, and a recurrence of the `factoryDeployments.ts`
pointer `INCIDENT_RESPONSE.md` §2 Step 1 already had to correct once.
The comparison is on-demand against a live RPC, not a CI gate, because
the 4663 endpoint is the one §5.28 rate-limited the watcher on. §5.31
records that the remaining laptop copies of the Supabase service-role
key and the Upstash REST token were the live production project, not
burned testnet artefacts; that `check:secrets` was green throughout
because it never asked whether a copy existed; and the decision to
destroy the mainnet deployer key rather than sweep it or hand the
orphans to the Safe. Rotation of those two credentials, deletion of
the laptop copies, and destruction of the deployer key are confirmed
complete; the orphan accept-then-renounce batch is built and
verified, not executed (it executed later the same day, at nonce 2 —
see the closing postscript). §5.32 records that the live mainnet PoG
signing key reached PowerShell history in plaintext, that the
disposition is accepted-deviation rather than rotation, and that
rotation is a blocking precondition for PM-C3 and PM-C8.*

*2026-09-09 — four operator reports checked against chain state rather
than accepted. The 0.108286 ETH is swept and `0xf9D360fC…` is empty;
the production frontend is coherent at chain 4663, closing PM-C7 after
a first deploy that carried mainnet addresses under a 46630 chain id;
and the accepted deviation on the PoG key is **reversed** — lifting
PM-C3 and PM-C8 while keeping the key is the conversion event the gate
exists to prevent, so rotation is in progress, in five parts, two of
them outside the contract. One report did not survive the check: the
orphan freeze batch has both signatures but has not been executed, and
Safe `nonce()` of 1 with both orphans still owned by the dead deployer
is the evidence. Signing is not executing. The deploy-time freeze is
also now in force for the first time, stranding four known-wrong
comments in `src/`; they are listed under "Obligations at deploy time"
in §8 rather than as a sweep, because finding them was doc work and
not a review pass.*

*2026-09-10 — §5.34 records the thirtieth sweep, which began by finding that
the outstanding manual step could not be performed at all: the PoG flow
renders only inside a genesis project page, and the factory's entire log
history is four governance events with zero `LaunchCreated`. A step should be
checked for reachability before it is checked for completion. The scan half was
then driven on production with a throwaway key and passed with all five chains
read, so only the signer-identity match and `registerPoG` itself now await a
funded wallet; the identity mismatch is no longer silent until it costs gas,
because the client compares the `issuer` it had always discarded against
`factory.pogSigner()` before sending — diagnosis, not enforcement, and
deliberately non-blocking when either value is unreadable. Also corrected: the
launch fee goes to `ladderTreasury`, which has no withdraw by design, so it is
spent rather than recycled — and later the same day it was lowered from 0.1 to
0.01 ETH on chain, leaving `src/` deliberately unedited and therefore
deliberately divergent. Also cleared: the 1 ETH `capWei` against
the 0.1 ETH on-chain allocation limit is an input cap against an output cap,
not a mismatch, and `assertPogBandCoherent()` already binds them.*

---

### 5.35 Thirty-first sweep — the platform moved and one page kept watching the address it left

The 8 % / 2 % referral split lives in `immutable` storage, so changing it meant
new bytecode, and on 2026-09-12 the platform was redeployed: factory
`0x2920ca7E9fcD85491D699e1f9Ae2CAa65Cfb2892`, treasury
`0x255722226720914eF5B2CD54647f21f584BD4Ea2`, block 61056709, from commit
`9b9d9ce`. The 2026-09-08 pair still exists on chain, unpaused and unowned by
anyone but the Safe, and is out of scope. This sweep is about what a redeploy
does to everything that had written the old address down.

**The finding: the public status page spent four days reporting on a factory
nobody uses.** `jayoo101/tosh-status` hardcodes its own `CHAIN` block, and its
`factory` field still read `0xBa9d2E86…` on 2026-09-12. The page's entire
function is to answer "is the live factory paused" during an incident, from a
host that does not depend on our app. Pausing the real factory would therefore
have left it reporting *operational* — the precise failure it exists to prevent —
and both of its explorer links sent readers to a contract with no users. Fixed at
`8099867`.

**Nothing was ever going to catch this, and that is the part worth generalising.**
The page is in a different repository, so no guard in this one can see it;
`checkStatusPage.mjs` asks whether the page is reachable and internally coherent,
not whether its factory is the factory this repo deploys. A cutover has as many
halves as there are places the address is written, and the halves outside the
repository have no guard by construction. PM-C7 already carried two halves for
exactly this reason and still needed a manual sweep to close the second one.

**`checkStatusPage.mjs` had a cutover check and it was the wrong one, which is
more interesting than not having had one.** Check 6 makes the page's four chain
fields vote testnet-or-mainnet and complains if the vote is testnet once a 4663
broadcast exists. `0xBa9d2E86…` votes mainnet — it is a perfectly good mainnet
factory, merely a retired one — so the guard was satisfied for the whole four
days, and reported `cutover check active` while doing it. The distinction it was
missing is *which* mainnet factory, and the reason that distinction had never
come up is that until 2026-09-12 there had only ever been one.

Closed this sweep as check **6b**: the page's `factory` field is now compared
against the `ToshFactory` `CREATE` entry in `broadcast/*/4663/run-latest.json`.
The comparison introduces no constant to maintain, because the broadcast
overwrites that artefact itself, and the page already had to be parsed for check
6 — so the two values were both already in hand and simply never met. It was
verified by making it fail: fed the retired address as the expected value it
reports the drift rather than passing, which is the only way to know a green
check means anything. Any future immutable change forces another redeploy, so
this will be load-bearing again.

**Two resets that are consequences rather than defects, recorded so they are not
later read as either.** First, PoG attestation is scoped to the factory, so every
user's attestation reset with the redeploy; nothing was lost that cannot be
re-earned, but the live system's attested-user count went to zero silently.
Second, `acceptOwnership()` is per-contract, so PM-C2's 2026-09-08 acceptance
said nothing whatever about the new addresses: the new pair opened its own
single-key window with the deployer as `owner()` and closed it only when the Safe
accepted. A redeploy reopens every per-address control, and the checklist rows
that look "already closed" are the dangerous ones.

**Three things that look like evidence and are not.** All three cost real time
this sweep, and all three fail in the direction of a false negative or a false
positive rather than an error.

1. **Blockscout's own verification form offers a method called `sourcify`, and it
   does not verify on Blockscout.** It renders an embedded `verify.sourcify.dev`
   widget that submits to Sourcify and displays *Sourcify's* result, so it shows a
   green "Match" badge for a contract Blockscout continues to list as unverified.
   Two attempts were reported successful on that basis before anyone read
   `is_verified` from `/api/v2/addresses/<addr>`. There is no path from a Sourcify
   publication into Blockscout's database. The method that works is **Solidity
   (Standard JSON input)**, and all five contracts are verified through it, graded
   `partial match` with `is_verified_via_sourcify: false` — accurate, because
   Blockscout compiled and compared for itself.
2. **A silently re-enabled form was a rate limit, not a rejected payload.**
   Blockscout's verification endpoint allows `x-ratelimit-limit: 1` submission per
   `x-ratelimit-reset` ≈ 18-minute window and answers `429 {"message":"Too many
   requests"}`, but the page surfaces none of it: the form simply re-enables with
   the file still attached. Retrying early spends the attempt and appears to
   restart the window. Found only by installing `fetch` and `XHR` interceptors in
   the page and reading the response instead of the form.
3. **Searching runtime bytecode for a custom-error selector is not a test.**
   Checking whether the new treasury carries the `TwapNotMature` gate by looking
   for `0x6b0cd1ba` in `cast code` returns absent — and that means nothing. Of the
   fourteen custom errors `ToshLadderTreasury` declares, **six leave a literal
   four-byte selector in the deployed runtime and eight do not**, with no relation
   to reachability: `OnlyHook` `0x5a91834f`, `ZeroAddress` `0xd92e233d`,
   `TokenNotLaunchedHere` `0x8696f741`, `InvalidPoolKey` `0xc256622b`,
   `OnlyPoolManager` `0xf655705d` and `PiggybackInProgress` `0x13987a05` are
   findable, while `FactoryNotSet` `0xa7df7fac`, `TokenAlreadyListed` `0xdeaabdc2`,
   `TokenNotListed` `0xc5f0a1ee`, `PoolNotLaunched` `0xf3ea0eb4`, `NotArmed`
   `0x8db2750a`, `OnlySelf` `0x14d4a4e8`, `FactoryAlreadySet` `0x154c51b8` and
   `TwapNotMature` itself are not. Under `viaIR` the selector is frequently
   materialised rather than stored, so **absence carries no information at all**.
   The evidence that holds is the Blockscout match — runtime
   bytecode identical to a compilation of source containing the gate. Probing it
   live is unavailable: `addLadderToken` is owner-only and reverts
   `OwnableUnauthorizedAccount` `0x118cdaa7` before reaching the check.

   *The first version of this paragraph cited two contrasting errors called
   `AlreadyListed` and `NotFactory`. Neither exists — the real names are
   `TokenAlreadyListed` and `FactoryNotSet` — so it had computed selectors for
   signatures no compiler had ever seen and offered their absence as evidence.
   `checkDocSymbols.mjs` refused the commit, which is the second time in this
   dossier that a doc guard has caught a claim resting on a symbol that was never
   there. The numbers above replaced the invention and are a measurement.*

**And one where the verification machine itself was the liar.** DNS and HTTP
checks run from the operator laptop returned addresses in `198.18.0.0/15` for
every hostname, which were read as a registrar parking page and produced a
confident, wrong report that the domain had not propagated. That range is the
fake-IP block a Clash-style local proxy hands out; the tell that was missed is
that the *nameservers* resolved into it too (`launch1.spaceship.net` →
`198.18.0.75`). Real answers came from DNS-over-HTTPS (`dns.google/resolve`,
`cloudflare-dns.com/dns-query`) and from Vercel's own request logs: both
hostnames `76.76.21.21`, serving 200s. **Any check whose subject is the network
must not be run through this machine's resolver.** The same artefact had been
making local HTTPS failures look like site outages.

*(Also closed this sweep, mechanically: `RecomputeInitcodeHash` re-measured
against the new factory — `HOOK_CREATION_CODEHASH`
`0xece3b0c259085201dda4d6a2ab94ed469a1d806b498a4d8c411b74ecd0b549f4`, changed
because the hook's creation code changed, which is what a working redeploy looks
like — `.env.production` refilled, `VerifyDeployment.s.sol` green against the new
pair, and the deployed frontend confirmed to contain the new addresses and **no
occurrence** of the old factory in any chunk. `9b9d9ce` is tagged
`deploy-4663-2026-09-12`, because GitHub's rebase merge replayed it onto `main` as
`d18d2d5` and nothing else kept the object that `run-latest.json` and `SECURITY.md`
both name reachable.)*

*2026-09-12 — §5.35 records the thirty-first sweep, which followed the redeploy
forced by the immutable referral split. The finding is that the public incident
status page, being in another repository, kept reading `paused()` off the retired
factory for four days and would have reported operational while the live factory
was paused; no guard in this repo can see that page, and `checkStatusPage.mjs`
checks reachability rather than identity. Recorded alongside it: a redeploy
reopens every per-address control, so PM-C2 needed re-doing and every user's PoG
attestation silently reset; three verification methods that produce confident
wrong answers — Blockscout's `sourcify` form method reports Sourcify's status and
not Blockscout's, a rate-limited submission is indistinguishable from a rejected
one at `1` per ~18 minutes, and custom-error selectors do not reliably survive
`viaIR` so bytecode selector searches are not tests; and the discovery that this
machine's proxy answers every DNS query from `198.18.0.0/15`, which had already
produced one confidently wrong report about the domain. Checks whose subject is
the network must not run through this resolver.*

### 5.36 Thirty-second sweep — the monitor was watching the contracts we left, and correcting it would have paged a drain

§5.35 found the public status page reading `paused()` off the retired factory and
called that a class of bug. It was. This sweep found the same class one layer
down, on the thing whose whole job is to notice: **the on-chain watcher had been
pointed at the retired pair for four days.**

`MONITOR_FACTORY` and `MONITOR_TREASURY` are GitHub Actions variables. Both were
set 2026-09-08 and neither was touched by the 2026-09-12 redeploy:

```
MONITOR_FACTORY   0xBa9d2E86281b988225Eca383C375215912fb20B9   retired
MONITOR_TREASURY  0x99aD248dD15498957B864Fd79917F0E103Aa78F7   retired
```

Every pass in those four days went green, and greenness was the problem. A
retired factory is not an unreachable endpoint that trips `WATCHER-02`; it is a
real contract that answers `owner()` with the Safe and `paused()` with `false`
and emits nothing at all, because nothing uses it. Governance alerts had nothing
to match, the state checks read exactly what they expected, and the monitor
looked healthy in the one way a monitor watching nothing always looks healthy.
Had the live factory been paused by an attacker in that window, the pass would
have reported the retired one as operational — which is §5.35's finding verbatim,
relocated from the status page to the detector.

`WATCHER-03` had already fixed precisely this shape for one field. It asks "was
this checkpoint written on the chain I am now watching?" and discards it if not,
and its comment explains that a stored fact is meaningless without the subject it
was measured against. That lesson was applied to `chainId` and to nothing else in
the same file. **`WATCHER-06`** now asks the same question about the factory and
treasury, and discards the checkpoint, the harvested hooks and the balance
baseline when the answer changes. Verified by switching the variables back and
forth and watching it fire on each change and stay quiet otherwise.

**The second finding is what correcting the first would have done.** The stored
treasury balance did not record which treasury it came from, so the moment the
variable was fixed, `STATE-02` compared the retired treasury's recorded holdings
against the live one's:

```
STATE-02 [P0] ladderTreasury balance fell from 0.021017 to 0.000000 ETH
              with NO buyback event in this window
```

A P0 drain alarm — the loudest finding in the catalogue, the one whose playbook is
`INCIDENT_RESPONSE.md` §2 — produced by editing a variable. This was not
hypothetical: it was measured against the real state file before the fix landed.
The check's own comment named both possible causes, "either a withdrawal path
exists or we are watching the wrong contract", and the code had no way to tell
them apart, because the only evidence that would distinguish them was the one
thing the baseline did not carry. It carries it now: `treasuryBalanceOf` is
written beside every reading, and a baseline belonging to a different address is
re-baselined with a printed gap rather than compared. `WATCHER-06` alone would not
have been enough — it cannot see a pair change that predates its own field, which
is exactly the state the CI checkpoint was in on the day the variables were
corrected.

So three findings across two sweeps share one shape: **a stored fact without its
subject.** A `paused()` reading without which factory it came from. A checkpoint
without which factory harvested its hooks. A balance without which treasury held
it. `chainId` was given its subject months ago and the pattern was not carried
across, which is worth more than the three fixes: the question "what would make
this reading meaningless, and is that recorded next to it?" is the one that finds
these before a redeploy does.

**Third finding, and the one nothing here can fix.** The schedule under the
watcher was re-measured because §7.3 of `ONCHAIN_MONITORING.md` left a hypothesis
open — that shortening the cron "buys more chances". Across 193.5 h of the
15-minute cron GitHub delivered 52 of an expected 774 passes, which is 7%, and
**0.269 passes an hour against 0.27 an hour under the hourly cron.** Four times
the requests, the same ~6.5 passes a day. The interval is an inert knob and the
hypothesis is answered. What that leaves is the honest detection latency of this
host: a median near 3.3 h, a worst observed gap of 7.2 h, and no gap in the whole
window shorter than 2.1 h. `WATCHER-05` cannot improve it and does not claim to —
it prints the gap on every pass and pages past 8 h, above the widest gap observed,
so that a schedule which has *stopped* is distinguishable from one that is merely
as bad as usual. Before it, `state.lastRun` was written by every pass and read by
nothing, so the only failure mode this host has was invisible from inside it.

**Two more of the same species, found by asking the question the first three
produced.** If a stale `MONITOR_*` variable was invisible, what about an absent
one, and what about the chain nobody compared?

`alerts.json` has carried `"chainId": 4663` since it was written and nothing read
it. The only chain test was `WATCHER-03`, which compares the endpoint against the
*checkpoint* — so it needs a previous pass on the right chain and says nothing on a
cold start, and cold starts are routine here because `WATCHER-03` and `WATCHER-06`
both discard the checkpoint by design. Reaching the wrong chain needs nothing more
than forgetting one variable: `MONITOR_RPC` unset falls back to the **testnet**
endpoint. A pass against 46630 holding mainnet addresses is quiet rather than loud
— address-scoped log filters return empty, `owner()` and `paused()` on codeless
addresses fail as non-paging "check failed" P1s, and empty-but-successful queries
do not trip `WATCHER-04`. `WATCHER-07` now compares the endpoint against the chain
the catalogue declares. It records rather than exiting 2, because the workflow
skips `report.mjs` on exit 2, so the loudest possible misconfiguration would have
reached a red Actions run and no pager — and at ~6.5 passes a day nobody is
watching the Actions tab.

The second: `MONITOR_EXPECTED_OWNER` or `MONITOR_EXPECTED_POG_SIGNER` unset made
`STATE-03` and `STATE-04` print a `gap()` and pass. A gap appears in the summary of
a run that is otherwise green, and this workflow's own comment says nobody opens
one of those. So deleting one variable silently turned off the check on the worst
thing that can happen to this protocol — ownership moving off the Safe — and on the
one that mints forged attestations, the PoG signer being rotated. Both now page,
and both name the value the chain currently answers so the fix is in the alert. A
stale expectation still compares against something; an absent one compares against
nothing, which makes absence the wider blast radius of the two.

**Fourth finding, small and the same species as the first three.** Every
checkpoint the watcher pushes goes to a one-file orphan branch, and Vercel was
building a Preview of it: an application-less branch, so every build failed —
about 6.5 failed deployments a day since 2026-09-04. The cost is not build
minutes. It is that a permanent stream of *expected* deployment failures is the
mechanism by which a real one stops being noticed, which is §6's noise-budget
argument arriving by a different road. `git.deploymentEnabled: false` has to be
present on the branch being pushed to be consulted rather than in the repository
being deployed (`vercel/vercel#11176` documents exactly this on an orphan
`gh-pages` branch), so the persist step writes it alongside the state file, at
both the repository root and under `soat-frontend/` because that is the project's
configured Root Directory and reports differ on which path a pre-build check
reads. Verified by pushing it and observing that the push produced no deployment
at all, where the previous checkpoint had produced a failed one.

*2026-09-13 — §5.36 records the thirty-second sweep. Its finding is that the
on-chain watcher spent four days pointed at the retired factory and treasury via
two GitHub Actions variables the redeploy did not update, going green throughout
because a retired contract answers reads and emits nothing. Fixed, and closed as
a class by `WATCHER-06`. Recorded alongside it: correcting the variable would
itself have paged a false P0 `STATE-02` drain, measured at 0.021017 → 0.000000
ETH, because the stored balance did not record which treasury it was read from —
now fixed at the root by `treasuryBalanceOf`; and the re-measurement that
disproves §7.3's open hypothesis, 0.269 passes/hour under a 15-minute cron
against 0.27 under an hourly one, making the cadence knob inert and the real
detection latency a 3.3 h median with a 7.2 h worst case, which `WATCHER-05` now
states on every pass rather than leaving to be inferred.*

### 5.37 Thirty-third sweep — the signing key was never compared to the signer, and the check that would prove it sat behind the check that refused the probe

The finding is one line of absence. `loadOracleAccount()` in
`sign-allocation/route.ts` read `POG_SIGNER_PRIVATE_KEY`, confirmed that viem
would **parse** it, and signed. Nothing compared the address it derives to
`factory.pogSigner()`, which is the only address `registerPoG` will accept.

A key that parses but belongs to somewhere else is therefore not a failure the
server can have. It is a failure the **users** have: the attestation is
well-formed, the route answers 200, the client submits it, and
`ToshFactory.sol:603` reverts on the recovered signer. Every depositor pays gas
to discover a deployment fault, under an error that names the signature rather
than the configuration, and no server-side signal is produced at all. Of the
things that can go wrong in this repository, "returns success while charging
every user to fail" is close to the worst shape, because it is indistinguishable
from the users being at fault.

Put next to the other five fields of the digest, the omission is stark. `nonce`
is read live from chain, and `onchainNonce.ts`'s own header explains why in these
exact terms — a stale one means "the user pays gas to revert". `contract_` is
pinned to `FACTORY_ADDRESS`. `chainId` is checked against the allow-list.
`sender` and `maxAlloc` come from an authenticated scan. Signer identity was the
one input still taken on the word of an environment variable — and the one that
cannot be audited from outside the runtime, because the production key is
write-only in Vercel, so no guard script and no CI job can ever see the value in
use. A check on it can only run where the key is.

**Not the first attempt at it, and the reason the first was not enough.** The
same comparison was added client-side on 2026-09-10 (`PRE_MAINNET_CHECKLIST.md`,
PM-D1 walkthrough): `PogScanButton` reads `pogSigner()` and refuses to send when
it disagrees with the `issuer` the route returns. That note is honest about its
two limits — it is diagnosis and not enforcement, since any client can ignore it,
and it deliberately falls **open** when `issuer` is absent or the read fails, so
as never to block a user the chain would accept. Both limits are right for a
client. Neither is acceptable as the only copy of the check, which is what it was
for three days. The server copy fails closed and cannot be reached around.

**The part worth recording is where it goes.** The check runs before
`readScannedGas`, and that placement retires a manual step rather than adding a
gate. Two paragraphs of the PM-D1 walkthrough are built on the premise that
identity could be proven only by a real attestation, hence only by a wallet with
genuine cross-chain gas history, hence only by a human — and that premise was an
artefact of the comparison living *after* the eligibility floor. Ahead of it, the
status code carries the answer: an ephemeral in-memory key with no history, no
funds and no launch gets **409 "no completed gas scan"** if the key is right and
**500** if it is not, because a mismatch is refused a stage earlier. The probe
that §PM-D1 says "cannot show identity" now shows it, unchanged. A check moved
in front of a refusal is worth more than the same check behind it.

**Second finding, the same question asked of the second item on that list.** The
other key said to need the operator was `PRIVATE_KEY`, the mainnet deployer,
sitting in plaintext in the repository-root `.env.production` as the single
remaining `check:secrets` finding — "delete it and rotate, not delete only".
Asking what made *that* unactionable produced this: `preflightMainnet.mjs:171`
was `new ethers.Wallet(process.env.PRIVATE_KEY).address`.

A pre-broadcast script whose entire job is to read state and refuse was loading
the mainnet deploy key into process memory to compute a **public** value. The
momentary exposure is the smaller half. The larger half is that this was the only
remaining reason the key had to stay in the file after the deploy it was needed
for: delete the line and the preflight stops running, so the finding could be
read but not acted on. `check:secrets` has inventoried the name at tier `absent`
and reported it on every run, and the thing making its instruction impossible to
follow was another guard in the same repository.

`DEPLOYER_ADDRESS` now answers for the deployer, `PRIVATE_KEY` is consulted only
if it is absent, and when both are present they are compared rather than one
winning silently — `forge script --private-key` broadcasts from the key while the
checks would read the address, and check 6 prints a fund-this-address
instruction, which is the money-instruction hazard check 0b already exists for.
Verified on all three paths: address alone runs the full preflight with no key
present anywhere, the two disagreeing refuses and names both, neither refuses and
names both options.

Two things the sweep corrected while there. `C1_RUNBOOK.md` §7 claimed the
plaintext `PRIVATE_KEY` copies were "both cleared", which was true when written
and false now: the 2026-09-12 redeploy needed the key and it was refilled, the
deployer's nonce having walked from 11 at C1 to 18. That is not a violation — the
broadcast does need it — it is a broadcast with no cleanup, and the cleanup is
what was impossible. And the residual authority was measured rather than assumed:
factory and ladder-treasury `owner()` are both the Safe
`0x2953957774482efA660921df85A1E7634ccfe27A`, both `pendingOwner()` are zero, so
what the key still commands is its own balance and nothing else.

*2026-09-13 — §5.37 records the thirty-third sweep, which came out of asking what
the top item on a "needs the operator, carries real risk" list was actually
waiting for. Its finding is that `sign-allocation` validated that the PoG signing
key parses and never that it is the key the factory accepts, so a wrong-but-valid
key would answer 200 and revert every depositor's registration with nothing
recorded server-side. Fixed by reading `factory.pogSigner()` alongside the nonce
already read — parallel, so it costs no round trip — and refusing with a Sentry
report on disagreement. Recorded alongside it: the client-side guard added
2026-09-10 was diagnosis that fails open, not enforcement; and because the new
check sits ahead of the eligibility floor, the ephemeral-wallet probe that could
not prove identity now proves it, which closed the last manual step of PM-D1
without the funded wallet it had been waiting on. Its second finding is that the
only remaining `check:secrets` failure — a plaintext mainnet deploy key — was
unactionable because `preflightMainnet.mjs` derived the deployer address from that
key, so deleting it broke a guard; the preflight now reads `DEPLOYER_ADDRESS`, and
the two findings share a shape, which is that a value nobody could check and a
secret nobody could delete were both being held in place by the convenience of a
script rather than by a requirement.*
