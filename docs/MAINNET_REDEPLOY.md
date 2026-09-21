# Mainnet redeploy runbook — BNB Smart Chain 56

> **§2 is chain-4663 history. §3 onward has been re-measured for BSC 56 and is
> executable.** This file was written for the Robinhood Chain redeploy of
> 2026-09-17 and the live target is now BSC 56 with PancakeSwap Infinity, which
> is **not yet deployed**. The procedure survived both moves intact
> (clock-decides-launch, PoG band, Ownable2Step handoff). What did not survive is
> every number, and the numbers are the part written as instructions.
>
> Re-measured against 56 as of 2026-09-19: §3's preconditions, §4's broadcast
> command, §5's dials and the variable lists in steps 7 and 9. The
> `.env.production` this used to point at was deleted on 2026-09-18 as a 4663
> relic holding a second private key; it has since been rebuilt for 56 and
> passes `scripts/preflightMainnet.mjs`. **Addresses, balances and outcomes in §2
> are chain 4663 and are there as a record of what that redeploy destroyed — do
> not act on them.**
>
> **The dials are split across two currencies, and this banner has already been
> wrong about them three times.** It said ETH, then BNB, then "all BEM". Today's
> defaults, read from `src/ToshFactory.sol`: `launchFee` **0.005 BNB**,
> `MAX_LAUNCH_FEE` **0.5 BNB** — native wei, collected as `msg.value` on
> `createLaunch`. `defaultSoftCap` **928.4 BEM**, `maxPogAllocationLimit`
> **46.4 BEM**, `MIN_SOFT_CAP_PROD` **100 BEM** — quote, 8 decimals. A figure
> here that carries no unit, or the wrong one, is the failure this banner
> exists to prevent: `setLaunchFee(9.28e8)` on a native-fee factory is not a
> BEM typo, it is 928 million BNB. What 56 should charge is still an open
> decision, not a value to copy — see step 3.

Written for the redeploy that shipped two changes: **the clock decides a
launch** (the soft cap becomes a progress target) and **the PoG band moves to
0.025 / 0.5 / 0.5** (floor / rate / ceiling, with `maxPogAllocationLimit` at
0.5 ether on-chain).

The first change is now simply how the protocol works, and it survived the move
to BSC unaltered. It has since gone one step further: the soft cap is not even a
progress target — nothing reads it, and the UI shows a countdown to the deadline
where the progress bar used to be. The only floor left is `ladderViable()`, the
raise below which `launch()` cannot build a monotone ladder, and falling under
it opens refunds the moment genesis closes rather than seven days later. The second
is the historical band: the on-chain ceiling it names has since moved to **46.4
BEM**, and the band is now split across two units on purpose — the floor stays in
**ETH** because it measures gas burned on ETH-settled chains, while the rate and
the ceiling are BEM. The off-chain triple is config rather than deployment, so §8
rotates it without any of this runbook.

`DeployMainnet.s.sol` prints its own checklist at the end of a broadcast. This
document is the part that checklist cannot know: the order, the evidence each
step needs before it counts as done, where you can still back out, and what
this redeploy destroys on the way past.

§2's addresses and balances were read from chain 4663 on 2026-09-17; §3's were
re-read from chain 56 on 2026-09-19. Re-read them again on the day; treat a
mismatch as a reason to stop, not to adjust the doc.

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
| Deployer `0x35b232E26a275f62E594e010624aEA0c46b7874a` balance | 0.012985 BNB | **covers the deploy at spot and not under load — top up before broadcasting.** ~0.00105 BNB at 0.05 gwei (12x covered), 0.0209 BNB at 1 gwei, i.e. **short by 0.0079 BNB** there. The gas figure is **20,908,865**, summed from the chain-56 `DeployMainnet` dry run. It read 15,236,814 until 2026-09-21 and 15,143,081 before that; both were the wrong measurement rather than a stale one — `broadcast/Deploy.s.sol/97/…`, a **different script on a different chain**, which does not contain the `Create2Deployer` → `HookDeployLib` transaction that 56 needs (7.68 M gas on its own). Understated by 37 %, the third time in that direction. `preflightMainnet.mjs` now sums a chain-56 `DeployMainnet` run, so **run the §4 dry run before trusting its funding check** |
| Owner Safe `0x02DE4629129D104C63329D13A6Ca67E43db7B310` | 0 BNB | irrelevant — `execTransaction` gas is paid by the owner EOA that submits it, not by the Safe. 2-of-3, v1.4.1, indexed, `nonce 0`; passes `scripts/verifyOwnerSafe.mjs` |
| Executing Safe owner's EOA balance | 0.020 / 0.010 / 0.122 BNB across the three owners | enough — at 0.05 gwei the three Safe transactions cost roughly 0.0001 BNB each |
| PoG signer | `0xc7B7CB00A4B5CBe832Caa7369FbcBbd6385E581D` | **rotated 2026-09-19, and this row is the one that changed.** It used to name `0x73db078fa94607893270079AC8F5c7492aB480cd`, the leaked testnet deployer, and blocked the deploy. Generated into an encrypted keystore; the key was never written to a log or a tracked file. Preflight checks 3 and 4 confirm it is an EOA and distinct from all three other roles |
| Deployer BEM balance | 0 | correct — the launch fee is paid by whoever calls `createLaunch`, not by the deployer. Nothing in the deploy moves BEM |
| Old factory `paused()` | n/a | there is no old factory on `56`; this is a first deployment, not a redeploy. See step 6 for what that changes |

