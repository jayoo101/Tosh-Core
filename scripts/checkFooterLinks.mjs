#!/usr/bin/env node
/*
 * checkFooterLinks.mjs
 * ────────────────────
 * Resolves the external links the site shows its users.
 *
 * There was exactly one when this was written, and it was wrong. `SiteFooter.tsx`
 * pointed "GitHub"
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
 * Three things are checked, and the first is the weakest of them:
 *   1. Every external href in the frontend's components resolves. A 404 here is
 *      worse than no link — a dead source link reads as a project with
 *      something to hide, which is the precise opposite of why it is there.
 *   2. The GitHub link points at *this* repository, resolved from `git remote`
 *      rather than from a constant in this file. A link that resolves is not
 *      enough: `github.com/tosh-protocol` would have passed check 1 the moment
 *      somebody registered that name, while still not being the source of the
 *      site the reader is standing on.
 *   3. Any x.com handle is a real account. Check 1 cannot be trusted to tell —
 *      that host answered 200 for one invented handle and 404 for another
 *      minutes apart — so the same "resolves but is not the right thing" gap
 *      that check 2 closes for GitHub was open for the X link the day it was
 *      added, and open intermittently, which is the harder kind to notice.
 *
 * Checks 2 and 3 both exist because reachability is the easy half. Each one
 * asks a source that can actually distinguish the right target from a
 * plausible-looking wrong one: `git remote` for the first, X's own oEmbed
 * lookup for the second.
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

// ── 3. The X handles are real accounts ──────────────────────────────────────
//
// Check 1 cannot be relied on here. x.com is a single-page app, and what it
// answers for a handle nobody has registered is not consistent: measured
// 2026-09-14, one invented handle came back 200 with a *larger* body than the
// real profile, while a second came back 404 minutes later. So check 1 will
// sometimes catch a typo in the footer and sometimes report OK on it, and which
// one you get is not a property of the link. A check that passes intermittently
// on a broken link is worse than no check, because its green is quoted.
//
// The oEmbed endpoint is a real lookup and 404s on an unknown handle. It is
// also a third party that can rate-limit or block a CI runner, and exit 2 is a
// red build here, so this must not be able to redden a build for any reason
// except a genuinely dead handle. Hence the control: X's own account proves the
// endpoint is answering truthfully before a 404 on ours is believed. If the
// control does not come back clean — blocked, rate-limited, endpoint retired —
// the check reports nothing rather than guessing.
const X_PROFILE = /^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/?$/i
const oembed = (handle) =>
  fetch(`https://publish.twitter.com/oembed?url=https://twitter.com/${handle}`)

const xHandles = links
  .map(l => ({ ...l, handle: l.url.match(X_PROFILE)?.[1] }))
  .filter(l => l.handle)

if (xHandles.length > 0) {
  let controlOk = false
  try {
    controlOk = (await oembed('X')).status === 200
  } catch { /* treated as "cannot ask" below */ }

  if (!controlOk) {
    console.warn(
      '[checkFooterLinks] skipped the X handle check: the oEmbed control lookup '
      + 'did not answer 200, so a 404 on our own handle would not mean anything. '
      + `${xHandles.length} x.com link(s) got reachability only, which for this `
      + 'host is no check at all.')
  } else {
    for (const { url, file, handle } of xHandles) {
      try {
        const res = await oembed(handle)
        if (res.status === 404) {
          bad.push(
            `${url} (in ${file}) is not a real account: the oEmbed lookup — `
            + 'which just confirmed X\'s own account, so it is answering — says '
            + 'this handle does not exist. Do not read anything into whether '
            + 'check 1 above also flagged it; that host is inconsistent about '
            + 'missing handles, which is why this check exists.')
        }
      } catch (err) {
        unreachable.push(`oEmbed lookup for @${handle} — ${err.message}`)
      }
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
