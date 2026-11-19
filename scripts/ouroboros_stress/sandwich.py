"""Can one transaction push the pool price down, mint L2 cheap, and buy back?

`tx.origin == msg.sender` stops contracts, but an EIP-7702 account batches calls
in one transaction. Compares holding after a plain mint with: sell X, mint,
buy X back. Gain is the USDT the extra tokens fetch when sold into the final
pool, plus the USDT left from the sell and buy-back, per unit of mint cost.
"""

import sys

FEE, BUY_TAX, SELL_TAX = 0.0025, 0.0125, 0.01


def sell(u, t, x):
    net = x * (1 - SELL_TAX)
    out = u * net * (1 - FEE) / (t + net * (1 - FEE))
    return u - out, t + net, out


def buy_exact(u, t, want):
    """USDT needed to receive `want` tokens after the buy tax."""
    gross = want / (1 - BUY_TAX)
    usdt = u * gross / ((t - gross) * (1 - FEE))
    return u + usdt, t - gross, usdt


MAX_MINT_POOL = 0.10


def mint(u, t, cost, post_lp):
    if post_lp and cost > u * MAX_MINT_POOL:
        return u, 0.0, 0.0  # MintTooLarge: the cap applies to the current pool
    base = u + 0.8 * cost if post_lp else u
    m = cost * t / base * 1.01
    return u + 0.8 * cost, t - m, m


MIN_POOL = 1e6


def gain(u, t, cost, x_frac, post_lp):
    _, t0, m0 = mint(u, t, cost, post_lp)
    if t0 < MIN_POOL:
        return float("nan")  # the plain mint already reverts PoolDepleted
    u1, t1, got = sell(u, t, t * x_frac)
    u2, t2, m1 = mint(u1, t1, cost, post_lp)
    if t2 < MIN_POOL or t * x_frac / (1 - BUY_TAX) >= t2:
        return -1.0  # reverts, or the buy-back cannot be filled
    u3, t3, paid = buy_exact(u2, t2, t * x_frac)
    # Extra tokens valued by selling them into the final pool, not at its spot price.
    extra = sell(u3, t3, m1 - m0)[2] if m1 > m0 else -(m0 - m1) * u3 / t3
    return (extra + got - paid) / cost


def main():
    post_lp = "--pre-lp" not in sys.argv
    print("pool_usdt\tcost\tbest_x_frac\tbest_gain_pct")
    for pool in [640, 6_400, 64_000]:
        for cost in [16, 120, 443]:
            rows = [(gain(pool, 9.33e9, cost, f / 1000, post_lp), f / 1000) for f in range(1, 600)]
            if rows[0][0] != rows[0][0]:
                print(f"{pool}\t{cost}\t-\tplain mint reverts")
                continue
            best = max(rows)
            print(f"{pool}\t{cost}\t{best[1]}\t{best[0] * 100:.2f}")


if __name__ == "__main__":
    main()
