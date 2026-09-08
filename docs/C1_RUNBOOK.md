# PM-C1 — deploy day runbook

**The broadcast ran on 2026-09-08.** This file was written as the order of
operations for a deploy that had not happened; it is now the record of the one
that has, plus the post-broadcast sequence that is still live. The procedure in
§§1–6 is kept because it is how the run actually went — §5's `set -a` is why
forge saw `.env.production` rather than `.env` — and §7 is the live checklist
as of the moment this paragraph was written.

The checklist argues about *what* and *why*; on the day you needed *in what
order, and how do I know the last step worked*. That split still holds: Gate C
moved when the receipts landed, and everything after the broadcast is in §7.

Every command below was checked against this repository and this machine on
2026-09-06. The key-generation steps were checked again on 2026-09-08, after
the instruction in §1 was found to name the wrong residue. Where a documented
instruction was wrong, it is corrected here and in the source it came from —
see §6.

---

## 0. State on 2026-09-08, after the broadcast

| | |
|---|---|
| Canonical factory | `0xBa9d2E86281b988225Eca383C375215912fb20B9` — 10,789 bytes runtime, chain 4663 |
| Canonical treasury | `0x99aD248dD15498957B864Fd79917F0E103Aa78F7` — 6,035 bytes runtime. Mutually wired: `factory.ladderTreasury()` and `treasury.factory()` return each other |
| Blocks | 57400516–57400521. Five transactions, all `status=0x1`. Artefact: `broadcast/DeployMainnet.s.sol/4663/run-latest.json` |
| Owner Safe | `0x2953957774482efA660921df85A1E7634ccfe27A` — 1.4.1, 2-of-3, owner set matches `safe-owners.json`, indexed by the transaction service as `1.4.1+L2`, accepts plain ETH at ~27,674 gas. Re-verify with `node scripts/verifyOwnerSafe.mjs <addr>` |
| Ownership | **Mid-handoff.** On both contracts `owner()` is still the deployer EOA `0x4E41CEa950cF40FA59774B409988D6F9F399E690` and `pendingOwner()` is the Safe. PM-C2 — the Safe calling `acceptOwnership()` on both — is the step that closes the single-key window. It is in progress with the signers and is **not** marked done from this seat |
| `.env.production` | `FACTORY_ADDRESS`, `LADDER_TREASURY_ADDRESS` and `DEPLOY_BLOCK=57400516` filled with the canonical values. `HOOK_CREATION_CODEHASH` and `LIVE_INITCODE_HASH` are still `0x` — that is PM-C6, not filled from this sitting |
| C1 cost | **9,353,658 gas.** Receipts paid 0.28205 gwei on the treasury create and 0.28461 gwei on the other four, totalling **0.0026585890501 ETH**. This file predicted 14,580,627 gas re-summed from the 46630 rehearsal — 56% high. The ~0.0117 ETH 2x funding guidance that came from it was therefore conservative in the right direction |
| Deployer | `0x4E41CEa950cF40FA59774B409988D6F9F399E690`, nonce 11. `0x73db078f…` remains the **testnet** deployer and §4.1 forbids reusing it |
| Orphan pair | A complete earlier deployment exists on chain and has no `run-*.json` in this repository. Factory `0x96a2A0f43225184d4C47A47Ed8d919233f5c1aBF`, treasury `0xbA6c032d0FAacd2A11B86Da7D3c82fbbba1ce4D4`. See `SECURITY_AUDIT.md` §5.25. Disposition is an operator decision; anything that needs the deployer key must happen before PM-D1/D3 rotates and destroys it |

## 1. Generate the deployer EOA

Do this in a terminal the editor does not manage: a PowerShell or Windows
Terminal window opened from the Start menu, not Cursor's integrated terminal.
`cast` on this machine is 1.7.1 and is on PATH.

```powershell
cd C:\Users\Administrator\Desktop\Tosh-Core_Workspace\Tosh-Core
$out  = cast wallet new
$addr = ($out | Select-String 'Address:').ToString().Split()[-1]
$key  = ($out | Select-String 'Private key:').ToString().Split()[-1]
(Get-Content .env.production) -replace '^PRIVATE_KEY=.*', "PRIVATE_KEY=$key" | Set-Content .env.production
Write-Host "deployer address: $addr"
Remove-Variable key
```

The snippet writes the key straight into `.env.production` and echoes only the
address. The key is never displayed.

This one does have to live in a local file: `script/DeployMainnet.s.sol:97`
reads it with `vm.envUint("PRIVATE_KEY")`, so an encrypted keystore
(`cast wallet new <path>`) does not fit this script. That is acceptable for this
role and only this role — the deployer is a temporary identity that signs once
and is powerless the moment the Safe accepts in step 6. The PoG key in step 2 is
the opposite case.

Fund it with only the ~0.0117 ETH step 3 names, and no more. The key lives in a
local file by necessity, so the balance is the exposure. A previous run put
0.12 ETH on it, roughly ten times the requirement.

The key is printed by `cast`, not typed, so it does not enter PowerShell's
PSReadLine history. That half is true. It was the wrong thing to be reassured
by. The residue that matters on this machine is not the scrollback of a window
you can close: Cursor continuously persists the output of every terminal it
manages into plaintext files at `.cursor/projects/<slug>/terminals/*.txt`.
Closing the window does not remove that file, and the same capture puts the
output into the agent conversation. Generate both EOAs outside that capture.

