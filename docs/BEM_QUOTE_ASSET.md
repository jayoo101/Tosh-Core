# Moving the quote asset to BEM

Status: **approved and implemented in this tree.** §6's three blocking questions
were answered in §0; the constructors, CREATE2 grind, `transferFrom` paths,
tests, frontend money paths and the script guards are in. What is still missing
is a live factory: `56` has not been deployed against BEM, and `97` has no BEM
to rehearse on. The structural choice in §0.1 (quote asset as an
implementation-level immutable) is what shipped.

It reverses a decision already recorded in `docs/PANCAKESWAP_INFINITY.md` §6
("Quote asset: BNB, decided"), so it has to answer that document rather than
ignore it. One of its five grounds has genuinely gone away. Three have not, and
one of those three undoes the reason this protocol is on PancakeSwap Infinity at
all.

Every figure below was measured on BNB Smart Chain `56` on 2026-09-19 with `cast`
against `https://bsc-dataseed1.bnbchain.org`, or computed from constants in this
tree. Where a number is computed rather than measured, it says so, and the
arithmetic is shown so it can be checked.

BEM is `0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a`.

---

## 0 · Decisions taken

**1. No test BEM on `97`. There will be no real-network rehearsal.** §4 called
this blocking and it was overruled; recording that plainly is the point of this
entry. What the decision actually costs is narrower than §4 implies, and worth
separating into what is recoverable and what is not.

Recoverable, and now the main line of defence: real BEM exists on `56`, so the
mainnet-fork suites (`ToshV5Fork.t.sol`, `ToshV5ForkInfinity.t.sol`, driven by
`BSC_RPC`) can exercise **real BEM bytecode** — the 8-decimal arithmetic, actual
`transferFrom` semantics, and a real Infinity pool with BEM as `currency0`. That
covers the failure classes this change is most likely to introduce, and the
`--isolate` run covers the per-call gas accounting. Fork coverage is therefore
not optional here; it is the substitute, and it should be held to a higher bar
than it was for the Infinity port, where `97` was available as a backstop.

Not recoverable: **multi-day time passage on a real network.** The `97`
rehearsal is what caught `addLadderToken` being unable to follow `launch()`
because the TWAP needs its full 1,800 seconds, and it is what exercised the
deploy-wiring sequence against real block production. On a fork `vm.warp` skips
that in one jump and always succeeds. So the residual risk is concentrated in
time-dependent and deploy-sequence behaviour, not in the ERC-20 mechanics — and
`preflightMainnet.mjs` plus `VerifyDeployment.s.sol` are the only things standing
in front of the deploy sequence now.

**2. Force the token address above BEM with CREATE2 (§3.1b).** Taken as
recommended. Reintroduces a weak salt grind, 1.57 expected attempts, and
preserves the "quote asset is always `currency0`" invariant that 91 hook sites
depend on.

**3. `MIN_SOFT_CAP_PROD` = 100 BEM.** Taken as recommended — the margin option,
where adjacent shelves differ by 4.75 integer units rather than 1. This raises
the smallest possible raise from 0.035 BNB-equivalent to about 3.8, roughly
108×. Small projects can no longer launch, by decision rather than by accident.

### 0.1 Where the quote asset lives, and why there

Decided while wiring, and recorded because it is the one structural choice that
would be expensive to revisit.

`quoteAsset` becomes an **implementation-level immutable** on
`ToshLaunchpadHook`, `ToshFactory` and `ToshLadderTreasury` — a constructor
argument, not one of the five per-project clone arguments. The hook already
holds `poolManager`, `vault` and `factory` this way: they are baked into the
implementation's bytecode and shared by every clone, while only `creator`,
`projectTreasury`, `softCap`, `perWalletCap` and `genesisDuration` are appended
per project.

This matters for three reasons. It leaves the 131-byte clone initcode tuple
untouched, so `hookInitcodeHash`'s argument list, `checkCloneInitcodeTuple.mjs`
and the frontend's address prediction all keep their current shape. It keeps the
quote asset out of a hot path — `_key()` runs inside `beforeSwap`, and reading
the factory for it would add an external call per swap. And it inherits the
reasoning already written at `ToshLaunchpadHook.sol:704`–713 about why
`poolManager` is an immutable rather than a factory field: a mutable one would
let the platform owner repoint economics under a launch that had already taken
money. The quote asset is exactly that kind of value, so changing it must
require a new implementation and a new factory, and now does.

