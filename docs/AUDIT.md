# Static analysis: Slither + Cyfrin Aderyn

Two analysers run against `src/` on every push. Both are gated the same way —
a baseline file pins the exact finding set, so a detector cannot start or stop
firing without somebody deciding about it. Neither gate is advisory.

| | Slither | Aderyn |
|---|---|---|
| Pinned version | 0.11.6 | 0.6.8 |
| Baseline | `slither-baseline.json` | `aderyn-baseline.json` |
| Gate | `scripts/checkSlitherFindings.mjs` | `scripts/checkAderynFindings.mjs` |
| Scope | `src/` (`--filter-paths lib/\|test/\|script/`) | `src/` (inferred from `foundry.toml`) |
| Current | 103 findings, 1H/33M/33L/36I | 164 findings, 33H/131L |
| Runtime | ~15 s, plus a slower `pip install` | ~6 s, no compile of its own |

## Why both

They disagree usefully. Slither reasons over a control-flow graph and is
stronger on dataflow; Aderyn walks the AST and is stronger at "this is
declared and nothing references it". On the first Aderyn run against this tree
its 19 detectors overlapped Slither's on almost nothing, and the one finding
worth acting on — three unreferenced imports, since removed — was in a
category Slither does not report at all.

Neither tool has found a real vulnerability here. That is the expected outcome
and is not the reason to run them: the value is that a *new* finding fails the
build, so a change that introduces one cannot land while nobody is looking.

## Running them

```bash
node scripts/checkSlitherFindings.mjs          # verify against the baseline
node scripts/checkAderynFindings.mjs           # same, for Aderyn
node scripts/checkAderynFindings.mjs --update  # re-triage: rewrite the baseline
```

`--update` is not a way to make CI green. It rewrites the disposition record,
and doing that without reading what moved is the exact drift the gate exists
to prevent.

### Installing Aderyn on Windows

Aderyn ships **no Windows binary**. The npm package supports only darwin and
linux, and `npm install -g @cyfrin/aderyn` on Windows leaves a shim that fails
later with `MODULE_NOT_FOUND` rather than an honest "unsupported platform" —
which is how this repository ended up with a broken `aderyn` on PATH that
looked installed.

So it runs through WSL, and `checkAderynFindings.mjs` shells into WSL
automatically on win32. To set that side up once:

```bash
# in WSL, with the release tarball already downloaded on the Windows side
PUBLISHED=$(awk '{print $1}' aderyn-x86_64-unknown-linux-gnu.tar.xz.sha256)
ACTUAL=$(sha256sum aderyn-x86_64-unknown-linux-gnu.tar.xz | awk '{print $1}')
[ "$PUBLISHED" = "$ACTUAL" ] || { echo mismatch; exit 1; }
tar -xJf aderyn-x86_64-unknown-linux-gnu.tar.xz
install -m 0755 aderyn-x86_64-unknown-linux-gnu/aderyn ~/.local/bin/aderyn
```

Download on the Windows side (`gh release download aderyn-v0.6.8 --repo
Cyfrin/aderyn`) rather than curling from inside WSL, which sits behind a proxy
here that breaks outbound requests.

Do not verify with `sha256sum -c`: the published `.sha256` names the artefact
with the build host's path prefix, so `-c` cannot resolve the name and exits 1
with "no file was verified", which reads as a mismatch when it is not one.

### When the gate fails

It prints one of three things, and they mean different things:

- **NEW finding** — triage it, record the disposition below, then `--update`.
- **count changed** — the same detector fires more or fewer times at one site.
  Usually a loop or a branch was added; check it is the change you intended.
- **finding GONE** — the baseline disposes of something that no longer exists.
  Confirm the removal was deliberate (it often is, after a refactor) and
  `--update`.

## Slither: v2

