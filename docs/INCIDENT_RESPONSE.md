# Tosh Protocol — Incident Response Runbook

**Version:** v5.0 (pre-mainnet baseline)
**Owner:** Protocol Engineering + Operations
**Audience:** On-call engineers, Gnosis Safe signers, support staff
**Companion documents:** `docs/PRD-v5.0.md` (§11 decision record, §8 forensics),
`test/ToshV5Factory.t.sol` (pause / blacklist), `test/ToshV5.t.sol` (ladder halt)

This runbook is the operational counterpart of the on-chain kill switches. Every
switch named here is covered by `ToshV5FactoryTest` (100/100 green) and by the
`test_ladderHalt_*` group in `ToshV5Test` — this file is the **human procedure**
that those switches are designed to support.

> **Golden rule.** The platform must always be capable of stopping *new*
> launches in under 60 seconds. A pause does **not** halt live genesis
> deposits, already-launched pools, shelf mints, claims, or refunds. If at
> any point a responder cannot meet the 60-second bar for new launches,
> treat it as a P0 incident in its own right.
>
> **One exception, added in v5.0.** `haltLadderMinting` can stop shelf mints on
> projects that have already launched — and nothing else on them. It exists for
> one scenario: a defect in the shelf pricing itself, where every live project
> would otherwise keep selling supply against the bug. It expires on its own
> within 7 days, and it cannot touch swaps, LP, claims, or refunds. See
> Section 2b.

---

## 0. Severity classification

| Sev | Definition | Examples | Target acknowledge | Target halt |
|:---:|------------|----------|:-------------------:|:-----------:|
| **P0** | Funds at risk *right now*, or active exploit in flight. | Verified reentrancy, signer key compromise, oracle compromise producing inflated quotas, malicious code in the frontend bundle. | 5 min | 15 min |
| **P1** | Latent vulnerability with credible path to funds, but not yet weaponized. | Auditor reports a serious issue post-deploy, an admin private-key device is suspected stolen. | 30 min | 2 h |
| **P2** | Operational degradation, no funds at risk. | RPC outage, frontend down, individual launches stuck. | 2 h | n/a |
| **P3** | Cosmetic / UX issue. | Wrong copy, broken link, missing image. | 1 business day | n/a |

P0 and P1 are the only paths that may invoke `pause()` or `setBlacklist()`.
P2/P3 are handled in-band by ordinary engineering rotation.

---

## 1. On-call roster & contacts

> Replace the placeholders below **before** mainnet launch. Keep this section
> deliberately short — the lookup belongs in 1Password / your team's pager
> system, not a public repo.

| Role | Primary | Backup |
|------|---------|--------|
| Incident commander | `@<oncall-1>` | `@<oncall-2>` |
| Gnosis Safe signer #1 | `<sig-1>` (`<phone>`) | — |
| Gnosis Safe signer #2 | `<sig-2>` (`<phone>`) | — |
| Gnosis Safe signer #3 | `<sig-3>` (`<phone>`) | — |
| Comms lead | `@<comms>` | `@<comms-backup>` |
| Legal | `@<legal>` | — |

The pager rotation **must** be reachable around the clock for at least 90 days
post-launch.

---

## 2. P0 — Immediate-halt playbook

### Decision: should we pause?

Pause is the **safer** error. Bias toward pausing whenever you observe either:

1. ETH leaving `ladderTreasury` to anywhere other than a swap that burns to
   `0xdead`, or an unexpected balance drop in any hook.
2. A signed PoG attestation that is **not** present in the off-chain signer's
   audit log (= the signer key has been duplicated).
3. A `LaunchCreated` event from a transaction your monitoring couldn't trace
   back to a real `createLaunch` call (= storage corruption / impossible state).
4. A credible report from a security researcher / auditor of a concrete attack
   path on the deployed bytecode.

If any of the above hold, **page the on-call commander and execute Step 1 below
without further deliberation.** A false-positive pause costs honest users at
most a few minutes; a missed pause costs the entire treasury.

### Step 1 — Halt the factory (`< 60 seconds`)

The `pause()` setter is `onlyOwner`. On mainnet, the owner is the Gnosis Safe
(`PROD_OWNER_SAFE`). On Sepolia, the owner is the deployer EOA.

