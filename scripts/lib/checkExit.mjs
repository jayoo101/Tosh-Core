/**
 * How a `check:*` script stops when it has a finding.
 *
 * ── The bug this exists to prevent ─────────────────────────────────────────
 *
 * Every diagnostic used to end a failure with `process.exit(1)` from inside its
 * own `fail()`, or with one `process.exit` after a completed `fetch`. On Node
 * 24 / Windows, exiting the process after a `fetch` aborts inside libuv:
 *
 *     Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c:76
 *
 * The undici socket is still open, `process.exit` tears the event loop down under
 * it, and the run ends at exit code **0xC0000409** with a C assertion printed
 * after the diagnostic. Three things go wrong at once: the FAIL message scrolls
 * away behind the assertion, the exit code is not 1 so a caller testing for it
 * sees something it has no case for, and a genuine finding about production
 * presents as a crash in the tool. A guard whose failure path looks like a bug in
 * the guard is a guard whose output gets dismissed — which is the opposite of
 * what these scripts are for.
 *
 * Verified with a minimal reproduction rather than inferred: `fetch` then
 * `process.exit(1)` aborts; `fetch` then `process.exitCode = 1` and a natural
 * drain exits 1 cleanly, in under a second of keep-alive.
 *
 * ── Why it lives here, not under soat-frontend ─────────────────────────────
 *
 * The first five consumers were in `soat-frontend/scripts/`. A count of those
 * against the comment that described them found a sixth family in *this*
 * directory — the same `fetch` + `process.exit` pairing, the same crash, and
 * the scripts a human reaches for when something is already on fire
 * (`checkBlockscoutKey`, `checkStatusPage`, `checkFooterLinks`,
 * `checkDrillPage`, `drillQ1`, `verifyOwnerSafe`). A module that only the
 * frontend tree can import cannot protect them. This file is the one copy;
 * `soat-frontend/scripts/lib/checkExit.mjs` re-exports it so existing relative
 * imports keep resolving.
 *
 * ── Why it is a throw and not a return ─────────────────────────────────────
 *
 * `fail()` is called from inside helpers — a `catch` around a `fetch`, a URL
 * parser, the middle of a loop — and every one of its call sites is written on
 * the assumption that nothing after it runs. `process.exit()` gave that for free.
 * A return value would have to be checked at every call site, and the one that
 * got missed would carry on and read a variable the failure proved was unusable.
 * A throw keeps the guarantee.
 *
 * Scripts that collect every finding and decide once at the end — the
 * `checkDeployedChain` / `checkStatusPage` shape — do not throw. They set
 * `process.exitCode` and let the loop drain. `CheckFailed` has nothing to model
 * there; `installFailureExit` still covers their unguarded fetches.
 *
 * ── Why both events ────────────────────────────────────────────────────────
 *
 * These scripts are ESM modules using top-level `await`, so a throw escapes
 * module evaluation and there is no `catch` to put it in. Which event it arrives
 * as depends on where in evaluation it happened, and an unhandled one restores
 * the exact crash described above — Node's own fatal path is what calls `exit`
 * with sockets still open. So both are registered, and `installFailureExit()` is
 * called before the first await.
 *
 * Usage:
 *
 *     import { CheckFailed, installFailureExit } from './lib/checkExit.mjs'
 *     installFailureExit()
 *
 *     function fail(message, detail) {
 *       console.log(`\nFAIL  ${message}`)
 *       if (detail) console.log(detail)
 *       throw new CheckFailed(message)
 *     }
 *
 *     // Or, at the end of a collecting script:
 *     process.exitCode = failures === 0 ? 0 : 1
 *
 * A second constructor argument sets a code other than 1 — `2` is "the check
 * could not run", which several scripts here distinguish from "the check ran
 * and found a problem". Callers that do not need the split omit it.
 */

/** A finding, already reported by `fail()`. Carries no stack worth printing. */
export class CheckFailed extends Error {
  constructor(message, exitCode = 1) {
    super(message)
    this.name = 'CheckFailed'
    this.exitCode = exitCode
  }
}

/**
 * Route a `fail()` throw to a clean exit, without tearing down live sockets.
 *
 * Anything that is NOT a `CheckFailed` is a bug in the calling script rather than
 * a finding about the project, and gets its stack printed — the distinction is
 * worth keeping, because a silent exit 1 on a `TypeError` would look exactly like
 * a detected problem and send someone to investigate production.
 */
export function installFailureExit() {
  const terminate = (err) => {
    process.exitCode = err instanceof CheckFailed ? err.exitCode : 1
    if (!(err instanceof CheckFailed)) console.error(err)
  }
  process.on('uncaughtException', terminate)
  process.on('unhandledRejection', terminate)
}
