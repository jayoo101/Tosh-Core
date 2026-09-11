# On-chain monitoring specification

**Version:** v5.0
**Checklist item:** **PM-E2** in `docs/PRE_MAINNET_CHECKLIST.md`
**Machine-readable config:** `monitoring/alerts.json`
**Watcher:** `monitoring/watch.mjs` · **capability probe:** `monitoring/probeRpc.mjs`
**Drift guard:** `scripts/verifyAlertTopics.js` (runs in CI)
**Last updated:** 2026-09-08

---

## 1. What this covers, and what already exists

Monitoring for this project is two separate systems that are easy to confuse:

| | Covers | Status |
|---|---|---|
| **PM-E1** — Sentry (`@sentry/nextjs`) | Browser errors, React error boundaries, API route failures under `src/app/api/**` | ✅ built |
| **PM-E2** — this document | Contract events and on-chain state | 🟡 **re-pointed at mainnet 4663.** Observed history begins at block 57,492,253 — §7.1. Remaining: the sink is GitHub Issues, which is a monitor and not a pager (§7.3) |

**These do not overlap at all.** Sentry sees a user's browser and our own server
routes. It sees nothing on chain. A `pause()` executed by a stolen owner key, a
treasury drained, a genesis round quietly going refundable — none of these
produce a frontend error, so none of them produce a Sentry event. The reverse
also holds: an alert on this spec will never tell you the deposit button is
broken.

`script/DeployMainnet.s.sol` step 6 asks for exactly this, and
`docs/INCIDENT_RESPONSE.md` §8 already scripts a drill (Q4) whose success
criterion is "on-call detects within 15 min via Defender alert". Both are
promises this document is the unpaid half of.

---

## 2. Design constraints particular to this protocol

Three things here are not generic launchpad monitoring advice. Getting any of
them wrong produces a monitor that looks configured and is not.

### 2.1 Hook addresses cannot be enumerated in advance

There is one `ToshLaunchpadHook` per project, deployed by the factory via
`CREATE2` at an address mined to carry the Uniswap V4 flag mask `0x20CC`. The
set is unbounded and every member is unknown until its launch transaction lands.

So any hook-level alert must be scoped one of two ways:

1. **By event signature across all addresses** (`topic0` filter, no address
   filter) — simplest, and what `scope: "any-address"` means in
   `monitoring/alerts.json`. Costs some noise from unrelated contracts that
   happen to share a signature; acceptable for the four hook alerts here.
   On 4663 that noise is already visible: an address-less `LaunchCreated`
   survey hits `0x78936d83771eacaf03a2f78553428f91dd66f5d9`, which is not a
   `ToshFactory`. LIFE-03 is factory-scoped and ignores it
   (`SECURITY_AUDIT.md` §5.28).
2. **By a self-updating watch list** — subscribe to `LaunchCreated`, take the
   indexed `hook` field, add it to the monitored set.

A monitor configured with a hardcoded list of hook addresses is the trap: it
works perfectly for every project that existed on the day it was set up, and
covers none created after. There is no error to notice.

### 2.2 The most important lifecycle transitions emit no event

This is the finding worth reading twice.

`refundEnabled` and `zombieRefundEnabled` are **event-dedup flags, not the
refund gate**, and the contract says so (`ToshLaunchpadHook.sol:447-457`). They
are set lazily, the first time `refund()` actually executes. Which means:

- A round that misses its soft cap emits **nothing** at the deadline.
- A round whose 7-day launch window lapses emits **nothing**; `launch()` merely
  begins reverting with `LaunchWindowExpired`.
- `GenesisFailed` / `ZombieRefund` fire when the **first depositor claims** —
  potentially days later, potentially never.

`canRefund()` is the authority and it is a *view*, not an event. Therefore a
round can sit refundable, with user money in it, and the event stream is
indistinguishable from idle. Depositors are owed the news that their exit is
open, and no event-based monitor can produce it.

This is why `monitoring/alerts.json` carries a `stateChecks` block alongside
`alerts`. **STATE-01** polls `canRefund()` hourly across the hook set. An
event-only monitoring setup for this protocol has a hole exactly the shape of
its refund path.

