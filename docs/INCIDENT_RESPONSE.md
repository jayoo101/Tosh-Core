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

### 1.1 Safe threshold — the decision, and what depends on it

**Decided 2026-09-03: 2-of-3.** Three signers, two signatures to execute. The
three signer rows above are sized for exactly that.

This is not only an operational preference. `docs/PRD-v5.0.md` §11 D2 declines
to put a timelock on `addLadderToken` / `removeLadderToken`, and states its
premise openly: the final owner is a Safe at **2/N or stricter**, whose
propose-and-approve flow is what D2 uses *instead of* a timelock. D2's own
review trigger ① says that if the owner ever degrades to a single EOA or a 1/N
Safe, the decision lapses and a timelock must be added immediately. 2-of-3
satisfies the premise with no margin above it — dropping one signer would put
the owner at 2/2, where a single unreachable signer freezes every emergency
control, and lowering the threshold would void D2.

**Status: decided, not yet executed.** The Safe does not exist yet (PM-D4), so
nothing above is on chain. This section records the intent so the premise is
auditable rather than remembered; D2 trigger ③ asks for the *actual* N and
threshold to be recorded here once ownership transfer completes (PM-C2), and
that is a separate edit against a deployed address.

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
(`PROD_OWNER_SAFE`). On Robinhood testnet (chain 46630), the owner is the
deployer EOA — that is the path the first drill used (§8.1).

**Mainnet (Gnosis Safe path):**

1. Open the Safe app at `app.safe.global` for the protocol owner Safe.
2. New Transaction → Contract Interaction.
3. Address: `<FACTORY_ADDRESS>` — the value of `NEXT_PUBLIC_FACTORY_ADDRESS`
   on the live deployment, read by `soat-frontend/src/lib/contracts.ts`. There
   is no `factoryDeployments.ts`; a previous version of this step named a file
   that does not exist, which a responder at 3am would have lost minutes to.
4. ABI: paste `ToshFactory` ABI; pick `pause()`; no args.
5. Submit. **Two signers must sign within 60 seconds.** The Safe is configured
   2-of-N for a reason — that is the lower bound of what you can ship.
6. Confirm on-chain: `cast call $FACTORY_ADDRESS "paused()(bool)" --rpc-url $RPC`
   must return `true`. The explorer is
   `https://explorer.testnet.chain.robinhood.com` on the rehearsal chain and
   whatever the mainnet cutover names; it is not Etherscan.

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
2. Pull the signer key from Vercel Production (rotate, don't delete —
   you may need it for forensic signature verification). The production store
   is an encrypted env var, not KMS (`PRE_MAINNET_CHECKLIST.md` §4.1).
3. **Do not** call `factory.setPogSigner(...)` until you've decided on a
   replacement key. A half-rotated signer with the old key still hot is worse
   than a paused factory.

### Step 4 — Communicate

The commander writes a single short post in this exact order:

1. **#status channel** (internal): "Factory paused at block N. Cause:
   `<one-line>`. Updates here every 15 min."
2. **Public status page** — <https://jayoo101.github.io/tosh-status/>, source
   at `jayoo101/tosh-status`. Set `STATUS = 'paused'` in `index.html`, add the
   one specific fact to `DETAIL`, stamp `UPDATED`, commit to `main`. Pages
   rebuilds in about a minute. **Do not compose prose here under stress:** the
   wording below is already in the page as the `paused` copy, verbatim, and
   rewording one without the other is how the page and this playbook start
   contradicting each other while a responder reads both.

   > "Tosh Protocol is currently paused while we investigate a security
   > report. Existing deposits remain refundable. We will update this page
   > within 30 minutes."

   The page also reads `paused()` off the chain by itself and prints the
   result, so the one fact that matters is right even in the minutes before
   you get to it — and if your banner and the chain disagree, the page says so
   and names the chain as the authority rather than quietly showing one.

   It is hosted on GitHub Pages, deliberately sharing nothing with the
   application: a page served from the same Vercel project would be down or
   compromised in the §0 P0 case that names a malicious frontend bundle.
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

`setBlacklist` and `liftBlacklist` both cap the batch at **200** addresses
(a hard-coded `require(users.length <= 200, "Batch too large")` — there is no
named constant to read on-chain). Larger batches must be split.

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
cannot move funds. The compromise scenario is therefore "attacker signs
themselves the maximum `maxAlloc` on as many wallets as they like, and deposits
with it". Cap surface:

