# Tosh Protocol — pre-mainnet checklist

**Version:** v5.0
**Status:** the canonical list. If this file disagrees with anyone's memory, or
with a `console2.log` in a deploy script, this file wins.
**Last updated:** 2026-08-26

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

## 1. Gate A — Audit (blocks everything else)

Nothing in §2 onward should be started while §1 is open: a remediation round
can change deployed bytecode, which invalidates every address, initcode hash
and verification artifact downstream.

| ID | Item | Evidence of done | Status |
|---|---|---|---|
| **PM-A1** | Third-party audit engaged, scope frozen, commit hash recorded | `docs/SECURITY_AUDIT.md` §0 board filled; branch frozen | ❌ |
| **PM-A2** | All Critical / High findings resolved | Remediation log in `SECURITY_AUDIT.md` §6 | ❌ |
| **PM-A3** | Remediation re-review passed | Auditor sign-off in §7 of that doc | ❌ |
| **PM-A4** | Pre-audit hygiene list complete | `SECURITY_AUDIT.md` §5 all boxes ticked | 🟡 9/11, all re-verified 2026-08-27. The two open ones are not engineering: `forge lint` triage is auditor work by design (§2.5 hands it over), and the branch freeze is PM-A1 |
| **PM-A5** | Slither run and output triaged into the dossier | **`SECURITY_AUDIT.md` §5.7**, not §6 — see note | ✅ 70 findings (1H/24M/26L/19I), each dispositioned. Re-run 2026-08-27 after the `PIGGYBACK_MIN_GAS` change: counts unchanged |

> `SECURITY_AUDIT.md` §0 is the authority for A1–A3. Do not duplicate its state
> here; check these boxes only when that table is green.
>
> **PM-A5's evidence column used to point at §6, and §6 is the wrong place.**
> That section is reserved for the auditor's own findings, under the auditor's
> own IDs. Static analysis lives in §5.7 with the rest of the pre-audit hygiene,
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
> `POOL_MANAGER` invalidates every mined salt and the whole of `hookBytecode.ts`,
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

| ID | Item | Evidence of done | Status |
|---|---|---|---|
| **PM-C1** | `DeployMainnet.s.sol` run against the production RPC | `broadcast/4663/` exists | ❌ — rehearsal on `46630` is RH-F1 and comes first |
| **PM-C2** | Gnosis Safe has called `acceptOwnership()` on **both** factory and ladder treasury | `VerifyDeployment.s.sol` passes with `EXPECTED_OWNER=<safe>` | ❌ |
| **PM-C3** | **Factory address not announced publicly until PM-C2 is done** | — | ⏸ gated |
| **PM-C4** | Contracts verified on the block explorer | Public verified source at the deployed address | ❌ |
| **PM-C5** | `forge build --sizes` — every contract under the 24 KB EIP-170 limit | Build output | ✅ see §3.1 |
| **PM-C6** *(legacy `#23`)* | Hook initcode hash regenerated against the **mainnet** build | `RecomputeInitcodeHash.s.sol` output committed; `extractBytecode.js` / `extractAbis.js` produce no diff | ❌ |
| **PM-C7** | `.env.production` filled: `NEXT_PUBLIC_FACTORY_ADDRESS`, `NEXT_PUBLIC_CHAIN_ID` | Deployed frontend reads the right factory | ❌ |
| **PM-C8** | Ladder buyback targets curated (`treasury.addLadderToken`) — **no token listed until its TWAP has matured**, see §3.2 | On-chain state; `STATE-07` green | ❌ |

> **PM-C2 is the one people skip.** `script/DeployMainnet.s.sol:134` says it in
> its own output: until the Safe accepts, the deployer EOA still owns the
> factory. A launchpad announced in that state has a single private key standing
> between users and every kill switch.
>
> **PM-C6 is the one that fails silently.** v5.0 changed both the hook
> constructor tuple and the salt mask (now `0x20CC`). A stale
> `hookBytecode.ts` does not error — the frontend's salt miner simply mines
> addresses that are never valid, and every launch attempt fails for reasons
> that look like a wallet problem. CI enforces the no-diff check
> (`.github/workflows/test.yml`), which catches drift but not "never regenerated
> against mainnet".