**Mainnet (Gnosis Safe path):**

1. Open the Safe app at `app.safe.global` for the protocol owner Safe.
2. New Transaction → Contract Interaction.
3. Address: `<FACTORY_ADDRESS>` (pinned in
   `soat-frontend/src/app/lib/factoryDeployments.ts`).
4. ABI: paste `ToshFactory` ABI; pick `pause()`; no args.
5. Submit. **Two signers must sign within 60 seconds.** The Safe is configured
   2-of-N for a reason — that is the lower bound of what you can ship.
6. Confirm on-chain via Etherscan: `factory.paused() == true`.

**Testnet (deployer EOA path):**

```bash
cast send $FACTORY_ADDRESS "pause()" \
  --rpc-url $TARGET_RPC \
  --private-key $PRIVATE_KEY
```

### Step 2 — Confirm what the halt actually covers

After `paused() == true`, **exactly two** surfaces revert with
`EnforcedPause()`:

- `factory.registerPoG(...)`
- `factory.createLaunch(...)`

> **`factory.deposit(...)` KEEPS WORKING.** It carries `nonReentrant` only —
> there is no `whenNotPaused` on it. A genesis round that was already open
> goes on taking ETH for its full window while the platform is paused. Pinned
> by `test_pause_doesNotBlockDepositIntoALiveRound`.
>
> This runbook previously listed `deposit` as a paused surface. It was wrong,
> and it was wrong in the most expensive direction: a responder reading it at
> 3am would believe they had stopped the inflow when they had not. **If your
> incident requires stopping money coming in, `pause()` is not sufficient** —
> you must additionally blacklist the depositing addresses (Section 3), and
> accept that you cannot stop an honest depositor from funding a round that is
> already live. That is the same de-centralisation promise that keeps refunds
> working; it cuts both ways.

`hook.refund()` is **intentionally not gated** — depositors who deposited
before the incident must keep their exit. Pinned by
`test_pause_doesNotBlockRefund` in `test/ToshV5Factory.t.sol`.

> **If you are blocking refunds, you have escalated the incident from "funds
> at risk" to "funds trapped". Roll back immediately.**

### Step 3 — Freeze the off-chain signer

If the incident is even *suspected* to involve the PoG signer key:

1. SSH (or kubectl / cloud-console) into the signer host and stop the
   sign-allocation API:
   ```bash
   systemctl stop tosh-sign-allocation
   # or, on Vercel / Cloud Run: scale to 0 via the dashboard
   ```
2. Pull the signer key from the KMS / secrets manager (rotate, don't delete —
   you may need it for forensic signature verification).
3. **Do not** call `factory.setPogSigner(...)` until you've decided on a
   replacement key. A half-rotated signer with the old key still hot is worse
   than a paused factory.

### Step 4 — Communicate

The commander writes a single short post in this exact order:

1. **#status channel** (internal): "Factory paused at block N. Cause:
   `<one-line>`. Updates here every 15 min."
2. **Public status page**: "Tosh Protocol is currently paused while we
   investigate a security report. Existing deposits remain refundable. We will
   update this page within 30 minutes."
3. **Twitter / X**: Link to the status page; **do not speculate on cause**.
4. **Discord**: Pin the status-page link in #announcements.

The first message must be out within 30 minutes of `pause()`. Silence is more
damaging than imperfect information.

### Step 5 — Investigate

While paused, the engineering team:

1. Forks the chain at the offending block in Anvil:
   ```bash
   anvil --fork-url $TARGET_RPC --fork-block-number <N-1>
   ```
2. Re-runs the suspicious transaction in isolation and reproduces the
   observable effect.
3. Writes a regression Foundry test for the exact attack vector in
   `test/ToshIncident_<DATE>.t.sol`. This test joins the permanent suite.
4. Drafts a fix (patch + redeploy / Safe-tx / config-rotation, in that
   preference order).

### Step 6 — Resume

`unpause()` follows the same Gnosis Safe path as `pause()`. **Do not unpause
until all four of the following hold:**

- [ ] Fix is merged to `main` and on the deployed factory (or the bug is
      operational and the underlying cause is removed).
