# Tosh Protocol — pre-mainnet checklist

**Version:** v5.0
**Status:** the canonical list. If this file disagrees with anyone's memory, or
with a `console2.log` in a deploy script, this file wins.
**Last updated:** 2026-09-08

---

## 0. Why this file exists, and what it is not

Until now this checklist existed only as scattered inline comments
(`// Pre-mainnet item #24`), six `console2.log` lines at the end of
`script/DeployMainnet.s.sol`, and a chat log. That is a bad place for the list
of things that must be true before immutable contracts take custody of user
funds: a comment citing `#26` was unresolvable, because nothing anywhere
defined what `#26` was.

### 0.1 Provenance, stated plainly

**The original numbered list is not recoverable.** Only five of its numbers are
attested anywhere in the repository:

| Legacy number | Attested at | Meaning |
|---|---|---|
| `#6` | `soat-frontend/src/app/lib/apiGuard.ts:4` | API route hardening primitives (CORS, rate limit, body cap) |
| `#10` | *(no code reference; cited in an earlier review)* | User-facing testnet strings in the UI |
| `#23` | `script/DeployMainnet.s.sol:18`, `script/RecomputeInitcodeHash.s.sol:12` | Regenerate hook initcode hash against the mainnet build |
| `#24` | `soat-frontend/src/app/providers.tsx:22`, `docs/INCIDENT_RESPONSE.md:473` | Multi-RPC fallback instead of one hard-coded endpoint |
| `#26` | `soat-frontend/src/lib/observability.ts:4`, `instrumentation*.ts`, `next.config.ts:13` | Error monitoring wired to a real backend |

Numbers `#1`–`#5`, `#7`–`#9`, `#11`–`#22` and `#25` are cited by nothing. They
are therefore **not reconstructed here** — inventing twenty-one definitions
would produce a document that reads as authoritative and is fiction.

Instead every item below carries a **thematic ID** (`PM-A1`, `PM-D2`, …) that is
stable from now on, and §7 maps the five legacy numbers onto them so the
existing code comments resolve. New work gets a new thematic ID, never a
recycled legacy number.

### 0.2 What "done" means

An item is checked only when the *evidence* named in its row exists — a passing
CI job, a transaction hash, a filled-in table. "Someone remembers doing it" is
not evidence.

---

## 1. Gate A — Security review (no longer blocks anything)

**This gate blocked everything else, and as of 2026-09-06 it blocks nothing.**
The ordering rule read: nothing in §2 onward should be started while §1 is open,
because a remediation round can change deployed bytecode, which invalidates
every address, initcode hash and verification artifact downstream. With A1–A3
retired (`SECURITY_AUDIT.md` §0) there is no remediation round to wait for, and
PM-C1 — the mainnet deploy — ran on 2026-09-08. The freeze on `src/` is now
live: the deployed factory bakes `HOOK_CREATION_CODEHASH` into its constructor.

The *reason* behind the rule survives its trigger, so it is restated rather than
deleted: **`src/` must stop changing before C1, not before an audit.** Internal
sweeps also change bytecode — §5.15 bounded two setters and §5.11's re-disposal
edited a `ToshFactory` comment, either of which moves an artifact if it lands
after a deploy. The gate to watch is now the last `src/` commit, and nothing in
this document enforces that automatically.

| ID | Item | Evidence of done | Status |
|---|---|---|---|
| **PM-A1** | Third-party audit engaged, scope frozen, commit hash recorded | Retired — see `SECURITY_AUDIT.md` §0 | ⬜ **Retired 2026-09-06 by decision, not satisfied.** This protocol ships without a third-party audit, permanently. The row is kept rather than deleted so the decision stays legible: a checklist that deletes what it abandons reads as complete for the wrong reason. What the decision costs is quantified in `SECURITY_AUDIT.md` §0.1, and the work that lost its owner along with the engagement is listed in §0.4 |
| **PM-A2** | All Critical / High findings resolved | Retired — no external findings will exist | ⬜ Retired with A1. Applied to an auditor's findings; there will be none. Findings this team makes are still triaged on the §6 severity ladder and Critical / High still block a deploy, but as an internal commitment nobody outside checks — `SECURITY_AUDIT.md` §0.3 |
| **PM-A3** | Remediation re-review passed | Retired — no re-reviewer | ⬜ Retired with A1. §7 of that doc is retired for the same reason: two of its three columns had no source once the engagement was cancelled, and the third is already recorded per finding in §5 |
| **PM-A4** | Hygiene list complete | `SECURITY_AUDIT.md` §5 boxes | ✅ 10 of 10 that still apply, 2026-09-06. It stood at 10/11 for two days, and the single unticked box was "audit branch frozen, commit hash written into §0" — which A1's retirement voids rather than completes. The box is struck through in place rather than ticked or deleted. Earlier the `forge lint` box closed by doing the work instead of buying it: §2.5 now disposes of all 19 narrowing casts by what bounds each one, gated by `scripts/checkLintFindings.mjs`, and doing it here found that §2.5 had drifted — a row for a cast the tool no longer reports, and a missing site — while its total still reconciled |
| **PM-A5** | Slither run and output triaged into the dossier | **`SECURITY_AUDIT.md` §5.7**, not §6 — see note | ✅ 71 findings (1H/24M/27L/19I) across 66 contracts, each dispositioned, and gated in CI by `scripts/checkSlitherFindings.mjs` since 2026-09-04. That re-run is why the numbers moved: the dark tax had added three untriaged `reentrancy-events`, and the table had never summed to its own total because `low-level-calls` had no row. A triage is only true as of a commit, so it is now re-checked on every push |

> **Gate A is closed, and three of its five rows closed by being abandoned.**
> `SECURITY_AUDIT.md` §0 remains the authority for A1–A3; it no longer holds an
> engagement board to go green, it holds the decision not to have one. Read §0.1
> before treating this gate as done in the ordinary sense — the rows are
> resolved, the risk they existed to retire is not.
>
> **PM-A5's evidence column used to point at §6, and §6 is the wrong place.**
> That section was reserved for an auditor's own findings, under their own IDs,
> and now keeps only the severity ladder. Static analysis lives in §5.7 with the
> rest of the hygiene list,
> and has done since it was run — the row said `❌` while the work sat one
> section away, which cost one duplicate triage before anyone checked the
> document instead of the checkbox.

---

## 2. Gate B — Chain and address decisions

These are decisions, not tasks, and they gate the deploy.

| ID | Item | Evidence of done | Status |
|---|---|---|---|
| **PM-B1** | **Decide the production chain.** | One answer, reflected consistently everywhere below | ✅ **Robinhood Chain, chain id 4663** — supersedes the Ethereum L1 answer, see §2.1 |
| **PM-B2** | `POOL_MANAGER` switched to the chosen chain's Uniswap V4 deployment | `soat-frontend/src/lib/contracts.ts` updated, reviewed as a source change | ✅ `0x8366a39CC670B4001A1121B8F6A443A643e40951` |
| **PM-B3** | `foundry.toml` has an `rpc_endpoints` + `etherscan` entry for the chosen chain | `forge verify-contract` succeeds against it | ✅ `robinhood` / `robinhood_testnet`, Blockscout verifier |
| **PM-B4** | `POSITION_MANAGER`, `STATE_VIEW`, `PERMIT2` overrides set for the chosen chain | `.env.production` populated | ✅ fallbacks in `contracts.ts` and `.env.production.example` both on 4663 |

### 2.1 The decision, and what it costs

**Robinhood Chain (chain id 4663), an Arbitrum Orbit L2.** This supersedes the
Ethereum L1 answer this section carried until the migration; the reasoning for
that one is kept below, because most of it is still the reasoning for this one.

> **Superseded — Ethereum L1 (chain id 1).** Chosen to resolve a contradiction
> the repository was carrying: `.env.production.example` already said
> `NEXT_PUBLIC_CHAIN_ID=1` and `chain.ts` already rendered "Settlement on
> Ethereum", while `foundry.toml` defined Base targets only. The decision matched
> what the UI was already promising.

The move to an Orbit chain is not a config change, and `docs/ROBINHOOD_MIGRATION.md`
is the record of what it actually took. The one item that reaches into the
contracts: `block.number` on an Orbit chain is the **L1** height, so the
flash-loan lockout stamped in `block.number` would have compared an L1 number
against an L2 one — a ~21 M gap, and a guard that never fires. `_blockNumber()`
in `ToshLaunchpadHook` reads `ArbSys(0x64).arbBlockNumber()` instead. §2.5 and
§5.3 of that file carry the detail.

**This section has been revised twice, and the history is the useful part.** It
originally said "`launch()` seeds a V4 pool in one transaction — roughly 3 M
gas", which was wrong in both the figure and the function. Measuring it found
5.56 M, concentrated in `createLaunch` rather than `launch`, because **every
project got its own full hook contract**: 20,775 bytes of initcode at 200 gas per
byte is 4.16 M in code deposit alone, plus 0.88 M for the `ToshToken`.

That note then closed by saying the only lever was "making hooks smaller or
sharing one hook across projects — an architecture change, not a config one, and
out of scope for v5.0". The architecture change was made. Per-project deployment
is now an **EIP-1167 minimal proxy carrying its config as immutable args**: 121
runtime bytes for the hook clone and 45 for the token, against one 20,775-byte
implementation the factory deploys once in its own constructor. Salt mining still
lands the clone on the `0x20CC` mask, since `HookMiner` is generic over the
initcode hash.

Measured by `test_gas_createLaunch` and `test_gas_launch` under `forge test
--isolate`. These replaced the earlier `--gas-report` figures (557,470 / 480,487),
which were medians over fuzz and invariant runs and so moved between runs of
identical code; each number below is one call in a fixed scenario:

| Call | Gas | Was | Who pays |
|---|---:|---:|---|
| `ToshFactory.createLaunch` | **534,011** | 5,016,031 | creator, at project creation |
| `ToshLaunchpadHook.launch` | **502,719** | 541,474 | creator, after genesis succeeds |
| **Total per project** | **≈ 1.04 M** | ≈ 5.56 M | creator |

At L1 prices that was on the order of **0.010 ETH per launch at 10 gwei and
0.031 ETH at 30 gwei**, down from 0.06 / 0.17. The launch fee was no longer
dwarfed by the gas it sat on top of, which removed most of the force from the
original concern — though stating the estimate in the UI before the creator
signs was still worth doing, and PM-F8 below did it.

**On 4663 the pricing argument stops mattering and a different one starts.**
Robinhood's L2 base fee reads **0.0352 gwei** (`cast gas-price`, August 2026),
about 280× under a 10 gwei L1, which puts the same 1.04 M gas at roughly
**0.00004 ETH**. The gas figures in the tables above are EVM gas and do not
change; what changed is that they are no longer the thing to worry about.

Two caveats, because "it's an L2, gas is free" is how people get surprised:

- **That number is the L2 side only.** ArbOS also charges for posting calldata
  to L1, as additional gas units rather than a separate line. A launch is
  calldata-light, so the L2 figure is the right order of magnitude, but it is a
  floor and not a quote.
- **The base fee is not a constant.** 0.0352 gwei is a reading taken on a quiet
  chain. Nothing in this protocol assumes a gas price, with one exception:
  `PIGGYBACK_MIN_GAS` and `PIGGYBACK_TAIL_RESERVE` in `ToshLaunchpadHook` are
  gas *unit* budgets tuned against Ethereum's accounting, and ArbOS does not
  account identically. Re-measuring those on a live 46630 deployment is
  **RH-B4**, and it is the one gas item the migration leaves open.

Per-transaction costs for the paths ordinary users touch, same run:

| Call | Gas | Note |
|---|---:|---|
| `deposit` (genesis) | 183,212 | |
| swap buy, warm pool | 167,314 | in line with a normal DEX swap |
| swap buy, end to end | 198,185 | |
| `mintBondingCurve`, one shelf | 173,550 | was 197,195 before `LadderState` packing |
| swap that carries a buyback | 362,884 | was 578,809 at three legs per poke |

The last row is the one worth watching: it is what a trader pays when their swap
happens to be the one that deploys the reservoir, and it is bounded by the gas
gate rather than by hope. See §2.3 of `docs/ONCHAIN_MONITORING.md` for the idle
side of that trade-off.

> **PM-F8 closed.** The launch page quotes both creator transactions before the
> creator signs, and the balance gate now requires fee **plus** gas rather than
> the fee alone — checking the fee by itself admitted a wallet that then could
> not pay for the transaction spending it.
>
> The quote reads `CREATE_LAUNCH_GAS` / `LAUNCH_GAS` from
> `soat-frontend/src/app/lib/launchGas.ts`, which mirrors what
> `test_gas_createLaunch` and `test_gas_launch` measure here. Those budgets
> therefore do double duty: past them the code has not merely got heavier, the
> number a creator was quoted is wrong.
>
> Both figures are `gasleft()` deltas and so exclude the 21,000 transaction
> base, which the frontend adds back. Quoting them raw is the easy way to
> under-state the bill by ~4 %.

### 2.2 The cutover values, now applied

Sourced from Robinhood's documentation and confirmed on Blockscout. Identical on
mainnet 4663 and testnet 46630 — same addresses, same code sizes:

