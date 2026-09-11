# Tosh Protocol — Robinhood Chain migration

**Version:** v5.0
**Status:** executed on testnet **46630**; mainnet **4663** deployed 2026-09-08
(PM-C1). Canonical factory `0xBa9d2E86281b988225Eca383C375215912fb20B9`,
treasury `0x99aD248dD15498957B864Fd79917F0E103Aa78F7`, blocks 57400516–57400521.
Ownership handoff is complete (PM-C2): both contracts are owned by the 2-of-3
Safe. RH-F4 / PM-C6 closed 2026-09-08 and was re-measured 2026-09-11 at block
59,605,031, after the first mainnet launch had run through the factory: the
on-chain `HOOK_CREATION_CODEHASH` still equals
`keccak256(type(ToshLaunchpadHook).creationCode)` of this tree. What is left of
RH-F3 was Blockscout verification, and all three deployed contracts now have
it: `HookDeployLib` verified 2026-09-11 as an exact match, closing PM-C4. This file is
the plan and the evidence behind the chain migration; `PRE_MAINNET_CHECKLIST.md`
remains the authority for everything that is not chain-specific.
**Target:** Robinhood Chain testnet **46630** first, mainnet **4663** after.
**Last updated:** 2026-09-11

---

## 0. What this file is, and how its facts were established

This supersedes the **PM-B1** decision in `PRE_MAINNET_CHECKLIST.md` §2
("Ethereum L1, chain id 1"). That decision is not wrong so much as superseded;
§2.1 of that file should be read as history once this migration is executed.

Every chain fact below was **measured against a live node on 2026-08-27**, not
read out of documentation. Third-party chain docs were wrong or stale often
enough during this survey that the rule for this file is: if a claim is not
reproducible with a command printed in §6, it is marked as unverified in §5
instead of being asserted.

The headline is that the configuration work is unusually cheap — every piece of
infrastructure this protocol needs is already deployed, at addresses shared
between testnet and mainnet, and viem already ships both chain definitions. The
expensive part is one Arbitrum semantic difference (§2) that turns an existing
security guard into a liveness failure, and that no test in the current suite
can catch.

---

## 1. Chain facts

Robinhood Chain is an Arbitrum Orbit L2 settling to Ethereum. Native gas is ETH.
Blocks are ~100 ms, sequenced first-come-first-served with no public mempool.
Explorer is Blockscout, **not** Etherscan — which matters for `foundry.toml`
(§3) more than for anything else.

| | Mainnet | Testnet |
|---|---|---|
| Chain id | `4663` (`0x1237`) | `46630` |
| RPC | `https://rpc.mainnet.chain.robinhood.com` | `https://rpc.testnet.chain.robinhood.com` |
| Explorer | `https://robinhoodchain.blockscout.com` | `https://explorer.testnet.chain.robinhood.com` |
| ArbOS | 116 | — |

### 1.1 Address book

Uniswap V4 is deployed by Uniswap themselves (commit `56928a9`, May 2026). The
byte counts are `EXTCODESIZE` readings taken on mainnet 4663, recorded so a
future reader can tell a moved deployment from a stale document.

| Contract | Address | Bytes |
|---|---|---:|
| PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` | 24009 |
| PositionManager | `0x58daec3116aae6D93017bAAea7749052E8a04fA7` | 23877 |
| StateView | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` | 3531 |
| V4Quoter | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` | — |
| UniversalRouter | `0x8876789976decbfcbbbe364623c63652db8c0904` | 24546 |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | 9152 |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | 3808 |
| CREATE2 factory (Nick's) | `0x4e59b44847b379578588920cA78FbF26c0B4956C` | 69 |
| WETH9 | `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73` | — |

**Testnet 46630 carries the same addresses.** PoolManager, Permit2, the CREATE2
factory and Multicall3 were confirmed present there with identical byte counts,
so a staging rehearsal needs no address substitution — only an RPC and a chain
id. (PositionManager and StateView on testnet are still unverified; see §5.)

WETH9 is listed for completeness. This protocol pools **native** ETH as
`currency0`, so it should not appear anywhere in Tosh's own address wiring; if
it does, that is a finding.

### 1.2 The three things that could have blocked this, and did not

Each of these would have made the migration an architecture project rather than
a configuration one. All three were checked first, before any planning.

**CREATE2 factory is present.** Nick's deterministic deployer holds its usual 69
bytes at the canonical address, so `HookDeployLib` deploys the same way it does
on Base Sepolia. Hook-clone salt mining never depended on it — `ToshCloneLib`
issues a raw `create2` with the factory as deployer — but the implementation
deploy did.

**Transient storage works.** `ToshLadderTreasury` guards reentrancy with a
hand-rolled `tstore`/`tload` mutex rather than a storage flag, which is the one
thing in this codebase that a conservative L2 could have broken outright. A
`TSTORE` followed by `TLOAD` round-tripped `0x2a` correctly on ArbOS 116.
`PUSH0` also works. `foundry.toml` now pins `evm_version = "cancun"` explicitly
rather than inheriting it from `solc = "0.8.26"`'s default (RH-B3), because that
inheritance had become load-bearing.

Re-measured on **both** chains at deploy time, because Foundry prints a warning
that reads like a contradiction and is not one:

```
Unsupported Chain IDs: 46630.
Contracts deployed with a Solidity version equal or higher than 0.8.20
might not work properly.  ...eips.ethereum.org/EIPS/eip-3855
```

That is Foundry saying it has no entry for 46630 in its own chain table, not
Foundry having tested anything. Three one-instruction probes settle it against
the chains themselves, and all three pass identically on 4663 and 46630:

| Probe | `cast call --create` | Result |
|---|---|---|
| `PUSH0` | `0x5f5ff3` | `0x` — deploys empty code, no invalid-opcode revert |
| `TSTORE`/`TLOAD` | `0x600160005d60005c5f5260205ff3` | `0x…01` — the value survives the round trip |
| `MCOPY` | `0x60aa5f5260205f60205e60206020f3` | `0x…aa` |

Worth keeping the exact bytecode rather than a prose claim: the next person to
see that warning on a deploy log will want to disprove it in one command, and
"the docs said ArbOS 116 supports it" is a weaker answer than a return value.

**viem already ships the chain.** viem 2.55.19, the version in
`soat-frontend/package.json`, exports `robinhood` (4663) and `robinhoodTestnet`
(46630), both complete with Blockscout URLs and the Multicall3 address. No
`defineChain` is needed, and `explorerBase()` can stop hard-coding hosts
entirely (RH-D2).

---

## 2. The one real problem: `block.number` is not this chain's block number

### 2.1 What was measured

On Arbitrum and its Orbit chains, Solidity's `block.number` returns the block
height of the first non-Arbitrum ancestor — Ethereum L1 — not the height of the
chain the contract is running on. Sampled over 75 seconds on mainnet 4663:

| Sample | `block.number` seen by a contract | L2 head | `block.timestamp` |
|---|---:|---:|---:|
| 0 | 25,843,528 | 47,081,278 | 1787797231 |
| 1 | 25,843,530 | 47,081,527 | 1787797256 |
| 2 | 25,843,532 | 47,081,772 | 1787797281 |
| 3 | 25,843,535 | 47,082,028 | 1787797306 |

Over that window `block.number` advanced **7** while the chain advanced **750**
blocks. One `block.number` increment spans roughly **107 L2 blocks / ~10.7
seconds** of wall clock.

`block.timestamp` tracked wall clock exactly, in real seconds. That is the
reassuring half of this section: the TWAP window (`TWAP_WINDOW`, 1800 s), the
genesis durations (`DURATION_FAST` / `DURATION_STANDARD` / `DURATION_SLOW`),
`LAUNCH_WINDOW`, the factory cooldowns and `MAX_HALT_DURATION` are all
timestamp-based and are **unaffected**. So is the buyback's TWAP reference in
`ToshLadderTreasury`.

`block.number` appears in `src/` in exactly four places, and all four are the
same mechanism.

### 2.2 What it breaks

**The contract over-blocks.** `ToshLaunchpadHook` stamps `_lastSwapBlock` on
every `afterSwap` and once in `launch()`, and `mintBondingCurve` refuses to run
while `block.number <= _lastSwapBlock`:

```solidity
if (block.number <= _lastSwapBlock) revert SameBlockMintForbidden();
```

The guard is meant to forbid manipulating spot price with a swap and minting
against it in the same block. On this chain it instead closes minting for the
**remainder of the current L1 block window** — up to ~10.7 seconds and ~107 L2
blocks. Two consequences, the second worse than the first:

- *Liveness.* A pool that sees one swap per ten seconds has its bonding curve
  permanently shut, with no attacker involved. That is ordinary traffic for an
  active pool on a 100 ms chain.
- *Griefing.* Gas is negligible and sequencing is FCFS with no mempool, so one
  dust swap per ~10.7 s window closes the entire ladder indefinitely. On
  Ethereum the same attack costs a competitively-priced transaction every block
  and buys the attacker one block; here it costs almost nothing and buys ~107.

**The frontend under-blocks, which is the mirror image.**
`ProjectTerminal/BondingPanel.tsx` decides whether to show the lockout by
comparing the contract's `lastSwapBlock()` against wagmi's `useBlockNumber()`.
On Robinhood the first is an L1 height (~25.8 M) and the second is the L2 head
(~47.1 M) — different units. `lastSwapBlock >= blockNumber` is then permanently
false, so the buy panel advertises minting as open during exactly the windows in
which the contract will revert with `SameBlockMintForbidden`. The user signs and
loses the transaction.

`maxMintable()` carries the same comparison and would report a size that cannot
be minted, which is precisely the "max button that offers a size the next call
rejects" failure its own docstring argues against.

### 2.3 The decision

**Read the L2 height from `ArbSys(0x64).arbBlockNumber()`.**

This restores the guard's intended meaning — one block, ~100 ms, which is
exactly the granularity at which atomicity exists and therefore exactly what the
guard needs — and it fixes the frontend half for free, because `useBlockNumber()`
already returns the L2 head. One change closes both directions.

Two alternatives were weighed and rejected. Keying the lockout on
`block.timestamp` would be chain-agnostic and bound the lockout to ≤1 s (~10
blocks), which is tolerable but still ten times stricter than the property
requires, and it silently changes the meaning of a getter that the treasury and
UI both read. Leaving the code alone and accepting ~10.7 s was rejected on the
liveness and griefing analysis above.

**Now is the cheapest possible moment to make this change.** It alters hook
bytecode, which invalidates the initcode hash and every mined salt — but the
chain switch forces a re-mine and a redeploy regardless, so the marginal cost is
approximately zero. Deferring it means paying that cost twice.

### 2.4 Implementation shape

Arbitrum registers its precompiles with a single `0xfe` byte of code, so
`extcodesize` at `0x64` is non-zero on Orbit chains and zero on a plain EVM.
Verified: 1 byte (`0xfe`) on 4663, empty on local anvil. That gives a reliable
runtime discriminator, which is what lets one binary stay correct on both
Robinhood and the devnet the test suite runs against.

Probe **once, in the implementation's constructor**, and store the answer as an
`immutable`:

```solidity
address internal constant ARB_SYS = 0x0000000000000000000000000000000000000064;