- [ ] Regression test is green.
- [ ] Status-page post-mortem is published.
- [ ] At least one signer outside the engineering org has signed off on the
      unpause transaction.

After unpause, atomic restoration of `registerPoG` and `createLaunch` is
guaranteed by the contract (`test_unpause_restoresAllPaths` in
`test/ToshV5Factory.t.sol`) — you do not need to manually verify each surface.
`deposit` needs no restoration because it was never paused; see the golden rule
above.

---

## 2b. P0 — Ladder halt playbook (shelf pricing defect)

`pause()` cannot reach a launched project. `haltLadderMinting` can, and it is
the **only** switch that can. Use it for exactly one class of incident: **the
shelf pricing or the price gate itself is defective**, so every live project is
selling supply against a bug and asking buyers to stop is not a plan.

Do **not** reach for it for anything else. A single misbehaving market, a
whale, an unhappy creator, a price you dislike — none of those are this switch.

### What it does and does not touch

| Halted | Untouched |
|---|---|
| `hook.mintBondingCurve(...)` → `LadderMintingHalted()` | pool swaps (buy and sell) |
| `hook.maxMintable()` → reports `0`, so the UI agrees with the guard | retail LP add / remove |
| | `hook.claimGenesis()` |
| | `hook.claimReferralReward()` |
| | `hook.refund()` |
| | `factory.deposit(...)` into a live round |

**A halt costs a buyer an opportunity. It can never cost anyone a balance.**
If you ever find a path where a halt traps funds, that is a P0 in its own
right — roll it back and page the commander.

### Step 1 — Choose the scope

```text
haltLadderMinting(address(0), duration)   // every project
haltLadderMinting(<hook>,    duration)    // that project only
```

Prefer the narrow form. Global halt is for a defect in the pricing code that is
shared by every hook; a single compromised market does not justify taking the
whole platform's Phase 2 offline.

### Step 2 — Choose the duration

`duration` is in **seconds**, must be non-zero, and must be `<= 7 days`
(`MAX_HALT_DURATION`, else `HaltDurationTooLong()`). It is a deadline, not a
flag: **the halt lapses on its own**, and re-arming is a fresh on-chain
transaction that anyone can see.

Pick the shortest duration that plausibly covers diagnosis. 24 h is the normal
opening bid; escalate by re-arming rather than by starting at 7 days.

**Testnet (deployer EOA path):**

```bash
# halt every ladder for 24 hours
cast send $FACTORY_ADDRESS "haltLadderMinting(address,uint256)" \
  0x0000000000000000000000000000000000000000 86400 \
  --rpc-url $TARGET_RPC --private-key $PRIVATE_KEY

# confirm
cast call $FACTORY_ADDRESS "ladderMintingHalted(address)(bool)" $HOOK_ADDRESS \
  --rpc-url $TARGET_RPC
```

**Mainnet:** Gnosis Safe → Contract Interaction → `haltLadderMinting`, same
2-of-N signing bar as `pause()`.

### Step 3 — Communicate, in this order

Shelf minting stopping is visible to users immediately (the mint button locks
and reads `[ladder_halted]`), so the announcement window is tighter than for a
factory pause. Post within **15 minutes**, and state three things explicitly:
what is halted, what is *not* halted (trading, claims, refunds all continue),
and when the halt expires on its own.

### Step 4 — Resume

```bash
cast send $FACTORY_ADDRESS "resumeLadderMinting(address)" $HOOK_ADDRESS \
  --rpc-url $TARGET_RPC --private-key $PRIVATE_KEY
```

Letting a halt lapse silently is acceptable for a false positive. For a real
incident, resume **explicitly** and publish the post-mortem in the same hour —
an expiring halt that nobody narrated looks identical to an owner who lost
their keys.

---

## 3. P0/P1 — Targeted blacklist playbook

When a **specific address** is the threat vector but the protocol as a whole is
sound, `setBlacklist` is the surgical tool. Use it when you can name the bad
actor's address(es) precisely.

### Step 1 — Confirm the target

