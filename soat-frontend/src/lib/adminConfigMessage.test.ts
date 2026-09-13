import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ADMIN_CONFIG_MESSAGE_TEMPLATE,
  buildAdminConfigMessage,
  SIGNATURE_WINDOW_SEC,
} from './adminConfigMessage'

const REPO_ROOT = path.resolve(__dirname, '../../..')

describe('the canonical admin-config message', () => {
  it('keeps the alignment that is part of the signed bytes', () => {
    // Whitespace is not cosmetic once something signs it. Pinning the exact
    // string here means a well-meaning reformat shows up as a failed assertion
    // rather than as a 403 that looks like the wrong wallet is connected.
    expect(buildAdminConfigMessage(0.12, 1757000000000n, 1757021600)).toBe(
      'Tosh Admin Config Update\n' +
      'rate:      0.12\n' +
      'nonce:     1757000000000\n' +
      'expiresAt: 1757021600',
    )
  })

  it('renders a rate the way a wallet will, not padded', () => {
    // `0.1` must sign as `0.1`. Anything that reformats numbers on one side of
    // this exchange invalidates every signature without saying so.
    expect(buildAdminConfigMessage(0.1, 1n, 2)).toContain('rate:      0.1\n')
  })

  it('accepts a nonce as bigint, string or number identically', () => {
    // The route parses a bigint, the admin panel holds a bigint, and the CLI
    // reads a number out of JSON. All three must produce the same bytes.
    const asBig = buildAdminConfigMessage(0.2, 42n, 99)
    expect(buildAdminConfigMessage(0.2, '42', 99)).toBe(asBig)
    expect(buildAdminConfigMessage(0.2, 42, 99)).toBe(asBig)
  })

  it('gives a multi-signature owner materially longer than a single signer', () => {
    // The five-minute flat window is what kept the Safe path unsatisfiable after
    // the ERC-1271 arm had already landed. An hour is the floor for "two people
    // on two devices" being plausible at all.
    expect(SIGNATURE_WINDOW_SEC.contract).toBeGreaterThanOrEqual(60 * 60)
    expect(SIGNATURE_WINDOW_SEC.eoa).toBeLessThan(SIGNATURE_WINDOW_SEC.contract)
  })
})

describe('scripts/rotateGasRate.mjs reads this module rather than copying it', () => {
  it('parses a template byte-identical to the exported one', () => {
    // The CLI cannot import TypeScript, so it parses `ADMIN_CONFIG_MESSAGE_TEMPLATE`
    // out of this file. That parser is the one part of the rotation flow that can
    // break from an edit over here, and the symptom would be signatures over the
    // wrong bytes — collected from three people before anybody finds out.
    const out = execFileSync(
      process.execPath,
      [
        'scripts/rotateGasRate.mjs', 'template',
        '--rate', '0.12', '--nonce', '1757000000000', '--expiresAt', '1757021600',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    )

    const expected = buildAdminConfigMessage(0.12, 1757000000000n, 1757021600)
    for (const line of expected.split('\n')) {
      expect(out).toContain(`    ${line}`)
    }
  })

  it('would notice if the template stopped being parseable', () => {
    // Guards the guard: the assertion above passes vacuously if the parser
    // silently returns something else, so pin the shape it depends on.
    expect(ADMIN_CONFIG_MESSAGE_TEMPLATE).toMatch(/^'?Tosh Admin Config Update/)
    expect(ADMIN_CONFIG_MESSAGE_TEMPLATE).toContain('{rate}')
    expect(ADMIN_CONFIG_MESSAGE_TEMPLATE).toContain('{nonce}')
    expect(ADMIN_CONFIG_MESSAGE_TEMPLATE).toContain('{expiresAt}')
  })
})
