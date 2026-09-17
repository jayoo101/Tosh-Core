# Tosh dApp

The web interface to the Tosh Protocol — launch creation, genesis deposits,
shelf minting, claims, referrals and the owner console.

Next.js (App Router) · React · TypeScript · wagmi + viem · Tailwind · Vitest.
Contracts and protocol documentation are in the [repository root](../README.md).

---

## Setup

```bash
npm install
npm run dev
```

`predev` runs `checkEnvShadow.mjs` first, so a misconfigured environment fails
before the dev server binds a port rather than halfway through a page load.

### Environment

`.env.local` — never committed:

```dotenv
NEXT_PUBLIC_FACTORY_ADDRESS=0x...
NEXT_PUBLIC_CHAIN_ID=46630           # 4663 for production
ROBINHOOD_RPC=https://...            # server-side only; where a KEYED endpoint goes
# NEXT_PUBLIC_RPC_URL=              # leave unset in production
POG_SIGNER_PRIVATE_KEY=0x...         # server-side only, never NEXT_PUBLIC_
```

Two rules the guards enforce, both learned the hard way:

**`NEXT_PUBLIC_CHAIN_ID` must name a chain `src/lib/chain.ts` registers.** An
unknown id throws at boot instead of falling back to a default, because a UI
silently pointed at a chain nobody asked for is worse than one that will not
start.

**A keyed RPC endpoint belongs in `ROBINHOOD_RPC` and nowhere else.**
`NEXT_PUBLIC_RPC_URL` is read first by both `providers.tsx` and `serverRpc.ts`,
so a keyed URL there ships the key in every browser bundle *and* preempts the
server-side variable — the paid node stays configured, stays billed, and is
never called. `npm run check:secrets` enforces both halves.

Supabase (project metadata and logo storage) and Upstash Redis (rate limits, the
gas-to-quota rate, the admin nonce) are configured through their own variables;
`npm run guard:supabase` and `npm run check:upstash` report what is missing.

---

## Routes

| Route | Purpose |
|---|---|
| `/` | Directory and genesis dashboard |
| `/launch` | Create a launch — duration picker, client-side CREATE2 salt mining |
| `/projects` | All launches, filtered by lifecycle phase |
| `/projects/[address]` | Project terminal: deposit, launch, mint, claim, LP, referral desk |
| `/referrals` | Aggregated referral ledger and per-project commission claims |
| `/r/[code]` | Referral short link — binds the referrer and forwards to the project |
| `/admin` | Owner console: monitors, parameters, buyback roster |

### API

| Endpoint | Purpose |
|---|---|
| `POST /api/sign-allocation` | Signs a PoG quota attestation. Ignores any caller-supplied nonce and reads the live on-chain value first. |
| `POST /api/pog-scan` | Multi-chain gas-history scan behind the quota. |
| `GET/POST /api/projects` | Project metadata registry. Writes require a signed attestation from the creator. |
| `GET /api/projects/lookup` | Resolve a project by hook, token, name or symbol. |
| `GET /api/projects/launch-tx` | Recover the `LaunchCreated` transaction hash for a hook, for metadata backfill. |
| `POST /api/projects/logo` | Logo upload to Supabase Storage. |
| `GET/POST /api/ref` | Referral code resolution and binding. |
| `GET/POST /api/admin/config` | Read and rotate `globalGasToSatoRate`. Owner-signed; accepts ERC-1271 so a Safe can authorise it. |

---

## Checks

```bash
npm run verify     # the full gate: tokens, tsc, eslint, guards, tests, build
```

That is what CI runs. The pieces, if you want them individually:

```bash
npx tsc --noEmit
npm run lint
npm test            # vitest
npm run guards      # all nine build-time guards
```

The guards exist because type checking cannot see across the boundary between
this app and the chain. Each one asserts something that TypeScript is structurally
unable to catch:

| Guard | Asserts |
|---|---|
| `guard:envshadow` | No `.env` file shadows another in a way that changes which value wins |
| `guard:chain` | The frontend's chain registry matches the contracts' |
| `guard:env` | No server-only secret is reachable under a `NEXT_PUBLIC_` name |
| `guard:chainaddr` | The built bundle names the chain and addresses it claims to |
| `guard:rpc` | RPC selection cannot silently prefer the free endpoint over the paid one |
| `guard:supabase` | Schema and policies match what the code queries |
| `guard:clmath` | The TS reimplementation of Infinity CL price math agrees with the Solidity |
| `guard:lpactions` | Encoded LP action calldata matches the deployed CLPositionManager's ABI shape |
| `guard:constants` | Every protocol constant mirrored in TS equals the on-chain value |

`guard:constants` and `guard:clmath` are the two that earn their keep most often:
a constant duplicated in TypeScript is a number that can drift from the contract
without anything failing to compile, and Infinity CL price math is where an off-by-one
in a `Q96` conversion produces a plausible-looking wrong answer.

Deployment-time checks that hit live services, run against a deployed URL rather
than in CI:

```bash
npm run check:deployed    # the built bundle points at the intended chain
npm run check:pog         # end-to-end quota flow against production
npm run check:storage     # the logo bucket exists and is configured
npm run check:secrets     # secret placement, incl. Vercel "Sensitive" storage
npm run check:sentry      # error reporting actually reports
```

### Design tokens

```bash
npm run tokens            # report
npm run tokens:strict     # fail on any raw value that should be a token
```

`tokens:strict` is part of `verify`, so a hardcoded colour or spacing value
fails the build rather than accumulating.