They cannot disagree, and a constructor equality check would have been the
wrong tool. The factory deploys the hook implementation from inside its own
constructor via `HookDeployLib.deployImplementation`, which is a DELEGATECALL
so `address(this)` inside the library is the factory mid-construction. Both
immutables are therefore written from the same `_quoteAsset` argument in the
same construction. That is the same structural argument
`hookImplementation` already makes about itself, and it is why the first
wiring pass did not add a cross-check: there is no deploy ordering in which
the two can name different tokens. The hook constructor still asserts
`decimals() == 8`, so that claim is checked once, there, rather than in
every caller.

---

## 1 · What changed, and what did not

**Changed: the token is ours.** §6 objected that "a quote asset whose supply one
address can expand is a different risk class from the native coin". The operator
has confirmed the `minter()` is under their control, which moves supply policy
from *counterparty risk* to *internal policy*. That is a real change and it is
why this document exists.

Two observations to confirm rather than assume, because neither is what a
casual reading of "we control it" would predict:

- Supply is moving. §6 recorded 181,273.29979283 BEM on 2026-09-17. Today
  `totalSupply()` is `18998386831142` — 189,983.86831142 BEM at 8 decimals.
  That is **+8,710.56851859 BEM, or +4.81%, in about two days.** Whether that is
  intended is a question for whoever operates the minter; what matters here is
  that anything denominated in BEM is denominated in a quantity that moved 4.81%
  while this document was being written.
- `minter()` is an **ERC-1967 proxy**, not a plain contract. Its 130 bytes are a
  minimal delegating proxy whose implementation slot
  (`0x360894…82bbc`, the OpenZeppelin implementation slot) points at
  `0xa3dbe873da37cd4e4a13c7cef23a7db6ca60f898`, 24,574 bytes, which answers
  `proxiableUUID()` — so it is UUPS and the mint logic is **upgradeable**. But
  `owner()` called through the proxy returns the **zero address**. If upgrade
  authority is `onlyOwner`, as UUPS conventionally is, then the implementation
  is frozen and the current mint policy cannot be changed by anyone. That may
  be deliberate and is arguably good for depositors, but it means "we control
  it" needs to be checked against what the contract will actually accept.

**Unchanged: market depth.** The one real market is the PancakeSwap v3 1% tier
at `0x28B12792F9D81Bd529Bc5572434E861C9EDbBBC2`, holding **1,959.32 BEM against
73.88 WBNB** — implied ≈ **0.037705 BNB per BEM**. §6 measured 0.0496 two days
ago, so BEM is down about 24% against BNB over the same window in which supply
rose 4.81%. As §6 already cautioned, `balanceOf` on a v3 pool is the total
across all ticks plus uncollected fees and **not** usable depth at spot, so real
slippage is worse than these figures suggest. There is still no BEM/USDT pair.

At today's price a 35-BNB-equivalent soft cap is **928 BEM**, which is **47% of
all BEM in that pool**. A depositor cannot acquire it, and a raise that filled
would seed a pool with more BEM than the open market holds.

**Unchanged: 8 decimals.** This turns out to be the binding engineering
constraint, and it is not where the trouble was expected. See §2.

**Unchanged, and decisive: BEM does not exist on testnet `97`.** `cast code`
returns `0x` — zero bytes. Section 4 is about what that costs.

---

## 2 · The conversion, and where the naive one breaks

This is the part that was asked for, and the headline is that the straightforward
conversion is arithmetically fine and **still wrong**, for a reason that only
shows up when you check the tier ladder.

Each constant needs two adjustments: `÷1e10` because BEM has 8 decimals where
BNB has 18, and `×26.52` because one BNB is 26.52 BEM at 0.037705. Net ×2.652e-9
on the raw integer.

| Constant | Now (BNB, 1e18) | Naive BEM (1e8) | Use instead |
|---|---|---|---|
| `launchFee` | 0.35 | 9.28 BEM | 9.28 BEM |
| `defaultSoftCap` | 35 | 928.4 BEM | 928.4 BEM |
| `TRIGGER_STEP` | 3.5 | 92.8 BEM | 92.8 BEM |
| `maxPogAllocationLimit` | 1.75 | 46.4 BEM | 46.4 BEM |
| `MIN_SOFT_CAP_PROD` | 0.035 | 0.93 BEM | **≥ 100 BEM** — see below |

### 2.1 The tier ladder degenerates at small raises

`ToshLaunchpadHook.launch()` computes the pool's opening price as

```
p0 = (lpQuote * 1e18) / GENESIS_LP_SUPPLY        GENESIS_LP_SUPPLY = 3.78e24
```

