/**
 * A tab opened before a deploy still runs the old build, and its next lazy
 * chunk request 404s once the new deploy is live (Skew Protection only keeps
 * old builds for its max age). The thrown error reaches an error boundary as
 * a crash, but a reload fetches the current build and fixes it.
 */

const RELOADED_AT = 'tosh:stale-build-reload'
/** A second chunk failure this soon after reloading is a real fault, not a stale tab. */
const RELOAD_COOLDOWN_MS = 60_000

const CHUNK_FAILURE =
  /ChunkLoadError|Loading (CSS )?chunk [^ ]+ failed|Failed to load chunk|Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module/i

export function isStaleBuildError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  return CHUNK_FAILURE.test(`${error.name}: ${error.message}`)
}

/** Reloads the page and returns true when `error` is a stale-build chunk failure. */
export function reloadOnceForStaleBuild(error: unknown): boolean {
  if (!isStaleBuildError(error)) return false
  try {
    const last = Number(window.sessionStorage.getItem(RELOADED_AT) ?? 0)
    if (Date.now() - last < RELOAD_COOLDOWN_MS) return false
    window.sessionStorage.setItem(RELOADED_AT, String(Date.now()))
  } catch {
    return false
  }
  window.location.reload()
  return true
}
