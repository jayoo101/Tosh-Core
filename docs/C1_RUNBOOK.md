# PM-C1 — deploy day runbook

**One irreversible broadcast, executed once, under time pressure.** That is the
whole reason this file exists separately from `PRE_MAINNET_CHECKLIST.md`: the
checklist argues about *what* and *why*, and on the day you need *in what order,
and how do I know the last step worked*.

Every command below was checked against this repository and this machine on
2026-09-06. Where a documented instruction was wrong, it is corrected here and
in the source it came from — see §6.

---

## 0. State on 2026-09-06, so you can tell what has moved

| | |
|---|---|
| Owner Safe | `0x2953957774482efA660921df85A1E7634ccfe27A` — 1.4.1, 2-of-3, owner set matches `safe-owners.json`, indexed by the transaction service as `1.4.1+L2`, accepts plain ETH at ~27,674 gas. Re-verify with `node scripts/verifyOwnerSafe.mjs <addr>` |
| `.env.production` | Exists. `PLATFORM_TREASURY` and `PROD_OWNER_SAFE` filled with the Safe above; `TARGET_CHAIN_ID`, `V4_POOL_MANAGER`, both RPC lines carried from the template |
| Still `REPLACE_ME` | `PRIVATE_KEY`, `POG_SIGNER_ADDRESS` — steps 1 and 2 |
| C1 cost | 14,580,627 gas (re-summed from the 46630 rehearsal receipts). At 0.4009 gwei that is **~0.005845 ETH**; fund to **~0.0117 ETH** for the 2x margin |
| Deployer balance | There is no mainnet deployer yet. `0x73db078f…` is the **testnet** deployer and §4.1 forbids reusing it — do not fund it |

## 1. Generate the deployer EOA

```bash
cast wallet new
```

Prints an address and a private key. Put the **private key** in
`.env.production` as `PRIVATE_KEY=0x…` and keep the address — step 3 funds it.

This one does have to live in a local file: `DeployMainnet.s.sol:87` reads it
with `vm.envUint("PRIVATE_KEY")`, so an encrypted keystore (`cast wallet new
<path>`) does not fit this script. That is acceptable for this role and only
this role — the deployer is a temporary identity that holds ~0.012 ETH, signs
once, and is powerless the moment the Safe accepts in step 6. The PoG key in
step 2 is the opposite case.

The key is printed to the terminal, not typed, so it does not enter PowerShell's
PSReadLine history. It is in the scrollback buffer. Close that window when done.

**Verify by reading, not by deriving.** `cast wallet new` prints the address next
to the key, so no derivation is needed — check by eye that it is not
`0x73db078f…`. Resist the obvious `cast wallet address --private-key <key>`: it
puts a live mainnet key on a command line, and command lines are what shell
history records.

The machine check comes in step 4. `preflightMainnet.mjs` derives the deployer
from `PRIVATE_KEY` in `.env.production` and asserts it differs from the PoG
signer, the Safe and the treasury — the same four assertions
`requireDistinctRoles` would make mid-broadcast.

## 2. Generate the PoG signer EOA

```bash
cast wallet new
```

Different rules from step 1, and the difference is the point:

- The **address** goes in `.env.production` as `POG_SIGNER_ADDRESS=0x…`.
- The **private key** goes into Vercel Production as `POG_SIGNER_PRIVATE_KEY`,
  marked Sensitive, scoped to **Production only** so preview builds fail closed —
  the same treatment `BLOCKSCOUT_API_KEY` got on 2026-09-05.
- The private key is written to **no local file**. Not `.env`, not
  `.env.production`, not `soat-frontend/.env.local`. `PRE_MAINNET_CHECKLIST.md`
  §4.1 calls a mainnet key in any of those a failed cutover.

The address and key come from the same `cast wallet new` output, so they match by
construction. Nothing checks that afterwards — `preflightMainnet.mjs` says so in
its closing lines, and the first place a mismatch shows is every depositor
getting `InvalidSignature` after launch.

**This key must not be the deployer.** `requireDistinctRoles` reverts
mid-broadcast on a collision, and `.env` today has exactly that collision, which
is why step 4 exists.

## 3. Fund the deployer

Send at least **0.0117 ETH** to the step-1 address on chain **4663**.

Not a round number someone liked: it is 2x `14,580,627 gas × 0.4009 gwei`
measured on 2026-09-06. Gas price moves, and step 4 re-prices it live rather than
trusting this line. The 2x is margin for a price move between the check and the
broadcast, not padding.

A broadcast that runs out part-way leaves `HookDeployLib` and the treasury live
and the factory absent, or the factory live and unowned. That is the one failure
on this list that happens *during* the irreversible step.

## 4. Preflight — must exit 0

```bash
node scripts/preflightMainnet.mjs
```

Read the exit code, not the vibe:

