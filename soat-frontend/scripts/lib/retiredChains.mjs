/**
 * Re-export, for the reason `./checkExit.mjs` gives: the module lives at the
 * repository root so both `scripts/` trees share ONE list, and this file exists
 * so imports from here stay `./lib/retiredChains.mjs` rather than a `../../..`
 * that is free to point at the wrong tree.
 *
 * Sharing the list is the whole point rather than a tidiness preference. A
 * second copy is how `checkStatusPage.mjs` nearly shipped a departed-chain
 * check that was green on one side and blind on the other.
 */
export { RETIRED_CHAINS, retiredChain, refuseIfRetired } from '../../../scripts/lib/retiredChains.mjs'