| Constant | Robinhood Chain (4663 / 46630) | Size |
|---|---|---:|
| `POOL_MANAGER` | `0x8366a39CC670B4001A1121B8F6A443A643e40951` | 24,009 B |
| `POSITION_MANAGER` | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` | 23,877 B |
| `STATE_VIEW` | `0xF3334192D15450CdD385c8B70e03f9A6bD9E673b` | 3,531 B |
| `PERMIT2` | `0x000000000022D473030F116dDEE9F6B43aC78BA3` (canonical on every chain) | 9,152 B |
| `UNIVERSAL_ROUTER` | `0x8876789976dEcBfCbBbe364623C63652db8C0904` | 24,546 B |

The PoolManager is **byte-for-byte the same length as Ethereum's**, which is the
cheapest available evidence that Robinhood runs the v4-core build this repository
compiles against. The periphery is where the two chains diverge.

`UNIVERSAL_ROUTER` exists here because the fork suite needs it: it is the
contract real swap traffic goes through, so anything that quotes or routes a
trade needs it even though nothing in `contracts.ts` references it today. The
version trap that came with it on Ethereum has **inverted**, which is worse than
it having gone away. Robinhood's router is *newer* than this repository's
`lib/v4-periphery`, not older, so its `ExactInputSingleParams` has the six-field
shape and the library struct is now the correct one to encode with. See
`docs/ROBINHOOD_MIGRATION.md` §5.1, and note the finding there: the wrong
encoding does **not** revert on an ETH-paired pool, it succeeds and silently
drops `hookData`. `scripts/checkV4RouterTuple.mjs` is what holds that line.

All five are checked against the chain itself by
`test/ToshV5Fork.t.sol::test_fork_liveAddressesAreTheOnesWeShipTo`, which is
worth more than any document: documents go stale together.

> **Superseded.** This section used to carry the Ethereum mainnet table
> (`POOL_MANAGER` `0x000000000004444c5dc75cB358380D2e3dE08A90`, PositionManager
> `0xbd21…ee9e`, StateView `0x7ffe…7227`, UniversalRouter `0x66a9…a8Af`) and
> explained at length why the values were recorded but **not** applied: changing
> `POOL_MANAGER` changes the hook implementation's creation code, and so its
> address, and so every salt mined against the resulting clone initcode —
> so it would take the then-live Base Sepolia staging deployment down the moment
> it landed. That coupling is unchanged and still the reason PM-B2 is a source
> change rather than a config one — it is just no longer a reason to wait, since
> the migration retired the Base Sepolia deployment it was protecting.

**Until recently, setting three of these would have done nothing.**
`POSITION_MANAGER`, `STATE_VIEW` and `PERMIT2` were read through
`envAddress('NEXT_PUBLIC_…', fallback)`, i.e. `process.env[name]` — a computed
access, which Next.js never inlines, so all three silently resolved to their
Base Sepolia fallbacks in every browser build. An operator working this table
correctly would have shipped a mainnet bundle whose LP panel still called a
Sepolia PositionManager, and nothing in the build, the types, the lint or a
local `next dev` check would have said so.

Fixed, and held by `soat-frontend/scripts/checkPublicEnv.mjs` in CI, which
fails on any computed env access and on any `NEXT_PUBLIC_*` key this template
documents that no source file statically reads. Treat that guard as the
evidence for this row: a variable being present in `.env.production` is not
evidence that the build uses it.

---

## 3. Gate C — Deploy and handoff

Ordered. Each step's output feeds the next.

> **On the day, follow `C1_RUNBOOK.md`, not this section.** This one argues what
> and why; the runbook is the order of operations with a verification after each
> step, and it carries the two corrections that came out of dry-running it on
> 2026-09-06 — the preflight's `Fund 0x73db078f…` line (`SECURITY_AUDIT.md`
> §5.20) and the missing `set -a` in the documented deploy command.

| ID | Item | Evidence of done | Status |
|---|---|---|---|
| **PM-C1** | `DeployMainnet.s.sol` run against the production RPC | `broadcast/DeployMainnet.s.sol/4663/run-latest.json`; factory `0xBa9d2E86281b988225Eca383C375215912fb20B9`, treasury `0x99aD248dD15498957B864Fd79917F0E103Aa78F7`; blocks 57400516–57400521 | ✅ **2026-09-08, chain 4663.** Five transactions, all `status=0x1`. 9,353,658 gas, 0.0026585890501 ETH. Mutually wired. Ownership was staged in this broadcast (`owner()` the deployer, `pendingOwner()` the Safe) and has since been accepted — see PM-C2. The 46630 rehearsal (RH-F1) remains the behavioural proof — launch, claim, buy, shelf mint, TWAP-matured `addLadderToken`. See the note below and `C1_RUNBOOK.md` §0 |
| **PM-C2** | Gnosis Safe has called `acceptOwnership()` on **both** factory and ladder treasury | `VerifyDeployment.s.sol` passes with `EXPECTED_OWNER=<safe>`; on-chain tx `0x002ad51544aa6b7377d689bf30f4822e45278a882887bf1fa6f363a95ed4b3eb` | ✅ **2026-09-08, chain 4663, block 57455937.** Single batched Safe transaction via MultiSendCallOnly v1.4.1 at `0x9641d764fc13c8B624c04430C7356C1C7C8102e2`, operation = 1 (DELEGATECALL), Safe nonce 0. `safeTxHash` `0x13602041beeb67d02fb828c79502839a0f2a65a663c43d1d0646bd4c8ec17ea1`. Status success, gasUsed 106151, submitted by signer `0xC2EA14cE2112B18AFBC78fE78C969b3002F07cbB`. Result: `ToshFactory` `0xBa9d2E86281b988225Eca383C375215912fb20B9` and `ToshLadderTreasury` `0x99aD248dD15498957B864Fd79917F0E103Aa78F7` both now have `owner()` = Safe `0x2953957774482efA660921df85A1E7634ccfe27A` and `pendingOwner()` = zero. Safe nonce is now 1. `VerifyDeployment.s.sol` passed with `EXPECTED_OWNER`, `EXPECTED_POG_SIGNER` and `EXPECTED_PLATFORM_TREASURY` all set. The single-key window is closed. Mechanism was rehearsed on 46630, 2026-09-04 (`INCIDENT_RESPONSE.md` §8.2). See `SECURITY_AUDIT.md` §5.26; the UI-path inference in that sweep is corrected in §5.29 |
| **PM-C3** | **Factory address not announced publicly until PM-C2 is done** | — | ❌ **no longer gated — open on its own terms.** C2 closed, and the PoG signer was rotated 2026-09-09 to `0x9A1a8C7b…`, so the precondition that made announcing dangerous is satisfied (`SECURITY_AUDIT.md` §5.32). Both reasons this row existed are now gone: the deployer no longer owns the factory, and publishing the address no longer converts a leaked signing key into exploitable quota. **It has still not been announced**, which is the only thing keeping it open |
| **PM-C4** | Contracts verified on the block explorer | Public verified source at the deployed address | ❌ the 4663 addresses exist; Blockscout verification of *this* deploy is not confirmed. Testnet 46630 is already verified. `--verify` was in the broadcast command; confirm the source is actually public at `0xBa9d2E86…` and `0x99aD248d…` |
| **PM-C5** | `forge build --sizes` — every contract under the 24 KB EIP-170 limit | Build output | ✅ see §3.1 |
| **PM-C6** *(legacy `#23`)* | Hook initcode hash regenerated against the **mainnet** build | `RecomputeInitcodeHash.s.sol` output committed; `extractAbis.js` produces no diff | ✅ **2026-09-08, chain 4663, block 57592077.** `RecomputeInitcodeHash.s.sol` run against factory `0xBa9d2E86281b988225Eca383C375215912fb20B9` with `--sig 'run(address)'`. `HOOK_CREATION_CODEHASH` `0xc43a20c91d0f3164cdeb07d8786c61184c105825a9edec30a8df949f41b4d139` matches `keccak256(type(ToshLaunchpadHook).creationCode)` of this tree; `getLiveHookInitcodeHash()` `0x3a706af1817f0f630ccde8389a67d0bffd6a4744f5e4e0dc6e914bb8bd0e91ef` (clone initcode; not comparable to the former). Output committed in `SECURITY_AUDIT.md` §5.30. `extractAbis.js` produced no diff. `.env.production` still holds the `0x` placeholders — that file is gitignored and is operator work, not this row's evidence. The launch page reads `factory.hookInitcodeHash(...)` from chain either way. See `SECURITY_AUDIT.md` §5.30 |
| **PM-C7** | `.env.production` filled: `NEXT_PUBLIC_FACTORY_ADDRESS`, `NEXT_PUBLIC_CHAIN_ID` — **and the status page's `CHAIN` block repointed** | Deployed frontend reads the right factory; `checkStatusPage.mjs` green | ✅ **both halves closed, and the frontend one only after a half-cutover shipped.** Status page: `jayoo101/tosh-status` names Robinhood mainnet 4663, factory `0xBa9d2E86…`, explorer `robinhoodchain.blockscout.com`. That half was added 2026-09-04 because C7 had never covered it — the page hardcodes its own chain in a different repository (`SECURITY_AUDIT.md` §5.27). Frontend: the first production deploy reported ready carried the mainnet factory and treasury with `NEXT_PUBLIC_CHAIN_ID` still `46630`, so the live site pointed a testnet connection at contracts that have no code on 46630 and rendered nothing. It was found by reading address literals out of a minified chunk by hand, which is why `checkDeployedChain.mjs` now exists. Verified 2026-09-09 against `https://tosh-two.vercel.app`: 19 chunks scanned, badge reads mainnet, chain id **4663**, both addresses resolve to the 4663 deployments, `coherent`. Re-check with `npm run check:deployed -- --url …`, never by eye |
| **PM-C8** | Ladder buyback targets curated (`treasury.addLadderToken`) — **no token listed until its TWAP has matured**, see §3.2 | On-chain state; `STATE-07` green | ❌ for mainnet, **no longer gated**. The PoG rotation that blocked this landed 2026-09-09 (`SECURITY_AUDIT.md` §5.32), so a listed token no longer hands value to a leaked key. No token has been listed on the 4663 treasury. Procedure rehearsed correctly on 46630 (`ROBINHOOD_MIGRATION.md` §F.8), which is also where §3.2's "poll, don't compute" caveat came from — the first testnet sitting had listed 52 s after launch |
| **PM-C9** | Deploy-side role addresses decided and distinct: `PROD_OWNER_SAFE`, `PLATFORM_TREASURY`, `POG_SIGNER_ADDRESS` | `verifyOwnerSafe.mjs` green; `DeployMainnet.s.sol`'s `requireDistinctRoles` passes | ✅ **all three filled and used in the 2026-09-08 broadcast.** The 2-of-3 Safe is both `PROD_OWNER_SAFE` and `PLATFORM_TREASURY`; `POG_SIGNER_ADDRESS` is `0x0E496Bd529646770192C7c35c65Ee1BB0e554E1b`, matching `factory.pogSigner()`. `requireDistinctRoles` passed — the broadcast reverts otherwise. **Added 2026-09-04, because `PLATFORM_TREASURY` had no checklist row at all.** C7 covers the *frontend* env; this row covered the *deploy* env, and one of its values can never be changed. `PLATFORM_TREASURY` takes 0.30 % of the ETH input of every buy on every pool, forever, and is immutable — baked into the factory *and* into the hook implementation's `platformFeeRecipient`, so rotating it means redeploying the factory and migrating every pool. The deploy script asserts only that it is non-zero and differs from the deployer and the PoG signer, so a personal EOA passes and is then permanent. **Decided:** the 2-of-3 owner Safe serves as both `PROD_OWNER_SAFE` and `PLATFORM_TREASURY`. Two properties of that choice which a comment had claimed and no test had checked are now asserted in `ToshV5.t.sol`: a recipient dearer than a `transfer()` stipend is still payable — a 1.4.1 Safe cost 29,944 gas to pay on 46630, and it works **only** because v4-core sends native value with `call(gas(), …)` — and a recipient that *reverts* does brick every buy on every pool. Note that `.env` today still points all three roles at the testnet deployer, which would fail all three assertions and is not what C1 used |

> **PM-C1 ran on 2026-09-08.** Chain 4663, blocks 57400516–57400521, five
> transactions all `status=0x1`, artefact `broadcast/DeployMainnet.s.sol/4663/run-latest.json`.
>
> | | Address | Runtime | Tx |
> |---|---|---:|---|
> | `ToshLadderTreasury` | `0x99aD248dD15498957B864Fd79917F0E103Aa78F7` | 6,035 | `0x1e521633…` CREATE, 1,388,888 gas |
> | `ToshFactory` | `0xBa9d2E86281b988225Eca383C375215912fb20B9` | 10,789 | `0x0eed646b…` CREATE, 7,820,344 gas |
> | `treasury.setFactory` | | | `0xbcec476c…` 47,309 gas |
> | `factory.transferOwnership` | | | `0x7d7a929b…` 48,924 gas |
> | `treasury.transferOwnership` | | | `0xe3b43d35…` 48,193 gas |
>
> Constructor arguments as recorded: treasury took `(PoolManager
> 0x8366a39C…, deployer)`; factory took `(PoolManager 0x8366a39C…,
> pogSigner 0x0E496Bd5…, Safe 0x29539577…, ladderTreasury 0x99aD248d…)`.
> The pair is mutually wired.
>
> **9,353,658 gas** totalling **0.0026585890501 ETH** (receipts: 0.28205 gwei
> on the treasury create, 0.28461 gwei on the other four). This note and
> `C1_RUNBOOK.md` carried **14,580,627 gas** re-summed from the 46630
> rehearsal — 56% high. The ~0.0117 ETH 2x funding guidance that came from
> it was therefore conservative in the right direction.
>
> The 2026-09-06 wording of this note is now historical: it said the mainnet
> deployer did not exist yet, and the wording before *that* named
> `0x73db078f…` (the testnet deployer §4.1 forbids reusing) and said to fund
> it. The wallet that actually broadcast is `0x4E41CEa950cF40FA59774B409988D6F9F399E690`,
> nonce 11. `preflightMainnet.mjs` was the pre-broadcast gate; C1 is done, so
> a green preflight is no longer this row's evidence.
>
> A second, earlier deployment exists on chain and has no artefact in this
> repository. See `SECURITY_AUDIT.md` §5.25. Its factory was paused the same
> day; see §5.26.

> **PM-C2 closed on 2026-09-08.** The Safe accepted ownership of both
> contracts in one batched transaction (`0x002ad51544aa6b7377d689bf30f4822e45278a882887bf1fa6f363a95ed4b3eb`).
> `owner()` is the Safe, `pendingOwner()` is zero, on both. The deployer EOA
> no longer controls either canonical contract. See `SECURITY_AUDIT.md` §5.26;
> the UI-path inference in that sweep is corrected in §5.29.
>
> **PM-C6 closed on 2026-09-08.** `RecomputeInitcodeHash.s.sol` was run
> against the live factory; both hashes match the independent `cast`
> reads, the local creation-code fingerprint asserts against on-chain
> `HOOK_CREATION_CODEHASH`, and `extractAbis.js` produced no diff. Output
> is in `SECURITY_AUDIT.md` §5.30. The silent-failure property of a
> stale published number remains true for future drift — the launch page
> still does not need the copy — which is why the comparison now lives
> in the script rather than in a human's hands. CI's no-diff check
> (`.github/workflows/test.yml`) still catches ABI drift and still
> cannot catch "never regenerated against a new deploy"; that is now
> an on-demand script, not a CI gate, because the 4663 RPC is the one
> §5.28 rate-limited the watcher on.

