import type { Address, Chain } from 'viem'
import { foundry, robinhood, robinhoodTestnet } from 'viem/chains'

/**
 * Settlement chain the UI talks to.
 *
 * `NEXT_PUBLIC_CHAIN_ID` is the switch.  POOL_MANAGER stays a source-code
 * constant in `contracts.ts` (a wrong one silently mis-CREATE2s every hook);
 * everything else — periphery addresses, explorer URLs, wagmi's chain list —
 * follows this id so a mainnet cutover is env, not a rebuild of the UI.
 *
 * The default is the public TESTNET, not production: an unset variable should
 * land somewhere harmless, and of the two that is the one where a mistake costs
 * nothing. Production is chain 4663; the public testnet is 46630.
 */
function parseChainId(): number {
  const raw = process.env.NEXT_PUBLIC_CHAIN_ID
  const n = raw ? Number(raw) : 46630
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 46630
}

export const TARGET_CHAIN_ID = parseChainId()
export const ROBINHOOD_ID = 4663 as const
export const ROBINHOOD_TESTNET_ID = 46630 as const
export const FOUNDRY_CHAIN_ID = 31337 as const

const CHAINS_BY_ID: Record<number, Chain> = {
  [ROBINHOOD_ID]: robinhood,
  [ROBINHOOD_TESTNET_ID]: robinhoodTestnet,
  [FOUNDRY_CHAIN_ID]: foundry,
}

/**
 * Throws rather than falling back, and that is a deliberate reversal.
 *
 * This used to read `CHAINS_BY_ID[TARGET_CHAIN_ID] ?? baseSepolia`, so an id
 * nobody had registered produced a working UI pointed at a *different chain*
 * than the operator asked for — silently, with the wrong explorer links and the
 * wrong periphery addresses, and no way to notice short of reading a block
 * number. That is the same failure `envAddress` was rewritten to eliminate (see
 * its comment below): a fallback that is indistinguishable from success.
 *
 * A boot-time throw is loud, immediate, and impossible to ship past.
 */
function resolveTargetChain(): Chain {
  const chain = CHAINS_BY_ID[TARGET_CHAIN_ID]
  if (!chain) {
    throw new Error(
      `[chain] NEXT_PUBLIC_CHAIN_ID=${TARGET_CHAIN_ID} is not a chain this build knows. ` +
      `Supported: ${Object.keys(CHAINS_BY_ID).join(', ')}. Add it to CHAINS_BY_ID in src/lib/chain.ts.`,
    )
  }
  return chain
}

export const targetChain: Chain = resolveTargetChain()

/**
 * Chains the Proof-of-Gas signing path accepts.
 *
 * The local devnet is included only when this is NOT a production build. It used
 * to be unconditional, so a deployed production build accepted `chainId: 31337`
 * and carried the request all the way to an RPC attempt against loopback before
 * failing 503. That fails closed, and the attestation digest binds
 * `block.chainid` so a 31337-bound signature is unusable on 4663 — but it is a
 * chain the deployment can never serve, reached through the oracle's own signing
 * path, and "the only thing stopping it is that nothing listens on localhost" is
 * not a control.
 *
 * `next build` sets `NODE_ENV=production` for a testnet deployment too, which is
 * the wanted behaviour: a deployed testnet build has no loopback node either. A
 * developer running `next dev` against the public testnet keeps the devnet.
 *
 * Exported only as a predicate, and the list is not exported, because this
 * decision used to be written twice — here, and again inline in
 * `onchainNonce.ts` as `chainId !== TARGET_CHAIN_ID && chainId !== FOUNDRY_CHAIN_ID`.
 * Two copies of one allowlist is the shape that let the PoG deadline drift; see
 * the PoG deadline drift in SECURITY.md.
 */
const SUPPORTED_POG_CHAIN_IDS: readonly number[] =
  process.env.NODE_ENV !== 'production' && TARGET_CHAIN_ID !== FOUNDRY_CHAIN_ID
    ? [TARGET_CHAIN_ID, FOUNDRY_CHAIN_ID]
    : [TARGET_CHAIN_ID]

export function isSupportedPogChain(chainId: number): boolean {
  return SUPPORTED_POG_CHAIN_IDS.includes(chainId)
}

/** For error messages that need to name what IS accepted. */
export function supportedPogChainLabel(): string {
  return SUPPORTED_POG_CHAIN_IDS.join(', ')
}

