/**
 * Predicates over a `ProjectRow` that BOTH the server and the browser need.
 *
 * `ProjectRow` itself is declared in `app/lib/supabase.ts`, and it can stay
 * there because a type import is erased. A function cannot be: that module calls
 * `createClient` at module scope, so importing a helper out of it from a client
 * component would ship `@supabase/supabase-js` to the browser to answer a
 * question about a string. Hence this file, which imports nothing.
 */

import type { ProjectRow } from '@/app/lib/supabase'

/**
 * Was this row assembled from chain reads because the registry had none?
 *
 * `getProjectFromChain` fills `tx_hash` with `''` deliberately, so that a
 * fallback row is distinguishable from a real one, and `POST /api/projects`
 * validates the hash against `/^0x[0-9a-fA-F]{64}$/` before inserting — so a
 * registry row always carries one and a chain-only row never does.
 *
 * The distinction was already being relied on by eye. It is a named predicate
 * because a second reader has appeared: the creator's own project page offers to
 * publish the missing listing, and it may only do so when there is genuinely no
 * row to overwrite. A bare `!row.tx_hash` at that call site would read as a
 * defensive null check rather than as the load-bearing question it is.
 */
export function isUnlisted(row: Pick<ProjectRow, 'tx_hash'>): boolean {
  return !row.tx_hash
}
