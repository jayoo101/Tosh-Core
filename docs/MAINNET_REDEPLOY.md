# Mainnet redeploy runbook — BNB Smart Chain 56

> **Do not execute the 4663 steps below.** This file was written for the
> Robinhood Chain redeploy of 2026-09-17. The live target is now BSC 56 with
> PancakeSwap Infinity; 56 is **not deployed**. Procedure still applies
> (clock-decides-launch, PoG band, Ownable2Step handoff) once a production env
> names chain 56, the Infinity CLPoolManager/Vault, and split keys — the root
> `.env.production` this used to point at was deleted on 2026-09-18 as a 4663
> relic holding a second private key. Addresses and balances in the tables were
> read from chain 4663 and are historical.
>
> **So are the numbers on the dials, which is the trap, because those are the
> part written as instructions.** §5 step 3 tells you to set a fee and step 4
> tells you to confirm two values; all three were denominated in ETH against a
> fee the old mainnet was charging, and none of them is what the code now
> ships. Today's defaults, read from `src/ToshFactory.sol` and confirmed on
> chain 97 on 2026-09-18, are `launchFee` **0.35**, `defaultSoftCap` **35** and
> `maxPogAllocationLimit` **1.75**, all in BNB. What 56 should charge instead
> is an open decision, not a stale figure — see the note under step 3.

Written for the redeploy that shipped two changes: **the clock decides a
launch** (the soft cap becomes a progress target) and **the PoG band moves to
0.025 / 0.5 / 0.5** (floor / rate / ceiling, with `maxPogAllocationLimit` at
0.5 ether on-chain).

The first change is now simply how the protocol works, and it survived the move
to BSC unaltered — it is the model `MANUAL_INTERACTION.md` documents. The second
is the historical band: the on-chain ceiling it names has since moved to **1.75
BNB**, and the off-chain triple is config rather than deployment, so §8 rotates
it without any of this runbook.

`DeployMainnet.s.sol` prints its own checklist at the end of a broadcast. This
document is the part that checklist cannot know: the order, the evidence each
step needs before it counts as done, where you can still back out, and what
this redeploy destroys on the way past.

Every address and balance below was read from chain 4663 on 2026-09-17. Re-read
them on the day; treat a mismatch as a reason to stop, not to adjust the doc.

---

## 1. Why a redeploy at all

Neither change can reach a deployed contract. The launch rule lives in
`ToshLaunchpadHook`, which the factory deploys **once in its own constructor**
and then clones immutably for every project; `maxPogAllocationLimit` has a
setter, but the hooks snapshot it at `createLaunch` time. There is no upgrade
path and there is deliberately no proxy. A new factory is the only way to
change what a future hook does.

---

## 2. What this redeploy cannot reach, and what it destroys

Read this section before funding anything. None of it is reversible after the
broadcast.

### The live project stays on the old factory, forever

| | |
|---|---|
| Hook | `0x0fbC9c29E9E6eFD390a4CaEb886b6b6fcEa7AdFE` |
| Token | `0x846D0ffC367B450c8C9E9E7875F019b96f9560DD` |
| State | `launched() == true`, raised 0.012858 ETH against a 0.01 ETH cap |

Its pool is seeded and trading. It keeps the old soft-cap rules and the old
0.1 ETH PoG ceiling for the rest of its life. The redeploy does not migrate it
and cannot.

### Switching the frontend hides it

`useDirectoryProjects.ts` reads `launches` from a **single** factory —
`FACTORY_ADDRESS`, sourced from `NEXT_PUBLIC_FACTORY_ADDRESS`. There is no
multi-factory list. The moment that variable points at the new factory, the
live project above disappears from the directory and from every page that
enumerates projects.

The token keeps trading on Uniswap V4 either way; the site simply stops listing
it. If that is not acceptable, the frontend needs a second factory address in
the enumeration path **before** the switch, not after.

> **Decided 2026-09-17: accepted.** The delisting is intentional, not an
> oversight. The project is already launched, so no depositor is waiting on a
> `refund()` route through the UI — the only thing lost is a directory entry for
> a token that trades on V4 regardless. Revisit only if a project on the old
> factory is still mid-genesis when the switch happens; that one would need the
> two-factory enumeration first, because its depositors would have no way to
> reach their exit.