/**
 * The chain Tosh settles on — a positioning statement, NOT where this build is
 * pointed. It reads the same on staging as in production, deliberately: the
 * product's answer to "what chain is this" should not change because someone is
 * looking at a testnet deployment.
 */
export const MAINNET_CHAIN_LABEL = 'Robinhood Chain'

/**
 * Where this build is ACTUALLY pointed, whatever that is.
 *
 * Was `TESTNET_CHAIN_LABEL`, and that name was the bug: it asserts something
 * the value does not carry. On a mainnet build this holds "Ethereum", so the
 * five call sites that printed a literal "testnet" beside it would have
 * rendered "testnet Ethereum" — in the footer, on every page. Consult
 * `IS_TESTNET` for that distinction; the label alone cannot tell you.
 */
export const ACTIVE_CHAIN_LABEL =
  TARGET_CHAIN_ID === FOUNDRY_CHAIN_ID ? 'Foundry'
  : targetChain.name

/** Whether this build talks to something other than a production mainnet. */
export const IS_TESTNET = TARGET_CHAIN_ID !== ROBINHOOD_ID

/**
 * The one-line "where are we" byline used by the chrome that carries it:
 * navbar, footer, admin header, user drawer.
 *
 * Those four each built this string by hand and each hard-coded the word
 * "testnet". One derived value is what stops the mainnet cutover from having to
 * remember four places.
 *
 * The testnet arm deliberately stops at "· testnet" instead of appending
 * `ACTIVE_CHAIN_LABEL`. Under Base the settlement chain and the staging chain
 * had different names ("Ethereum · testnet Base Sepolia"), so naming both said
 * something; here they are the same family, and the honest version of that
 * sentence is "Robinhood Chain · testnet Robinhood Chain Testnet" — which says
 * the name twice and adds nothing. `checkChainCopy.mjs` fails the build on
 * exactly that repetition, which is how this was caught rather than shipped.
 */
export const CHAIN_BYLINE = !IS_TESTNET
  ? MAINNET_CHAIN_LABEL
  : TARGET_CHAIN_ID === FOUNDRY_CHAIN_ID
    ? `${MAINNET_CHAIN_LABEL} · devnet ${ACTIVE_CHAIN_LABEL}`
    : `${MAINNET_CHAIN_LABEL} · testnet`

/**
 * Where this build is pointed, as a badge. The old fallback rendered a bare
 * `CHAIN 31337`, which says nothing to anyone who does not already know the
 * number.
 */
export const CHAIN_STATUS_BADGE = !IS_TESTNET
  ? `MAINNET · ${MAINNET_CHAIN_LABEL.toUpperCase()}`
  : TARGET_CHAIN_ID === FOUNDRY_CHAIN_ID
    ? `DEVNET · ${ACTIVE_CHAIN_LABEL.toUpperCase()}`
    : `TESTNET · ${MAINNET_CHAIN_LABEL.toUpperCase()}`

/**
 * The hero sentence. Derived from `IS_TESTNET` rather than enumerated per
 * chain, which is what let the old fallback emit "Settled on Foundry." — a
 * claim that a local devnet is the settlement chain, on the most prominent
 * line of the landing page.
 */
export const CHAIN_POSITIONING = !IS_TESTNET
  ? `Settled on ${MAINNET_CHAIN_LABEL}.`
  : TARGET_CHAIN_ID === FOUNDRY_CHAIN_ID
    ? `Settlement on ${MAINNET_CHAIN_LABEL} — currently running against a local devnet.`
    : `Settlement on ${MAINNET_CHAIN_LABEL} — currently staging on the public testnet.`

/**
 * Whether `CHAIN_STATUS_BADGE` already names the settlement chain.
 *
 * The landing hero shows the badge and, beside it, a "Settles on X" line. That
 * second line was gated on `IS_TESTNET`, which reads as though it were the
 * question being asked and is not: look at the badge's arms and BOTH the
 * mainnet and testnet ones interpolate `MAINNET_CHAIN_LABEL`. Only the devnet
 * arm names something else. So on the public testnet — the build everyone has
 * actually been looking at — the badge said "TESTNET · ROBINHOOD CHAIN" and
 * the line beside it said "Settles on Robinhood Chain", which is the same
 * sentence twice, forty pixels apart.
 *
 * Derived from the badge rather than from the chain, because "does the badge
 * already say this" is the actual question. Retuning `CHAIN_STATUS_BADGE`
 * cannot now leave the hero repeating itself, and cannot leave it silent about
 * settlement on a devnet either.
 *
 * `checkChainCopy.mjs` evaluates this on all three chains.
 */
