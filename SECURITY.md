# Security Policy

This repository contains the contracts and frontend of ToshX v3. **v3 is
deployed on BNB Smart Chain `56`** (2026-10-29, from block 130,426,789) by
`script/DeployV3.s.sol`; `deployments/v3-56.json` records the addresses, all 18
deployed contracts are an exact match on Sourcify, and their source is public on
BscScan. Reports against the source are welcome and read.

v2 is also still deployed (2026-10-28, from block 130,243,379,
`deployments/v2-56.json`, 16 contracts exact on Sourcify). It lists no new
projects and never listed one; its source is `src/` minus `src/v3/`, and most of
it is shared with v3.

The v1 contracts that remain on BNB Smart Chain `56` are no longer in this
tree. Their source, tests and deployment records are in git history up to
commit `7cebff2e`, which is where a report against them should point.

## Reporting a vulnerability

Use GitHub's **private vulnerability reporting** on this repository
(*Security* → *Report a vulnerability*). That is the only channel published
here, and it is deliberate: no email address, phone number or messaging handle
belonging to an operator or a signer is recorded in this repository, and adding
one to receive reports would undo that. Private reporting gives you a
confidential thread with the maintainers without either side publishing a
contact.

Please do not open a public issue for anything that could put funds at risk.

**What to include.** A description of the flaw, the contract and function, and
— if you have one — a Foundry test that reproduces it against `test/v3`. The
test is worth more than the prose.

## What we can honestly promise

- **Expect a reply in days, not minutes**, and assume nobody is awake when you
  send it. If you believe an exploit is in flight and you can see funds moving,
  say so in the first line of the report.
- There is no automated on-chain monitor for v3 yet. Detection depends on
  people.
- The incident commander and comms lead are the same person.
- On `56`, the 2-of-3 Safe `0x02DE4629129D104C63329D13A6Ca67E43db7B310`
  (SafeL2 1.4.1) owns both v3 treasuries directly, and each v3 factory is owned
  by its `ToshLaunchGateway`, whose Safe is the same one: any current Safe
  signer may list through it, and every other owner call needs the Safe itself.
  `ToshBidBook` and both `ToshAutoLp` instances have no owner. v2 is held the
  same way. `DeployV3.s.sol` refuses a chain-56 deploy whose owner Safe has any other
  shape. Two of the three owner keys are held by the operator's counterparties
  and one by the operator; that is an attestation, not a measurement, and
  nothing on chain proves it.

There is **no bug bounty**. We have no funds earmarked for one and would rather
say that than imply otherwise.

## Scope

**In scope is this source tree**: `src/`, `script/` and the frontend under
`soat-frontend/`. A finding against the code is a finding whether or not it is
deployed anywhere.

### Out of scope

- Private keys that appear in this repository's git history. They are test and
  rehearsal keys, or v1 keys whose roles are disclosed in the v1 history. History
  was deliberately not rewritten, because commit hashes are what let anyone
  reproduce a verified build. **Finding one of them holding a role on a v2 or
  v3 deployment would be a finding.**
- Anything reachable only by the owner Safe acting against its own interest.
- Denial of service against public RPC endpoints or third-party services.

## Known and accepted — please challenge this one

We would rather you spend your time on something new, so here are the issues we
already know about.

**Provenance.** These entries were written and measured against v1. The
mechanisms they describe — the ladder treasury's buyback, its TWAP floor and
depth cap, `addLadderToken`'s maturity gate, the shelf's same-block rule — are
carried into v2's and v3's `src/` unchanged, so the findings stand. Two things differ:
the figures are v1 measurements in the currency of the build they were taken
on, and the tests they cite (`test/ToshV5*.t.sol`) are in git history rather
than in this tree. In v2 and v3, `launch()` is not creator-only: the Circuit NFT holder
has 48 hours after sell-out or the deadline, and then anyone may call it, so
read "the creator picks the block" below as "whoever launches picks the block".

**Sandwiching the treasury buyback used to pay ~7 %. It is closed, and the dial
that closed it is the one to challenge.** The buyback is a public, sized,
tax-exempt market buy: `pokeBuyback()` is permissionless, `nextSpendAmount()` and
`currentCursor` are readable, and the leg itself is exempt from the 1 % hook tax.
Until 2026-09-21 its only protection was `_buybackSqrtFloor`, a TWAP-anchored
**price** bound of 1000 bps in sqrt — about 23 % in price — which stops an
out-of-band shove and does nothing to a same-size sandwich well inside it.