Re-baselined on 2026-10-28, from 87 to 103, against the v2 contracts deployed
on BNB Smart Chain at block 130243379. v2 replaced the deposit-and-refund sale
with a GENESIS curve gated on Binance Agent ID, and added a shared pre-launch
bid book and a second quote asset (USDT beside WBNB). 29 findings are new, 15
left with the v1 code they described, and none is a defect.

Medium:

- **`tx-origin`** — `ToshToken._update`. The pre-launch transfer rule:
  before `openTrading()`, a transfer has to be sent by the holder's own wallet,
  executed by that wallet or the bid book, and land on a registered wallet.
  `tx.origin` can only make this stricter. The pattern the detector exists for
  — a contract the victim calls, spending the victim's balance — is the one
  `caller != from && caller != bidBook` refuses. The rule switches off for good
  at launch.
- **`incorrect-equality`** — `ToshLadderTreasury._buyAndBurn` compares
  `lastLegBlock[token] == block.number`, a one-leg-per-block guard that an
  attacker can only trip, not hold open. The other strict equalities, new and
  old, are zero checks that skip work.
- **`uninitialized-local`** — `_addInitialLiquidity.quoteOwed` and
  `.tokensOwed` (renamed from one shared `owed`), and `ToshBidBook.fill.fees`.
  Each starts at zero on purpose and is written only on the branch that owes
  or accrues something.
- **`unused-return`** — `getVaultReserve()` in `_runPiggyback` (only the
  synced currency matters) and `getSlot0()` in `_spotStretchedAboveTwap`
  (only the price matters).

Low and Informational:

- **`calls-loop`** — `ToshBidBook.factoryOf` and `initialize` loop over the
  factories the book serves, which are fixed at initialisation (two on chain
  56); `ToshHookLens.getTiers` is a view the frontend pages through.
- **`low-level-calls`** — `buyGenesis` returns unspent BNB to the buyer with a
  plain `call`, as the last statement of a `nonReentrant` function whose state
  is already written, and reverts if the refund fails.
- **`timestamp`** — `buyGenesis`, `launchStart`, `genesisBlocked` and
  `releaseAbandonedName` read the genesis deadline, the sell-out time and
  blacklist expiry. Validator skew of seconds does not matter at
  hour-scale windows.
- **`assembly`** — `AgentIdLib._boundedStaticcall`, `handleOf` and
  `ownerOfHandle` cap the gas and the size of the return data from the Agent ID
  registry, so a misbehaving registry cannot grief a buy; `WalletLib.isWallet`
  reads `extcodesize` and the EIP-7702 delegation prefix.
- **`cyclomatic-complexity`** — `buyGenesis` and `ToshBidBook.fill`. Each check
  is a separate early revert or skip, and splitting them would only move them.
- **`naming-convention`** — interface getters for public constants
  (`ADMIN_LAUNCH_WINDOW`, `TIER_COUNT`, `TIER_SIZE`, `TRIGGER_STEP`) keep the
  constant's name, as do `HOOK_RUNTIME_CODEHASH` and `PIGGYBACK_TRIGGER_STEP`,
  which are immutables set once in a constructor.
- **`missing-inheritance`** — `CircuitRevenueVault` matches an interface the
  hook declares without importing it, the same shape as the treasury and the
  gateway.

What left: v1's `deposit`, `refund`, `canRefund`, `registerPoG`,
`eligibility` and the quota window, the hook's `getTier`/`getTiers` (moved to
`ToshHookLens`), `ladderViable`, and `HookDeployLib`, which the clone factory
replaced. The single High, `weak-prng` in `_twapSqrtPriceX96`, is unchanged
and is not randomness: `delta % span` decides whether the average tick is
rounded down toward negative infinity, the same correction Uniswap's
`OracleLibrary.consult` makes.

## Aderyn disposition record

23 detectors, 164 instances, all triaged, nothing unresolved.

Re-baselined on 2026-10-28 against v2. `src/` went from 10 source units to
14: `ToshBidBook`, `ToshHookLens`, `AgentIdLib`, `WalletLib` and
`GenesisCurve` arrived, and `HookDeployLib` left. Three detectors fired for the
first time:

