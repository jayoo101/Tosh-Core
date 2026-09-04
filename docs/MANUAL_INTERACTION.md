# Tosh Protocol — Manual Interaction Guide

**Version:** v5.0
**Audience:** Users and power users operating **without** the Tosh frontend
**Companion documents:** `docs/INCIDENT_RESPONSE.md` (§6b links here),
`docs/SECURITY_AUDIT.md`

> **Why this exists.** The Tosh contracts do not depend on the Tosh website.
> If the frontend is down, geoblocked, or you simply do not trust it, every
> user action below is reachable directly from the chain with `cast`.
>
> **The one that matters: `refund()` needs nothing from us.** No signature, no
> API, no website. If a genesis round fails, your ETH is retrievable with a
> single transaction for as long as the chain exists. That property is the
> whole point of this document.

> ⚠️ **Owner and incident procedures are NOT here.** `pause`, `setBlacklist`,
> `setPogSigner`, `haltLadderMinting` and the rest live in
> `docs/INCIDENT_RESPONSE.md`. This file is user-side only.

---

## 0. Setup

Install Foundry (`foundryup`), then set your environment. Every command below
assumes these are exported.

```bash
export RPC=https://<your-rpc-endpoint>
export FACTORY=0x<factory-address>       # see below
export HOOK=0x<project-hook-address>     # the project you care about
export TOKEN=0x<project-token-address>
export ME=0x<your-wallet-address>
```

**Where to get the factory address without trusting the site:** it is pinned
in the repo at `soat-frontend/src/app/lib/factoryDeployments.ts`, and it is the
`to` address of every `LaunchCreated` event on the explorer. Cross-check both.

### Reads vs writes

Everything in §1 is a `cast call` — free, read-only, no key needed. Writes in
§2 onward need a signer. Prefer a hardware wallet:

```bash
# Ledger
--ledger --mnemonic-derivation-path "m/44'/60'/0'/0/0"

# Keystore file (never paste a raw private key into a shell)
--keystore ~/.foundry/keystores/<name>
```

Every write example below ends with `$SIGNER`; substitute one of the above.

```bash
export SIGNER='--ledger'
```

> **Simulate before you send.** Append `--rpc-url $RPC` to a `cast call` with
> the same arguments as your intended `cast send` and you get the revert reason
> for free, without paying gas for a failed transaction. Do this every time;
> §6 lists what the errors mean.

---

## 1. Find out where you stand

Run these first. They tell you which section of this document applies.

```bash
# Has the project launched? false = still in genesis or awaiting launch
cast call $HOOK "launched()(bool)" --rpc-url $RPC

# Genesis deadline (unix seconds) and how much was raised vs. required
cast call $HOOK "genesisDeadline()(uint256)"    --rpc-url $RPC
cast call $HOOK "totalEthDeposited()(uint256)"  --rpc-url $RPC
cast call $HOOK "softCap()(uint256)"            --rpc-url $RPC

# Your own position
cast call $HOOK "ethDeposited(address)(uint256)" $ME --rpc-url $RPC
cast call $HOOK "hasClaimed(address)(bool)"      $ME --rpc-url $RPC
cast call $HOOK "claimableReferral(address)(uint256)" $ME --rpc-url $RPC

# THE decisive read: can you refund right now?
cast call $HOOK "canRefund()(bool)" --rpc-url $RPC
```

`cast call` prints wei. `cast from-wei <value>` converts to ETH.

### Which phase am I in?

| `launched()` | `canRefund()` | `block.timestamp` vs `genesisDeadline()` | Phase | Go to |
|:---:|:---:|---|---|---|
| `false` | `false` | before | **Genesis open** — deposits accepted | §2 |
| `false` | `false` | after, soft cap met | **Awaiting launch** — creator must call `launch()` | §3 |
| `false` | `true` | after, soft cap missed | **Failed genesis** — refund | §4 |
| `false` | `true` | after, `LAUNCH_WINDOW` (7d) elapsed | **Abandoned** — refund | §4 |
| `true` | `false` | — | **Live** — claim, trade, shelf-mint | §5 |

---

## 2. Genesis — depositing

Deposits go through the **factory**, never the hook directly (`hook.deposit` is
factory-only and will revert with `OnlyFactory`).

### 2.1 Check you are eligible first

```bash
cast call $FACTORY "eligibility(address,address)(bool,uint256,uint256)" \
  $ME $HOOK --rpc-url $RPC
# → (eligible, remainingQuota, cooldownRemaining)
```

A `false` here means one of: you have no PoG quota, you have used it,
your per-hook cooldown has not elapsed, or you are blacklisted. §6 maps the
revert names.

### 2.2 PoG registration requires the off-chain signer