Measured then (`test_probeG_sandwichThePiggyback`), 10,000 BEM raised, 9,000 BEM
pooled, a 333.33 BEM leg, each figure net of the identical round trip with the
reservoir emptied so the attacker's own friction cancels:

| pump | × leg | gross edge | return on pumped capital |
|---:|---:|---:|---:|
| 166.67 BEM | 0.5 | **+11.75 BEM** | 7.1 % |
| 333.33 BEM | 1.0 | **+22.89 BEM** | 6.9 % |
| 666.67 BEM | 2.0 | **+43.49 BEM** | 6.5 % |
| 1,333.33 BEM | 4.0 | 0 | 0 % |
| 4,000 BEM | 12.0 | 0 | 0 % |

Two things in that table did the diagnostic work. The cliff past 4× the leg is
the band binding, and the old probe's flat 4,000 BEM pump sat in it — which is how
a live, repeatable sandwich was reported as a clean zero for months. And the
**return** is flat at ~7 % while only the absolute figure moves, which says the
governing quantity is a ratio, not a size: gross gain is `(leg / depth) × pump`
and friction is `1.3 % × pump`, so `pump` cancels and the trade pays if and only
if `leg / depth` exceeds friction. At 3.7 % it did, by roughly 3×, at every size.

That is also why the two obvious dials cannot fix it. The band bounds the price at
the *end* of the leg, so it must stay wide enough for the leg's own impact on the
thinnest listed book and cannot tell a sandwich from an honest fill. A `minOut`
bounds the *average* paid, which does distinguish them, but not as one constant:
here the honest shortfall is ~1.8 %, and at the `MIN_SOFT_CAP_PROD` floor (90 BEM
pooled, a 30.93 BEM leg, 34 % of the book) it is ~25 %.

**The fix is sizing, not guarding.** `ToshLadderTreasury.MAX_LEG_DEPTH_BPS` caps
each leg at 0.50 % of its own pool's quote-side depth, applied per pool in
`_buyAndBurn` rather than per cycle in `_runPiggyback`, because depth is a property
of the book and `nextSpendAmount()` is a property of the reservoir. Depth comes
from `getLiquidity` and `getSlot0` as `(L << 96) / sqrtPriceX96`, the virtual
quote reserve of the active range. Unspent offer stays in the reservoir for the
next cycle, so a thin pool is bought back in more, smaller bites.

Re-measured after the cap, same raise, leg now 45.49 BEM:

| pump | × leg | gross edge | net P&L to the attacker |
|---:|---:|---:|---:|
| 45.49 BEM | 1.0 | +0.44 BEM | **−0.73 BEM** |
| 90.99 BEM | 2.0 | +0.88 BEM | **−1.45 BEM** |
| 181.97 BEM | 4.0 | +1.76 BEM | **−2.89 BEM** |
| 682.40 BEM | 15.0 | +6.42 BEM | **−10.57 BEM** |
| 4,000 BEM | 88.0 | 0 | **−87.73 BEM** |

**Two things worth challenging.** First, the probe now asserts on **net** P&L, not
on the gross edge, and that correction matters: `edge` is the armed arm minus the
emptied arm, so the attacker's friction cancels out of it, which makes it the
buyback's gross contribution to a position someone already holds — positive for
any non-zero leg. `edge == 0` is not a property this design can have, and an
earlier revision of this file disclosed a *ceiling* on `edge` for exactly that
reason. What the protocol needs is that manufacturing the position costs more than
the buyback pays for it. Second, break-even was bisected rather than derived: at
130 bps the sandwich still loses, at 150 bps it profits, so the real threshold is
~140 bps and 50 bps sits ~2.8× under it. That margin is carrying constant-product
curvature, the leg's own tax exemption, and a builder paying no priority fee. **If
you can find a configuration where 50 bps is not enough, that is a finding.**