> **The PoG signer is the one precondition that is not a number to check, and
> it is now satisfied — but not finished.** The reason it blocked the deploy:
> whoever holds that key can sign arbitrary `maxAlloc` values, which is the
> ability to mint deposit quota without limit, the exact thing `GOV-04` pages on.
> It could not be deferred past the deploy even though `pogSigner` is settable,
> because the factory would be live with a public key for the length of one Safe
> transaction and the quota it signs is spendable inside that window.
>
> What is left is not on this chain and no pre-broadcast check can see it: the
> **private half** must reach Vercel as `POG_SIGNER_PRIVATE_KEY` before any
> creator registers PoG. Production currently holds the chain-97 throwaway. A
> mismatch does not fail the build or the deploy — `/api/pog/attest` signs with
> whatever key it has, the factory recovers a different address, and every
> `registerPoG` reverts for every user while the site reports nothing. That is
> `PM-C7`, and it is verifiable only after the fact by registering once.
>
> `.env` still names the leaked `0x73db…`, which is correct: that file is the
> chain-97 tree, where the address is a throwaway on a worthless chain. It is
> `.env.production` that had to move, and it has.
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
POG_SIGNER_ADDRESS=0xc7B7CB00A4B5CBe832Caa7369FbcBbd6385E581D   # rotated 2026-09-19
ETHERSCAN_API_KEY=<an Etherscan v2 key — one key covers 56 and 97>
```

`.env.production` in this tree is filled in and passes preflight with one
exception: `ETHERSCAN_API_KEY` is still `REPLACE_ME_ETHERSCAN_V2_KEY`. Preflight
does not check it, and **that is now correct rather than a gap**: nothing in §4
needs it. Verification moved off the broadcast and off this machine entirely —
the key lives in Actions secrets and `.github/workflows/verify.yml` spends it.
The placeholder can stay. Leave the line in the file only as a reminder of which
key the workflow is holding; filling it in here puts a secret on the deploy
machine to no purpose.

`TARGET_RPC` **is** defined in `.env.production` even though it does not appear
in the block above — that block is the set of values needing a decision, not the
file's contents. §4 passes `$env:TARGET_RPC` and the loader supplies it.

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
**chain-97** roles: `TARGET_CHAIN_ID=97`, `QUOTE_ASSET` the 8-decimal mock
`0x76bD1ceC663AE3242e5267e232B821C51a4882EB`, `PLATFORM_TREASURY` and
`POG_SIGNER_ADDRESS` two throwaway EOAs.

Measured behaviour: **a variable set in the shell wins over `.env`.** Verified
by injecting `INFINITY_CL_POOL_MANAGER=0x…dEaD` into the session and watching the script
log `0x…dEaD` instead of `.env`'s value. So exporting the production values is
sufficient — but only for the variables you actually export. Anything you miss
falls through to `.env`'s testnet value in silence.

`.env.production` does not define these, so `.env` supplies them:

```
PRIVATE_KEY   ROBINHOOD_TESTNET_RPC   TREASURY_ADDRESS   HOOK_ADDRESS   TOKEN_ADDRESS
```

⚠ **THE SAFETY NET THIS PARAGRAPH USED TO DESCRIBE IS GONE, AND THE FIX IS WHAT
REMOVED IT.** It said `.env`'s `PRIVATE_KEY` was the leaked testnet deployer
`0x73db…`, so a fall-through "would fail on gas (0 mainnet balance) rather than
misdeploy". That reasoning depended on the key being **worthless**. Chain 97 was
rebuilt on 2026-09-19 with a fresh deployer, and the key now in `.env` is
`0x35b232E26a275f62E594e010624aEA0c46b7874a` — **the funded mainnet deployer**,
the same address §3's first row checks the balance of. A fall-through now
broadcasts successfully.

What still fails loudly: missing `TARGET_CHAIN_ID` falls through to 97 and
`require(block.chainid == targetChainId)` reverts against a 56 RPC. What fails
**permanently and silently** is any *other* variable you forget to export.
`PLATFORM_TREASURY` is the one to fear — miss it and `.env` supplies the chain-97
throwaway `0x1230d6Cb…`, `requireDistinctRoles` waves it through because it is
genuinely distinct from the other three roles, and that address becomes the
immutable recipient of 0.30 % of the BEM input of every buy on every pool
forever. Baked into the hook implementation. Not a config change — a redeploy of
everything.

This is why the `Rename-Item .env .env.testnet-parked` line below is not
belt-and-braces any more. Exporting the right values is still sufficient *if the
export is complete*, and moving `.env` out of the way is what makes an incomplete
export fail instead of shipping.

> **Worth deciding separately, before deploy day:** that one key is now both the
> testnet deployer and the mainnet deployer, and it sits in plaintext in `.env`.
> The exposure is bounded — the deployer surrenders ownership to the Safe in §5
> steps 1 and 2, and holds ~0.013 BNB — but between broadcast and acceptance it
> **is** the owner of the factory and the treasury. Using a separate key for 56,
> or moving this one into an encrypted keystore the way the PoG signer was, closes
> that window. Neither is done.

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
# Expect the deployer from §3, not the address that used to be written here --
# `0x4E41CEa9…E690` was a 4663 wallet and no longer exists in any role.
cast wallet address --private-key $env:PRIVATE_KEY   # expect 0x35b232E2...874a
```

