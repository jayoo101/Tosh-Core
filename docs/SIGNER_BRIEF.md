# Being a Tosh Protocol Safe signer — what is actually being asked

*Written to be handed to a candidate as-is. Last updated 2026-09-08.*

This was written because PM-D4 was blocked on finding two people, and "help me
run a multisig" is not a question anyone can answer. Below is the whole
obligation, the whole power the key carries, and the parts that are genuinely
unattractive. If you read it and say no, that is a useful answer and costs
nothing.

---

## The one-sentence version

You would hold one of three keys to a wallet that owns Tosh Protocol's
emergency brake. Two of the three must agree for anything to happen. Your job
is to be **reachable within 15 minutes** and, when reached, to co-sign a
pause. Signing itself takes seconds and costs you nothing.

---

## What the key can do

The wallet owns two contracts, and between them there are exactly fifteen
functions it can call. Nothing else. Grouped by what they are for:

| | Functions | What they are |
|---|---|---|
| **The brake** | `pause`, `unpause`, `haltLadderMinting`, `resumeLadderMinting` | Stop new launches and new attestations. This is the reason the wallet exists. |
| **Blocking an address** | `setBlacklist`, `liftBlacklist` | Shut one attacker out without stopping everyone. |
| **Parameters** | `setLaunchFee`, `setCooldownDuration`, `setQuotaWindowDuration`, `setDefaultSoftCap`, `setMaxPogAllocationLimit`, `setPogSigner` | Ordinary configuration and key rotation. |
| **Buyback list** | `addLadderToken`, `removeLadderToken`, `setFactory` | Which tokens the treasury buys back with protocol revenue. |

## What the key cannot do

**There is no way to withdraw funds.** The treasury contract has no
`withdraw`, no `sweep` and no `rescue` — not disabled, absent, and the source
says so in a comment listing each one as "absent by design". ETH can only
leave it through the buy-and-burn path, which sends tokens to a burn address.
So no combination of signatures produces a transfer to a signer.

## The part you should be suspicious of

The last row of the first table is real power. `addLadderToken` decides which
tokens the treasury spends protocol revenue buying. Two signers who agreed to
be dishonest could point that spending at a token they controlled. They could
not send themselves the ETH, but they could direct where it goes, which is
economic influence even if it is not theft.

That is the honest reason the threshold is two of three rather than one of two,
and the reason we are not lowering it to make recruiting easier. It also means
the third signer is not a formality: they are the reason no two people can
quietly do the above without a third who could have refused.

## Before you sign a buyback listing, run one command

```
node scripts/preflightLadderListing.mjs <token-address>
```

It is read-only, holds no key and sends nothing. It prints `safe to sign` or
`DO NOT SIGN` and says why.

The reason it exists is worth a paragraph, because it is the sort of thing that
is easy to wave through. `_buybackSqrtFloor` bounds every buyback leg to the
pool's own 30-minute average price, which is what stops the treasury being
made to buy at a price somebody moved a moment earlier. For the first 30
minutes of a pool's life that average does not exist yet, and the contract
reads the absence as "no limit" rather than as "wait". A token listed inside
that window therefore has no price protection on its buybacks at all, on the
pool least able to absorb it — measured at 0.93 ETH taken from a 3.33 ETH leg,
and repeatable, not once.

Listing is the only way to reach that state, and listing needs your signature.
So the rule is: do not sign a listing for a pool younger than 30 minutes. The
script is that rule, checked against the chain instead of remembered. Nothing
is lost by waiting — an unlisted token costs the treasury nothing, and the
window closes on the clock by itself.

Newer deployments enforce this in the contract, and the script tells you which
kind you are looking at. The treasury holding the live reservoir is the older
kind and cannot be upgraded to the newer one, so for that one your signature
and this script are the whole control. `SECURITY_AUDIT.md` §2.3 is the full
account, including our own view that holding it this way is weaker than fixing
it in code.

If you want to verify any of this rather than take our word for it, the
contracts are source-verified on the explorer and the function list above is
exhaustive.

---

## The time commitment, measured rather than estimated

We rehearsed the whole thing on the test network on 2026-09-04 and timed it
(`INCIDENT_RESPONSE.md` §8.2):

- Building the transaction, collecting two signatures, and getting it confirmed
  on chain: **5 seconds.**
- Which means the 60-second target in our playbook is spent almost entirely on
  **reaching the second person**, not on anything technical.

So the ask is not skill or speed. It is that when a message arrives saying
"pause, now", you see it and act inside 15 minutes. Nights and weekends
included, because that is when it would happen.

**What you would actually do:** open the Safe web app, read a transaction that
says `pause()` on a named contract, and click to sign. That is the entire
mechanical task. You do not need to understand the incident to sign the brake
— pausing is the safe error, and our playbook says to bias toward it.

**What we would ask you not to do:** deliberate. If you want to understand the
situation first, that is fine *after* signing the pause. A false pause costs
users a few minutes. A missed pause can cost the treasury.

## What it costs you

- **No money.** You never pay gas: whoever submits the transaction pays it, and
  in the rehearsal that was the deployer. Your key holds no funds and never
  needs any.
- **No ongoing work.** There is nothing to do between incidents. Realistically
  the expected number of pauses is zero.
- **One setup session, about ten minutes.** A hardware wallet or a fresh
  browser wallet, the address sent to us, and a test signature so we know the
  path works before we need it.

## What it costs you if it goes wrong

Being honest about this, since the rest of the document is asking for trust:

- Your address becomes publicly associated with the protocol, permanently and
  on chain. If you would rather not be publicly connected to a crypto project,
  this is a real reason to decline.
- If you lose the key, we drop to two working signers, and the threshold is
  two — meaning any further loss freezes the brake entirely. Tell us
  immediately if that happens; it is recoverable while there are still two.
- You may be contacted at an inconvenient hour and be unable to help. That is
  expected occasionally. It is why there are three of you and not two.

## What disqualifies a candidate

Not competence — reachability. If you routinely go a day without checking
messages, or you would want to research an incident before signing a pause,
you would be a liability in the only fifteen minutes that matter. Saying so
now is more useful than discovering it during one.

---

## If you say yes

1. Send us the address you will sign from. Do not send a private key or a seed
   phrase to anyone, including us. Nobody who is entitled to ask will ever ask.
2. We add you as one of three owners on the Safe and confirm on chain that
   `getOwners()` and `getThreshold()` read as expected.
3. You sign one harmless test transaction, so the first real signature is not
   also the first time the path is exercised.
4. Your contact channel is Encrypted Signal / Telegram. The handle is recorded
   in the operator's offline vault, not in `INCIDENT_RESPONSE.md` §1 — that
   roster names the channel and does not hold personal numbers, emails or IDs.

## Where this sits

This document was the recruiting input to **PM-D4**, which closed once three
reachable signers existed, the Safe was built, and §1 named the channel (handles
in the offline vault, not in this repository). Ownership of the factory and
treasury still moves to the Safe
(**PM-C2** — mechanism already rehearsed end to end on the test network), and
the factory address can be announced publicly (**PM-C3**, which is deliberately
gated behind that transfer, so nobody is handed a contract whose original
deployer can still control it).

Until C2 the brake is a single key held by one person, which is exactly the
arrangement `PRD-v5.0.md` §11 D2 names as voiding its own decision to ship
without a timelock.