**The obvious way to defeat a depth cap is to supply the depth, and it does not
work — check this.** `MAX_LEG_DEPTH_BPS` reads `getLiquidity()` at poke time and
`beforeAddLiquidity` is a `pure` no-op, so the quantity the cap is derived from is
attacker-supplied: add in-range liquidity, watch the ceiling rise with it, poke,
remove, all atomically and at no inventory risk. The lever is real and large.
Measured (`test_probeO_jitLiquidityAroundTheBuybackLeg`), a position at 4× the
book: ceiling **70.17 → 350.85 BEM**, i.e. the leg restored from the cap almost
back to the full uncapped offer, and the leg burns 4.75× more supply.

It extracts nothing because the two effects cancel exactly. Raising the liquidity
raises the leg *and* raises the depth that leg swaps through, by the same factor,
because it is the same liquidity — and price impact is `leg / depth`, which the cap
pins at 0.50 % regardless of who supplied the depth or when. What the treasury buys
is deflation per BEM, and that is unmoved: **1,714,050,693,515 tokens/BEM with the
JIT position against 1,713,626,299,190 without**, 0.025 % apart on a leg 5× larger.

**That the cap is a *ratio* against *live* liquidity is what makes this hold, and
it is the part to attack.** A cap written as an absolute figure would be a lever
here. So would the tempting "fix" for JIT — reading a lagged or stored depth — and
it would be strictly worse, because a stale depth against a live leg breaks the
cancellation that is doing the work. The probe asserts the burn rate rather than
the attacker's P&L, which is **+144.79 BEM** with the position against −8.42
without; that gap is not extraction from the buyback but from `modifyLiquidity`
not being a swap, so it pays neither the 1 % hook tax nor slippage, which makes an
LP position a cheaper way to liquidate size than selling through the book. That
routing edge is available to any holder at any time, treasury or no treasury.

**At the price boundary the leg fills for dust rather than declining.** One
full-range genesis position has the same liquidity at every tick inside it, so
`getLiquidity()` never falls to zero on the way out and the boundary is not a
cliff — the *ratio* degrades instead. `(L << 96) / sqrtPriceX96` collapses as sqrt
price grows, so the ceiling shrinks smoothly to nothing. Measured
(`test_probeN_priceDrivenOntoTheRim`) with spot walked to tick **537,327**:
`legCeiling` **4,549,348,672 → 19,837 base units**, and the leg spends exactly
that — 0.0002 BEM against an offer of 333 — while still buying a large quantity of
near-free supply. Filling is correct here; what must not happen is filling at
*size*, because then anyone able to shove a pool toward the rim could aim the whole
reservoir at a pool of their choosing at a price they set. The ratio is what
prevents it, and it holds at inputs extreme enough to overflow a less careful
expression.

Two adjacent behaviours that probe recorded, neither a vulnerability, both worth
knowing. An oversized **exact-input** sell is unfillable rather than partially
filled: the pool stops at the price limit with most of the input unconsumed, while
the hook's skim is sized off the *specified* amount, so it tries to take 1 % of the
full figure from a vault that never received it and the swap reverts
`ERC20InsufficientBalance` inside `HookCallFailed`. Nothing moves and no funds are
lost. Separately, with a pool's quote side drained, the hook's 70 bps reservoir
share is `take`n from the vault *during* the swap, before the router settles the
buyer's input — so the first buy that unsticks such a pool must be small enough
that its own skim fits in the vault's residue. In production the Infinity vault is
shared across every pool on this quote asset, so its aggregate balance is nowhere
near one drained pool's; the coupling is nonetheless to the vault's balance at swap
time rather than to the trade.

**First-block pool flow is open, deliberately.** Whoever calls `launch()` picks
the block — the Circuit NFT holder for the first 48 hours, then anyone — and
`nonReentrant` does not serialise a swap later in the same transaction: they may
bundle `launch()` with a buy, and a searcher may backrun instead. `beforeSwap`
has no allowlist, no cooldown and no per-transaction cap, and
`beforeAddLiquidity` is a no-op, so JIT LP is available from the first tick.
The genesis position is 80 % of the raise against `0.8 × raised ÷ 2P` tokens at
the opening price 2P — 90,000,000 tokens on a sold-out raise.