The loader loop above is safe against this tree's `.env.production`: every
entry is a bare `KEY=value` with no inline comment, quoting or whitespace.
Re-check that if the file grows.

---

## 4. Preflight, dry run, then broadcast

**Run the preflight first, and note that §3 already assumes you did.** The banner
at the top of this file justifies `.env.production` by saying it "passes
`scripts/preflightMainnet.mjs`" — but no step anywhere told you to run it, so
that claim rested on someone having done it once, off the record, against a file
that has been rebuilt since. It is the only check that reads the environment as a
whole rather than one variable at a time, and it is the only one that runs before
anything is irreversible.

```powershell
# Reads .env.production. No arguments, no flags.
node scripts/preflightMainnet.mjs
```

It prints every role with the file it came from, then reaches the chain. Exit 0
is the only pass; it says so itself, because an exit 2 still prints a full and
reassuring-looking manifest above the failure. If it cannot reach the RPC it
stops there and reports `CANNOT RUN` — that is a blocked check, not a passed one,
and going on to the dry run at that point means broadcasting against
preconditions nothing has verified.

```powershell
# Dry run. No --broadcast: nothing is sent, and the chain-id guard still fires.
forge script script/DeployMainnet.s.sol:DeployMainnetScript --rpc-url $env:TARGET_RPC -vvvv
```

The chain-id guard now refuses two distinct mistakes, not one. It still rejects
an RPC that disagrees with `TARGET_CHAIN_ID`, and it additionally rejects a
`TARGET_CHAIN_ID` that is not 56 — so a shell still carrying the testnet export,
or a `.env` restored by habit, can no longer drive the *mainnet* script onto
testnet with every check green. Testnet deploys go through
`script/Deploy.s.sol`, which pins 97 from the other side.

The dry run also settles the **Infinity pairing**, which used to be a manual step
and is now not one. `INFINITY_CL_POOL_MANAGER` and `INFINITY_VAULT` are two
variables naming one pair; the script asks the manager for its own `vault()` and
refuses a value that disagrees, plus refuses either address if it holds no code
on this chain. That matters because a mismatched pair does not degrade — the
manager and the Vault each reject the other's counterparty, so the factory
deploys clean, the manifest reads correctly, and every `createLaunch` reverts.
Both addresses are immutable on the factory *and* on every hook it clones, so the
remedy is a full redeploy. You no longer have to check this by hand; if the dry
run is silent about it, it agreed.