`p0` is therefore *quote base units per 1e18 token*, and dropping the quote from
18 decimals to 8 costs it ten decimal digits of headroom. Shelf prices step
`TIER_STEP = +0.19025%` each, so adjacent shelves differ by `p0 × 1.05 ×
0.0019025` — and that difference is an integer. Computed from the constants in
this tree:

| Raise | `p0` | Adjacent shelf step | |
|---|---|---|---|
| 0.93 BEM *(naive min)* | 22 | 0.044 | **truncates to 0** |
| 5 BEM | 119 | 0.238 | **truncates to 0** |
| 21 BEM | 500 | 0.999 | **truncates to 0** |
| 100 BEM | 2,380 | 4.75 | ok |
| 928.4 BEM *(soft cap)* | 22,109 | 44.2 | ok |

Below roughly **21 BEM** of raise, consecutive shelves round to *the same integer
price*, and the "4,000 shelves, +0.19025% each" ladder becomes a flat step
function for its lower reaches. `ToshFactory.sol:126` already warns that
`lpQuote < 3_780_000` base units collapses `p0` to zero outright; that threshold
is only 0.0378 BEM and is not the one that bites. The one that bites is this one,
and it is 500× higher.

So `MIN_SOFT_CAP_PROD` cannot be converted — it has to be **raised in real
value**, from 0.035 BNB to about 0.79 BNB-equivalent at the bare threshold, or
~3.8 BNB-equivalent (100 BEM) for the margin the table suggests. **That is a
product decision, not a refactor:** the smallest possible raise gets ~22× to
~108× more expensive, and small projects stop being able to launch.

Confirm this with a test before acting on it. The premium identity is already
pinned by the suite, so the check is whether that test still passes at a
minimum-soft-cap raise in 8-decimal units — if the ladder degenerates, it should
fail, and if it does not fail, the test is not covering this.

### 2.2 What the conversion does not break

Checked, so that the plan does not spend effort here:

- **`sqrtPriceX96` does not overflow.** `_toSqrtPriceX96` computes
  `(sqrt(amount1) << 96) / sqrt(amount0)`. At the soft cap that is
  `(1.944e12 << 96) / 2.891e5 ≈ 5.33e35`, against a `uint160` ceiling of
  1.46e48. Comfortable.
- **The initial tick stays in range.** The raw price ratio becomes ≈ 4.52e13,
  which is tick ≈ **+314,400**, inside the `±887,200` full-range bounds the
  genesis position uses. It is far off-centre compared to BNB's ≈ +116,900, but
  in range, and `TICK_LOWER`/`TICK_UPPER`/`TICK_SPACING` need no change.

---

## 3 · The re-architecture, layer by layer

§6 predicted this would be "a larger change than this whole port". Counting
mentions of `payable`, `msg.value`, `isNative`, `CurrencyLibrary.NATIVE` and
`_sendNative`:

| Area | Sites |
|---|---|
| `ToshLaunchpadHook.sol` | 91 |
| `ToshFactory.sol` | 28 |
| `ToshLadderTreasury.sol` | 18 |
| `ToshCloneLib.sol` | 1 |
| `test/*.sol` | 365 |
| `scripts/*.mjs` | 36 |
| `soat-frontend/src` | 49 |

The count is not the difficulty. §3.1 is.

### 3.1 `currency0` ordering — the genuinely hard problem

Infinity sorts a `PoolKey`'s currencies by address, and the native coin is
`address(0)`, so **every pool this protocol has ever opened has the quote asset
as `currency0`**. `ToshLaunchpadHook.sol:2195` hard-codes
`currency0: CurrencyLibrary.NATIVE`, and the codebase leans on the invariant
well beyond that line: `_skimInputTax` derives `nativeIsInput` directly from
`params.zeroForOne`, the buy/sell tax split depends on which delta is the input,
`_sqrtPriceToNativePerToken` inverts assuming quote-is-`currency0`, and
`ToshLadderTreasury.sol:430` refuses to list a token unless
`key.currency0.isNative()` — with a comment saying why: the hard-wired
`zeroForOne = true` buy direction would otherwise swap the wrong way.

BEM sits at `0x5ce0…`, which is **36.3% of the way through the address space.**
Project tokens are deployed by `ToshCloneLib.deployBareClone` with plain
`CREATE` — nonce-derived, as its comment states, precisely because a token
address "carries no V4 permission bits, so nothing needs to predict or mine it".
Nonce-derived addresses are effectively uniform, so roughly **36% of projects
would get the token as `currency0` and 64% as `currency1`.**

That is the worst possible shape. The invariant would not invert cleanly — it
would hold for about two projects in three and fail for the other one, which is
far harder to catch than a total reversal. A test fixture that happens to land
on the common ordering passes while a third of real launches misprice their tax.