Do not read the shelf's defences as covering this. The launch block shuts the
**ladder** — `SameBlockMintForbidden` plus a pre-maturity reference price of
`min(spot, 2P)`, so a two-block pump cannot lift the ceiling — and the first
shelf is 183,000 × raised ÷ hard cap tokens, about 0.2 % of the token side of the
book beside it, sold only to Agent ID holders within their shelf allowance.
What bounds the pool is price rather than permission: a sniper
pays at least the opening price 2P, plus 1 % hook tax and 0.2 % pool fee. It is a
privileged first look at the float, not a discount against the GENESIS buyers,
whose cost was P to 1.5P. In v1 this was pinned by
`test_probeA2_launchBlockPoolFlowIsOpenByDesign` (git history).

**Buyback was unbounded in a pool's first 1800 s.** `_buybackSqrtFloor` returns
`MIN_SQRT_PRICE + 1` — no bound at all — for exactly the window between a pool's
`launch()` and `TWAP_WINDOW` elapsing, because `twapSqrtPriceX96()` reads 0 until
then. During that window a listed token has no anti-sandwich control, on the
pool whose liquidity is thinnest. It is measured, not theoretical: on a pool
parked 1500 bps out, the full 3.33 ETH leg clears and 0.93 ETH of it is
recovered by whoever parked the price.

Those two figures are **denominated in ETH because that is the build they were
measured on**, and they are left unconverted rather than rescaled. `TRIGGER_STEP`
has since been re-denominated several times — ETH, then 3.5 BNB, then 92.8 BEM,
then 10 BEM, and in v2 and v3 **0.3 BNB** on the BNB treasury and **180 USDT** on the
USDT treasury, both at 18 decimals — over an unchanged `BATCH_SIZE` of 3, so the leg a present-day
attacker would be reaching for is a different number. Multiplying the old
measurement through two currency rescales would produce a figure nobody measured
and present it in the same sentence as one somebody did. If this window is ever
reopened, the measurement has to be redone rather than converted.

**Closed in source on 2026-09-11, on 4663 on 2026-09-12, and carried into every
deployment since — including `97` and the v2 and v3 treasuries on `56`.** The next
three paragraphs are v1 history; the gate itself is what is true now.
`addLadderToken` now reads `twapSqrtPriceX96()` itself and reverts
`TwapNotMature` unless it answers non-zero, which puts the window out of reach
through the only door that leads to it. `test_probeG3_immatureTwapIsRefusedAtListing`
pins the refusal at the same 1500 bps park that used to clear the whole cheque.

**How it reached the chain is worth stating, because it was not by plan.**
`ToshFactory.ladderTreasury` is `immutable` and is baked into the hook
implementation every launch clones, so this gate could never be retrofitted to
the treasury that was live — it could only arrive with a whole new platform.
This section used to say so, and used to say the gate would therefore wait. It
did not wait: the platform was redeployed on 2026-09-12 for an unrelated reason
(per-project referral binding), the new treasury is built from source carrying
the gate, and the exposure closed as a side effect. The old treasury still does
not have it and still never can; it is simply no longer the platform.

**The gate has now been watched firing, on a real chain.** This section used to
say the opposite — that its presence rested on provenance rather than
observation, because reaching it needed a token listed on the treasury and none
had been (`ladderTokenCount()` read 0). The `97` rehearsal closed that gap
without setting out to. Listing was attempted in the same transaction as
`launch()` and `addLadderToken` reverted `TwapNotMature`, which is the refusal
arm; the listing was retried a `TWAP_WINDOW` later and succeeded, and
`ladderTokenCount()` on `0x79de…7674` now reads 1. Both arms of one branch,
against deployed bytecode rather than a fork. That is observation, and it is
worth more than the four directions of provenance it replaces — though note what
it is observation *of*: the v1 source of the time on a testnet, not the retired
4663 treasury, which never got the gate and never could. The v2 and v3
treasuries are built from source that carries the same gate; no token has been
listed on them yet, so on `56` it rests on provenance until one is.

**Sandwiching `ToshAutoLp`'s buy loses, but by a thinner margin than the
treasury's — check the flush path.** 80 % of every shelf payment is bought into
the project's pool and added as liquidity, so like the treasury leg it is a
public, sized market buy. It runs only when the TWAP is mature and spot is no
more than 99 bps (in sqrt price) above it, spends at most `MAX_DEPTH_BPS` (2 %)
of the pool's virtual quote reserve per run, of which about half is swapped, and
refuses a swap that would move sqrt price more than 2 %; otherwise the amount
stays pending. `flush` refuses a block that already has a swap. Its buys pay the
1 % tax and never carry the treasury buyback.

