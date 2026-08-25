/**
 * /projects/[address] — MeritX invest/[address] layout (Tosh logic preserved).
 */

import { notFound } from 'next/navigation'
import Link from 'next/link'
import { AtSign, Globe, Send } from 'lucide-react'
import { createPublicClient, http } from 'viem'
import type { Address } from 'viem'

import { testnetExplorerAddress, FACTORY_ADDRESS, FACTORY_ABI, ERC20_ABI } from '@/lib/contracts'
import { targetChain } from '@/lib/chain'
import { supabase } from '../../lib/supabase'
import type { ProjectRow } from '../../lib/supabase'
import ProjectTerminal from '@/components/ProjectTerminal'
import { InvestLeftPanel } from '@/components/directory/InvestLeftPanel'

export const revalidate = 30

/** Scan recent factory launches to find a hook address for a known token. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function resolveHookAddress(client: any, tokenAddr: string): Promise<string | null> {
  try {
    const launchCount = await client.readContract({
      address: FACTORY_ADDRESS, abi: FACTORY_ABI, functionName: 'launchCount',
    }) as bigint
    const total = Number(launchCount)
    if (total === 0) return null
    const scanDepth = Math.min(48, total)
    const start = total - scanDepth
    const contracts = Array.from({ length: scanDepth }, (_, i) => ({
      address: FACTORY_ADDRESS as Address, abi: FACTORY_ABI, functionName: 'launches' as const,
      args: [BigInt(start + i)] as const,
    }))
    const results = await client.multicall({ contracts })
    for (const r of results) {
      if (r.status !== 'success') continue
      const [token, hook] = r.result as [Address, Address, Address, bigint]
      if (token.toLowerCase() === tokenAddr.toLowerCase()) return hook
    }
    return null
  } catch { return null }
}

/** On-chain fallback: build a synthetic ProjectRow from ERC-20 + factory data. */
async function getProjectFromChain(tokenAddr: string): Promise<ProjectRow | null> {
  try {
    const client = createPublicClient({ chain: targetChain, transport: http() })
    const addr = tokenAddr as Address
    const [nameRes, symbolRes] = await client.multicall({
      contracts: [
        { address: addr, abi: ERC20_ABI, functionName: 'name'   as const },
        { address: addr, abi: ERC20_ABI, functionName: 'symbol' as const },
      ],
    })
    const name   = nameRes.status   === 'success' ? (nameRes.result   as string) : addr.slice(0, 10)
    const symbol = symbolRes.status === 'success' ? (symbolRes.result as string) : '???'
    const hook   = await resolveHookAddress(client, tokenAddr)
    return {
      id:            tokenAddr,
      tx_hash:       '',
      token_address: tokenAddr,
      hook_address:  hook,
      name,
      symbol,
      logo_url:    null,
      website:     null,
      twitter:     null,
      telegram:    null,
      description: null,
      created_at:  new Date().toISOString(),
    }
  } catch { return null }
}

/**
 * Ceiling on the registry lookup.
 *
 * Supabase holds presentation metadata only — `getProjectFromChain` can answer
 * this route without it. But the client carries its own ~11 s timeout, so an
 * unreachable registry blocked the whole server render for that long before the
 * fallback even started, and the page read as hung rather than degraded.
 */
const REGISTRY_TIMEOUT_MS = 2_500

