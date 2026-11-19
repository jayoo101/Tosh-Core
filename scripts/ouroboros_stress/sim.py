"""Ouroboros stress model, following OuroborosMint / OuroborosToken as deployed.

Order inside one L2 mint (OuroborosMint.mintL2):
  1. token.swapTaxes(): held buy tax sold into the pair, capped at 0.1% of T
  2. tokens = cost * T / U * 1.01   (reserves before the AutoLp)
  3. 20% of cost to treasury, 80% buys then adds liquidity: U += 0.8 * cost, T unchanged
  4. revert PoolDepleted if T - tokens < 1M; else burn `tokens` from the pair and sync
Pair: Pancake V2, 0.25% fee. From L2: buys pay 1.25% of tokens out (held, sold later),
sells pay 1% of tokens in (burned). Shares: 30 per Agent ID across L1 + L2.
"""

from __future__ import annotations

import csv
import json
import sys
from dataclasses import dataclass, field
from pathlib import Path

CAP = 21_000_000_000
L1_ALLOC = 11_666_666_667
POOL_ALLOC = CAP - L1_ALLOC
MIN_POOL = 1_000_000
L1_PRICE = 0.9
QUOTA = 30
FEE = 0.0025
BUY_TAX = 0.0125
SELL_TAX = 0.01
SWAP_CAP = 0.001
# The contract prices L2 tokens on reserves after the AutoLp and caps one mint
# at 10 % of the pool's USDT. `--pre-lp` reproduces the earlier pricing, uncapped.
POST_LP = "--pre-lp" not in sys.argv
MAX_MINT_POOL = 0.10 if POST_LP else float("inf")

TIERS = [  # (first share, last share, start price, step size in shares, step)
    (1, 10_000, 1.20, 10_000, 0.0),
    (10_001, 20_000, 1.28, 1_000, 0.08),
    (20_001, 100_000, 2.08, 1_000, 0.016),
    (100_001, 1_000_000, 3.36, 10_000, 0.016),
    (1_000_001, 5_000_000, 4.80, 20_000, 0.02),
    (5_000_001, 21_000_000, 8.80, 50_000, 0.02),
]


