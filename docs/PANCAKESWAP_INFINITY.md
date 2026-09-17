# Porting to PancakeSwap Infinity — assessment

Status: assessment, plus a fork spike that has been run. No production code has
been changed. §9 records what the spike measured; the port itself is not started.

Every deployment fact below was measured against a live node on 2026-09-17, not
read off a table. The commands are included so they can be re-run, because the
addresses are the part most likely to rot.

---

## 1 · The question is not "which router"

"Switch the swap to PancakeSwap" sounds like a router change. It is not, and the
reason decides the whole assessment.

PancakeSwap v2 and v3 have **no hook mechanism at all**. This protocol *is* a
hook: the bonding curve runs in `beforeSwap`, the 70 bps tax and the ladder
treasury piggyback run in `afterSwap`, and the same-block lockout is hook state
(`_lastSwapBlock`). On v2 or v3 there is nowhere for any of that to live. Pointing
the frontend at PancakeSwap's router without moving the pool would mean trading a
Uniswap V4 pool through a router that cannot see it, which simply reverts.

So the only real option is **PancakeSwap Infinity**, their hook-capable AMM
(audited March 2025, per their developer docs). Everything below is about that.

---

## 2 · The actual driver: Infinity has a testnet, Uniswap V4 does not

This is the argument that matters, and it is the one that has nothing to do with
liquidity.

Measured with `cast code`:

| Contract | BSC mainnet (56) | BSC testnet (97) |
| --- | --- | --- |
| Infinity `Vault` | 8,347 B | 8,347 B |
| Infinity `CLPoolManager` | 20,885 B | 20,886 B |
| Infinity `CLPositionManager` | 24,004 B | 24,004 B |
| Infinity `UniversalRouter` | 24,350 B | 24,350 B |
| Uniswap V4 `PoolManager` | 24,009 B | **no code** |
| Uniswap V4 `PositionManager` | 23,877 B | **no code** |
| Uniswap V4 `UniversalRouter` | 24,546 B | **no code** |

Addresses used are in §7.

The BSC migration currently has **no real testnet**. That is why
`soat-frontend/src/lib/chain.ts` defaults to 31337 rather than 97, and why the
full-lifecycle rehearsal was rewritten to run against `anvil --fork-url $BSC_RPC`.
An anvil fork is a good tool and it is not a testnet. It cannot exercise:

- real validators and real reorg behaviour
- real gas pricing and real block times
- multi-day time passage (a genesis window is 3–72 h, the launch window another
  7 days; on a fork this is `vm.warp`, which is exactly the thing a rehearsal is
  supposed to stop trusting)
- explorer verification of the deployed bytecode
- a frontend pointed at a public chain that other people can also reach

Note the asymmetry: the 20,885 vs 20,886 byte difference in `CLPoolManager` is
one byte, which is what a differing constructor immutable looks like. Testnet and
mainnet Infinity are the same build. A rehearsal on 97 would be rehearsing the
real thing.

Infinity is also deployed on Robinhood Chain, so this is not a single-chain bet.
`BinPoolManager` is absent there; `CLPoolManager` — the one that matters here —
is present.

---

## 3 · What the port costs, layer by layer

Measured with `rg -c` over `src/`.

### 3.1 The hook callbacks: cheaper than expected

This was the surprise, and it is worth stating plainly because the conservative
guess is wrong. Infinity's `ICLHooks` callback signatures are **near-identical**
to Uniswap V4's. Compared side by side against what
`src/ToshLaunchpadHook.sol` already implements:

| Callback | ours (Uniswap V4) | Infinity `ICLHooks` |
| --- | --- | --- |
| `beforeInitialize` | `(address, PoolKey, uint160) → bytes4` | identical |
| `afterInitialize` | `(address, PoolKey, uint160, int24) → bytes4` | identical |
| `beforeSwap` | `(address, PoolKey, SwapParams, bytes) → (bytes4, BeforeSwapDelta, uint24)` | identical, but `ICLPoolManager.SwapParams` |
| `afterSwap` | `(address, PoolKey, SwapParams, BalanceDelta, bytes) → (bytes4, int128)` | identical, but namespaced |
| `beforeAddLiquidity` | `(address, PoolKey, ModifyLiquidityParams, bytes) → bytes4` | identical, but namespaced |
| `beforeRemoveLiquidity` | same shape | identical, but namespaced |