```bash
cast send $FACTORY \
  "registerPoG(uint256,uint256,uint256,bytes)" \
  <maxAlloc> <deadline> <nonce> <signature> \
  --rpc-url $RPC $SIGNER
```

> **This is the one action you cannot self-serve.** The four arguments come
> from an attestation signed by the protocol's PoG oracle key; the contract
> verifies the signature and there is no way to forge one. If the signing API
> is down, **new** PoG registration is genuinely unavailable — but every
> already-registered quota, every deposit made with it, and every refund
> continue to work. Signatures expire (`MAX_SIG_VALIDITY = 24 hours`).

### 2.3 Deposit

```bash
cast send $FACTORY "deposit(address,address)" \
  $HOOK 0x0000000000000000000000000000000000000000 \
  --value 0.05ether \
  --rpc-url $RPC $SIGNER
```

The second argument is your referrer. Use the zero address for none. **The
binding is permanent and platform-wide** — the first non-zero referrer you ever
deposit with is the only one you will ever have. Check yours:

```bash
cast call $FACTORY "referrerOf(address)(address)" $ME --rpc-url $RPC
```

Your deposit is capped per wallet by `perWalletCap()`; exceeding it reverts
with `PerWalletCapExceeded`.

---

## 3. Triggering the launch (project creator only)

Callable only by the address in `creator()`, only after the soft cap is met,
and only within `LAUNCH_WINDOW = 7 days` of the genesis deadline.

```bash
cast call $HOOK "creator()(address)" --rpc-url $RPC   # confirm it is you

cast send $HOOK "launch()" --rpc-url $RPC $SIGNER --gas-limit 3000000
```

`launch()` seeds the Uniswap V4 pool in one transaction and is expensive — let
`cast` estimate first, and only pin `--gas-limit` if estimation fails.

> **Miss the 7-day window and the launch is gone.** `LaunchWindowExpired` is
> terminal: the round converts to a refund and every depositor takes their ETH
> back. There is no owner override and no extension. If you are the creator and
> your window is closing, this is the most time-sensitive command in this
> document.

---

## 4. Refunds — the path that always works

Available when `canRefund()` returns `true`: the soft cap was missed at the
deadline, or the creator let the 7-day launch window lapse.

```bash
cast call $HOOK "canRefund()(bool)" --rpc-url $RPC   # must be true

cast send $HOOK "refund()" --rpc-url $RPC $SIGNER
```

You receive **your exact deposit** in ETH. Facts worth knowing at 3am:

- `refund()` is **not** gated by `pause()`. A paused platform still refunds.
  Pinned by `test_pause_doesNotBlockRefund`.
- It is **not** gated by the ladder halt either.
- There is **no deadline** on refunding. The hook holds your ETH indefinitely;
  claim it in a year if you like.
- No owner, admin, or creator can block, delay, or redirect it.

If `refund()` reverts with `GenesisActive`, the round is still open or the
creator still has launch window left — you are early, not blocked. Re-check
the table in §1.

---

## 5. After launch

### 5.1 Claim your genesis tokens

```bash
cast call $HOOK "hasClaimed(address)(bool)" $ME --rpc-url $RPC   # want false
cast send $HOOK "claimGenesis()" --rpc-url $RPC $SIGNER
```

Pro-rata from `GENESIS_CLAIM_SUPPLY` against your share of
`totalEthDeposited()`. One claim per address, no deadline.

### 5.2 Claim referral rewards

```bash
cast call $HOOK "claimableReferral(address)(uint256)" $ME --rpc-url $RPC
cast send $HOOK "claimReferralReward()" --rpc-url $RPC $SIGNER
```

Paid in ETH, accrues at `REFERRAL_BPS = 1000` (10%) of your referees' deposits,
claimable only after launch.

### 5.3 Buy from the shelf ladder

Quote first — the price gate can reject a mint that looked fine a block ago:

```bash
# Ceiling on what you can mint right now (0 = gate closed or halted)
cast call $HOOK "maxMintable()(uint256)" --rpc-url $RPC

# Exact ETH cost for a given token amount
cast call $HOOK "quoteMint(uint256)(uint256)" <tokenAmount> --rpc-url $RPC

# Full gate snapshot:
# (tierIndex, tierPrice, remaining, spotPrice, twapPrice, ceiling, unlocked)
cast call $HOOK \
  "tierStatus()(uint256,uint256,uint256,uint256,uint256,uint256,bool)" \
  --rpc-url $RPC
```

Then mint, sending **at least** the quoted amount:

```bash
cast send $HOOK "mintBondingCurve(uint256)" <tokenAmount> \
  --value <quotedEthCost> \
  --rpc-url $RPC $SIGNER
```

Overpayment is refunded within the same transaction; underpayment reverts with
`InsufficientPayment`. A single call spans at most `MAX_TIERS_PER_TX = 32`
shelves — ask for more and it reverts with `SpanTooManyShelves`; split the
order.

