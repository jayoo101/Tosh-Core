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
| Current | 76 findings, 1H/29M/27L/19I | 98 findings, 16H/82L |
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

## Aderyn disposition record

18 detectors, 98 instances, all triaged, nothing unresolved.

These counts are the baseline's, and they are worth re-reading against it when
this file is touched. The prose below drifted from `aderyn-baseline.json` once
already — it described 19 `centralization-risk` instances against a baseline
holding 21, and its own per-detector figures summed to 96 while the header
claimed 97. Nothing was wrong with the gate, which compares against the
baseline and never reads this file; what was wrong was the document a reader
is pointed at, which is the only part of this that is published.

### High

**`abi-encode-packed-hash-collision`** — 2, in `ToshCloneLib.bareCloneInitcode`
and `ToshCloneLib.cloneInitcode`. Not applicable. Both calls take only
fixed-width arguments: `hex"…"` literals, `address`, `uint128`, `uint128`,
`uint32`. An `encodePacked` collision needs at least two adjacent
variable-length arguments so the boundary between them can shift; there is no
variable-length argument here at all, and there cannot be, because the output
is EVM bytecode where a shifted boundary would be a different program rather
than an ambiguous encoding. The code already handles the one real version of
this concern: the `genesisDuration > type(uint32).max` revert immediately
above `cloneInitcode`'s encode exists precisely so a silent truncation cannot
make two durations produce the same initcode hash.

**`reentrancy-state-change`** — 13, split into two causes, neither reachable:

- 6 are inside `nonReentrant` functions (`ToshFactory.createLaunch` ×2,
  `ToshLaunchpadHook.launch` ×3, `ToshLaunchpadHook.mintBondingCurve`). Aderyn
  does not model modifiers.
- 7 call `external view` functions, which solc compiles to `STATICCALL`, so no
  state change can occur during them: `canRefund()`, `tokenToHook()`,
  `launched()`, `twapSqrtPriceX96()`, `getPoolKey()`, `decimals()`,
  `balanceOf()`. Aderyn does not model mutability.

`ToshFactory.releaseAbandonedName` is the one worth naming individually, since
it is permissionless and takes an address argument: its first statement is
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
declaring the interface bought nothing.

Removing them was measured rather than estimated, because this repository's
CREATE2 addresses are sensitive to anything that moves a metadata hash. The
result: `ToshLadderTreasury`'s creation code changed in its **last 43 bytes
only** — the CBOR metadata blob — with the executable code byte-identical, and
`ToshLaunchpadHook` and `ToshFactory` unchanged entirely. So no hook address
moved and no initcode hash needed republishing; PM-C6 did not apply.

The cost was one chain 97 redeploy, so the deployed treasury keeps
byte-matching a fresh build. Verified after deployment by comparing runtime
code with the 384 bytes of immutables masked out.

The gate behaved as intended across this: it failed with "finding GONE" rather
than silently accepting a smaller finding set, which is the half of the
baseline contract that only matters when something is fixed.

**`unused-error`** — 1, `ToshLaunchpadHook.NativeTransferFailed`. Intentional
and already documented at the declaration: unreachable since `_payQuote` moved
to `SafeERC20.safeTransfer`, which bubbles the token's own revert, and kept so
the ABI does not lose a selector indexers may already match on.

**`unused-state-variable`** — 1, `ToshLadderTreasury._PIGGYBACK_SLOT`. False
positive, and the most important one to understand before trusting this
detector: the constant *is* used, at the `tload` and `tstore` that implement
the treasury's hand-rolled reentrancy mutex. Aderyn's AST walk does not
descend into `assembly` blocks. Read as written, this finding says the mutex
is dead code.

**`non-reentrant-not-first`** — 3. The detector asks a real question — whether
a modifier ahead of `nonReentrant` can make an external call before the guard
engages — and the answer here is no for all three. `whenNotPaused` reads
`_paused`; `initialized` reads `tokenInitialized`. Both are plain storage
reads with no call.

**`unchecked-return`** — 6. Each is a return value nobody needs:
`vault.lock("")` and `vault.settle()` return amounts already known to the
caller, `poolManager.initialize()` returns the resulting tick, and
`_grantRole()` returns whether the role was newly granted inside a
run-once `initialize`.

**`centralization-risk`** — 21. Accurate and by design. Mainnet ownership is a
2-of-3 Gnosis Safe (SafeL2 1.4.1, `0x02DE4629129D104C63329D13A6Ca67E43db7B310`);
every powerful setter is bounded by a hard-coded ceiling and emits an event.
`README.md` §"What the owner can do" is the real answer to this detector and is
deliberately not summarised here, because a summary would be the thing that goes
stale.