bool private immutable _hasArbSys;

constructor(/* … */) {
    _hasArbSys = ARB_SYS.code.length != 0;
}

function _blockNumber() internal view returns (uint256) {
    return _hasArbSys ? IArbSys(ARB_SYS).arbBlockNumber() : block.number;
}
```

Immutables are inlined into the implementation's runtime code and are therefore
readable through the clones' `delegatecall`, so this costs nothing per clone and
does not disturb the EIP-1167 immutable-args layout the clones use for their own
config. Probing in the constructor rather than per call also keeps a cold
`EXTCODESIZE` (2600 gas) off the swap path; what remains is the precompile call,
measured at roughly 1,000 gas net of the 21,000 intrinsic.

The four `block.number` reads then become `_blockNumber()`, and the surrounding
prose needs to follow:

- `launch()` and `afterSwap`, which stamp `_lastSwapBlock`
- `mintBondingCurve`, the reverting guard
- `maxMintable()`, the view mirror of that guard
- the storage-packing note above `_lastSwapBlock`, which justifies the `uint48`
  narrowing as "107 million years at 12 s". At 100 ms blocks the same 2.8e14
  ceiling is ~890,000 years — still not a real ceiling, but the stated reasoning
  is now wrong and this repository treats a comment that argues from a false
  premise as a defect.

### 2.5 Why the current test suite cannot catch any of this

**Foundry's EVM does not emulate Arbitrum's `block.number`.** Even forking 4663,
`block.number` inside a test increments normally and `vm.roll` behaves as it
does on L1. Every one of the 22 references to `vm.roll`, `lastSwapBlock` and
`SameBlockMintForbidden` across `ToshV5.t.sol`, `ToshV5Attack.t.sol`,
`ToshV5Fuzz.t.sol` and `ToshV5Invariants.t.sol` will keep passing whether or not
this bug is present. The suite is not weak here; it is testing a machine that
behaves differently from the deployment target.

That has a direct consequence for the design in §2.4: on anvil the probe
resolves to `false`, so the ArbSys branch is **never executed by the existing
tests**. Coverage of it has to be built deliberately — `vm.etch` a mock ArbSys
at `0x64` *before* deploying the implementation, so `_hasArbSys` latches true,
and re-run the lockout tests against a mock whose height advances at 100 ms. A
mutation check belongs here too: with the mock installed, reverting
`_blockNumber()` to `block.number` must turn those tests red, or they are not
testing what they claim.

Ultimate confirmation is a live rehearsal on testnet 46630 (RH-F1), not a local
test.

---

## 3. Checklist

Thematic IDs, stable from now on, in the style of `PRE_MAINNET_CHECKLIST.md`. An
item is done when the evidence in its row exists.

### Gate RH-A — Decide and verify (blocks everything else)

| ID | Item | Evidence of done |
|---|---|---|
| **RH-A1** | Target chain decided | ✅ testnet 46630 first, then mainnet 4663 |
| **RH-A2** | `block.number` treatment decided | ✅ ArbSys, per §2.3 |
| **RH-A3** | Confirm Robinhood's UniversalRouter is stock Uniswap, not a fork | ✅ stock, but newer than L1's and its swap struct has six fields — §5.1 |
| **RH-A4** | Confirm PositionManager + StateView on testnet 46630 | ✅ both present at the mainnet addresses — §5.2 |
| **RH-A5** | Re-measure the piggyback gas constants on 4663 | ✅ one leg = **156,153** on 46630, 4.8 % over the local cold figure. The feared ArbOS divergence is not there; a mis-set gate was. §F.7 |

### Gate RH-B — Contracts

| ID | Item | Evidence of done |
|---|---|---|
| **RH-B1** | `IArbSys` interface + `_blockNumber()` added, four call sites migrated | ✅ `forge test` 335 passed / 0 failed / 0 skipped |
| **RH-B2** | `uint48` packing comment restated for 100 ms blocks | ✅ ~890,000 years, not 107 million |
| **RH-B3** | `foundry.toml` pins `evm_version = "cancun"` explicitly | ✅ |
| **RH-B4** | `PIGGYBACK_MIN_GAS` / `PIGGYBACK_TAIL_RESERVE` re-tuned per RH-A5 | ✅ `MIN_GAS` **230,000 → 260,000**; `TAIL_RESERVE` unchanged at 100,000. The old value sat 26k *below* `TAIL_RESERVE + one leg`, so the gate admitted pokes it could not fund — on both chains, and since before this migration. Missing `assertGe` added. §F.7 |
| **RH-B5** | Salt re-mined on the `0x20CC` mask, initcode hash recomputed | ✅ `checkHookMinerTuple.mjs` green. This row also called for regenerating `hookBytecode.ts`; that file has since been deleted as unread — `PRE_MAINNET_CHECKLIST.md` §6.2 |

Arbitrum bills L1 data posting up front, so `gasleft()` inside `afterSwap` starts
from a different place than it does on L1. RH-A5 and RH-B4 are the same finding
split across the two gates: measure first, then re-tune.

**It could not be measured from here, and the reason is worth keeping** — it is
what §F.7 had to work around, and the same shape of obstacle will recur. A
Foundry fork does not reproduce ArbOS gas accounting any more than it reproduces
`ArbSys` (§5.3), so a number taken against the fork would be the Ethereum number
with extra steps. And RH-F1 did not close it either, despite the obvious reading
of "we deployed and launched on the real chain": the piggyback branch is guarded
by an armed reservoir, `TRIGGER_STEP` is a 1 ETH `constant` with no setter, and
the dark tax that fills it would need roughly 143 ETH of swap volume (§F.4
note 2). Every swap in the rehearsal took the declining branch, so `gasleft()`
was never read in anger.

What the rehearsal did establish is that ordinary paths cost what they cost
locally: `createLaunch` came in 0.02 % off its local measurement (§F.3) and
`launch()` at 501,932 gas. So the concern was always narrow — the piggyback
branch specifically, not ArbOS gas being broadly unpredictable.

**Both are now closed by §F.7**, using the third option the paragraph above did
not consider: neither a funded reservoir nor a production `TRIGGER_STEP` that can
be scaled, but a probe that deploys the real treasury with a scaled threshold
beside the real one. The narrow concern turned out to be unfounded — ArbOS is
4.8 % dearer, not materially different — and the measurement found a mis-set gate
that had nothing to do with which chain it ran on.

Worth being precise about what is and is not at risk, because "gas is different
on L2" invites the wrong worry. Robinhood's L2 base fee reads **0.0352 gwei**
(`cast gas-price`, August 2026), roughly 280× under a 10 gwei L1, so a launch's
1.04 M gas costs about **0.00004 ETH** and nothing in this protocol prices
anything off a gas *price*. The exposure is entirely to gas *units*:
`PIGGYBACK_MIN_GAS` and `PIGGYBACK_TAIL_RESERVE` are budgets in units, checked
against `gasleft()`, and they decide whether an ordinary swap carries a buyback
or declines to. Tuned too high, the piggyback never fires and the treasury only
drains through `pokeBuyback`; too low, a swap enters the buyback path with too
little gas to finish it. Both are quiet failures, which is why this is a gate
item and not a footnote.

### Gate RH-C — Deploy pipeline

| ID | Item | Evidence of done |
|---|---|---|
| **RH-C1** | `foundry.toml` `[rpc_endpoints]` gains `robinhood` and `robinhood_testnet` | ✅ Base entries removed; `mainnet` kept for the fork suite only |
| **RH-C2** | Verification switched to Blockscout | ✅ URLs match viem's `blockExplorers.apiUrl` on both chains; a real verify awaits RH-F3 |
| **RH-C3** | Chain guards in `script/Deploy.s.sol` and `script/DeployMainnet.s.sol` accept 4663 / 46630 | ✅ `DeployMainnet.t.sol` green at `TARGET_CHAIN = 4663` |
| **RH-C4** | `.env.example` and `.env.production.example` updated: `TARGET_CHAIN_ID`, `TARGET_RPC`, `V4_POOL_MANAGER` | ✅ both key variables deleted rather than renamed |

The three `[etherscan]` entries do not cover 4663 and Etherscan v2's multichain
host does not serve it. Blockscout needs no API key, so `BASESCAN_API_KEY` drops
out of the deploy path rather than being replaced.

### Gate RH-D — Frontend

| ID | Item | Evidence of done |
|---|---|---|
| **RH-D1** | `chain.ts` registers `robinhood` / `robinhoodTestnet`; labels and `IS_TESTNET` updated | ✅ `checkChainCopy.mjs` green on all three chains |
| **RH-D2** | `explorerBase()` reads `targetChain.blockExplorers`, hard-coded hosts deleted | ✅ returns `undefined` on the devnet instead of borrowing Base Sepolia's |
| **RH-D3** | `targetChain` fallback no longer silently degrades to Base Sepolia | ✅ throws, named the supported ids, covered by two tests |
| **RH-D4** | `POOL_MANAGER` in `contracts.ts` switched; `POSITION_MANAGER` / `STATE_VIEW` fallbacks updated | ✅ EIP-55 checksums recomputed |
| **RH-D5** | `serverRpc.ts` — `PUBLIC_FALLBACK`, `CHAINS_BY_ID`, `scopedEnvUrl` | ✅ `checkServerRpc.mjs` green; suite rewritten, 50 tests pass |
| **RH-D6** | `providers.tsx` — wagmi chain list and transports | ✅ public leg now reads `targetChain.rpcUrls` instead of a parallel literal list |
| **RH-D7** | Guards updated: `checkChainCopy.mjs` chain table, `checkServerRpc.mjs` host allowlist, `checkPublicEnv.mjs` template | ✅ `npm run verify` green end to end, production build included |
| **RH-D8** | Static copy in `app/layout.tsx` metadata no longer says Base Sepolia | ✅ covered by `checkChainCopy.mjs`, which reads the derived constants |

RH-D3 turned out to be the load-bearing one. `targetChain =
CHAINS_BY_ID[TARGET_CHAIN_ID] ?? baseSepolia` means that during the migration a
half-configured build points at Base Sepolia and *looks* fine — the same class
of silent fallback that `envAddress` was rewritten to eliminate, documented at
length in that function's own comment. Making it throw immediately surfaced two
stale ids that would otherwise have shipped: `NEXT_PUBLIC_CHAIN_ID: "84532"` in
`.github/workflows/frontend.yml`, and the whole of `serverRpc.test.ts`.

### Gate RH-E — Tests and documentation

| ID | Item | Evidence of done |
|---|---|---|
| **RH-E1** | ArbSys mock coverage per §2.5, including the mutation check | ✅ `ToshV5ArbSys.t.sol`, 7 tests; the mutation kills 4 of them |
| **RH-E2** | Fork suite retargeted to 4663 | ✅ 8 tests green against the live chain, **unpinned** — the public RPC cannot serve a fixed block (§5.3). ArbSys etched in `_installArbSys`; six-field struct imported per §5.1 |
| **RH-E3** | Frontend suites' hard-coded `31337` / `84532` reviewed | ✅ `serverRpc.test.ts` rewritten; 50 pass |
| **RH-E4** | `monitoring/alerts.json` `chainId` | ✅ 4663, plus a note on what 100 ms blocks do to the "per block" reasoning in the immature-TWAP check |
| **RH-E5** | `README.md`, `PRE_MAINNET_CHECKLIST.md` §2 address tables and PM-B1 reconciled with this file | ✅ both done |

RH-E2 shipped with one property given up and one gained, both deliberate. Given
up: reproducibility. The suite forks the tip because the public endpoint retains
state for under seventeen minutes, so any `FORK_BLOCK` constant is stale before
it is reviewed. Gained: `test_fork_deployedRouterReadsTheSixthField`, which
exists because the mutation testing showed the obvious assertions could not tell
the two router layouts apart — see §5.1, it is the more interesting half of this
gate.

### Gate RH-F — Cutover

| ID | Item | Evidence of done |
|---|---|---|
| **RH-F0** | Deployer funded on 46630 | ✅ `0x73db078fa94607893270079AC8F5c7492aB480cd`, funded from `faucet.testnet.chain.robinhood.com` |
| **RH-F0b** | Contracts deployed and Blockscout-verified on 46630 | 🔁 was ✅ §F.2 — **superseded**, see below |
| **RH-F1** | Full rehearsal on testnet 46630: create → genesis → launch → mint → buyback | ✅ re-run end to end on the redeployed contracts, §F.8. Buyback alone stays fork-grade, and not for want of trying — see §F.4 note 2 |
| **RH-F2** | Lockout behaviour observed live under real 100 ms blocks | ✅ re-confirmed on the redeploy: `lastSwapBlock` = 112,342,060, which is both an L2 height and exactly the block `launch()` mined in. Re-armed to 112,348,233 by the phase 3 swap. §F.8 |
| **RH-F3** | Mainnet 4663 deploy, Blockscout-verified | ✅ deploy half 2026-09-08: factory `0xBa9d2E86281b988225Eca383C375215912fb20B9`, treasury `0x99aD248dD15498957B864Fd79917F0E103Aa78F7`, artefact `broadcast/DeployMainnet.s.sol/4663/run-latest.json`. Verification half closed 2026-09-11: all three contracts are exact matches on Blockscout — the two named above on 2026-09-09, and the library `HookDeployLib` `0x873E0841…` at 02:23:12Z, which no count of this deploy had included because `forge script` places libraries through the CREATE2 proxy rather than as a `CREATE` entry. See PM-C4 |
| **RH-F4** | `RecomputeInitcodeHash` run; `FACTORY_ADDRESS`, `LIVE_INITCODE_HASH`, `DEPLOY_BLOCK` backfilled | ✅ all four filled. `FACTORY_ADDRESS` and `DEPLOY_BLOCK=57400516` on deploy day; `HOOK_CREATION_CODEHASH=0xc43a20c9…41b4d139` and `LIVE_INITCODE_HASH=0x3a706af1…bd0e91ef` since. **Re-measured 2026-09-11 at block 59,605,031** — the script was run again against the live factory *after* the first mainnet launch, and the on-chain fingerprint still equals this tree's `keccak256(type(ToshLaunchpadHook).creationCode)`. The script reverts `HookCreationCodehashMismatch` if it does not, so a clean exit is the assertion. The same run read the live dials back: launch fee 0.01 ETH, default soft cap 10 ETH (restored after the launch), per-wallet cap 0.1 ETH, PoG signer `0x9A1a8C7b…`, platform treasury = the owner Safe |

**RH-F0b and RH-F1 were reset on 2026-09-03**, and the first version of this
note gave the wrong reason. It said the old factory could no longer be mined
against — that `createLaunch` would revert with `InvalidHookSalt`. It would
not have. The launch page reads `factory.hookInitcodeHash(...)` off the chain
and mines against the answer, so it tracks whatever factory is deployed; the
old one would have kept working indefinitely. See `PRE_MAINNET_CHECKLIST.md`
§6.2 for how a stale auto-generated comment produced that claim.

The real reason is narrower and is about verification, not availability.
Pinning the remappings moved the metadata hash, so the 46630 contracts were
Blockscout-verified against source this tree no longer produces. RH-F0b asks
for verified contracts; a deployment whose published source does not rebuild
does not satisfy it. Redeploying was the cheap way to make the row honest, and
it also re-based RH-F1 on contracts an auditor can reproduce.

RH-F2's finding is about ArbOS rather than about our bytecode, so it is not
invalidated, but the block heights it cites belong to the old deployment and
should be re-observed on the new one.

#### F.1 Two wall-clock constraints, both of them the contracts working correctly

**The genesis window cannot be shortened below three hours.** `launch()` requires
`block.timestamp >= genesisDeadline`, and `initializeToken` accepts a duration of
3 h, 24 h or 72 h and nothing else. There is no `vm.warp` against a real chain,
so the rehearsal is two sittings with a three-hour gap: `script/RehearseTestnet.s.sol`
splits into `Phase1Genesis` and `Phase2Launch` for exactly this reason, not for
tidiness. Plan the afternoon around it.

**And the stock economic parameters make a faithful genesis impossible.** Worth
catching before someone tries it and concludes the contracts are broken.
`ToshFactory`'s defaults are:

| Parameter | Default |
|---|---:|
| `launchFee` | 0.1 ETH |
| `defaultSoftCap` | 10 ETH |
| `maxPogAllocationLimit` | 0.1 ETH **per wallet** |

The last two multiply. Filling a 10 ETH soft cap when no wallet may contribute
more than 0.1 ETH takes **one hundred separately funded, separately PoG-attested
wallets**, and no faucet is going to underwrite that. The per-wallet cap is a
fairness property and it is working as designed; it just makes genesis the one
phase that cannot be rehearsed at production scale on a testnet.

So the rehearsal has to move the parameters, which the deployer can do because
`Deploy.s.sol` deliberately leaves the factory EOA-owned on testnet. What
`Phase1Genesis` actually applied:

    factory.setLaunchFee(0.001 ether)
    factory.setDefaultSoftCap(0.01 ether)          // == MIN_SOFT_CAP_PROD, the floor
    factory.setMaxPogAllocationLimit(0.01 ether)   // one wallet fills the cap exactly

The soft cap cannot go lower: `MIN_SOFT_CAP_PROD` is 0.01 ETH, and below it
`p0 = lpEth * 1e18 / GENESIS_LP_SUPPLY` starts truncating toward zero. The wallet
cap was raised to *meet* the soft cap rather than sit under it, which collapses
genesis to a single depositor. That is one more property given up on purpose:
multi-wallet genesis accounting — the `perWalletCap` rejection path, pro-rata
across several depositors — is not exercised here and stays covered by the local
suites.

**State plainly what that costs**, because it is the part that will be forgotten:
a rehearsal at these values does not exercise the arithmetic at production
magnitudes. Anything that could go wrong only at 10 ETH — an overflow, a rounding
step that disappears at small numbers, a bonding-curve tick that lands differently
— is out of scope for RH-F1 and stays covered only by the local suites, which do
run the real defaults. RH-F1 answers "does the sequence work against the real
chain", not "does it work at the real size".

RH-F2 exists as its own row because §2.5 means it is the *first* point in the
whole plan at which the central fix is genuinely exercised.

#### F.2 Deployed on 46630

`forge script script/Deploy.s.sol:DeployScript --broadcast --slow --verify
--verifier blockscout`. All four contracts verified; sources are readable on the
explorer.

| Contract | Address | Gas |
|---|---|---:|
| `ToshLadderTreasury` | `0x2Fe27f0207EBC8aCd73B608b58CF693d5310eEeB` | 1,507,996 |
| `ToshFactory` | `0x22Ba5ce2a0FAEc8A990E16Cc5E51Cb721cB64E86` | 8,015,925 |
| `ToshLaunchpadHook` (implementation, from the factory constructor) | `0x97B655c53d7B750639e049E39D26189B38F6d020` | — |
| `ToshToken` (implementation) | `0xc411a0Ecc63933b3eD642e76A6B2be2fFd097EE7` | — |
| `setFactory` | — | 51,571 |

**9,575,492 gas total, 0.0000958 ETH** at 0.01 gwei. Note that against the
18,462,503 the dry run predicted, the estimate was conservative by 1.9×; budget
from the estimate, reconcile against the receipt.

Post-deploy reads confirm the wiring closes in both directions —
`factory.ladderTreasury()` and `treasury.factory()` point at each other, and both
carry `poolManager = 0x8366a39CC670B4001A1121B8F6A443A643e40951`. Ownership is
the deployer EOA on all three, which is correct for testnet and is precisely what
§F.1's parameter rewriting depends on.

#### F.2b Redeployed on 46630 after the remapping pin (2026-09-03)

Same command as §F.2. All **five** contracts verified on Blockscout, this time
from source that reproduces from a clean clone — which is the point of the
redeploy, and the only thing wrong with the §F.2 deployment.

| Contract | Address |
|---|---|
| `ToshFactory` | `0x2E690A91b383eDB21f6b5B4180Cc4a2C905C6BeA` |
| `ToshLadderTreasury` | `0x3Fd38489e4B3F021324354Fb5A014Cc904D66C20` |
| `ToshLaunchpadHook` (implementation) | `0x31Db411E078Eed180fF5E516D16037fD7dd270Cc` |
| `ToshToken` (implementation) | `0x07A92b8C8c160Ac7461Aa3b6Ae6A65A3878123A0` |

Wiring re-confirmed in both directions, both carrying
`poolManager = 0x8366a39CC670B4001A1121B8F6A443A643e40951`, owner the deployer
EOA on both.

**The first `Phase1Genesis` attempt failed after printing a complete, correct
phase 1 report.** Foundry's message named EIP-1559 fee estimation and suggested
`--legacy`; the actual cause was three lines below it, `tls handshake eof`
against the public RPC. Nothing was sent — `launchCount()` was 0, `launchFee()`
was still the 0.1 ETH default rather than the rehearsal's 0.001, and the
predicted hook address held no code.

This is §F.5's lesson arriving through a different door. A `forge script`
report describes the script body, which runs whether or not the broadcast that
follows succeeds, so a full "PHASE 1 COMPLETE" block with addresses in it is not
evidence that anything happened. **Read the chain, not the report.** The retry
with `--retries 8 --delay 6` went through unchanged.

Genesis state, read back from chain rather than from the script:

| Result | Value |
|---|---|
| Hook | `0x90FDE02D9786C84198c21d2947C42D2C16c4fFDf` |
| Token | `0x489851b576f0043c56872A5e13991ac6e239dBe5` (`RHRSL`) |
| `softCap` / `totalEthDeposited` | 0.01 ETH / 0.01 ETH — filled |
| Hook address `& 0x20CC` | `0x20CC` — mined salt valid |
| `genesisDeadline` | 1788447616 (23:00 UTC+8, 2026-09-03) |

#### F.3 Genesis on 46630 (RH-F1, first sitting)

`forge script script/RehearseTestnet.s.sol:Phase1Genesis --broadcast --slow`, six
transactions, **971,032 gas / 0.0000097 ETH**.

| Result | Value |
|---|---|
| Hook | `0x70F48Dc75Cb448baeeCdC038103F9758C6A2BCfE` |
| Token | `0xBaAe9aAC56beF51bF5171e98C704fa00E1F5f28E` |
| `softCap` / `totalEthDeposited` | 0.01 ETH / 0.01 ETH — filled |
| `genesisDuration` | 10,800 s |

Two things worth keeping from this sitting.

**The salt mining works against the real factory.** The hook landed on
`0x…BCfE`, and `0xbcfe & 0x20CC == 0x20CC`. Every prior demonstration of that was
against a locally deployed factory, so the CREATE2 address derivation, the
initcode hash and the flag mask are now confirmed to agree with a factory whose
address nobody chose.

**`createLaunch` cost 534,102 gas, against 534,011 measured locally** — 0.02%
apart. Useful mainly as a negative result: the EIP-1167 clone path costs the same
under ArbOS as under a local EVM, so RH-B4's re-measurement concern does not
extend to deployment gas. It remains open for the piggyback constants, which sit
behind `launch()` and could not be measured in this sitting.

`lastSwapBlock` reads 0 here, as it must before `launch()` stamps it. It is the
number the second sitting exists to read.

#### F.4 Rehearsing the rehearsal, and the three things it caught

Three hours is too long to spend discovering a typo, so phases 2–4 were run
first against `anvil --fork-url $ROBINHOOD_TESTNET_RPC` with the clock pushed
past the deadline by `evm_increaseTime`. The fork carries the real deployment,
the real Uniswap V4 singleton and the real UniversalRouter, so everything except
the clock is genuine. Two notes on setting it up: ArbSys must be installed with
`anvil_setCode 0x64 0x4360005260206000f3` (nine bytes: `NUMBER; MSTORE; RETURN`),
for the reason §5.3 gives, and the fork must not be on a port that already has an
anvil — the second one exits and `cast` then talks to the first, which answers
happily as chain 31337.

It caught three things, and the first two would each have cost a real window.

**1. An eager-evaluation panic in the phase 2 guard.** The wait check was written
as `require(block.timestamp >= deadline, string.concat(..., vm.toString(deadline
- block.timestamp), ...))`. Solidity evaluates a `require`'s message argument
even when the condition holds, so the subtraction underflows the instant the
window opens — precisely and only when the script is meant to work. Now an
`if/revert`, which evaluates the message only on the failing branch.

**2. `TRIGGER_STEP` puts the buyback out of reach of a faucet.** A cycle arms at
a 1 ETH reservoir balance, and it is a `constant` with no setter — unlike the
soft cap and wallet cap, it cannot be scaled down for a rehearsal. The reservoir
fills from the 70 bps reservoir share of the dark tax, so arming it honestly
needs on the order of 143 ETH of swap volume. (The tax is now 1.00 %, but the
other 30 bps is the platform's cut and never reaches this balance, so the 143
figure is unchanged from when the tax was a flat 0.70 %.) On the fork the balance was set directly with
`anvil_setBalance` and the leg then ran correctly against the real V4 contracts:
0.3333 ETH spent (1 ETH ÷ `BATCH_SIZE`), tokens delivered to `DEAD_ADDRESS`.
**On the real testnet this leg stays unreachable**, and `Phase4Ladder` reports
that as a legible state rather than a failure. RH-F1's buyback evidence is
therefore fork-grade, not testnet-grade — worth knowing before the row is ticked.

**3. The burn does not move `totalSupply`.** `_buyAndBurn` transfers to
`DEAD_ADDRESS` rather than calling `_burn`, so a supply delta reads zero however
well the buyback worked. The script measures the dead address's balance instead.
A monitoring dashboard written against `totalSupply` would show a permanently
flat line and conclude the buyback was dead.

#### F.5 `forge script` cannot broadcast a transaction that touches ArbSys

The fourth thing, and the one the fork rehearsal could not have caught, because on
a fork ArbSys is something we installed ourselves.

`Phase2Launch` failed on its first attempt against the real chain. The trace is
worth keeping, because everything in it is correct up to the last line: 8.4 M
tokens minted to the hook, the pool initialised at tick 198567, `modifyLiquidity`
seating 184.4 e18 of liquidity across the full range, both currencies settled —
and then

```
├─ [0] 0x0000000000000000000000000000000000000064::arbBlockNumber() [staticcall]
│  └─ ← [InvalidFEOpcode] EvmError: InvalidFEOpcode
└─ ← [Revert] EvmError: Revert
```

An Orbit chain stores a stub at `0x64` whose bytecode is literally `0xfe`. The
node never executes it — it intercepts calls to the address and answers from Go.
Foundry has nothing to intercept with, so it fetches the stub over `eth_getCode`,
runs it, and hits `INVALID`. This is not the same problem as §5.3: there the
issue was that a fork has no ArbSys at all, here the issue is that it has one and
the copy is inert.

Installing the §5.3 mock in the script's `_setUp` is necessary but **not
sufficient**, which is the part worth writing down. `forge script` runs the
script body, then re-simulates the recorded transactions against live chain state
before it sends them, and that second pass does not carry cheatcode state. So the
run reports `Script ran successfully`, prints a complete phase 2 report including
`launched: true`, and then refuses to broadcast — with a trace showing `launch()`
reverting on `InvalidFEOpcode` and `addLadderToken` following it down with
`PoolNotLaunched()`. Both halves of that output are honest and they describe
different executions. Read quickly, it looks like a launch that half-happened.
Nothing had been sent; `launched()` was still `false` on chain.

The real node has no such trouble. `cast estimate` on the same call returned
518,497 gas against the live RPC, because there ArbSys is real.

Two ways through, both used here:

- **`cast send`** for a call with fixed arguments. Used for `launch()` and
  `addLadderToken()`. No simulation, no cheatcodes, nothing between the calldata
  and the node.
- **`forge script --skip-simulation`** where the script earns its keep by
  building calldata or asserting invariants — phases 3 and 4, which encode
  UniversalRouter actions and compare `quoteMint` against what is actually
  charged. This skips only the second pass; the script body still executes, so
  the mock from `_setUp` is still what makes it run to completion.

  The cost is that everything the script prints comes from its own simulation
  rather than from a mined receipt. Phase 3's numbers were re-read from the chain
  afterwards and matched to the wei, but that is a property of a pool nobody else
  is trading, not a guarantee. **Treat `--skip-simulation` output as a prediction
  and confirm it with `cast call`.**

**This applies to the mainnet deploy (RH-F3).** `Deploy.s.sol` itself does not
touch ArbSys, so it broadcasts normally — the constructor path never reads block
height. Anything that drives a launch afterwards does.

#### F.6 RH-F1 on 46630, end to end

| | tx | block | gas |
|---|---|---|---|
| `launch()` | [`0x0dfdae5c…`](https://explorer.testnet.chain.robinhood.com/tx/0x0dfdae5c998865386c1797326305470a3dd093e73dad7ac9c55fed86c7e9d595) | 108111395 | 501,932 |
| `addLadderToken()` | [`0xd3c9845c…`](https://explorer.testnet.chain.robinhood.com/tx/0xd3c9845c2811bd914ed34b5b0279619f3236d80f03caa66e144d83c8d135c823) | 108111914 | 165,587 |
| buy 0.002 ETH via UniversalRouter | phase 3 | — | — |
| ladder mint 315 tokens | phase 4 | — | — |

Gas price throughout was 0.01 gwei.

**RH-F2 is settled, and this is the result the whole migration turned on.**
`launch()` stamped `lastSwapBlock` at **108,111,395** — identical to the block
the transaction landed in, and in this chain's own height range. Had
`_blockNumber()` still been reading the `NUMBER` opcode it would have recorded an
L1 height near 25.8 M, the flash-loan lockout would have been comparing two
unrelated clocks, and it would never have fired once in production. The swap in
phase 3 re-armed it to 108,112,516, so the path holds after a swap as well as
after a launch. Every previous test of this supplied its own ArbSys with
`vm.etch`; this is the first time the real precompile answered.

The rest, all re-read from chain rather than taken from script output:

- **Genesis → launch.** 8.4 M supply minted, 3.78 M seated as full-range
  liquidity, 0.001 ETH launch fee forwarded to the treasury.
- **Buy.** 0.002 ETH in, 681,651.2 tokens out, and 14 gwei of dark tax to the
  reservoir — 0.7 % to the wei. (Measured before the buy leg was split. The
  reservoir's share is still 0.7 %, so this figure would reproduce today; what
  changed is that the trader now also pays a further 30 bps to the platform, so
  the total skim on the same trade would be 20 gwei rather than 14.)
- **Mint.** `quoteMint` said 787,499,999,685 wei and `mintBondingCurve` charged
  787,499,999,685 wei. Exact agreement against live pool state is the one thing
  no unit test can establish. `maxMintable` went 3,150 → 2,835, draining by
  exactly what was minted.
- **Buyback.** Not exercised on the production treasury, for the `TRIGGER_STEP`
  reason in §F.4 note 2. The reservoir holds 0.002014 ETH against a 1 ETH arming
  threshold, so `nextSpendAmount` is 0 and `Phase4Ladder` says so rather than
  failing. §F.7 closes this a different way, with a probe.

#### F.7 RH-B4 settled: the buyback leg, measured on 46630

**The finding in one line: ArbOS charges 4.8 % more than the local suite for a
buyback leg, and while measuring that, the gate protecting the leg turned out to
be set below the cost of running it — on both chains, since before the
migration.**

##### Why this needed a probe

RH-B4 asks for one number: what a buyback leg costs in the accounting the
contract will actually execute in. It sat open for as long as it did because of
a circularity rather than a lack of effort. The piggyback branch runs only when
the reservoir holds `TRIGGER_STEP` — 1 ETH, a `constant` with no setter. A
testnet faucet does not dispense that, and the dark tax that fills the reservoir
organically would need roughly 143 ETH of swap volume. So on every chain where
the number could be measured, the code that consumes it was unreachable. A
Foundry fork does not help either, for the reason in §5.3: it replays this
chain's state on a vanilla EVM, which reproduces the Ethereum number with extra
steps.

`test/probe/PiggybackGasProbe.sol` breaks the circle by deploying the real
`ToshLadderTreasury` with the arming threshold — and only the arming threshold —
replaced. `_nextSpendAmount` is now `virtual` to allow it; the runtime bytecode
is byte-identical with and without the keyword (every differing byte falls inside
the 53-byte CBOR metadata trailer, which moves whenever a comment does), so the
seam costs production nothing. `ToshV5Guards.t.sol` asserts production still uses
the base implementation.

Real in the measurement: `_runPiggyback`, `executeBuyAndBurn`, `_buyAndBurn`,
`_buybackSqrtFloor`, the V4 swap/settle/take triad, the live PoolManager, the
launched pool from §F.6, the hook that pool invokes, and ArbOS's accounting for
all of it. Not real: the threshold, and the caller — `ProbeGasMeter` stands in
for a hook, because `autoPiggybackBuyback` is `onlyHook`, and opens the unlock
frame that `afterSwap` would have opened.

##### Four samples

| run | leg (`gasleft` delta) | unlock frame | fill | note |
|---|---:|---:|---|---|
| 1 | **156,153** | 184,093 | 0.001 ETH, full | first burn for this token |
| 2 | 136,890 | 147,730 | floor-bounded | |
| 3 | 136,922 | 147,762 | floor-bounded | offered 3× more, filled the same |
| 4 | 136,890 | 147,730 | floor-bounded | |

Run 1: [`0xc556bcaf…`](https://explorer.testnet.chain.robinhood.com/tx/0xc556bcaf71c4ed4c1b4bd6976bae4a3923843d82363579d45bc18b48a1befc4e),
block 108,146,482, 233,062 gas for the whole transaction. It moved 0.001 ETH out
of the probe reservoir, burned 256,258 tokens to `0xdEaD`, and paid 0.7 % of the
buy as dark tax to the *production* treasury — the leg is a real market buy, not
a simulation of one. (Recorded before the buy leg was split; the treasury's
share is still 0.7 %, and a further 30 bps would now also leave for the platform
fee recipient.)

Two things the spread is worth reading for. **Run 1 is dearer by ~19k because it
took that token's `0xdEaD` balance slot from zero**, which is a once-per-token
cost and therefore the right one to size a gate against. And **runs 3 and 4 cost
what run 2 did despite being offered three times the ETH**: `_buybackSqrtFloor`
had bound by then and each leg filled only what TWAP drift allowed. That is the
anti-sandwich bound working, observed rather than argued, but it does mean the
steady-state figure here is a lightly-filled leg. A leg crossing more initialised
ticks costs more than 136,890, which is why the gate is sized on run 1.

##### Against the local control

`test_piggybackStillRidesAProperlyEstimatedSwap` measures the same leg as the
difference between an armed and an unarmed swap quote:

| | one leg |
|---|---:|
| local, `--isolate` (cold storage) | 148,986 |
| **Robinhood 46630, real transaction** | **156,153** |
| ratio | **1.048** |

**The migration's stated worry does not survive this.** §2.1 of
`PRE_MAINNET_CHECKLIST.md` warned that these constants were "tuned against
Ethereum's accounting, and ArbOS does not account identically", with the implied
risk that the divergence could be large enough to invalidate them. At 4.8 % it is
not. Nothing about ArbOS gas required the constants to be re-derived from
scratch.

##### What the measurement found instead

`PIGGYBACK_MIN_GAS` was **260,000**, and had been **230,000**. The gate reads:

```solidity
uint256 avail = gasleft();
if (ladderTreasury.balance >= PIGGYBACK_TRIGGER_STEP && avail >= PIGGYBACK_MIN_GAS) {
    try IToshLadderTreasury(ladderTreasury).autoPiggybackBuyback{gas: avail - PIGGYBACK_TAIL_RESERVE}() {}
```

At `avail = 230_000` the gate admits the poke and forwards `230_000 - 100_000`,
handing one leg 130k to do 149k of work. The leg runs out, `try/catch` swallows
it, the trade survives, and no buyback happens. So the floor below which the gate
is simply lying is `PIGGYBACK_TAIL_RESERVE + one leg`: **248,986 locally,
256,153 on 4663**. The old value sat 19k under the first and 26k under the
second.

This is an efficiency defect, not a custody one — the waste is bounded by the
forwarded gas, and `pokeBuyback()` is permissionless, so no buyback is
permanently lost. It is worth the fuss because of how it hid. The swap succeeds.
The buyback is merely absent, and absence is what this branch looks like when it
is working normally against an unarmed reservoir. The only trace is a
`PiggybackPokeFailed` nobody was watching for, and §5 of
`PRE_MAINNET_CHECKLIST.md` already records that a skipped buyback emits nothing
by design.

**It hid because the test bounded the constant from one side.** The suite
asserted `MIN_GAS <= TAIL_RESERVE + leg + 40_000`, catching a value drifting high
enough to retire the mechanism, and asserted nothing at all from below. The
matching `assertGe` is now there and fails at 230,000 with
`230000 < 248986` — checked before the fix, not after.

##### Choosing the replacement

The floor is the target rather than a bound to stay clear of, because both
directions away from it cost something and the costs are opposite. Below it, the
band between gate and floor is pure waste: pokes admitted that cannot finish.
Above it, the band between floor and gate is lost buybacks: pokes declined that
would have completed. Exactly at the floor both bands are empty. So "err low",
the rule the old comment gave, is not the right shape of advice in either
direction — it is right only until the floor and wrong immediately after.

**260,000** is the next round number above the 4663 floor of 256,153. 270,000 was
tried first and rejected: it clears the floor by 14k, and every one of those
14,000 gas is a window where a poke that would have worked is turned away.

The honest cost, since it is easy to present this as a free correction and it is
not: the engage test reads a **20 % wallet buffer where it read 15 %** at
230,000. Some of what 230,000 appeared to buy at 15 % was real. The trade is
still right — the 15 % was measured in Ethereum's accounting, which this contract
will never execute in, and in the accounting it will execute in the old value was
26k below the floor.

`PIGGYBACK_TAIL_RESERVE` stays at **100,000**. It covers a tail estimated at ~70k
on Ethereum, and 4.8 % of that is 3.4k, so the existing headroom absorbs the
ArbOS difference without a change. The probe's own frame overhead — the gap
between the `leg` and `unlock frame` columns above — is 27,940 on this chain,
consistent with that.

##### A mode-dependence found on the way

The structural bounds described themselves as "mode-independent, because both
sides are then measured in the same accounting". They were not. `MIN_GAS` is a
fixed constant while `legCost` moves with the run mode: plain `forge test` keeps
storage warm between calls inside a test and measured **100,286**, against
148,986 under `--isolate`. At 230,000 that went unnoticed because the constant
cleared both; the first value placed near the cold floor broke the warm run.

Fixed by measuring cold in both modes — `vm.cool` on the four accounts a leg
touches, taken before each of the two quotes. The gap closes from ~49k to ~9.5k
(139,486 warm, 148,986 cold) and the bounds hold in both. Worth noting that the
warm-with-cooling figure of 139,486 lands within 0.4 % of this chain's
steady-state leg at 136,890, which is a reassuring cross-check between two
measurements that share no code.

The percentage assertion that sat beside them — `assertLt(required, 50)` — is
gone, replaced by a check that *some* buffer in the sweep produces a real burn.
The paragraph above it had already explained that percentages are not comparable
across accountings; the assertion contradicting that paragraph survived only
because the constant it measured happened to clear both modes.

##### What is still open

The hook implementation deployed at
`0x97B655c53d7B750639e049E39D26189B38F6d020` on 46630 was built before this
change and still carries `PIGGYBACK_MIN_GAS = 230_000`. The measurement did not
depend on it — the probe calls the treasury directly — but **the testnet
deployment is now behind `src/`, and its initcode hash with it**. Anything
re-derived from that deployment must be re-derived after a redeploy. On mainnet
this is PM-C6 (`RecomputeInitcodeHash`), which is gated on RH-F3 and has to run
against the mainnet build regardless.

##### Reproducing it

```bash
forge create test/probe/PiggybackGasProbe.sol:ProbeRegistry \
  --rpc-url $RPC --private-key $PK --broadcast --constructor-args $HOOK $TOKEN
forge create test/probe/PiggybackGasProbe.sol:ProbeTreasury \
  --rpc-url $RPC --private-key $PK --broadcast --constructor-args $POOL_MANAGER $OWNER
forge create test/probe/PiggybackGasProbe.sol:ProbeGasMeter \
  --rpc-url $RPC --private-key $PK --broadcast --constructor-args $POOL_MANAGER $PROBE_TREASURY

cast send $PROBE_TREASURY 'setFactory(address)'      $PROBE_REGISTRY --rpc-url $RPC --private-key $PK
cast send $PROBE_TREASURY 'addLadderToken(address)'  $TOKEN          --rpc-url $RPC --private-key $PK
cast send $PROBE_TREASURY 'setProbeSpend(uint256)'   3000000000000000 --rpc-url $RPC --private-key $PK
cast send $PROBE_TREASURY --value 5000000000000000   --rpc-url $RPC --private-key $PK

cast send $PROBE_METER 'measure()' --rpc-url $RPC --private-key $PK --gas-limit 3000000
cast call $PROBE_METER 'lastPokeGas()(uint256)'  --rpc-url $RPC
cast call $PROBE_METER 'lastFrameGas()(uint256)' --rpc-url $RPC
```

`forge create` is used rather than `forge script` on purpose: none of these
constructors touch ArbSys, so they broadcast cleanly, while `measure()` does
reach it through the pool's hook and would hit §F.5 under a script. `cast send`
estimates against the node, so it never runs the vanilla-EVM simulation that
fails there.

Probe deployment on 46630, kept for re-runs: registry
`0x35409f9CcCEB564E2f53C0372f69Cc874ECBE328`, treasury
`0x8Af251CEae847a4acD55EA22Ab7B0eeE899303e9`, meter
`0xDb25d6959C3252b87D7f35424EF697F22EC2c3cc`. All three deployed for a combined
0.00002 ETH.

#### F.8 RH-F1 re-run on the redeployed contracts (2026-09-03, second sitting)

§F.2b redeployed the contracts so their published source rebuilds, which reset
RH-F0b and RH-F1. This is that re-run, on hook
`0x90FDE02D9786C84198c21d2947C42D2C16c4fFDf` and token
`0x489851b576f0043c56872A5e13991ac6e239dBe5`.

| | tx | block | gas |
|---|---|---|---|
| `launch()` | [`0x5c281f3d…`](https://explorer.testnet.chain.robinhood.com/tx/0x5c281f3dfb88b520e35c070dd923dce994013643371c5f965c09ac27c39b153a) | 112342060 | 506,235 |
| `claimGenesis()` | [`0x3c9239ac…`](https://explorer.testnet.chain.robinhood.com/tx/0x3c9239ac445b0253beccc90dd71a3c5f6658cc275b335d3f0ea62a443fc9fbec) | — | 136,902 |
| buy 0.002 ETH via UniversalRouter | phase 3 | — | — |
| ladder mint 315 tokens | phase 4 | — | — |

Every figure below was re-read with `cast call` after the fact, per §F.5. The
launch leg matched the three documented supply invariants exactly: 8.4 M minted,
4.62 M retained by the hook for claims, the 3.78 M difference seated as
liquidity. `claimGenesis` returned the whole 4.62 M, correct for a sole
depositor, leaving 7,741 wei of rounding dust in the hook, and a second attempt
was refused with `AlreadyClaimed()`. Phase 3 and phase 4 both matched their own
predictions to the wei — 681,651.205352259518743036 tokens out for 0.002 ETH in
with 1.4e13 of dark tax, then `quoteMint` and `mintBondingCurve` agreeing at
787,499,999,685 wei.

##### The price gate holds shelf 0 shut by 42 wei, and that is the design

Before phase 3, `maxMintable()` was 0 and `quoteMint` reverted
`TierPriceAboveCeiling()`. The numbers behind that are worth recording because
the margin is so thin it reads like a bug: shelf 0 costs 2,499,999,999 and the
105 % ceiling stood at 2,499,999,957. Forty-two wei, a relative gap of 1.7e-8.

It is exactly what the design asks for. `launch()` sets the pool's opening price
and shelf 0's price from the same `p0` so genesis buyers pay no premium, the gate
is a strict `>`, and sqrt truncation leaves the shelf a hair above the ceiling
rather than exactly on it. So nothing is mintable until the secondary market
moves — which is what makes phase 3 a prerequisite for phase 4 rather than
merely earlier in the list. The 0.002 ETH buy lifted the reference price to
3,543,836,596, `unlocked` flipped true, and the same `quoteMint` that had
reverted answered 2,499,999,999,000.

##### The first sitting listed the token 52 seconds after launch

`addLadderToken` carries an operational rule the contract does not enforce: do
not list a pool younger than `TWAP_WINDOW`. The hook reports a TWAP of 0 for
1800 s after `launch()`, `_buybackSqrtFloor` falls back to unbounded on 0, and
a token listed inside that window therefore has no anti-sandwich price bound on
its buyback legs, on the pool whose liquidity is thinnest.

§F.6's own table shows the first sitting broke it. `launch()` mined in block
108,111,395 and `addLadderToken()` in 108,111,914 — 519 blocks apart, which on a
100 ms chain is 52 seconds, not the 1800 required. Nothing was lost, because the
reservoir was far below `TRIGGER_STEP` and no buyback could run; but the
rehearsal did not rehearse the rule, and the sequence as recorded would carry
the same violation to mainnet.

This sitting waited. `twapSqrtPriceX96()` was polled directly until it turned
non-zero — the same getter `STATE-07` alerts on, rather than a deadline
re-derived from timestamps — and the token was listed only then, in
[`0xc740b50a…`](https://explorer.testnet.chain.robinhood.com/tx/0xc740b50a2c5f32bf43082887251989f33aec912749df6c51bcb37204616c6022)
for 172,575 gas, with `isLadderToken` read back true.

Polling rather than computing turned out to matter, which was not the
expectation going in. The TWAP stayed 0 for **at least 147 s past
`launch_ts + TWAP_WINDOW`**, and became readable only somewhere in the 28 s poll
that followed. The window is not the whole wait: `_prevCheckpointTs` rolls onto
a checkpoint already a full window old, and checkpoints are written by pool
interactions, so the clock effectively starts at the last checkpoint before
maturity rather than at `launch()`. A deadline derived from the launch timestamp
would have said "safe to list" while the floor was still unbounded — the exact
failure the rule exists to prevent, arrived at by doing the arithmetic the rule
does not ask for.

---

## 4. What does not change

Recorded so nobody spends time re-deriving it:

- Everything time-based. `block.timestamp` is real seconds here, so TWAP,
  genesis windows, `LAUNCH_WINDOW`, cooldowns and halts all carry over untouched.
- The transient-storage reentrancy mutex in `ToshLadderTreasury`.
- Hook salt mining as a mechanism. The `0x20CC` mask is unchanged; only the
  mined values change, because the bytecode does.
- `blockhash`, `prevrandao`, `basefee` and `coinbase` — none are used in `src/`,
  which removes the rest of the usual Arbitrum divergence list from scope.
- `msg.sender` aliasing, which applies only to L1→L2 messages. Nothing here
  receives them.

---

## 5. Settled since this file was written

### 5.1 UniversalRouter provenance (RH-A3) — resolved, and the answer inverts a test

Both claims in the original entry were half right, which is why they looked
contradictory. The deployed router **is** stock Uniswap: its source is verified
on Blockscout at `src/pkgs/universal-router/contracts/UniversalRouter.sol`, the
`Uniswap/contracts` monorepo layout, importing `RouteSigner`. It is not a
Robinhood fork. But it is a **newer build than Ethereum mainnet's**, and its

```solidity
struct ExactInputSingleParams {
    PoolKey poolKey;
    bool zeroForOne;
    uint128 amountIn;
    uint128 amountOutMinimum;
    uint256 minHopPriceX36;
    bytes hookData;
}
```

does carry `minHopPriceX36` — six fields, matching **this repository's**
`lib/v4-periphery`, not the five-field shape Ethereum's router decodes.

The bytecode sizes say the same thing from the outside: 24,546 bytes on 4663
against 19,499 on Ethereum, a 5,047-byte gap far past what differing immutables
could explain.

The consequence landed on `ToshV5Fork.t.sol`, and it is the reverse of what that
file used to document. It hand-rolled a five-field struct *because* "the deployed
router predates this repository's copy of v4-periphery". On Robinhood the
deployed router is ahead of it, so the retargeted suite deletes the hand-roll and
imports `IV4Router.ExactInputSingleParams`. `scripts/checkV4RouterTuple.mjs` was
inverted to match: it now fails when `lib/` and the deployed layout **differ**.

**And the five-field encoding does not fail loudly — that is the part worth
keeping.** Mutation-tested against the live router: reverting the fork suite to
the old hand-roll leaves seven of its eight tests green, including the exact
tax assertion (70 bps when this was measured; 100 bps, split 70/30, today —
the mutation survives either way, which is the point). Three coincidences stack
up:

- the deployed decoder is `swapParams := add(params.offset, calldataload(params.offset))`,
  a raw pointer cast with no length check, so a short tuple is reinterpreted
  rather than rejected;
- the word read as `minHopPriceX36` is the short tuple's `hookData` offset,
  `0x120` = 288. Nonzero, so the price check *runs* — but 288 in X36 fixed point
  is 4.2e-9, which every real price clears;
- the word read as the `hookData` offset is that tail's length, `0`, pointing
  back at the tuple start, whose first word is `currency0`. Native ETH, so zero,
  so `hookData` decodes as empty — correctly, by accident. An ERC20 `currency0`
  would read an address as a length and die. Every pool this protocol creates is
  ETH-paired.

Net: the swap succeeds with the right amounts and a silently discarded
`hookData`. So the fork suite alone cannot pin this layout, which is why
`test_fork_deployedRouterReadsTheSixthField` exists — it forces the sixth field
to `type(uint256).max` and asserts the revert, and it is the only test in that
file the wrong encoding kills.

### 5.2 Periphery on testnet 46630 (RH-A4) — verified

PositionManager (23,877 B), StateView (3,531 B), V4Quoter (6,118 B),
UniversalRouter (24,546 B) and ArbSys all present, at the same addresses and the
same sizes as mainnet.

### 5.3 Foundry cannot fork this chain faithfully — two independent reasons

Found while doing RH-E2. Neither is fatal, but each costs the suite something,
and what it costs is stated here rather than in a commit message.

**ArbSys does not work under a fork.** It is a host-implemented precompile, not
bytecode; the chain reports one `0xfe` byte at `0x64` and that is all Foundry
fetches. A `staticcall` to `arbBlockNumber()` on a fork therefore reverts with
empty returndata, while the same call against the live RPC returns 47,111,719.
A fork suite must `vm.etch` a mock at `0x64` **before** `new ToshFactory`, the
way `ToshV5ArbSys.t.sol` already does — the implementation latches `_hasArbSys`
in its constructor. `ToshV5Fork.t.sol` now does the same in `_installArbSys`.
Removing that etch kills five of its eight tests, so it is visibly load-bearing
rather than decorative setup.

Curiously, `block.number` under a fork reports the **L2** height (47,111,382),
because Foundry takes it from `eth_getBlockByNumber` rather than from the
`NUMBER` opcode's Arbitrum semantics. So a fork is wrong in both directions at
once, and neither error is visible without probing for it.

That second quirk has a silver lining and a cost. The lining: seeding the mock
from `block.number` gives it the chain's real L2 height rather than an invented
one. The cost: under a fork `block.number` and `arbBlockNumber()` **agree**, so
the fork suite cannot catch a regression that dropped `_blockNumber()` and went
back to `block.number`. Forcing the two apart is `ToshV5ArbSys.t.sol`'s job, and
that suite kills exactly that mutation.

The one thing the fork *can* check here, and does:
`test_fork_arbSysIsRegisteredOnThisChain` reads `ARB_SYS.code.length` from the
real chain before the etch covers it. That length is the premise `_hasArbSys` is
built on, and it is now checked once against the thing every other test mocks.

**The public endpoint cannot serve a pinned block.** State is retained for
somewhere between 1,000 and 10,000 blocks — at 100 ms, under seventeen minutes.
A fork pinned for reproducibility goes stale the same afternoon it is written,
so the suite forks the tip. A failure is a claim about the chain as it was that
morning rather than one anybody else can re-run. Pinning returns the day an
archive endpoint does; it is one constant in `setUp`.

---

## 6. Unverified, and deliberately not asserted

- **Contract size headroom** — resolved, and it was the non-issue it looked
  like. `forge build --sizes` after the ArbSys change: hook 20,598 B (3,978
  spare), factory 10,666, treasury 6,035, token 4,203. Nothing is near EIP-170.
  Unrelated but worth knowing if `--sizes` is read in CI: the test-only
  `CloneDeployer` helper in `ToshHookClone.t.sol` reports 27,637 B, because it
  embeds the hook's creation code. It is never deployed to a chain, and it was
  already thousands of bytes over before this migration touched anything.
- **Sequencer failure modes.** A single-sequencer FCFS chain with a 7-day
  withdrawal challenge period has an availability profile that
  `INCIDENT_RESPONSE.md` was not written against. Out of scope for the
  migration; worth a pass of that document before mainnet.

---

## 7. Reproducing the probes

All read-only, no key required.

```bash
RPC=https://rpc.mainnet.chain.robinhood.com

# Chain identity and infrastructure
cast chain-id --rpc-url $RPC
cast code 0x8366a39CC670B4001A1121B8F6A443A643e40951 --rpc-url $RPC   # PoolManager
cast code 0x4e59b44847b379578588920cA78FbF26c0B4956C --rpc-url $RPC   # CREATE2 factory

ARB_SYS=0x0000000000000000000000000000000000000064

# block.number as a CONTRACT sees it: NUMBER, MSTORE, RETURN
cast call --rpc-url $RPC --create 0x4360005260206000f3      # -> L1 height
cast block-number --rpc-url $RPC                            # -> L2 height
cast call $ARB_SYS "arbBlockNumber()(uint256)" --rpc-url $RPC

# Cancun opcodes: TSTORE 0x2a then TLOAD it back
cast call --rpc-url $RPC --create 0x602a60005c60005d60005260206000f3
cast call $ARB_SYS "arbOSVersion()(uint256)" --rpc-url $RPC

# ArbSys is registered with one 0xfe byte — the discriminator §2.4 relies on
cast code $ARB_SYS --rpc-url $RPC
```

The viem check, from `soat-frontend/`:

```bash
node -e "const c=require('viem/chains'); console.log(c.robinhood.id, c.robinhoodTestnet.id)"
```