Read the manifest it prints and confirm all four roles before going further —
`PROD owner`, `PoG Signer`, `Platform fee recipient` and `Deployer`.
`platformTreasury` is immutable **and** baked into the hook implementation, so
a wrong value there is another redeploy, not a config change.

```powershell
forge script script/DeployMainnet.s.sol:DeployMainnetScript `
  --rpc-url $env:TARGET_RPC `
  --broadcast `
  -vvvv
```

> **No `--verify`, and this line has now been wrong in both directions.** It
> first read `--verifier blockscout --verifier-url
> https://robinhoodchain.blockscout.com/api`, the retired chain's explorer.
> Blockscout does not serve chain 56 at any tier, so an operator following this
> file would have passed a verifier that **verifies nothing and reports success
> for having done so** — the deploy would look fully verified while BscScan
> showed unverified bytecode for the factory that holds every kill switch.
>
> The correction to that made it plain `--verify`, which contradicted the
> standing policy in `docs/DEVELOPMENT.md`: *"Verification is not part of the
> broadcast any more … Rather than put that key on a laptop, run
> `.github/workflows/verify.yml` by hand."* Two current documents gave opposite
> instructions for one deploy-day action, and the disagreement was about where a
> secret lives. This file is the one that was out of step.
>
> `--verify` also could not have worked as written. `ETHERSCAN_API_KEY` in
> `.env.production` is `REPLACE_ME_ETHERSCAN_V2_KEY` and preflight does not check
> it, so the flag would have failed at the end of an otherwise successful
> broadcast. That is recoverable — the transactions are on chain and recorded
> under `broadcast/`, so verification can be retried at leisure — but it is a
> failure arriving at the one moment nobody wants to be reading an error.
>
> **So: broadcast without verifying, then run `.github/workflows/verify.yml`.**
> It holds the key in Actions secrets, skips contracts already published and
> retries the rate limit. Nothing about verification needs to happen while the
> deploy machine still has a mainnet key in its environment, which also means
> §7's cleanup no longer has to wait on it.

Record `FACTORY_ADDRESS` and `TREASURY_ADDRESS` from the manifest.

### If the broadcast stops part-way