**Verify by reading, not by deriving.** The snippet echoes the address and not
the key, so no derivation is needed — check by eye that the echoed address is
not `0x73db078f…`. Resist the obvious `cast wallet address --private-key <key>`:
it puts a live mainnet key on a command line, and command lines are what shell
history records.

The machine check comes in step 4. `preflightMainnet.mjs` derives the deployer
from `PRIVATE_KEY` in `.env.production` and asserts it differs from the PoG
signer, the Safe and the treasury — the same four assertions
`requireDistinctRoles` would make mid-broadcast.

## 2. Generate the PoG signer EOA

Same unmanaged window as step 1. Same rule: the key is never displayed.

```powershell
$out  = cast wallet new
$addr = ($out | Select-String 'Address:').ToString().Split()[-1]
$key  = ($out | Select-String 'Private key:').ToString().Split()[-1]
(Get-Content .env.production) -replace '^POG_SIGNER_ADDRESS=.*', "POG_SIGNER_ADDRESS=$addr" | Set-Content .env.production
$key | Set-Clipboard
Write-Host "pog signer address: $addr"
Remove-Variable key
```

The snippet writes the address into `.env.production` and puts the key on the
clipboard for the Vercel paste. After pasting into Vercel, clear the clipboard
with Set-Clipboard -Value ' '.

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

Send at least **0.0117 ETH** to the step-1 address on chain **4663**, and no
more. A previous run put 0.120292 ETH on a deployer whose key then leaked —
roughly ten times this figure, all of which had to be swept. The key lives in
`.env.production` by necessity, so the balance is the exposure.

Not a round number someone liked: it is 2x `14,580,627 gas × 0.4009 gwei`
measured on 2026-09-06 from the 46630 rehearsal. The live 4663 run used
**9,353,658 gas** (see §0), so the rehearsal figure was 56% high and this 2x
margin was conservative in the right direction. Gas price moves, and step 4
re-prices it live rather than trusting this line. The 2x is margin for a price
move between the check and the broadcast, not padding, and not a reason to
fund 0.12 ETH.

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

The next wrong instruction was the paragraph in §1 that said the key is printed,
not typed, so it does not enter PSReadLine history, and that closing the window
is enough because the residue is the scrollback buffer. The first half is true.
The second names the wrong residue, and a warning that is precise about the
wrong threat reads as reassurance — the same shape as `preflightMainnet.mjs`
check 0b in `SECURITY_AUDIT.md` §5.20 and as `checkBlockscoutKey.mjs` in §5.22:
a control that was confident about a model of the world that had drifted.

Cursor persists every managed terminal's output to
`.cursor/projects/<slug>/terminals/*.txt`. Closing the window does not delete
that file. An operator who followed §1 and §2 verbatim in the Cursor integrated
terminal on 2026-09-08 ran `cast wallet new` twice; both keypairs landed in
plaintext in that capture and in the agent transcript. Both EOAs are burned:
deployer `0xf9D360fC5AC1045d79054a850b05F646939c3366` (funded with 0.120292 ETH
on 4663 before the exposure was noticed, then swept) and PoG signer
`0xE7c1bCbCc5b8bB9B40F6E39C382bA94713588B7a` (held 0). `.env.production` was
untouched — all three `REPLACE_ME` lines still intact — so the blast radius
stopped at two keypairs and the sweep gas.

The git history already called the `set -a` omission "the second wrong
instruction in it". This is the third, in a file that exists to prevent exactly
this. The procedure in §1 and §2 now generates both EOAs in a terminal the
editor does not manage, writes the deployer key straight into `.env.production`
without echoing it, and puts the PoG key on the clipboard for the Vercel paste
rather than on the screen.

## 7. After the broadcast

In order. Each is a checklist row. This is the live list: C1 is done, C2 is
not. `checkStatusPage.mjs` is already failing, on purpose — that is PM-C7
armed by the `broadcast/*/4663/` artefact, not a broken guard.

1. **PM-C2** — the Safe signers call `acceptOwnership()` on **both** the factory
   and the ladder treasury. Until they do, the deployer EOA still owns
   everything and a launchpad announced in that state has one private key
   standing between users and every kill switch. Live as of this writing:
   `owner()` is the deployer, `pendingOwner()` is the Safe, on both contracts.
   The signers are working this in parallel with the documentation; **do not
   mark it done from a seat that cannot see the accept.** Rehearsed end to end
   on 46630 (`INCIDENT_RESPONSE.md` §8.2): 106,308 gas, 3.92 s, two signatures.
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

There is nothing left on this list. PM-D4, PM-E4 and PM-E6 were the rows that
needed no deploy and no key; they closed 2026-09-08. `INCIDENT_RESPONSE.md` §1
names Encrypted Signal / Telegram for Tom, Jack and Joe, with handles in the
offline vault; Incident commander and Comms lead are the Deployer / Primary
Operator; Legal is N/A at launch; the D1–D4 review triggers are watched by the
same person. That is a policy closure: the placeholders are gone and the
channel is named. Nobody has been paged at 03:00 to prove the channel works.

**Q1's third criterion is not on this list, and an earlier draft of this file
put it there.** §8.3 closed it on 2026-09-04: Joe and Tom signed all four
payloads on 46630. `verifyOwnerSafe.mjs` went on printing "the only one still
unmet" for two days afterwards and was corrected in the same commit as this
line — worth knowing, because §0 of this runbook tells you to run that script.
The same script later printed a remaining-for-D4/E4 nag after those rows had
also closed; that line is gone too.