So the **bodies** of the callbacks — the curve, the tax, the lockout, the
piggyback — survive the port. `SwapParams` and `ModifyLiquidityParams` move from
free-standing types in `v4-core/src/types/PoolOperation.sol` to nested types on
`ICLPoolManager`, which is an import-and-qualify change, not a logic change.

### 3.2 The plumbing: Vault replaces PoolManager for accounting

This is the real work. Uniswap V4 puts accounting and AMM logic in one
`PoolManager`; Infinity splits them into `Vault` (accounting) and
`CLPoolManager` (AMM).

| Operation | Uniswap V4 | Infinity |
| --- | --- | --- |
| acquire lock | `poolManager.unlock()` → `unlockCallback(data)` | `vault.lock()` → `lockAcquired(data)` |
| settle / take | `poolManager.take/settle/sync` | `vault.take/settle/sync/mint/burn` |
| transfer target | `PoolManager` | `Vault` |
| delta reporting | implicit | `vault.accountAppBalanceDelta(...)` |

Affected: `ToshLaunchpadHook.sol` (2,521 lines, 71 of them touching V4 types or
calls, including `unlockCallback` at line 2053 and the `onlyPoolManager`
modifier, which must now distinguish "called by CLPoolManager as a hook" from
"called by Vault as a lock holder") and `ToshLadderTreasury.sol` (797 lines, 31
touching), whose buyback path is a swap and therefore goes through the Vault.

### 3.3 PoolKey and permissions: the address miner dies

Infinity's `PoolKey` differs structurally:

```solidity
struct PoolKey {
    Currency currency0;
    Currency currency1;
    IHooks hooks;
    IPoolManager poolManager;  // new: CLPoolManager or BinPoolManager
    uint24 fee;
    bytes32 parameters;        // replaces int24 tickSpacing
}
```

`parameters` packs the 16-bit hook registration bitmap in its first 16 bits, then
24 bits of tick spacing. Every `PoolKey` construction and every `PoolId`
derivation changes, and `PoolId` changing means pool identity changes — anything
that stored or indexed a pool id is affected.

The consequential part is how permissions are declared. Uniswap V4 requires the
hook's **address** to carry the permission bits, which is the sole reason this
repository owns a CREATE2 salt miner. Infinity instead calls
`hook.getHooksRegistrationBitmap()` at `initialize` and checks it against the
bitmap in `poolKey.parameters` (`Hooks.validateHookConfig`). Their docs say it
outright: *"Have the hook contract deployed (no address mining is required)"*.

So this machinery becomes dead code:

| What | Size |
| --- | --- |
| `src/libraries/HookAddress.sol` | 119 lines |
| `src/libraries/HookDeployLib.sol` | 79 lines |
| `scripts/checkCloneInitcodeTuple.mjs` (guard) | 242 lines |
| `script/RecomputeInitcodeHash.s.sol` | 4 salt/initcode references |
| `soat-frontend/src/app/lib/hookAddress.ts` | 6 references |
| `soat-frontend/src/app/launch/page.tsx` | 8 references |
| `src/ToshFactory.sol` (`hookInitcodeHash` and callers) | 8 references |
| `test/ToshV5Factory.t.sol` | 43 references |
| `scripts/mineHookSalt.js` | 5 references |

Deleting it is a simplification — the launch page stops mining client-side, and
the whole class of "salt mined against stale dials" bugs stops existing. But it
is a *large* deletion that reaches the launch flow and the frontend, and
deletions of load-bearing machinery are where regressions hide. Budget it as
work, not as savings.

**What was actually removed, and what this table got wrong.** The searching went:
`find`, `isValidHookAddress`, the fourteen flag constants, `InvalidHookSalt`, and
`scripts/mineHookSalt.js` outright. `HookMiner.sol` is now `HookAddress.sol` and
keeps `computeAddress` — CREATE2 arithmetic was never Uniswap-specific; only the
question of which addresses were ACCEPTABLE was.

