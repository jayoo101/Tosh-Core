# Security Policy

This repository contains the contracts, monitoring and tooling for a protocol
that is **not deployed to any mainnet right now**. Reports are welcome and read.

That sentence used to say "live on Robinhood Chain (chain 4663) and holds real
value", and every section below was written under it. The protocol has since
left that chain for BNB Smart Chain, `56` has not been deployed, and the only
standing deployment is a rehearsal on testnet `97` that holds no value and whose
keys are public. So the honest reading of this policy today is: the threat model
and the known findings are current, the operational promises describe a
deployment that no longer exists, and each section says which it is.

**If you are looking for the live singletons to point a report at, there are
none.** The `97` addresses in *Scope* are the current code on a chain where
nothing is at stake.

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
than the prose; `test/` carries 389 tests across 16 suites, 17 of them
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
- The public RPC rate-limits the monitor. On chain 4663 the ceiling was measured:
  identical `eth_getLogs` calls were refused from the seventh onward, and that
  cost one real detection — on the 2026-09-08 cutover every log query was
  refused, the run stayed green, and seven P0 governance events in that window
  went unread. A pass now issues three queries rather than one per event, and a
  fully blind pass is loud instead of green. **Those two fixes travel to BSC; the
  measurement does not.** Nobody has characterised the BNB dataseed endpoints'
  limits, so the margin the "three rather than one" figure was chosen against is
  currently unknown rather than comfortable. A keyed endpoint removes the
  question; the project does not have one yet.
- The incident commander and comms lead are the same person.
- **Halting is not multi-signature on the standing deployment.** On 4663 it
  required 2-of-3 on Safe `0x2953957774482efA660921df85A1E7634ccfe27A`, and the
  binding constraint was reaching a second human rather than the mechanics —
  those were measured at 5 seconds. That Safe is on a chain the protocol left
  and cannot be reused. On `97` both the factory and the treasury answer
  `owner()` with a single EOA whose private key is public, so halting there
  requires no human at all and can be done by anyone who cloned this repository.
- A **replacement 2-of-3 now exists on `56`**:
  `0x02DE4629129D104C63329D13A6Ca67E43db7B310`, created 2026-09-18, SafeL2
  1.4.1, indexed by the transaction service, owner set verified against three
  signatures that each recovered to their claimed address. **It owns nothing
  yet.** `56` is undeployed, so the Safe is a precondition that has been met
  rather than a control that is operating: `script/DeployMainnet.s.sol` reads it
  as `PROD_OWNER_SAFE` and transfers both the factory and the ladder treasury to
  it in the same broadcast, and until that broadcast runs the 2-of-3 property is
  something this repository is ready for and not something it has.
- Two of the three owner keys are held by the operator's counterparties and one
  by the operator. The gas that funded the Safe's deployer came from owner 3's
  address at the operator's request, which is worth stating because balance
  arithmetic alone cannot tell that apart from the operator holding that key —
  and if the operator held two of three, the threshold would be decorative.
  This is an attestation, not a measurement. Nothing on chain proves it.

So: expect a reply in **days, not minutes**, and assume nobody is awake when you
send it. If you believe an exploit is in flight and you can see funds moving, say
so in the first line of the report.

There is **no bug bounty**. We have no funds earmarked for one and would rather
say that than imply otherwise.

## Scope

**In scope is this source tree**, because that is where the protocol currently
lives: `src/`, the PoG signing oracle under `scripts/`, and the frontend under
`soat-frontend/`. A finding against the code is a finding whether or not it is
deployed anywhere, and with `56` undeployed that is the only kind available.

### The standing deployment — BNB Smart Chain testnet `97`

| Contract | Address |
|---|---|
| `ToshFactory` | `0xB224f26a323320376c0b4C6a3228533FA63E5bBd` |
| `ToshLadderTreasury` | `0x79de222644E8BBeea6FC55815CCBE9FF136D7674` |

Deployed 2026-09-17 at block 131563800 from commit `1030eae`, recorded in
`broadcast/Deploy.s.sol/97/run-latest.json`. `ToshLaunchpadHook` and `ToshToken`
are deployed as clones by the factory on every launch; the rehearsal's pair are
`0x46e8ADDa65b8acE41B2818A4cf0B1249c03E393f` and
`0xb3b9443a717138aFB542156D27279726BAFf5A63` (`RHRSL`).

Two things to know before spending time on it.