**This file warned about the half-deployed state for four revisions and never
said what to do about it**, which is the worst combination: an operator who has
just hit it is reading the one document that should know, at the one moment they
cannot afford to improvise. `preflightMainnet.mjs` names the state too ("leaves
exactly the half-deployed platform this script exists to prevent") and also stops
there.

**The answer is `--resume`, not a re-run.** Same command with `--resume` in place
of nothing; forge reads `broadcast/DeployMainnet.s.sol/56/run-latest.json` and
sends only what has no receipt.

```powershell
forge script script/DeployMainnet.s.sol:DeployMainnetScript `
  --rpc-url $env:TARGET_RPC --broadcast --resume -vvvv
```

Why a plain re-run is the wrong reflex here: the script is two dependent `CREATE`s
in one `startBroadcast` — `new ToshLadderTreasury(...)`, then
`new ToshFactory(..., address(treasury), ...)` — with no CREATE2 and no mined salt.
Re-running deploys a **second** treasury and wires the factory to that one, leaving
the first live, deployer-owned and referenced by nothing. Not dangerous, but it
burns the gas again and leaves an orphan on chain 56 forever that looks exactly
like a Tosh treasury to anyone reading the explorer.

**And expect to need this, because the RPC is the weak link rather than the gas.**
Measured from this machine on 2026-09-21, six `eth_chainId` calls per endpoint:

| endpoint | succeeded |
|---|---|
| `bsc-dataseed2.bnbchain.org` | 5 / 6 |
| `bsc-dataseed1.bnbchain.org`, `bsc-dataseed3`, `bsc-rpc.publicnode.com` | 4 / 6 |
| `bsc-dataseed4.bnbchain.org` | 2 / 6 |
| `bsc.drpc.org` | 1 / 6 |
| `binance.llamarpc.com`, `rpc.ankr.com/bsc` | 0 / 6 |

Every public endpoint is lossy from here — `tls handshake eof`, not a rate limit —
so this is the network path and not one bad host. The §4 dry run itself failed on
its first attempt and succeeded on its second. At a 67–83 % per-call success rate
a six-transaction broadcast is unlikely to complete in one pass, which makes
`--resume` the expected path rather than the exception. If you can broadcast from a
network that reaches an authenticated endpoint instead, prefer it.

---

## 5. After the broadcast, in order

Ownership first. Until the Safe accepts, the deployer EOA owns the factory, and
the factory must not be announced in that state.

> **Close the door before anything else — step 0 below.** `DeployMainnet.s.sol`
> broadcasts the factory **unpaused**, and the steps in this table are what make
> it fit to use: the launch fee is still the 9.28 BEM default until step 3, the
> dials are unconfirmed until step 4, and `VerifyDeployment` has not run until
> step 5. So between broadcast and step 5 the factory is open for business in a
> state nobody has checked yet.
>
> Note what this is and is not about. It is **not** a mitigation for a compromised
> deployer key — an attacker holding that key can simply unpause. What it stops is
> a **third party** launching a project against default dials and unverified
> invariants, which is not far-fetched: new contracts on `56` are indexed within
> blocks, and `createLaunch` needs no announcement, no allowlist and no referral
> to find. A launch created in that window cannot be undone; the token, the pool
> and the genesis clock are all real.
>
> `pause()` is the right brake here because of what it deliberately spares. It
> stops `createLaunch` and `registerPoG` — new entrants — while leaving `deposit`,
> `refund` and `claim` reachable, so if something does land in the window it is
> not trapped by the fix.

| # | Step | Done when |
|---|---|---|
| 0 | **Deployer EOA** calls `pause()` on the factory, in the same session as the broadcast and before anything else | `factory.paused()` is `true`. Do this even though the factory is unannounced — see the note above for what it is actually protecting against |
| 1 | Safe calls `acceptOwnership()` on the **factory** | `owner()` is the Safe and `pendingOwner()` is `address(0)` |
| 2 | Safe calls `acceptOwnership()` on the **treasury** | same two reads on the treasury |
| 3 | Safe calls `setLaunchFee(1000000000000000)` — **0.001 BNB**, decided 2026-09-21, see below | `launchFee()` returns `1000000000000000`, not the `5000000000000000` default. Check the units: this is native wei, and the figure is 1e15 |
| 4 | Confirm the dials nobody has to touch | `defaultSoftCap()` = `928.4e8`, `maxPogAllocationLimit()` = `46.4e8` — i.e. 928.4 and 46.4 **BEM**, at 8 decimals — and `cooldownDuration()` = `259200` (72 h) |
| 4a | Read the cooldown as policy, not as a throttle | At 72 h it is at least `DURATION_SLOW`, so it is the **one-deposit-per-wallet-per-project** rule. Lowering it restores instalment deposits, silently: nothing reverts, the UI stops saying "one deposit per wallet", and a wallet can accumulate to `perWalletCap` across refilled quota windows. Treat it as a market parameter, not a spam knob |
| 4b | Confirm the asset all three contracts are denominated in | `factory.quoteAsset()`, `hookImplementation().quoteAsset()` and `treasury.quoteAsset()` all return BEM. There is no setter; a disagreement here is a redeploy |
| 5 | `forge script script/VerifyDeployment.s.sol:VerifyDeploymentScript --sig "run(address)" $env:NEXT_PUBLIC_FACTORY_ADDRESS --rpc-url $env:TARGET_RPC` | all invariants pass, including `factory.platformTreasury() == hookImplementation().platformFeeRecipient()` |
| 6 | `forge build; node scripts/extractAbis.js` | `git diff` on `soat-frontend/src/app/lib/abis.ts` is empty (it was regenerated before the branch was committed) |
| 7 | Vercel Production: the **six** variables below, not two | `cd soat-frontend; npm run check:quote` agrees with the chain — see below |
| 8 | Push the five commits to `main` | CI green |
| 9 | Repoint `monitoring/` — the **four** repo variables below | a watch run reports the new addresses with 0 findings |
| 10 | **Safe** calls `unpause()` — last, after step 5 passed and step 9 is watching | `factory.paused()` is `false`. This is the moment the launchpad goes live, so it belongs after verification and after monitoring, not before |

**Step 7 is six variables, and Production currently holds the chain-97 set.**
Naming only the factory and the quote asset is how a half-switched frontend
happens: the chain id would still say 97, so wallets would prompt for the wrong
network against a mainnet factory.

```
NEXT_PUBLIC_CHAIN_ID=56                  # currently 97
NEXT_PUBLIC_FACTORY_ADDRESS=<new>        # currently the 97 rehearsal factory
NEXT_PUBLIC_TREASURY_ADDRESS=<new>
NEXT_PUBLIC_QUOTE_ASSET=0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a   # currently the 8-decimal mock
NEXT_PUBLIC_QUOTE_SYMBOL=BEM             # currently mBEM
POG_SIGNER_PRIVATE_KEY=<the rotated signer's key>                    # currently the 97 throwaway — PM-C7
```

Set Preview to the same values or leave it on 97 deliberately; what must not
happen is Preview silently becoming a mainnet build nobody reviewed.

**Six edits are not six changes, and the Vercel UI will happily treat them as
six.** Saving a variable can trigger a rebuild on its own, so editing them one at
a time can ship a build carrying three new values and three old ones — a chain id
of 97 against a mainnet factory, or a BEM symbol over the 8-decimal mock. Both
are states no row of this table describes and no check catches, because each
variable is individually correct. Turn off any automatic redeploy while editing,
save all six, and only then trigger one Redeploy from the Deployments tab. The
rollback note at the end of §6 makes the same argument from the other direction.

**Step 9's trap is `MONITOR_EXPECTED_OWNER`.** These are GitHub Actions *repo
variables*, not files, so they do not move with a commit and nothing in CI
notices they are stale.

```
MONITOR_FACTORY=<new>                    # currently 0x51Bb18FE739e21A07d5F092b37504988Ae81C546 (97)
MONITOR_TREASURY=<new>                   # currently 0x5BBcA0BEC63EF0B9B3eAa96499fBDdefE9CC9FCC (97)
MONITOR_EXPECTED_OWNER=0x02DE4629129D104C63329D13A6Ca67E43db7B310    # the SAFE, not the deployer
MONITOR_EXPECTED_POG_SIGNER=0xc7B7CB00A4B5CBe832Caa7369FbcBbd6385E581D
```

On 97 `MONITOR_EXPECTED_OWNER` is the deployer EOA, because nothing ever handed
that factory to a Safe. Copying that shape to 56 inverts the check: it would
page `GOV-01` the moment step 1 succeeds, and read green for exactly as long as
ownership is still sitting on the deployer — green during the one window that is
actually dangerous. Set it to the Safe, matching the end state of steps 1 and 2.

Leaving all four stale is the quieter failure: the watcher keeps polling a
healthy chain-97 factory every 15 minutes and reports 0 findings, while the
mainnet deployment nobody is watching holds every kill switch.

**So flip `STANDING_CHAIN_ID` first, and let the pager drive the rest.** Step 9
is four repo variables *and* two fields in `monitoring/alerts.json` — `chainId`
and the whole `addresses` block — and the order matters because only one of those
edits makes the others self-enforcing:

```
scripts/lib/retiredChains.mjs   STANDING_CHAIN_ID = 97  ->  56
```

That single number is what `WATCHER-09` compares the catalogue against, and it
was added for exactly this step. Move it first and every pass pages P1 until
`alerts.json` and the `MONITOR_*` variables follow, so a cutover interrupted
halfway is loud. Move it last and the window in between is silent — which is the
state described in the paragraph above, and the same shape as the ~1,000 green
passes about chain 4663.

`WATCHER-08` will not cover this one. It needs the stale target to be a *retired*
chain, and 97 is not retired: it stays the rehearsal chain, `Deploy.s.sol` pins
it, and the drill harnesses are supposed to run there. Do not add 97 to
`RETIRED_CHAINS` to get a pager out of it — that would refuse every legitimate
testnet drill. "Retired" and "not what the pager is for" are different
properties; `STANDING_CHAIN_ID` is the second one.

**Step 3 is not optional, and it no longer has an answer written down.** It
used to read `setLaunchFee(0.01 ether)`, then `setLaunchFee(9.28e8)` after
the BEM move. Both halves are obsolete: the fee is **native BNB again**
(`launchFee = 0.005 ether` in `src/ToshFactory.sol`), and there is no "what
mainnet charges today", because 56 has never launched anything. The old
figures were prices in ETH and then BEM, and neither can be carried across by
editing the unit.

So the fee is a decision owed before the broadcast, not a value to copy out of
this table. What constrains it: `MAX_LAUNCH_FEE` is **0.5 BNB**, so anything
sensible is legal; it is collected as **`msg.value`** on `createLaunch`, so
the creator pays it in the same transaction that opens the round and does
**not** approve BEM first; and it is settable afterwards by the Safe, so it
is reversible in a way the immutable dials are not. Left at the default, the
first creator pays 0.005 BNB to open a round — whether that is right is the
question, and it is the kind of question a runbook must not answer by inertia.

**Decided 2026-09-21: `0.001 BNB` (`1000000000000000` wei).** A promotional
figure, deliberately low, and the reasoning is what makes it not zero.

Zero was asked for first and is legal — `setLaunchFee` has only a ceiling, no
floor. What ruled it out is `SCAN_DEPTH = 48` in
`soat-frontend/src/components/directory/useDirectoryProjects.ts`: the directory
shows the newest 48 launches, and `createLaunch` is a **measured 558,509 gas**
(`test_createLaunch_gasStaysUnderBudget`). At 0.05 gwei that is about **$0.018**
a launch, so **48 of them — enough to push every real project off the
directory — costs about $0.87**, repeatably. `/referrals` is bounded by the same
constant and says so in its own comment, so a referrer whose commission sits on
a buried launch is told they have none. **The fee is the only economic gate on
creation**: `createLaunch` has no per-creator cooldown, no allowlist and no PoG
requirement, and `nameTaken` only forces a fresh name+symbol per attempt.

0.001 BNB does not deter a real creator — it is 1/5 of the default and
1/500 of the ceiling — while taking the price of burying the directory from
$0.87 to about **$31**. That is not a wall, and it is not meant to be one; it is
enough to make the griefing cost visible, and the Safe can raise it in one
transaction if it stops being.

**No frontend change is needed for this, and that was checked rather than
assumed.** `launch/page.tsx` reads `launchFee()` live through
`useReadContracts`, **re-reads it immediately before submitting** (the one dial
in that batch that used to go stale), and passes the same figure as both
`expectedFee` and `value`, simulating with it too. Only `MAX_LAUNCH_FEE` is
mirrored into TypeScript, and `checkContractConstants.ts` guards that. The
`FeeChanged` check is also one-sided — `if (fee > expectedFee)` — so a session
still holding the 0.005 default is not broken by the reduction: the factory takes
0.001 and refunds the rest as change. `formatEstimateEth` renders 1e15 as
`0.001`, verified, so the panel does not show a fee of `0`.

**Write the figure in native wei when you send it.** `setLaunchFee(0.005
ether)` is the factory default. `setLaunchFee(9.28e8)` is 928 million BNB
and reverts against `MAX_LAUNCH_FEE`. The near miss that does land is an
order-of-magnitude slip inside the 0.5 BNB ceiling;
`test_setLaunchFee_rejectsOrderOfMagnitudeSlip` is the guard, and it only
covers the extreme. **Count the zeros on the decided figure before you sign it**:
`1000000000000000` is a one followed by **fifteen** zeros. Fourteen gives
0.0001 BNB, which is cheaper than the zero fee this decision rejected;
sixteen gives 0.01 BNB, twice the default it undercuts. Both are legal, both
pass every guard, and neither is what was decided.

**Two of the commands above will not run as written if you drop a flag or a
directory, and both failures look like something else.**

`VerifyDeployment.s.sol` declares both `run()` and `run(address)`, so forge
cannot pick an entry point from the ABI and step 5 needs `--sig`. Without it the
command dies on `Multiple functions with the same name 'run' found in the ABI`,
which reads like a broken script rather than a missing flag — the same trap
`script/RecomputeInitcodeHash.s.sol` documents in its own header. Passing the
factory explicitly is also what you want here: the no-argument overload reads
the address from the environment, and on deploy day the environment is the thing
under test.

`check:quote` is a script in `soat-frontend/package.json`. There is no
`package.json` at the repo root, so `npm run check:quote` from the tree root
fails with `ENOENT` / "Could not read package.json" — not with a verdict about
the quote asset. Step 7 therefore begins with the `cd`.

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
redeploying.

⚠ **THIS PARAGRAPH USED TO SAY CHAIN 97 WAS IN THE SECOND STATE. IT IS NOT, AND
  HAS NOT BEEN SINCE THE 97 REBUILD.** The factory now at
  `0x51Bb18FE739e21A07d5F092b37504988Ae81C546` answers
  `quoteAsset()` with `0x76bD1ceC663AE3242e5267e232B821C51a4882EB` and holds one
  launch, so 97 is in the *first* state at worst — an env-var question, not a
  redeploy. The claim survived because the row in step 9 above was updated to the
  new address while the prose here was not, which is the same staleness this file
  warns about two sections earlier.

  It also argued from a fact that does not support it: `RehearseTestnet.s.sol`
  does say the asset it rehearses against is not BEM, and that is still true —
  BEM has no deployment on 97, so the rehearsal runs against an 8-decimal mock.
  But that is a statement about the *token*, not about the factory. The script
  reads `factory.quoteAsset()` to find it, which only a post-BEM factory can
  answer. The two claims were read as one.

**Steps 7 and 8 belong together.** The committed frontend copy shows a
countdown to the genesis deadline and does not name a raise target. That is
true of the new factory and false of every hook that still treated `softCap`
as a refund door, so shipping the copy while the site still points at an old
factory tells existing depositors the wrong thing about their refunds.

---

## 6. Rollback points

| Position | Reversible? | Cost of backing out |
|---|---|---|
| Before the broadcast | fully | nothing |
| Broadcast done, Safe has not accepted | yes | the new factory exists, is owned by the deployer EOA, is unannounced and is referenced by nothing. Abandoning it costs the ~0.00076 BNB already spent. There is no old factory on 56 to fall back to, so "backing out" here means 56 has nothing deployed, not that traffic returns somewhere |
| Safe has accepted, Vercel not switched | yes | same as above. Ownership being correct does not make the factory live; nothing points users at it |
| Vercel switched | **the last exit** | reverting `NEXT_PUBLIC_FACTORY_ADDRESS` restores the old directory, but any project created on the new factory in the meantime vanishes from the site and its depositors lose their route to `refund()` through the UI |
| First launch created on the new factory | no | that hook is immutable and its depositors are committed |

If something is wrong after the switch and the old factory must take traffic
again, revert the Vercel variable **first** and the commits second. The
variable is one setting and takes effect on redeploy; the commits are a build.

> **On 56 the last two rows are weaker than they read, because this is a first
> deployment.** The table was written for a redeploy, where reverting the Vercel
> variable hands traffic back to a working mainnet factory. There is no such
> factory on 56. Reverting points production at the **chain-97 rehearsal**, so
> the rollback is not "serve the old version", it is "take the product down to a
> testnet" — and it only works at all if the chain id is reverted with it, which
> is the argument for treating step 7's six variables as one atomic change.

There is no `pause()`-based rollback worth planning around: pausing the new
factory stops `createLaunch` and `registerPoG` but does nothing for a genesis
round already open on it.

That is not in tension with §5 step 0, and the difference between them is exactly
why step 0 is worth doing. `pause()` is useless as a *rollback* because by then the
launches it cannot reach already exist; it is useful as a *gate* because before
step 10 there are none, and keeping it that way is the whole point.

---

## 7. Clean up the deploy machine

The session that ran the broadcast holds a mainnet key in `$env:PRIVATE_KEY`
and has the testnet tree renamed out from under it. Neither should outlive the
deploy.

```powershell
Remove-Item Env:\PRIVATE_KEY
Rename-Item .env.testnet-parked .env

# The key must not be in any file. See the note below: on this tree it WILL
# print one line, and that line is expected.
Select-String -Path (Get-ChildItem .env* -Force -Exclude *.example) -Pattern '^PRIVATE_KEY=.+'
```

> **"This should print nothing" stopped being true on 2026-09-19.** `.env` holds a
> `PRIVATE_KEY` by design — it is how `forge` drives chain 97 — and since the 97
> rebuild that key is the same one as the mainnet deployer. So the expected result
> is exactly **one** hit, on `.env`, and the check no longer distinguishes "clean"
> from "the mainnet key is lying around": both look identical. Treat a hit on any
> file **other** than `.env` as stop-everything, and treat the `.env` hit as the
> open item flagged at the end of §3 rather than as a pass.

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