### 3.1 PM-C5 — measured sizes

`forge build --sizes`, default profile (`via_ir = true`, `optimizer_runs = 200`).
There is no separate mainnet compile profile in `foundry.toml`, so this *is* the
production build and the earlier "unverified for the mainnet profile" caveat was
describing a profile that does not exist.

| Contract | Runtime (B) | Margin to EIP-170 (B) |
|---|---:|---:|
| `HookDeployLib` | 22,152 | 2,424 |
| `ToshLaunchpadHook` | 20,984 | 3,592 |
| `ToshFactory` | 10,789 | 13,787 |
| `ToshLadderTreasury` | 6,035 | 18,541 |
| `ToshToken` | 4,203 | 20,373 |
| `ToshCloneLib` | 57 | 24,519 |

All under the 24,576-byte limit. Re-measured 2026-09-06; `HookDeployLib` is
still the tightest, now at 2,424 bytes of headroom (was 3,198 when this table
was first written). `forge build --sizes` also prints a red
"some contracts exceed the runtime size limit" — that is v4-core /
OpenZeppelin in the same compilation, not these six. They are not what C1
broadcasts as standalone runtimes.

These sizes no longer drive per-project cost the way they did when this table was
written. Each project now deploys a 121-byte clone rather than a copy of the
20,372-byte hook, so the implementation's size is paid **once per platform
deployment** instead of once per launch (§2.1). It still matters for EIP-170
headroom, and `ToshFactory` shed ~4.5 KB by handing deployment to `ToshCloneLib`
— but "shrinking the hook pays twice" is no longer true.

### 3.2 PM-C8 — do not list a token until its TWAP has matured

**The rule:** before calling `treasury.addLadderToken(token)`, read
`twapSqrtPriceX96()` on that token's hook. If it returns **0**, do not list yet.
Zero means the pool is still inside the first `TWAP_WINDOW` (1800 s) after
`launch()`. Wait for it to go non-zero — it does so on the clock alone, with no
swap needed — and list then.

**Poll the getter; do not compute the deadline.** `launch_ts + 1800` is a lower
bound, not the answer. Measured on testnet 46630 the TWAP was still 0 **147 s
past** that point, because `_prevCheckpointTs` rolls onto a checkpoint already a
full window old and checkpoints are written by pool interactions — so the wait
runs from the last checkpoint before maturity, not from `launch()`. Arithmetic
here says "safe to list" while the floor is still unbounded, which is the exact
state the rule exists to prevent. `ROBINHOOD_MIGRATION.md` §F.8.

**Why it is a rule and not a `require`:** `_buybackSqrtFloor` anchors the
buyback's anti-sandwich bound to that TWAP, and treats 0 as "no reference yet,
fill unbounded". So a token listed inside the window has **no price bound on its
buyback legs**, on the pool whose liquidity is thinnest.
`test_probeG3_immatureTwapLeavesTheBuybackUnbounded` measures the cost: a pool
parked 1500 bps out gives up 0.93 ETH of a 3.33 ETH leg, where a matured TWAP
refuses the same deviation outright. `pokeBuyback` has no cooldown, so that
repeats per block, and the leg is `balance / 30`, so it scales with the
reservoir.

We chose to hold this off chain rather than change the contract, on the grounds
that `addLadderToken` is owner-only, so the state is unreachable without a
privileged action. That reasoning is only as good as this rule being followed —
which is why it is also a gate here, a warning in `addLadderToken`'s natspec,
and `STATE-07` in `monitoring/alerts.json`. The audit dossier records it as
accepted-with-residual-risk and explicitly invites the auditor to argue for the
code fix instead (`SECURITY_AUDIT.md` §2.3).

**If STATE-07 ever fires,** the recovery is `removeLadderToken(token)` via the
Safe, wait for maturity, re-add. Nothing is forfeited by removing: the reservoir
is not spent on an unlisted token.

---

## 4. Gate D — Keys and secrets

| ID | Item | Evidence of done | Status |
|---|---|---|---|
| **PM-D1** | PoG signer is a **new** key, distinct from the deployer, held only in the production secret store | Cutover: `factory.pogSigner()` ≠ deployer; `POG_SIGNER_PRIVATE_KEY` set in Vercel Production only; absent from every laptop `.env*`. See §4.1 | ✅ both halves closed 2026-09-09. On chain, `factory.pogSigner()` is `0x9A1a8C7b…`, distinct from the deployer and from all three Safe owners. Custody: `POG_SIGNER_PRIVATE_KEY` is sensitive and write-only in Vercel Production, absent from every local dotenv, and `POG_PRIVATE_KEY` — the second legal name for the same key — is unset and now inventoried `absent`. **Verified rather than asserted:** a forensic sweep of 220 shell-history, terminal-capture and transcript files derived every one of 105 distinct 64-hex candidates and found no copy of the new key, and the address has on-chain nonce **0**, so it has never been loaded into anything that sends a transaction — which is what nonce 2 on the old key had revealed (§5.32). This is the first key this project has generated that did not leak |
| **PM-D2** | ~~PoG signer wallet pre-funded (~0.05 ETH) for signature gas~~ | — | ⬜ **Not applicable, closed 2026-09-04.** There is no signature gas. `registerPoG` is `external` and keys off `msg.sender`, so the depositor pays; the signer's address appears in the contract only as the expected result of `hash.recover(signature)`. Both consumers of the key sign with no chain connection — `privateKeyToAccount().signMessage()` in the API route, and an `ethers.Wallet(pk)` with **no provider** in `scripts/pogSigner.ts`, which cannot broadcast at all. Funding it would add a liability without buying anything: the key lives in a Vercel env var, and one guarding a balance is worth more to steal. `ONCHAIN_MONITORING.md` §4.1 has the full correction and what became of STATE-05 |
| **PM-D3** | `SENTRY_AUTH_TOKEN`, Supabase service keys held only in the CI secret store | `npm run check:secrets` green (store, tier, **and** no secret-tier assignment in local dotenv); no secret in any committed `.env*` | ✅ Custody is now checked mechanically — see §4.2. All **five** credentials are in Vercel Production at the write-only tier (`BLOCKSCOUT_API_KEY` joined them 2026-09-05, verified on all five chains before it was stored, since a Sensitive value cannot be read back to notice it was stored wrong), nothing has ever been committed, and the open question "does any CI job need the Supabase service key" is answered **no**. The workflows reference **two** secrets, `ROBINHOOD_RPC` and `MONITOR_RPC` — this row said "exactly one" until 2026-09-05, having been written before PM-E2 added the watcher, which is precisely the drift §4.2 exists to catch. Adding the key surfaced two standing gaps rather than none: `MONITOR_RPC` had been a live GitHub secret since 2026-09-04 that no row classified, and the check could not see GitHub *variables* at all. The same drift fired a second time on 2026-09-08: PM-C7 added `NEXT_PUBLIC_RPC_URL` to Vercel Production, which no inventory row classified, and `check:secrets` failed with that single finding. Classified `config` — anything `NEXT_PUBLIC_` is inlined into the browser bundle, so it cannot hold a secret; today's value is the bare public Robinhood endpoint. The row's `why` now says what changes if that is swapped for a keyed provider URL. `SENTRY_AUTH_TOKEN` is fully closed — Vercel only, no laptop copy — and stays out of GitHub Actions on purpose, because a workflow run that is not a production deploy would cut a Sentry release for a commit that never shipped. The laptop copies that kept this amber are gone: Supabase service_role and the Upstash token were rotated in their consoles, Vercel Production updated, local `.env.local` deleted; the local PoG copy (the burned testnet key) cleaned up; deployer `PRIVATE_KEY` destroyed from `.env.production`. `npm run check:secrets` reports 27/27 green. See `SECURITY_AUDIT.md` §5.31. That is not a clean custody surface: the live mainnet PoG signing key reached PowerShell history in plaintext and was not rotated (`SECURITY_AUDIT.md` §5.32). That defect is PM-D1's, not this row's |
| **PM-D4** | Gnosis Safe threshold and signer set confirmed, signers reachable | `INCIDENT_RESPONSE.md` §1 filled | ✅ **the Safe exists: `0x2953957774482efA660921df85A1E7634ccfe27A`, 2-of-3 SafeL2 1.4.1 on 4663, created 2026-09-04** (tx `0x0ac80e07…`, 305,871 gas, ~0.0001 ETH; the transaction service reports `1.4.1+L2`). All three owners proved control of their address by signature before creation, so no owner slot is occupied by an address nobody can sign for. `verifyOwnerSafe.mjs` is green on every property: threshold, owner set, L2 indexing, fallback handler, role separation from the deployer and PoG signer, and that it accepts plain ETH — which matters because PM-C9 makes this same Safe the platform treasury. **Reachability, closed 2026-09-08:** §1 names Encrypted Signal / Telegram for Tom, Jack and Joe, with the handle looked up in the operator's offline 1Password / Vault, not in this repository. That is what the row asked for. It is not a 03:00 page-out; the vault entry existing and staying current is an operator obligation no guard here can see. §8.2 measured the mechanical path at 5 s against a 60-second budget, so the budget is still the human hop, and one unreachable signer still turns 2-of-3 into 2-of-2. **The tooling was verified before any of this, so the remaining half was only ever a people problem.** Robinhood Chain is a custom Orbit chain and nothing had ever checked that a Safe is possible on it, while D2's premise, C2 and E5 all rest on one existing. Checked 2026-09-04: Safe 1.3.0 **and** 1.4.1 singletons, proxy factories and MultiSend are all deployed at their canonical addresses on **both** 4663 and 46630, and both chains are in Safe's official supported list with live transaction services (`api.safe.global/tx-service/robinhood`, `…/robinhood-testnet`, service 6.10.1). Those facts are still true. What they do not establish — and what that sitting inferred from them — is that the UI offers an entry point for constructing an arbitrary call. Rechecked 2026-09-08 (`SECURITY_AUDIT.md` §5.29): chain 4663's Apps registry carries two apps and no Transaction Builder; the paste-the-ABI flow is reachable only by a direct appUrl. `INCIDENT_RESPONSE.md` §1.1 and §2 Step 1 now say so. **Then rehearsed rather than inferred:** a throwaway 1-of-1 Safe was deployed on 46630 (`0x3e3A1223…`, SafeL2 1.4.1, 270,604 gas), confirmed indexed by the service as `1.4.1+L2`, and used to `execTransaction` a real contract call into the factory — `isSuccessful=true`, nonce 0→1. `INCIDENT_RESPONSE.md` §1.1 has the hashes. That rehearsal drove `execTransaction` from a script, not through the UI's app surface — the same untested link §5.29 records. That Safe is disposable and must never own anything: 1-of-1 is what D2 trigger ① forbids. **Then the real path, §8.2, same day:** that first run chose a *view* function, so it proved a Safe can make a call and nothing about the call Step 1 actually makes. A **2-of-3** Safe (`0x83f877BE…`, 318,831 gas) took ownership of the testnet factory and executed `pause()` and `unpause()` through it — so the `onlyOwner` path, PM-C2's `acceptOwnership`, and the two-signature bar are all now measured rather than assumed. The number that matters for recruiting: the mechanical path is **5 s**, so the 60-second bar in Step 1 is almost entirely the time to reach a second human, which makes the requirement *reachability*, not skill. `docs/SIGNER_BRIEF.md` exists to be handed to a candidate, since "help me run a multisig" is not a question anyone can answer and the vagueness was itself part of the blocker. **Two candidates found 2026-09-04**; the three scripted steps ran the same day: `verifySignerCandidates.mjs` (each candidate signs a message; the recovered address must match the one they sent — an owner nobody can sign for is indistinguishable from a working one until the first P0), `createOwnerSafe.mjs` (2-of-3 SafeL2 on 4663, refusing to run on any other chain, refusing the deployer EOA as an owner, and re-verifying the signatures at the write rather than trusting the earlier step), and `verifyOwnerSafe.mjs`. **This gated C1, not just C2:** `DeployMainnet.s.sol` reads `PROD_OWNER_SAFE` with no default and calls `transferOwnership` to it in the same broadcast, so the Safe is an input to the mainnet deploy.

> **PM-D1 is the highest-severity open item that is not the audit.** The
> on-chain half is done and the custody half is now a known violation, not
> an unverified remainder. The live PoG signing key reached PowerShell
> history in plaintext (`SECURITY_AUDIT.md` §5.32). The operator accepted
> the deviation rather than rotating. The key cannot move funds, but it
> mints deposit quota: whoever holds it can sign themselves the maximum
> allocation on unlimited wallets. The bound on the
> damage is `maxPogAllocationLimit` and the per-hook `perWalletCap`, not the
> signature itself — see `INCIDENT_RESPONSE.md` §4 for the cap table and the
> rotation playbook. Quota currently buys nothing (zero launches). It
> becomes real value the moment PM-C3 announces the factory or PM-C8 lists
> a token; rotation is a blocking precondition for both.

### 4.1 Every wallet is new on mainnet — and KMS is not required

**Decided 2026-09-04.** Two decisions, because they look like one and are not.

**Storage.** The production PoG key lives in Vercel Production as an encrypted
environment variable. It does not live in KMS, and `sign-allocation/route.ts`
keeps reading `POG_SIGNER_PRIVATE_KEY`. KMS would keep the material out of the
process and log every signature; for a single-operator launch those are not
the failure we have. The failure we have is a key that has sat in plaintext
on a laptop, in a second `.env`, and in this working tree, and that currently
is also the deployer. Vercel encrypted env plus the rotation below is the
control; a KMS client is not. Revisit when more than one person can pull
Production secrets, or when an auditor requires the key never enter the
process.

**Rotation.** Every private key and every wallet that has been used on
testnet, in this repository, or in a chat, is treated as burned. Mainnet
launch does not reuse any of them. The list, today:

| Role | What it is on 46630 | What it must be on 4663 |
|---|---|---|
| Deployer EOA (`PRIVATE_KEY`) | `0x73db078f…` — deployed the factory, ran the drill, still the owner | A **new** EOA, used once for `DeployMainnet.s.sol`, then idle after the Safe accepts |
| PoG signer (`POG_SIGNER_PRIVATE_KEY`) | **The same key** as the deployer | A **new** EOA, **not** the deployer. Address goes to `POG_SIGNER_ADDRESS` / `factory.pogSigner()`. The private key is written to Vercel Production only and is never saved in a laptop `.env*` |
| Factory / treasury owner | The deployer EOA | Gnosis Safe, 2-of-3 (PM-D4). The Safe is itself new; its three signers are not `0x73db078f…` |
| Laptop copies | `.env`, `soat-frontend/.env.local`, `.env.bak-premigration` | May keep the *testnet* keys for 46630 work. A mainnet private key that exists in any of these files is a failed cutover |
| Vercel `POG_SIGNER_PRIVATE_KEY` | Currently the testnet key | Replaced at C1, same sitting as the factory deploy. Leaving the testnet value in Production against a 4663 factory is `InvalidSignature` for every depositor |

