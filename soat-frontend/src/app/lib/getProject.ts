import { zeroAddress } from 'viem'
import type { Address } from 'viem'

import { FACTORY_ADDRESS, FACTORY_ABI, HOOK_ABI, ERC20_ABI } from '@/lib/contracts'
import { serverPublicClient } from '@/app/lib/serverRpc'
import {
  supabase,
  REGISTRY_READ_DEADLINE_MS,
  type ProjectRow,
} from '@/app/lib/supabase'

/**
 * Three outcomes, not two.
 *
 * `null` used to mean both "there is no launch at this address" and "we could
 * not find out", and the caller turned either into a 404 that the loader
 * renders as "No launch at this address". So an RPC outage produced a
 * confident denial that a real, funded project exists.
 *
 * They are different answers with different lifetimes: `not-found` is
 * cacheable and stable, `unavailable` is transient and must be retried. Only
 * the lookup route consumes this, so distinguishing them costs one union.
 */
export type ProjectLookup =
  | { status: 'found'; row: ProjectRow }
  | { status: 'not-found' }
  | { status: 'unavailable' }

function isAddress(raw: string): raw is Address {
  return /^0x[a-fA-F0-9]{40}$/.test(raw)
}

async function queryRegistry(raw: string): Promise<ProjectRow | null> {
  // `raw` is interpolated into a PostgREST filter EXPRESSION, where a comma or
  // a dot is syntax rather than data. Every caller today validates the address
  // first, so this has never been reachable — but the guard belongs next to
  // the interpolation, not one call frame away, or the next caller inherits a
  // filter injection without knowing there was a contract to honour.
  if (!isAddress(raw)) return null

  try {
    // The ceiling used to be a `Promise.race` against a `setTimeout`, which
    // bounded only how long THIS function waited: the query itself kept going,
    // and since supabase-js retries four times with backoff, an unreachable
    // registry left a chain of attempts running behind an answer nobody was
    // reading any more. `abortSignal` bounds the operation instead of the wait
    // on it, so the work stops when the interest in it does.
    const { data, error } = await supabase
      .from('projects')
      .select('*')
      .or(`token_address.ilike.${raw},hook_address.ilike.${raw}`)
      // A token can carry more than one row. Without an order, Postgres is
      // free to return whichever it likes, so which metadata a visitor saw was
      // nondeterministic between requests. Oldest-first matches what the
      // directory grid already resolves to, so both surfaces agree.
      .order('created_at', { ascending: true })
      .limit(1)
      .abortSignal(AbortSignal.timeout(REGISTRY_READ_DEADLINE_MS))

    // A timeout arrives here as an error, and is treated exactly as a miss
    // was before: the caller's chain read is already in flight, and it is the
    // one that can distinguish "no such project" from "could not look".
    if (error) return null
    return (data?.[0] as ProjectRow | undefined) ?? null
  } catch {
    return null
  }
}

/**
 * One mapping read, not a 48-launch scan.
 *
 * `factory.tokenToHook` is the canonical token → hook index. The previous
 * fallback walked `launches(i)` backwards, which is why a cold project page
 * sat on a loading shell for several seconds after the registry had already
 * given up.
 */
async function getProjectFromChain(tokenOrHook: string): Promise<ProjectLookup> {
  try {
    const client = serverPublicClient()
    const addr = tokenOrHook as Address

    const hookFromToken = await client.readContract({
      address: FACTORY_ADDRESS,
      abi: FACTORY_ABI,
      functionName: 'tokenToHook',
      args: [addr],
    }) as Address

    let token: Address = addr
    let hook: Address = hookFromToken

    if (hook === zeroAddress) {
      // URL might already be the hook. `projectToken` reverts on anything else.
      try {
        const maybeToken = await client.readContract({
          address: addr,
          abi: HOOK_ABI,
          functionName: 'projectToken',
        }) as Address
        if (maybeToken && maybeToken !== zeroAddress) {
          token = maybeToken
          hook = addr
        }
      } catch {
        // `projectToken` reverts on any address that is not one of our hooks,
        // and the factory already said it is not one of our tokens. That is a
        // real absence, not a failure to look.
        return { status: 'not-found' }
      }
    }

    // Two plain reads rather than `multicall`. viem's `foundry` chain declares
    // no Multicall3 and anvil does not predeploy one, so the batched form did
    // not degrade per call there — it threw, and took every chain-fallback
    // lookup on the devnet with it. That is precisely where this path gets
    // exercised, so the batching saved one round trip on two calls at the cost
    // of the fallback being untestable.
    //
    // A Tosh token's `name()` does not revert, so a rejection here is the RPC.
    // The honest answer is "ask again", not a plausible-looking fabrication in
    // a row typed identically to a real one — hence no per-call salvage.
    const [name, symbol] = await Promise.all([
      client.readContract({ address: token, abi: ERC20_ABI, functionName: 'name' }),
      client.readContract({ address: token, abi: ERC20_ABI, functionName: 'symbol' }),
    ])

    return {
      status: 'found',
      row: {
        id:            token,
        tx_hash:       '',
        token_address: token,
        hook_address:  hook,
        name:   name   as string,
        symbol: symbol as string,
        logo_url:    null,
        website:     null,
        twitter:     null,
        telegram:    null,
        description: null,
        // Empty rather than `now`: this row was assembled from chain reads and
        // nobody knows when the launch happened. Stamping the current time
        // invented a field that is indistinguishable from a registry row's
        // real one. Nothing renders it, and only registry rows are ordered by
        // it, so absence is safe and a lie is not.
        created_at:  '',
      },
    }
  } catch {
    // A throw out of `createPublicClient`/`readContract` is transport, not a
    // verdict on whether the project exists.
    return { status: 'unavailable' }
  }
}

export async function getProject(address: string): Promise<ProjectLookup> {
  const raw = address.trim()
  if (!isAddress(raw)) return { status: 'not-found' }
  const chain = getProjectFromChain(raw)
  const row = await queryRegistry(raw)
  if (row) return { status: 'found', row }
  return chain
}