### The old ladder treasury's balance is stranded

| | |
|---|---|
| Old treasury | `0x255722226720914eF5B2CD54647f21f584BD4Ea2` |
| Balance | 0.021293 ETH |
| Withdraw path | none — `withdraw`, `sweep` and `rescue` are absent **by design** |

New hooks point at a new treasury. That 0.021293 ETH stays where it is,
permanently. This is not a bug to fix on deploy day; it is the price of the
redeploy, and it was the price the no-withdraw design accepted up front.

### One project was already lost to the rule being removed

| | |
|---|---|
| Hook | `0xA4c10938D80Cfc9b97f56c08110bda2b364338Ec` |
| Raised | 0.048866 ETH against a **10 ETH** soft cap |
| Deadline | passed 2026-09-16; hook balance is now 0 |

Under the old rule its refunds opened the instant the deadline passed and every
depositor has already exited. Under the new rule nothing would have opened for
another seven days and the creator could still have launched. This is the exact
outcome the change exists to prevent, and it is not recoverable — the hook is
immutable and the money is back with the depositors.

---

## 3. Preconditions

> ⚠ **EVERY ADDRESS IN THE TABLE BELOW USED TO BE A ROBINHOOD ONE**, and that is
> a worse failure than an absent table: the deployer, the owner Safe and the PoG
> signer were all `4663` addresses quoted in ETH, and the old Safe
> `0x2953957774482efA660921df85A1E7634ccfe27A` **has no code on 56**. An operator
> working down the list would have funded a wallet that cannot deploy and pointed
> ownership at an address that does not exist on the target chain. Re-measured
> against chain `56` on 2026-09-19.

| Check | Value on 2026-09-19, chain `56` | Verdict |
|---|---|---|
| Deployer `0x35b232E26a275f62E594e010624aEA0c46b7874a` balance | 0.012985 BNB | enough — the deploy costs ~0.00076 BNB (15,143,081 gas at 0.05 gwei), roughly 17x covered |
| Owner Safe `0x02DE4629129D104C63329D13A6Ca67E43db7B310` | 0 BNB | irrelevant — `execTransaction` gas is paid by the owner EOA that submits it, not by the Safe. 2-of-3, v1.4.1, indexed, `nonce 0`; passes `scripts/verifyOwnerSafe.mjs` |
| Executing Safe owner's EOA balance | 0.020 / 0.010 / 0.122 BNB across the three owners | enough — at 0.05 gwei the three Safe transactions cost roughly 0.0001 BNB each |
| PoG signer | **`0x73db078fa94607893270079AC8F5c7492aB480cd` — LEAKED, BLOCKS THE DEPLOY** | must be rotated before `.env.production` is written. See below |
| Deployer BEM balance | 0 | correct — the launch fee is paid by whoever calls `createLaunch`, not by the deployer. Nothing in the deploy moves BEM |
| Old factory `paused()` | n/a | there is no old factory on `56`; this is a first deployment, not a redeploy. See step 6 for what that changes |

> **The PoG signer is the one precondition that is not a number to check.**
> `POG_SIGNER_ADDRESS` in `.env` is still the leaked testnet deployer. Whoever
> holds that key can sign arbitrary `maxAlloc` values, which is the ability to
> mint deposit quota without limit — the exact thing `GOV-04` pages on. It is
> also why this cannot be deferred past the deploy: `pogSigner` is settable, so
> in principle it could be rotated afterwards, but the factory would be live with
> a signer whose key is public for the length of one Safe transaction, and the
> quota it signs is spendable within that window.
>
> The new signer needs **no BNB at all** — see the note below, which is about the
> deploy script and applies with equal force to a freshly generated key.

> **The deploy script's checklist item 5 is stale.** It says to pre-fund the PoG
> signer with ~0.05 ETH. `registerPoG` binds its digest to `msg.sender` and
> recovers the signer only to compare addresses, so the signer never sends a
> transaction. The Robinhood mainnet signer
> `0x9A1a8C7b7D68d391909F02e8bD5B148b4B95b736` held 0 ETH throughout and PoG
> worked the whole time. Funding it would be harmless and pointless.