**`tx-origin-used-for-auth`** — 1, `ToshToken._update`. The pre-launch
transfer rule described under Slither's `tx-origin` above. It narrows what a
transfer may do and grants nothing.

**`unsafe-erc20-operation`** — 1, `ToshToken.approve`. False positive. The line
is `super.approve` inside the token's own override, which refuses approvals to
anyone but the bid book before launch; it is not a call into some other token
whose return value could be dropped.

**`internal-function-used-once`** — 2, `AgentIdLib.handleOf` and
`AgentIdLib.ownerOfHandle`, the two registry reads `agentKeyOf` is built from.
Kept as named steps; inlining them changes nothing.

And one stopped: **`contract-locks-ether`** — was 1, on v1's
`ToshFactory.depositNative`. The v2 factory has no payable entry; native BNB
reaches only the hook's `buyGenesis`, which wraps what it spends and returns
the rest in the same call.

These counts are the baseline's, and they are worth re-reading against it when
this file is touched. The prose below drifted from `aderyn-baseline.json` once
already — it described 19 `centralization-risk` instances against a baseline
holding 21, and its own per-detector figures summed to 96 while the header
claimed 97. Nothing was wrong with the gate, which compares against the
baseline and never reads this file; what was wrong was the document a reader
is pointed at, which is the only part of this that is published.

### High

**`abi-encode-packed-hash-collision`** — 3, in `ToshCloneLib.bareCloneInitcode`,
`ToshCloneLib.cloneInitcode` and `ToshCloneLib.vaultCloneInitcode`. Not
applicable. All three take only fixed-width arguments: `hex"…"` literals,
`address`, `uint128`, `uint128`, `uint32`, and the vault's `uint256` token id.
An `encodePacked` collision needs at least two adjacent variable-length
arguments so the boundary between them can shift; there is no variable-length
argument here at all, and there cannot be, because the output is EVM bytecode
where a shifted boundary would be a different program rather than an ambiguous
encoding. The code already handles the one real version of this concern: the
`uint128` and `uint32` range checks at the top of `cloneInitcode` exist so a
silent truncation cannot make two different caps or durations produce the same
initcode hash.

**`reentrancy-state-change`** — 28, in three groups, none reachable:

- 18 are inside `nonReentrant` functions: `ToshBidBook.placeBid` ×5 and
  `fill` ×4, `ToshFactory.createLaunch` ×3, and on the hook `launch` ×4,
  `buyGenesis` and `mintBondingCurve`. Aderyn does not model modifiers. Most
  of these calls are also views on the hook or factory the function has just
  checked is registered, and `placeBid` writes the bid before it pulls the
  escrow.
- 4 run before anyone else can call in: the factory constructor, the hook
  implementation's constructor ×2 (`decimals()` on the quote asset and the
  treasury's `TRIGGER_STEP()`), and `ToshBidBook.initialize`, which only the
  deployer can call, once, and which has already run on chain 56.
- 6 call `external view` functions, which solc compiles to `STATICCALL`, so
  no state can change during them: `ToshFactory.releaseAbandonedName` reading
  `raised()` and `genesisDeadline()`, and `ToshLadderTreasury.addLadderToken`
  ×5 (`tokenToHook()`, `launched()`, `twapSqrtPriceX96()`, `getPoolKey()`),
  which is owner-only besides. Aderyn does not model mutability.

`releaseAbandonedName` is the one worth naming individually, since it is
permissionless and takes an address argument: its first statement is
`if (!registeredHooks[hook]) revert HookNotRegistered()`, so the callee is
always a clone this factory deployed, never caller-supplied code.

**`unsafe-casting`** — 1, `ToshLadderTreasury._buybackSqrtFloor`. Cannot
truncate. The cast is `uint160(floor)` where
`floor = twapSqrt × (BPS_DENOMINATOR − MAX_BUYBACK_SQRT_DEVIATION_BPS) /
BPS_DENOMINATOR`, `twapSqrt` is already `uint160`, and both constants are
`constant` — 10 000 and 1 000 — so the factor is a compile-time 0.9. `floor`
is strictly smaller than a value that already fits.

