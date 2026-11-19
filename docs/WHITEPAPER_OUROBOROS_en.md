# Ouroboros Whitepaper

**The serpent issue: one minted, one burned.**

| | |
|---|---|
| Project | Ouroboros |
| Version | v2.5 |
| Date | 2026-11-17 |
| Network | BNB Smart Chain |
| Liquidity | PancakeSwap V2 (TOKEN / USDT) |
| Access | Binance `.ai` Agent ID |

---

## Risk and Nature Statement (read first)

This product is an **experimental meme / fair-mint and trading mechanism** deployed on a public blockchain. The verified smart contracts are the rules, and anyone can check them.

1. **Not a security or investment product** — It provides no equity, debt, deposit, wealth-management product, dividend or claim on any return.  
2. **No promise of return** — It promises no price, return, break-even, redemption or investment gain, and is not investment advice.  
3. **Loss of principal** — Participation can lose **part or all of the funds used**; the token price can fall and **can go to zero**.  
4. **The mechanism is not a price floor** — Burning, the launch, liquidity additions and trading tax described here are rules, not a floor, support or guarantee. When minting stops, selling is heavy or liquidity is thin, the market price can fall, including below the pool's opening price.  
5. **The contracts prevail** — Where this document differs from the verified contracts or the official announcements, the contracts and the announcements prevail.  
6. **Not legal advice** — Assess the regulations where you are and your own tolerance for risk.  
7. **Funds discipline** — Use only funds you can afford to lose in full.

---

## Contents