### The values to write into `.env.production`

Three of these are already correct in `.env.production.example` and need no
decision; they are listed so that a filled-in file can be diffed against
something. The BSC `56` Infinity addresses were taken from the deployment the
fork suite runs against, and `QUOTE_ASSET` is checked on chain by preflight `5c`
for code, 8 decimals and identity.

```
TARGET_CHAIN_ID=56
INFINITY_CL_POOL_MANAGER=0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b   # in the template
INFINITY_VAULT=0x238a358808379702088667322f80aC48bAd5e6c4             # in the template
QUOTE_ASSET=0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a                # in the template — BEM
DEPLOYER_ADDRESS=0x35b232E26a275f62E594e010624aEA0c46b7874a
PROD_OWNER_SAFE=0x02DE4629129D104C63329D13A6Ca67E43db7B310
PLATFORM_TREASURY=0x02DE4629129D104C63329D13A6Ca67E43db7B310
POG_SIGNER_ADDRESS=<the rotated signer — NOT 0x73db…>
```

The Safe address is recorded here because it was recorded nowhere: it existed in
a chat log and on chain, and was recovered by scanning `56` for a contract among
the candidate addresses with a `getThreshold()` of 2. That is not a procedure
anybody should need on deploy day.

`PLATFORM_TREASURY` being the same address as `PROD_OWNER_SAFE` is the decision
taken deliberately, and `verifyOwnerSafe.mjs` is the gate for it: it is
**immutable** in both the factory and the hook implementation, it receives 0.30 %
of the BEM input of every buy on every pool forever, and rotating it is a factory
redeploy plus a migration of every pool.

### The environment trap

`forge` auto-loads `.env` from the repo root, and `.env` currently holds
**testnet** roles (`TARGET_CHAIN_ID=46630`, `PLATFORM_TREASURY` and
`POG_SIGNER_ADDRESS` both set to the testnet deployer).

Measured behaviour: **a variable set in the shell wins over `.env`.** Verified
by injecting `INFINITY_CL_POOL_MANAGER=0x…dEaD` into the session and watching the script
log `0x…dEaD` instead of `.env`'s value. So exporting the production values is
sufficient — but only for the variables you actually export. Anything you miss
falls through to `.env`'s testnet value in silence.

`.env.production` does not define these, so `.env` supplies them:

```
PRIVATE_KEY   ROBINHOOD_TESTNET_RPC   TREASURY_ADDRESS   HOOK_ADDRESS   TOKEN_ADDRESS
```

`PRIVATE_KEY` is the dangerous one. `.env`'s copy is the **testnet** deployer
`0x73db078fa94607893270079AC8F5c7492aB480cd`, and `requireDistinctRoles` would
wave it through — it differs from the signer, the Safe and the platform
treasury. It would fail on gas (0 mainnet balance) rather than misdeploy, but
the failure would come at the broadcast, with the operator believing a
different key was in play.

The documented invocation, `set -a && source .env.production && set +a`, is
bash. In PowerShell:

```powershell
# Clear the testnet tree out of the way entirely. Belt and braces: exporting
# the right values is enough, but a renamed .env removes the question.
Rename-Item .env .env.testnet-parked

Get-Content .env.production |
  Where-Object { $_ -match '^[A-Z_][A-Z0-9_]*=' } |
  ForEach-Object {
    $k, $v = ($_ -split '=', 2)
    Set-Item -Path "Env:\$k" -Value $v.Trim()
  }

# Supplied by hand — .env.production deliberately does not carry it.
# -MaskInput is PowerShell 7+. This tree runs 5.1, where -AsSecureString plus
# an explicit unmarshal is the equivalent that keeps the key off the screen
# and out of the command history.
$sec = Read-Host -Prompt 'mainnet deployer PRIVATE_KEY' -AsSecureString
$env:PRIVATE_KEY = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
  [Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))

# Prove the key is the one you meant before spending anything.
cast wallet address --private-key $env:PRIVATE_KEY   # expect 0x4E41CEa9...E690
```

The loader loop above is safe against this tree's `.env.production`: every
entry is a bare `KEY=value` with no inline comment, quoting or whitespace.
Re-check that if the file grows.

---

## 4. Dry run, then broadcast