`DeployMainnet.s.sol` now refuses `POG_SIGNER_ADDRESS == deployer`, so the
collapse that 46630 ran with cannot be broadcast on 4663. It cannot see a
laptop file, so the "never write the mainnet key locally" half stays a
human step, checked by `cast wallet address --private-key` against an empty
grep of the working tree.

Generate the two new keys at C1, not before. Generating them now and parking
them in `.env.production` on this machine recreates the thing the rotation
is for. The deployer's public address can be funded in advance (D2's cousin);
the PoG private key is generated, pasted into Vercel, and discarded, in that
order, on the sitting that broadcasts. **That sitting has happened:** the
2026-09-08 broadcast used deployer `0x4E41CE…` and PoG signer `0x0E496Bd5…`.
What §4.1 still requires is that the PoG private key exist only in Vercel
Production, and that the deployer key be destroyed once C2 lands (runbook §7).

**Deployer key, destroyed 2026-09-08.** Destroyed `0x4E41CE…`, deleted it from
`.env.production`, kept no copy, and abandoned its residue rather
than spend a transaction sweeping it. It has no authority over the canonical
contracts (both `owner()` = Safe). It is still `owner()` of both orphans: the
paused factory `0x96a2A0f4…` and the treasury `0xbA6c032d…` (balance 0, no
listed tokens, no Pausable). The operator had intended the deployer to
`renounceOwnership` on both orphans before the key was destroyed; those
calls were never sent (deployer nonce 12, no such transactions). The
orphans are stranded with a dead owner and `pendingOwner()` = the Safe.
The remedy taken is the path §5.31 originally declined: the Safe
`acceptOwnership` then immediately `renounceOwnership` on each, atomically
in one MultiSend batch. Built and verified 2026-09-08; the first build sat
at nonce 1 with both signatures and was voided when `setPogSigner` took
that slot; rebuilt at nonce 2 as `safeTxHash` `0x389d443c…` and
**executed 2026-09-09**, tx
`0xba5995e1dde8f0287422dd327aa10de76d633ad6100cfd6d85cd3bd733cff3b2`
at block 58,601,352.

Verified on chain after execution: both orphans read `owner()` = zero and
`pendingOwner()` = zero, and the orphan factory still reads `paused()` =
true — stopped, with no address left that could ever `unpause()` it. The
canonical pair is untouched (factory `0xba9d2e86…` and treasury
`0x99ad248d…` both `owner()` = the Safe, `pendingOwner()` zero, not
paused). Safe nonce is 3. See `SECURITY_AUDIT.md` §5.31, and §5.26 for
the orphan pause.

> **Signed is not executed, and the two are easy to conflate.** A
> `safeTxHash` is what owners sign; it exists as soon as the batch is
> built, and collecting the threshold does not submit anything — somebody
> still has to send `execTransaction`, and the on-chain nonce is the only
> thing that says whether they did. This was reported complete on
> 2026-09-09 on the strength of the signatures being gathered. Read
> `nonce()` and the two `owner()` values, not the signing UI.
>
> **And a signed batch occupies a nonce it does not own.** The `_nonce`
> field is inside the EIP-712 `SafeTx` struct, so a signature authorises
> one transaction at one sequence position and nothing else. While this
> batch sat signed at nonce 1, the PoG rotation was executed — and it
> took nonce 1, because that was simply the next slot. Both signatures
> died at that moment, silently: nothing rejects them, they just no
> longer describe anything executable. Rebuilding the identical four
> calls at nonce 2 reproduces `0xffe2da61…` exactly when hashed at nonce
> 1, which is how the two were confirmed to be the same batch differing
> only in position. **Execute a signed Safe transaction before starting
> another, or expect to re-sign it.**
>
> **And an empty queue proves nothing.** The rebuilt hash was computed by
> `eth_call` against the Safe's `getTransactionHash()`, which posts
> nothing to the Safe Client Gateway — so the web queue stayed empty and
> looked like a failure when it was only ever a local computation.
> Creating the transaction in the UI is what enqueues it. There were also
> no signatures to hand over: a rebuilt hash starts at zero, and nothing
> in this repository's tooling holds an owner key, by design.

### 4.2 Custody is checked, not remembered

`npm run check:secrets` (`scripts/checkSecretStore.mjs`) reads the live Vercel
Production environment, the GitHub Actions secret list **and the GitHub Actions
variable list**, and compares all three against an inventory that names every
credential and says which store it belongs in. Run it before C1 and again after
the §4.1 rotation, because that rotation re-adds every row and "I put them all
back" is a different claim from "they are all there, and none of them landed one
tier too readable".

**The tier is the point.** Vercel has two, and the dashboard draws them almost
identically:

| `type` | Who can read it back |
|---|---|
| `sensitive` | Nobody. Not the dashboard, not `vercel env pull`, not the owner |
| `encrypted` | Any account with project access, in plaintext |

`vercel env add` chooses between them with a prompt that is easy to click past.
A signer key that lands on `encrypted` is stored, encrypted at rest, shown with
a lock — and readable by every collaborator forever, with nothing anywhere
saying so. That is the failure the check is aimed at, and it is why the script
asserts the tier rather than mere presence.

**Why the variable list is read too, added 2026-09-05.** GitHub keeps secrets
and variables in separate namespaces, and a workflow that reads `secrets.X`
cannot tell whether a plaintext `vars.X` sits beside it. A credential set with
`gh variable set` instead of `gh secret set` is therefore readable by anyone with
repository access while the running system looks entirely correct — the exact
shape of the Vercel tier mistake above, in the other store. Reading only the
secret list left that invisible, so the check now reads both, treats a name
present in *both* namespaces as a finding, and requires every variable to be
classified as well. This is also what makes the four `MONITOR_*` addresses
reviewable: they are public, but they are also what decides **which chain is
being watched**, and nothing had ever said out loud that they hold no credential.

The inventory is closed in both directions. A credential live in any store
that no row classifies is a finding, so a variable cannot be added to
Production without someone deciding what it is; and `ADMIN_SECRET` is
classified `absent`, so setting it is also a finding. That last one is not
pedantry: unset, `POST /api/admin/config` has no bearer path at all and the
recovered-signature-equals-`factory.owner()` check is the only way in. Filling
the variable because its name looks like a gap re-opens a shared-secret route
to a privileged endpoint. The unclassified direction has now fired for real
twice: first `MONITOR_RPC` on 2026-09-05, then `NEXT_PUBLIC_RPC_URL` on
2026-09-08 when PM-C7 cut Vercel Production over to chain 4663. The second
is `config` because the prefix inlines it into the browser; today's value is
the public endpoint, and the inventory `why` is the control for the remaining
trap — a keyed Alchemy / Infura URL in that slot stays `config`, stays green,
and ships a credential to every browser. The check has no value inspection and
no conditional tier.

Five injected faults — a credential downgraded to `encrypted`, a required one
missing, an `absent` one set, an unclassified variable live in Vercel, and a
missing CI secret — were each caught by the script before it was committed.

**Local copies, added 2026-09-08.** Store-and-tier is not the same claim as
"and nowhere else". The script now also asserts that every `secret`-tier name
in its inventory is absent or empty in the local dotenv files under
`soat-frontend/` (`.env`, `.env.local`, and other `.env*` siblings, excluding
`*.example` templates). Presence of a non-empty assignment is the entire
signal; values are never printed and never compared. If no such file is
present — CI, because `.env.local` is gitignored — the check reports that
local copies were not evaluated, rather than treating an empty scan as a
pass. That gap is what §5.31 records: the check was green while two live
production credentials sat in `soat-frontend/.env.local`. Those copies are
now deleted and the live values rotated; the check is 27/27 green. The
open custody defect on this machine is a different variable — the live
PoG signing key in PowerShell history, §5.32, which is PM-D1.

It needs an authenticated `vercel` and `gh`, which CI deliberately does not
have, so it is an operator command and not a gate. **Preview and Development
hold nothing**, which is a posture rather than an oversight: a preview with no
variables fails at boot, where one holding the production service-role key
would come up looking healthy and writing to the real registry. The script
prints that state and flags it if Preview ever stops being empty.

---

## 5. Gate E — Observability and operations

| ID | Item | Evidence of done | Status |
|---|---|---|---|
| **PM-E1** *(legacy `#26`, frontend half)* | Frontend error monitoring wired | `@sentry/nextjs` installed; `instrumentation*.ts`, `observability.ts`, error boundaries and API routes report | ✅ |
| **PM-E2** *(legacy `#26`, on-chain half)* | **On-chain alerting on contract events and state** | Spec + config-as-code: `docs/ONCHAIN_MONITORING.md`, `monitoring/alerts.json` (24 alerts, 7 state checks), CI-guarded by `scripts/verifyAlertTopics.js`. **The host and the sink exist** (`.github/workflows/watch.yml` + `monitoring/report.mjs`, §7.3) and **`MONITOR_*` now points at 4663.** Remaining is a real pager — §8 of that doc is the done-list. | 🟡 scheduled on mainnet, first pass was blind. There is **no vendor**: `monitoring/watch.mjs` consumes the catalogue directly (§7.1). Rehearsed over 900k blocks of 46630 (11 of 24 alerts matched, both §2.1 hook methods, STATE-05 disproved its own premise — how PM-D2 closed). **Re-point happened**; `workflow_dispatch` run 34196807435 then printed `0 log(s)` over blocks 56,592,252–57,492,252 and went green. Independently that window held seven logs (GOV-01/02/03/06/07, all P0). The 4663 public RPC 429s a tight `eth_getLogs` loop on request #7 (JSON-RPC body error, not HTTP status); 250 ms pacing is clean; `Promise.all` fails immediately; a 1,000,000-block window is accepted. 46630 accepted the tight loop, so the rehearsal could not have caught this. Three defects, now fixed (`SECURITY_AUDIT.md` §5.28): no throttle/retry; WATCHER-02 was `page: false` so a blind pass filed only WATCHER-03; `probeRpc.mjs` ignored `MONITOR_*` and crashed on mainnet. **The skipped window will not be backfilled.** Decided 2026-09-08 (`SECURITY_AUDIT.md` §5.28, `ONCHAIN_MONITORING.md` §7.1): those seven logs are the PM-C1 deploy and the PM-C2 ownership handoff, already in the dossier; filing five P0 issues for them would train responders to ignore P0s. Observed history on 4663 therefore begins at block 57,492,253. That is a stated limitation, not an open item on this row. What keeps this at 🟡 is unchanged and honest: GitHub Issues is a monitor rather than a pager — best-effort cron, auto-disabled after 60 idle days, and nobody is woken by an issue. §7.3 states that plainly rather than letting the green tick imply otherwise |
| **PM-E3** | Sentry DSNs populated for production | `NEXT_PUBLIC_SENTRY_DSN` set; a test event lands in the right project | ✅ DSN + org + project + `org:ci` token in Vercel Production. Event `09496d0b8e…` confirmed in `tosh-production` under `environment=production`, and verified on **both** routes an error can take — direct ingest and the `/monitoring` tunnel a browser actually uses. Source maps upload for real: release `5e9d92ba…` attached to `tosh-production`, 121 of 122 chunks paired with a map and a debug id, bundle `af8399aa…`. §5.1 |
| **PM-E4** | On-call roster placeholders replaced | `INCIDENT_RESPONSE.md` §1 names the channel; handles live in the offline vault, not in this repository | ✅ 2026-09-08. §1 has no placeholders. Tom, Jack and Joe are named against the addresses they signature-proved, each reachable on Encrypted Signal / Telegram with the handle kept in the offline 1Password / Vault. Incident commander and Comms lead are both the Deployer / Primary Operator — the same person, not Tom or Jack or Joe. Legal is N/A (Decentralized protocol / Founder-led at launch). What the criterion asked for is the placeholders gone and the channel named. Nobody has been paged at 03:00 to prove the channel works, and no guard here can see the vault. |
| **PM-E5** | First incident drill run and dated | `INCIDENT_RESPONSE.md` §8 drill log | ✅ **Q1's three criteria all met, 2026-09-04.** §8.3 closed the third line that §8.1 and §8.2 both failed: Tom and Joe — two of the three real mainnet Safe owners, neither of them the operator — signed `acceptOwnership` / `pause` / `unpause` / `transferOwnership` back through drill Safe `0x853D416A…` on 46630, whose owner set matches the mainnet Safe and **does not include the deployer**. Pause window 602 blocks ≈ 1 min 56 s (bar is 30 min). Status page `paused` banner fetched live 15.7 s after push. Deployer's own `unpause()` reverted `OwnableUnauthorizedAccount` while the Safe held the brake. Factory restored: owner is the deployer, `paused()` is false, `/drill/` taken down. Twitter / Discord / `#status` remain unopened accounts — they are Step 4 amplification, not this row's criterion. The remaining limitation is honest: the signers were expecting the request, so this timed a round-trip to a waiting person, not a 03:00 wake-up |
| **PM-E6** | D1–D4 accepted-risk review triggers have an owner watching them | Named owner per trigger (`PRD-v5.0.md` §11) | ✅ 2026-09-08. Watcher is the Deployer / Primary Operator — the same person as Incident commander and Comms lead, no separate role. Named once at the head of `PRD-v5.0.md` §11, covering D1–D4. Naming a watcher is not the same as having watched; the triggers themselves are unchanged. |