### 2.3 Three failures are swallowed by design, and one of them silently

`PiggybackPokeFailed` and `BuybackSkipped` exist because the protocol correctly
refuses to let a broken buyback brick trading. The revert is caught, an event is
emitted, execution continues. That is the right call — and it means the buyback
engine can be completely broken while every user-facing surface looks healthy.
Unmonitored, the failure mode is a treasury that accumulates ETH it can no longer
spend, discovered by accident months later.

The third one emits nothing at all, and needs a different instrument.
`ToshLaunchpadHook.afterSwap` gates the poke on `gasleft() >= PIGGYBACK_MIN_GAS`
and caps it at `gasleft() - PIGGYBACK_TAIL_RESERVE`. That gate is why an
ordinary trade no longer reverts when its own buy tax happens to tip the
reservoir over the trigger — but it also means trading alone no longer guarantees
the reservoir is deployed, and a skipped poke is deliberately not logged.
Skipping is the common case, and an event would charge every trader for the
privilege of recording a non-event.

So this one is invisible to any event subscription, however well configured. It
is the same shape of blind spot as §2.2's refund flags and takes the same answer:
a scheduled poll of balance-plus-silence, **STATE-06**. The remedy is
permissionless — `pokeBuyback()` takes no role and no Safe transaction — so the
exposure is a monitoring gap rather than a custody one.

---

## 3. Severity model

Aligned with `docs/INCIDENT_RESPONSE.md` §0 so an alert maps onto an existing
playbook rather than inventing a parallel vocabulary.

| Severity | Meaning | Response |
|---|---|---|
| **P0** | Funds at risk, or governance compromised | Page immediately, 24/7 |
| **P1** | A protocol switch was thrown, or user-visible degradation | Page in waking hours, ticket otherwise |
| **P2** | Silent degradation | Ticket, next business day |
| **P3** | Informational | Dashboard / digest — **never** pages |

Current inventory: **6 P0, 5 P1, 9 P2, 4 P3**, plus 7 state checks and 22
events explicitly routed away from the pager. These counts are asserted against
`monitoring/alerts.json` by `scripts/verifyAlertTopics.js`; see §5.

### 3.1 Correlation is what makes governance alerts actionable

Every P0 in the `GOV-*` family fires on a legitimate action too. `Paused` looks
identical whether we did it or an attacker did. The alert cannot tell you which,
so the runbook must:

> **On any `GOV-*` or `SWITCH-0[12]` alert:** find the corresponding Gnosis Safe
> transaction within 5 minutes. A match downgrades it to an audit-trail entry.
> **No match escalates it to P0 regardless of the event's listed severity.**

That rule is the whole value of alerting on governance events. Without it, the
alerts train the on-call to acknowledge and move on, which is worse than not
having them.

---

## 4. Alert catalogue

The catalogue itself lives in `monitoring/alerts.json` — one entry per alert,
each with its `topic0`, severity, paging decision, playbook reference, and a
`why` field stating what the alert is actually for. It is the artifact to review
in a PR; this document is the reasoning around it.

Summary of the P0 set:

| ID | Event | Contract |
|---|---|---|
| GOV-01 | `OwnershipTransferStarted` | Factory |
| GOV-02 | `OwnershipTransferred` | Factory |
| GOV-03 | `OwnershipTransferred` | Treasury |
| GOV-07 | `OwnershipTransferStarted` | Treasury |
| GOV-04 | `PogSignerUpdated` | Factory |
| GOV-06 | `FactorySet` | Treasury |

> **GOV-05 was removed, and the ID is deliberately not reused.** It watched
> `TreasuryUpdated`, the companion event to `setPlatformTreasury`. Both were
> deleted when `platformTreasury` went back onto a money path — it now receives
> 0.30 % of the ETH input of every buy — because a mutable fee-routing target
> is audit finding M-2, so the mutability went rather than the inflow. The
> field is `immutable` on the factory and the same address is baked into the
> hook implementation as `platformFeeRecipient`.
>
> That means the event can never fire again, and a rule that can never fire is
> the worst kind of monitoring: it is silent for the wrong reason, and on a
> dashboard it is indistinguishable from a healthy system. Nothing replaces it
> in the governance set, because there is no governance action left to watch —
> the owner cannot retarget that revenue any more than a stranger can. The
> fee flow itself is visible as `PlatformSwapFeePaid`, which fires on every buy
> and is therefore classified under `mustNotPage`.