```powershell
# Dry run. No --broadcast: nothing is sent, and the chain-id guard still fires.
forge script script/DeployMainnet.s.sol:DeployMainnetScript --rpc-url $env:TARGET_RPC -vvvv
```

Read the manifest it prints and confirm all four roles before going further —
`PROD owner`, `PoG Signer`, `Platform fee recipient` and `Deployer`.
`platformTreasury` is immutable **and** baked into the hook implementation, so
a wrong value there is another redeploy, not a config change.

```powershell
forge script script/DeployMainnet.s.sol:DeployMainnetScript `
  --rpc-url $env:TARGET_RPC `
  --broadcast --verify `
  --verifier blockscout `
  --verifier-url https://robinhoodchain.blockscout.com/api `
  -vvvv
```

Record `FACTORY_ADDRESS` and `TREASURY_ADDRESS` from the manifest.

---

## 5. After the broadcast, in order

Ownership first. Until the Safe accepts, the deployer EOA owns the factory, and
the factory must not be announced in that state.

| # | Step | Done when |
|---|---|---|
| 1 | Safe calls `acceptOwnership()` on the **factory** | `owner()` is the Safe and `pendingOwner()` is `address(0)` |
| 2 | Safe calls `acceptOwnership()` on the **treasury** | same two reads on the treasury |
| 3 | Safe calls `setLaunchFee(<decide this first — see below>)` | `launchFee()` returns the base units you decided on, not the 9.28 BEM default |
| 4 | Confirm the dials nobody has to touch | `defaultSoftCap()` = `928.4e8`, `maxPogAllocationLimit()` = `46.4e8` — i.e. 928.4 and 46.4 **BEM**, at 8 decimals |
| 4b | Confirm the asset all three contracts are denominated in | `factory.quoteAsset()`, `hookImplementation().quoteAsset()` and `treasury.quoteAsset()` all return BEM. There is no setter; a disagreement here is a redeploy |
| 5 | `forge script script/VerifyDeployment.s.sol:VerifyDeploymentScript --rpc-url $env:TARGET_RPC` | all invariants pass, including `factory.platformTreasury() == hookImplementation().platformFeeRecipient()` |
| 6 | `forge build; node scripts/extractAbis.js` | `git diff` on `soat-frontend/src/app/lib/abis.ts` is empty (it was regenerated before the branch was committed) |
| 7 | Vercel Production: `NEXT_PUBLIC_FACTORY_ADDRESS` = new factory, `NEXT_PUBLIC_QUOTE_ASSET` = BEM | `npm run check:quote` agrees with the chain — see below |
| 8 | Push the five commits to `main` | CI green |
| 9 | Point `monitoring/` at the new factory and treasury | a watch run reports the new addresses with 0 findings |

**Step 3 is not optional, and it no longer has an answer written down.** It
used to read `setLaunchFee(0.01 ether)`, on the reasoning that the factory
default was 0.1 ether and mainnet was charging a tenth of that. Both halves
are obsolete twice over: the default is now **9.28 BEM**
(`src/ToshFactory.sol`), and there is no "what mainnet charges today", because
56 has never launched anything. The old figure was a price in ETH, and it
cannot be carried across two re-denominations by editing the unit.

So the fee is a decision owed before the broadcast, not a value to copy out of
this table. What constrains it: `MAX_LAUNCH_FEE` is 928 BEM, so anything
sensible is legal; it is **pulled with `transferFrom`** on `createLaunch`, so
the creator has to approve it first and it is the first number — and the first
extra signature — a creator meets; and it is settable afterwards by the Safe,
so it is reversible in a way the immutable dials are not. Left at the default,
the first creator pays 9.28 BEM to open a round — whether that is right is the
question, and it is the kind of question a runbook must not answer by inertia.

**Write the figure in base units when you send it.** BEM has 8 decimals, so
`setLaunchFee(9.28e8)` is the fee and `setLaunchFee(9.28e18)` is 9.28 billion
BEM — roughly fifty thousand times the entire supply, which reverts against
`MAX_LAUNCH_FEE` rather than landing. The near miss that does land is an
order-of-magnitude slip inside the ceiling; `test_setLaunchFee_rejectsOrderOfMagnitudeSlip`
is the guard, and it only covers the extreme.

**Step 7 has a check, and it is not in CI on purpose.** `npm run check:quote`
asks the factory what it is denominated in and compares that against
`NEXT_PUBLIC_QUOTE_ASSET`. It needs a live RPC and a deployed factory, so it
cannot be a source-text guard like the rest of `npm run guards` — it is a
deploy-day step, run against the chain being pointed at.

Two failures it distinguishes, because the remedies are opposite. A factory that
answers `quoteAsset()` with a *different* address means the env var is wrong and
editing Vercel fixes it. A factory whose `quoteAsset()` *reverts* predates the
denomination entirely: its `deposit` and `createLaunch` take different arguments,
so no env value makes this frontend able to drive it, and the chain needs
redeploying. **Chain 97 is in the second state right now** — the rehearsal
factory there was built before the BEM move, which is also why
`RehearseTestnet.s.sol` says the asset it rehearses against is not BEM.

**Steps 7 and 8 belong together.** The committed frontend copy says the soft
cap is a progress target. That is true of the new factory and false of every
hook on the old one, so shipping the copy while the site still points at the
old factory tells existing depositors the wrong thing about their refunds.

---

## 6. Rollback points

| Position | Reversible? | Cost of backing out |
|---|---|---|
| Before the broadcast | fully | nothing |
| Broadcast done, Safe has not accepted | yes | the new factory exists, is owned by the deployer EOA, is unannounced and is referenced by nothing. Abandoning it costs the ~0.00074 ETH already spent. The old factory is untouched and still serving users |
| Safe has accepted, Vercel not switched | yes | same as above. Ownership being correct does not make the factory live; nothing points users at it |
| Vercel switched | **the last exit** | reverting `NEXT_PUBLIC_FACTORY_ADDRESS` restores the old directory, but any project created on the new factory in the meantime vanishes from the site and its depositors lose their route to `refund()` through the UI |
| First launch created on the new factory | no | that hook is immutable and its depositors are committed |

If something is wrong after the switch and the old factory must take traffic
again, revert the Vercel variable **first** and the commits second. The
variable is one setting and takes effect on redeploy; the commits are a build.

There is no `pause()`-based rollback worth planning around: pausing the new
factory stops `createLaunch` and `registerPoG` but does nothing for a genesis
round already open on it.

---

## 7. Clean up the deploy machine

The session that ran the broadcast holds a mainnet key in `$env:PRIVATE_KEY`
and has the testnet tree renamed out from under it. Neither should outlive the
deploy.

```powershell
Remove-Item Env:\PRIVATE_KEY
Rename-Item .env.testnet-parked .env