The blacklist is **global** (covers every hook, every future hook) and
**defence-in-depth** — applies on every deposit, regardless of pre-registered
PoG quota (`test_blacklist_blocksAttackerAcrossAllHooks`,
`test_blacklist_blocksEvenAfterPreRegisteredQuota`,
`test_deposit_blockedWhenBlacklisted` in `test/ToshV5Factory.t.sol`).

False-positive cost is real (banned user cannot deposit anywhere), so the
target list goes through:

1. Confirmed on-chain heuristic (e.g., funded from a known sanctioned mixer,
   or signed an attestation that is rejected as forged).
2. Cross-sign by **two** engineers via Slack screenshot of the address.
3. Commander records the rationale in the incident doc **before** signing.

### Step 2 — Choose a ban duration

```text
1 day      = 86_400                   // Sybil sweep, low-confidence
24 hours       86_400                  // (alias)
7 days     = 604_800                  // Repeat offender
365 days   = 31_536_000               // Confirmed exploit attempt
permanent  = type(uint256).max
           = 115792089237316195423570985008687907853269984665640564039457584007913129639935
```

Permanent ban truly never expires — `setBlacklist` stores the
`type(uint256).max` sentinel verbatim instead of adding it to `block.timestamp`
(`test_setBlacklist_permanentSentinel` in `test/ToshV5Factory.t.sol`). It is a
one-way switch unless
followed by an explicit `liftBlacklist(...)`.

### Step 3 — Apply

```bash
# 24h ban on two addresses
cast send $FACTORY_ADDRESS \
  "setBlacklist(address[],uint256)" \
  "[0xBAD1...,0xBAD2...]" \
  86400 \
  --rpc-url $TARGET_RPC \
  --private-key $PRIVATE_KEY   # or Safe path on mainnet
```

The factory accepts batches up to the contract-declared limit
(`MAX_BLACKLIST_BATCH`, currently 100). Larger batches must be split.

### Step 4 — Verify

```bash
cast call $FACTORY_ADDRESS "blacklistedUntil(address)(uint256)" 0xBAD1...
```

Should return a non-zero unix timestamp ≥ `block.timestamp + banDuration`
(or `2^256-1` for the permanent sentinel).

### Step 5 — Restore (when applicable)

```bash
cast send $FACTORY_ADDRESS \
  "liftBlacklist(address[])" \
  "[0xBAD1...]" \
  --rpc-url $TARGET_RPC \
  --private-key $PRIVATE_KEY
```

Lift is **immediate** — same-block deposits succeed
(`test_liftBlacklist_immediatelyRestores` in `test/ToshV5Factory.t.sol`). No
second-block waiting period. A ban also lapses on its own when its duration
expires (`test_blacklist_expiresAfterBanDuration`), so a lift is only needed to
end one early.

---

## 4. P0 sub-playbook — PoG signer key compromise

The signer key holds **only** the right to mint user quota allocations — it
cannot move funds. The compromise scenario is therefore "attacker can issue
themselves a 200-SATO `maxAlloc` and deposit using it". Cap surface:

| Quantity | Value | Worst-case attacker gain (per signed attestation) |
|----------|-------|----------------------------------------------------|
| `MAX_ALLOC_SATO_WEI` | 200 SATO | 200 SATO deposited per wallet, once. |
| `maxPogAllocationLimit` (factory) | configured limit | Hard ceiling regardless of signer behaviour. |

Even with a fully-compromised signer, total damage is bounded by
`maxPogAllocationLimit × N_unique_attackers`. This is **not** a treasury-loss
event — but it is still a P0 because it breaks the integrity claim of PoG
attestation.

### Procedure

1. **Pause the factory** (Section 2).
2. **Stop the sign-allocation API** (Section 2 Step 3).
3. Generate a fresh signer key in the KMS (`rotate-pog-signer.yml` Ansible
   playbook, if you have one).
4. From the Gnosis Safe:
   ```text
   factory.setPogSigner(<new-signer-address>)
   ```
5. Re-deploy / re-configure the sign-allocation API with the new key.
6. **Unpause** the factory.

> **Do not** call `setPogSigner` while the API is still hot with the old key —
> there is a (small) window where the API would sign an attestation that the
> contract immediately rejects, surfacing to users as `InvalidSignature` errors
> rather than the proper "PoG service unavailable" maintenance message.