1. [Summary](#1-summary)  
2. [Imagery and Terms](#2-imagery-and-terms)  
3. [Supply](#3-supply)  
4. [Eligibility](#4-eligibility)  
5. [Lifecycle](#5-lifecycle)  
6. [L1 Seeding](#6-l1-seeding)  
7. [Launch](#7-launch)  
8. [L1.5 Exchange](#8-l15-exchange)  
9. [L2 Expansion](#9-l2-expansion)  
10. [Equal Burn and Liquidity](#10-equal-burn-and-liquidity)  
11. [Claiming](#11-claiming)  
12. [Payment](#12-payment)  
13. [Trading Tax](#13-trading-tax)  
14. [Flow of Funds](#14-flow-of-funds)  
15. [Governance and Treasury](#15-governance-and-treasury)  
16. [Leaderboards and Events](#16-leaderboards-and-events)  
17. [Principal Risks](#17-principal-risks)  
18. [Closing](#18-closing)  
19. [Appendix A · L2 Ladder](#appendix-a--l2-ladder)  
20. [Appendix B · Parameters](#appendix-b--parameters)

---

## 1. Summary

Ouroboros issues its token in three phases:

| Phase | What happens |
|---|---|
| **L1 (2 hours)** | 0.9 USDT a share, limited by time only, no volume cap; when it ends, the L1 tokens are split by shares |
| **L1.5** | Launch and claims; minting closed; no pool yet, and tokens change hands through bids only |
| **L2 (next day)** | The pool is seeded at the opening price and opens for trading; minting on a price ladder; mint funds buy and add liquidity; an equal amount is burned |

**Motto: one minted, one burned.**

---

## 2. Imagery and Terms

**Ouroboros**, the serpent eating its tail, joins creation and destruction in one loop: every token minted in L2 burns the same amount from the pool, and the mint funds go into liquidity in the same transaction.

| Term | Meaning |
|---|---|
| One minted, one burned | The L2 burn equals what the minter receives |
| Opening price | Set from the L1.5 trading price, never below the L1 subscription price |
| Exchange window | The L1.5 market, where trades settle only against bids |

---

## 3. Supply

- Hard cap of **21,000,000,000 tokens** (21 billion), written into the token contract; nothing beyond it can be minted.  
- 5/9 is created when L1 ends, for L1 participants; at most 4/9 is created when the pool is seeded at L2, into the official pool. An opening price above the L1 price creates less, and the rest is never created.  
- Every token minted in L2 burns the same amount from the pool, so total supply does not change.  
- From L2, the 1% sell tax is burned, so supply only goes down.  
- No presale, no team allocation, no private round.

---

## 4. Eligibility

- A valid Binance `.ai` **Agent ID**.  
- Each Agent ID has **at most 30 shares across L1 and L2 combined**, and at most 30 shares per transaction.  
- Without a valid ID, or once the shares are used, no further minting is possible.  
- Minting must be sent directly by the wallet holding the Agent ID; contract wallets and relaying contracts cannot mint.  
- Binance maintains the Agent ID registry; while the registry is down, minting is unavailable, and it resumes once the registry recovers.

---

## 5. Lifecycle

| Phase | Time | Minting | Market |
|---|---|---|---|
| **L1 Seeding** | 2 hours | Open | Fixed-price subscription; tokens not transferable |
| **Launch (L1.5 begins)** | When L1 ends | Closed | L1 tokens claimable; the bid book opens; no pool yet |
| **L1.5 Exchange** | From launch until L2 opens the next day | Closed | Bids only; no asks |
| **L2 Expansion** | Opens the next day | Open | The pool is seeded at the opening price, LP locked forever, and trades; ladder minting, liquidity additions, equal burn |

The exact times follow the countdown on the official site.

---

## 6. L1 Seeding

- Lasts **2 hours**, limited by time only, with no volume cap: every eligible user can take part in that window, up to 30 shares per ID.  
- **0.9 USDT** a share, payable in USDT or BNB (see section 12).  
- When L1 ends, **11,666,666,667 tokens** (5/9 of supply) are split by shares among all L1 participants:  
  `tokens per share = 11,666,666,667 ÷ total L1 shares`  
- **20%** goes to the project treasury; **80%** is held by the mint contract and seeds the pool when L2 opens.  
- The total raised in L1 sets the size of the pool.  
- Tokens cannot be transferred during L1; participants claim their L1 tokens after launch.

---

## 7. Launch

L1 ending starts L1.5: L1 participants claim their tokens and the bid book opens. **There is no pool yet**: the official pair holds no liquidity, and nobody can move tokens into it.

When L2 opens, the protocol adds all of the 80% of USDT raised in L1 to PancakeSwap V2, paired with tokens at the opening price, at most **9,333,333,333 tokens** (4/9 of supply). The LP tokens go to an unrecoverable address and are locked forever. Any one of the multisig signers seeds the pool once L2 opens, and seeding and opening to trading happen in one transaction; until then, neither L2 minting nor pool trading is open. If the pool is still unseeded three days after L2 opens, anyone may seed it, at the L1 price.

The signer enters the opening price when seeding, with reference to the L1.5 trading price. The contract applies these rules:

- The opening price is never below the L1 price (the per-token price of an L1 share); a lower price entered opens the pool at the L1 price.  
- If cumulative bid-book volume in L1.5 is under **5%** of the total L1 raise, the pool opens at the L1 price.  
- At the L1 price the full 4/9 goes in; above it, proportionally fewer tokens go in and the rest are never created.

---

## 8. L1.5 Exchange

- **Bids only** (the buyer locks USDT); **no asks**. Holders sell by filling an existing bid.  
- Every trade in this phase settles through the bid book.  
- The price is whatever the bid and the filler agree on; with no bids, nobody can sell.  
- Fills pay the L1.5 trading tax (see section 13).

---

## 9. L2 Expansion

- When L2 opens, the pool is first seeded at the opening price (see section 7) and then trades.  
- The ladder starts at **share 1 of L2** (L1 shares do not count), at **1.20 USDT a share**, and rises with cumulative L2 shares; the full table is in [Appendix A](#appendix-a--l2-ladder).  
- L2 has **21,000,000 shares** and stops when they are sold.  
- Tokens received = payment ÷ the pool price after this mint's liquidity is added × 1.01.  
- One mint costs at most 10% of the pool's USDT; with a shallow pool, fewer shares fit in one mint.  
- Shares come from the same 30-share quota per ID as L1.  
- Payable in USDT or BNB (see section 12).  
- **20%** goes to the treasury and **80%** to liquidity.

---

## 10. Equal Burn and Liquidity

Each L2 mint completes in a single transaction:

1. Identity, shares and the per-mint cap are checked and the payment is split;  
2. 80% of the payment buys tokens and adds liquidity;  
3. The minter's tokens are priced at the pool price after that addition and go to the claim contract;  
4. The same amount the minter receives is burned from the official pool.  

If slippage prevents part of the liquidity addition, that amount is queued and added in a later transaction.  
LP from these additions is locked forever.

---

## 11. Claiming

Tokens minted in L2 can be claimed after **180 seconds**.

---

## 12. Payment

L1 and L2 accept **USDT** or **BNB**:

- **USDT**: approve, then mint. The contract charges the amount due, and the user can set the most they are willing to pay.  
- **BNB**: the BNB due is the Chainlink BNB/USD price plus 1%. The contract swaps the BNB to USDT on PancakeSwap and settles in USDT. If the swap returns less than the amount due, the whole transaction reverts; USDT above the amount due goes to the treasury; excess BNB is returned to the sender.  
- Sending BNB or USDT directly to the mint contract does not mint. If any check fails, the whole transaction reverts and the funds stay in the user's wallet.

Whichever way the user pays, what reaches the pool and the treasury is USDT.

---

## 13. Trading Tax

| Phase | Venue | Buy | Sell |
|---|---|---|---|
| **L1.5** | Bid book fills | **2%** → treasury | **2%** → treasury |
| **From L2** | Official TOKEN/USDT pair | **1.25%** → swapped to USDT for the treasury | **1%** → burned |

- In L1.5, the buyer's tax comes out of the tokens the buyer receives and the seller's tax out of the USDT the seller receives; both go straight to the treasury.  
- Wallet-to-wallet transfers are untaxed, as are minting, burning, liquidity additions and claims.  
- The official pair is the only AMM market: in every phase, tokens cannot move into or out of any other pair or pooled-liquidity venue.

---

## 14. Flow of Funds

| Source | Destination |
|---|---|
| L1 payments | 20% → treasury; 80% → pool seeded at L2 |
| L1.5 trading tax | 2% each side → treasury |
| L2 payments | 20% → treasury; 80% → liquidity |
| Buy tax from L2 | 1.25% → swapped to USDT → treasury |
| Sell tax from L2 | 1% → burned |
| BNB payment swap surplus | USDT above the amount due → treasury |
| Official LP | Locked forever |

Treasury funds pay for operations, marketing and audits.

---

## 15. Governance and Treasury

- A **Safe multisig** holds the treasury and the protocol's admin rights.  
- Supply, shares, the ladder, tax rates and the payment split are written into the contracts; after launch nobody can change them.  
- The multisig can only pause or resume minting in an emergency, seed the pool once L2 opens, and manage treasury funds; it cannot mint more or change the parameters above.  
- The multisig, token contract, mint contract and official pair addresses are published on the official site, and the contracts are verified on BscScan.  
- The token contract can deduct tokens from the official pool; that right is used only for the equal burn during L2 minting.  
- The official LP is locked forever; the multisig cannot withdraw it.

---

## 16. Leaderboards and Events

The official site shows leaderboards for L1 Seeding, L1.5 Exchange and L2 Minting.  
Leaderboards count on-chain records; community event dates, rules and what counts are published by announcement on the official site.

---

## 17. Principal Risks

| Risk | Description |
|---|---|
| Market price | The price can move sharply, fall below the pool's opening price and go to zero |
| Mechanism limits | Burning, liquidity additions and trading tax guarantee no price or return |
| Restricted selling in L1.5 | The pool does not trade; you can only sell into existing bids, and with too few bids you may be unable to sell or only sell low |
| Trading costs | 2% each side in L1.5; from L2, 1.25% on buys and 1% on sells, plus Pancake fees and slippage |
| Liquidity and slippage | A small L1 means a shallow pool; minting, liquidity additions and trades can all slip |
| Front-running | With a shallow pool or a large order, a transaction can be front-run; set slippage protection when minting and trading |
| Mint size | Each mint is limited by pool depth; if L1 totals fewer than 17 shares, L2 minting waits until buys deepen the pool |
| Identity limits | Quotas are per Agent ID; one person holding several IDs can take part several times |
| External dependencies | The Agent registry, Chainlink prices, RPCs, the stablecoin, the router and the chain itself can all fail |
| Pool seeding | A multisig signer seeds the pool; until then L2 cannot mint or trade |
| Opening price | A multisig signer enters the opening price, which can be above the L1.5 trading price; the higher it is, the fewer tokens the pool holds and the more a given sale moves the price |
| BNB payment | BNB is charged at the quote plus 1% and swapped to USDT; if the swap falls short the transaction fails and gas is not refunded |
| Contracts and operations | Bugs, misconfiguration, frontend failures and key management problems can all cause loss |
| Regulation and access | Rules differ by region; the frontend may restrict access; users are responsible for their own compliance |

---

## 18. Closing

> One minted, one burned.

Before taking part, read the risk statement, understand the contracts, and use only funds you can afford to lose.

---

## Appendix A · L2 Ladder

Priced by cumulative L2 shares (counting from share 1 of L2; L1 does not count). When a single mint crosses a tier, each share is priced at its own tier.

| L2 share number | Price per share (USDT) |
|---|---|
| 1 – 10,000 | 1.20 |
| 10,001 – 20,000 | From 1.28, +0.08 every 1,000 shares (to 2.00) |
| 20,001 – 100,000 | From 2.08, +0.016 every 1,000 shares (to 3.344) |
| 100,001 – 1,000,000 | From 3.36, +0.016 every 10,000 shares (to 4.784) |
| 1,000,001 – 5,000,000 | From 4.80, +0.02 every 20,000 shares (to 8.78) |
| 5,000,001 – 21,000,000 | From 8.80, +0.02 every 50,000 shares (to 15.18) |

L2 has **21,000,000 shares** and stops when they are sold.

---

## Appendix B · Parameters

| Parameter | Value |
|---|---|
| Total supply | Capped at 21,000,000,000 tokens (5/9 created when L1 ends, at most 4/9 when the pool is seeded at L2; only decreases afterwards) |
| L1 tokens per share | 11,666,666,667 ÷ total L1 shares |
| Payment | USDT or BNB (BNB is swapped to USDT before settling) |
| L1 allocation | 5/9 split by shares among participants; at most 4/9 into the pool when it is seeded at L2 |
| Shares per ID | 30 (L1 + L2 combined) |
| L1 duration | 2 hours; no volume cap |
| L1 price | 0.9 USDT / share |
| L1.5 | Bids only; no pool yet; minting closed |
| L1.5 trading tax | 2% buy / 2% sell → treasury |
| L2 opens | Next day; the pool is seeded at the opening price and trades |
| L2 ladder | 1.20 → 15.18 USDT / share (see Appendix A) |
| L2 total shares | 21,000,000; stops when sold |
| L2 tokens | Payment ÷ pool price after the liquidity addition × 1.01 |
| L2 per-mint cap | Payment at most 10% of the pool's USDT |
| Who sends a mint | The wallet holding the Agent ID, directly |
| Other pairs | Tokens cannot move in or out |
| L2 claim | After 180 seconds |
| Mint split | 20% treasury / 80% liquidity |
| Trading tax from L2 | 1.25% buy → USDT to treasury; 1% sell → burned |
| Liquidity | Pancake V2; LP locked forever |
| Pool seeding | By a multisig signer once L2 opens; opening price never below the L1 price; at the L1 price if L1.5 volume is under 5% of the L1 raise; anyone may seed at the L1 price after three days unseeded |
| Governance | Safe multisig; emergency pause, pool seeding and treasury only; parameters immutable |
