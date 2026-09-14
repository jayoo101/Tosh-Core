#!/usr/bin/env node
/**
 * Starts one Watch pass from a host that is not GitHub's scheduler.
 *
 * `watch.yml`'s own cron delivered 0.269 passes/hour no matter how often it
 * asked. This script posts `repository_dispatch` of type `watch`, which is a
 * different pool — so the interval you put in front of this command is the
 * detection interval. `/api/watch-ping` is the HTTP form of the same button
 * for hosts that can only GET a URL (Vercel cron, cron-job.org).
 *
 *   WATCH_DISPATCH_TOKEN   fine-grained PAT, Contents: write on Tosh-Core
 *   WATCH_DISPATCH_REPO    default jayoo101/Tosh-Core
 *
 * Contents, not Actions: `repository_dispatch` is POST /repos/{o}/{r}/dispatches,
 * which GitHub files under Contents. Actions: write buys the workflow_dispatch
 * endpoint instead, so a token scoped that way authenticates and is then
 * refused by the call below.
 *
 *   node scripts/pingWatch.mjs
 *
 * Do not run `monitoring/watch.mjs` from this process. The checkpoint lives
 * on branch `watcher-state`; two writers without that workflow's concurrency
 * group would race it.
 */
const token = (process.env.WATCH_DISPATCH_TOKEN || '').trim()
const repo = (process.env.WATCH_DISPATCH_REPO || 'jayoo101/Tosh-Core').trim()

if (!token) {
  console.error('Set WATCH_DISPATCH_TOKEN (fine-grained PAT, Contents: write on the repo).')
  process.exit(2)
}
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
  console.error(`WATCH_DISPATCH_REPO is not owner/name: ${repo}`)
  process.exit(2)
}

const res = await fetch(`https://api.github.com/repos/${repo}/dispatches`, {
  method: 'POST',
  headers: {
    authorization: `Bearer ${token}`,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
    'content-type': 'application/json',
  },
  body: JSON.stringify({ event_type: 'watch' }),
})

if (res.status !== 204) {
  console.error(`dispatch failed: ${res.status} ${(await res.text()).slice(0, 300)}`)
  if (res.status === 403 || res.status === 404) {
    // 404 as well as 403: GitHub hides repositories a token cannot see rather
    // than admitting they exist, so the wrong permission and the wrong
    // repository arrive as the same status.
    console.error(
      `The token reached GitHub and was refused. Check Contents: write on ${repo} —\n`
        + 'Actions: write is the workflow_dispatch endpoint, not this one, and grants\n'
        + 'nothing here. Check the repository is in the token\'s selected set too.',
    )
  }
  if (res.status === 422) {
    console.error(
      'The token is fine. 422 here means watch.yml on the DEFAULT branch has no\n'
        + 'repository_dispatch trigger — GitHub reads the workflow file from there.',
    )
  }
  process.exit(1)
}
console.log(`dispatched watch on ${repo}`)