### 5.4 Trade on the pool

Once launched, the token is an ordinary Uniswap V4 asset. Fetch the pool key
and route through V4 periphery or any aggregator:

```bash
cast call $HOOK "getPoolKey()" --rpc-url $RPC
```

Pool parameters are `POOL_FEE = 3000` (0.30%) and `TICK_SPACING = 200`. A
1.00% tax applies on hook-routed swaps, so total friction is 1.30%. Buys split
theirs — 0.70% of the ETH input to the ladder treasury, 0.30% to the platform's
fee recipient. Sells are not split: the full 1.00% of the token input is burned.

> **Beware lookalike pools.** Anyone can open a V4 pool for the same token with
> a different hook — one that has no tax and no ladder. The canonical pool is
> the one `getPoolKey()` returns. Verify before you trade size.

Your swap may or may not carry a buyback, and you cannot choose. `afterSwap`
pokes the treasury only when the trade has gas to spare
(`gasleft() >= PIGGYBACK_MIN_GAS`, currently 230,000). If it does, expect roughly
363,000 gas instead of the ~217,000 an untriggered swap costs; if it does not,
the poke is skipped, your trade settles normally, and the treasury waits.

This is worth knowing when you set a gas limit by hand. A limit sized against a
simulation that happened to skip the buyback will still succeed — the gate
withholds the swap's remaining gas physically, so a poke can never strand the
trade. What it cannot do is make the buyback happen on a tight limit. If you
*want* your swap to carry one, leave headroom; wallets that simulate and add
~15% generally do.

### 5.5 Poke the buyback yourself

Anyone can deploy the reservoir without trading:

```bash
cast send $TREASURY "pokeBuyback()" --rpc-url $RPC --private-key $PK
```

No role, no Safe transaction, no allowlist. This exists because the gas gate in
§5.4 means trading alone no longer guarantees the treasury empties: in a market
where wallets attach tight limits, the reservoir can hold ETH indefinitely with
nothing in the event stream to say so. `STATE-06` in `monitoring/alerts.json`
polls for exactly that, and this is its remedy.

It is safe to leave to strangers because it decides nothing. The venue comes from
the listed token's own hook, the size from the treasury balance, the order from
the round-robin cursor, and the price is bounded by the same TWAP floor as every
other leg. Proceeds go to `0xdead`. The only choice a caller has is *when*, and
the cursor makes that uninteresting.

Reverts you should expect rather than debug:

| Error | Meaning |
|-------|---------|
| `NotArmed` | Balance is below `TRIGGER_STEP` (1 ETH), or no tokens are listed. Nothing to deploy. |
| `PiggybackInProgress` | A cycle is already running in this call stack. Retry after it settles. |

---

## 6. When a transaction reverts

`cast` prints the custom error name. What each one means for you:

### You are not allowed to do this yet