### Low

**`unused-import`** — was 3, in `ToshLadderTreasury`: `IHooks`,
`IPoolManager`, `ILockCallback`. **Genuine, and the only Aderyn finding that
resulted in a code change.** All three were imported and referenced nowhere.
`ILockCallback` is the one that looks like a mistake and is not: the contract
does implement `lockAcquired`, but the Vault dispatches to it by selector, so
declaring the interface bought nothing. Removing them changed only the CBOR
metadata at the end of the treasury's creation code. The gate failed with
"finding GONE" rather than silently accepting a smaller finding set, which is
the half of the baseline contract that only matters when something is fixed.

**`unused-error`** — 1, `ToshLaunchpadHook.OnlyCreator`. Opening the pool
moved behind the Circuit holder's admin window, and the error is kept so the
ABI does not lose a selector indexers may already match on. Its companion
`NativeTransferFailed` is in use again, by the BNB refund in `buyGenesis`.

**`unused-state-variable`** — 1, `ToshLadderTreasury._PIGGYBACK_SLOT`. False
positive, and the most important one to understand before trusting this
detector: the constant *is* used, at the `tload` and `tstore` that implement
the treasury's hand-rolled reentrancy mutex. Aderyn's AST walk does not
descend into `assembly` blocks. Read as written, this finding says the mutex
is dead code.

**`non-reentrant-not-first`** — 4. The detector asks a real question — whether
a modifier ahead of `nonReentrant` can make an external call before the guard
engages — and the answer here is no for all four. `onlyOwner` and
`whenNotPaused` on `createLaunch`, and `initialized` on the hook's
`buyGenesis`, `launch` and `mintBondingCurve`, are plain storage reads with no
call.

**`unchecked-return`** — 7. Each is a return value nobody needs:
`vault.lock` and `vault.settle()` return amounts already known to the caller
(`collectGenesisFees`' callback returns empty bytes), `poolManager.initialize()`
returns the resulting tick, and `_grantRole()` returns whether the role was
newly granted inside the token's run-once `initialize`.

**`centralization-risk`** — 20. Accurate and by design. Mainnet ownership is a
2-of-3 Gnosis Safe (SafeL2 1.4.1, `0x02DE4629129D104C63329D13A6Ca67E43db7B310`).
Each v2 factory is owned by its `ToshLaunchGateway` — BNB
`0xdaA1F95d4D319B04792759551587E24c751f2EaA`, USDT
`0x16efaC5111417F810f23817B5EEB95Cb14801881` — which lets any current signer
of that Safe call `createLaunch` and forwards every other owner call only from
the Safe itself. Both ladder treasuries are owned by the Safe directly. On the
factory the detector names the contract and twelve functions: `pause`,
`unpause`, `renounceOwnership`, `setHardCapBounds` and `setAgentCapBounds`
(bounded by hard-coded absolute limits), `setGenesisPaused`, `setBlacklist`
and `liftBlacklist` (batches of at most 200), `haltLadderMinting` (bounded by
`MAX_HALT_DURATION`) and `resumeLadderMinting`, `createLaunch`, and
`releaseName`, which frees the name of a launch the platform did not mean to
list and is kept with the Safe as a whole rather than with a single signer. On
the treasury: the contract, `renounceOwnership`, `setFactory` (once only),
`addLadderToken` and `removeLadderToken`. Every one emits an event, and
`README.md` §"Contracts" says who owns what.

The Safe's shape is stated once and checked. This paragraph read **3-of-5**
until 2026-09-22, and it was the only place in the repository that did: the
deploy refused any other Safe than 2-of-3, the frontend said 2-of-3, and the
three signers each signed a message naming the role as "(2-of-3, BNB Smart
Chain 56)" — so the consent on record is to 2-of-3 as well.