### 3.1 PM-C5 — measured sizes

`forge build --sizes`, default profile (`via_ir = true`, `optimizer_runs = 200`).
There is no separate mainnet compile profile in `foundry.toml`, so this *is* the
production build and the earlier "unverified for the mainnet profile" caveat was
describing a profile that does not exist.

| Contract | Runtime (B) | Margin to EIP-170 (B) |
|---|---:|---:|
| `HookDeployLib` | 21,378 | 3,198 |
| `ToshLaunchpadHook` | 20,372 | 4,204 |
| `ToshFactory` | 10,640 | 13,936 |
| `ToshLadderTreasury` | 6,035 | 18,541 |
| `ToshToken` | 4,203 | 20,373 |
| `ToshCloneLib` | 57 | 24,519 |

All under the 24,576-byte limit. `HookDeployLib` is the tightest at 3,198 bytes
of headroom, which is worth knowing before anyone adds a feature to the deploy
path.

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
| **PM-D1** | PoG signer key moved off a plaintext env var into KMS/HSM | `sign-allocation/route.ts` reads from the KMS client, not `POG_SIGNER_PRIVATE_KEY` | ❌ |
| **PM-D2** | PoG signer wallet pre-funded (~0.05 ETH) for signature gas | Balance check | ❌ |
| **PM-D3** | `SENTRY_AUTH_TOKEN`, Supabase service keys held only in the CI secret store | No secret in any committed `.env*` | 🟡 |
| **PM-D4** | Gnosis Safe threshold and signer set confirmed, signers reachable | `INCIDENT_RESPONSE.md` §1 filled | ❌ |

> **PM-D1 is the highest-severity open item that is not the audit.** The key
> cannot move funds, but it mints deposit quota: whoever holds it can sign
> themselves the maximum allocation on unlimited wallets. The bound on the
> damage is `maxPogAllocationLimit` and the per-hook `perWalletCap`, not the
> signature itself — see `INCIDENT_RESPONSE.md` §4 for the cap table and the
> rotation playbook.

---

## 5. Gate E — Observability and operations

| ID | Item | Evidence of done | Status |
|---|---|---|---|
| **PM-E1** *(legacy `#26`, frontend half)* | Frontend error monitoring wired | `@sentry/nextjs` installed; `instrumentation*.ts`, `observability.ts`, error boundaries and API routes report | ✅ |
| **PM-E2** *(legacy `#26`, on-chain half)* | **On-chain alerting on contract events and state** | Spec + config-as-code: `docs/ONCHAIN_MONITORING.md`, `monitoring/alerts.json` (25 alerts, 7 state checks), CI-guarded by `scripts/verifyAlertTopics.js`. **Remaining: import into a provider and test delivery** — §8 of that doc is the done-list. | 🟡 specified, not live |
| **PM-E3** | Sentry DSNs populated for production | `NEXT_PUBLIC_SENTRY_DSN` set; a test event lands in the right project | ❌ |
| **PM-E4** | On-call roster placeholders replaced | `INCIDENT_RESPONSE.md` §1 has real handles | ❌ |
| **PM-E5** | First incident drill run and dated | `INCIDENT_RESPONSE.md` §8 drill log | ❌ |
| **PM-E6** | D1–D4 accepted-risk review triggers have an owner watching them | Named owner per trigger (`PRD-v5.0.md` §11) | ❌ |

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

---

## 6. Gate F — Frontend and platform