| Error | Meaning | Do this |
|-------|---------|---------|
| `GenesisActive` | Round is still open (or the creator's launch window is still running). | Wait. Re-check §1. |
| `GenesisExpired` | Deposit window closed. | If the cap was missed, refund (§4). |
| `NotLaunched` | Action requires a launched project. | Wait for the creator, or refund if the window lapsed. |
| `AlreadyLaunched` | Genesis is over. | Use §5. |
| `SoftCapNotMet` | `launch()` called below the cap. | Nothing to do; the round will refund. |
| `LaunchWindowExpired` | Creator missed the 7-day window. | Refund (§4). Terminal. |
| `OnlyCreator` / `OnlyFactory` / `Unauthorized` | Wrong caller. | `deposit` goes through the factory; `launch` needs `creator()`. |

### Your eligibility

| Error | Meaning | Do this |
|-------|---------|---------|
| `IsBlacklisted` | Address is banned. | Check `blacklistedUntil(address)`; bans can be time-limited. |
| `NoPogQuota` / `QuotaExceeded` | No or insufficient PoG quota. | Register (§2.2) or wait for the quota window to refill. |
| `CooldownActive` | Re-depositing to the same hook too soon. | `eligibility(...)` returns the seconds remaining. |
| `InvalidSignature` / `SignatureExpired` / `NonceConflict` | Bad, stale (>24h), or reused attestation. | Request a fresh one. |
| `PerWalletCapExceeded` | Deposit exceeds `perWalletCap()`. | Send less. |

### Claims and rewards

| Error | Meaning |
|-------|---------|
| `AlreadyClaimed` | Genesis tokens already claimed. |
| `NoDeposit` | This address never deposited into this hook. |
| `NoReferralReward` | Nothing accrued, or already withdrawn. |

### The shelf ladder

| Error | Meaning | Do this |
|-------|---------|---------|
| `InsufficientPayment` | `--value` below the quote. | Re-quote and resend; the price moves. |
| `TierPriceAboveCeiling` | Shelf price is above the TWAP-derived ceiling. | Gate is protecting you. Wait for the pool to catch up. |
| `LadderMintingHalted` | Owner halted shelf minting. | Auto-expires within 7 days. Trading, claims and refunds are unaffected. |
| `SameBlockMintForbidden` | Minting in the pool's own swap block. | Retry next block. |
| `ExceedsTierRemaining` / `LadderExhausted` | Order exceeds the shelf, or the ladder is sold out. | Check `tierRemaining()` / `bondingRemaining()`. |
| `SpanTooManyShelves` | Order crosses more than 32 shelves. | Split it. |

### Platform state

| Error | Meaning |
|-------|---------|
| `EnforcedPause` | Platform paused. Affects **only** `createLaunch` and `registerPoG` — deposits into open rounds, claims, trading and refunds all continue. |
| `InsufficientLaunchFee` / `FeeChanged` | Launch fee wrong or changed mid-flight. Re-read `launchFee()`. |
| `NameTaken` | Name/symbol already used. |

### The buyback treasury

| Error | Meaning |
|-------|---------|
| `NotArmed` | `pokeBuyback()` with the reservoir below `TRIGGER_STEP` or with no tokens listed. Reverts rather than returning quietly, because unlike the swap-borne poke this is nobody's hot path and a caller deserves to know the call did nothing. |
| `PiggybackInProgress` | A buyback cycle is already open in this call stack. |
| `OnlyPoolManager` | Something other than the V4 `PoolManager` called `unlockCallback`. You should never see this; if you do, it is not a configuration problem. |
| `OnlyHook` | `autoPiggybackBuyback()` called directly. That entry point is for registered hooks only — use `pokeBuyback()` (§5.5), which is the permissionless door. |
| `PoolNotLaunched` | `addLadderToken` on a project whose `launch()` has not run. Distinct from `InvalidPoolKey`: the hook exists and its key is well-formed, there is just no pool behind it yet. |

---

## 7. Creating a launch manually

`createLaunch` is the one user action that is **not** a practical one-liner:

```solidity
createLaunch(
    string  name,
    string  symbol,
    address projectTreasury,
    address projectAdmin,
    bytes32 hookSalt,          // ← must be mined
    uint256 expectedFee,
    uint256 genesisDuration    // 3h | 24h | 72h
) payable returns (address token, address hook)
```

`hookSalt` must produce a CREATE2 address whose low bits match the Uniswap V4
hook-flag mask `0x20CC`. Finding one is a search loop, not a shell command.

Use the repo's script rather than hand-rolling it:

```bash
forge script script/Deploy.s.sol --rpc-url $RPC --broadcast
```

Mine against `hookInitcodeHash(...)` read from the **live factory**. Do not use
`getLiveHookInitcodeHash()` (build fingerprint only, not valid for mining), and
never hardcode a hash — a comment-only change to the hook source produces a
different one and invalidates every previously mined salt.

`genesisDuration` must be exactly `DURATION_FAST` (3h = `10800`),
`DURATION_STANDARD` (24h = `86400`), or `DURATION_SLOW` (72h = `259200`);
anything else reverts with `InvalidDuration`.

---

## 8. Reading the registry

Enumerate every launch this factory has produced, without any API:

```bash
cast call $FACTORY "launchCount()(uint256)" --rpc-url $RPC

# LaunchInfo: (token, hook, creator, createdAt)
cast call $FACTORY "launches(uint256)(address,address,address,uint256)" \
  <index> --rpc-url $RPC

# Reverse lookup
cast call $FACTORY "tokenToHook(address)(address)" $TOKEN --rpc-url $RPC

# Confirm a hook really came from this factory — do this before depositing
# into a hook address someone sent you
cast call $FACTORY "registeredHooks(address)(bool)" $HOOK --rpc-url $RPC
```

Or from event logs:

```bash
cast logs --from-block <deployBlock> --address $FACTORY \
  "LaunchCreated(uint256,address,address,address,string,string)" \
  --rpc-url $RPC
```

---

## 9. Safety checklist

Before signing anything:

1. **Verify the factory address** against `factoryDeployments.ts` in the repo
   *and* the explorer. Everything else derives from it.
2. **Verify the hook is registered** — `registeredHooks(hook)` must be `true`.
   An unregistered "hook" is someone else's contract.
3. **Simulate with `cast call`** before `cast send`. Free revert reasons.
4. **Never paste a private key into a shell.** `--ledger` or `--keystore`.
5. **Check `canRefund()` before you panic.** If it is `true`, your ETH is
   already retrievable and nothing else is urgent.

---

*Last updated: 2026-08-26 (v5.0 — initial version, ETH-native surface).*