export const BADGE_NAMES_SETTLEMENT_CHAIN =
  CHAIN_STATUS_BADGE.includes(MAINNET_CHAIN_LABEL.toUpperCase())

/**
 * The provisional-status caveat ALONE, with no settlement chain in it.
 *
 * `CHAIN_POSITIONING` carries both halves — "Settlement on Robinhood Chain"
 * plus "currently staging on the public testnet" — which is right for a
 * standalone sentence and wrong directly under an `<h1>` that already ends in
 * the chain's name. The hero was naming the chain in the badge, in the line
 * beside the badge, in the headline, and again three words into the paragraph
 * below it: four times above the fold.
 *
 * Empty on mainnet, and that is the correct value rather than a missing one.
 * There is nothing provisional to disclose, and the headline has already said
 * where this settles.
 *
 * MUST NOT name `MAINNET_CHAIN_LABEL`. That is the whole invariant, and
 * `checkChainCopy.mjs` asserts it on every chain — this constant exists only
 * to be the half that does not repeat the headline.
 */
export const CHAIN_STAGING_NOTE = !IS_TESTNET
  ? ''
  : TARGET_CHAIN_ID === FOUNDRY_CHAIN_ID
    ? 'Currently running against a local devnet.'
    : 'Currently staging on the public testnet.'

/**
 * Read off the chain definition rather than enumerated here.
 *
 * The enumerated version had a `return 'https://sepolia.basescan.org'` as its
 * final line, so every chain it did not recognise — including the local devnet,
 * which has no explorer at all — produced links pointing at Base Sepolia. They
 * rendered, they were clickable, and they resolved to "not found" for a
 * transaction that had certainly succeeded.
 *
 * `viem` carries the explorer with the chain, so the two cannot drift, and a
 * chain genuinely without one is now visible as such instead of borrowing
 * somebody else's.
 */
function explorerBase(): string | undefined {
  return targetChain.blockExplorers?.default.url
}

/** Whether links produced by the helpers below will go anywhere. */
export const HAS_EXPLORER = explorerBase() !== undefined

/**
 * `undefined` when the target chain has no explorer, rather than a string built
 * around one. Interpolating a missing base would yield the literal
 * `undefined/tx/0x…`, which renders as a link and fails as one; the type makes
 * callers decide what to show instead, and `AddressLink` degrades to plain text.
 */
export function testnetExplorerTx(hash: string): string | undefined {
  const base = explorerBase()
  return base && `${base}/tx/${hash}`
}

export function testnetExplorerAddress(addr: string): string | undefined {
  const base = explorerBase()
  return base && `${base}/address/${addr}`
}

/**
 * Validate an override read from the environment, falling back when it is
 * absent or malformed.
 *
 * Takes the VALUE, not the variable name, and that is the whole point. This
 * used to take a name and do `process.env[name]`, which never worked in the
 * browser: Next.js inlines `NEXT_PUBLIC_*` by substituting the literal text
 * `process.env.NEXT_PUBLIC_FOO`, so a computed member access is not a
 * substitution target and `process.env` is simply an empty object on the
 * client. Every override silently resolved to `fallback`.
 *
 * That failed in the worst possible way. The fallbacks ARE the testnet
 * addresses, so nothing looked wrong until the one deploy where it mattered:
 * an operator who correctly set `NEXT_PUBLIC_POSITION_MANAGER` for the mainnet
 * cutover (PM-B4) would have shipped a build whose LP panel still encoded
 * calls to the Sepolia PositionManager. No runtime assertion could have caught
 * it — the value is gone at build time, not at run time.
 *
 * So call sites must write the access out in full:
 *
 *     envAddress(process.env.NEXT_PUBLIC_POSITION_MANAGER, FALLBACK)
 *
 * and not hand this function a name to look up.
 */
export function envAddress(value: string | undefined, fallback: Address): Address {
  if (typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value.trim())) {
    return value.trim() as Address
  }
  return fallback
}