The guard was the entry this table judged wrongly. `checkHookMinerTuple.mjs` is
now `checkCloneInitcodeTuple.mjs` and is *more* load-bearing than before, not
dead: the mask was doubling as the backstop against a clone-layout drift, which
used to revert `InvalidHookSalt` on every launch and now deploys successfully at
an address the UI cannot name. Deleting the guard as part of "this machinery"
would have removed the replacement for the protection at the same time as the
protection.

A trap for whoever does this: `ICLHooks.sol`'s own doc comment still says the
pool manager decides callbacks "by inspecting the leading bits of the hooks
contract address". That sentence is inherited from Uniswap and is **wrong for
Infinity** — `Hooks.validateHookConfig` reads the bitmap. Do not let that comment
talk you into keeping the miner.

### 3.4 Vendored dependencies and the metadata hash

`lib/v4-core` and `lib/v4-periphery` would be joined or replaced by
`infinity-core` and `infinity-periphery`. Per the long argument already recorded
in `foundry.toml`, changing the `remappings` list changes solc's metadata hash,
which changes the last 32 bytes of creation code, which changes every CREATE2
address. That mattered a great deal under address mining. Once §3.3 lands it
matters much less, which is a small piece of luck: the two changes cancel.

**Measured, and it is a non-issue.** `lib/infinity-core` is now vendored as a
submodule. Its sources import only three non-relative prefixes —
`@openzeppelin/contracts/`, `forge-std/` and `solmate/`, the last two only from
`src/test/` mocks nothing here imports — and all three are already in the pinned
list. So it resolves with **no new remapping entry**, `forge config` reports the
same eight remappings as before, and `foundry.toml` is untouched. Production
metadata hashes do not move. `scripts/checkCloneInitcodeTuple.mjs` still passes,
which is the guard that would have noticed if they had.

The spike imports it by relative path (`../lib/infinity-core/src/...`), the same
way `ToshLaunchpadHook.sol` already imports `v4-core`. A real port would probably
want remapping entries for readability, and that is the point at which the
metadata-hash argument comes back.

**And it comes back harder than the paragraph above implies.** `infinity-periphery`
is now vendored too, and unlike core it does *not* resolve for free: its sources
reach core through an `infinity-core/` prefix, so importing anything from it
requires that remapping. Adding it was measured rather than reasoned about:

| | `ToshLaunchpadHook` creation code, SHA-256 |
|---|---|
| eight pinned remappings | `4B960B60…6B321AC3` |
| plus `infinity-core/=lib/infinity-core/` | `31E9D55C…601435DB` |

One remapping entry, **imported by no production file**, moves the hook's
creation code. solc records the entire `remappings` list in metadata regardless
of which entries a given contract actually used, so there is no such thing as a
locally-scoped remapping. `foundry.toml`'s warning is exact, and now has a
number behind it.

The consequence for the spike is concrete: it **restates**
`ICLRouterBase.CLSwapExactInputSingleParams` rather than importing it, because
importing it would perturb production bytecode for the sake of a test. A
restated calldata tuple is the precise hazard `scripts/checkV4RouterTuple.mjs`
exists to police, so it is pinned there against the vendored source — see §9.4.

The consequence for a real port is that the remapping is unavoidable and should
be added **once, deliberately, in the same change that deletes the address
miner**, so every CREATE2 address moves exactly once.

`LiquidityAmounts` (currently from `v4-periphery`) and `TickMath` / `FullMath` /
`SafeCast` (from `v4-core`) have Infinity equivalents; the LP math vectors in
`test/ToshV5LpMathVectors.t.sol` (242 lines) exist precisely to catch a silent
change in those, and should be re-run rather than trusted.

### 3.5 Tests and guards

There are ~11,965 lines of Solidity tests. They do not transfer for free:

