/**
 * The message a launch creator signs to publish their project's metadata.
 *
 * `POST /api/projects` used to accept any body from anyone. The row it writes
 * is what the directory and the project page render — name, logo, website,
 * twitter — so "anyone" included an attacker, and the attack did not even need
 * to overwrite anything. `tx_hash` is unique, so the race is enough: watch the
 * chain for `LaunchCreated`, POST that txHash first with your own links, and
 * the real creator's POST comes back `{ duplicate: true }` while the project
 * page serves your site to their audience. Nothing on the page would look
 * wrong, because everything on it is exactly what the table says.
 *
 * So the server has to answer two questions it could not answer before: did
 * this launch really happen, and is the person describing it the person who
 * launched it. The first comes from the receipt. The second comes from this
 * signature — recovered and compared against the `creator` in the on-chain
 * `LaunchCreated` event, which is the only authority on the subject.
 *
 * Both sides build the message HERE, in one file imported by the route and by
 * the launch page, because a signature scheme whose two halves are written
 * twice is a signature scheme that will eventually disagree with itself and
 * lock every creator out of their own project.
 *
 * Notes on the format:
 *   • `JSON.stringify` per value, so a newline or a quote inside a website
 *     field cannot forge the shape of a different field. It also keeps the
 *     text readable in a wallet's signing prompt, which is the point of
 *     personal_sign over an opaque digest.
 *   • The chain id is bound so a signature collected on staging cannot be
 *     replayed against mainnet.
 *   • No nonce and no expiry, deliberately. The signature authorises exactly
 *     one insert, keyed by a txHash that can only ever be inserted once, so a
 *     replay reproduces a row that already exists.
 */

export interface ProjectAttestationFields {
  chainId: number
  txHash: string
  logoUrl: string
  website: string
  twitter: string
  telegram: string
  description: string
}

export function buildProjectAttestationMessage(f: ProjectAttestationFields): string {
  const line = (k: string, v: string) => `${k}: ${JSON.stringify(v ?? '')}`
  return [
    'Tosh — publish project metadata',
    '',
    'Signing this proves you are the creator of the launch below. It costs',
    'nothing, sends no transaction, and grants no spending permission.',
    '',
    line('chainId', String(f.chainId)),
    line('txHash', f.txHash.toLowerCase()),
    line('logoUrl', f.logoUrl),
    line('website', f.website),
    line('twitter', f.twitter),
    line('telegram', f.telegram),
    line('description', f.description),
  ].join('\n')
}