async function queryRegistry(raw: string): Promise<ProjectRow[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const lookup = supabase
      .from('projects')
      .select('*')
      .or(`token_address.ilike.${raw},hook_address.ilike.${raw}`)
      .limit(1)
    const ceiling = new Promise<null>(resolve => {
      timer = setTimeout(() => resolve(null), REGISTRY_TIMEOUT_MS)
    })
    const settled = await Promise.race([lookup, ceiling])
    if (settled === null) {
      console.warn('[getProject] registry lookup exceeded its ceiling, using on-chain data')
      return null
    }
    if (settled.error) {
      console.warn('[getProject] registry error, using on-chain data', settled.error.message)
      return null
    }
    return settled.data as ProjectRow[]
  } catch (e) {
    console.warn('[getProject] registry threw, using on-chain data', e)
    return null
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function getProject(address: string): Promise<ProjectRow | null> {
  const raw = address.trim()
  if (!/^0x[a-fA-F0-9]{40}$/.test(raw)) return null
  const rows = await queryRegistry(raw)
  // On-chain fallback covers both a dead registry and a launch that never
  // registered, so a valid on-chain project never hard 404s.
  return rows?.[0] ?? getProjectFromChain(raw)
}

function safeHref(url: string | null | undefined): string | null {
  if (!url) return null
  const t = url.trim()
  return /^https?:\/\//i.test(t) ? t : `https://${t}`
}

function shortAddr(a: string): string {
  return `${a.slice(0, 6)}…${a.slice(-4)}`
}

function projectManifesto(p: ProjectRow): string {
  if (p.description?.trim()) return p.description.trim()
  return `${p.name} ($${p.symbol}) runs on Tosh Protocol's three-phase lifecycle: PoG-gated genesis deposits in ETH, creator-triggered launch() at soft cap, then a 4000-rung discrete shelf ladder (up to 12.6M tokens, 105% price gate). Depositors claim pro-rata via claimGenesis(); failed genesis opens refund().`
}

function isoDate(iso: string): string {
  if (!iso) return '—'
  try { return new Date(iso).toISOString().slice(0, 10) } catch { return '—' }
}

type Props = { params: Promise<{ address: string }> }

export default async function ProjectDetailPage({ params }: Props) {
  const { address } = await params
  const p = await getProject(address)
  if (!p) notFound()

  const initial = (p.name || p.symbol || '?').charAt(0).toUpperCase()
  const tw = safeHref(p.twitter)
  const tg = safeHref(p.telegram)
  const web = safeHref(p.website)

  return (
    <div className="min-h-screen bg-bg-base text-text-primary font-sans">
      <main className="max-w-7xl mx-auto py-12 px-4 md:px-6 lg:px-8">
        <nav className="text-note font-mono text-text-tertiary flex items-center gap-2 mb-8">
          <Link href="/#directory" className="hover:text-brand transition-colors">Agent Directory</Link>
          <span>/</span>
          <span className="text-brand">{p.symbol}</span>
        </nav>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          {/* LEFT — MeritX invest column */}
          <div className="lg:col-span-2 flex flex-col gap-6">
            <div className="rounded-xl border border-border-subtle bg-surface-card/50 p-5">
              <div className="flex items-start gap-4">
                <div className="w-16 h-16 rounded-xl bg-bg-base border border-border-subtle flex items-center justify-center overflow-hidden shrink-0">
                  {p.logo_url
                    // eslint-disable-next-line @next/next/no-img-element
                    ? <img src={p.logo_url} alt={p.name} className="w-full h-full object-cover" />
                    : <span className="text-2xl font-black text-brand">{initial}</span>}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-mono text-brand mb-1">${p.symbol}</p>
                  <h1 className="text-2xl md:text-3xl font-black text-text-primary truncate">{p.name}</h1>
                  <div className="flex items-center gap-2 mt-3 flex-wrap">
                    {tw && (
                      <a href={tw} target="_blank" rel="noopener noreferrer"
                         className="w-9 h-9 rounded-lg bg-surface-card/80 border border-border-strong flex items-center justify-center text-text-tertiary hover:text-brand hover:border-brand/40 transition-colors">
                        <AtSign className="w-4 h-4" />
                      </a>
                    )}
                    {tg && (
                      <a href={tg} target="_blank" rel="noopener noreferrer"
                         className="w-9 h-9 rounded-lg bg-surface-card/80 border border-border-strong flex items-center justify-center text-text-tertiary hover:text-brand hover:border-brand/40 transition-colors">
                        <Send className="w-4 h-4" />
                      </a>
                    )}
                    {web && (
                      <a href={web} target="_blank" rel="noopener noreferrer"
                         className="w-9 h-9 rounded-lg bg-surface-card/80 border border-border-strong flex items-center justify-center text-text-tertiary hover:text-brand hover:border-brand/40 transition-colors">
                        <Globe className="w-4 h-4" />
                      </a>
                    )}
                  </div>
                  <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-label font-mono text-text-quiet">
                    <span>Created {isoDate(p.created_at)}</span>
                    {p.token_address && (
                      <a href={testnetExplorerAddress(p.token_address)} target="_blank" rel="noopener noreferrer" className="hover:text-brand transition-colors">
                        Token {shortAddr(p.token_address)}
                      </a>
                    )}
                    {p.hook_address && (
                      <a href={testnetExplorerAddress(p.hook_address)} target="_blank" rel="noopener noreferrer" className="hover:text-brand transition-colors">
                        Hook {shortAddr(p.hook_address)}
                      </a>
                    )}
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-border-subtle bg-surface-card/50 p-5">
              <div className="text-label font-bold text-text-tertiary uppercase tracking-widest mb-3 font-mono">{`/// Project Manifesto`}</div>
              <p className="text-sm text-text-secondary leading-relaxed whitespace-pre-wrap">
                {projectManifesto(p)}
              </p>
            </div>

            <InvestLeftPanel project={p} />
          </div>

          {/* RIGHT — sticky action terminal */}
          <div className="lg:col-span-1">
            <div className="sticky top-24">
              <ProjectTerminal project={p} />
            </div>
          </div>
        </div>
      </main>
    </div>
  )
}