> **PM-E2 is a documented dependency, not a nice-to-have.**
> `INCIDENT_RESPONSE.md` §8 already scripts a quarterly drill around
> "detected within 15 minutes via a Defender alert", and
> `DeployMainnet.s.sol` lists wiring it as step 6. Until PM-E2 is *live*, the
> detection half of every on-chain playbook in that runbook is aspirational —
> PM-E1 covers browser and API errors only, and a silent `OwnershipTransferred`
> is exactly the event nobody notices by hand.
>
> Three findings from writing the spec are worth carrying here, because each
> makes a naive setup useless rather than merely incomplete:
>
> - **Hook addresses cannot be enumerated in advance.** One `CREATE2` hook per
>   project, mined for the `0x20CC` mask. A monitor configured with a fixed hook
>   list covers every project alive on setup day and none created afterwards,
>   with no error to notice.
> - **The refund transitions emit nothing.** `refundEnabled` /
>   `zombieRefundEnabled` are event-dedup flags set lazily inside `refund()`, so
>   `GenesisFailed` fires when the first depositor claims — not when the round
>   failed. A round can sit refundable, holding user money, while the event
>   stream looks idle. `canRefund()` is a view, so only a scheduled state poll
>   can catch it (STATE-01).
> - **A skipped buyback emits nothing either.** The gas gate in `afterSwap` drops
>   the poke when the triggering trade cannot afford it, and deliberately logs
>   nothing: skipping is the common case and an event would bill every trader for
>   it. So a reservoir can sit armed and idle indefinitely with a clean event
>   stream — same shape of blind spot as the refund flags, and it needs the same
>   answer, a scheduled balance poll (STATE-06). The remedy is permissionless:
>   anyone can call `pokeBuyback()`, so this is a monitoring gap rather than a
>   custody one.

### 5.1 PM-E3 — "the DSN works" and "the events are somewhere anyone looks"

The row asks for a test event in the **right** project, and the second word is
the whole requirement. `scripts/checkSentry.mjs` (`npm run check:sentry`) posts
an envelope to the same ingest endpoint `@sentry/nextjs` uses and reports what
came back. A 200 from ingest means the DSN was accepted; it does not mean the
event is visible where an on-call rotation is looking. A DSN addresses a project
by **numeric id**, a human opens one by **slug**, so a DSN belonging to some
older project satisfies every check that stops at "200" while the watched
dashboard stays empty. Given a token the script resolves the DSN's numeric id
back to a slug and compares it with `SENTRY_PROJECT`.

That gap is not hypothetical, and setting this up walked into a version of it.
The org slug supplied by hand was `tosh-sz`; the org auth token's own payload —
base64 in its middle segment — said `tosh-x2`. The API settled it: `tosh-x2`
answered `/releases/` with 200 and `tosh-sz` with 404. Had `SENTRY_ORG=tosh-sz`
been written as given, `next.config.ts` would have gated source-map upload on
three variables that were all set, and produced no upload and no error.

The comparison could not be automated in the end, and the reason is worth
recording so nobody re-litigates it. Sentry's Organization Tokens are
fixed-scope `org:ci` — release creation, source-map upload, code mappings — and
the UI offers no way to add `org:read` or `project:read`. Listing projects
therefore returns 403 to the only credential a deployment should be holding; the
alternatives that could do it are a personal token, which is a person rather
than a deployment and dies when they leave. So `check:sentry` now says that
plainly instead of "token may lack project:read", which would send someone to
look for a checkbox that does not exist, and the DSN-to-slug comparison stays a
one-time human step — done, event `09496d0b8e…`. It does not need repeating: the
DSN is pinned in Vercel and changing it is a deliberate act.

What the script checks in its place is the capability that token exists for. All
three of `SENTRY_AUTH_TOKEN` / `SENTRY_ORG` / `SENTRY_PROJECT` being non-empty
satisfies `next.config.ts`'s gate, which cannot tell a live token from a revoked
one — and a sourcemap step that fails is deliberately non-fatal, so that build
succeeds, uploads nothing, and says nothing. The script asks
`/api/0/organizations/<org>/chunk-upload/`, the endpoint the upload actually
goes through, whether this token may use it.

And the human step turned out to be only half necessary. **Releases are readable
with `org:ci`, and a release names the project slugs it was created against** —
so the build's own artifacts state which project this pipeline uploads to,
mechanically, with the credential we have. `check:sentry` now reads the latest
release and fails if it is not attached to `SENTRY_PROJECT`. What that still
cannot cover is the DSN: source maps could land in `tosh-production` while
events go elsewhere, because nothing ties the DSN's numeric id to a slug without
`project:read`. So the eyeball step shrank from "is any of this wired up" to
"does the DSN point here", which is one question asked once.

Verified end to end on release `5e9d92ba…`: attached to `tosh-production`, 121
of 122 chunks paired with a source map and a debug id, `Bundled 212 files`,
bundle `af8399aa…`, `Successfully uploaded source maps to Sentry`.

The one unpaired chunk is worth naming rather than rounding to 100 %. It is 112
kB of pre-minified UMD — a `globalThis` detection preamble, no license banner,
no library name, and no debug id where every application chunk has one — so a
vendored dependency shipped without a map, which Turbopack passes through and
which therefore has nothing to upload. Frames originating inside it will stay
minified in Sentry. That is a real if small gap, and it is not fixable from this
side: the dependency would have to ship its own maps.

##### An error takes two routes to Sentry, and only one of them is the hot path

Everything above talks straight to ingest. A browser in production does not:
`tunnelRoute: '/monitoring'` makes the SDK post to the app's own origin, which
rewrites to ingest server-side, so a wallet extension or a corporate blocklist
cannot drop every report. That means the original check and production disagreed
about the route — the exact mismatch `checkSentry.mjs`'s own header warns
against — and the tunnel is the one that matters.

Checking it took two corrections worth keeping, because both are easy to repeat:

- **`POST /monitoring` with no query string is a 404 by design.** The tunnel is
  a Next.js rewrite, not a route handler, and it matches on `has` conditions
  requiring `?o=<orgId>&p=<projectId>`. A bare POST returning 404 says nothing
  about whether the tunnel works. The correct shape, with org id and region read
  out of the DSN host rather than configured separately, returns 200 and
  Sentry's event id.
- **A 404 from the tunnel has two causes that need opposite answers.** Vercel
  answers 404 for a deployment that does not exist at all, so the first version
  of this check reported "the rewrite is not there" for a mistyped hostname —
  naming a cause in `next.config.ts` for a typo in an argument. It now asks the
  site root first and says which case it is. That flaw was found by mutation
  test, not by reading.

`check:sentry` takes an optional deployment URL and probes both routes. Verified
green on `tosh-two.vercel.app`; the "rewrite missing" branch was exercised by
temporarily pointing it at an absent path, because a branch that has never run
is a branch that has not been checked.

Two smaller things worth keeping:

- **`NEXT_PUBLIC_SENTRY_DSN` is deliberately absent from `.env.local`.**
  `observability.ts` treats a missing DSN as monitoring-off and calls that the
  correct state for local dev. Putting the production DSN there would send every
  half-written component and deliberately-broken fixture into the production
  project under the same `environment` tag as a real fault — which does not add
  noise so much as teach the PM-E4 rotation to ignore this project. The file now
  carries that reasoning and the one-shot invocation instead of a value.
- **401 and 403 are different answers.** A token that returns 401 is not
  under-scoped, it is unrecognised, and no amount of adding scopes fixes it.
  Distinguishing the two is what stopped this from being debugged as a
  permissions problem.

### 5.2 A stale `.env.local` one directory above the real one

Found while placing the Sentry variables, and it belongs to the family
`scripts/checkEnvShadow.mjs` was written for — that guard's own comment says
the failure "has now cost this project twice". This was a third instance, and
the guard could not see it: it compares the ambient shell against the keys
`soat-frontend/.env.local` declares, and knows nothing about a second file of
the same name in the repo root.

That file held `NEXT_PUBLIC_FACTORY_ADDRESS` pointing at the **pre-redeploy
factory** (`0xCD824ee8…` against the live `0x2E690A91…`), a Supabase URL and
anon key for a **deleted** project, and a duplicate of the PoG signer key.
Next.js never read it — its project root is `soat-frontend/` — so production was
never affected. The diagnostics were: they resolve `.env.local` against the
current directory, and run from the repo root `checkSupabaseRls.mjs` connected
to the old project. It failed only because that project no longer exists. Had it
still been alive, the script would have reported RLS correctly enforced on a
database nothing reads.

Deleted. The same command from the repo root now fails with "not set", which is
the outcome to want: a diagnostic that cannot find its configuration should say
so, not quietly find the wrong one. `.env.bak-premigration` is still there and
still holds a plaintext `PRIVATE_KEY`, but no loader looks for that name, so it
is dormant rather than shadowing — it belongs to PM-D1.

---

## 6. Gate F — Frontend and platform

| ID | Item | Evidence of done | Status |
|---|---|---|---|
| **PM-F1** *(legacy `#6`)* | API route hardening: CORS allow-list, rate limit, body cap | `apiGuard.ts` primitives adopted by every route under `src/app/api/**` | ✅ |
| **PM-F2** *(legacy `#24`)* | Multi-RPC fallback rather than one hard-coded endpoint | `providers.tsx` uses `fallback()` over a ranked list | ✅ |
| **PM-F3** | Frontend CI: typecheck, lint, build, token check | `frontend.yml` `verify` job green on `jayoo101/Tosh-Core@3c82f73` — see §6.1 | ✅ |
| **PM-F4** | Dependency advisory gate | `frontend.yml` `audit` job green on the same run — `npm audit --audit-level=high` | ✅ |
| **PM-F5** | Rate limiter survives multi-instance deployment | Shared backend behind the `apiGuard` limiter, or a documented single-instance constraint | ✅ Upstash on AWS `us-east-1` beside Vercel `iad1`; both vars in Vercel Production. Live `GET /api/projects` returns 200 with no `X-RateLimit-Backend` header, which is the shared-store path |
| **PM-F6** *(legacy `#10`)* | Testnet strings reviewed for a mainnet audience | `soat-frontend/scripts/checkChainCopy.mjs` green on chains 4663 / 46630 / 31337, wired into `frontend.yml` | ✅ |
| **PM-F7** | Supabase production project provisioned with row-level security | Policies reviewed; anon key cannot write `projects`; rows scoped to a chain | ✅ project provisioned, 0001 and 0002 run, `npm run check:supabase` green on all seven checks, and the three vars set in Vercel Production — see §6.3 |
| **PM-F8** | Launch flow shows an estimated gas cost before the creator signs | Launch UI renders an estimate for `createLaunch` | ✅ |
| **PM-F9** | Genesis allocation is sized from something real, or the docs say it is not | Either the scan reads a live indexer, or §2.3 of the audit dossier and the user-facing copy state that every eligible address receives the same flat amount | ✅ `gasHistory.ts` sums outbound fees across five chains through the keyed Blockscout PRO API, banded by a 0.05 ETH floor and a 1 ETH cap; live scan green, and the deployer's Ethereum total still reproduces to the wei (`0.11395591` ETH) after the migration. Capacity ~1,000 wallets/day on the measured free tier, gated by an observed-credit reserve rather than a guessed request count. An unreadable Robinhood degrades to a flagged lower bound; the four majors still fail closed — see §6.4.1 and §6.4.2 |

### 6.1 PM-F3 / PM-F4 — a workflow file is not a workflow run

Both rows were `✅` on the strength of the YAML existing. Checked against the
repository on 2026-09-03, neither job had ever run and one of them could not
have: there was no git remote, and `frontend.yml` was not tracked by git at
all. They were reset to 🟡, and are green now on a run rather than on a file —
`jayoo101/Tosh-Core` (private), `main` green on both workflows at `3c82f73`.

The first run is the argument for §0.2, so what it cost is worth recording.
Five defects were sitting in a tree that every local check called clean, and
four of them share a shape: **a check that passes on a developer machine and
cannot pass anywhere else.**

- `soat-frontend/.env.production.example` had never been committed. The
  frontend `.gitignore` carries a blanket `.env*` with no exemption, unlike
  the root one, which names both templates. `checkPublicEnv.mjs` derives the
  `NEXT_PUBLIC_*` keys it verifies from that template — so the guard read a
  file git had been hiding since the day it was written, and died with ENOENT
  on the runner.
- `next build` could not collect route config for `/api/projects/lookup`:
  `supabase.ts` builds its client at module scope and throws without
  `NEXT_PUBLIC_SUPABASE_URL` / `_ANON_KEY`, which the workflow never set. The
  build had only ever succeeded on machines with a populated `.env.local`.
- Foundry was unpinned. `stable` resolved to 1.8.1, whose formatter wants a
  line break 1.7.1 does not, so `forge fmt --check` failed on a tree nobody
  had edited. Now pinned; the isolated-gas step is the reason it matters more
  than formatting.
- `FOUNDRY_PROFILE: ci` named a profile `foundry.toml` does not define. Every
  run fell back to default and said so in a warning nobody was there to read.
- `forge build --sizes` failed on `CloneDeployer`, a 27 KB test helper. The
  step reports one verdict for the whole tree, so an over-limit test contract
  masks the size gate for every contract that ships.

The fifth was not CI hygiene at all — see §6.2.

Note also that these workflows are GitHub Actions specific — `secrets.*`,
`github.event.repository.fork` and `::error::` annotations. Hosting the
repository anywhere that does not run Actions satisfies neither row, and does
not create the secret store PM-D3 needs either.

### 6.2 The deployed bytecode depended on the machine that built it

`test_hookBytecode_inSyncWithArtifact` failed on the runner. The two artifacts
were compared field by field, and almost everything matched:

| | local | runner |
|---|---|---|
| source hashes | 44 | 44, all identical |
| compiler, optimizer, viaIR, evmVersion | | identical |
| executable code | | byte-identical |
| `settings.remappings` | **12** | **15** |

That last row is the whole difference and it is sufficient. solc records the
remappings in the contract metadata and appends the metadata hash to the
creation code, so the trailing 32 bytes moved. Auto-detection builds that list
by scanning `lib/`, and this tree carries `permit2`, `erc4626-tests` and
`halmos-cheatcodes` as *empty* directories — uninitialised submodules — while
CI checks out `recursive` and gets them populated.

This is not a CI problem wearing a disguise, but the first version of this
section overstated what it was. The claim written here was "every launch
reverting for every user". That is wrong, and the correction is worth more than
the original point.

The launch page does not mine against any local copy of the creation code. It
reads `factory.hookInitcodeHash(...)` off the chain and mines against the
answer, so it adapts to whatever factory is live — a machine-dependent build
does not break launching. What it does break is anything that predicts an
address *before* a deploy, and anything that rebuilds the source afterward to
check it:

- **Source verification.** Blockscout compares the metadata hash. A clean clone
  is the tree an auditor builds, and it would not match what was deployed.