| Suite | Lines | Exposure |
| --- | --- | --- |
| `ToshV5.t.sol` | 3,599 | core behaviour, mostly portable |
| `ToshV5Invariants.t.sol` | 1,747 | handler drives V4 calls directly |
| `ToshV5Factory.t.sol` | 1,297 | 43 salt/initcode references |
| `ToshV5Attack.t.sol` | 1,252 | encodes V4 reentrancy and lock semantics |
| `ToshV5Guards.t.sol` | 803 | permission-bit assumptions |
| `ToshV5Fork.t.sol` / `ToshV5ForkBsc.t.sol` | 591 / 441 | rewritten against Infinity |
| `ToshHookClone.t.sol` | 498 | clone + mined address |
| others | ~1,700 | mixed |

Guards written against Uniswap V4 semantics: `checkV4RouterTuple.mjs` (503),
`checkLpActionsAbi.mjs` (534), `checkPoolGeometry.mjs` (182),
`checkCloneInitcodeTuple.mjs` (242, dies per §3.3), `checkPogDigestTuple.mjs` (288).

`checkV4RouterTuple.mjs` deserves specific mention. Its entire argument is that a
wrong-length tuple at the V4 decoder does not revert, it gets reinterpreted, and
the swap succeeds with `hookData` silently dropped. Infinity's `UniversalRouter`
is a different contract with its own calldata layout, so that guard must be
re-derived against Infinity's decoder, not edited. Its check 5 (the BSC
older-router address pin) becomes irrelevant and its checks 2–3 need a new
measured layout.

---

## 4 · What does not change

Worth listing, because it is most of the product:

- the bonding curve and all its math
- the PoG band, the gas-history scanner, the attestation signing
- `ToshFactory`'s dials, ownership, Safe flow, name registry
- `ToshToken`
- the launch/genesis/refund state machine and its timing
- the BNB denomination and the ×3.5 calibration (see §6)
- the frontend outside the launch page's mining step
- the watcher, monitoring and admin surfaces

---

## 5 · Open questions — measure before committing

1. ~~**Does the hook actually run?**~~ **Answered — see §9.**
   `test/ToshV5ForkInfinity.t.sol`, 9 tests against the live `Vault` and
   `CLPoolManager` on a chain-56 fork. The mechanism runs and the address miner
   is confirmed deletable. One sub-question is still open: Infinity's
   `UniversalRouter` calldata layout (§9.3).
2. **Liquidity and routing.** It is widely assumed that PancakeSwap carries the
   large majority of BSC volume and that Uniswap V4 on BSC is comparatively thin.
   **This has not been measured** and should not be cited until it is. What
   matters for a launchpad is not headline TVL but whether aggregators route
   through Infinity pools with a custom hook, which is a different question
   again.
3. **Dynamic fee interaction.** `beforeSwap` can override the LP fee only if the
   pool is created with a dynamic fee flag. The current design takes its cut in
   the hook rather than via LP fee, so this is probably unused — confirm rather
   than assume.
4. **Donate callbacks.** Infinity's bitmap has `beforeDonate` / `afterDonate`.
   Leaving them unregistered means a donate path exists that the hook does not
   see. Decide whether that is acceptable or whether they need stubs.
5. **`BinPoolManager`.** Not needed (CL is the analogue of what is used now), but
   its existence means a pool could be created against the wrong manager. The
   `poolManager` field in `PoolKey` is now a thing that can be wrong.

---

## 6 · Quote asset: BNB, decided

Recorded here because it was investigated in the same session and would otherwise
be lost.

`0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a` ("BEM") was raised as a candidate
quote asset. **Decision: no — the raise and the pool stay in BNB**, and the ×3.5
calibration already committed stands. Measured grounds:

- Plain ERC20, 2,205 bytes of code. No transfer tax, no blacklist, no pause, no
  permit. 8 decimals. Supply 181,273.29979283.
- It has `mint(address,uint256)` gated by a single `minter()` =
  `0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46` (a 130-byte contract), with **no
  `owner()` and no role system**. A quote asset whose supply one address can
  expand is a different risk class from the native coin.