`test/v3/AutoLpSandwich.t.sol` measures it the same way as the treasury probe:
the attacker buys, the AutoLp run happens, the attacker sells everything, and
the identical round trip without the run is the control. Pumps from 0.01 % to
32 % of the reserve, on the `AutoLp.t.sol` launch (8 pooled, a run at the cap):

| path | how the attacker gets around the gates | edge as a share of the round trip's cost | result |
|---|---|---:|---|
| shelf sale, same block | pump under ~0.05 % of the reserve; anything larger trips `MAX_MINT_TICK_DRIFT` (10 ticks) and the sale reverts | 53 % | loses at every size |
| shelf sale, next block | pump at the end of block N, the sale opens N+1 | 53 % | loses at every size |
| `flush`, next block | same, with quote already pending | **82 %** | loses at every size |
| several flushes on one pump | — | — | only one run: after it, spot is past the 99 bps premium and the next `flush` defers |

At ≥ 2 % of the reserve every path defers (spot above the TWAP premium), so the
edge is zero there. The round trip costs ~2.4 % of the pump (1 % tax each way
plus the 0.2 % pool fee twice), and a capped run hands back ~1.9 %, so the ratio
argument holds with ~18 % to spare on `flush`. That margin is what to attack:
anything that cheapens the attacker's round trip — a fee-free route into the
same pool, a rebate, a token-side tax exemption — or lets one pump see more
than one capped run. **A configuration where sandwiching it pays is a
finding.**

One honest limit remains. The gate fires **once, at listing**, while
`_buybackSqrtFloor` runs on every leg thereafter, so a token listed with a
healthy getter whose getter later reverts still buys unbounded. That residual is
assessed as unreachable on chain and is pre-disclosed below.

The audit's own verdict on the trade the gate replaced is reproduced rather than
softened, because it is what the source change was answering and because it
still describes any deployment that lacks the gate:

> this is a procedural control on a privileged key, so it is exactly as strong
> as the runbook and the alert pipeline, and weaker than the one-line code
> change that would make it unreachable. An auditor who thinks that trade is
> wrong should say so.

**One part of this the gate does not fix, which is the part worth your time.**
`_buybackSqrtFloor` answers a *reverting* `twapSqrtPriceX96()` with "unbounded"
as well, and the gate only establishes that the getter answered once, at
listing time. We think that door is unreachable on chain — `nowTs -
_prevCheckpointTs` cannot underflow where time only moves forward, and nothing
else in the getter reverts — and we would rather be shown wrong about that by
you than find out otherwise. It is reachable in tests, and was reached; see
`_warpBy` in `test/ToshV5.t.sol`.

If you think it is wrong, say so. That is a legitimate report even though it is
already documented, and arguing the trade is more useful to us than rediscovering
the mechanism.

**A buyback leg can move a couple of wei into the pool without burning
anything.** `_buyAndBurn` settles whatever the pool consumed and then burns only
`if (out > 0)`. When spot already sits on `_buybackSqrtFloor`, the AMM fills
nothing and still rounds the amount owed to the pool up, so the swap returns
`amount0 = -2, amount1 = 0`: two wei leave the treasury, no tokens come back, no
`BuybackBurned` is emitted. The wei reach the pool, not an address — nobody is
paid — but "every wei out is matched by a burn" is false at wei granularity, and
we would rather write that down than round it off.

This was found by the fuzzer, not by reading: `invariant_treasuryOutflowAlwaysBurns`
in `test/ToshV5Invariants.t.sol` failed on one seed with `2 != 0`. The treasury
is immutable and cannot be taught to skip a zero-output fill, so the invariant
now classifies the drop instead — a residue at or below `NIL_FILL_DUST_WEI`
(16 wei) is counted as a rounded-up nil fill, and anything above it still fails
hard. That threshold is nine orders of magnitude below a single leg's offer of
`TRIGGER_STEP / BATCH_SIZE`, so it cannot mask a loss worth reporting; it is a
threshold, not a tolerance. If you can drive the unburned residue above it, or
reach it through a path that is not a nil fill, that is a finding and we want it.

## Disclosure

We will confirm a report, agree a timeline with you, and credit you unless you
ask us not to. If a fix requires redeploying a singleton and migrating state, the
timeline will be weeks and we will say so rather than sit on the thread silently.