- **PM-C6.** The committed initcode hash is only true for the machine that
  produced it, and the row exists to make it true for everyone.

Both are auditability failures rather than availability failures, which is a
smaller blast radius and a longer-lived problem.

Fixed by removing the dependency rather than by matching the two machines:
`auto_detect_remappings = false` with all eight prefixes listed explicitly in
`foundry.toml`, derived by scanning imports rather than by copying what
auto-detection produced. A `.gitattributes` was added in the same change for
the same reason — `core.autocrlf=true` is the Git for Windows default and
metadata hashes source *bytes*, so a clone on Windows would have changed all
44 source hashes. This tree escaped that only because its files were written
LF by an editor rather than materialised by a checkout.

**Consequence:** the metadata hash is now `3ae40d72…`, replacing two accidental
values (`da4562f8…` local, `bd0f4787…` runner). Testnet 46630 was redeployed —
not because it had stopped working, but because its contracts were verified
against pre-pin source and would no longer reproduce from this tree. The new
deployment is recorded in ROBINHOOD_MIGRATION.md §F.2b.

#### The guard that raised this was pinning a constant nothing imported

`test_hookBytecode_inSyncWithArtifact` compared the compiled hook artifact
against `soat-frontend/src/app/lib/hookBytecode.ts`. Chasing its failure is
what surfaced the remapping problem, so it earned its keep once. But it, the
constant, the extractor that wrote it, its CI step, its `fs_permissions` entry
and three comments asserting its importance have all been deleted, because
nothing imported `HOOK_BYTECODE`.

It was load-bearing before the EIP-1167 refactor, when a hook was deployed from
its own creation code. Afterwards a hook is a 131-byte clone whose initcode
carries the *implementation address*, and `hookMiner.ts` builds that from the
address alone. The constant stopped being read; the machinery around it did
not stop running, and its comments went on describing the old design — which is
how a stale comment came to be the source cited for the overstatement corrected
above. The comment was auto-generated, so it would have regenerated after any
manual fix.

Worth naming the general shape, since this tree has a lot of guards: a guard
that pins a value nothing reads still fails, still costs a red CI and an
investigation, and still teaches whoever reads its comment. What it cannot do
is catch a bug. Prefer `factory.hookInitcodeHash(...)` — asking the contract —
over any check that restates the contract's answer in a second file.

### 6.3 PM-F7 — the front door was locked and the side door was not

This row's evidence line has always read "anon key cannot write `projects`",
which is the correct requirement. The SQL that was supposed to implement it did
the opposite. It lived in a comment block in `src/app/lib/supabase.ts`:

```sql
CREATE POLICY "service write" ON projects FOR INSERT WITH CHECK (true);
```

The name says service. The SQL does not — a policy with no `TO` clause applies
to PUBLIC, which includes `anon`, and `anon` is the role behind
`NEXT_PUBLIC_SUPABASE_ANON_KEY`. That key is handed to every browser by design;
RLS is the only thing that makes doing so safe. Applied as written, anyone
could POST rows straight to PostgREST.

**What makes this sharper than a loose policy** is that the attack it re-opens
was already known and already fixed. `src/lib/projectAttestation.ts` documents
it: watch the chain for `LaunchCreated`, POST that `txHash` first with your own
links, and — because `tx_hash` is UNIQUE — the real creator's publish comes
back `{ ok: true, duplicate: true }`, a 200, while the project page serves the
attacker's site to their audience. The fix was a `personal_sign` attestation
the route recovers and compares against `launch.creator`, and it is a good fix.
It just does not bind anyone who never calls the route. PostgREST does not run
that file.

So the route's checks were load-bearing in intent and advisory in fact. Closing
it needed both halves:

- **`soat-frontend/supabase/migrations/0001_projects_rls.sql`** — the schema and
  policies as a migration rather than a comment. `anon` and `authenticated` get
  SELECT; there is deliberately no INSERT, UPDATE or DELETE policy, because
  under RLS a missing policy denies and `service_role` is BYPASSRLS. It also
  `FORCE`s RLS so the table owner is not exempt, drops the two old policies by
  name if they were ever applied, and revokes the write grants as a second
  layer.
- **`src/app/lib/supabaseAdmin.ts`** — a service-role client, built lazily so a
  deployment without the key still builds and still serves every read, with the
  write path returning 503 naming the missing variable. `POST /api/projects`
  now writes through it; reads stay on the anon client, which is both least
  privilege and a live check that the public read policy works.

`SUPABASE_SERVICE_ROLE_KEY` is new, server-only, and bypasses RLS — it belongs
in the hosting secret store, and it is part of what PM-D3 has to collect.

