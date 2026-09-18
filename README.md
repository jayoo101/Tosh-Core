# Tosh Protocol

**A Phase-1.5 fair-launch protocol built on Proof-of-Gas and a PancakeSwap Infinity hook.**

[![tests](https://github.com/jayoo101/Tosh-Core/actions/workflows/test.yml/badge.svg)](https://github.com/jayoo101/Tosh-Core/actions/workflows/test.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

| | |
|---|---|
| Version | v5.0 |
| Date | 2026-09-18 |
| Network | Migrating to BNB Smart Chain. Rehearsed end to end on testnet `97`; mainnet `56` **not yet deployed** |
| Previously | Robinhood Chain `4663` — retired, see Appendix A |
| Site | [toshx.xyz](https://toshx.xyz) |
| Source | [github.com/jayoo101/Tosh-Core](https://github.com/jayoo101/Tosh-Core) |

**[Development guide](docs/DEVELOPMENT.md)** · **[Security policy](SECURITY.md)**

### On verifiability

This document describes a protocol that is open source and checkable line by line
against `src/` and a read-only RPC. It is not an investment pitch and it is not
marketing copy. Every mechanism, parameter and identity below is tied to a
specific state variable or function signature. Where the code does not implement
something, this document does not claim it.

**Read every "is deployed" and "has been verified" below against the migration.**
This document used to say "deployed on a production chain" without qualification,
which was true of Robinhood Chain `4663` and is true of nothing today. The
protocol is mid-move to BNB Smart Chain: the AMM changed with it, from Uniswap V4
to PancakeSwap Infinity, because BSC has no V4 deployment. Every currency figure
below is BNB, rescaled ×3.5 from its ETH value — except the Proof-of-Gas floor,
which stays in ETH on purpose and says so where it appears.

What that costs in confidence is stated rather than glossed. The 4663 deployment
had verified bytecode on two independent services and a pinned build tag; the BSC
build has neither yet, because it has not been deployed to `56`. §10.1 marks
which claims travelled and which did not.

---

## Abstract

The native use case for a public blockchain is permissionless, censorship-resistant
capital formation. The way tokens actually get issued has polarised into two
failure modes, and neither serves the people funding the project.

**Primary markets — ICOs and private rounds.** The team holds pre-mined supply,
the raise carries no on-chain constraints, and abandonment is routine.

**Secondary markets — pure bonding curves and pump venues.** Allocation goes to
whoever can spin up the most fresh wallets. The curve fills, and only then does
the project "graduate" into a real pool. What happens in between is a zero-sum
race that MEV bots are better equipped to win than the people it is nominally for.

Tosh proposes a third shape, **Phase 1.5** — continuous fundraising in which
primary issuance and a real secondary pool are live at the same time:

$$\text{Phase 1.5} \;=\; \underbrace{\text{Infinity full-range pool}}_{\text{secondary price discovery}} \;\parallel\; \underbrace{4{,}000 \text{ discrete shelves}}_{\text{primary supply, minted on demand}}$$

Four properties follow from that, and each is a consequence of code that exists
or code that is deliberately absent:

**The pool exists before the secondary market does.** A real Infinity pool is
created atomically in the same call that closes genesis. There is no structural
gap between "trading on a curve" and "a pool exists".

**Fairness is priced in historical gas, not identity.** Gas already burned is the
one quantity on an EVM network that cannot be minted, cannot be borrowed with a
flash loan, and cannot be manufactured at zero marginal cost. Tosh sizes genesis
allocation from an address's historical gas spend and clamps it with an on-chain
per-wallet ceiling, which attacks the economics of a sybil farm rather than
trying to detect one.

**Primary issuance is decoupled from the pool but constrained by it.** The
remaining 60% of supply is split into 4,000 discrete price shelves, minted on
demand, and each shelf unlocks only when the secondary market has risen to meet
it. Primary issuance can never undercut the pool.

**The treasury is a one-way valve.** `ToshLadderTreasury` has no withdraw, no
sweep, no rescue and no `delegatecall`. Its only outbound path buys tokens on a
Tosh pool and sends them to `0xdead`.

---

## 1. Failure modes, and what Phase 1.5 changes

### 1.1 What goes wrong today

**Sybil extraction at zero marginal cost.** Whether a launchpad allocates
first-come-first-served or by invitation, a script can generate tens of thousands
of fresh addresses in milliseconds, take the whole allocation, and sell it back
to retail higher up.

**Pre-mined supply.** Many projects mint 100% of supply at launch, which leaves
the team holding a large low-cost or zero-cost position it can sell into the
market at any time.

**Cheap-end curve farming.** Speculators mint in bulk at the cheap end of a
curve, often with borrowed capital, and dump into a thin pool a moment later.

**Genesis participants underwater at open.** Plenty of launchpads set the opening
price with no binding relationship to what depositors paid, which produces the
absurd outcome that the earliest supporters are down on day one.

**Locked liquidity, and no way for anyone else to make markets.** Burning the LP
position to a dead address is common, and it means third-party market makers
cannot provide liquidity and the pool's own trading fees accrue to a position
nobody can ever claim.

### 1.2 The Phase-1.5 model

Tosh puts a primary issuance shelf and a real secondary pool under one state
machine:

**The pool goes first.** Genesis proceeds fund a full-range Infinity position,
which gives the token real two-sided depth from its first block.

**Supply is minted on demand, as it climbs.** Shelf tokens do not exist on chain
until somebody buys them, so no address ever holds 100% of supply. Shelves unlock
on a fixed geometric step as the market rises; 99% of the proceeds go straight to
the project to fund continued work, and 1% goes to the protocol treasury.

**Issuance is bounded by the market in both directions.** A shelf opens only when

$$\text{shelfP0} \times \text{STEP}^i \;\le\; \min(\text{spot},\ \text{TWAP}) \times 1.05$$

so the primary channel cannot sell below the pool and cannot be walked up by a
manufactured price.

---

## 2. Proof-of-Gas

### 2.1 Why historical gas is the honest scarce resource

Every other sybil control in common use fails somewhere specific:

| Control | How it fails |
|---|---|
| Centralised KYC | Invades privacy, and has a mature black market in rented identities |
| Token staking | Becomes a capital privilege that whales dominate by construction |
| First-come-first-served | Becomes a contest between private RPCs and sandwich bots |

The axiom Tosh works from is narrower and harder to game: **a genuinely active
wallet has, at some point, irreversibly paid validators to include its
transactions.** That spend is gone. It cannot be borrowed, refunded, or faked in
bulk.

### 2.2 How the quota is computed and enforced

```
                  ┌───────────────────────────────┐
                  │   participant requests quota  │
                  └───────────────┬───────────────┘
                                  │ signed request
                                  ▼
┌───────────────────────────────────────────────────────────────────┐
│                  historical gas-spend indexer                     │
│      (Ethereum · Arbitrum · Optimism · Base · Robinhood)          │
└─────────────────────────────────┬─────────────────────────────────┘
                                  │
                                  ▼
                      [ gas-floor check ]
                                  │
          ┌───────────────────────┴───────────────────────┐
          │                                               │
   lifetime gas < 0.025 ETH                      lifetime gas ≥ 0.025 ETH
   (band.floorWei)                                        │
          │                                               ▼
          ▼                                     [ size the quota ]
      [ refused ]                     alloc = f(gas spent) × globalGasToSatoRate
                                                          │
                                                          ▼
                                          [ ON-CHAIN per-wallet clamp ]
                                    maxAlloc = min(alloc, maxPogAllocationLimit)
                                                          │
                                                          ▼
                                        [ EIP-191 verification, then deposit ]
```

⚠ **That chain list is current code, and it is one migration behind.** It still
scans Robinhood `4663` and does not scan BSC `56`, so a wallet's BSC gas history
earns it nothing today. The cause is transport, not policy: the scanner reads
Blockscout, and Blockscout does not cover chain 56 at any tier, so BSC needs an
Etherscan v2 key the project does not yet hold. Listed here rather than quietly
corrected because the scan set is a live decision, not a typo.

**1 · The floor (`band.floorWei`, seeded at 0.025 ETH).** The oracle sums the
requesting wallet's real gas spend across major chains. Fresh wallets and
bulk-generated airdrop farms fall below the floor and are refused.

That figure is in ETH, and it is still in ETH now that deposits settle in BNB.
This is deliberate rather than a leftover. The floor is a threshold on gas
already paid to Ethereum, Arbitrum, Optimism and Base, all of which settle in
ETH, and what the settlement chain's own coin is worth has no bearing on how
much gas a wallet has historically burned. Rescaling it along with the
BNB-denominated dials would have raised the eligibility bar by the same factor
while reading as nothing more than a rename. Everything on the *deposit* side of
Proof-of-Gas — the ceiling below, and the quota the rate grants — is BNB, so the
rate is BNB of quota per 1 ETH of gas and carries a currency conversion as well
as a policy choice. `soat-frontend/src/app/lib/pogQuota.ts` states the same
split at the constants, and `docs/BSC_MIGRATION.md` §6 records why it was made.

Worth stating precisely, because it is a trust boundary rather than an invariant:
this floor lives in the off-chain oracle (`soat-frontend/src/app/lib/pogQuota.ts`
seeds it, `pogParams.ts` holds the live value), not in the factory. What the
*contract* enforces is the clamp below.

**2 · The on-chain ceiling (`maxPogAllocationLimit` = 1.75 BNB).** Gas history
establishes that an address is real; it does not buy unlimited allocation. A
wallet that has burned 100 ETH in fees still deposits at most 1.75 BNB in
genesis, because the factory clamps whatever the oracle signed. That ceiling is
what disperses the opening float across hundreds or thousands of organic
addresses instead of a handful of large ones.

At the seeded rate of 1.75 BNB of quota per 1 ETH of historical gas, the ceiling
binds from 1 ETH of lifetime gas upward, and more history past that point buys
nothing. That 1 ETH is where the gate sat before deposits moved to BNB as well:
the ceiling and the rate were rescaled by the same factor, and the gas at which
the rate first reaches the ceiling is their quotient, so it did not move.

**3 · The attacker's cost inverts.** Suppose a farm wants 100 genesis slots:

| | Cost to obtain 100 slots | Allocation unlocked |
|---|---|---|
| Conventional launchpad | ~0, generate 100 keypairs | whatever the cap allows |
| Tosh | 100 × 0.025 ETH = **2.5 ETH** genuinely burned in fees first | 100 × 0.04375 BNB = 4.375 BNB |

The two columns are in different currencies, for the reason given in point 1:
the left is gas already paid on ETH-settled chains and the right is a BNB
deposit allowance, so putting them side by side takes a conversion. The rate was
set against 3.5 BNB to the ETH, at which 4.375 BNB is 1.25 ETH — a wallet
sitting exactly on the floor earns half of what the floor cost it, and a hundred
minimum-viable sybils burn 2.5 ETH of gas to unlock the equivalent of 1.25 ETH
of allocation. Buying the full 1.75 BNB ceiling per wallet costs 1 ETH of real
gas per wallet, and that one figure needs no conversion at all: the cap is the
ceiling divided by the rate, and dividing BNB by BNB-per-ETH lands back in ETH.

Read the 2:1 as a design margin rather than as arithmetic. It was arithmetic
while both sides were ETH — a fixed property of two constants, true at any
price. Now it is a ratio between two currencies and it moves with theirs: at
3.3624 BNB to the ETH, spot on the day the conversion factor was chosen, the
same hundred sybils burn 2.5 ETH to unlock about 1.30 ETH of allowance, so the
margin is nearer 1.9:1 than 2:1, and it narrows further if BNB appreciates
against ETH. The rate is the dial that restores it and it rotates without a
redeploy, which makes this a number to keep watching rather than a redeployment.

Either way the fees are spent before any position is taken and cannot be
recovered by selling, which removes the profit from the sybil model rather than
policing it.

**All three off-chain dials are owner-tunable** through the owner-signed
`POST /api/admin/config` (see `scripts/rotateGasRate.mjs`): the floor, the rate,
and the ceiling the oracle signs against. The ceiling cannot be raised above the
live on-chain `maxPogAllocationLimit` — the endpoint refuses that, because an
attestation over the factory dial reverts `registerPoG` for everybody.

**4 · Replay protection.** The attestation is EIP-191 over a six-field tuple:

$$\text{digest} = \text{keccak256}\big(\text{abi.encode}(\text{sender},\ \text{maxAlloc},\ \text{nonce},\ \text{deadline},\ \text{factory},\ \text{chainId})\big)$$

Because the factory hashes with its own `address(this)` and `block.chainid`, a
signature naming another factory or another chain cannot be recovered at this
one. The signing route reads the live on-chain nonce and ignores any the caller
supplies.

---

## 3. Architecture

Two platform singletons per chain. Each project gets a CREATE2-derived pair of
EIP-1167 minimal clones.

**The addresses in this diagram are BNB Smart Chain testnet `97`**, the standing
deployment. Mainnet `56` has no protocol addresses yet — see Appendix A.3 — so
there is nothing else these could be. They are shown because a diagram of
abstract boxes is harder to check than one you can paste into an explorer, not
because they are production.

```
ToshFactory (0xB224f26a…) ──────────► ToshLadderTreasury (0x79de2226…)
   ├─ createLaunch / PoG verification      ├─ revenue in: launch fee, shelf cut,
   ├─ genesis deposit gateway              │  buy-side tax, orphaned commission
   │  and two-tier referral ledger         └─ only way out ──► 0xdead (buy & burn)
   └─ cooldown / blacklist / pause
          │
          │ CREATE2 (EIP-1167 minimal clone, 131 bytes)
          ▼
ToshLaunchpadHook (one per project) ──► Infinity CLPoolManager (0x36A12c70…)
   ├─ Phase 1: deposit / refund / launch    │  runs the pool: full-range BNB ⇄ token
   ├─ Phase 2: 4,000 shelves / genesis      └─► Infinity Vault (0x2CdB3EC8…)
   │  claims                                      holds every balance; settlement
   └─ ICLHooks: beforeSwap / afterSwap             is paid HERE, not to the manager
          │
          │ mint()  [exclusive MINTER_ROLE]
          ▼
ToshToken (one per project)
   ├─ hard cap: 21,000,000
   └─ DEFAULT_ADMIN_ROLE is never granted to anyone
```

| Contract | Instances | Responsibility |
|---|---|---|
| `ToshFactory` | one per chain | `createLaunch`, `registerPoG`, deposit routing, the project and lifetime referral graph, and the global safety controls |
| `ToshLadderTreasury` | one per chain | One-way valve. Collects four revenue streams, buys on the project's own pool, and burns to `0xdead` |
| `ToshLaunchpadHook` | one per project | The whole per-project lifecycle state machine, and the Infinity `ICLHooks` callbacks |
| `ToshToken` | one per project | Standard ERC-20, hard cap 21,000,000, mint authority exclusive to its hook, no admin backdoor |

---

## 4. Lifecycle

### 4.1 Phase 1 · Genesis

The creator pays the launch fee and picks a fundraising window:

| Option | Duration |
|---|---|
| `DURATION_FAST` | 3 hours |
| `DURATION_STANDARD` | 24 hours |
| `DURATION_SLOW` | 72 hours |

The soft cap is written into the hook from the factory's `defaultSoftCap` at
creation time and cannot go below the production floor
`MIN_SOFT_CAP_PROD` = 0.035 BNB.

**Two refund guarantees, both at 100% of principal with no penalty:**

The genesis window always runs to its deadline. At that point the creator may
call `launch()` with whatever was raised — the soft cap is a progress target,
not a fail condition. The empty raise (`totalNativeDeposited == 0`) cannot seed a
pool and is the only size `launch()` still rejects.

Refunds open when nobody called `launch()` within the `LAUNCH_WINDOW` of 7 days
that follows the deadline. Use the `canRefund()` view rather than re-deriving
the condition.

### 4.2 Phase 2 · The pool and the shelves

Once genesis has closed and the 7-day window has not lapsed, the creator calls
`launch()`. That call does the following in a strict atomic order:

**Reserve the commission.** 10% of the raise is carved off for referrals whether
or not anyone was referred, leaving `lpNative` to seed the pool.

**Fix the anchors.** The opening price is $p_0 = \text{lpNative} / \text{GENESIS\_LP\_SUPPLY}$,
and the shelf ladder starts one notch above it at $\text{shelfP0} = p_0 \times 1.05$.

**Mint the genesis block** — `GENESIS_SUPPLY`, 8,400,000 tokens:

- **45% (3,780,000)** goes straight into a full-range Infinity position: tick
  range ±887,200, fee 0.30% (`POOL_FEE` = 3000), `TICK_SPACING` = 200.
- **55% (4,620,000)** stays in the hook for genesis depositors to withdraw pro
  rata via `claimGenesis()`.

**Arm the same-block lock.** `lastSwapBlock = block.number` is recorded, which
shuts shelf purchases for the launch block itself.

**Sweep orphaned commission.** Any referral share that never bound is moved to
the treasury as buyback fuel.

#### The 4,000-shelf ladder

The ladder is not an approximation of a continuous curve. It is 4,000 discrete
price levels evaluated in closed form by fast exponentiation, so there is no
accumulated truncation drift across the range.

| Constant | Value | Meaning |
|---|---|---|
| `TIER_COUNT` | 4,000 | number of shelves |
| `TIER_SIZE` | 3,150 tokens | fixed allocation per shelf |
| `BONDING_MAX` | 12,600,000 | 4,000 × 3,150 — exactly 60% of supply |
| `TIER_STEP_E18` | 1.001902508266805824 | +0.19025% per shelf |
| ladder span | 2,000× | first shelf to last |
| `MAX_TIERS_PER_TX` | 32 | shelves one call may sweep |

Shelf $i$ is purchasable only while

$$\text{shelfP0} \times \text{STEP}^i \;\le\; \min(\text{spot},\ \text{TWAP}) \times 1.05$$

Note that `SHELF_PREMIUM_BPS` and `PRICE_CEILING_BPS` are both `10500`
deliberately: the two 1.05 factors cancel, so the condition carries no magic
number. Of the proceeds, 99% goes to `projectAdmin` and 1%
(`PLATFORM_TAX_BPS`) to the treasury. Shelf tokens are minted at purchase.

### 4.3 Phase 3 · The deflation engine

Once the treasury's native balance reaches `TRIGGER_STEP` = 3.5 BNB, any
`afterSwap` on a Tosh pool will attempt a **piggyback buyback**:

- **Size.** $\max(3.5\text{ BNB},\ 10\%$ of balance$)$ — `SPEND_BPS` = 1000.
- **Rotation.** `BATCH_SIZE` = 3 spreads the spend across pools, advancing
  `LEGS_PER_POKE` = 1 per poke in round-robin order.
- **Slippage bound.** `MAX_BUYBACK_SQRT_DEVIATION_BPS` = 1000, anchored to the
  pool's own TWAP. The name is not decoration: the bound is stated in **sqrt**
  terms, so 1000 bps lets the sqrt price fall to 90% of the TWAP's, and price
  goes as the square — $0.9^2 = 0.81$, so it is roughly a **19% band in price**,
  not 10%. Both this and `SPEND_BPS` above happen to be 1000, and they do not
  mean the same thing. The looseness is deliberate; `src/ToshLadderTreasury.sol`
  argues the trade at the constant.
- **Gas defence, and the backstop it needs.** If the transaction has less than
  `PIGGYBACK_MIN_GAS` = 270,000 left, the protocol skips the buyback so the
  user's own trade always completes. Because skipping means trading alone no
  longer guarantees the reservoir drains, anyone may call the permissionless
  `pokeBuyback()` to advance it. That call moves no BNB to the caller and
  chooses nothing but the timing.

---

## 5. Token economics

### 5.1 Supply

| Tier | Constant | Tokens | Of hard cap | Destination |
|---|---|---|---|---|
| Hard cap | `MAX_SUPPLY` | 21,000,000 | 100% | absolute lifetime ceiling |
| Genesis | `GENESIS_SUPPLY` | 8,400,000 | 40% | minted to the hook by `launch()` |
| ├ depositor claims | `GENESIS_CLAIM_SUPPLY` | 4,620,000 | 22% | claimed pro rata (55% of genesis) |
| └ pool liquidity | `GENESIS_LP_SUPPLY` | 3,780,000 | 18% | permanent full-range position (45% of genesis) |
| Shelf ladder | `BONDING_MAX` | 12,600,000 | 60% | minted on demand in Phase 2 |

$$8{,}400{,}000 + 12{,}600{,}000 = 21{,}000{,}000$$

A fully sold ladder lands exactly on the cap rather than approaching it.
`DEFAULT_ADMIN_ROLE` is never granted to anyone, and the hook is the only holder
of `MINTER_ROLE`.

### 5.2 Where the 10% opening premium comes from

Let $R$ be the total BNB raised in genesis. The protocol always carves off 10%
for referrals, whether or not anyone was referred, so the pool is seeded with
$0.9R$.

Depositors' average cost basis:

$$P_{\text{raise}} = \frac{R}{\text{GENESIS\_CLAIM\_SUPPLY}} = \frac{R}{4{,}620{,}000}$$

The pool's opening price:

$$p_0 = \frac{\text{lpNative}}{\text{GENESIS\_LP\_SUPPLY}} = \frac{0.9R}{3{,}780{,}000}$$

The ratio:

$$\frac{p_0}{P_{\text{raise}}} = \frac{0.9R / 3{,}780{,}000}{R / 4{,}620{,}000} = 0.9 \times \frac{4{,}620{,}000}{3{,}780{,}000} = 0.9 \times \frac{11}{9} = 1.10$$

$R$ cancels. The 10% premium is not a target price anyone chose — it is an
algebraic consequence of the 55/45 split and the 10% referral carve, and it holds
at any raise size. Shelf 0 sits a further 5% above the pool, so the primary
channel opens at $1.10 \times 1.05 = 1.155$ against depositor cost, which is what
guarantees primary issuance never undercuts the people who funded it.

Because it is a ratio rather than a pair of magnitudes, resizing the genesis block
leaves the premium at exactly 1.10. Moving the split or the referral rate moves
it, and a test pins the identity so it cannot be changed silently.

### 5.3 What the 40/60 split does to early sell pressure

Equal-size shelves release $\log(R) / \log(\text{span})$ of the ladder by the time
the market trades at $R\times$ the ladder base, so the release curve depends on
the span, not on the ladder's absolute size. At 2×:

| Configuration | Released at 2× | Of genesis supply | Of the tradeable float (4.62M) |
|---|---|---|---|
| earlier design — 20/80 + 2000× | 1,533,000 | 36.5% | 33.2% |
| **current — 40/60 + 2000×** | **1,149,750** | **13.7%** | **24.9%** |

Both denominators are given because they answer different questions. The 13.7%
column includes the 3.78M sealed in the genesis LP position — supply that exists
and never trades — so it is the right basis for comparing configurations against
each other, and the wrong basis for asking what the market must absorb. Against
the float that actually trades, a doubling still asks the market to take on about
a quarter of the live supply.

---

## 6. Fees

| Fee | Rate | Where it goes |
|---|---|---|
| Infinity pool fee | 0.30% | liquidity providers, settled natively by the AMM |
| Swap tax — buy | 1.00% of BNB in | 70 bps → treasury (buy & burn); 30 bps → `platformTreasury` |
| Swap tax — sell | 1.00% of tokens in | all 100 bps burned to `0xdead`; the platform takes nothing |
| Shelf purchase | 1.00% | treasury as buyback fuel; the other 99% to `projectAdmin` |
| Launch fee | currently 0.35 BNB | treasury in full |
| Orphaned commission | the 10% carve, when unbound | treasury at `launch()` |

**Total trader friction is 1.30%** — 0.30% to LPs, 0.70% to buy-and-burn, 0.30%
to the platform.

**Disclosure.** The 30 bps on the buy side (`PLATFORM_SWAP_FEE_BPS`) settles to
`platformTreasury` as operating revenue and does **not** enter the burn loop. It
applies to the buy leg only, because a sell's input is the project's own token
and paying the platform in kind would leave it holding illiquid positions in
tokens it is meant to be neutral about. `platformTreasury` is an `immutable`
constructor argument with no setter, so redirecting it requires deploying a new
factory.

---

## 7. Referrals

The 10% carved off at deposit (`REFERRAL_BPS` = 1000) splits into two independent
slots. The split is expressed as a share of the carve rather than of the deposit,
which is what lets it be retuned without touching `REFERRAL_BPS` — and therefore
without moving the opening premium.

| Slot | Share of the carve | Of the deposit | Binding |
|---|---|---|---|
| Project referrer | 80% (`PROJECT_REFERRAL_SHARE_BPS`) | 8% | written on a wallet's first deposit to that project, permanent for it |
| Lifetime referrer | the remaining 20% | 2% | written on a wallet's first binding anywhere, permanent platform-wide |

**A referrer has to qualify, and the two slots ask for different things.** Both
require the referrer to hold a registered PoG quota, so farming links costs an
attestation per throwaway wallet — a cost the oracle can price or refuse, which
is a cost rather than a wall and is documented as such. The project slot asks for
one thing more: a live deposit in that same project, read from state before the
new depositor's own BNB arrives. `canBindProjectReferral` is the read-only mirror
of that gate, so the UI does not have to reproduce it in TypeScript.

Self-referral is ignored, and so is a stale link — silently, because this runs
inside `deposit` and reverting would cost a depositor their transaction over
somebody else's referral problem. **A failed binding is not sticky:** the slot
stays empty, so the same wallet's next deposit into the same project tries again
and binds if the referrer has qualified since.

**Orphaned commission is captured, not kept.** Any share that never binds moves
to the treasury at `launch()` as public buyback reserve.

**Commission unlocks only on success.** It accrues at deposit and becomes
claimable through `claimReferralReward()` once the project reaches Phase 2. If
genesis fails, the reserve returns to depositors through the refund path and no
commission is ever paid.

---

## 8. Asset security

### 8.1 The one-way valve

`ToshLadderTreasury` accumulates value and terminates it.

- **In:** launch fees, orphaned commission, the 1% shelf cut, the 70 bps buy-side
  tax.
- **Out:** the internal `_buyAndBurn` only. It buys the token through Infinity
  and sends it to `0xdead`.
- **Absent by design:** `withdraw`, `sweep`, `rescue`, `delegatecall`. The owner
  can curate which tokens are in the buyback rotation. The owner cannot move one
  wei out.

`addLadderToken` also derives the buyback venue from the token's own hook and
refuses tokens this platform did not launch. Without that, an owner could list a
token they minted, pair it in a pool only they provide liquidity to, and drain the
reservoir one trigger at a time.

### 8.2 Genesis liquidity is locked; retail LPs are not

Infinity keys every position to the address that created it, exactly as Uniswap
V4 did. The genesis
position belongs to the hook, and the hook exposes no path that calls
`modifyLiquidity` to reduce it. The lock is a consequence of ownership plus
absence, not of a callback that could be edited later.

Third-party LPs use their own separate positions, come and go freely, and earn
the pool's 0.30% fee on their own terms.

---

## 9. Governance

Ownership on BNB Smart Chain is the Gnosis Safe
`0x02DE4629129D104C63329D13A6Ca67E43db7B310`, a 2-of-3 threshold created
2026-09-18. It does not own anything yet: `56` is undeployed, and the mainnet
deploy script transfers the factory and the treasury to it in the same broadcast
that creates them. On the standing `97` testnet both contracts are owned by a
single EOA whose key is public — the table below describes the design, not the
testnet's current security. (The earlier 2-of-3,
`0x2953957774482efA660921df85A1E7634ccfe27A`, was on chain 4663 and did not
travel; a Safe is a contract at an address, so the same owners on a new chain are
a new Safe.)

Both the factory and the treasury use OpenZeppelin's `Ownable2Step`, so a
transfer requires the recipient to call `acceptOwnership()`.

| The owner can | The owner cannot |
|---|---|
| Adjust the launch fee (ceiling `MAX_LAUNCH_FEE` = 35 BNB, zero permitted) | Withdraw treasury funds, or anything held for depositors, referrers or LPs |
| Adjust the default soft cap (floor `MIN_SOFT_CAP_PROD` = 0.035 BNB) | Change `platformTreasury`, which is `immutable` |
| Adjust the PoG ceiling and cooldown (`MAX_COOLDOWN` = 7 days) | Remove any token or BNB from the genesis liquidity position |
| Pause `createLaunch` and `registerPoG`, or blacklist an address | Use the ladder halt to withhold refunds, genesis claims or commission |
| Curate the treasury's buyback roster | Grant mint authority to any third party |
| Halt shelf minting per project or globally (`MAX_HALT_DURATION` = 7 days, auto-expiring) | Alter the immutable parameters of a deployed hook |

`pause()` does not close a genesis round that is already open — a raise already
taking money keeps taking it, because the designed failure is a raise that never
calls `launch()` inside its window, and gating deposits would hand the owner a
unilateral veto over a project it already accepted money for. A shelf halt can
make a buyer miss a price. It cannot cost anyone a balance already on the books.

Note what the designed failure is *not*: missing the soft cap. `canRefund()`
reads `block.timestamp > genesisDeadline + LAUNCH_WINDOW` and nothing else, and
no `require` or `revert` anywhere in the contracts compares a raise against
`softCap()` — it is a snapshot taken at clone time and exposed for display, per
§4.1. An earlier version of this paragraph said the soft cap was the designed
failure, which contradicted §4.1 and §10.1 on the same page and would have told
a depositor to expect a refund on a ground that does not exist.

This is governance, not the absence of governance. The boundaries are real and so
are the powers.

---

## 10. Security posture

### 10.1 What has been verified

⚠ **Two of the four items below describe the RETIRED 4663 deployment and have no
BSC equivalent yet.** They are kept, marked, rather than deleted, because losing
them is part of the migration's cost and a reader deciding whether to trust this
build should see the gap rather than an unqualified list.

- **Bytecode — 4663 only.** All five contracts verified on Blockscout as `partial
  match` and independently on Sourcify as `match`. Nothing on BSC is verified: `56`
  has no deployment, and verification there is Etherscan v2 rather than Blockscout,
  which needs an API key the project does not yet hold.
- **Build provenance — 4663 only.** That deployment was pinned to tag
  `deploy-4663-2026-09-12`. `HOOK_CREATION_CODEHASH` is still cross-checked against
  this tree by `RecomputeInitcodeHash`, which is checkable from chain and from this
  repository without trusting anyone — but there is no BSC tag to pin to yet.
- **Tests — current.** 389 passing of 393 across 16 suites, covering the lifecycle state
  machine, the premium identity, the same-block lock, retail LP isolation from the
  genesis position, and that a ladder halt cannot withhold refunds. CI runs the
  suite twice — once normally and once under `--isolate`, which charges each call
  the way a real transaction does. The port to Infinity is inside this count, and
  it found two real bugs: settlement was being paid to the pool manager rather
  than the Vault, and the treasury's callback still authenticated the manager.
  A further four tests report as skipped: they check a `56` deployment and stay
  dormant until there is one.
- **Live-chain rehearsal — current, complete on `97`.** The whole lifecycle has
  been driven against the real PancakeSwap Infinity deployment on testnet `97`,
  not only against a fork — genesis, launch, the ladder listing, a buy, and a
  ladder mint, each as its own transaction. It earned its place by finding what
  the forks could not. Listing a token on the ladder turned out to be impossible
  in the same transaction as the launch, because `addLadderToken` reads a TWAP
  that `launch()` has just zeroed; it is now a phase of its own, run a
  `TWAP_WINDOW` later. The launch itself went through under the soft cap, which
  is the intended behaviour rather than a fault — the soft cap is a progress
  target, not a fail condition (§4.1). And both value-moving calls charged what
  they had quoted, to the wei: a 0.002 BNB buy and a 945-token ladder mint.
- **Static analysis, pinned.** `forge lint` and Slither both run in CI against
  committed baselines, so a finding cannot start or stop firing without somebody
  deciding about it. There has been no third-party audit; see below.

### 10.2 Limits and disclosures

1. **Short operating history.** The mechanisms are in place; they have not been
   run through a long adversarial period. Read any "therefore X will happen" here
   as a design claim, not as a historical statistic.
2. **No third-party audit.** None has been performed. What stood in for one on
   `4663` was reproducibility — independent verification on two services and a
   pinned build tag — and the BSC build has neither yet (§10.1). Until it does,
   what is left is the public test suite and audit log, which are weaker than
   what this line used to claim.
3. **Early shelf release.** Around 2×, the ladder releases roughly 24.9% of the
   live float — see §5.3. Depth has to absorb it. Span and split are parameters,
   not constants.
4. **Piggyback buybacks are not guaranteed to be immediate.** Under gas pressure
   a trade will skip the buyback to protect the user's own transaction, and the
   reservoir accumulates until someone calls `pokeBuyback()`. That call is
   permissionless, and `STATE-06` in `monitoring/alerts.json` polls for the
   armed-but-silent state.
5. **The platform takes 30 bps on the buy side.** It is operating revenue and it
   is the one fee not committed to burn — see §6. The recipient is immutable with
   no setter.
6. **PoG depends on off-chain infrastructure.** Eligibility relies on gas-history
   indexing and Blockscout API quota. Exhausting the window temporarily refuses
   *new* registrations; quotas already issued, deposits already made, and the
   refund path are unaffected.
7. **Single-chain deployment.** Liveness and finality are inherited from BNB Smart
   Chain and its validator set. This used to read "Robinhood Chain and its
   Arbitrum Orbit sequencer", and the difference is not only the name: BSC has no
   `ArbSys` precompile, so the hook reads `block.number` directly instead of
   asking for an L2 block height. The same-block lock therefore depends on one
   clock rather than reconciling two.
8. **Governance is a multisig, not a burned key.** The powers in §9 are real. What
   they exclude is any path that moves user funds.

---

## Appendix A · Deployments

### A.1 Robinhood Chain `4663` — RETIRED

⚠ **This is no longer the platform, and nothing should be wired to it.** Tag
`deploy-4663-2026-09-12`, block 61056709.

These are Uniswap V4 hooks, and their factory mined CREATE2 salts against the
`0x20CC` address mask — a mechanism that does not exist in the current tree, since
Infinity reads permissions from `getHooksRegistrationBitmap()` instead. The
addresses are kept recoverable, not operational.

| Component | Address |
|---|---|
| `ToshFactory` | [`0x2920ca7E9fcD85491D699e1f9Ae2CAa65Cfb2892`](https://explorer.mainnet.chain.robinhood.com/address/0x2920ca7E9fcD85491D699e1f9Ae2CAa65Cfb2892) |
| `ToshLadderTreasury` | [`0x255722226720914eF5B2CD54647f21f584BD4Ea2`](https://explorer.mainnet.chain.robinhood.com/address/0x255722226720914eF5B2CD54647f21f584BD4Ea2) |
| Governance Safe (2-of-3) | [`0x2953957774482efA660921df85A1E7634ccfe27A`](https://explorer.mainnet.chain.robinhood.com/address/0x2953957774482efA660921df85A1E7634ccfe27A) |
| Uniswap v4 PoolManager | `0x8366a39CC670B4001A1121B8F6A443A643e40951` |

That last row is a Uniswap V4 manager, and it is the reason this appendix cannot
be read as a template for the BSC one: the current tree talks to an Infinity
`CLPoolManager` and a separate `Vault`, and no address here has a counterpart
there.

`LaunchCreated` has topic0
`0x857f6038583a34516f405db6cc1a1112e32e20ddd3d9a5297662fbc7f730d3fc`, over the
signature `LaunchCreated(uint256,address,address,address,string,string)`.

The earlier pair — factory `0xBa9d2E86281b988225Eca383C375215912fb20B9`, treasury
`0x99aD248dD15498957B864Fd79917F0E103Aa78F7` — is retired and is no longer the
platform. It still exists and still holds a small buyback reservoir with no
withdraw path.

### A.2 BNB Smart Chain testnet `97` — rehearsed end to end

| Component | Address |
|---|---|
| `ToshFactory` | `0xB224f26a323320376c0b4C6a3228533FA63E5bBd` |
| `ToshLadderTreasury` | `0x79de222644E8BBeea6FC55815CCBE9FF136D7674` |
| Infinity `CLPoolManager` | `0x36A12c70c9Cf64f24E89ee132BF93Df2DCD199d4` |
| Infinity `Vault` | `0x2CdB3EC82EE13d341Dc6E73637BE0Eab79cb79dD` |

Two addresses, not one, because Infinity splits what V4's PoolManager did alone:
the manager runs the pool and the Vault holds every balance. That split is the
source of both bugs the port surfaced — see §10.1.

The rehearsal project itself is `RHRSL`, and it is checkable:

| Component | Address |
|---|---|
| `ToshLaunchpadHook` | `0x46e8ADDa65b8acE41B2818A4cf0B1249c03E393f` |
| `ToshToken` (`RHRSL`) | `0xb3b9443a717138aFB542156D27279726BAFf5A63` |

Its supply reads 8,400,945 rather than the round `GENESIS_SUPPLY` of 8,400,000,
and the difference is the point: 945 tokens are what the ladder minted in the
last phase, so the total is itself evidence the buyback leg ran on a live chain.

⚠ An earlier factory at `0xe94F79A0c44b124b5987Afe55Add16EF0c80FFb2` is abandoned.
Its immutable `platformTreasury` is Anvil's account #1, whose private key ships
with Foundry: a leftover shell variable shadowed `.env`, and Foundry lets the
process environment win. Both deploy scripts now refuse the default test accounts
outright. Recorded because the address is live, looks ordinary, and would pass
every invariant check the repository has.

⚠ **Treat this whole deployment as compromised.** All three privileged roles on
the factory above — `owner`, `pogSigner` and `platformTreasury` — are the single
address `0x73db078fa94607893270079AC8F5c7492aB480cd`, and its private key was
committed to this repository in a set of driver scripts and pushed. The scripts
are deleted, which stops the bleeding but does not undo the disclosure: anyone
who cloned the repository can sign as any of the three. `platformTreasury` is
`immutable`, so `97` cannot be repaired by rotating a key — only by redeploying.
It is testnet, holding no value, and it is left standing on purpose so the
addresses in this appendix keep resolving. Nothing here travels to `56`; see A.3.

### A.3 BNB Smart Chain mainnet `56` — not deployed

No protocol addresses yet, deliberately. One governance address does exist:

| Component | Address |
|---|---|
| Governance Safe (2-of-3, SafeL2 1.4.1) | [`0x02DE4629129D104C63329D13A6Ca67E43db7B310`](https://bscscan.com/address/0x02DE4629129D104C63329D13A6Ca67E43db7B310) |

Created 2026-09-18 in tx
[`0x41c2429e…939b0`](https://bscscan.com/tx/0x41c2429ebc462aefa9ed3cc62a2d4f43b8f7e12aaae921a278c7c3e53ef939b0),
305,871 gas. **It owns nothing.** It exists ahead of the deploy because
`script/DeployMainnet.s.sol` reads it as `PROD_OWNER_SAFE` with no default and
cannot run without it, so creating it early takes it off the critical path
instead of parking it behind the audit. Each of the three owners signed a
message naming the chain and the threshold, and each signature was checked to
recover to the address that claimed it — an owner nobody can sign for is
indistinguishable from a working one until the first time you need two
signatures inside a minute. By the standing decision the same address is also
`PLATFORM_TREASURY`, which is why it was additionally checked to accept a plain
BNB transfer.

Splitting the deployer key three ways — owner, PoG signer, platform treasury —
was already the plan, because one address holding all three means one compromise
ends the protocol and `platformTreasury` cannot be rotated afterwards. The
disclosure described in A.2 turns that plan into a precondition: the `97` key is
public, so `56` has to be deployed from freshly generated keys that have never
appeared in this repository, and the mainnet address must not be `0x73db…80cd`.
That address has still never transacted on `56`. A fresh deployer key now exists
and paid for the Safe above.

The PoG signer is **not** rotated, deliberately and for now: it still names
`0x73db…80cd`, whose key is public. On `97` that costs nothing already lost —
the same key owns both contracts there — but `registerPoG` verifies signatures
against `pogSigner`, so on `56` a public signing key means anyone can mint PoG
allocations from the first block. It is the one remaining key-shaped
precondition for mainnet, and it is a hard one.

---

## Appendix B · Constants

| Constant | Value | Where | Meaning |
|---|---|---|---|
| `MAX_SUPPLY` | 21,000,000 | `ToshToken` | absolute per-project ceiling |
| `GENESIS_SUPPLY` | 8,400,000 | `ToshLaunchpadHook` | minted at `launch()` — 40% of cap |
| `GENESIS_CLAIM_SUPPLY` | 4,620,000 | `ToshLaunchpadHook` | depositor claims — 55% of genesis |
| `GENESIS_LP_SUPPLY` | 3,780,000 | `ToshLaunchpadHook` | full-range pool seed — 45% of genesis |
| `TIER_COUNT` | 4,000 | `ToshLaunchpadHook` | shelves in the ladder |
| `TIER_SIZE` | 3,150 | `ToshLaunchpadHook` | tokens per shelf |
| `BONDING_MAX` | 12,600,000 | `ToshLaunchpadHook` | ladder total — 60% of cap |
| `TIER_STEP_E18` | 1.001902508266805824 | `ToshLaunchpadHook` | price step per shelf |
| `REFERRAL_BPS` | 1000 | `ToshLaunchpadHook` | total referral carve — 10% |
| `PROJECT_REFERRAL_SHARE_BPS` | 8000 | `ToshLaunchpadHook` | project referrer's share of the carve — 80% |
| `TAX_BPS` | 100 | `ToshLaunchpadHook` | swap tax — 1.00% |
| `PLATFORM_SWAP_FEE_BPS` | 30 | `ToshLaunchpadHook` | platform's share of the buy-side tax |
| `PLATFORM_TAX_BPS` | 100 | `ToshLaunchpadHook` | treasury's share of shelf proceeds — 1.00% |
| `POOL_FEE` | 3000 | `ToshLaunchpadHook` | Infinity CL pool fee — 0.30% |
| `TICK_SPACING` | 200 | `ToshLaunchpadHook` | pool tick spacing |
| `SHELF_PREMIUM_BPS` | 10500 | `ToshLaunchpadHook` | shelf base premium — 105% |
| `PRICE_CEILING_BPS` | 10500 | `ToshLaunchpadHook` | shelf unlock ceiling — 105% |
| `TWAP_WINDOW` | 1800 s | `ToshLaunchpadHook` | oracle window, and its manipulation depth |
| `LAUNCH_WINDOW` | 7 days | `ToshLaunchpadHook` | window to call `launch()` before refunds open |
| `MAX_TIERS_PER_TX` | 32 | `ToshLaunchpadHook` | shelves one call may sweep |
| `PIGGYBACK_MIN_GAS` | 270,000 | `ToshLaunchpadHook` | gas floor below which a buyback is skipped |
| `MIN_SOFT_CAP_PROD` | 0.035 BNB | `ToshFactory` | production floor for the default soft cap |
| `MAX_LAUNCH_FEE` | 35 BNB | `ToshFactory` | ceiling on the launch fee |
| `MAX_COOLDOWN` | 7 days | `ToshFactory` | ceiling on the deposit cooldown |
| `MAX_HALT_DURATION` | 7 days | `ToshFactory` | longest single shelf halt |
| `TRIGGER_STEP` | 3.5 BNB | `ToshLadderTreasury` | balance that arms a buyback |
| `SPEND_BPS` | 1000 | `ToshLadderTreasury` | share of balance spent per cycle — 10% |
| `BATCH_SIZE` | 3 | `ToshLadderTreasury` | pools a cycle is spread across |
| `LEGS_PER_POKE` | 1 | `ToshLadderTreasury` | legs advanced per poke |
| `MAX_BUYBACK_SQRT_DEVIATION_BPS` | 1000 | `ToshLadderTreasury` | buyback slippage band against TWAP |
| `DEFAULT_POG_GAS_FLOOR_WEI` | 0.025 ETH | off-chain oracle (`pogQuota.ts` seed) | lifetime gas required to qualify — ETH, not BNB, and see below |
| `DEFAULT_GAS_TO_ALLOC_RATE` | 1.75 | off-chain oracle (`pogQuota.ts` seed) | BNB of quota granted per 1 ETH of historical gas |
| `DEFAULT_POG_MAX_ALLOC_WEI` | 1.75 BNB | off-chain oracle (`pogQuota.ts` seed) | ceiling the oracle signs against |
| `maxPogAllocationLimit` | 1.75 BNB | `ToshFactory` | **on-chain** per-wallet genesis clamp |

The last four rows are the trust boundary worth reading carefully: the floor,
rate, and off-chain ceiling are owner-tunable policy the oracle applies — the
three values above are seeds, and the live band lives in `pogParams.ts` — while
the per-wallet clamp is enforced by the contract regardless of what the oracle
signed. Keep the on-chain dial at or above the off-chain ceiling; the admin
endpoint enforces that direction.

They are also not all in one currency, which is the other thing to read
carefully. The floor is ETH because it measures gas spent on ETH-settled chains;
the two ceilings are BNB because they bound a deposit; and the rate is the term
that crosses between them, so it is neither dimensionless nor a typo. §2.2
argues the split. The rate constant was called `DEFAULT_GAS_TO_ETH_RATE` while
both sides were ETH, and that name is kept as a deprecated alias so existing
callers still resolve.

---

## Documentation

| Document | What it covers |
|---|---|
| [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) | Build, test, deploy, environment, CREATE2 salts, guards, troubleshooting |
| [`SECURITY.md`](SECURITY.md) | Reporting channel, scope, and verification anchors |

If this document and the source disagree, the source wins.

---

## License

MIT — see [LICENSE](LICENSE) and the SPDX headers in each source file.