Both halves of the two-step ownership transfer are alerted, on both contracts.
`Ownable2Step` makes a takeover two transactions, and the window between them is
the only point at which it can still be abandoned by simply not accepting —
alerting only on completion discards the one chance to intervene.

> GOV-07 was missing from the first draft of `alerts.json`, and
> `scripts/verifyAlertTopics.js` is what caught it: the factory had both halves,
> the treasury only the second. The contract that actually holds ETH was the one
> with the gap.

The `stateChecks` block is the other half of the catalogue, and the half a
provider is most likely to drop on import (§7). Each one exists because the
condition it watches for **emits no event**:

| ID | Sev | Cadence | Watches | Because |
|---|---|---|---|---|
| STATE-01 | P1 | hourly | `canRefund()` across the hook set | refund flags are set lazily (§2.2) |
| STATE-02 | P0 | 15 min | treasury balance non-decreasing outside a buyback | the invariant suite cannot speak for deployed bytecode |
| STATE-03 | P0 | 15 min | `factory.owner()` / `pendingOwner()` | belt to GOV-01/02's braces; event delivery can fail |
| STATE-04 | P1 | 15 min | `factory.pogSigner()` | same reasoning applied to GOV-04 |
| STATE-05 | P1 | daily | keeper gas balance, **only if one is configured** | inactive by default — nothing this protocol runs needs gas (§4.1) |
| STATE-06 | P2 | hourly | reservoir armed ≥ 24h with no `PiggybackExecuted` | a gas-gated skip is deliberately not logged (§2.3) |
| STATE-07 | P1 | 5 min | `twapSqrtPriceX96()` **answers, and answers non-zero**, on every listed ladder token | the buyback's price bound is *absent*, not loose, while that reads 0 — **or while it reverts**, since `_buybackSqrtFloor`'s `catch` returns the same unbounded floor (§5.11) |

STATE-06 is the only one that needs a window rather than a single reading, which
is a real implementation constraint — see §7.

### 4.1 STATE-05 watched a wallet that never spends anything

**Corrected 2026-09-04.** This check used to read the PoG signer's balance
against a 0.05 ETH floor, and PM-D2 existed to top that wallet up. The premise
was wrong: **the PoG signer never sends a transaction.**

`registerPoG` is `external` and every branch keys off `msg.sender`, so the
*depositor* submits it and pays for it. The signer's address enters the
contract only as the expected result of `hash.recover(signature)`. Both
consumers of the key sign with no chain connection at all — the API route uses
viem's `privateKeyToAccount().signMessage()`, and `scripts/pogSigner.ts`
constructs `ethers.Wallet(pk)` with **no provider**, which cannot broadcast
even in principle.

A signer holding nothing therefore signs exactly as well as one holding fifty
ETH, and funding it was slightly worse than pointless: the key sits in a Vercel
environment variable, and a key guarding a balance is worth more to steal than
one guarding nothing.