Two things were adjusted so the change cannot rot. `scripts/checkSupabase.mjs`
matched `supabase.from(` literally, so the new `supabaseAdmin.from(` would have
been invisible to the deadline guard — on the one path with no fallback. Its
docstring had predicted the shape of this ("the fourth one added will not ask
it either") without predicting that the fourth would not be seen. And
`route.post.test.ts` asserts the insert lands on the service-role client **and
that the anon client was not called** — verified by mutation, since a test that
only checks the status code passes either way.

##### Verified against a live project on 2026-09-03

The project exists, the migration has been run against it, and
`npm run check:supabase` (`scripts/checkSupabaseRls.mjs`) is green. That script
is deliberately a different kind of check from its sibling: `checkSupabase.mjs`
reads source and refuses a `.from(...)` chain with no `.abortSignal()`, while
this one talks to the real database, because the property in question is not in
the source at all. It lives in the policy catalogue, it is wrong by default, and
the step that makes it right is performed by a human in a dashboard exactly once.

`route.post.test.ts` proves the route writes as the service role. It cannot
prove the database would refuse anyone else, because there the database is a
mock that agrees with whatever it is asked.

Two things the live run established that the tests could not:

**The denial is at the grant layer, not RLS.** All three write verbs come back
`401` with PostgreSQL's `42501` and the hint `GRANT INSERT ON public.projects TO
anon` — meaning `anon` holds no write privilege at all. That is the migration's
`REVOKE`, the outer of its two locks; RLS's missing-policy denial is the inner
one and is never consulted. Both are installed. Worth naming which answered,
because a project whose grants were fixed and whose policies were not looks
identical from outside until someone re-grants.

**The check tested INSERT alone at first, and that was a real gap.** UPDATE is
the easier attack — no squatting, no race against the creator, just rewrite the
logo and outbound links of a project that already exists and is already trusted.
It now tests all three verbs.

The keys are the new `sb_publishable_` / `sb_secret_` format rather than the
legacy anon/service_role JWTs. Same roles behind them, so the policies naming
`anon` still apply; unlike the JWTs they do not expire and can be revoked
individually.

Warm read latency measured 470 ms from a developer machine in Asia — the same
figure Upstash returns from that machine, which is how the region was confirmed
rather than assumed. The first two calls cost ~2.1 s to establish the
connection, which is 1.6 s of TLS handshake at cross-Pacific RTT and not a
production figure. It is worth noticing only because
`REGISTRY_READ_DEADLINE_MS` is 1,200 ms: co-located that budget is enormous,
and from here it is not.

##### 0002 — a row knew who wrote it and not what it was about

Found while deciding how to scope Vercel's environments, which is the useful
part: the question "may Preview and Production share one Supabase project?" is
what surfaced it, and nothing in the test suite or the guards would have.

0001 settled **who may write**. It left **what a row is about** unasked. A row
identified a launch by `tx_hash`, and a transaction hash does not name a chain.

The hazard was already understood — `POST /api/projects` carries a comment
naming it exactly:

> Read it from the wrong one and a launch minted on a free testnet
> authenticates a listing in the mainnet directory: the caller genuinely is
> that launch's creator, the signature genuinely verifies, and the row is still
> a forgery.

The `assertServerChain()` check under that comment defends the write path's own
consistency. It cannot defend **which directory the row lands in**, because the
row carried nothing to sort it by, and both reads — `GET /api/projects` and
`getProject.ts`, which matches on token/hook address — selected every row in the
table. So two deployments sharing one project mix their listings while every
individual write is correctly authenticated. Nothing is forged in the sense the
write path checks for; the rows are simply about somewhere else.

It does not take two deployments. **One deployment repointed does it too** — the
testnet rehearsals that precede a mainnet cutover write rows the mainnet
directory then reads as its own. That is the case that made this urgent rather
than tidy, since a rehearsal was in progress.

`0002_projects_chain_id.sql` adds `chain_id BIGINT NOT NULL`, moves uniqueness
from `(tx_hash)` to `(chain_id, tx_hash)`, and replaces the 0001 indexes with
leading-`chain_id` composites so the now-filtered reads stay indexed. Both reads
filter on it; the insert stamps `targetChain.id`.

Three things worth recording about how it was found and checked:

- **The type system found the call sites, not a search.** Adding `chain_id` to
  `ProjectRow` produced five errors in three files — the chain-fallback row in
  `getProject.ts`, two `rememberProject` calls in `launch/page.tsx`, and
  `directoryToRow` in `MeritXProjectCard.tsx`, whose return type was inferred
  rather than annotated and is now annotated for that reason.
- **The session cache had the same shape of bug**, keyed by bare address. The
  exposure is narrow — `TARGET_CHAIN_ID` is fixed at build time and
  sessionStorage is per-origin — but not narrow enough for a tab held open
  across the redeploy that repoints a domain from testnet to mainnet. The key
  is chain-scoped now.
- **`checkSupabaseRls.mjs` asks the live schema whether 0002 has been run**,
  because the repository and the database are connected only by a human pasting
  a file into a dashboard. Against a project still on 0001 the filter names a
  column that does not exist, PostgREST answers 400, and the result is an empty
  directory and a total lookup miss on a database that is otherwise healthy —
  while writes keep succeeding, which is what would have made it quiet.

Every new assertion was mutation-tested: dropping either `.eq()`, or the
`chain_id` from either insert, fails exactly one test each.

The three vars are now in Vercel Production and were read back. This row is
closed. Holding the service key *only* there, and not also in a laptop file,
is PM-D3.

> **PM-F6 was worse than a wording pass.** Five components — navbar, footer,
> user drawer, admin header, and the directory hero — each built the same byline
> by hand as `` `${MAINNET_CHAIN_LABEL} · testnet ${ACTIVE_CHAIN_LABEL}` ``, with
> "testnet" as a JSX literal. Correct on staging; on chain 1 every one of them
> renders **"Ethereum · testnet Ethereum"**, in the site footer, on every page.
>
> The root cause was a name. `TESTNET_CHAIN_LABEL` holds `"Ethereum"` on a
> mainnet build — the identifier asserted something the value does not carry, so
> five call sites reasonably annotated it. It is now `ACTIVE_CHAIN_LABEL`
> ("wherever we are pointed"), beside a new `IS_TESTNET` for the distinction the
> label cannot make and a derived `CHAIN_BYLINE` those five now share.
>
> Two further strings were false rather than merely awkward: the launch page
> header read "Mainnet · Ethereum" while sitting on a devnet, and
> `CHAIN_POSITIONING` fell through to **"Settled on Foundry."** — the landing
> page's most prominent line claiming a local devnet as the settlement chain.
>
> Reviewing copy on the chain you happen to be running cannot find any of this,
> because the wrong strings only appear on chains you are not running.
> `scripts/checkChainCopy.mjs` therefore evaluates every user-visible chain
> string on all four supported chain ids in a fresh process each, and fails on a
> mainnet build that calls itself provisional or names the settlement chain
> twice. Reintroducing the original bug makes it red.
>
> **PM-F5 now needs credentials, not code.** The limiter's counters moved out of
> `apiGuard.ts` into `src/app/lib/rateLimitStore.ts`, which selects a shared
> Redis backend when `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` are
> both present and falls back to per-process memory when they are not. **Setting
> those two variables in the production environment is what closes this item** —
> until then production runs the in-memory path, where N instances multiply every
> quota by N and a rolling deploy resets them. On a serverless platform that
> scales per request that is close to no rate limit at all.
>
> Verify after deploy rather than assuming: a 429 carries
> `X-RateLimit-Backend: degraded-memory` whenever the shared store was
> configured but unreachable, and omits the header when the shared counter
> answered. All three states (unconfigured, shared, shared-but-down) can be
> rehearsed locally against `soat-frontend/scripts/mockRateLimitStore.mjs`,
> which documents the exact commands.
>
> **Closed 2026-09-03.** Upstash on AWS `us-east-1` sits beside Vercel `iad1`.
> Both vars are in Vercel Production. A live `GET /api/projects` on
> `tosh-two.vercel.app` returns 200 with no `X-RateLimit-Backend` header —
> the shared counter answered. `npm run check:upstash` still exercises the
> same `/pipeline` REST call `rateLimitStore.ts` makes (INCR + PEXPIRE) and
> is the reachability check, not the production proof. The laptop copy of
> the token is PM-D3, not this row.
>
> Read that script's latency figure with its origin in mind. It measures from
> wherever it runs, and only the deployment region is on the hot path — a high
> number from a developer machine on the other side of an ocean is what correct
> provisioning looks like, and "fixing" it by moving the database closer to the
> laptop would put that ocean in front of every production request instead. The
> script said "slow" on its first run for exactly this reason and no longer
> grades what it cannot situate.

---

### 6.4 PM-F9 — the allocation nobody is measuring

Added 2026-09-04, from the sweep recorded as §5.10 of the audit dossier. Like
PM-C9 before it, the notable part is not the defect but that the row did not
exist: an irreversible, user-visible property of launch day, with no line in
this file to be answered on.

`scanGasHistoryForWallet` in `soat-frontend/src/app/api/sign-allocation/route.ts`
is two statements:

```ts
async function scanGasHistoryForWallet(userAddress: Address): Promise<ChainGasData[]> {
  void userAddress
  return MOCK_CHAIN_GAS
}
```

`MOCK_CHAIN_GAS` is a fixed four-row table summing to 0.033 ETH. Through
`computeMaxAllocWei` at the seeded rate of 0.1 that is `min(0.0033, 0.1)` =
**0.0033 ETH**, which is 3.30 % of the `MAX_ALLOC_ETH_WEI` ceiling — the ceiling
is only reached if the rotatable rate is raised past 3.0303. So every address
that clears the gates receives the same attestation for the same amount, and the
address it was issued for is discarded before it is used. This is deliberate,
labelled at the call site as the seam a real indexer drops into, and correct as
a stub.

The finding is the uniformity, not the size. A flat 0.0033 ETH is not a
give-away; it is that nothing distinguishes one claimant from another, so the
only thing rationing genesis supply is how many addresses show up.

**What makes it a checklist item rather than a TODO** is that other documents
have already spent it. §2.1 of the audit dossier describes the PoG signer as
attesting to a wallet's multi-chain gas history; with the mock in place there is
no history being attested, and the trust model claims a bound the code does not
supply. Anything user-facing that describes genesis allocation as earned by past
gas spend is in the same position.

Two ways to close it, and they are genuinely different products:

- **Wire a live indexer** behind the seam. Everything downstream — rate fetch,
  `computeMaxAllocWei`, nonce sync, digest framing — is already built and stays
  untouched, so the work is the data source and its failure modes, not the
  pipeline.
- **Ship the flat allocation on purpose**, and say so: every eligible address
  gets the same 0.0033 ETH, first come until the global limit is reached. Then
  §2.3 and the launch copy have to be rewritten to match, and headcount becomes
  the only thing rationing supply — which makes Sybil resistance the whole
  design, since the marginal cost of a second claim is one fresh address.

Either is defensible. Shipping the mock while the docs describe the first option
is not, and that is the state this row exists to prevent.

#### Closed 2026-09-05 — the first option, with a band

`soat-frontend/src/app/lib/gasHistory.ts` scans five chains and sums the fees an
address actually paid. Blockscout is the source on all five, which was not a
preference: Etherscan V2's single key covers 60-odd chains but excludes Optimism
and Base on the free tier and does not index Robinhood Chain at any tier, so no
amount of money buys the chain the token launches on. Paying for data was
therefore never the question it looked like.

What the scan counts, and what it does not:

| Chain | Endpoint | Fee figure |
|---|---|---|
| Ethereum, Arbitrum | v1 `txlist` | `gasUsed × gasPrice`, which is the whole fee |
| Optimism, Base | v1 `txlist` | L2 execution only — **the L1 data fee is not counted** |
| Robinhood 4663 | v2 `addresses/{a}/transactions` | `fee.value`, L1 component included |

The OP-stack omission understates heavy senders on two of five chains. It is the
safe direction (nobody is over-credited) and it is bounded by the cap below, so
it is recorded rather than fixed. Two other things are deliberate: only outbound
transactions count, because Blockscout's aggregate `gas_usage_count` also sums
gas from transactions an address merely *received* and so measures popularity
rather than spend; and the Robinhood instance sits behind Cloudflare, which
answers Node's default `fetch` with a 403 challenge and a browser `User-Agent`
without one. That last is a fragile dependency on someone else's bot policy, and
if it changes the scan fails closed on that chain.

**And it has no RPC fallback, though `gasHistory.ts` claimed one.** Counting the
chain from the RPC we already run for the watcher sounds like the obvious escape
until the chain is measured: Robinhood is an Arbitrum Nitro rollup with a
**0.20 s block time**, which put it at **54.8 M blocks 127 days after launch**.
JSON-RPC has no `eth_getTransactionsByAddress` — maintaining that index is what an
explorer is *for* — so finding one wallet's sends means walking every block: about
**548,000 batched requests, for one wallet, on one chain**. `trace_filter` and
`arbtrace_filter` are both absent from that node, so there is no shortcut, and
`eth_getLogs` cannot substitute because a plain ETH send emits no logs. The
comment is corrected; a fallback that does not work is worse than an admitted gap.
The real one is the keyed PRO API, which reaches 4663 by `chain_id` and never
touches this host.

The band you asked for is `pogQuota.ts`:

- **Floor `POG_GAS_FLOOR_WEI` = 0.05 ETH.** Below it, `computeMaxAllocFromWei`
  returns zero — no allocation at all. This is the Sybil answer the flat mock did
  not have: a fresh address costs nothing to make but 0.05 ETH of real historical
  fees to make *eligible*, and that cost cannot be faked after the fact.
- **Cap `POG_GAS_CAP_WEI` = 1 ETH.** History past it stops counting, so one very
  old whale cannot take an outsized share.

Cap, `MAX_ALLOC_ETH_WEI` and the on-chain `ToshFactory.maxPogAllocationLimit` are
one decision written in three places, and `assertPogBandCoherent()` throws at
boot if they stop agreeing — which is what keeps this from becoming another §2.5.

**What bounds the cost.** A scan reads five hosts that charge nothing and owe us
nothing, and it fails closed, so an IP ban is a denial of service on genesis
allocation that we would be delivering to ourselves. Wallet auth does not help:
keypairs are free, so each fresh address is a fresh cache key and a real
five-chain read, and a proxy pool multiplies the per-IP bucket. So `/api/pog-scan`
runs the scan as a job behind four gates — a 1-hour result cache, an in-flight
join, a **global hourly ceiling**, and **6/hour per address** — with the last two
charged only when a scan will really run, so that polling and cache hits are
free. Ten tests, nine mutations, all caught.

That global ceiling was first set to 240/hour, reasoned from what five hosts
"ought to absorb". Then the hosts were asked, and the answer is in the next
section: it is now 10/hour unkeyed and 40/hour with a key, because 240 was
never the binding constraint.

One residual trap was removed rather than documented: `totalGasEth()` still
defaulted its argument to `MOCK_CHAIN_GAS`, so a caller who forgot to pass a scan
result silently got the fixture. The default is gone and omitting the argument is
now a compile error.

**The half that was nearly missed.** Moving the scan out of `sign-allocation`
gave that route a new precondition — 409 until a finished scan is on file — and
`PogScanButton.tsx` was still calling it directly. The backend was complete and
live-verified while the only button that reaches it would have failed on every
click, which is worse than the mock it replaced: the mock at least worked. The
button now runs the scan first, polls on a budget derived from the server's own
120 s lease rather than a guessed number, names which of the two waits the user
is in, and reports an under-floor wallet with the figure it missed by instead of
letting a bare 409 stand in for it.

Not yet done: nobody has clicked it against a live deployment. `tsc`, `eslint`,
the unit suite and `next build` all pass, and the scan underneath is verified
against real hosts, but the assembled flow has not been exercised in a browser.
That belongs with PM-C7, when the frontend is pointed at 4663.

#### Reopened the same day — the free tier is ten wallets an hour

Everything above was sized against a guess about what the public Blockscout
instances tolerate. They were then measured, by walking each host up to its limit
until it refused:

| Host | `x-ratelimit-limit` | Window | Effective | Behaviour at the limit |
|---|---:|---|---|---|
| Ethereum, Optimism | 180 | ~60 s | 3 req/s | fine for our volumes |
| **Arbitrum, Base** | **10** | **~40 min** | **~10 req/hour** | `429` on the tenth, twice, reproducibly |

The 429 body is `{"message":"Too many requests. Increase limits now at
https://dev.blockscout.com"}`. A scan needs at least one request per chain and
**every** chain must succeed for a total to be a total — an unreachable chain
reads as a smaller wallet, and that difference is an allocation. So those ten
requests, not anything in this repository, are the ceiling on the whole product.

How many wallets ten requests buys depends on the wallet, and not in the
direction one would guess:

| Wallet | Cost on Arbitrum | Wallets per window |
|---|---:|---:|
| Few transactions | 1 (the v2 probe answers in one page) | ~10 |
| Long history, under the cap | up to 5 (probe + four v1 windows) | ~2 |
| Whale | **0** | unlimited |

The whale row is not a mistake. `GAS_SCAN_CHAINS` puts Ethereum first precisely
because fees there dominate, so a wallet that reaches the 1 ETH cap on Ethereum
alone never issues a request to Arbitrum or Base at all — the early exit that
exists to save time also spares the tightest hosts. The expensive case is the
middle: a wallet with tens of thousands of cheap transactions and no single chain
large enough to end the scan.

Call it **ten wallets an hour** as a planning figure, understanding that a run of
busy-but-not-rich wallets can make it two.

That is not a launch-day capacity, and no constant here can make it one. Three
consequences, all now recorded in code:

1. **The 240/hour ceiling was fiction.** Fixed twice: first to 10 unkeyed and 40
   keyed, then — after the migration below — to a flat 120/hour, because request
   count stopped being the scarce thing.
2. **The retry loop was making it worse.** A 429 was retried on a 400/800/1200 ms
   backoff against a window that refills in forty minutes — three more requests
   from a budget with none left, aimed at a host that had just asked us to stop.
   It now reads `x-ratelimit-reset` and only retries a window about to turn over.
   Seven mutations, all caught, including both directions of that threshold.
3. **The real fix was not a constant, it was moving off those hosts.** See below.

#### 6.4.1 Migrated to the keyed PRO API — 2026-09-05

A key was obtained and the migration done. Everything below is measured against
it, not quoted from the pricing page.

**The URL shape was guessed wrong twice before a key existed**, so it is worth
stating plainly: the chain id is the **first path segment**.

```
v1   https://api.blockscout.com/{chainId}/api?module=account&action=txlist&…
v2   https://api.blockscout.com/{chainId}/api/v2/addresses/{a}/transactions?…
```

It is *not* the `chain_id` query parameter the docs describe, and not
`/v2/{chainId}/…`; both 404. `gasHistory.test.ts` asserts the shape so a tidy-up
toward the documented form cannot quietly break all five chains.

**What the migration bought, all verified on all five chains:**

| | Before (five public instances) | After (one keyed host) |
|---|---|---|
| Arbitrum / Base limit | 10 requests per ~40 min | 5 req/s |
| 429 reset window | ~2,370,000 ms | **306 ms** — retrying is sane again |
| Robinhood access | Cloudflare challenge, needed a spoofed browser `User-Agent` | no override needed; **workaround deleted** |
| Robinhood dialect | pinned to v2, 20-page budget (v1 timed out) | same probe-first path as the rest |
| Missing key | silent low limits | `402`, so it fails loudly |

Robinhood joining the normal path rests on a measurement: `gasUsed * gasPrice`
there equals v2's authoritative `fee.value` **to the wei** over 50 transactions,
because Nitro bills L1 cost through an inflated `gasUsed` rather than a separate
field. Re-measured per chain the same way:

| Chain | v1 under-counts v2 by | Worst single tx |
|---|---:|---:|
| Ethereum | 0.0000 % | 0.00 % |
| Arbitrum | 0.0000 % | 0.00 % |
| Optimism | 2.3000 % | 49.09 % |
| Base | 0.0200 % | 0.02 % |
| Robinhood | 0.0000 % | 0.00 % |

So only Optimism and Base under-count, and only for senders heavy enough to fall
past the one-page v2 probe.

**Capacity, and the tier we are actually on.** The key reports
`x-ratelimit-limit: 5` and ~100,000 `x-credits-remaining`, which is the **free**
tier, not the $49 Builder tier decided earlier:

| | Measured |
|---|---|
| Rate | 5 req/s (Builder is 15) |
| Credits | 100,000/day (Builder is 100M/month) |
| v2 page | ~16.7 credits |
| v1 page | ~15 credits — and `offset=10000` costs the same 20 as `offset=10` |
| Capacity | ~5,000 calls/day ⇒ **~1,000 light or ~200 heavy wallets/day** |

Page size being free is why `V1_PAGE_SIZE` is maxed. **Decided 2026-09-05: stay
on the free tier for now, upgrade to Builder at mainnet.** ~1,000 wallets/day is
enough to open with, and the gauge below degrades gracefully rather than going
dark.

**Credits per day, not requests per second, is now the binding constraint**, and a
request-count ceiling cannot bound it because one scan costs between 5 calls and
25 depending on whose wallet it is. So `/api/pog-scan` reads `x-credits-remaining`
off every response, stores it, and refuses new scans below a 2,000-credit reserve
— sized to let scans already in flight finish, since a scan killed halfway spends
the credits and produces nothing. The gauge expires after an hour of quiet,
deliberately: a reading is only ever a floor, and without expiry yesterday's
exhausted value would refuse every claimant against a budget that had just reset.
An unknown balance admits; zero refuses; the two are never conflated.

`npm run check:blockscout` was rewritten around the verified URLs and now requires
**both** dialects on **all five** chains, because v2 is the probe every chain
starts with and v1 is the only way a heavy sender's history gets read at all —
neither is a fallback for the other, and "either one works" would pass a key that
silently breaks half the traffic.

#### 6.4.2 4663's indexer is not reliable, and it used to gate every claim

Measured the same afternoon, and the reason the failure policy changed. Within
half an hour of a clean run, the Robinhood leg went from 200 to this:

| Endpoint | Availability |
|---|---|
| PRO API, 4663, v2 | 1/12 |
| PRO API, 4663, v1 | 2/12 |
| PRO API, chain 1, v2 (same key) | **12/12** |
| 4663's own instance, v2, browser UA | 0/8 (502) |
| 4663's own instance, v2, no UA | 0/8 (403 — the Cloudflare challenge, still there) |

Both access paths down at once places the fault in **Robinhood Chain's own
indexer**, not in either route to it, so there is nothing to fail over to. Under
the old rule — any unreadable chain fails the whole scan — roughly nine in ten
genesis allocations would have failed, on a chain contributing a rounding error.

That exposed an inconsistency in the failure rules: a history longer than the
request budget was allowed to yield a flagged lower bound, while an unreadable
chain was fatal, though both are the same error. The difference that matters is
how much each can hide, and it is not uniform:

- an unreadable **Ethereum** can hide 24 ETH (the heaviest wallet tested spent
  that there alone);
- an unreadable **Robinhood** hides almost nothing — a busy 4663 account's fifty
  latest transactions cost **0.00403 ETH** total, which is 8 % of the 0.05 ETH
  eligibility floor and 0.4 % of the 1 ETH cap.

**Decided: the four majors stay fatal, Robinhood degrades to a flagged lower
bound.** It sets `truncated`, so nothing downstream can present the total as
complete, and the API names the unread chain so the UI says "Robinhood could not
be read; retrying later may change this" instead of a vague "may be incomplete" —
which is different advice, and it matters most in the one case where the
under-count costs the user something: being told they are below the floor.

Safe adversarially, which is the part worth checking: someone who could make 4663
look unreadable would only reduce their own total. There is no version of this
that awards more. Nine mutations on the policy, all caught, including flipping any
major chain to optional and reporting an unreadable chain as cap-skipped.

**PM-F9 is now ✅ on correctness and capacity.** What remains is not this row: the
assembled flow has still never been clicked on a real deployment, which is carried
with PM-C7, and the Builder upgrade is carried to mainnet.

---

## 7. Legacy number crosswalk

For anyone who arrives here from a code comment:

| In code | Read as | Section |
|---|---|---|
| `Pre-mainnet item #6` | **PM-F1** | §6 |
| item `#10` | **PM-F6** | §6 |
| `item #23 on the pre-mainnet checklist` | **PM-C6** | §3 |
| `Pre-mainnet item #24` | **PM-F2** | §6 |
| `pre-mainnet item #26` / `(#26)` | **PM-E1** (frontend) + **PM-E2** (on-chain) | §5 |

`#26` maps to two items on purpose: it was written as one line of work, and only
half of it is built. Collapsing that back to a single checkbox is how it would
get marked done while the on-chain alerting still does not exist.

---

## 8. Current state at a glance

Recounted 2026-09-04 against the rows above, not against memory — and now
recounted by `scripts/checkChecklistCounts.mjs` in CI rather than by hand,
because the previous version of this table drifted within hours of being
written by hand. See the note under the table.

| Gate | Open | Partial | Gated | N/A | Done |
|---|---:|---:|---:|---:|---:|
| A — Security review | 0 | 0 | 0 | 3 | 2 |
| B — Chain decisions | 0 | 0 | 0 | 0 | 4 |
| C — Deploy & handoff | 3 | 0 | 0 | 0 | 6 |
| D — Keys & secrets | 0 | 0 | 0 | 1 | 3 |
| E — Observability & ops | 0 | 1 | 0 | 0 | 5 |
| F — Frontend & platform | 0 | 0 | 0 | 0 | 9 |
| **Total** | **3** | **1** | **0** | **4** | **29** |

The **N/A** column holds four rows: PM-D2, and PM-A1 through PM-A3 as of
2026-09-06. It was added for D2 alone, because the table had no column for a
retired item, so closing D2 as not-applicable left it counted under *Open* — the
table said thirteen open items when twelve were open and one no longer existed.
Three days later it absorbed the entire audit gate, which is a good argument for
having built it: the decision in `SECURITY_AUDIT.md` §0 moved three items out of
*Open* at once, and without this column that would have read as three items
quietly completed. **N/A is not Done.** A1–A3 are counted here precisely so the
27 in the Done column cannot be read as covering them. That is the smallest possible version of
the failure this document keeps finding elsewhere: a summary maintained
separately from the thing it summarises, agreeing with it only for as long as
someone remembers both. The counts are now derived from the gate tables by
`node scripts/checkChecklistCounts.mjs`, which also compares the status glyph
in **Still open** against the gate row it repeats and fails if a row that is
not ✅ is missing from that list. Eight mutations, all caught. This table can
no longer disagree with the rows without CI saying so.

**Gates B and F are both closed.** F closed on 2026-09-05 with PM-F9, which is
worth recording as a sequence because none of it was visible when the row was
written: the 2026-09-04 sweep added the row at all — the genesis allocation was
computed from a constant table and nothing in this file had ever asked about it —
2026-09-05 replaced the table with a real five-chain scan, then measuring the free
public instances showed they served about ten wallets an hour, then a key was
obtained and the scan migrated onto the PRO API, and then 4663's indexer failed
mid-verification and forced the failure policy to become per-chain (§6.4.1,
§6.4.2). Each step was only findable by measuring the one before it.

The accounts-and-credentials group that was blocking F and half of E is done:
Upstash, Supabase (with `chain_id`), Sentry (both ingest routes and a real
source-map upload), and the Vercel project serving `tosh-two.vercel.app`. The 46630 rehearsal (RH-F1) and the on-chain
half of the first incident drill are dated. What is still open is listed
below, in the order it actually blocks.

**Still open**

| ID | Status | Why it is still open |
|---|---|---|
| **PM-A1, A2, A3** | ⬜ | Retired 2026-09-06: no third-party audit, permanently. Listed here because **N/A is not Done** — nothing further will happen on these rows, and `SECURITY_AUDIT.md` §0.1 states what that leaves uncovered. A4 no longer waits on A1 and has closed. |
| **PM-C3** | ❌ | No longer gated: C2 closed and the PoG signer was rotated 2026-09-09. Open only because the factory address has still not been announced. |
| **PM-C4** | ❌ | Explorer verification of the *mainnet* deploy at `0xBa9d2E86…` / `0x99aD248d…`. Testnet 46630 is already verified. |
| **PM-C8** | ❌ | Mainnet ladder listing, after TWAP maturity, polled not computed. Rehearsed on 46630. No longer gated — the PoG rotation landed 2026-09-09. Nothing listed yet. |
| **PM-D2** | ⬜ | Not applicable. The PoG signer never sends a transaction, so there is no gas to pre-fund (`ONCHAIN_MONITORING.md` §4.1). |
| **PM-E2** | 🟡 | Re-pointed at 4663. First mainnet pass was blind (RPC 429, non-paging WATCHER-02; workflow run 34196807435). Transport and paging fixed (§5.28). Remaining is a pager rather than GitHub Issues. |

> **One item outlived the row it was written on.** PM-C7 closed on 2026-09-09
> and carried a caveat inherited from PM-F9: the two-phase PoG flow is unit- and
> live-tested, but **no human has clicked it through on this deployment**. It is
> kept here rather than deleted with the row, and deliberately without an ID, so
> that `checkChecklistCounts.mjs` does not count it as a gate item — it is not
> one, and inventing `PM-C10` for it would misrepresent a manual walkthrough as
> a gate. Do it once the PoG rotation lands, since the rotation changes the key
> that flow signs with and a walkthrough before it would test the wrong key.

**The shape of the remaining work:** almost none of it is writing application
code. Gate A used to be a procurement and calendar problem and is now neither —
it was retired rather than solved (§1), which removes the last item on this list
that money could have bought. Gate C's broadcast has landed and the ownership
handoff with it (C2 — the single-key window is closed). What remains there
is verification, the announcement (gated on PoG signer rotation — §5.32), the frontend
cutover (the status-page half of C7 is done; the `soat-frontend` /
`.env.production` half is not), and the first ladder listing (also gated
on that rotation). Gate D's remaining row is PM-D1: the live PoG signing
key reached PowerShell history in plaintext and was not rotated
(`SECURITY_AUDIT.md` §5.32). The laptop copies of the Supabase and
Upstash credentials that §5.31 found are rotated and deleted;
`check:secrets` is 27/27 green. That is not a clean custody surface.
Gate E has no red row left — E4 and E6 closed 2026-09-08 as a
policy naming, not as a 03:00 page-out. E2's `MONITOR_*` re-point at 4663 has
landed; its first mainnet pass was blind and is recorded in §5.28. What keeps
E2 at 🟡 is the pager, not the chain.

That leaves a list on which **every single remaining item is procedural or
operational**, and not one of them is a second opinion on the contracts. Worth
noticing before reading the count as reassuring: 4 open and 2 partial is a
smaller number than it was, produced by C1 landing, by C2 closing the
single-key window, by C6 committing the mainnet hashes, and by C9 closing with C1 —
the PoG signer address was `REPLACE_ME` in this file and is `0x0E496Bd5…` in
`.env.production` and on chain.

What is left that is purely engineering:

- **PM-E2, delivery half** — the host and the sink exist and were driven end
  to end on testnet (`ONCHAIN_MONITORING.md` §7.3). The re-point at 4663
  happened. The first mainnet pass was blind: run 34196807435 reported
  0 logs in a window that held seven P0 governance events, because the
  public RPC rate-limits a tight `eth_getLogs` loop and WATCHER-02 did
  not page (`SECURITY_AUDIT.md` §5.28). That is fixed. What is still
  open is not code: a P0 still lands in an issue rather than on a phone.
  §1 now names Encrypted Signal / Telegram for the signers, but the
  watcher does not drive it.
- ~~The public status page~~ — **done**, at
  <https://jayoo101.github.io/tosh-status/> (repo `jayoo101/tosh-status`). It
  is worth recording that the sentence above this list — "Gate E's two red rows
  are a roster" — was wrong: E5's status page was engineering, unblocked, and
  sitting inside a 🟡 row where the summary table's colour hid it. Reading the
  blockers off the red rows alone missed it.

  Hosted on GitHub Pages rather than Vercel, because a status page sharing a
  deploy pipeline with the application is useless in the §0 P0 case that names
  a malicious frontend bundle. It reads `paused()` off the chain in the
  browser, so the fact that matters is not hostage to a human remembering to
  edit it, and it names the chain as the authority when the two disagree.

  Living in another repository buys that availability and costs coupling:
  nothing here can see the page change. `scripts/checkStatusPage.mjs` closes
  that in CI — it fetches the deployed page and fails if the paused wording no
  longer matches Step 4 verbatim, if the page stops calling `paused()`, or if
  the guide §6b hands to users stops resolving. Five mutations, all caught.
  As of this sitting the page in `jayoo101/tosh-status` names the 4663
  factory. `checkStatusPage.mjs` is green against that local file and stays
  red against the live page until that repository is pushed — expected, not
  a reason to weaken the guard. The remaining half of PM-C7 is the
  frontend.

  One of them caught a hole in the guard itself: the chain-read check
  originally asked whether the page *contained* the `paused()` selector, and a
  mutation repointing the call at `0xdeadbeef` passed, because the selector was
  still sitting in the comment one line above. Presence is not use, and a check
  a comment can satisfy is reading the documentation rather than the behaviour.
  It now matches the selector in the `data:` position of the call.
- ~~Publishing `MANUAL_INTERACTION.md`~~ — **done**, and it was a real bug
  rather than a tidying job. `INCIDENT_RESPONSE.md` §6b tells the status page
  to link that guide during a frontend outage, but it lived in this private
  repository, so the link returned 404 to exactly the users the step exists to
  help. It now lives in the public status-page repository as the only copy —
  <https://github.com/jayoo101/tosh-status/blob/main/MANUAL_INTERACTION.md> —
  with no second copy to drift.

  Moving it surfaced two errors inside it. It sent readers to
  `soat-frontend/src/app/lib/factoryDeployments.ts` for the factory address,
  which **does not exist** — the same dead pointer §8.1 had already found and
  corrected in `INCIDENT_RESPONSE.md`, still live in the user-facing file
  because that fix was applied by hand to one document. And it called the
  factory the `to` of every `LaunchCreated`, when the factory is the log's
  emitter; those coincide only for a direct `createLaunch` and diverge the
  moment the call is routed. Both are rewritten to two sources a user can
  actually reach, with instructions to distrust the address if they disagree.
- ~~Fork tests against a live V4 deployment~~ — **done**.
  `test/ToshV5Fork.t.sol` runs the launch lifecycle and a UniversalRouter buy
  against the V4 singleton deployed on Robinhood Chain (`SECURITY_AUDIT.md`
  §4.2). It also checks the five §2.2 cutover addresses against the chain itself,
  which is the one source that cannot be out of date, and pins the router's
  calldata layout. Verified 8/8 green by hand.

  It is now also 8/8 green **in CI**, not by hand: the `ROBINHOOD_RPC`
  repository secret exists on `jayoo101/Tosh-Core` and the fork step reported
  `8 passed; 0 failed; 0 skipped` against the live singleton on chain 4663 at
  `3c82f73`. Zero skipped is the number that matters — see the next paragraph.

  **The step no longer passes quietly without it.** An earlier version of this
  paragraph warned that a green CI run did not mean the fork tests ran, which was
  true when the step tolerated a missing secret everywhere. `test.yml` now
  distinguishes: a fork of this repository, or a PR raised from one, gets a
  `::notice` and an early exit, because secrets are not exposed there and a
  permanently red check on someone else's fork is worth less than no check. On
  the canonical repository a missing secret is `::error` and `exit 1`. The step
  also fails if the suite ran but nothing passed — which is what an unreachable
  endpoint looks like, since `setUp()` then never forks — and fails on a PARTIAL
  skip, so no subset of `_requireFork` can go quiet.

  So the honest reading was: on the canonical repository this step is **red
  until the secret is added**, and cannot be made green by anything other than a
  real run. That has now happened — the repository exists, the secret is set to
  Robinhood's public mainnet endpoint (verified `eth_chainId` = `0x1237` and the
  singleton carrying 24 KB of code before it was stored), and the step is green
  on its own terms rather than on a tolerated skip.

  To run locally:

  ```
  ROBINHOOD_RPC=https://rpc.mainnet.chain.robinhood.com \
    forge test --match-contract ToshV5ForkTest -vv

  # the production swap path, with the full call trace
  ROBINHOOD_RPC=... forge test --match-test test_fork_buyThroughRealUniversalRouter -vvvv
  ```

  On PowerShell, set it as `$env:ROBINHOOD_RPC="..."` on its own line first.

  **This suite is unpinned**, unlike the Ethereum one it replaced (which sat at
  block 25,800,000). Robinhood's public endpoint retains state for under
  seventeen minutes at 100 ms blocks, so a `FORK_BLOCK` constant would be stale
  before review. The trade is reproducibility: a failure here describes the chain
  as it was that morning. `docs/ROBINHOOD_MIGRATION.md` §5.3 has the measurement
  and the one-line path back if an archive endpoint is ever provisioned.

Everything else needs a decision or a credential, not a commit.

---

## 9. Related documents

| Document | Authority over |
|---|---|
| `docs/SECURITY_AUDIT.md` | Audit scope, trust model, test coverage, findings. **Authoritative for Gate A.** |
| `docs/ONCHAIN_MONITORING.md` | The PM-E2 spec: what to alert on, why, and the two ways a naive setup silently covers nothing. Config in `monitoring/alerts.json`. |
| `docs/INCIDENT_RESPONSE.md` | What to do when something is already wrong. Authoritative for the on-call roster and drills. |
| `jayoo101/tosh-status` → `MANUAL_INTERACTION.md` | Driving the protocol with `cast` when the frontend is unavailable. **Public, and not in this repository** — §6b links it to users mid-outage, so it has to be readable by someone who cannot read this. |
| `docs/SIGNER_BRIEF.md` | The PM-D4 recruiting document, written to be handed to a candidate unedited: the whole obligation, the fifteen functions the key can call, the absence of any withdrawal path, and the one power worth being suspicious of. |
| `docs/PRD-v5.0.md` | Product spec; §11 holds the D1–D4 accepted risks and their review triggers. |
| `script/DeployMainnet.s.sol` | The executable form of Gate C. Its `CRITICAL NEXT STEPS` output and §3 here must not diverge. |