- One real market: the PancakeSwap v3 1% tier, holding 1,562.92 BEM against
  77.55 WBNB (implied ≈0.0496 BNB per BEM). The v2 pair (0.00036 BEM /
  0.0000288 WBNB) and the v3 0.25% tier are dust. No BEM/USDT pair.
  Caveat on that figure: `balanceOf` on a v3 pool is the total across all ticks
  plus uncollected fees, **not** usable depth at spot. Real slippage needs the
  tick distribution.

Staying in BNB also keeps an assumption the codebase leans on: every pool is
native-coin/token, so `currency0` is always zero. `scripts/checkV4RouterTuple.mjs`
cites that fact directly in its argument about the quiet failure mode. Moving to
an ERC20 quote asset would turn deposits from `msg.value` into `transferFrom` and
rewrite the refund and buyback paths — a larger change than this whole port.

---

## 7 · Addresses used, and how to re-check them

PancakeSwap Infinity, from their developer docs, verified to have code:

| Contract | BSC mainnet (56) | BSC testnet (97) |
| --- | --- | --- |
| `Vault` | `0x238a358808379702088667322f80aC48bAd5e6c4` | `0x2CdB3EC82EE13d341Dc6E73637BE0Eab79cb79dD` |
| `CLPoolManager` | `0xa0FfB9c1CE1Fe56963B0321B32E7A0302114058b` | `0x36A12c70c9Cf64f24E89ee132BF93Df2DCD199d4` |
| `CLPositionManager` | `0x55f4c8abA71A1e923edC303eb4fEfF14608cC226` | `0x77DedB52EC6260daC4011313DBEE09616d30d122` |
| `UniversalRouter` | `0xd9C500DfF816a1Da21A48A732d3498Bf09dc9AEB` | `0x87FD5305E6a40F378da124864B2D479c2028BD86` |

Uniswap V4 on BSC mainnet, for comparison: `PoolManager`
`0x28e2Ea090877bF75740558f6BFB36A5ffeE9e9dF`, `PositionManager`
`0x7A4a5c919aE2541AeD11041A1AEeE68f1287f95b`, `UniversalRouter`
`0x8B844f885672f333Bc0042cB669255f93a4C1E6b`. None of the three has code on 97.

```powershell
# code presence, per address, per chain
cast code <address> --rpc-url https://bsc-dataseed1.bnbchain.org
cast code <address> --rpc-url https://data-seed-prebsc-1-s1.bnbchain.org:8545
```

Sources: `https://developer.pancakeswap.finance/contracts/infinity/` for the
address table, the vs-Uniswap-v4 FAQ and the hook page;
`https://github.com/pancakeswap/infinity-core/blob/main/src/pool-cl/interfaces/ICLHooks.sol`
for the callback signatures in §3.1.

---

## 8 · How to decide

The port is not cheap and it is not a rewrite either. The callback bodies survive
(§3.1); the accounting plumbing and the PoolKey/permission encoding do not
(§3.2–3.3); the test and guard layer is where the hours actually go (§3.5).

The question that should decide it is narrower than "PancakeSwap or Uniswap":

> Is shipping to BSC mainnet with rehearsals that only ever ran on an anvil fork
> an acceptable risk?

If yes, stay on Uniswap V4 — it is already measured working on BSC by
`test/ToshV5ForkBsc.t.sol`, and this port buys comparatively little.

If no, Infinity is currently the only way to get a real testnet on BNB Chain, and
that is worth more than any liquidity argument in §5.2 — which is unmeasured
anyway.

The §5.1 fork spike has now been run, which removes the largest unknown. §9
records what it found; §9.3 is what is left.

---

## 9 · Spike results

`test/ToshV5ForkInfinity.t.sol`, 9 tests, all passing against the live `Vault`
and `CLPoolManager` on a BSC mainnet fork. Run with:

```powershell
$env:BSC_RPC = "https://bsc-dataseed1.bnbchain.org"
forge test --match-path "test/ToshV5ForkInfinity.t.sol" -vv
```

It skips cleanly when `BSC_RPC` is unset, so it does not make the default suite
depend on the network. The full suite is 370 passing / 0 failing with it added.