# The key must not be in any file. This should print nothing.
Select-String -Path (Get-ChildItem .env* -Force -Exclude *.example) -Pattern '^PRIVATE_KEY=.+'
```

This used to name `.env` and `.env.production` literally, which stopped working
the day the second file was deleted — and it failed by *erroring on the missing
path*, so the check that is supposed to print nothing printed a PathNotFound
instead. A reader mid-cleanup reasonably reads "no output about a key" as the
pass it looks like. Globbing what is actually there avoids inventing that
outcome, and `-Exclude *.example` keeps the two committed templates out of a
result set where a hit means "stop everything".

For the same question asked properly, across the remote stores as well as the
local files, `node soat-frontend/scripts/checkSecretStore.mjs` inventories every
name this protocol uses and says which of them a local copy is still holding.

Close the shell as well — `$env:PRIVATE_KEY` is gone from it, but the value may
still sit in the PSReadLine history if it was ever typed rather than prompted
for. That is the reason for the `Read-Host` prompt above.

---

## 8. After it is live

Rotating the PoG band does **not** need a redeploy — that was the point of the
band work. `POST /api/admin/config` moves the floor, the rate and the ceiling
together against an owner signature, and `scripts/rotateGasRate.mjs` drives it
for a Safe. The one ordering rule: the off-chain ceiling may be lowered freely,
but raising it above `maxPogAllocationLimit` is refused, because the oracle
would otherwise sign attestations that `registerPoG` reverts for everybody.
Raise the on-chain dial first. See `docs/DEVELOPMENT.md` for the mechanics.