That last sentence is in this file because this paragraph had already broken it.
It read **3-of-5** until 2026-09-22, and it was the only place in the repository
that did: `scripts/verifyOwnerSafe.mjs` refuses to pass any Safe that is not
2-of-3, `README.md`, `monitoring/alerts.json`, the mainnet runbook and four
frontend modules all say 2-of-3, and the three signers each signed a message
naming the role as "(2-of-3, BNB Smart Chain 56)" — so the consent on record is
to 2-of-3 as well.

Nothing was mis-built; one published sentence was wrong about what was built.
The direction is what makes it worth writing down rather than quietly fixing: it
**overstated** the protection. A reader weighing custody risk was told three
signatures stand between them and every owner-only dial, when two move them. The
counts at the top of this file were gated against their baselines in the same
week, and this number — the only one here a reader might actually act on — had
nothing looking at it, because neither analyser baseline has anything to say
about who owns the contracts. `checkAuditDoc.mjs` now compares this claim with
the constants `verifyOwnerSafe.mjs` enforces against the live Safe.

Two of those 21 arrived on 2026-09-21 and are worth naming, because the detector
reads them exactly backwards: `ToshFactory.renounceOwnership` and
`ToshLadderTreasury.renounceOwnership` are `onlyOwner` functions that
unconditionally **revert**. They exist to *remove* a power, not to hold one.

`Ownable2Step` makes `transferOwnership` propose-then-accept so ownership cannot
land on an address nobody holds, and then inherits from `Ownable` a one-call,
unconfirmed `renounceOwnership` that sets the owner to zero — permanently
disabling `pause`, `setBlacklist`, `haltLadder` and every other brake on a live
launchpad holding user quote. On the treasury the failure is quieter and no
better: `addLadderToken` and `removeLadderToken` freeze, so a rugged token can
never be delisted and the reservoir keeps market-buying it out of every future
launch's fees. Both overrides revert; `onlyOwner` stays in front so a stranger
is still refused as a stranger. Pinned by `test_factory_ownershipCannotBeRenounced`,
`test_ladderTreasury_ownershipCannotBeRenounced` and
`test_renounceOwnership_refusesStrangersAsStrangers`.

Two more sit on `ToshToken` — the contract itself and `ToshToken.mint` — and the
detector reads these backwards too, harder than it does the two above. The token
has no owner at all. `MINTER_ROLE` is granted once, to the hook, inside an
`initialize` the factory calls exactly once, and **`DEFAULT_ADMIN_ROLE` is left
deliberately vacant**, so `grantRole` and `revokeRole` have no eligible caller
for the rest of the token's life: the minter cannot be changed, added to, or
taken away by anyone, including the platform. What the detector sees as a
privileged role is the mechanism that makes the hook's exclusivity permanent —
the Immutable Pact described at the top of `ToshToken.sol`. Supply is bounded
independently by the `MAX_SUPPLY` check inside `mint`, which needs nobody to
intervene, and there is deliberately no kill-switch to intervene with.

**`unused-public-function`** — 8, all in `ToshLaunchpadHook`. Read by the
frontend and by monitoring rather than by other contracts, which is not
visible to a tool that only sees `src/`.

It was 9 until 2026-09-21. `canRefund()` left the list because `refund()` now
calls it instead of inlining its own copy of the seven-day comparison — the
change that opened refunds immediately for a raise too small to carry a ladder,
which gave the predicate two clauses and made a second copy of them a liability.
The detector is right that it is now reachable internally; nothing was removed.

**`push-zero-opcode`** (7) and **`unspecific-solidity-pragma`** (4) — both
follow from `pragma solidity ^0.8.26` plus `evm_version = "cancun"`. PUSH0 is
intended; Shanghai-or-later is a deployment requirement this project already
depends on more sharply elsewhere (the transient-storage mutex needs Cancun,
verified by execution against chain 56 — see `foundry.toml`).

**`literal-instead-of-constant`** (12), **`large-numeric-literal`** (4),
**`modifier-used-only-once`** (4), **`costly-loop`** (2),
**`require-revert-in-loop`** (5), **`uninitialized-local-variable`** (3),
**`local-variable-shadowing`** (1) — style findings with no behavioural claim.
The uninitialised locals are accumulators written before first read on every
path; the loops that revert are batch operations where partial application
would be worse than rejection.
