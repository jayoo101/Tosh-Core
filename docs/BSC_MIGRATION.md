# Moving settlement to BNB Smart Chain (56)

Scope as decided: a **full move**. The Robinhood Chain factory is not maintained
after the cutover, and nothing migrates off it.

Everything in this document was read from chain or from the vendor's own
documentation on 2026-09-17. Where a figure was measured, the measurement is
stated so it can be re-run rather than trusted.

> **§1 and §2 are no longer arguments.** `test/ToshV5ForkBsc.t.sol` runs the
> whole lifecycle against a BSC mainnet fork — mine a salt, create, deposit,
> launch into the live singleton, then buy through the deployed router — and
> **all 9 tests pass with no change to any contract**. Run it with
> `$env:BSC_RPC="https://bsc-dataseed1.bnbchain.org"; forge test --match-path
> test/ToshV5ForkBsc.t.sol`. It skips without the variable, so CI is unaffected.
>
> What that run settles, as opposed to argues: the hook's `_hasArbSys` fallback
> is the branch that executes (the suite needs no `_installArbSys` at all, and
> its absence is the evidence); BSC's live 24,009-byte singleton accepts a hook
> address our miner produced and holds the genesis liquidity; and the router
> reads the sixth field, so the tuple layout is measured rather than inferred
> from a bytecode diff.

---

## 1. The contract layer is nearly free

This is the surprise, and it is a consequence of decisions already made rather
than luck.

**`ArbSys` needs no change.** `_hasArbSys` is set at construction from
`ARB_SYS.code.length != 0`, so a chain without the precompile falls through to
`block.number` on its own. BSC's `block.number` is a real block height, which
is exactly what the two call sites — the same-block lockout and `maxMintable()`
— want. No edit, no flag, no redeploy path to think about.

**Cancun is available.** BSC enabled EIP-1153 (`TSTORE`/`TLOAD`) in the Tycho
hard fork on 2024-06-20 via BEP-343, so `evm_version = "cancun"` and V4's
transient-storage accounting both hold.

**The V4 periphery is deployed.** Confirmed by reading code size on chain 56,
not by citation:

| Contract | Address | Code |
|---|---|---|
| PoolManager | `0x28e2ea090877bf75740558f6bfb36a5ffee9e9df` | 24,009 B |
| PositionManager | `0x7a4a5c919ae2541aed11041a1aeee68f1287f95b` | 23,877 B |
| StateView | `0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4` | 3,531 B |
| V4Quoter | `0x9f75dd27d6664c475b90e105573e550ff69437b0` | 5,820 B |
| UniversalRouter 2.1.1 | `0x8b844f885672f333bc0042cb669255f93a4c1e6b` | 24,546 B |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | 9,152 B |

CREATE2 hook mining, the `0x20CC` flag encoding and Permit2's canonical address
are all chain-independent.

---

## 2. The router: one address is correct, the other is a trap

BSC lists two Universal Routers, and the difference is not cosmetic.