---

## 5. P0 sub-playbook — Factory owner key compromise

This is the **hardest** scenario. If the EOA / Safe that owns the factory is
compromised, the attacker can:

- `pause()` permanently — DoS on new launches only. In-flight genesis rounds
  keep taking deposits and every project already launched is untouched.
- `haltLadderMinting(0x0, 7 days)` on repeat — a **rolling** DoS on shelf
  minting across the platform. Bounded by design: each halt lapses after at
  most 7 days, so the attacker must keep re-arming in public, on-chain, and
  they still cannot touch swaps, LP, claims, or refunds. Treat it as a loud
  nuisance, not a fund-loss event, and let it inform how fast you must
  complete the ownership migration below.
- `setPlatformTreasury(<their-address>)` — **no effect.** This is a v4.x
  leftover that no longer sits on any money path; all platform revenue goes to
  the immutable `ladderTreasury`. Do not spend incident time on it.
- `addLadderToken(<token>)` — the strongest treasury vector they have, and it
  is bounded: `addLadderToken` only accepts tokens this factory launched and
  derives the buyback pool from the token's own hook, so the attacker cannot
  point buybacks at a pool they control. The worst case is buyback pressure
  steered toward a legitimately-launched token they happen to hold.
  **Curation policy:** only list a token after `launch()` has succeeded and
  the project is not under an active incident; prefer FIFO listing of every
  live Tosh pool rather than picking winners. `removeLadderToken` is for
  hostile or bricked pools, not for starving a competitor of buyback flow.
  Both calls are owner-gated and should go through the Safe.
- `setPogSigner(<their-key>)` — escalates to the signer-compromise scenario.
- `setLaunchFee(0)` or `setLaunchFee(huge)` — UX-only damage.
- `setBlacklist([...everyone...], permanent)` — DoS, not theft.

**Hookpaths cannot be exploited via the factory owner** — once a hook is
deployed, the launchpad logic is closed and the owner cannot reach into it.

### Procedure

1. Confirm the suspected key actually wrote the suspicious transaction by
   inspecting `tx.origin` and signature recovery on the offending tx.
2. From the **outgoing** owner (if still controlled by the legitimate
   operator):
   ```text
   factory.transferOwnership(<rescue-address>)
   ```
   then have the rescue address call `acceptOwnership()`.
3. If the legitimate operator no longer controls the key, the protocol is in
   the **frozen end-state**: existing deposits still refund (hook is
   self-contained), but `createLaunch` is permanently in the attacker's hands.
   Communicate this to users immediately — there is no on-chain recovery
   path.

This is why the mainnet deploy script (`script/DeployMainnet.s.sol`) forces a
two-step `transferOwnership` to a Gnosis Safe at deploy time. **Never deploy
the factory with the deployer EOA retaining ownership in production.**

---

## 6. P2 — RPC / frontend outage playbook

These are operational, not security, but they still trigger the on-call rota.

### 6a. RPC outage

