/**
 * Re-export. The module lives at the repository root so diagnostics in both
 * `scripts/` trees share one copy; this file exists so every
 * `soat-frontend/scripts/*.mjs` import of `./lib/checkExit.mjs` keeps
 * resolving without a `../../..` that would be free to point at the wrong tree.
 */
export { CheckFailed, installFailureExit } from '../../../scripts/lib/checkExit.mjs'