| ID | Item | Evidence of done | Status |
|---|---|---|---|
| **PM-F1** *(legacy `#6`)* | API route hardening: CORS allow-list, rate limit, body cap | `apiGuard.ts` primitives adopted by every route under `src/app/api/**` | ✅ |
| **PM-F2** *(legacy `#24`)* | Multi-RPC fallback rather than one hard-coded endpoint | `providers.tsx` uses `fallback()` over a ranked list | ✅ |
| **PM-F3** | Frontend CI: typecheck, lint, build, token check | `frontend.yml` `verify` job green on `jayoo101/Tosh-Core@3c82f73` — see §6.1 | ✅ |
| **PM-F4** | Dependency advisory gate | `frontend.yml` `audit` job green on the same run — `npm audit --audit-level=high` | ✅ |
| **PM-F5** | Rate limiter survives multi-instance deployment | Shared backend behind the `apiGuard` limiter, or a documented single-instance constraint | 🟡 code done, needs credentials |
| **PM-F6** *(legacy `#10`)* | Testnet strings reviewed for a mainnet audience | `soat-frontend/scripts/checkChainCopy.mjs` green on chains 4663 / 46630 / 31337, wired into `frontend.yml` | ✅ |
| **PM-F7** | Supabase production project provisioned with row-level security | Policies reviewed; anon key cannot write `projects` | 🟡 policies and writer split written and tested — see §6.3; needs a project to run against |
| **PM-F8** | Launch flow shows an estimated gas cost before the creator signs | Launch UI renders an estimate for `createLaunch` | ✅ |

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

This is not a CI problem wearing a disguise. The frontend mines CREATE2 salts
over this creation code, so a factory deployed from one machine rejects every
salt mined against the other with `InvalidHookSalt`: **every launch reverting
for every user**, with both sides compiling and all 336 tests green. Blockscout
verification fails the same way against a clean clone, which is the tree an
auditor builds.

Fixed by removing the dependency rather than by matching the two machines:
`auto_detect_remappings = false` with all eight prefixes listed explicitly in
`foundry.toml`, derived by scanning imports rather than by copying what
auto-detection produced. A `.gitattributes` was added in the same change for
the same reason — `core.autocrlf=true` is the Git for Windows default and
metadata hashes source *bytes*, so a clone on Windows would have changed all
44 source hashes. This tree escaped that only because its files were written
LF by an editor rather than materialised by a checkout.

**Consequence:** the metadata hash is now `3ae40d72…`, replacing two accidental
values (`da4562f8…` local, `bd0f4787…` runner). Testnet 46630 has to be
redeployed — its factory embeds the old creation code, so the frontend can no
longer mine a salt it will accept. The `broadcast/` records below predate this
change.

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

What is left is the account itself: create the project, run the migration,
confirm from the SQL editor that an `anon`-role INSERT is rejected.

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

| Gate | Open | Done |
|---|---:|---:|
| A — Audit | 4 (+1 partial) | 0 |
| B — Chain decisions | 2 | 2 |
| C — Deploy & handoff | 6 (+1 gated) | 1 |
| D — Keys & secrets | 3 (+1 partial) | 0 |
| E — Observability & ops | 4 (+1 partial) | 1 |
| F — Frontend & platform | 1 (+1 partial) | 6 |

**The shape of the remaining work:** almost none of it is writing application
code. Gate A is a procurement and calendar problem, and Gates C and D need
production credentials and a Safe quorum. Gate B is now decided (§2): what is
left there is the cutover edit itself, which is deliberately bundled with the
deploy because it takes staging down.

What is left that is purely engineering:

- **PM-E2, delivery half** — the alert definitions and the drift guard exist in
  `monitoring/alerts.json`; importing them into a provider and testing that a
  hook event actually arrives does not.
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
| `docs/MANUAL_INTERACTION.md` | Driving the protocol with `cast` when the frontend is unavailable. |
| `docs/PRD-v5.0.md` | Product spec; §11 holds the D1–D4 accepted risks and their review triggers. |
| `script/DeployMainnet.s.sol` | The executable form of Gate C. Its `CRITICAL NEXT STEPS` output and §3 here must not diverge. |