| Quantity | Value | What bounds the attacker |
|----------|-------|--------------------------|
| `maxPogAllocationLimit` (factory) | `0.1 ether` by default; `setMaxPogAllocationLimit` changes it | `registerPoG` reverts with `ExceedsGlobalPogLimit` above this, whatever the signer signed. |
| `perWalletCap` (per hook, immutable) | snapshotted from `maxPogAllocationLimit` when the hook was deployed | `PerWalletCapExceeded` on deposit. Lowering the factory limit does **not** retroactively tighten live hooks. |
| `MAX_SIG_VALIDITY` | `24 hours` | Attestations signed before rotation stop working within a day. |

> **This table said `MAX_ALLOC_SATO_WEI = 200 SATO` until 2026-08-26. That
> constant does not exist.** v5.0 is 100% ETH-native and the cap is
> `maxPogAllocationLimit`, denominated in ETH wei. A responder who went looking
> for the old constant during an incident would have found nothing.

Damage is bounded by `perWalletCap × N_attacker_wallets`, and the ETH is a real
deposit into a real genesis round — it is refundable, and it buys the attacker
an outsized share of that round rather than a withdrawal. This is **not** a
treasury-loss event, but it is still a P0 because it breaks the integrity claim
of PoG attestation and lets one actor capture a launch.

### Procedure

1. **Pause the factory** (Section 2).
2. **Stop the sign-allocation API** (Section 2 Step 3).
3. Generate a fresh signer key. Write it to Vercel Production as
   `POG_SIGNER_PRIVATE_KEY` and nowhere else — not a laptop `.env`, not
   GitHub Actions. There is no Ansible playbook for this.
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
- `setPlatformTreasury(<their-address>)` — **the function does not exist.** It
  was deleted when `platformTreasury` went back onto a money path: it now takes
  0.30% of the ETH input of every buy, and a mutable fee-routing target was
  audit finding M-2. The field is `immutable` on the factory and the same
  address is baked into the hook implementation as `platformFeeRecipient`, so
  an attacker with the owner key **cannot** redirect that revenue stream. The
  other three platform pipes (launch fees, the shelf cut, orphaned referral
  commission) still go to the immutable `ladderTreasury`. Nothing to do here.
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
ranked list (item #24 on the pre-mainnet checklist = **PM-F2** in
`docs/PRE_MAINNET_CHECKLIST.md`), so a single endpoint flapping is handled
silently.

If **all** legs are down:

1. Add a new premium endpoint to `NEXT_PUBLIC_ROBINHOOD_TESTNET_RPC` (or
   `NEXT_PUBLIC_ROBINHOOD_RPC` / `NEXT_PUBLIC_RPC_URL` for mainnet) in the
   deployment env. The Base-era names (`NEXT_PUBLIC_BASE_SEPOLIA_RPC`,
   `NEXT_PUBLIC_ETHEREUM_RPC`) are not read by `providers.tsx` or
   `serverRpc.ts` and setting them would do nothing.
2. Redeploy the frontend.
3. Public status update: "Some users are experiencing RPC errors; engineering
   is rolling out a fix. No funds are affected."

### 6b. Frontend outage

The factory does not depend on the frontend. Users with their own RPC + ABI
can interact with the factory directly via `cast` (`createLaunch`, `deposit`,
`refund`, …). Status page should link to:

- `docs/MANUAL_INTERACTION.md` — every user-side action as a `cast` command,
  including the refund path, which needs nothing from us
- The factory address on the chain explorer (Robinhood testnet:
  `https://explorer.testnet.chain.robinhood.com`)

…so determined power-users can still operate.

> **⚠ This step cannot be executed as written.** The status page links the
> factory, but not `MANUAL_INTERACTION.md`, because `jayoo101/Tosh-Core` is a
> **private** repository — the raw URL returns 404 to the users this step
> exists to help. All 463 lines of that file are user-facing (reads, deposits,
> the refund path, revert decoding, a safety checklist) and none of it is
> operator-only, so nothing about the content justifies it being unreachable;
> it simply lives in the wrong place for the job this playbook gives it.
> Publishing it somewhere public is an open decision, and until it is made,
> a frontend outage leaves users with the explorer and nothing that tells
> them what to send it.

---

## 6c. P2 — Buyback reservoir armed but idle (STATE-06)

**This is a chore, not an incident.** No funds are at risk, nothing is
compromised, and the fix needs no key you have to protect. It is in this document
only because STATE-06 pages a ticket at somebody, and that somebody should find
the answer here rather than reverse-engineer it.

**Symptom.** `monitoring/alerts.json` STATE-06 fires: the treasury has held at
least `TRIGGER_STEP` (1 ETH) for 24 hours with no `PiggybackExecuted` in the
window.

