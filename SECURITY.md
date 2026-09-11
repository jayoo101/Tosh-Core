# Security Policy

This repository contains the contracts, monitoring and tooling for a protocol
that is **live on Robinhood Chain (chain 4663)** and holds real value. Reports
are welcome and read.

## Reporting a vulnerability

Use GitHub's **private vulnerability reporting** on this repository
(*Security* → *Report a vulnerability*). That is the only channel published
here, and it is deliberate: no email address, phone number or messaging handle
belonging to an operator or a signer is recorded in this repository, and adding
one to receive reports would undo that. Private reporting gives you a
confidential thread with the maintainers without either side publishing a
contact.

Please do not open a public issue for anything that could put funds at risk.

**What to include.** A description of the flaw, the contract and function, and
— if you have one — a Foundry test that reproduces it. The test is worth more
than the prose; `test/` carries 357 tests across 13 files, 17 of them
adversarial `test_probe*` cases, and one of those —
`test_probeG3_immatureTwapLeavesTheBuybackUnbounded` in
`test/ToshV5Attack.t.sol` — is the model for what a useful report looks like.

## What we can honestly promise

`docs/INCIDENT_RESPONSE.md` §0 sets internal severity targets — P0 acknowledged
in 5 minutes, halted in 15. **Those are targets for an incident already
detected, and they are not a commitment to an external reporter.** The reasons
are written down rather than glossed:

- The on-chain monitor is a GitHub Actions workflow, not a pager.
  `docs/ONCHAIN_MONITORING.md` §7.3 states plainly that it does not meet the
  15-minute detection criterion, that a P0 filed at 03:00 lands in an issue
  inbox nobody watches out of hours, and that the honest claim is only *"the
  protocol will notice, and will write it down."*
- The incident commander and comms lead are the same person.
- Halting requires 2-of-3 signatures on Safe
  `0x2953957774482efA660921df85A1E7634ccfe27A`, so the binding constraint is
  reaching a second human, not the mechanics — those were measured at 5 seconds.

So: expect a reply in **days, not minutes**, and assume nobody is awake when you
send it. If you believe an exploit is in flight and you can see funds moving, say
so in the first line of the report.

There is **no bug bounty**. We have no funds earmarked for one and would rather
say that than imply otherwise.

## Scope

In scope — the singletons deployed on chain 4663:

| Contract | Address |
|---|---|
| `ToshFactory` | `0xBa9d2E86281b988225Eca383C375215912fb20B9` |
| `ToshLadderTreasury` | `0x99aD248dD15498957B864Fd79917F0E103Aa78F7` |

Also in scope: `ToshLaunchpadHook` and `ToshToken`, which are deployed as clones
by the factory on every launch; the PoG signing oracle under `scripts/`; and the
frontend under `soat-frontend/`.

Both singletons are verified on Blockscout, so the source you are reading here
is the source that is running. `docs/PRE_MAINNET_CHECKLIST.md` PM-C4 records the
verification and the commit it was built from.

### Out of scope

- **Private keys that appear in this repository's git history.** They are test
  and rehearsal keys. All of them are revoked: none holds any role in the live
  deployment, and `docs/C1_RUNBOOK.md` §4.1 bans their reuse. History was
  deliberately *not* rewritten, because the commit that the verified mainnet
  bytecode was built from is the anchor that lets anyone reproduce the build,
  and rewriting history would break every hash in that chain. Reporting one of
  these keys is not a finding.
- Anything reachable only by an owner key acting against its own interest.
  Ownership is a 2-of-3 Safe; "the owner could rug" is understood and is what
  the Safe and `docs/PRD-v5.0.md` §11 D2 exist to discuss.
- Denial of service against the public RPC endpoint, or against the free-tier
  third-party services the monitoring uses.

## Known and accepted — please challenge this one

We would rather you spend your time on something new, so here is the issue we
already know about, stated as the audit states it.

`docs/SECURITY_AUDIT.md` §2.3, row *"ACCEPTED, HELD OFF CHAIN — buyback is
unbounded in a pool's first 1800 s"*: `_buybackSqrtFloor` returns
`MIN_SQRT_PRICE + 1` — no bound at all — for exactly the window between a pool's
`launch()` and `TWAP_WINDOW` elapsing, because `twapSqrtPriceX96()` reads 0 until
then. During that window a listed token has no anti-sandwich control, on the
pool whose liquidity is thinnest. It is measured, not theoretical: on a pool
parked 1500 bps out, the full 3.33 ETH leg clears and 0.93 ETH of it is
recovered by whoever parked the price.

**We chose not to change the contract.** The exposure is held shut by an
operational rule — do not list a token until its TWAP matures — on the grounds
that reaching the state at all requires `addLadderToken`, which is owner-only.
The rule is recorded in `addLadderToken`'s natspec, in `_buybackSqrtFloor`'s
natspec, and as `STATE-07` in `monitoring/alerts.json`.

The audit's own verdict on that trade, which we are not going to soften here:

> this is a procedural control on a privileged key, so it is exactly as strong
> as the runbook and the alert pipeline, and weaker than the one-line code
> change that would make it unreachable. An auditor who thinks that trade is
> wrong should say so.

If you think it is wrong, say so. That is a legitimate report even though it is
already documented, and arguing the trade is more useful to us than rediscovering
the mechanism.

## Disclosure

We will confirm a report, agree a timeline with you, and credit you unless you
ask us not to. If a fix requires redeploying a singleton and migrating state, the
timeline will be weeks and we will say so rather than sit on the thread silently.
