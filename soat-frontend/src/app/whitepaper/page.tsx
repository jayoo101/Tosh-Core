import type { Metadata } from 'next'
import type { ComponentProps, ElementType } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'

import { requestDictionary } from '@/i18n/server'

const REPO = 'https://github.com/jayoo101/Tosh-Core'
const SOURCE = `${REPO}/blob/main/docs/WHITEPAPER_zh.md`
const RAW = 'https://raw.githubusercontent.com/jayoo101/Tosh-Core/main/docs/WHITEPAPER_zh.md'

/** The repository copy is the one people review, so the page reads it rather than a second copy. */
export const revalidate = 3600

export async function generateMetadata(): Promise<Metadata> {
  const t = (await requestDictionary()).dict.x
  return { title: t.metaWhitepaperTitle, description: t.metaWhitepaperDescription }
}

async function loadWhitepaper(): Promise<string | null> {
  try {
    const r = await fetch(RAW, { next: { revalidate } })
    return r.ok ? await r.text() : null
  } catch {
    return null
  }
}

/** Links between docs are relative in the repository; on this site they point back to GitHub. */
function href(url: string): string {
  if (/^(https?:|mailto:|#)/.test(url)) return url
  return `${REPO}/blob/main/docs/${url.replace(/^\.\//, '')}`
}

type Tag = 'h1' | 'h2' | 'h3' | 'h4' | 'p' | 'ul' | 'ol' | 'blockquote' | 'th' | 'td' | 'code' | 'pre'

/** react-markdown hands every element its syntax-tree `node`; it must not reach the DOM. */
function dom<P extends { node?: unknown }>(p: P): Omit<P, 'node'> {
  const rest = { ...p }
  delete rest.node
  return rest
}

function styled<T extends Tag>(Tag: T, className: string) {
  return function Styled(p: ComponentProps<T> & { node?: unknown }) {
    const Element = Tag as ElementType
    return <Element className={className} {...dom(p)} />
  }
}

const md: Components = {
  h1: styled('h1', 'text-hero text-text-primary'),
  h2: styled('h2', 'mt-10 border-b border-border-subtle pb-2 text-section text-text-primary'),
  h3: styled('h3', 'mt-6 text-title text-text-primary'),
  h4: styled('h4', 'mt-4 text-title text-text-secondary'),
  p: styled('p', ''),
  ul: styled('ul', 'list-disc space-y-1 pl-6'),
  ol: styled('ol', 'list-decimal space-y-1 pl-6'),
  blockquote: styled('blockquote', 'rounded-card border-l-2 border-brand bg-brand/5 px-4 py-3 [&>p]:m-0'),
  th: styled('th', 'border-b border-border-subtle bg-bg-subtle px-3 py-2 text-left font-bold text-text-primary'),
  td: styled('td', 'border-t border-border-subtle px-3 py-2 align-top'),
  code: styled('code', 'rounded bg-surface-hover px-1 py-0.5 font-mono text-[0.9em] text-text-primary'),
  pre: styled('pre', 'overflow-x-auto rounded-card bg-bg-subtle p-4 font-mono text-note [&_code]:bg-transparent [&_code]:p-0'),
  a: ({ href: url, ...p }) => {
    const to = href(url ?? '')
    const external = /^https?:/.test(to)
    return <a className="text-brand hover:underline" {...dom(p)} href={to} {...(external ? { target: '_blank', rel: 'noreferrer' } : {})} />
  },
  hr: () => <hr className="border-border-subtle" />,
  table: p => (
    <div className="overflow-x-auto rounded-card border border-border-subtle">
      <table className="w-full border-collapse text-note" {...dom(p)} />
    </div>
  ),
}

export default async function WhitepaperPage() {
  const { dict } = await requestDictionary()
  const t = dict.x
  const text = await loadWhitepaper()

  return (
    <main className="relative isolate">
      <div aria-hidden className="toshx-grid toshx-grid-dim" />
      <article className="relative z-10 mx-auto flex w-full max-w-[880px] flex-col gap-4 px-4 py-8 text-body text-text-secondary md:px-8">
        {text
          ? <ReactMarkdown remarkPlugins={[remarkGfm]} components={md}>{text}</ReactMarkdown>
          : <p>{t.whitepaperUnavailable}</p>}
        <p className="mt-8 text-note text-text-tertiary">
          <a className="text-brand hover:underline" href={SOURCE} target="_blank" rel="noreferrer">{t.whitepaperSource}</a>
        </p>
      </article>
    </main>
  )
}