Two ways out:

**(a) Support both orderings.** Thread "which side is the quote" through all 91
hook sites, both tax paths, the TWAP inversion and the treasury's swap
direction. Honest assessment: this is the highest-risk change in the whole plan
and the one most likely to ship a silent, per-project mispricing.

**(b) Force the ordering at deploy time — recommended.** Move the project token
from `CREATE` to `CREATE2` and require its predicted address to be **above
BEM**, so BEM is always `currency0` and the existing invariant survives
untouched. 63.7% of salts qualify, so the expected number of attempts is
**1.57** — the creator grinds off-chain and passes a `tokenSalt`, and the factory
recomputes the address and reverts if it does not clear BEM.

Option (b) reintroduces a salt mine, which this tree deliberately deleted when
Infinity removed the need for one. Worth saying plainly rather than hiding: it
is a far weaker mine than the V4 one (1.57 expected tries versus ~32 for the
`0x20CC` mask), it is checked by equality against a constant rather than a mask,
and the frontend already has the address-prediction machinery from
`hookAddress.ts`. It buys the preservation of an invariant that 91 call sites
depend on, which is a good trade — but it is a reversal of a decision made two
days ago and should be recorded as one.

### 3.2 Deposits, refunds and fees: `msg.value` → `transferFrom`

`deposit(hook, referrer)` is `payable`; it becomes
`deposit(hook, referrer, amount)` plus an ERC-20 pull, with an approval step in
front of it in the UI. `createLaunch`'s `launchFee` and `mintBondingCurve`'s
payment take the same treatment, and the `expectedFee` slippage cap stays as-is.

`_sendNative` becomes a `safeTransfer` in three places (refund, claim payout,
shelf proceeds split). This *removes* one real bug class — the 2,300-gas stipend
problem that `--isolate` caught, where a clone funded by `transfer()` could not
cover a proxy's delegatecall — because ERC-20 transfers carry no stipend.

The reentrancy surface changes and must be re-audited rather than assumed:
the current code can rely on "native transfer to an EOA cannot re-enter", and an
ERC-20 `transfer` to a contract recipient can. BEM itself is a plain 2,205-byte
ERC-20 with no transfer tax, no blacklist, no pause and no permit, per §6 and
re-confirmed today, so it introduces no callback of its own — but the
`nonReentrant` placement was chosen under the old assumption and needs checking
against the new one.

Note the absence of `permit`: deposits will require two transactions (approve,
then deposit) with no single-signature path available.

### 3.3 Vault settlement

`ToshLadderTreasury` and the hook both settle native through
`vault.sync(CurrencyLibrary.NATIVE)` followed by a value-bearing `settle()`.
The ERC-20 path is `sync(BEM)`, then transfer BEM to the Vault, then `settle()`.
The existing comment at `ToshLadderTreasury.sol:637` explaining why `sync` is
called before `settle` — so an outer lock's synced-currency slot cannot
misattribute the payment — applies unchanged and is the reason not to simplify
this while touching it.

### 3.4 The treasury's listing gate

`ToshLadderTreasury.sol:430`'s `if (!key.currency0.isNative())` becomes an
equality check against BEM. With §3.1(b) in place the adjacent
`zeroForOne = true` assumption stays correct; without it, this check is what
stops a mispriced buyback, and it must not be weakened to accommodate both
orderings.

### 3.5 Proof-of-Gas

The band already mixes units deliberately: `floorWei` measures **gas history**
in ETH and `maxAllocWei`/`rate` measure a **deposit**. Only the deposit side
moves, so `floorWei` stays 0.025 ETH and `rate` becomes *BEM of quota per 1 ETH
of gas*.

The problem is that the rate needs a BEM/ETH price, and BEM has one thin pool
and no stable pair. The ×3.5 ETH→BNB calibration worked because BNB has deep,
many-venue pricing; a BEM calibration is anchored to a 73.88-WBNB pool that
moved 24% in two days. `scripts/rotateGasRate.mjs` exists and rotates the band
without a redeploy, so the mechanism is there — but it would need to be
exercised far more often, and `pogBandProblem()`'s coherence check (floor must
not sit above the derived gas cap) should be re-verified at the new rate.

### 3.6 Frontend

49 sites. Beyond the approve-then-deposit flow: every amount display moves to 8
decimals, and `soat-frontend/src/lib/clMath.ts` — the hand-ported slice of
Infinity CL fixed-point maths behind the LP panel — is decimal-sensitive. Its
six pinned vectors are asserted from `test/ToshV5LpMathVectors.t.sol` through
`checkClMath.ts`, so they must be regenerated together or the cross-language
chain described in `PANCAKESWAP_INFINITY.md` §9.3 breaks silently.