| Router | Address | Code |
|---|---|---|
| Robinhood (today's production) | `0x8876789976dEcBfCbBbe364623C63652db8C0904` | 24,546 B |
| BSC Universal Router | `0x1906c1d672b88cd1b9ac7593301ca990f94eae07` | **19,499 B** |
| BSC Universal Router **2.1.1** | `0x8b844f885672f333bc0042cb669255f93a4c1e6b` | **24,546 B** |

The BSC 2.1.1 router and the Robinhood router are the same compiled build.
Measured: identical length, and the bytes differ in **35 contiguous runs, every
one of them 32 bytes or shorter** — 34 at 20 bytes (address immutables) and one
at 32 bytes (a `bytes32` immutable). No run exceeds a single word, so there is
no logic difference, only chain-specific immutables.

That settles the question `scripts/checkV4RouterTuple.mjs` exists to ask: the
six-field `ExactInputSingleParams` matches, `lib/v4-periphery` agrees, and the
frontend's V4 encoding needs no change.

**Provided the 2.1.1 address is the one wired in.** The 19,499-byte router is a
different, older build, and per that guard's own analysis a tuple mismatch is
not rejected — it is reinterpreted. The swap succeeds, the amounts are right,
`hookData` is silently discarded, and the fork suite does not catch it because
the results look correct. Wiring the wrong BSC router is therefore a bug with no
symptom until a hook stops receiving its data.

`test_forkBsc_deployedRouterReadsTheSixthField` confirms this against the chain:
forcing the sixth field to a bound nothing can satisfy makes the deployed router
revert, which it can only do if it read our word 9 at the offset the six-field
layout puts it. The bytecode diff said "probably"; that test says "yes".

`test_forkBsc_theOtherRouterIsADifferentBuild` pins the choice between the two
addresses, so it is a failing test rather than a comment if someone reaches for
"the BSC Universal Router" and gets the 19,499-byte one.

Remaining action: point `scripts/checkV4RouterTuple.mjs` at chain 56 and the
2.1.1 address. The guard's premise — that agreement is two versions happening to
line up, not a property of the world — is unchanged and still worth keeping.

---

## 3. Proof-of-Gas: replace Blockscout, do not add to it

Blockscout's own migration table lists **BNB Smart Chain 56 and 97 as
unsupported** by its PRO API. Since the scanner is built entirely around one
Blockscout PRO key fanning out over `api.blockscout.com/{chainId}`, BSC gas
history is unreadable through the current vendor. For a launchpad settling on
BSC that is not a rounding error: the users most likely to arrive are the ones
whose gas history is on BSC, and they would receive no allocation at all.

The fix is better than a second vendor. `api.etherscan.io/v2/chainlist` returns
63 chains, and it covers **every chain the scanner reads** — 1, 10, 42161, 8453,
56, 97 — *and* Robinhood Chain 4663. One key, one API shape, all chains. That is
one fewer vendor than today, not one more.

| | Blockscout PRO | Etherscan v2 |
|---|---|---|
| Ethereum 1, Arbitrum 42161, Optimism 10 | yes | yes |
| Base 8453 | yes | paid tier only |
| **BSC 56 / 97** | **no** | paid tier only |
| Robinhood 4663 | yes | yes (free until 2026-10-15, then Lite+) |

Etherscan's free tier excludes BSC *and* Base, so this needs the $49/mo Lite
plan (5 calls/sec, 100,000 calls/day). Compare that against what the Blockscout
PRO tier currently costs before treating it as a new expense.

Two consequences for `gasHistory.ts`:

- It speaks two Blockscout shapes today (`ScanApi = 'v1' | 'v2'`) and the
  probe-first path exists because v1 cannot filter by direction. Etherscan's
  `txlist` has the same limitation, so that logic carries over rather than being
  rewritten.
- BSC has no separate L1 data fee, so `gasUsed * gasPrice` is the whole fee:
  the new chain row is `execFeeIsWholeFee: true`, like Ethereum and Arbitrum.

> **Stale claim to fix while here.** `foundry.toml` says "chain 4663 is absent
> from Etherscan v2's multichain host". That was true when written and is no
> longer: Etherscan lists Robinhood Chain, free until 2026-10-15.

---

## 4. The release process loses its rehearsal

**There is no Uniswap V4 on BSC testnet.** Uniswap publishes no chain-97
deployment, and the mainnet PoolManager address reads empty code there
(confirmed).

This removes a property the current setup depends on and that
`docs/DEVELOPMENT.md` calls out explicitly: Robinhood mainnet and testnet
*share every V4 address*, so a testnet rehearsal exercises the production
address book unchanged. On BSC there is no equivalent, and
`script/Deploy.s.sol` plus `script/RehearseTestnet.s.sol` have nothing to point
at.

Three ways out, none free:

1. **Rehearse against a BSC mainnet fork.** Already proven workable in this
   repo — the soft-cap removal was demonstrated exactly this way, by forking and
   warping time. Cheapest, but it is a fork, so it never catches a
   chain-behaviour difference.
2. **Deploy your own V4 on chain 97.** Gives a real testnet loop, but the
   periphery would be yours rather than Uniswap's, which weakens the thing the
   rehearsal is supposed to prove.
3. **Rehearse on mainnet with tiny amounts.** Honest and real; costs real BNB
   and puts rehearsal hooks in the production factory's `launches` array.

This deserves a decision before any code is written, because it shapes the whole
cutover.

---

## 5. The watcher needs a keyed RPC again

Measured on the public endpoint: a **9,000-block `eth_getLogs` span is refused**
with `limit exceeded`. BSC produces a block every **0.451 s** (measured across
2,000 blocks), so an hourly watch pass spans roughly 8,000 blocks — the same
magnitude that broke the watcher on Robinhood and the same refusal shape.

This is a solved problem with a known cost: `MONITOR_RPC` already points at a
paid dRPC Growth endpoint for exactly this reason. Budget the equivalent for
BSC and confirm the range limit before cutover rather than after.

---

## 6. Economics to recalibrate

Deployment itself is cheap: at the measured 0.05 gwei, the 15,143,081 gas the
factory and treasury deploy consumes costs about **0.000757 BNB**.

What needs thought is denomination. The PoG band — floor 0.025, rate 0.5,
ceiling 0.5 — is priced in the settlement chain's native token, and 0.5 BNB is
an order of magnitude away from 0.5 ETH in value. So:

- Re-derive the band against BNB, and recompute the attacker-cost paragraph in
  `README.md`, which inverts at different numbers rather than merely restating.
- `defaultSoftCap` (10 ether) and `MIN_SOFT_CAP_PROD` are the same question.
- `maxPogAllocationLimit` must be correct **at deploy**, since the off-chain
  ceiling cannot exceed it.
- The band is rotatable now without a redeploy, which is what makes getting this
  slightly wrong survivable.

**Resolved:** a single ×3.5 factor, applied to every BNB-denominated constant.
Chosen over per-constant rounding because one factor keeps the numbers clean and
auditable, and it sat ~4% above spot at the time (1 ETH = 3.3624 BNB). The PoG
band is the exception and is deliberately split across two currencies: the floor
stays in ETH because it measures ETH gas history, while `maxAllocWei` and `rate`
move to BNB because they bound a BNB deposit. `pogQuota.ts` carries the full
argument. The `README.md` attacker-cost recomputation is still outstanding.

The 21 `totalNativeDeposited`-style identifiers keep working — they are all
`msg.value` — but every one of them names the wrong asset. That is a rename,
not a behaviour change, and it reaches the ABI and the frontend. **Done** across
843 occurrences in 43 files.

### 6.1 Quote asset: BNB, not an ERC20

`0x5ce033b2bfca3af30b3e8c8457deaf776a8b695a` ("BEM") was raised as a candidate
for the raise currency and the pool's quote side. **Rejected; BNB stays.**

Measured: plain ERC20, 2,205 bytes, no transfer tax or blacklist or pause,
8 decimals, supply 181,273.29979283. But it exposes `mint(address,uint256)` gated
by a single `minter()` = `0x7E2E0DC66a3bD9103E69b766afA62d9f7b697b46`, a 130-byte
contract, with no `owner()` and no role system — a quote asset one address can
inflate. Its only real market is the PancakeSwap v3 1% tier (1,562.92 BEM against
77.55 WBNB, implying ≈0.0496 BNB per BEM); the v2 pair and the v3 0.25% tier hold
dust, and there is no BEM/USDT pair. Note that `balanceOf` on a v3 pool sums all
ticks plus uncollected fees and is **not** usable depth at spot.

The structural reason matters more than the token's own risk. Every pool this
protocol creates is native-coin/token, so `currency0` is always zero — an
assumption `scripts/checkV4RouterTuple.mjs` cites directly when arguing about its
quiet failure mode. An ERC20 quote asset turns deposits from `msg.value` into
`transferFrom` and rewrites the refund and buyback paths. That is a larger change
than the whole BSC migration.

See `docs/PANCAKESWAP_INFINITY.md` §6 for the same record from the AMM side.

One code comment goes stale: the `uint48 _lastSwapBlock` headroom note reasons
from 12-second blocks. At 0.451 s the slot still holds about **4.0 million
years**, so the conclusion survives and only the arithmetic needs redoing.

---

## 7. Work breakdown

Mechanical, once the decisions above are made:

- `src/lib/chain.ts`: add `bsc` to `CHAINS_BY_ID` (viem ships it), retune
  `MAINNET_CHAIN_LABEL` and the byline/badge/positioning constants.
- `src/lib/contracts.ts`: the six periphery addresses. `POOL_MANAGER` is a
  source constant on purpose — a wrong one silently mis-CREATE2s every hook.
- `foundry.toml`: `[rpc_endpoints]` and `[etherscan]` to BscScan via Etherscan
  v2, which is simpler than the Blockscout arrangement it replaces.
- `gasHistory.ts`: Etherscan v2 as the transport; add chain 56.
- `scripts/checkV4RouterTuple.mjs`, `checkChainCopy.mjs`,
  `checkBlockscoutKey.mjs` (becomes an Etherscan check).
- 194 occurrences of "Robinhood" and 123 of `4663`/`46630` across `src`,
  `test`, `script`, `scripts`, `soat-frontend/src` and `monitoring`.

Needs a decision first, in this order:

1. How to rehearse without a V4 testnet (§4).
2. The BNB-denominated band and soft cap (§6).
3. Whether the Etherscan Lite plan replaces the Blockscout spend or adds to it
   (§3).

---

## 8. What stays behind

The Robinhood factory `0x2920ca7E9fcD85491D699e1f9Ae2CAa65Cfb2892` keeps
running whether or not it is maintained. Hooks are immutable clones, so the one
launched project goes on trading there, and the ladder treasury's 0.021293 ETH
stays where it is — `withdraw`, `sweep` and `rescue` are absent by design. See
`docs/MAINNET_REDEPLOY.md` §2, which covers the same ground for a same-chain
redeploy and applies unchanged here.

A cross-chain move makes one of those points sharper: the frontend enumerates
`launches` from a single factory, so after the cutover the Robinhood project is
not merely delisted, it is on a chain the UI no longer connects to.
