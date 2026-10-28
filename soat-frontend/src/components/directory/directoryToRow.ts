import type { DirectoryProject } from './useDirectoryProjects'
import { TARGET_CHAIN_ID } from '@/lib/contracts'
import type { ProjectRow } from '@/app/lib/supabase'

/** A directory entry as the registry row the project page caches and paints from. */
export function directoryToRow(p: DirectoryProject): ProjectRow {
  return {
    id:            p.token,
    // The directory only ever lists this deployment's chain, so the row it
    // synthesises belongs to it too. The return type is annotated rather than
    // inferred so a new `ProjectRow` column fails to compile here.
    chain_id:      TARGET_CHAIN_ID,
    tx_hash:       '',
    token_address: p.token,
    hook_address:  p.hook,
    name:          p.name,
    symbol:        p.symbol,
    logo_url:      p.logoUrl,
    website:       p.website,
    twitter:       p.twitter,
    telegram:      null,
    description:   p.description,
    created_at:    new Date(Number(p.createdAt) * 1000).toISOString(),
  }
}