**What it means.** The gas gate in `ToshLaunchpadHook.afterSwap` is doing its
job. A poke only rides a swap that can afford it, and swaps are arriving with
limits too tight to carry one. Nothing is broken; the reservoir is simply not
being deployed by trading alone. There is no event for a skipped poke, which is
why this had to be a balance poll.

**Fix.**

```bash
cast send $TREASURY "pokeBuyback()" --rpc-url $RPC --private-key $PK
```

Permissionless. No Safe transaction, no role, and it can safely be handed to a
keeper or a cron job — it moves no ETH to the caller, picks its venue from the
listed token's own hook, its size from the balance, its order from the cursor,
and is bounded by the same TWAP floor as any other leg.

Each call runs one buy leg (`LEGS_PER_POKE`), so a fully armed reservoir with
three listed tokens wants three calls to complete a cycle. Repeat until it
reverts `NotArmed`, which is the signal that the reservoir has dropped below the
trigger.

**When to escalate instead.** If `pokeBuyback()` itself reverts with something
other than `NotArmed` or `PiggybackInProgress`, or if `BuybackSkipped` is firing
for most of the curated set (SILENT-02), the problem is a broken ladder pool
rather than a gas gate. That is a curation question — see §5's notes on
`removeLadderToken`.

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
| Q1 | Full-factory pause on Robinhood testnet, communicate, unpause. | `pause()` → public status page → `unpause()` within 30 min, with at least one new signer participating. |
| Q2 | Targeted blacklist of a fake exploit address on Robinhood testnet. | Two-engineer sign-off recorded, `setBlacklist` executed, `liftBlacklist` after 1 h. |
| Q3 | PoG signer rotation on Robinhood testnet. | New signer key in Vercel Production only, `setPogSigner` executed via Safe, sign-allocation API redeployed and serving. |
| Q4 | Full red-team: external attacker tries a forged PoG attestation against the Robinhood testnet deployment for 2 h. | All attempts fail at `_verifyPoGSignature`; on-call detects within 15 min via Defender alert. |

> **The rehearsal chain is Robinhood testnet, chain id 46630.** Every row above
> said "Sepolia" until 2026-09-03, which was correct while the project targeted
> Base and then Ethereum, and became wrong when it moved to Robinhood Chain
> (`docs/ROBINHOOD_MIGRATION.md`). A drill rehearses the deployment you are
> going to have to defend; rehearsing on a chain this protocol is no longer
> deployed to would exercise the human steps and none of the chain-specific
> ones — and `_blockNumber()` reading `ArbSys` instead of `block.number` is
> exactly the kind of difference a drill is supposed to surface.

> **Q4 cannot be run as written yet.** Its success criterion names a Defender
> alert, and there will not be one: on-chain alerting is **PM-E2** in
> `docs/PRE_MAINNET_CHECKLIST.md`, and it is served by `monitoring/watch.mjs`
> against the chain's own RPC rather than by a vendor
> (`ONCHAIN_MONITORING.md` §7.1). Detection is therefore built and rehearsed —
> but nothing schedules it and no P0 has anywhere to land, so an alert still
> cannot reach a human unattended. Rewrite Q4's criterion to name the watcher,
> and run it only once that watcher has a host and a sink. The
> frontend error
> monitoring that *was* wired (Sentry, PM-E1) reports browser and API-route
> errors — it sees nothing on chain, and a forged-attestation attempt that
> reverts inside the contract produces no frontend error at all. Either complete
> PM-E2 before scheduling Q4, or run Q4 with manual log inspection and record
> that the detection half was not exercised. Do not mark the drill passed on the
> strength of the attempts failing; the attempts failing is the *contract*
> working, not the *response* working.

Record drill outcomes in the incident-response log even if no real incident
occurred. The presence of a quarterly cadence is itself evidence of
operational maturity.

### 8.1 First drill — 2026-09-03, Q1 mechanical half on chain 46630

Factory `0x2E690A91b383eDB21f6b5B4180Cc4a2C905C6BeA`, owner the deployer EOA
`0x73db078fa94607893270079AC8F5c7492aB480cd`. The Safe does not exist
(PM-D4), so this used the testnet EOA path in Step 1, not the mainnet Safe
path. That is the honest scope: the contract's pause boundary was rehearsed;
the 2-of-3 signing bar was not.