def ladder_price(n: int) -> float:
    for lo, hi, start, size, step in TIERS:
        if lo <= n <= hi:
            return start + ((n - lo) // size) * step
    raise ValueError(n)


def ladder_cost(first: int, shares: int) -> float:
    return sum(ladder_price(n) for n in range(first, first + shares))


@dataclass
class Pool:
    u: float
    t: float
    supply: float = CAP
    treasury: float = 0.0
    held_tax: float = 0.0
    burned_sell: float = 0.0
    burned_l2: float = 0.0
    depleted: int = 0
    capped: int = 0  # shares an agent could not mint under the 10 % cap
    edges: list[float] = field(default_factory=list)

    @property
    def price(self) -> float:
        return self.u / self.t

    def sell(self, tokens: float) -> float:
        burn = tokens * SELL_TAX
        self.supply -= burn
        self.burned_sell += burn
        x = (tokens - burn) * (1 - FEE)
        out = self.u * x / (self.t + x)
        self.t += tokens - burn
        self.u -= out
        return out

    def buy(self, usdt: float) -> float:
        x = usdt * (1 - FEE)
        out = self.t * x / (self.u + x)
        self.u += usdt
        self.t -= out
        tax = out * BUY_TAX
        self.held_tax += tax
        return out - tax

    def swap_taxes(self) -> None:
        amount = min(self.held_tax, self.t * SWAP_CAP)
        if amount <= 0:
            return
        self.held_tax -= amount
        x = amount * (1 - FEE)
        out = self.u * x / (self.t + x)
        self.t += amount
        self.u -= out
        self.treasury += out

    def mint_l2(self, cost: float) -> float:
        self.swap_taxes()
        u = self.u + 0.8 * cost if POST_LP else self.u
        tokens = cost * self.t / u * 1.01
        if self.t - tokens < MIN_POOL:
            self.depleted += 1
            return 0.0
        self.treasury += 0.2 * cost
        self.u += 0.8 * cost
        self.t -= tokens
        self.burned_l2 += tokens
        # The pool burn and the minter's tokens cancel: supply is unchanged.
        x = tokens * (1 - SELL_TAX) * (1 - FEE)
        self.edges.append(self.u * x / (self.t + x) / cost - 1)
        return tokens


@dataclass
class Scenario:
    name: str
    l1_frac: float  # share of agents in L1
    l1_shares: int
    l2_frac: float  # share of agents in L2
    l2_sell: float  # fraction of each L2 mint sold right after (ignores the 180s vest)
    final_dump: float = 0.0  # fraction of all holdings sold at the end


SCENARIOS = [
    Scenario("l1_10_l2_20_hold", 1.0, 10, 1.0, 0.0),
    Scenario("l1_20_l2_10_hold", 1.0, 20, 1.0, 0.0),
    Scenario("l1_30_only", 1.0, 30, 0.0, 0.0),
    Scenario("l2_half_dump", 1.0, 10, 1.0, 0.5),
    Scenario("l2_full_dump", 1.0, 10, 1.0, 1.0),
    Scenario("thin_l2", 1.0, 10, 0.2, 0.0),
    Scenario("stop_then_dump", 1.0, 10, 0.3, 0.0, 0.8),
    Scenario("l1_cold_l2_hot", 0.2, 10, 1.0, 0.0),
]

AGENTS = [100, 500, 1_000, 5_000, 10_000]


def run(agents: int, sc: Scenario) -> dict:
    l1_agents = max(1, int(agents * sc.l1_frac))
    l1_total = l1_agents * sc.l1_shares
    raised_l1 = l1_total * L1_PRICE
    pool = Pool(u=raised_l1 * 0.8, t=POOL_ALLOC, treasury=raised_l1 * 0.2)
    par = pool.price
    held = float(L1_ALLOC)

    l2_agents = int(agents * sc.l2_frac)
    minted = 0
    raised_l2 = 0.0
    for i in range(l2_agents):
        # An agent outside L1 keeps the full 30; an L1 agent has 30 - l1_shares left.
        shares = QUOTA - sc.l1_shares if i < l1_agents else QUOTA
        # Over the cap, the agent splits the quota into the largest mints that fit.
        while shares > 0:
            k = shares
            while k > 0 and ladder_cost(minted + 1, k) > pool.u * MAX_MINT_POOL:
                k -= 1
            if k == 0:
                pool.capped += shares
                break
            cost = ladder_cost(minted + 1, k)
            got = pool.mint_l2(cost)
            if got == 0:
                break
            shares -= k
            minted += k
            raised_l2 += cost
            sold = got * sc.l2_sell
            if sold:
                pool.sell(sold)
            held += got - sold

    peak = pool.price
    if sc.final_dump:
        pool.sell(held * sc.final_dump)
        held *= 1 - sc.final_dump

    return {
        "agents": agents,
        "scenario": sc.name,
        "l1_shares": l1_total,
        "l1_raise": round(raised_l1),
        "l2_shares": minted,
        "l2_raise": round(raised_l2),
        "pool_usdt": round(pool.u),
        "peak_x": round(peak / par, 3),
        "final_x": round(pool.price / par, 3),
        "supply_pct": round(pool.supply / CAP * 100, 3),
        "burned_l2_pct": round(pool.burned_l2 / CAP * 100, 2),
        "treasury": round(pool.treasury),
        "depleted": pool.depleted,
        "capped_shares": pool.capped,
        "edge_max_pct": round(max(pool.edges, default=0) * 100, 3),
        "edge_last_pct": round(pool.edges[-1] * 100, 3) if pool.edges else 0,
    }


def main() -> None:
    rows = [run(a, sc) for a in AGENTS for sc in SCENARIOS]
    out = Path(__file__).parent
    tag = "" if POST_LP else "_pre_lp"
    with open(out / f"results{tag}.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0]))
        w.writeheader()
        w.writerows(rows)
    (out / f"results{tag}.json").write_text(json.dumps(rows, indent=1), encoding="utf-8")
    cols = list(rows[0])
    print("\t".join(cols))
    for r in rows:
        print("\t".join(str(r[c]) for c in cols))


if __name__ == "__main__":
    sys.exit(main())
