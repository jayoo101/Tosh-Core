"""How the official pair's USDT evolves once L2 is open, day by day.

Reuses `Pool` and the ladder from sim.py (same pair, tax and mint rules).
Assumptions, all illustrative:
  * AGENTS Agent IDs; every ID mints 10 shares in L1 and the pair opens at par.
  * L2 demand: a fraction of IDs mint their remaining 20 shares, spread evenly
    over the first L2_DAYS days.
  * Secondary trading: each day `turnover x pool USDT` of volume in TRADES equal
    trades; each trade is a buy with probability `buy_p`, otherwise a sell of the
    same USDT value at the current price. Sellers are assumed to hold the tokens.
"""

from __future__ import annotations

import random
import sys
from dataclasses import dataclass
from typing import Callable

from sim import L1_PRICE, POOL_ALLOC, QUOTA, Pool, ladder_cost

AGENTS = 1_000
L1_SHARES = 10
L2_DAYS = 14
DAYS = 180
TRADES = 200
REPORT_DAYS = [0, 1, 3, 7, 14, 30, 60, 90, 180]


@dataclass
class Scenario:
    name: str
    label: str
    l2_frac: float
    turnover: Callable[[int], float]
    buy_p: Callable[[int], float]
    dump_day: int = 0  # on this day holders sell `dump` of the float at once
    dump: float = 0.0
    mint_sell: float = 0.0  # fraction of each L2 mint sold once it vests
    l1_frac: float = 1.0  # share of IDs that minted in L1


def const(x: float) -> Callable[[int], float]:
    return lambda _d: x


SCENARIOS = [
    Scenario("balanced", "买卖平衡，日换手 20%", 1.0, const(0.20), const(0.50)),
    Scenario("bull", "温和净买入（买单 52%）", 1.0, const(0.20), const(0.52)),
    Scenario("bear", "温和净卖出（买单 48%）", 1.0, const(0.20), const(0.48)),
    Scenario("cool", "热度衰减：换手 100%→5%，买单 50%→46%", 1.0,
             lambda d: max(0.05, 0.97 ** d), lambda d: 0.50 - 0.04 * min(d, 60) / 60),
    Scenario("thin_l2", "L2 只有 20% ID 参与，买卖平衡", 0.2, const(0.20), const(0.50)),
    Scenario("dump", "买卖平衡，第 30 天持有人抛售 30% 流通盘", 1.0, const(0.20), const(0.50), 30, 0.30),
]

# L2 minters dominate and sell after the vest; other trading is light and balanced.
MINT_DUMP = [
    Scenario(f"{tag}_sell{int(p * 100)}", f"{label}，铸后卖出 {int(p * 100)}%", 1.0, const(0.05),
             const(0.50), mint_sell=p, l1_frac=l1)
    for tag, label, l1 in [("base", "L1 全员各 10 份", 1.0), ("l2heavy", "L1 仅 20% ID，L2 占大头", 0.2)]
    for p in (1.0, 0.7, 0.5, 0.0)
]


def run(sc: Scenario, seed: int = 7) -> list[dict]:
    rng = random.Random(seed)
    l1_ids = int(AGENTS * sc.l1_frac)
    raised_l1 = l1_ids * L1_SHARES * L1_PRICE
    pool = Pool(u=raised_l1 * 0.8, t=POOL_ALLOC, treasury=raised_l1 * 0.2)
    open_price = pool.price
    l2_ids = int(AGENTS * sc.l2_frac)
    per_day = l2_ids / L2_DAYS
    minted = 0
    done_ids = 0.0
    volume = 0.0
    queued = 0.0
    minter_paid = minter_got = 0.0
    rows = [snapshot(0, pool, open_price, volume)]
    for day in range(1, DAYS + 1):
        target = min(l2_ids, round(per_day * day)) if day <= L2_DAYS else l2_ids
        mints = [QUOTA - L1_SHARES if i < l1_ids else QUOTA for i in range(int(done_ids), int(target))]
        done_ids = target
        trade = sc.turnover(day) * pool.u / TRADES
        events = mints + ["trade"] * TRADES
        rng.shuffle(events)
        for ev in events:
            if queued and ev == "trade":
                pool.swap_taxes()
                minter_got += pool.sell(queued)
                queued = 0.0
            if ev != "trade":
                cost = ladder_cost(minted + 1, ev)
                got = pool.mint_l2(cost) if cost <= pool.u * 0.10 else 0.0
                if got:
                    minted += ev
                    queued += got * sc.mint_sell
                    minter_paid += cost * sc.mint_sell
            elif rng.random() < sc.buy_p(day):
                pool.buy(trade)
                volume += trade
            else:
                float_tokens = pool.supply - pool.t - pool.held_tax
                tokens = min(trade / pool.price, float_tokens * 0.5)
                if tokens > 0:
                    volume += tokens * pool.price
                    pool.swap_taxes()
                    pool.sell(tokens)
        if day == sc.dump_day:
            chunk = (pool.supply - pool.t - pool.held_tax) * sc.dump / TRADES
            for _ in range(TRADES):
                pool.swap_taxes()
                pool.sell(chunk)
        if day in REPORT_DAYS:
            rows.append(snapshot(day, pool, open_price, volume))
    if minter_paid:
        print(f"  dumping minters: paid {minter_paid:,.0f}, got {minter_got:,.0f} ({minter_got / minter_paid - 1:+.2%})")
    return rows


def snapshot(day: int, pool: Pool, open_price: float, volume: float) -> dict:
    return {
        "day": day,
        "pool_usdt": pool.u,
        "pool_tokens_b": pool.t / 1e9,
        "price_x": pool.price / open_price,
        "supply_pct": pool.supply / 21e9 * 100,
        "treasury": pool.treasury,
        "volume": volume,
    }


def round_trip() -> None:
    """One balanced buy-then-sell of 1,000 USDT on a 100,000 USDT pool."""
    pool = Pool(u=100_000, t=POOL_ALLOC)
    u0, p0 = pool.u, pool.price
    got = pool.buy(1_000)
    pool.sell(got)
    pool.swap_taxes()
    print(f"round trip 1,000 USDT: pool USDT {pool.u - u0:+.2f}, price {pool.price / p0 - 1:+.4%},"
          f" treasury {pool.treasury:.2f}")


def main() -> None:
    round_trip()
    for sc in MINT_DUMP if "--mint-dump" in sys.argv else SCENARIOS:
        print(f"\n## {sc.label}")
        print("day\tpool_usdt\tpool_tokens_b\tprice_x\tsupply_pct\ttreasury\tvolume")
        for r in run(sc):
            print(f"{r['day']}\t{r['pool_usdt']:,.0f}\t{r['pool_tokens_b']:.2f}\t{r['price_x']:.2f}"
                  f"\t{r['supply_pct']:.2f}\t{r['treasury']:,.0f}\t{r['volume']:,.0f}")


if __name__ == "__main__":
    sys.exit(main())