| Exit | Meaning |
|---|---|
| 0 | `✓ clear for C1` — proceed |
| 1 | a check failed — **do not broadcast** |
| 2 | could not run. **Not a pass.** A guard that cannot run must not be mistaken for one that found nothing |

Check 0b will exit 2 if any role resolved from `.env` instead of
`.env.production`. That check exists because without it this script priced the
funding gap against the testnet deployer and printed `Fund 0x73db078f…` — a
money instruction naming a forbidden wallet. See `SECURITY_AUDIT.md` §5.20.

## 5. Broadcast

**Use Git Bash, not PowerShell** (`C:\Program Files\Git\bin\bash.exe` on this
machine). The `set -a` is load-bearing; §6 explains why.

```bash
cd /c/Users/Administrator/Desktop/Tosh-Core_Workspace/Tosh-Core
set -a && source .env.production && set +a

forge script script/DeployMainnet.s.sol:DeployMainnetScript \
  --rpc-url "$TARGET_RPC" \
  --broadcast \
  --verify \
  --verifier blockscout \
  --verifier-url https://robinhoodchain.blockscout.com/api \
  -vvvv
```

**Verify before walking away:** `broadcast/DeployMainnet.s.sol/4663/` exists and
holds receipts. That directory is also what arms `checkStatusPage.mjs`, which
starts failing while the status page still points at testnet — that is PM-C7
telling you it is now your turn, not a regression.

## 6. What the old instruction got wrong

The header of `script/DeployMainnet.s.sol` used to say "after `source
.env.production`". Incomplete, and it would have failed on the day.

`source` sets shell variables. It does not export them, and this script reads
the *environment* through `vm.envUint` / `vm.envAddress`. So without `set -a`
the values never reach forge. What does reach forge is `.env`, which it
auto-loads and which holds testnet roles: `TARGET_CHAIN_ID=46630`,
`PLATFORM_TREASURY` and `POG_SIGNER_ADDRESS` both `0x73db078f…`, and no
`PROD_OWNER_SAFE` at all.

That last absence is the accident that saves it — `vm.envAddress` reverts on a
missing variable, so the run dies instead of deploying a real fee-taking factory
with testnet roles. Fail-closed by omission is not a control, so the header is
corrected rather than left to luck.

## 7. After the broadcast

In order. Each is a checklist row.

1. **PM-C2** — the Safe signers call `acceptOwnership()` on **both** the factory
   and the ladder treasury. Until they do, the deployer EOA still owns
   everything and a launchpad announced in that state has one private key
   standing between users and every kill switch. Rehearsed end to end on 46630
   (`INCIDENT_RESPONSE.md` §8.2): 106,308 gas, 3.92 s, two signatures.
   Verify with `VerifyDeployment.s.sol` and `EXPECTED_OWNER=<safe>`.
2. **PM-C3** — only now may the factory address be announced.
3. **PM-C4** — explorer verification. `--verify` in step 5 should have done it;
   confirm the source is actually public at the address.
4. **PM-C6** — regenerate the hook initcode hash against the **mainnet** build
   and commit it. Nothing errors if you skip this: the launch page reads
   `factory.hookInitcodeHash(...)` from chain and works either way. The
   published number is simply, quietly wrong.
5. **PM-C7** — point the frontend at 4663, and the status page's own `CHAIN`
   block in the other repository. Then click the two-phase PoG flow through on
   the real deployment — `/api/pog-scan` then `/api/sign-allocation`. It is unit-
   and live-tested and no human has ever clicked it on a real deploy.
6. **PM-C8** — `treasury.addLadderToken`, but **poll for TWAP maturity, do not
   compute it**. The first testnet sitting listed 52 s after launch; see
   `PRE_MAINNET_CHECKLIST.md` §3.2.
7. **PM-D1 / PM-D3** — the rotation is now real: every key and wallet used on
   testnet, in this repo, or in a chat is burned. Clear the remaining laptop
   copies and re-run `npm run check:secrets` — from `soat-frontend/`, which is
   where that script is defined.
8. **PM-E2** — repoint `MONITOR_*` at 4663 and give `watch.yml` its delivery
   sink.

## 8. Not blocked by any of the above

These need no deploy and no key. They are the only rows on the open list that
could close today:

- **PM-D4 / PM-E4** — `INCIDENT_RESPONSE.md` §1 names the three signers (Tom,
  Jack, Joe) as addresses. It needs contact channels. One unreachable signer
  turns 2-of-3 into 2-of-2, and §8.2 measured the mechanical signing path at
  5 s against a 60-second budget — so the budget is almost entirely the time to
  reach a human.
- **PM-D4's third Q1 criterion** — re-run the §8.2 drill on 46630 with one of
  the new signers taking part.
- **PM-E6** — name a watcher for the D1–D4 review triggers.
