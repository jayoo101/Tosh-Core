# On-chain monitoring specification

**Version:** v5.0
**Checklist item:** **PM-E2** in `docs/PRE_MAINNET_CHECKLIST.md`
**Machine-readable config:** `monitoring/alerts.json`
**Drift guard:** `scripts/verifyAlertTopics.js` (runs in CI)
**Last updated:** 2026-08-26

---

## 1. What this covers, and what already exists

Monitoring for this project is two separate systems that are easy to confuse:

| | Covers | Status |
|---|---|---|
| **PM-E1** — Sentry (`@sentry/nextjs`) | Browser errors, React error boundaries, API route failures under `src/app/api/**` | ✅ built |
| **PM-E2** — this document | Contract events and on-chain state | ❌ **not wired** |

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

Current inventory: **7 P0, 5 P1, 9 P2, 4 P3**, plus 7 state checks and 21
events explicitly routed away from the pager.

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
| STATE-05 | P1 | daily | PoG signer gas balance | runs dry silently, blocks every new depositor |
| STATE-06 | P2 | hourly | reservoir armed ≥ 24h with no `PiggybackExecuted` | a gas-gated skip is deliberately not logged (§2.3) |
| STATE-07 | P1 | 5 min | `twapSqrtPriceX96() != 0` on every listed ladder token | the buyback's price bound is *absent*, not loose, while that reads 0 |

STATE-06 is the only one that needs a window rather than a single reading, which
is a real implementation constraint — see §7.

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

`mustNotPage` in `alerts.json` lists 21 events that are high-volume and entirely
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

---

## 8. Definition of done for PM-E2

- [ ] Provider chosen and the 25 alerts imported from `monitoring/alerts.json`
- [ ] Hook coverage verified by §2.1 method 1 or 2 — **tested by creating a
      launch and confirming its hook events arrive**
- [ ] All 7 `stateChecks` scheduled and firing, STATE-06 included — it is the
      only one needing a window rather than a reading (§7)
- [ ] **STATE-07 live before the first `addLadderToken` on mainnet.** Unlike the
      others it is not a backstop for something the contract already handles —
      it is the only automated check on a rule the contract does not enforce
      (PM-C8 / `SECURITY_AUDIT.md` §2.3). Listing a token before this is
      scheduled means running that window unobserved.
- [ ] P0 routes to a pager that has been tested with a synthetic event
- [ ] The 21 `mustNotPage` events confirmed not paging
- [ ] Correlation rule in §3.1 written into the on-call runbook
- [ ] `INCIDENT_RESPONSE.md` §8 Q4 drill re-scheduled now that its detection
      dependency exists

The second box is the one that gets skipped and the one that matters: an
untested hook subscription is the failure in §2.1, and it presents as silence.