| | tx | block | gas | wall |
|---|---|---|---|---|
| `pause()` | [`0x2cf52249…`](https://explorer.testnet.chain.robinhood.com/tx/0x2cf522492d781143dbe1ff3340914bb5dab5efa67c9416df053ab133ee641e6c) | 112415196 | 52,274 | 5 s |
| `unpause()` | [`0xd8a535bc…`](https://explorer.testnet.chain.robinhood.com/tx/0xd8a535bce516db1646d60aa5a1389fd944526b8065cf460af978540a9632645e) | 112415489 | 29,836 | 4 s |

293 blocks between them, ~29 s on a 100 ms chain. The 60-second halt bar and
the 30-minute Q1 window both hold for the on-chain half.

Each user-facing surface was probed with `cast call` (so no state change, and
the same command a responder would type) before, during, and after:

| Surface | before | during pause | after unpause |
|---|---|---|---|
| `factory.createLaunch` | (parser / would be `FeeChanged` on `expectedFee=0`) | **`EnforcedPause`** | `FeeChanged` (`0x2f0a5ab4`) |
| `factory.registerPoG` | `SignatureExpired` | **`EnforcedPause`** | `SignatureExpired` |
| `factory.deposit` | `ZeroAmount` | `ZeroAmount` | `ZeroAmount` |
| `hook.refund` | `Already launched` | `Already launched` | `Already launched` |
| `hook.claimGenesis` | `AlreadyClaimed` | `AlreadyClaimed` | `AlreadyClaimed` |

`deposit` is the row this drill existed to confirm. The modifier order is the
whole argument: `whenNotPaused` runs before the function body, so if `deposit`
carried it, a paused call would have to revert `EnforcedPause` and could not
reach `ZeroAmount`. It reached `ZeroAmount` in all three states. A responder
who paused to stop money coming in would have stopped nothing.

`createLaunch` after unpause reverting `FeeChanged` rather than
`EnforcedPause` is the restore: the call got past the modifier and into the
body, where `launchFee > expectedFee` (we passed 0) fires first. Same shape as
`test_unpause_restoresAllPaths`, measured on the chain a drill is supposed to
use.

The launched hook `0x90FDE02D9786C84198c21d2947C42D2C16c4fFDf` was the
refund/claim subject. Both kept their own errors through the pause, which is
the other half of the golden rule: `pause()` does not reach a project that has
already launched.

**Q1 pass criteria, scored honestly:**

- `pause()` then `unpause()` within 30 min — **met**, 29 s.
- Public status page — **not exercised at the time; the page now exists.**
  When this sitting ran, Step 4 named four channels (`#status`, a public status
  page, Twitter/X, Discord #announcements) and none of them existed, so the
  comms half would have been posting into the void. One of the four is now
  live at <https://jayoo101.github.io/tosh-status/> — the only one of the four
  that was engineering rather than an account signup. The remaining three are
  still absent, so Step 4 is still not executable end to end, and this line
  does not become a pass until a drill actually posts to the page and back.
- At least one new signer participating — **not exercised**. Single EOA, no
  Safe. The 2-of-3 bar in Step 1 is still theatre until PM-D4.

Do not read this sitting as a passed Q1. It is a dated rehearsal of the
on-chain half, and it is the half that had been written wrong once already
(`deposit` used to be listed as paused). The human half is PM-E4 and PM-D4.

Three stale pointers this sitting found and corrected in the same file:

- Step 1 still said "On Sepolia, the owner is the deployer EOA" after §8 had
  been rewritten to Robinhood testnet.
- Step 1 named `soat-frontend/src/app/lib/factoryDeployments.ts`, which does
  not exist. The address lives in `NEXT_PUBLIC_FACTORY_ADDRESS`, read by
  `soat-frontend/src/lib/contracts.ts`.
- §6a told a responder to set `NEXT_PUBLIC_BASE_SEPOLIA_RPC` /
  `NEXT_PUBLIC_ETHEREUM_RPC`, which `providers.tsx` and `serverRpc.ts` do not
  read. The names that work are `NEXT_PUBLIC_ROBINHOOD_TESTNET_RPC`,
  `NEXT_PUBLIC_ROBINHOOD_RPC`, and the chain-agnostic `NEXT_PUBLIC_RPC_URL`.
- §6b linked "the factory address on Etherscan". The rehearsal chain's
  explorer is Blockscout at `explorer.testnet.chain.robinhood.com`.

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
│  POKE BUYBACK           cast send $TREASURY "pokeBuyback()"            │
│                         NO ROLE NEEDED — anyone, no Safe tx.  Use when │
│                         STATE-06 fires (reservoir ≥1 ETH, idle 24h).   │
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

*Last updated: 2026-09-03 (first drill, §8.1: pause/unpause on 46630, deposit
confirmed ungated, three stale pointers in Step 1 and §6a corrected.)*

*Previously: 2026-08-25 — ladder halt playbook §2b; corrected the pause
boundary (`deposit` is NOT paused); owner-compromise section covers rolling
halts.*
