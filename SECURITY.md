# Security Policy

This repository contains the contracts, monitoring and tooling for a protocol
that is **live on Robinhood Chain (chain 4663)** and holds real value. Reports
are welcome and read.

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
— if you have one — a Foundry test that reproduces it. The test is worth more
than the prose; `test/` carries 373 tests across 13 files, 17 of them
adversarial `test_probe*` cases, and one of those —
`test_probeG3_immatureTwapIsRefusedAtListing` in
`test/ToshV5Attack.t.sol` — is the model for what a useful report looks like.

## What we can honestly promise

Internal severity targets are P0 acknowledged in 5 minutes, halted in 15.
**Those are targets for an incident already detected, and they are not a
commitment to an external reporter.** The reasons
are written down rather than glossed:

- The on-chain monitor is a GitHub Actions workflow. Since 2026-09-11 a paging
  finding is pushed to a phone rather than left in an issue inbox nobody
  watches at 03:00, so that specific gap is closed. The one above it is not:
  this host does not meet the 15-minute detection criterion, and the gap has a
  number rather than a hedge. Measured twice, and the second measurement is the
  one that settles it: over 157 hours at an hourly cron, GitHub delivered 27% of
  the passes asked for; over the next 193.5 hours at a cron asking four times an
  hour, it delivered **7%**. Read the rate rather than the percentage —
  **0.269 passes per hour, against 0.27 at the hourly cron.** Asking four times
  as often changed nothing, so the interval is not a detection knob on this
  host and no cron setting here produces an upper bound. Observed gaps between
  passes ran 2.1 h at the closest and 7.2 h at the widest.
- The workflow therefore also accepts an external trigger
  (`repository_dispatch`, via `/api/watch-ping`), so the cadence can come from a
  host that is not GitHub's shared scheduler. First measurement, 2026-09-14:
  three consecutive gaps of 15.3, 14.7 and 15.1 minutes against a requested 15 —
  a cadence the cron did not hold once in 193.5 hours. **That is four passes, not
  193.5 hours. It is enough to set a threshold from and not enough to claim the
  15-minute criterion is met.** What stops it from being an assertion here is
  WATCHER-05: the gap between passes is now checked from inside the monitor and
  pages if an hour goes by without one. A pass that never runs still pages
  nobody, and the push reaches one phone, not a rotation.
- The public chain-4663 RPC rate-limits the monitor: identical `eth_getLogs`
  calls are refused from the seventh onward. That cost one real detection — on
  the 2026-09-08 mainnet cutover every log query was refused, the run stayed
  green, and seven P0 governance events in that window went unread. A pass now
  issues three queries rather than one per event, which is under the measured
  ceiling, and a fully blind pass is loud instead of green. Neither change
  removes the ceiling; a keyed endpoint does.
- The incident commander and comms lead are the same person.
- Halting requires 2-of-3 signatures on Safe
  `0x2953957774482efA660921df85A1E7634ccfe27A`, so the binding constraint is
  reaching a second human, not the mechanics — those were measured at 5 seconds.

So: expect a reply in **days, not minutes**, and assume nobody is awake when you
send it. If you believe an exploit is in flight and you can see funds moving, say
so in the first line of the report.

There is **no bug bounty**. We have no funds earmarked for one and would rather
say that than imply otherwise.

## Scope

In scope — the singletons deployed on chain 4663:

| Contract | Address |
|---|---|
| `ToshFactory` | `0x2920ca7E9fcD85491D699e1f9Ae2CAa65Cfb2892` |
| `ToshLadderTreasury` | `0x255722226720914eF5B2CD54647f21f584BD4Ea2` |

Also in scope: `ToshLaunchpadHook` and `ToshToken`, which are deployed as clones
by the factory on every launch; the PoG signing oracle under `scripts/`; and the
frontend under `soat-frontend/`.

Deployed 2026-09-12 at block 61056709 from commit `9b9d9ce`, which reaches
`main` as `d18d2d5`. Two names for one tree, and worth stating rather than
quietly picking one: `9b9d9ce` is what the deployer recorded in
`broadcast/DeployMainnet.s.sol/4663/run-latest.json` at broadcast time and is
therefore the historical fact, while GitHub's rebase merge replayed the commit
onto `main` under a new object name. `git diff 9b9d9ce d18d2d5` is empty, so
either name reproduces the build; `d18d2d5` is the one reachable from `main`.

Sources for both, and for the three contracts the factory creates, are published
on **Sourcify** under chain 4663:

    https://sourcify.dev/server/v2/contract/4663/<address>