### 3.7 Naming

`nativeDeposited`, `totalNativeDeposited`, `lpNative`, `NativeTransferFailed`,
`_sendNative` and the `Launched(totalNative, lpNative, …)` event all become
quote-denominated. There are already two generations of deprecated aliases
(`ethDeposited` from v4.x, `satoDeposited` from the SATO era). A third rename
adds a third, and indexers depend on these. Consider `quoteDeposited` rather
than `bemDeposited`, so a future quote-asset change is not a fourth rename.

---

## 4 · What is lost: the rehearsal

This is the objection that is not an engineering cost and cannot be paid off
with effort.

`PANCAKESWAP_INFINITY.md` §8 records that the entire move to Infinity was
decided on one question — *"Is shipping to BSC mainnet with rehearsals that only
ever ran on an anvil fork an acceptable risk?"* — and the answer taken was no.
Uniswap V4 worked on BSC mainnet and was rejected because it has no testnet `97`
deployment.

**BEM has no code on `97`.** Choosing it as the quote asset reinstates exactly
the condition that was rejected: the deposit, launch, shelf, refund and buyback
paths could not be rehearsed on a real network before mainnet.

That judgement has since been vindicated three times, all in ways an anvil fork
did not surface: settlement paid to the pool manager instead of the `Vault`, the
treasury's lock callback authenticating the wrong caller, and `addLadderToken`
being unable to follow `launch()` because the TWAP needs its full 1,800-second
window. A quote-asset change of the size in §3 is *more* likely to have that
class of bug, not less.

**The fix is cheap and it is a precondition, not a nice-to-have.** The operator
controls BEM, so deploy the same bytecode to `97` as a test BEM, seed a pool,
and the rehearsal capability comes back. Nothing else in this plan should start
until that exists — otherwise the first real-network execution of an 8-decimal
ERC-20 quote asset is the production deploy.

---

## 5 · Risk list

Ordered by how badly each one ends, not by likelihood.

1. **Per-project ordering mispricing.** §3.1. If (b) is not taken, about one
   launch in three gets the token as `currency0` and the tax logic silently
   charges the wrong side. Mitigation: force the ordering at deploy.
2. **No rehearsal.** §4. Mitigation: deploy test BEM on `97` first. Blocking.
3. **Degenerate tier ladder at small raises.** §2.1. Naively converting
   `MIN_SOFT_CAP_PROD` ships a launchpad whose shelf ladder is flat for its
   lower reaches. Mitigation: raise the floor to ≥ 100 BEM and add a test at the
   minimum.
4. **Depositors cannot acquire the quote asset.** §1. A 928-BEM soft cap is 47%
   of the only real pool. This has no code fix: it needs either much deeper BEM
   liquidity or a much smaller soft cap, and a smaller soft cap runs into risk 3.
5. **Everything the protocol holds is denominated in a supply that moved 4.81%
   in two days.** §1. The genesis pool, the treasury reservoir and every
   unclaimed refund. Internal policy rather than counterparty risk now, but
   depositors cannot verify that, and `SECURITY.md` would have to state it
   plainly.
6. **The PoG rate loses its anchor.** §3.5. Quota pricing depends on a 73.88-WBNB
   pool. Mitigation: rotate more often, and accept that quota is approximate.
7. **Mint authority may be frozen, or may not be.** §1. `owner()` through the
   minter proxy is the zero address. Establish which before depending on either
   answer.
8. **Reentrancy assumptions change.** §3.2. Low likelihood given BEM is a plain
   ERC-20, but the existing guard placement was chosen under "native transfers
   cannot re-enter" and needs re-deriving.

---

## 6 · What needs deciding before any code moves

1. **Deploy test BEM on `97`?** Blocking. Without it there is no rehearsal, and
   §4 is the reason this protocol is on Infinity.
2. **Force token ordering above BEM via CREATE2 (§3.1b), or support both
   orderings (§3.1a)?** Strong recommendation for (b).
3. **What is `MIN_SOFT_CAP_PROD` in BEM?** Not convertible. ≥ 21 BEM to keep the
   ladder monotone at all, ≥ 100 BEM for margin. This raises the floor on the
   smallest possible raise by 22×–108× in value.
4. **How is the depth problem in risk 4 addressed?** This is the one with no
   engineering answer.
5. **Is the minter's upgrade authority live or renounced?** §1.

Nothing in this document should be implemented until 1, 2 and 3 are answered.