**Its keys are public.** All three privileged roles on that factory — `owner`,
`pogSigner` and `platformTreasury` — are the single address
`0x73db078fa94607893270079AC8F5c7492aB480cd`, whose private key was committed to
this repository in a set of driver scripts and pushed. The scripts are deleted;
the disclosure is not undone. Anyone who cloned the repository can sign as any
of the three. `platformTreasury` is `immutable`, so this cannot be fixed by
rotating a key — only by redeploying. **"I can drain / halt / mint on `97`" is
therefore not a finding**, and neither is anything else that follows from
holding that key. It is left standing so the addresses above keep resolving.

**Half of BSC is verified, and the missing half is the factory.**
`ToshLadderTreasury` at `0x79de…7674` has its source published on
testnet.bscscan.com, compiler `v0.8.26+commit.8a97fa7a`, submitted from
`.github/workflows/verify.yml`. `ToshFactory` does not, and the reason is
worth stating because it is not a decision: Etherscan refuses further
submissions on chain 97 to this key with *"Free API access is not supported
for this chain"* — after accepting one. It behaves like a spent allowance
rather than a plan boundary, since reads on the same key and chain never
stopped working.

**Leaving it unverified is a decision, not a backlog item.** `97` is a
rehearsal whose keys are public; buying an API plan to publish source on it
would be spending money to improve the provenance of a deployment that holds
nothing. The workflow is idempotent and skips what is already published, so
whoever wants the factory on BscScan can re-run it any time and it will
attempt only that one contract. For `56` this stops being optional.

So the provenance chain below — two independent verifications of the 4663
build — has one BSC counterpart out of two. What covers the gap meanwhile is
the local anchor, which needs no explorer and no trust: the deploy artefact at
`broadcast/Deploy.s.sol/97/run-latest.json` plus `HOOK_CREATION_CODEHASH`.

What IS worth reporting against `97`: anything reachable **without** that key.
An unprivileged attack on genesis accounting, the buyback floor, the claim
arithmetic, the same-block lock, or the PoG quota is a real finding, and `97` is
a convenient place to demonstrate it because a rehearsal has already driven the
whole lifecycle through it.

### Retired — Robinhood Chain `4663`

Everything from here to the end of this section describes a deployment the
protocol has **left**. It is kept because the verification work is the strongest
provenance claim this project has ever been able to make, and deleting it would
quietly upgrade the current state. Reports against these addresses are welcome
as history and are not live findings.

| Contract | Address |
|---|---|
| `ToshFactory` | `0x2920ca7E9fcD85491D699e1f9Ae2CAa65Cfb2892` |
| `ToshLadderTreasury` | `0x255722226720914eF5B2CD54647f21f584BD4Ea2` |

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

And one before that, also on 4663 — factory
`0xBa9d2E86281b988225Eca383C375215912fb20B9`, treasury
`0x99aD248dD15498957B864Fd79917F0E103Aa78F7`, deployed 2026-09-08 and
Blockscout-verified. It still exists and still holds a small buyback reservoir
with no withdraw path, and its two launches were abandoned by decision rather
than by failure.

So the full history is three deployments deep and none of them is live: two on a
chain that was left, one on a testnet whose keys are public. That is the state a
reporter should assume.

### Out of scope

- **Private keys that appear in this repository's git history** — but read the
  correction, because this entry used to be wrong in a way that would have cost
  a reporter their time. It said "all of them are revoked: none holds any role
  in the live deployment." **That is false.**
  `0x73db078fa94607893270079AC8F5c7492aB480cd` holds `owner`, `pogSigner` and
  `platformTreasury` on the standing `97` deployment, and its key is in this
  history. It is out of scope because it is **already disclosed** — see *Scope*
  — and not because it is inert. The distinction matters: an out-of-scope note
  resting on a false premise is worse than no note, since it tells a reader not
  to look at the one live key there is.

  The rest are genuinely test and rehearsal keys with no role anywhere. History
  was deliberately *not* rewritten, because the commit the verified 4663
  bytecode was built from is the anchor that lets anyone reproduce that build,
  and rewriting history would break every hash in that chain. Reporting any of
  these keys is not a finding. **Finding one of them signing on `56` would be**,
  and `0x73db…80cd` in particular must never appear there; at the time of
  writing it has never transacted on `56`.
- Anything reachable only by an owner key acting against its own interest —
  with the same caveat. On 4663 ownership was a 2-of-3 Safe and the threshold
  was the answer to "the owner could rug". On `97` ownership is one EOA with a
  public key, so there is no threshold and the premise of this exclusion does
  not hold; that case is covered by the disclosure above rather than by this
  line. The 2-of-3 property is a precondition for `56`.
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