Nothing was mis-built; one published sentence was wrong about what was built.
The direction is what makes it worth writing down rather than quietly fixing: it
**overstated** the protection. A reader weighing custody risk was told three
signatures stand between them and every owner-only dial, when two move them.
`checkAuditDoc.mjs` now compares this claim with the shape
`script/DeployV2.s.sol` enforces on chain 56.

Two of those 20 are worth naming, because the detector reads them exactly
backwards: `ToshFactory.renounceOwnership` and
`ToshLadderTreasury.renounceOwnership` are `onlyOwner` functions that
unconditionally **revert**. They exist to *remove* a power, not to hold one.
`Ownable2Step` inherits from `Ownable` a one-call, unconfirmed
`renounceOwnership` that sets the owner to zero, which would permanently
disable `pause`, `setBlacklist`, `haltLadderMinting` and every other brake on a
live launchpad holding user funds, and freeze the ladder list so a rugged token
could never be delisted. Both overrides revert; `onlyOwner` stays in front so a
stranger is still refused as a stranger. Pinned by `test_renounceDisabled` and
`test_revert_treasury_ownership`.

Two more sit on `ToshToken` — the contract itself and `ToshToken.mint` — and the
detector reads these backwards too. The token has no owner at all.
`MINTER_ROLE` is granted once, to the hook, inside an `initialize` the factory
calls exactly once, and **`DEFAULT_ADMIN_ROLE` is left deliberately vacant**, so
`grantRole` and `revokeRole` have no eligible caller for the rest of the token's
life: the minter cannot be changed, added to, or taken away by anyone,
including the platform. Supply is bounded independently by the `MAX_SUPPLY`
check inside `mint`, and there is deliberately no kill-switch.

**`unused-public-function`** — 10: on the hook `creator`, `projectTreasury`,
`currentTierIndex`, `currentTierSold`, `phase2Minted`, `currentGenesisPrice`,
`maxMintable` and `lastSwapBlock`, and on the lens `basePrice` and
`publicLaunchAt`. Read by the frontend, by monitoring, and — for
`currentGenesisPrice` — by the bid book through an interface, none of which is
visible to a tool that only sees `src/` by name.

**`unsafe-oz-erc721-mint`** — 1, `CircuitNFT.mint`. Deliberate. `_mint`
rather than `_safeMint` means minting the developer's Circuit cannot call
into the developer's address in the middle of `createLaunch`; a developer
contract that cannot hold ERC-721s is the developer's choice to make.

**`missing-inheritance`** — 2, `ToshLaunchGateway` and `CircuitRevenueVault`,
each matching a minimal interface declared elsewhere without importing it.
Inheriting would pull another contract's interface file in for no behavioural
change.

**`push-zero-opcode`** (14) and **`unspecific-solidity-pragma`** (9) — both
follow from `^0.8.24`/`^0.8.26` pragmas plus `evm_version = "cancun"`. PUSH0 is
intended; Shanghai-or-later is a deployment requirement this project already
depends on more sharply elsewhere (the transient-storage mutex needs Cancun,
verified by execution against chain 56 — see `foundry.toml`).

**`local-variable-shadowing`** (15) — 14 are the fields of `ToshFactory.Config`,
the constructor's argument struct, which are named after the state variables
they initialise; the fifteenth is `ToshLadderTreasury`'s constructor parameter
`_owner`, which shadows `Ownable`'s private slot and is handed straight to
`Ownable`'s constructor. Nothing is shadowed at run time.

**`literal-instead-of-constant`** (17), **`large-numeric-literal`** (8),
**`modifier-used-only-once`** (6), **`costly-loop`** (4),
**`require-revert-in-loop`** (6), **`uninitialized-local-variable`** (3) — style
findings with no behavioural claim. The uninitialised locals are loop counters
starting at zero; the loops that revert are batch operations (the bid book's
fills, the factory's blacklist batches) or bounded ladder walks where partial
application would be worse than rejection.
