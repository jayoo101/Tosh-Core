# Mainnet redeploy runbook — Robinhood Chain 4663

Written for the redeploy that ships two changes: **the clock decides a launch**
(the soft cap becomes a progress target) and **the PoG band moves to
0.025 / 0.5 / 0.5** (floor / rate / ceiling, with `maxPogAllocationLimit` at
0.5 ether on-chain).

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

| Check | Value on 2026-09-17 | Verdict |
|---|---|---|
| Deployer `0x4E41CEa950cF40FA59774B409988D6F9F399E690` balance | 0.003695 ETH | enough — the deploy costs ~0.00074 ETH (15,143,081 gas at 0.0487 gwei), roughly 5x covered |
| Executing Safe owner's EOA balance | check on the day | must cover three Safe transactions |
| Owner Safe `0x2953957774482efA660921df85A1E7634ccfe27A` | 0.000006 ETH | irrelevant — `execTransaction` gas is paid by the owner EOA that submits it, not by the Safe |
| PoG signer `0x9A1a8C7b7D68d391909F02e8bD5B148b4B95b736` | 0 ETH | correct, leave it. See the note below |
| Old factory `paused()` | `false` | see step 6 |

> **The deploy script's checklist item 5 is stale.** It says to pre-fund the PoG
> signer with ~0.05 ETH. `registerPoG` binds its digest to `msg.sender` and
> recovers the signer only to compare addresses, so the signer never sends a
> transaction. The live mainnet signer has held 0 ETH throughout and PoG has
> worked the whole time. Funding it would be harmless and pointless.

### The environment trap

`forge` auto-loads `.env` from the repo root, and `.env` currently holds
**testnet** roles (`TARGET_CHAIN_ID=46630`, `PLATFORM_TREASURY` and
`POG_SIGNER_ADDRESS` both set to the testnet deployer).

Measured behaviour: **a variable set in the shell wins over `.env`.** Verified
by injecting `V4_POOL_MANAGER=0x…dEaD` into the session and watching the script
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
| 3 | Safe calls `setLaunchFee(0.01 ether)` | `launchFee()` returns `10000000000000000` |
| 4 | Confirm the dials nobody has to touch | `defaultSoftCap()` = 10 ether, `maxPogAllocationLimit()` = 0.5 ether |
| 5 | `forge script script/VerifyDeployment.s.sol:VerifyDeploymentScript --rpc-url $env:TARGET_RPC` | all invariants pass, including `factory.platformTreasury() == hookImplementation().platformFeeRecipient()` |
| 6 | `forge build; node scripts/extractAbis.js` | `git diff` on `soat-frontend/src/app/lib/abis.ts` is empty (it was regenerated before the branch was committed) |
| 7 | Vercel Production: `NEXT_PUBLIC_FACTORY_ADDRESS` = new factory | redeploy finishes and the directory renders |
| 8 | Push the five commits to `main` | CI green |
| 9 | Point `monitoring/` at the new factory and treasury | a watch run reports the new addresses with 0 findings |

**Step 3 is not optional.** The new factory's `launchFee` default is **0.1
ether**, ten times what mainnet charges today. Left alone, the first creator to
try a launch pays ten times the intended fee, or more likely cannot afford it
and leaves.

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
Select-String -Path .env, .env.production -Pattern '^PRIVATE_KEY=.+'
```

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