Nothing downstream could have caught this. The check was implementable, the
threshold was readable, and on testnet it even fired — because there the signer
is also the deployer (`PRE_MAINNET_CHECKLIST.md` §4.1's role collapse), so the
balance it read was real and belonged to a different role. A check can be
correct in every mechanical respect and still be about the wrong thing.

The ID is kept rather than retired because the shape fits a case that has not
arrived. `pokeBuyback()` is permissionless and STATE-06's remedy is currently a
human calling it; automating that would give the protocol its first wallet that
genuinely needs gas, and it would go quiet on running dry with nothing to say
so. Setting `MONITOR_KEEPER_ADDRESS` activates the check for that wallet. Until
then it does not run, and `monitoring/watch.mjs` says nothing about it rather
than reporting a floor nobody is standing on.

---

## 5. Drift protection

An alert config is written once and then trusted for years. Rename an event or
change a parameter type, and every monitor keyed on the old `topic0` goes quiet
— not erroring, just never firing again. That failure is invisible exactly when
it matters most, because "no alerts" reads the same as "nothing wrong".

`scripts/verifyAlertTopics.js` runs in CI and enforces three things:

1. Every event named in `alerts.json` still exists on the named contract, with
   exactly the parameter types the signature claims.
2. Every `topic0` equals `keccak256` of that signature, computed with
   `cast sig-event` rather than copied.
3. **Every event the contracts emit is classified** — it has an alert, or it is
   explicitly listed under `mustNotPage`. A newly added event that nobody
   classified is the real hazard, since the default state of a new event is
   unmonitored and nothing complains.

Rule three is the one that earns its keep. It means adding an event to a
contract without deciding how it is monitored is a red CI check.

```bash
forge build
node scripts/verifyAlertTopics.js
```

---

## 6. Noise budget

The failure mode of a new monitoring setup is not too few alerts. It is a
firehose that gets muted wholesale in week two, taking the P0 alerts down with
it.

`mustNotPage` in `alerts.json` lists 22 events that are high-volume and entirely
normal — deposits, tier mints, tax receipts, referral accruals, quota resets.
They belong on a dashboard or in a daily digest. Two specifics worth knowing:

- **`GenesisDeposit` and `Deposited` are the same deposit** seen from the
  factory and from the hook respectively. Alerting on both double-counts every
  deposit and makes any rate-based rule wrong by a factor of two.
- **`BuybackBurned` is muted but `BuybackSkipped` is not.** Success is routine;
  the skip is the signal.

One rate to expect rather than investigate: `PiggybackExecuted` now fires once
per buy leg instead of once per three, because `LEGS_PER_POKE` is 1. Three times
the events for the same ETH deployed. A rule tuned on the old cadence will read
that as a buyback storm.

---

## 7. Provider notes

`monitoring/alerts.json` is provider-neutral on purpose: every monitor can
express "topic0 == X on address Y", and none of them agree on a config format.
Encoding intent in-repo means the reviewable artifact is a file in a PR rather
than a dashboard nobody can diff.

When importing, the two capabilities to check for — because not every provider
has both — are:

1. **Address-less `topic0` subscriptions**, or a webhook that can add addresses
   at runtime. Required by §2.1. A provider that only monitors a fixed address
   list cannot cover hooks.
2. **Scheduled view-function polling with a comparison**, not just event
   filters. Required by §2.2, §2.3 and by all six `stateChecks`. This is the
   capability most commonly missing, and without it both silent holes — refund
   visibility and an idle armed reservoir — stay open.

If the chosen provider cannot do (2), the state checks are a small scheduled job
against an RPC endpoint — a handful of `eth_call`s and a comparison. Do not skip
them because the vendor does not offer them.

STATE-06 needs one thing the others do not: memory. "Armed for 24h with no
`PiggybackExecuted`" is a claim about a window, not about a single reading, so a
stateless poll that only compares the current balance will fire on every healthy
cycle. Track the last `PiggybackExecuted` block alongside the balance.

### 7.1 There is no provider, because the chain's own RPC has both capabilities

`monitoring/probeRpc.mjs` measures the two requirements above against an
endpoint. Window width, measured on the 46630 testnet node and
**re-measured 2026-09-08 against `https://rpc.mainnet.chain.robinhood.com`**:

| Capability | 46630 (rehearsal) | 4663 (mainnet, 2026-09-08) |
|---|---|---|
| Address-less `topic0` filter (§2.1) | accepted over 1,000,000 blocks | accepted over 1,000,000 blocks, address-scoped and address-less |
| `eth_call` for view polling (§7) | `owner()`, `pendingOwner()`, `pogSigner()` all answer | same |
| Block time | ~0.2 s, so one max-span call reaches back ~59 h | 0.102 s (probed 2026-09-08), ~28.3 h per 1M |
| Request *rate* | a tight `eth_getLogs` loop is accepted | **does not transfer.** Requests 1–6 succeed; #7 returns JSON-RPC `Too Many Requests` (code 429) on HTTP 200. 250 ms between calls: 0/24 failures. `Promise.all`: fails immediately |

Window width is not the constraint that moved. A 900k-block rehearsal on
46630 could not have seen this: that node accepted the loop the watcher
actually runs (one `eth_getLogs` per topic0, back to back). The first
mainnet pass (workflow run 34196807435) reported `0 log(s)` over
56,592,252–57,492,252 and went green. Independently the same window held
seven logs mapping to GOV-01/02/03/06/07, all P0.

The cutover pass nevertheless wrote `lastBlock` to 57,492,252 — WATCHER-04
did not exist yet, so a blind-but-WATCHER-03 run consumed the window.
**That gap will not be swept.** The seven events are the PM-C1 deploy and
the PM-C2 ownership handoff, already recorded in `SECURITY_AUDIT.md`
§§5.25–5.26; a non-dry re-scan would file five P0 issues for actions taken
on purpose, which is how a P0 label stops meaning anything (§6). The
watcher's observed history on mainnet therefore begins at block
57,492,253. That is a stated limitation, not an oversight. The transport
fix was verified the same day by a `dry` dispatch (run 34200408580,
`--since 150000`) that saw those seven logs and zero WATCHER-02 entries,
in the same CI environment that had reported none.

So the implementation is still `monitoring/watch.mjs`: one pass, resumable
from a state file, then exit. What §7.1 previously treated as "the raw node
has both capabilities, a vendor is optional" remains true for *what* the
node will answer and false for *how fast*. Transport lives in
`monitoring/rpc.mjs` and is shared with the probe:

- Pace: one in-flight request, 250 ms since the previous start. Measured
  against the mainnet endpoint on 2026-09-08; a hardcoded sleep with no
  provenance is the thing someone deletes later, which is why the numbers
  sit next to the measurement.
- Retry: a JSON-RPC 429 / `Too Many Requests` is retried four times with
  exponential backoff (500 ms × 2^attempt). Detection inspects the JSON-RPC
  *body* (`error.code` / `error.message`), not `res.status`. Bounded, so a
  dead endpoint still throws.
- Concurrent callers queue rather than stampede. The probe used to
  `Promise.all` two `eth_getBlockByNumber`s and crash.

Findings still go to stdout as JSON lines and the exit code is non-zero
when any of them pages. Delivery is GitHub Issues (`report.mjs`), which
is a monitor and not a pager — §7.3.

A failed `eth_getLogs` after those retries is WATCHER-02. If the skipped
topic includes any P0, that pages. A pass that completed zero log queries
is WATCHER-04, which always pages, and does not advance `lastBlock`.
P1/P2-only skips do not page: §6's noise budget is spent by exactly that
kind of every-cycle repetition, and the P0s are what get muted along with
it. Retry is what absorbs a transient 429; paging is what remains after
retry is exhausted.

### 7.2 What the testnet rehearsal established

Run over 900,000 blocks of 46630 — real history, not a fixture:

- **11 of 24 alerts matched.** Both deploys (`OwnershipTransferred` ×2,
  `FactorySet`), the four dial changes from setup, the launch
  (`LaunchCreated`, `Launched`), and the `Paused`/`Unpaused` pair left by the
  2026-09-03 incident drill in `INCIDENT_RESPONSE.md` §8.1. The drill is now
  also the monitoring fixture.
- **A finding on the first run, which turned out to be the check's own bug.**
  STATE-05 reported the PoG signer at 0.0445 ETH against a 0.05 floor, and it
  was initially written up as PM-D2 caught in advance. Chasing it down instead
  established that the signer never sends a transaction and needs no gas at
  all — §4.1. So the rehearsal's most useful result was not an incident it
  detected but a check it disproved, and the only reason the number looked
  plausible is that on 46630 the signer is also the deployer.
- **Four checks driven to fire** by feeding a wrong expectation or a doctored
  state file: STATE-03 (ownership mismatch, P0), STATE-04 (signer mismatch),
  STATE-02 (balance drop with no buyback to explain it, P0), and STATE-06 on
  both sides of its window — silent when the reservoir has just armed, firing
  at 55.6 h. STATE-06's threshold can be overridden for that test, and the
  override reports itself on every run, because a testing affordance that can
  quietly disable a production check is the same class of bug as the rest of
  this document.
- **Silence confirmed as passing, not broken.** STATE-01 and STATE-07 reported
  nothing; `canRefund()` is `false` and the listed token's TWAP is 1.33e33, so
  nothing was owed. Both were verified independently with `cast` rather than
  inferred from the absence of output.

Two bugs were found by rehearsing that reading the code would not have caught.
The hook harvest read `LaunchCreated`'s `hook` field out of the log data, but
all three of `launchId`, `token` and `hook` are indexed and therefore in
`topics[1..3]`; the data holds `creator` and two string offsets. And the hook
filter tested `(addr & 0x3FFF) == 0x20CC`, whereas `HookMiner` requires the
flag bits to be *set* — the live hook ends `0xffdf`, low bits `0x3fdf`, and
carries all of `0x20CC`. Each produced an empty watch list and no error.

---

### 7.3 The host and the sink — and what they are not

`.github/workflows/watch.yml` runs the watcher on a schedule and
`monitoring/report.mjs` files paging findings as GitHub Issues. Both were driven
end to end against 46630 on 2026-09-04, not just written:

- A cold start with no checkpoint scanned a **bounded** 5,000 blocks and said in
  the log which window it was therefore *not* scanning.
- A deliberate 900,000-block sweep produced 17 findings, 11 paging — the same
  count §7.2 recorded — and filed 11 correctly labelled issues.
- Re-sweeping the identical window **suppressed all 11 and filed nothing**.
- A resumed pass picked up from the persisted checkpoint, scanned only new
  blocks, and advanced it (112,827,090 → 112,827,580).

**The checkpoint lives on an orphan `watcher-state` branch**, because every
runner is fresh and `monitoring/.watch-state*.json` is gitignored. `test.yml`
and `frontend.yml` exclude that branch from `on: push`; without the exclusion
each checkpoint would start a full Foundry build twice an hour.

**Deduplication is keyed on the situation, not the reading.** Event findings key
on the transaction hash and are filed once. State findings have no transaction
and are re-evaluated every pass, so they key on the alert id plus the address in
the message and deliberately ignore the numbers — otherwise STATE-02 would file
a fresh issue every time the treasury balance moved, and §6's noise budget would
be spent on the alerts it exists to protect. Nothing auto-closes: a check going
quiet is equally consistent with the check having broken.

> **This is a monitor. It is not a pager, and it must not be described as one.**
>
> GitHub's scheduled workflows are explicitly best-effort. Delays of tens of
> minutes are routine when the shared pool is busy, and runs are dropped
> outright under load — the cron here is offset from the hour for that
> reason, which reduces contention and guarantees nothing. So the
> **15-minute detection criterion in `INCIDENT_RESPONSE.md` §8 Q4 is not met by
> this host**, and Q4 must not be marked passed on the strength of it.
>
> Two silent failure modes come with the platform. Scheduled workflows are
> **disabled automatically after 60 days without repository activity** — the
> monitor stops and nothing announces it, because the thing that would announce
> it is the monitor. And an issue is not a notification unless someone has
> repository notifications on and reads them out of hours; a P0 filed at 03:00
> into an inbox nobody watches has been detected and not reported.
>
> Closing that last gap needs a channel that pushes. `report.mjs` now has one,
> built on 2026-09-11: with `PAGER_TELEGRAM_TOKEN` and `PAGER_TELEGRAM_CHAT`
> set it pushes every paging finding into the Telegram channel
> `INCIDENT_RESPONSE.md` §1 already names as the incident channel, so it
> reaches the signers where they have agreed to be reached and costs nothing.
>
> **Two properties of it matter more than its existence.** An unacknowledged
> P0 pages on EVERY pass, not once — a pager that fires into a sleeping phone
> and then goes quiet has still detected and not reported, and nothing here
> auto-closes, so a later pass knows the situation is unresolved.
> Acknowledgement is the issue itself and needs no new state: close it, or add
> the `acked` label. And the credentials are exercised on every pass via
> `getMe`/`getChat`, because "the day the bot token was revoked" and "the day
> of the first P0" are independent events and discovering the first during the
> second is the entire failure mode. That lesson is second-hand: the private
> issue sink shipped without it and had to be fixed the same day.
>
> **Until the two secrets are set this is inert**, and it says so on every
> pass rather than looking configured. The honest claim while unset is
> unchanged: **the protocol will notice, and will write it down.**

**Cost, measured rather than assumed.** A 900k-block mainnet pass on
2026-09-08 took 16.8 s wall-clock with the 250 ms floor (7 logs, 7
findings, 0 WATCHER-02). The same-day `dry` CI dispatch (run 34200408580,
`--since 150000`) is the verification that those seven logs, and zero
WATCHER-02 entries, appear in the environment that had been blind. GitHub
bills a whole minute per run, so cadence used to convert directly into
spend: hourly ≈720 min/month, every 30 minutes ≈1,440, every 15 ≈2,880,
all against the same private-repository allowance that `test.yml`
(4.4 min per push) and `frontend.yml` (2.4 min) drew on.

**That arithmetic stopped applying on 2026-09-11**, when the repository was
published. Actions minutes are free on public repositories, so the budget
that decided the cadence no longer exists.

**Hourly, at `:07`, decided 2026-09-04. Every 15 minutes from 2026-09-11.**
The original was a budget decision, and cheap to make because the thing being
given up was not real: the platform never guaranteed the 15-minute bar at any
cadence, so paying double for a schedule that still missed it bought latency on
paper only.

Publication removed the price rather than the argument, which is why the cadence
moved and the verdict above did not. Free minutes make hourly a choice with
nothing behind it, and four passes an hour is what `alerts.json` says three of
the state checks warrant; STATE-07, which is the only automated check on the
rule `SECURITY_AUDIT.md` §2.3 leans on, gets asked its question four times as
often. None of that is a detection guarantee, and the 15-minute bar in
`INCIDENT_RESPONSE.md` §8 Q4 is still not met by this host at any cron setting.
What closes that is a channel that pushes, not a shorter interval.

---

## 8. Definition of done for PM-E2

- [x] Provider chosen and the 24 alerts imported from `monitoring/alerts.json`
      — **no vendor**; `monitoring/watch.mjs` consumes the catalogue directly.
      §7.1 records why, and `monitoring/probeRpc.mjs` is the measurement that
      made it a decision rather than a preference.
- [x] Hook coverage verified by §2.1 method 1 or 2 — **both**. On 46630 the
      watcher caught `Launched` from hook `0x90FDE02D…`, an address it was
      never given, through the address-less topic filter (method 1); the same
      address was harvested from `LaunchCreated`'s `topics[3]` into the watch
      list (method 2) so the state checks have something to call.
- [x] All 7 `stateChecks` scheduled and firing, STATE-06 included — it is the
      only one needing a window rather than a reading (§7). STATE-01/03/04/05/07
      were run against the live testnet and 02/03/04/06 were each driven to fire
      (§7.2); `.github/workflows/watch.yml` now runs the lot on a schedule with
      a durable checkpoint (§7.3). **Re-pointed at 4663.** The first mainnet
      pass (workflow run 34196807435) was blind: 0 logs in a window that held
      seven P0 governance events, because the public RPC 429s a tight
      `eth_getLogs` loop and WATCHER-02 did not page. Transport, paging, and
      the probe are fixed (§7.1); the schedule now points at the chain that
      holds the money. The skipped window is left unswept: those seven logs
      are the PM-C1/C2 handoff, and observed history on 4663 begins at
      57,492,253.
- [x] A checkpoint that survives the cutover. `lastBlock` recorded no chain, so
      re-pointing at mainnet would have made `from` a testnet height above the
      mainnet head, and the "no new blocks" branch would have exited 0 on every
      cycle — a green run monitoring nothing, starting the day real money went
      live. WATCHER-03 now discards a checkpoint whose chain id differs, and
      also one that is simply ahead of the head, since the file already on disk
      has no chain id to compare. A pass that then scans nothing must not
      consume the window either: WATCHER-04 pages and leaves `lastBlock`
      unmoved, so the next pass retries rather than skipping the P0s. The
      cutover pass had already consumed 56,592,252–57,492,252 before that
      rule existed. Observed history on 4663 therefore starts at 57,492,253;
      the following pass (run 34200284533) resumed there, scanned 25,382
      blocks, and exited 0. The skipped window will not be re-opened — §7.1.
- [x] **STATE-07 live before the first `addLadderToken` on mainnet.** Unlike the
      others it is not a backstop for something the contract already handles —
      it is the only automated check on a rule the contract does not enforce
      (PM-C8 / `SECURITY_AUDIT.md` §2.3). Listing a token before this is
      scheduled means running that window unobserved. The schedule now points
      at 4663; this box closes when the first `addLadderToken` lands and
      STATE-07 is observed to poll it, not from the re-point alone.
      **Closed 2026-09-11.** The listing landed — `ladderTokenCount()` is 1 and
      `ladderTokens(0)` is `0x88382f166D1F900E69cFc433a8F936D671246233` — and a
      mainnet pass was then observed polling it. The evidence is a line that did
      NOT appear: STATE-07 emits the gap `no ladder tokens listed, so there is
      nothing to price-bound yet` whenever `count == 0`, and the pass printed
      only the STATE-03/04 gaps, so the loop ran with `count == 1` and the read
      came back non-zero. Worth stating in that shape, because a clean STATE-07
      and a STATE-07 that never executed look identical in a finding count.
      Note also that STATE-07 reads `ladderTokens(i)` off the treasury rather
      than from the harvested hook set, so it is unaffected by a pass that
      knows 0 hooks — which is most of them, since the set is rebuilt from
      `LaunchCreated` inside the scanned window.
- [ ] P0 routes to a pager that has been tested with a synthetic event.
      **Still open, and now for a narrower reason than before.** Until
      2026-09-11 delivery went only to GitHub Issues, and §7.3 sets out why
      that is a monitor and not a pager: best-effort scheduling, silent
      disablement after 60 idle days, and an issue nobody is notified of at
      03:00. Marking it done because something arrived somewhere is precisely
      the substitution this list exists to prevent.

      The mechanism now exists — a Telegram push in `report.mjs`, repaging
      unacknowledged P0s every pass, credentials exercised hourly (§7.3). It
      was exercised against a synthetic GOV-01 in `--dry`, both with the
      secrets absent and present, so the message that would be sent has been
      read. **What is still missing is the half that cannot be written:** the
      bot and chat do not exist until an operator creates them, and until the
      two secrets are set `report.mjs` reports on every pass that findings
      were written down and nobody was woken. This box closes when a synthetic
      P0 has been pushed to a real chat and someone's phone has rung, not
      when the code to do it merges.
- [x] The 22 `mustNotPage` events confirmed not paging — the 900k-block sweep
      produced 17 findings of which 11 paged, and `report.mjs` filed exactly the
      11. The non-paging six reached the run summary and nothing else.
- [x] Correlation rule in §3.1 written into the on-call runbook —
      `INCIDENT_RESPONSE.md` §1.0, 2026-09-05, with the routing this catalogue
      implies and had not stated: which playbook each *unmatched* alert goes to.
      Writing it out surfaced two things §3.1 does not say. `SWITCH-01` is
      catalogued P1, so "escalate regardless of severity" is an **inversion** for
      the pause family, not a step up — an unmatched `Paused` outranks its own
      label. And correlation must be done against the **Safe's** history rather
      than a signer's address, since signatures are off chain and any owner may
      execute, so `msg.sender` is the Safe on every legitimate call. Also recorded
      there: until PM-C2 the owner is still the deployer EOA, so there is no Safe
      record to correlate against and the rule reaches full strength only at C2.
- [ ] `INCIDENT_RESPONSE.md` §8 Q4 drill re-scheduled now that its detection
      dependency exists — note Q4's criterion names a 15-minute detection, which
      §7.3 explains this host does not guarantee

The second box is the one that gets skipped and the one that matters: an
untested hook subscription is the failure in §2.1, and it presents as silence.
