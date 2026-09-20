# Development guide

How to build, test, deploy and operate this repository. For what the protocol
*is* and why it is built this way, read the [README](../README.md).

**[README / protocol spec](../README.md)** · **[toshx.xyz](https://toshx.xyz)** ·
**[Security policy](../SECURITY.md)**

| | |
|---|---|
| Network | BNB Smart Chain — chain `56` (mainnet, **not yet deployed**) / chain `97` (testnet, live) |
| AMM | PancakeSwap Infinity CL (`Vault` + `CLPoolManager`) |
| Factory (97) | [`0x3009e10a696AC43465C8bdb9AFD8C989aB9cebdE`](https://testnet.bscscan.com/address/0x3009e10a696AC43465C8bdb9AFD8C989aB9cebdE) |
| Treasury (97) | [`0xB07Fb4f504e13A77422f8E82986C37B61F11c4aA`](https://testnet.bscscan.com/address/0xB07Fb4f504e13A77422f8E82986C37B61F11c4aA) |
| Quote asset (97) | [`0x76bD1ceC663AE3242e5267e232B821C51a4882EB`](https://testnet.bscscan.com/address/0x76bD1ceC663AE3242e5267e232B821C51a4882EB) — `MockQuoteAsset`, 8 decimals, symbol `mBEM`. Real BEM has **no deployment on 97**, so the rehearsal cannot use it; see `SECURITY.md` for what a mock does and does not prove |
| Governance (97) | a **single EOA** — `0x35b232E2…874a`, the deployer. Not a multi-sig, and the PoG signer is separate (`0x7138DEb9…e03A`). See `SECURITY.md` |
| Governance (56) | 2-of-3 Safe [`0x02DE4629129D104C63329D13A6Ca67E43db7B310`](https://bscscan.com/address/0x02DE4629129D104C63329D13A6Ca67E43db7B310), `Ownable2Step` on both singletons — **owns nothing yet**, the deploy transfers to it |
| Supply per project | 21,000,000 hard cap, enforced on every mint |
| Trader friction | 1.30% total — 0.30% to LPs, 0.70% buy-and-burn, 0.30% platform |
| Verification | Etherscan v2 via `.github/workflows/verify.yml`. `ToshLadderTreasury` is verified on `97`; `ToshFactory` is deliberately not — see `SECURITY.md`. Nothing on `56` is verified because nothing on `56` is deployed |
| Quote asset | **BEM**, an 8-decimal ERC-20 (`0x5ce0…695a` on `56`). BNB pays gas only |
| Tests | 392 passing of 396 across 16 suites, including stateful invariants and adversarial probes |
| Toolchain | Foundry · Next.js + wagmi + viem · Node |

> There is no platform token, and the quote asset is not the chain's coin either.
> Launch fees, genesis deposits, shelf purchases, refunds and buyback ammunition
> are all **BEM**, pulled with `transferFrom` — nothing on a money path is
> `payable`. Notes mentioning native-coin deposits, `msg.value`, `MockSATO`,
> `harvestAndBurn`, graduation or the `0x2200` / `0x20CC` hook address mask
> describe earlier denominations or Uniswap V4 and no longer apply. Infinity
> registers permissions via `getHooksRegistrationBitmap()`.

---

## What the protocol guarantees

These are structural properties, not policies — each one is a consequence of
code that exists or code that is absent, and each is checkable from chain.

**Depositors always have a way out.** If the creator never calls `launch()`
within the 7-day `LAUNCH_WINDOW` after genesis closes, every depositor reclaims
100% of their BEM with no penalty. Missing the raise target does not fail the
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
in the buyback rotation; the owner cannot choose where the BEM goes.

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
Every figure below is in **BEM**, the quote asset — an 8-decimal ERC-20, not the
chain's own coin — *except the launch fee*, which is native BNB at 18 decimals.
Everywhere else BNB pays gas and nothing else.

| Fee | Rate | Destination |
|---|---|---|
| Launch fee | `launchFee()` — default **0.005 BNB** (native, 18 decimals) | `platformTreasury` |
| Shelf proceeds | 99% | `projectAdmin` |
| Shelf platform cut | 1% | `ladderTreasury` |
| Referral commission | 10% of each deposit | referrer(s), or the treasury if unbound |
| Swap tax — buy | 1.00% of the BEM input | 0.70% → `ladderTreasury`, 0.30% → `platformTreasury` |
| Swap tax — sell | 1.00% of the token input | burned to `0xdead`, not split |
| Pool fee | 0.30% | third-party LPs, settled natively by the Infinity CL pool |
| **Total trader friction** | **1.30%** | 0.30% LPs + 0.70% burn + 0.30% platform |

The launch fee is an owner-tunable parameter with a `MAX_LAUNCH_FEE` = 0.5 BNB
ceiling and zero permitted; read `launchFee()` rather than trusting this table.

It goes to `platformTreasury` rather than `ladderTreasury` for a mechanical
reason, not a policy one: `ladderTreasury` buys and burns with BEM, and has no
path that converts native coin. Fee revenue sent there would sit unreachable.

**`createLaunch` is `payable`; the other two money paths are not.** The fee is
native BNB, so `createLaunch` takes it as `msg.value` and refunds any excess in
the same transaction. `deposit` and `mintBondingCurve` are in BEM and pull with
`transferFrom` against an allowance the caller
must already hold, so each is two transactions. The spender is not the same
contract in both directions and guessing costs a reverted deposit: `deposit`
pulls through the **factory**, `mintBondingCurve` through the **hook**.

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
| `ToshLaunchpadHook` | one per project | Phase 1 deposit / refund / launch; Phase 2 shelf mint / claims; Infinity `ICLHooks` callbacks; hook-local TWAP oracle |
| `ToshToken` | one per project | ERC-20, hard cap checked on every mint, minted only by its own hook |

Hooks are deployed as EIP-1167 clones at CREATE2 addresses, which is what makes
one dedicated hook per project affordable. Per-project rules are frozen as
immutables at deployment.

Two byte counts appear in this repository and both are right: the initcode is
**131 bytes** (a 10-byte creation stub plus the runtime) and that is what the
CREATE2 address is derived from, while the deployed **runtime is 121 bytes** and
that is what the 200 gas/byte is charged on. `ToshCloneLib` lays out both, and
`ToshV5Factory.t.sol` asserts the 131.

| Role | Who | Can do |
|---|---|---|
| Platform owner | Safe on `56`; a single public-key EOA on `97` | pause new launches, curate the buyback roster, tune caps and fees, halt shelf minting for ≤ 7 days |
| `creator` | EOA | call `launch()` on their own project |
| `projectAdmin` | EOA / Safe | receive 99% of shelf proceeds; may rotate itself |
| Genesis depositor | anyone eligible | deposit in Phase 1, claim after launch, or refund |
| Referrer | anyone | earn commission on deposits bound to them |
| Retail LP | anyone | add and remove liquidity in the project pool |

---

## Lifecycle

**Create.** `createLaunch(name, symbol, projectTreasury, projectAdmin, rawSalt,
expectedFee, genesisDuration)` reserves the name/symbol pair and CREATE2-deploys
the hook. `expectedFee` is the caller's slippage cap against the owner moving
`launchFee` underneath them.

The address is **not** mined. Uniswap V4 read a hook's permissions out of its
address, so the factory used to search salts until it found one carrying the
`0x20CC` mask; Infinity calls `getHooksRegistrationBitmap()` instead, and any
unused salt will do. See "Salts: there is nothing left to mine" below.

**Phase 1 — genesis.** Depositors approve the **factory** for BEM, then call
`factory.deposit(hook, referrer, amount)` — two transactions, and the allowance
goes to the factory rather than to the project's own hook, which is the one a
depositor would guess. The window is a hard deadline chosen at creation; the soft cap is a
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

**Buyback.** Once the treasury holds `TRIGGER_STEP` (92.8 BEM) the reservoir is
armed and `max(92.8 BEM, 10% of balance)` is due. One poke spends
`spend / BATCH_SIZE` on one roster token in round-robin order and sends it to
`0xdead`, under a TWAP-relative floor
(`MAX_BUYBACK_SQRT_DEVIATION_BPS` = 1000). Two things poke it:

- **`afterSwap`, when the trade can afford it** — gated on
  `gasleft() >= PIGGYBACK_MIN_GAS` and capped at
  `gasleft() - PIGGYBACK_TAIL_RESERVE`, so a swap always keeps enough gas to
  finish. Without the gate, the trade whose own tax armed the reservoir paid for
  the whole cycle, every cycle.
- **`pokeBuyback()`, from anyone** — the liveness backstop, since the gas gate
  means trading alone no longer guarantees the reservoir empties. It moves no BEM
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
the live rate (seeded at 46.4 BEM of quota per 1 ETH of gas), capped by the
band's own ceiling (seeded at 46.4 BEM), then clamped on-chain by
`maxPogAllocationLimit()` (46.4 BEM) regardless of what the oracle signed.

The two units in that sentence are not a typo, and since the BEM move they are
not even the same **scale** — the floor is 18-decimal and the ceiling is
8-decimal. The floor and the derived gas cap measure **gas history**, which was
spent on ETH-settled chains and stays in ETH; the rate and the ceiling measure a
**deposit**, which is BEM. 1 ETH of gas fills the ceiling exactly, as it did
under all three denominations (1.75/1.75, then 46.4/46.4). `pogQuota.ts` says
the same thing at its `floorWei` and `maxAllocWei` declarations. Note also what
the scanner still covers: Ethereum, Arbitrum, Optimism, Base and Robinhood —
**not** BSC. A wallet's BSC gas history does not count toward its own quota on
BSC, which is a disclosed gap rather than a design choice, and closing it needs
a paid Etherscan v2 tier.

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

`cooldownDuration` is a separate per-(wallet, hook) clock, and at its current
**72 h** it is not a throttle but a one-deposit rule. It is at least
`DURATION_SLOW`, the longest genesis, so a wallet's second deposit into a given
project can never land inside the window its first one was made in — the
cooldown expires no earlier than the deadline the deposit would have to beat.

That matters because the two clocks used to agree at 24 h: a wallet on a 72 h
genesis got three quota refills and could accumulate up to `perWalletCap` in
instalments its quota never justified in one transaction. The quota refills;
`nativeDeposited` does not reset.

The relationship is a dial against a constant in another contract, with nothing
structural holding them together and zero margin at 72 h against 72 h, so
`test_cooldown_isAtLeastTheLongestGenesis` pins it and
`test_deposit_slowGenesisAllowsExactlyOnePerWallet` exercises the tight case.

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

Expected: **389 passing, 4 skipped** in both runs. CI runs both. The 4 skipped
check a deployed `56` and stay dormant until there is one.

Two suites — `ToshV5Fork.t.sol` and `ToshV5ForkInfinity.t.sol` — fork BSC
mainnet against the real Infinity deployment and therefore depend on `BSC_RPC`
answering. They flake when it rate-limits, which presents as a handful of
failures and a lower total rather than as a network error. If a local run
reports something like "3 failing, 367 succeeded", re-run before believing it.

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
> change to a single opcode — produces a different initcode hash and therefore a
> different CREATE2 address for the same salt. Under Uniswap V4 that also
> invalidated every previously mined salt; with no mask to satisfy, the cost now
> is simply that predicted addresses move. This only bites
> during development: once deployed, the factory freezes
> `HOOK_CREATION_CODEHASH` in its constructor. Never hardcode an initcode hash
> in tooling; always read it from the deployed factory.

### Auditing a live launch

```bash
node scripts/auditLaunch.mjs <hook address>
```

Reads a launched hook, its token and its Infinity CL pool, and checks them
against the arithmetic `launch()` performs — pool state comes from
`CLPoolManager.getSlot0` / `getLiquidity`, not through the app's read path.

It reads through those getters rather than `extsload` because Infinity ships no
`StateView`, which is the periphery contract the V4 version leaned on. Balances
live in the `Vault` and pool state in the manager, so this reads two contracts
where it used to read one.

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

**A public RPC will not serve this monitor, and the reason differs per chain.**
On the public 4663 endpoint the seventh identical `eth_getLogs` was refused; a
pass that issued one request per topic0 walked into that ceiling, and workflow
run `34196807435` missed P0 governance logs that way. The watcher now ORs topic0s
into three queries (factory, treasury, address-less hook events), with 250 ms
pacing plus adaptive backoff. On the public **BSC testnet dataseed** the answer
is blunter: measured 2026-09-18, `eth_getLogs` is refused unconditionally —
`-32005`, six of six identical one-block requests at 2-second spacing — so it is
neither a rate limit nor a range cap and no amount of pacing or chunking reaches
it. `eth_call` is served, which is why a pass on that endpoint runs the `STATE-*`
checks and reports `0/3 getLogs`. `MONITOR_RPC` must be a **keyed chain-97
endpoint**; with one, a pass reads logs normally.

**The monitor watches chain `97`, and `monitoring/alerts.json` is the thing that
says so.** It named 4663 for ten days after the protocol left that chain, with
the endpoint and the `MONITOR_*` addresses agreeing, and reported success on
every pass about a deployment that settles nothing. `WATCHER-07` compares the
catalogue against the endpoint and could not see it, because both were wrong
together. `WATCHER-08` compares the catalogue against an external retired-chain
list instead. If you repoint this monitor, move `alerts.json` first — repointing
only the RPC makes `WATCHER-07` page while the addresses stay wrong.

---

## Hook permissions

The hook declares which callbacks Infinity should invoke, as a `uint16` bitmap
returned by `getHooksRegistrationBitmap()` and repeated in `PoolKey.parameters`;
`CLPoolManager.initialize` refuses the pool if the two disagree. Six offsets are
set, giving **`0x0CC5`**:

| Offset constant | Why it is load-bearing |
|---|---|
| `HOOKS_BEFORE_INITIALIZE_OFFSET` | only this hook may open its own pool |
| `HOOKS_BEFORE_ADD_LIQUIDITY_OFFSET` | gates who may provide liquidity |
| `HOOKS_BEFORE_SWAP_OFFSET` | takes the exact-input tax (specified = input) |
| `HOOKS_AFTER_SWAP_OFFSET` | stamps the block, feeds the oracle, pokes the buyback |
| `HOOKS_BEFORE_SWAP_RETURNS_DELTA_OFFSET` | lets `beforeSwap` move the input side |
| `HOOKS_AFTER_SWAP_RETURNS_DELTA_OFFSET` | lets `afterSwap` charge exact-output |

Exact-output cannot be taxed in `beforeSwap` — the input is unspecified and its
size is only known after the swap. Returning a delta from `afterSwap` is what
charges that input, so a router asking for "N tokens out" still funds the
treasury instead of burning the output token.

What is absent is `BEFORE_REMOVE_LIQUIDITY`, and only that one. The genesis
position stays locked through ownership, so a reverting `beforeRemoveLiquidity`
would only have punished retail LPs for a guarantee the ownership model already
provides. `BEFORE_ADD_LIQUIDITY` *is* set — an earlier version of this table
listed five flags and said "no liquidity flags", which was wrong on both counts.

**Do not carry the old hex over.** The same permission set under Uniswap V4 was
the address mask `0x20CC`, and these are offsets into a bitmap rather than bits
of the hook's address, so the numbering is unrelated. Importing `0x20CC` here, or
`0x0CC5` into anything that reasons about addresses, is silent nonsense — the
set is identical, the encoding is not. On chain 97 you can read the whole word
back: `PoolKey.parameters` is `0xc80cc5`, which is tick spacing 200 (`0xC8`)
packed above the `0x0CC5` bitmap.

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
# BNB Smart Chain testnet (97)
forge script script/Deploy.s.sol:DeployScript \
  --rpc-url $BSC_TESTNET_RPC --broadcast -vvvv

# Local
anvil
forge script script/DeployLocal.s.sol:DeployLocal --fork-url http://127.0.0.1:8545 --broadcast
```

Each script asserts `block.chainid` before broadcasting, so pointing one at the
wrong RPC aborts instead of deploying.

Verification is **not** part of the broadcast any more. Chain 4663 was verified
on Blockscout, which needed no API key; BSC verification goes through Etherscan
v2, which does. Rather than put that key on a laptop, run
`.github/workflows/verify.yml` by hand — it holds the key in secrets, skips
contracts already published, and retries the rate limit. Two things it taught,
both recorded in `SECURITY.md`: `foundry.toml` must carry `?chainid=` in the
`[etherscan]` URL or `forge` reports a missing-chainid error whatever
`--verifier-url` says, and a free key can be refused with "Free API access is
not supported for this chain" on submission even when reads work — which is why
`ToshFactory` is deliberately unverified while `ToshLadderTreasury` is verified.

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

### PancakeSwap Infinity periphery

Unlike Robinhood Chain, mainnet and testnet do **not** share addresses here, so
every one of these is per-chain and a rehearsal does not exercise the production
address book. The authoritative copies are `soat-frontend/src/lib/contracts.ts`
and the two `.env*.example` templates; this table is a convenience, and
`scripts/preflightMainnet.mjs` check 5b verifies the pair structurally by calling
`CLPoolManager.vault()` rather than trusting either.

| Contract | `56` mainnet | `97` testnet |
|---|---|---|
| CL PoolManager | `0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b` | `0x36A12c70c9Cf64f24E89ee132BF93Df2DCD199d4` |
| Vault | `0x238a358808379702088667322f80aC48bAd5e6c4` | `0x2CdB3EC82EE13d341Dc6E73637BE0Eab79cb79dD` |
| UniversalRouter | `0xd9C500DfF816a1Da21A48A732d3498Bf09dc9AEB` | `0x87FD5305E6a40F378da124864B2D479c2028BD86` |
| CLPositionManager | `0x55f4c8abA71A1e923edC303eb4fEfF14608cC226` | `0x77DedB52EC6260daC4011313DBEE09616d30d122` |
| Permit2 | `0x31c2F6fcFf4F8759b3Bd5Bf0e1084A055615c768` | same |

Measured on chain 2026-09-19 rather than cited: manager 20,885 bytes on `56` and
20,886 on `97`, Vault 8,347 on both, UniversalRouter 24,350 on both,
CLPositionManager 24,004 on both, Permit2 7,020 on both. And each manager's own
`vault()` returns the Vault in its column — so the pairing above is the managers'
answer, not this table's claim.

Two rows in that table were wrong, and both were wrong in the same way: the value
was plausible and something else answered to it.

- **The `UniversalRouter` row held the `CLPositionManager` addresses.** The
  byte-count sentence said "UniversalRouter 24,004 on both", which is genuinely
  `CLPositionManager`'s size — so the measurement corroborated the mislabelling
  instead of catching it. Both contracts now have their own row.
- **The `Permit2` row held Uniswap's canonical address.** `0x0000…78BA3` is
  deployed on BSC and is a working Permit2 (9,152 bytes), so an approval to it
  succeeds and a presence check passes. PancakeSwap's periphery does not consult
  it. Both `UniversalRouter` and `CLPositionManager` pull through
  `0x31c2F6fc…c768`, which is what `CLPositionManager.permit2()` returns on both
  chains. Approving the canonical one leaves a swap or an LP mint reverting with
  `AllowanceExpired` from a contract the caller never named.

The Permit2 mistake was invisible until the quote asset became an ERC-20: under
native settlement Permit2 was not in the swap path at all. `ToshV5Fork.t.sol`
now asserts `CLPositionManager.permit2()` against the constant, so a periphery
bump cannot move it back quietly.

There is no `StateView` and no `Quoter` row because Infinity ships neither. Pool
state is read from `CLPoolManager.getSlot0` / `getLiquidity` directly, which is
why `auditLaunch.mjs` and the frontend both talk to the manager instead of to a
periphery reader.

> ⚠ **The Vault is not optional detail.** V4's `PoolManager` both ran the pool
> and held the balances; Infinity splits those, and settlement is paid to the
> **Vault**. Both bugs the port surfaced were this: settlement paid to the
> manager, and the treasury's callback still authenticating the manager rather
> than the Vault. Anything hand-encoding a swap or a liquidity payload needs the
> 6-field `PoolKey` — `(currency0, currency1, hooks, poolManager, fee, parameters)`
> — where V4 had 5 ending in `hooks`. The action opcodes are numerically
> identical to V4's, so the key's width is the only structural signal that you
> are on the wrong one.

The retired Robinhood Chain V4 periphery — where mainnet `4663` and testnet
`46630` did share every address — is in `README.md` Appendix A.1. Nothing in this
tree talks to it.

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
| `/launch` | Create a launch — duration picker, client-side salt selection and address prediction |
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

`MONITOR_RPC` is a paid keyed endpoint (dRPC Growth) as of 2026-09-15, repointed
at **BSC testnet `97`** on 2026-09-18. It had been the public 4663 URL, and half
the passes were scanning nothing: every `eth_getLogs` refused on the first
attempt through all four retries, `eth_call` answering normally alongside.
`monitoring/rpc.mjs` carries the measurements — the short version is that the
public endpoint meters by source IP, a GitHub runner shares its range with every
other runner, and no request interval buys back an allowance a neighbour has
already spent.

The repoint is a separate act from repointing `alerts.json`, and doing one
without the other is how this monitor spent ten days reporting on a chain the
protocol had left. `watch.yml` resolves `MONITOR_RPC` with
`secrets.MONITOR_RPC || secrets.BSC_TESTNET_RPC`; that order was briefly
inverted, for a good reason that expired within hours, and the comment there is
worth reading before changing it.

Three things follow that are worth knowing before touching this.

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

**The public BSC testnet dataseed cannot stand in for it, and not for the reason
the section above would suggest.** Measured 2026-09-18, it refuses `eth_getLogs`
unconditionally — `-32005` on six of six identical one-block requests at 2-second
spacing — so this is neither a rate limit nor a range cap, and neither chunking
nor pacing reaches it. `eth_call` is served, so a pass on that endpoint runs the
`STATE-*` checks, reports `0/3 getLogs`, and fires `WATCHER-02` and `-04`. Useful
as a fallback that pages, useless as a target.

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
│   ├── ToshLaunchpadHook.sol   # Per-project Infinity CL hook: genesis, pool, shelf ladder, tax
│   ├── ToshLadderTreasury.sol  # Platform-wide buyback reservoir (one-way valve)
│   ├── ToshToken.sol           # ERC-20, minted on demand by its hook only
│   └── libraries/              # HookDeployLib · HookAddress (computeAddress only) · ToshCloneLib
├── test/                       # 393 tests, incl. stateful invariants and test_probe* adversarial cases
├── script/                     # Foundry deploy + verification scripts
├── scripts/                    # Node tooling: ABI sync, launch audit, preflight, guards
├── monitoring/                 # alerts.json + watcher
├── docs/                       # This file. Protocol overview is README.md, disclosure is SECURITY.md
├── soat-frontend/              # Next.js dApp
└── foundry.toml
```

---

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `createLaunch` reverts `CapsChanged` | `expectedSoftCap` / `expectedWalletCap` no longer equal the factory's live `defaultSoftCap` / `maxPogAllocationLimit`. Re-read both from chain and retry. This replaced `InvalidHookSalt`, which no longer exists. |
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
| Treasury holds ≥ 92.8 BEM and nothing burns | Not a fault. Swaps are skipping the poke on the gas gate. Call `pokeBuyback()` — permissionless. `STATE-06` watches for this. |
| `pokeBuyback` reverts `NotArmed` | Reservoir below `TRIGGER_STEP`, or the roster is empty. |
| `pokeBuyback` reverts `PiggybackInProgress` | A buyback is already mid-flight in this call stack. Retry after it settles. |
| Every swap on a pool reverts | Check `treasury.factory()` is wired. This now degrades to skipped buybacks rather than bricking pools. |

---

## License

MIT — see [LICENSE](../LICENSE) and the SPDX headers in each source file.