Sourcify grades all five `match` rather than `exact_match`, and the difference
matters enough to spell out: the runtime bytecode matches this tree byte for
byte, and the metadata hash appended after it does not. What is proven is that
the code that executes is this code. What is not proven is the provenance of
the trailing metadata blob, which contains no executable instructions.

All five are **also verified on Blockscout**, so the explorer shows source rather
than bytecode and the constructor arguments are decoded on the page. Blockscout
grades them `partial match` for the same reason Sourcify says `match`: runtime
bytecode byte-identical, trailing metadata hash not. Its records carry
`is_verified_via_sourcify: false`, which is accurate — it did not import from
Sourcify, it compiled the standard-JSON input itself and compared. The two
verifications are therefore independent of each other, and agreeing is worth
more than either alone.

One warning for anyone repeating this. Blockscout's verification form offers a
method called **Sourcify**, and it is not a way to verify on Blockscout. It is an
embedded `verify.sourcify.dev` widget that submits to Sourcify and reports
*Sourcify's* status, so it shows a green "Match" badge for a contract Blockscout
still lists as unverified. Two attempts here were fooled by exactly that. The
method that works is **Solidity (Standard JSON input)**; `verify-out/README.md`
records the rest.

A second, independent anchor that needs no third party at all: the deploy
artefact `broadcast/DeployMainnet.s.sol/4663/run-latest.json` plus the factory's
`HOOK_CREATION_CODEHASH`, which equals this tree's
`keccak256(type(ToshLaunchpadHook).creationCode)`. If you are auditing, that
equality is checkable from the chain and from this repository without trusting
either of us, or Sourcify; `script/RecomputeInitcodeHash.s.sol` is the check.

The previous pair — factory `0xBa9d2E86281b988225Eca383C375215912fb20B9`,
treasury `0x99aD248dD15498957B864Fd79917F0E103Aa78F7`, deployed 2026-09-08 and
Blockscout-verified — is **out of scope**. It is no longer the platform. It
still exists and still holds a small buyback reservoir with no withdraw path,
and its two launches were abandoned by decision rather than by failure. Reports
against it are welcome as history but are not live findings.

### Out of scope

- **Private keys that appear in this repository's git history.** They are test
  and rehearsal keys. All of them are revoked: none holds any role in the live
  deployment, and their reuse is banned. History was
  deliberately *not* rewritten, because the commit that the verified mainnet
  bytecode was built from is the anchor that lets anyone reproduce the build,
  and rewriting history would break every hash in that chain. Reporting one of
  these keys is not a finding.
- Anything reachable only by an owner key acting against its own interest.
  Ownership is a 2-of-3 Safe; "the owner could rug" is understood, and the
  threshold is the answer to it.
- Denial of service against the public RPC endpoint, or against the free-tier
  third-party services the monitoring uses.

## Known and accepted — please challenge this one

We would rather you spend your time on something new, so here is the issue we
already know about, stated as the audit states it.

**Buyback was unbounded in a pool's first 1800 s.** `_buybackSqrtFloor` returns
`MIN_SQRT_PRICE + 1` — no bound at all — for exactly the window between a pool's
`launch()` and `TWAP_WINDOW` elapsing, because `twapSqrtPriceX96()` reads 0 until
then. During that window a listed token has no anti-sandwich control, on the
pool whose liquidity is thinnest. It is measured, not theoretical: on a pool
parked 1500 bps out, the full 3.33 ETH leg clears and 0.93 ETH of it is
recovered by whoever parked the price.

**Closed in source on 2026-09-11, and on chain on 2026-09-12.**
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

Two honest limits on that claim. First, the gate's presence in the live treasury
rests on **provenance rather than observation**: the deploy artefact records the
commit, the factory's `HOOK_CREATION_CODEHASH` matches this tree, the treasury's
runtime differs from this tree's build only in the bytes of the `poolManager`
immutable, and Sourcify has independently recompiled this source and matched it
against the deployed runtime — but nobody has watched the gate fire, because
reaching it needs a token listed on the new treasury and none has been listed
(`ladderTokenCount()` reads 0). Provenance from four directions is still provenance; it
says the right code is there, not that it was seen to work. Second, the gate fires **once, at listing**, while
`_buybackSqrtFloor` runs on every leg thereafter, so a token listed with a
healthy getter whose getter later reverts still buys unbounded. That residual is
assessed as unreachable on chain and is pre-disclosed below. `STATE-07` in
`monitoring/alerts.json` is not retired by any of this.

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
`if (out > 0)`. When spot already sits on `_buybackSqrtFloor`, V4 fills nothing
and still rounds the amount owed to the pool up, so the swap returns
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