Symptom: users report "transaction won't broadcast" or wagmi hooks return
infinite pending. The `providers.tsx` config now uses `fallback()` over a
ranked list (item #24 on the pre-mainnet checklist), so a single endpoint
flapping is handled silently.

If **all** legs are down:

1. Add a new premium endpoint to `NEXT_PUBLIC_BASE_SEPOLIA_RPC` (or
   `NEXT_PUBLIC_ETHEREUM_RPC` for mainnet) in the deployment env.
2. Redeploy the frontend.
3. Public status update: "Some users are experiencing RPC errors; engineering
   is rolling out a fix. No funds are affected."

### 6b. Frontend outage

The factory does not depend on the frontend. Users with their own RPC + ABI
can interact with the factory directly via `cast` (`createLaunch`, `deposit`,
`refund`, …). Status page should link to:

- `docs/MANUAL_INTERACTION.md` (operator-supplied)
- The factory address on Etherscan

…so determined power-users can still operate.

---

## 7. Post-incident — within 7 days

After **every** P0/P1 incident:

1. **Public post-mortem** on the status page: timeline, root cause, fix,
   prevention. No blame on individuals; full transparency on the technical
   chain of events.
2. **Regression test** committed to `test/`. The test must FAIL on the buggy
   commit and PASS on the fix.
3. **Audit re-engagement** if the root cause was code-level. The external
   auditor should review the patch on a paid hourly basis, not gratis.
4. **Runbook update** — this document — capturing any new learning. Date the
   update at the top so future responders can see how the playbook evolved.

---

## 8. Drill schedule

Untested kill switches are theatre. Drill the runbook quarterly:

| Quarter | Drill | Pass criteria |
|--------:|-------|---------------|
| Q1 | Full-factory pause on Sepolia, communicate, unpause. | `pause()` → public status page → `unpause()` within 30 min, with at least one new signer participating. |
| Q2 | Targeted blacklist of a fake exploit address on Sepolia. | Two-engineer sign-off recorded, `setBlacklist` executed, `liftBlacklist` after 1 h. |
| Q3 | PoG signer rotation on Sepolia. | New signer key in KMS, `setPogSigner` executed via Safe, sign-allocation API redeployed and serving. |
| Q4 | Full red-team: external attacker tries a forged PoG attestation against the Sepolia deployment for 2 h. | All attempts fail at `_verifyPoGSignature`; on-call detects within 15 min via Defender alert. |

Record drill outcomes in the incident-response log even if no real incident
occurred. The presence of a quarterly cadence is itself evidence of
operational maturity.

---

## 9. Quick-reference cheat sheet

```text
┌────────────────────────────────────────────────────────────────────────┐
│  TOSH PROTOCOL — INCIDENT QUICK REFERENCE                              │
├────────────────────────────────────────────────────────────────────────┤
│  HALT NEW LAUNCHES      Gnosis Safe → factory.pause()                  │
│  RESUME                 Gnosis Safe → factory.unpause()                │
│  HALT SHELF MINTS       factory.haltLadderMinting(hook|0x0, seconds)   │
│                         0x0 = all projects · max 86400*7 · auto-expires│
│  RESUME SHELF MINTS     factory.resumeLadderMinting(hook|0x0)          │
│  BAN ADDRESS (24 h)     cast send … setBlacklist([…], 86400)           │
│  BAN ADDRESS (forever)  cast send … setBlacklist([…], 2^256-1)         │
│  UN-BAN                 cast send … liftBlacklist([…])                 │
│  ROTATE PoG SIGNER      pause → stop API → setPogSigner → restart API  │
│                         → unpause                                      │
│  DELIST BUYBACK TOKEN   Gnosis Safe → treasury.removeLadderToken(…)    │
│                                                                        │
│  PAUSE IS NARROW.  It stops createLaunch and registerPoG.  THAT IS     │
│  ALL.  It does NOT stop deposits into a live genesis round — deposit   │
│  has no whenNotPaused — and it does NOT touch any project already      │
│  launched: not swap, not claim, not refund, not LP.  That is the       │
│  de-centralisation promise: once the platform has taken money for a    │
│  round, it cannot starve it.  A round fails by missing its soft cap,   │
│  not by an owner switch.                                               │
│                                                                        │
│  IF YOU NEED TO STOP MONEY COMING IN, PAUSE IS NOT ENOUGH.  Blacklist  │
│  the addresses (§3).  You cannot stop an honest depositor funding a    │
│  round that is already open.                                           │
│                                                                        │
│  ONE SWITCH REACHES A LAUNCHED PROJECT: haltLadderMinting.  It stops   │
│  mintBondingCurve and nothing else, and it expires within 7 days.      │
│  Use it only for a defect in shelf pricing itself.  See §2b.           │
│                                                                        │
│  REFUNDS WORK DURING PAUSE AND DURING A LADDER HALT.  Intentional.     │
│  Pinned by test_pause_doesNotBlockRefund in test/ToshV5Factory.t.sol.  │
│  If you break this you've turned a brake into a hostage situation.     │
└────────────────────────────────────────────────────────────────────────┘
```

---

*Last updated: 2026-08-25 (v5.0 — ladder halt playbook §2b; corrected the pause
boundary: `deposit` is NOT paused; owner-compromise section covers rolling
halts).*
