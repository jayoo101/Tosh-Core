# Tosh dApp

The web interface to ToshX v3 — launch creation, the Agent ID GENESIS sale,
the Agent ID–gated shelf ladder, the pre-launch bid market, portfolios and the
operator console. Production ([toshx.xyz](https://toshx.xyz)) runs against the
v3 deployment on BNB Smart Chain `56`.

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

`.env.local` — never committed. `.env.production.example` is the full list:

```dotenv
NEXT_PUBLIC_CHAIN_ID=97              # 56 for production
NEXT_PUBLIC_TOSH_STACK=v3            # v3 in production; unset means v2
NEXT_PUBLIC_V2_FACTORY_BNB=0x...     # ToshFactoryV3 raising in BNB
NEXT_PUBLIC_V2_FACTORY_USDT=0x...    # ToshFactoryV3 raising in USDT
NEXT_PUBLIC_V2_LEGACY_FACTORIES_BNB=0x...,0x...   # earlier factories: listed and tradable, no new launches
NEXT_PUBLIC_V2_LEGACY_FACTORIES_USDT=0x...
NEXT_PUBLIC_V2_BIDBOOK=0x...
NEXT_PUBLIC_V2_LENS=0x...            # ToshHookLensV3
NEXT_PUBLIC_V2_FROM_BLOCK=...        # deploy block, where log scans start
BSC_RPC=https://...                  # server-side only; keyed mainnet endpoint
BSC_TESTNET_RPC=https://...          # server-side only; keyed testnet endpoint
# NEXT_PUBLIC_RPC_URL=              # leave unset in production
```

The `V2` in the variable names is historical: v3 kept v2's interfaces, so one
set of names serves both, and `NEXT_PUBLIC_TOSH_STACK` says which deployment
they point at (supply constants differ: 21M on v2, 2.1B on v3). The production
values are in [`deployments/v3-56.json`](../deployments/v3-56.json).
`src/lib/v2/config.ts` reads them and re-checksums each address, so a value
pasted with its case mangled still works. `node scripts/genV2Abis.mjs`
regenerates `src/lib/v2/abis.ts` from the Foundry artefacts, and `--check` fails
when they have drifted.

Two rules the guards enforce, both learned the hard way:

**`NEXT_PUBLIC_CHAIN_ID` must name a chain `src/lib/chain.ts` registers.** An
unknown id throws at boot instead of falling back to a default, because a UI
silently pointed at a chain nobody asked for is worse than one that will not
start.

**A keyed RPC endpoint belongs in `BSC_RPC` / `BSC_TESTNET_RPC` and nowhere else.**
`NEXT_PUBLIC_RPC_URL` is read first by both `providers.tsx` and `serverRpc.ts`,
so a keyed URL there ships the key in every browser bundle *and* preempts the
server-side variable — the paid node stays configured, stays billed, and is
never called. `npm run check:secrets` enforces both halves.

Supabase (project metadata, logo storage and the on-chain event index) and Upstash
Redis (rate limits) are configured through their own variables;
`npm run guard:supabase` and `npm run check:upstash` report what is missing.

---

## Routes

| Route | Purpose |
|---|---|
| `/` | Homepage: featured raise and live feed |
| `/launchpad` | Raises in GENESIS |
| `/launched` | Launched projects |
| `/market` | Pre-launch bid market |
| `/launch/v2` | Create a launch (`/launch` redirects here) |
| `/projects/[address]` | Project terminal: GENESIS buy, launch, shelf mint, fund withdrawal |
| `/projects/[address]/market` | The project's bid book |
| `/register` | Agent ID registration |
| `/portfolio` | A wallet's GENESIS buys, bids and holdings |
| `/apply` | Project application form |
| `/admin` | Operator console: launch roster, featured project |

### API

| Endpoint | Purpose |
|---|---|
| `GET/POST /api/projects` | Project metadata registry. Writes require a signed attestation from the creator. |
| `GET /api/projects/lookup` | Resolve a project by hook, token, name or symbol. |
| `GET /api/projects/launch-tx` | Recover the `LaunchCreated` transaction hash for a hook, for metadata backfill. |
| `POST /api/projects/logo` | Logo upload to Supabase Storage. |
| `GET /api/v2/index` | Cron: indexes factory, hook and bid-book events into Supabase. |
| `GET /api/v2/genesis-buys`, `/bids`, `/trades`, `/portfolio` | Reads over that index. |
| `GET/POST /api/admin/featured` | Homepage pin and cover, behind `CONTENT_ADMIN_SECRET`. |
| `POST /api/apply` | Forwards a project application to the review group. |

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
npm run guards      # all build-time guards
```

The guards exist because type checking cannot see across the boundary between
this app and the chain. Each one asserts something that TypeScript is structurally
unable to catch:

| Guard | Asserts |
|---|---|
| `guard:envshadow` | No `.env` file shadows another in a way that changes which value wins |
| `guard:chain` | Chain copy and tickers come from the chain registry, not literals |
| `guard:env` | No server-only secret is reachable under a `NEXT_PUBLIC_` name |
| `guard:chainaddr` | The built bundle names the chain and addresses it claims to |
| `guard:rpc` | RPC selection cannot silently prefer the free endpoint over the paid one |
| `guard:supabase` | Every Supabase query carries a deadline |
| `guard:constants` | Every protocol constant mirrored in `V2` equals the Solidity value |
| `guard:payable` | Every call to a payable function sends a `value` |
| `guard:walletchain` | Nothing asks wagmi's `useChainId` for the wallet's chain, which it cannot answer |
| `guard:i18n` | Every locale agrees with English on keys, placeholders and markup |
| `guard:guardcoverage` | Every CI-runnable guard is wired into `frontend.yml` |

Deployment-time checks that hit live services, run against a deployed URL rather
than in CI:

```bash
npm run check:deployed    # the built bundle points at the intended chain
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