### 9.1 Scope, stated plainly

The spike reproduces the **mechanism**, not `ToshLaunchpadHook`'s 2,521 lines: a
minimal hook at the real pool geometry (fee 3000, tick spacing 200, full range
±887200, native/token) that declares permissions by bitmap, takes a basis-point
cut in `beforeSwap`, stamps the block in `afterSwap`, and seeds its own liquidity
through the Vault lock. The curve, the treasury and the genesis state machine are
arithmetic and bookkeeping that never touch the AMM boundary, which is the only
thing that was in question.

So the spike licenses "the AMM boundary works", not "the port is done".

### 9.2 What it established

**The address miner can go.** This was the load-bearing question. The hook is
deployed wherever `new` puts it; the test asserts its low 14 bits do *not* encode
its permissions — i.e. it is an address Uniswap V4 would reject — and the pool
initializes anyway. So §3.3's deletion list is real.

**And dropping it does not drop enforcement.** Declaring a bitmap in
`poolKey.parameters` that disagrees with the hook's own
`getHooksRegistrationBitmap()` reverts `Hooks.HookConfigValidationError`. Worth
having asserted: had it passed silently, the port would have traded one silent
failure mode for another.

**`beforeSwap` returning a delta takes the cut, exactly.** Asserted to the wei.
Then asserted again at a second rate (500 bps against 70), because 70 bps of
1 ether sits close enough to what a pool with its own 0.30% fee produces that a
single-rate test cannot distinguish "the hook took our cut" from "something took
roughly that much". The cut follows the hook's parameter, so the hook is what is
deciding.

**`afterSwap` runs**, so the same-block lockout would arm. A registered callback
that is never invoked is precisely the quiet failure worth an assertion.

**`hookData` arrives intact** through `CLPoolManager.swap`.

**The native/token shape survives**: `currency0` is zero, and tick spacing
round-trips through the `bytes32 parameters` packing.

**A new hazard, and it is guarded.** `PoolKey` gained a `poolManager` field, so a
key can name a manager other than the one it is created on — a realistic slip,
since `BinPoolManager` is deployed on this chain. The benign outcome was
plausible: `PoolId` hashes the whole key, so a mismatch could have quietly
produced a *different pool* rather than an error. It does not —
`CLPoolManager` reverts `PoolManagerMismatch`. Asserted by selector rather than
with a bare `expectRevert`, which would also have passed on "that address has no
code" and proved nothing.

### 9.3 What is still open

Seeding genesis liquidity at real curve parameters
rather than a flat `1e18`, and the treasury's buyback swap under the Vault's lock
while a hook callback is already on the stack. The second is the one to be
careful with — reentrancy shape differs when the lock lives in a separate
contract from the AMM.

## 10 · The router path, measured

§9.3 used to open by saying Infinity's `UniversalRouter` layout had not been
measured and warning against porting it from the docs. It has now been measured,
against the live router on a BSC mainnet fork, and the docs would have been the
wrong place to get it.

### 10.1 The encoding

`execute(bytes commands, bytes[] inputs)` — the same entry point shape as
Uniswap's. One command byte, `INFI_SWAP = 0x10`, whose input is
`abi.encode(bytes actions, bytes[] params)`. Actions for a buy are
`CL_SWAP_EXACT_IN_SINGLE = 0x06`, `SETTLE_ALL = 0x0c`, `TAKE_ALL = 0x0f`; the two
settle actions each take `abi.encode(Currency, uint256)`, as Uniswap's do.

Three things worth having in writing:

- **`hookData` survives the router.** Separate claim from surviving
  `CLPoolManager.swap`, and the one whose loss is silent.
- **The 70 bps cut is exact through the router**, not just through a direct
  `swap` call.
- **Output is paid to the caller of `execute`**, because `TAKE_ALL` pays
  `msgSender()`, which the router resolves to whoever took its reentrancy lock.
  No sweep step, so the frontend needs no extra command.

### 10.2 The near-miss, which is the real finding