Those two figures are **denominated in ETH because that is the build they were
measured on**, and they are left unconverted rather than rescaled. `TRIGGER_STEP`
has since been re-denominated twice — ETH, then 3.5 BNB, and now **92.8 BEM** at
8 decimals — over an unchanged `BATCH_SIZE` of 3, so the leg a present-day
attacker would be reaching for is a different number. Multiplying the old
measurement through two currency rescales would produce a figure nobody measured
and present it in the same sentence as one somebody did. If this window is ever
reopened, the measurement has to be redone rather than converted.

**Closed in source on 2026-09-11, on 4663 on 2026-09-12, and carried into every
deployment since — including `97`.** The next two paragraphs are 4663 history;
the one after them is what is true now.
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
it is observation *of*: the current source on a testnet, not the retired 4663
treasury, which never got the gate and never could.

One honest limit remains. The gate fires **once, at listing**, while
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

**The monitor watching that gate was itself broken for the whole Infinity port,
in two independent ways, and both are worth knowing before you weigh anything
above about detection.** Found 2026-09-18 by running the monitor rather than by
reading it:

1. **It was watching a chain the protocol had left.** `monitoring/alerts.json`
   named 4663, `MONITOR_RPC` pointed at 4663, and the `MONITOR_*` addresses were
   the 4663 pair — from the 2026-09-08 cutover until 2026-09-18. Every pass
   reported success, roughly a thousand of them, about a deployment that settles
   nothing, while `97` had nothing watching it. No check caught it because every
   check in `watch.mjs` was a *consistency* check and all of them were satisfied:
   the endpoint agreed with the catalogue, the checkpoint agreed with the
   endpoint, and `owner()` answered with the address the config expected.
   `WATCHER-08` is the check added for it, and it compares the catalogue against
   an external list of retired chains rather than against anything in the
   catalogue.
2. **STATE-07 could not perform its check at all.** It read the hook address
   from word 4 of the `PoolKey` returned by `getPoolKey(address)`, which is
   Uniswap V4's five-member layout ending in `hooks`. Infinity's key has six
   members and `hooks` is third, so word 4 is `fee` — the monitor was calling
   `twapSqrtPriceX96()` on `0x…0bb8`, i.e. 3000. That address has no code, the
   call failed, and the handler reported the token as having no anti-sandwich
   bound. So the one automated control on the unbounded-buyback rule paged a
   confident false P1 for every listed token on every pass and could never
   detect the real condition. The unit test did not catch it because its stub
   encoded the same five-word layout. The fix reads word 2 and additionally
   cross-checks against the factory's `tokenToHook` mapping, so the offset is no
   longer the only thing asserting what that address is; `monitoring/state07.test.mjs`
   now fails if the offset regresses.

Neither was exploitable on its own, and neither is a contract bug. They are
detection failures, which is why they belong in the same section as the claims
about detection rather than in a changelog. Read the stated 15-minute and 8-hour
figures elsewhere in this file with the knowledge that for ten days they
described passes about the wrong chain.

**The monitor was briefly half-blind on `97`, loudly, and is not any more.**
Measured 2026-09-18, the public BSC testnet dataseed refuses `eth_getLogs`
unconditionally — `-32005`, six of six identical one-block requests at 2-second
spacing — so it is neither the rate limit nor the range cap documented in
`monitoring/rpc.mjs`; the method is not served. `eth_call` is, so the `STATE-*`
checks and the ownership reads ran while the 24 log-based alerts did not, with
`WATCHER-02` and `WATCHER-04` saying so on every pass. `MONITOR_RPC` was then
repointed at a keyed chain-97 endpoint and the next pass read 12 logs in 3/3
getLogs with neither check firing. Worth stating rather than quietly fixing,
because the loud half-blind state is the *repaired* form of the 2026-09-08
incident, in which a fully blind pass stayed green.

**The PoG signer is still `0x73db078f…80cd`, whose private key is public, and
that is now a decision rather than an oversight.** On `97` it changes nothing
that is not already true: the same key owns both contracts there, so the testnet
offers no security to lose and is documented throughout this file as such. The
reason to name it here anyway is that it does **not** carry to `56`.
`registerPoG` verifies signatures against `pogSigner`, so a public signing key on
mainnet means anyone can mint PoG allocations at will — it is a funds-affecting
compromise on day one, not a degraded control. Rotating it is a precondition for
the mainnet deploy in the same sense the owner Safe was, and unlike the Safe it
has not been done. Do not read "deferred" as "assessed as low risk on `56`".

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
