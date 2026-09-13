#!/usr/bin/env node
/*
 * checkFooterLinks.mjs
 * ────────────────────
 * Resolves the external links the site shows its users.
 *
 * There is currently one, and it was wrong. `SiteFooter.tsx` pointed "GitHub"
 * at `github.com/tosh-protocol` — a plausible name for an organisation that has
 * never existed — so the single link on the site that invites a reader to stop
 * trusting us and read the source answered 404 instead. It shipped that way,
 * and every guard in this repository was green while it did, because no guard
 * had ever looked outward from the frontend.
 *
 * That is the same shape as the bug found the same day in `checkStatusPage.mjs`,
 * where the page named a real mainnet factory that was merely the wrong one.
 * Both are references to something outside the tree, both were written once and
 * never re-read, and both looked exactly like working links. The cheap defence
 * is not review, it is a request.
 *
 * Two things are checked, and the second is the one with teeth:
 *   1. Every external href in the frontend's components resolves. A 404 here is
 *      worse than no link — a dead source link reads as a project with
 *      something to hide, which is the precise opposite of why it is there.
 *   2. The GitHub link points at *this* repository, resolved from `git remote`
 *      rather than from a constant in this file. A link that resolves is not
 *      enough: `github.com/tosh-protocol` would have passed check 1 the moment
 *      somebody registered that name, while still not being the source of the
 *      site the reader is standing on.
 *
 * Only `src/components` is scanned, deliberately. `src/app` and the tests are
 * full of `https://tosh.test/...` and `https://cdn.test/logo.png` fixtures and
 * of placeholder URLs like the `https://your-agent.xyz` in a form's
 * `placeholder`, none of which are meant to resolve. Widening the net would
 * mean an allowlist, and an allowlist is where the next dead link will hide.
 *
 * Usage:  node scripts/checkFooterLinks.mjs
 * Exits 1 on a bad link, 2 when the network prevented an answer — a blocked
 * runner is not a broken site and the two are deliberately different codes.
 */

import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { installFailureExit } from './lib/checkExit.mjs'

installFailureExit()

const REPO_ROOT  = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const COMPONENTS = path.join(REPO_ROOT, 'soat-frontend', 'src', 'components')

const bad = []
const unreachable = []

/** Retries transient failures but not 4xx, on the reasoning in
 *  `checkStatusPage.mjs`: a blip between CI and GitHub should not redden an
 *  unrelated pull request, and retrying a 404 three times only delays it. */
async function head(url, attempts = 3) {
  let last
  for (let i = 1; i <= attempts; i++) {
    try {
      // GET rather than HEAD: GitHub answers HEAD on a missing user page with a
      // 404 as expected, but enough hosts mishandle HEAD that a 405 from one of
      // them would read as a dead link. A GET costs a page body and removes the
      // whole question.
      const res = await fetch(url, { redirect: 'follow' })
      if (res.status >= 400) throw new Error(`HTTP ${res.status}`)
      return res
    } catch (err) {
      last = err
      if (/HTTP 4\d\d/.test(err.message)) throw err
      if (i < attempts) await new Promise(r => setTimeout(r, i * 1500))
    }
  }
  throw last
}

// ── Collect the links ───────────────────────────────────────────────────────
function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (/\.tsx?$/.test(entry.name)) out.push(full)
  }
  return out
}

if (!fs.existsSync(COMPONENTS)) {
  console.error(`[checkFooterLinks] ${path.relative(REPO_ROOT, COMPONENTS)} does not exist.`)
  process.exit(1)
}

const links = []
for (const file of walk(COMPONENTS)) {
  const src = fs.readFileSync(file, 'utf8')
  // Only `href="..."` on a literal string. A template literal or a variable is
  // built at runtime and cannot be resolved from here; explorer links are the
  // known case and are covered by `chain.ts` and `checkChainCopy.mjs`.
  for (const m of src.matchAll(/href="(https?:\/\/[^"]+)"/g)) {
    links.push({ url: m[1], file: path.relative(REPO_ROOT, file) })
  }
}

if (links.length === 0) {
  // Not a pass. Either the footer lost its links or the attribute is now written
  // some way this regex does not see, and both mean the guard has quietly
  // stopped guarding.
  console.error(
    '[checkFooterLinks] found no external href in src/components. This guard '
    + 'exists because one of them was a 404; finding none means either the links '
    + 'were removed or they are no longer written as `href="https://…"`, and in '
    + 'the second case this check is now watching nothing.')
  process.exit(1)
}

// ── 1. They resolve ─────────────────────────────────────────────────────────
for (const { url, file } of links) {
  try {
    await head(url)
  } catch (err) {
    if (/HTTP 4\d\d/.test(err.message)) {
      bad.push(`${url} → ${err.message}, linked from ${file}`)
    } else {
      unreachable.push(`${url} — ${err.message}`)
    }
  }
}

// ── 2. The GitHub link is this repository ───────────────────────────────────
//
// Read from `git remote get-url origin` so the expected value cannot drift from
// the truth by anyone editing this file. If the remote is unreadable — a shallow
// export, a tarball — the check reports that it could not run rather than
// passing, because "I could not tell" and "it is correct" are different answers
// and this guard exists because they were once confused.
const githubLinks = links.filter(l => /^https?:\/\/(www\.)?github\.com\//i.test(l.url))

let originSlug = null
try {
  const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
    cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
  }).trim()
  const m = remote.match(/github\.com[/:]([^/]+\/[^/.]+)/i)
  if (m) originSlug = m[1].toLowerCase()
} catch { /* handled below */ }

if (githubLinks.length === 0) {
  bad.push(
    'no github.com link in src/components. The footer carried one and it is the '
    + 'only invitation on the site to read the source instead of believing the '
    + 'copy; losing it silently is a regression this guard should catch.')
} else if (!originSlug) {
  unreachable.push(
    'git remote `origin` could not be read, so the GitHub link could not be '
    + 'compared against this repository. It resolved, which is check 1 only.')
} else {
  for (const { url, file } of githubLinks) {
    const m = url.match(/github\.com\/([^/?#]+\/[^/?#]+)/i)
    const slug = m ? m[1].replace(/\.git$/, '').toLowerCase() : null
    if (slug !== originSlug) {
      bad.push(
        `${url} (in ${file}) does not point at this repository. `
        + `\`origin\` is ${originSlug}; the link names ${slug ?? 'no repository at all'}. `
        + 'A link that merely resolves is not enough — the previous value was an '
        + 'organisation that does not exist, and would have started passing a '
        + 'reachability check the day somebody else registered the name.')
    }
  }
}

// ── Report ──────────────────────────────────────────────────────────────────
if (bad.length > 0) {
  console.error('[checkFooterLinks] BAD LINK')
  for (const b of bad) console.error(`  — ${b}`)
  process.exitCode = 1
} else if (unreachable.length > 0) {
  console.error('[checkFooterLinks] could not answer — network, not drift:')
  for (const u of unreachable) console.error(`  — ${u}`)
  process.exitCode = 2
} else {
console.log(
  `[checkFooterLinks] OK — ${links.length} external link(s) in src/components `
  + `resolve, and the GitHub link is ${originSlug}.`)
}