Infinity's decoder is not merely *similar* to Uniswap's hazard — it is the same
line of assembly, `swapParams := add(params.offset, calldataload(params.offset))`,
with no validation beyond a minimum-length floor. And the floors are the same
number:

| | head slots | floor |
|---|---|---|
| Uniswap `ExactInputSingleParams` | `PoolKey`(5) + bool + uint128 + uint128 + uint256 `minHopPriceX36` + bytes = **10** | `0x160` |
| Infinity `CLSwapExactInputSingleParams` | `PoolKey`(6) + bool + uint128 + uint128 + bytes = **10** | `0x160` |

Infinity drops `minHopPriceX36` and its `PoolKey` gains a member — it names its
own pool manager. The two cancel. **Identical encoded size, different meanings**,
so neither decoder's length check can reject the other's calldata. The obvious
conclusion is that sending one to the other is silent.

It is not, and the reason should not be trusted twice: Uniswap's `fee` lands on
the head slot Infinity reads as `poolManager`, and `CLPoolManager` validates that
field (`PoolManagerMismatch`, §9.2). So the mismatch reverts. That is **one field
in one position** — luck, not a design guarantee, and nothing makes it survive a
version bump on either side.

`test_forkInfinity_theUniswapShapedTupleIsNotInterchangeable` builds a
Uniswap-shaped tuple and sends it to Infinity's decoder to keep that measured
rather than assumed. `test_forkInfinity_aShortTupleIsRefusedByTheLengthFloor`
pins the floor itself.

### 10.3 What the guard now pins

`scripts/checkV4RouterTuple.mjs` gained a sixth check, and two of its own
assumptions became derived rather than written down:

- The restated `CLSwapExactInputSingleParams` must match
  `infinity-periphery` field-for-field. It is restated because importing it
  needs the remapping from §3.4, which makes this guard the *only* thing
  relating the two.
- Infinity's decoder floor must match its own head-slot count, as the check
  already did for Uniswap's.
- Both `PoolKey` widths are now parsed from their vendored sources instead of
  the literal `5` the file used to carry. That number is what makes the two
  layouts collide, so it is the last thing that should have been a literal.
- While the two totals are equal, the interchangeability test above must exist.
  If a future bump makes the sizes *differ*, the hazard gets safer and the check
  goes quiet on its own.

Negative-tested in the way the mistake would actually happen — copying the V4
fork test's tuple, `minHopPriceX36` and all, into the Infinity spike. The guard
rejects it.

## 11 · What the port cost, found by porting the tests

The suite is green again — 364 passing, 0 failing, 4 skipped, against 261/102
when it first compiled. Three of the things that fixed it are worth keeping a
record of, because two were real defects in the contracts and one is a defect the
port introduced and has not closed.

### 11.1 The settlement transfer went to the wrong contract

`_addInitialLiquidity` synced and settled against the Vault but transferred the
project tokens to the *pool manager*. `settle()` then measured a balance that had
not changed, credited nothing, and the frame closed with `CurrencyNotSettled()`.

This one line accounted for 178 of the 190 initial failure reports — roughly 89
tests, across every suite that launches a project. It is the clearest example of
why the mechanical substitution pass was not sufficient on its own: `sync` and
`settle` moved to the Vault and were renamed accordingly, but the *address the
tokens are physically sent to* is an argument, not a receiver, so no rename
touched it. Nothing about the code looked wrong.

### 11.2 The treasury's callback guarded the wrong caller

`ToshLadderTreasury.lockAcquired` still rejected everyone but the pool manager,
which under Infinity means rejecting the Vault — the only caller that can
legitimately arrive. Every piggyback path reverted with `OnlyPoolManager()`. The
error is now `OnlyVault()`, matching the hook.

The hook's equivalent guard had already been switched during the port; the
treasury's had not, and no test caught the asymmetry until the settlement fix
above unblocked the paths that reach it. `ToshV5Guards` now has
`test_lockAcquired_rejectsEvenThePoolManager`, which pins the distinction
directly rather than relying on a launch path to expose it.

### 11.3 Config rotation in flight — broken by the port, then fixed properly

**Resolved.** `createLaunch` now takes `expectedSoftCap` and `expectedWalletCap`
and reverts `CapsChanged()` on any mismatch. What follows is why it needed to.

Deleting the address-bit gate deleted an accidental guard. Under Uniswap V4, a
creator predicted their hook address from the dials as they read at quote time;
if the platform owner rotated `defaultSoftCap` or `maxPogAllocationLimit` before
the transaction landed, the initcode changed, the address re-rolled, and the new
address failed the `0x20CC` mask with probability 503/512. About 98% of in-flight
rotations therefore reverted loudly with `InvalidHookSalt`.

`test_rehearsal_saltMinedAgainstStaleDialsIsRejected` asserted exactly that, and
the mitigation plan was written around it: the residual ~2% was called the case
that cannot be caught in code, and the operational rule — never let a dial change
be in flight during `createLaunch` — was the cover for it.

Infinity reads permissions from the hook's registration bitmap. `ToshFactory`
checks no address bits, `InvalidHookSalt` is gone, and every salt is valid. So
the residual 2% is now 100%: the launch succeeds at an address the creator did
not predict, with whatever dials read at execution time frozen into the clone.
The operational rule is no longer a backstop for a rare case; it is the only
control over the general one.

#### The guard

`expectedFee` already showed the shape, and the caps now follow it — with one
deliberate difference. `expectedFee` is a **bound**: `fee > expectedFee` reverts,
because a fee that moved down leaves the caller better off. The caps are an
**equality**, because there is no direction in which a mismatch is harmless. A
cap that moved in the caller's favour still re-rolls the CREATE2 address they
predicted, so `test_createLaunch_refusesEvenAFavourableRotation` pins that a
larger wallet allowance is refused too.

The check sits immediately beside the freeze, reading the same locals that are
about to be baked into the clone rather than re-reading storage. The window being
closed is between the caller's read and that freeze, so comparing against
anything else would leave a gap.

Coverage is four tests in `ToshV5Factory` — soft cap rotated, wallet cap rotated,
favourable rotation, and the positive case that the launch lands where the agreed
dials predicted — plus
`ToshV5FirstLaunchRehearsal.test_rehearsal_aDialChangeInFlightIsRefused` against a
deployed factory. The two dials have separate setters, which is why they get
separate tests: a guard watching only `defaultSoftCap` would look right and be
half blind.

The residual is now zero rather than V4's 1.8%. The old protection was
probabilistic because it depended on address arithmetic; an equality on
caller-supplied values is not.

#### A trap worth recording, since it cost a full test run

Threading the two arguments through 35 call sites broke 125 tests in a way that
pointed everywhere except at the cause:

```solidity
vm.prank(creator);
factory.createLaunch{value: fee}(..., factory.defaultSoftCap(), ...);
```

Arguments evaluate before the call, and `vm.prank` applies to the next call — so
the prank was spent on `defaultSoftCap()` and `createLaunch` ran as the test
contract. `finalSalt` includes `msg.sender`, so every launch bound to the wrong
creator: predictions stopped matching, `OnlyCreator()` fired on every later
`launch()`, and salts began colliding between tests that used to have distinct
creators. None of the failure messages mentioned a prank.

This is the second time the same mistake has appeared in this port — the first was
`_routerInputs` inside a pranked `execute` during the router measurement. The rule
is simply that a pranked call takes no arguments that are themselves calls. Every
site now hoists the reads to locals above the prank.

### 11.4 Launch got 34k more expensive

`hook.launch()` measures 612,384 gas against ~577,000 on the V4 path, and the
budget in `test_gas_launch` moved from 578,000 to 620,000 to match. The 34k is
the Vault indirection: `vault.lock` calls back into the hook, the hook calls
`poolManager.modifyLiquidity`, the manager calls back into the Vault to account
the delta, and the hook makes two further round trips to `sync`/`settle` each
currency. Calls that were internal to one contract now cross a boundary.

It falls on the creator once, and at 1 gwei on BSC it is about 0.000034 BNB. The
budget was raised rather than removed so it stays a guard.

