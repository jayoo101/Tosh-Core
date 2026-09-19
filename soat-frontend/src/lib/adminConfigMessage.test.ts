import { execFileSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  ADMIN_CONFIG_KEEP,
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
    expect(buildAdminConfigMessage({
      rate: 0.12,
      floorWei: '25000000000000000',
      maxAllocWei: '500000000000000000',
      nonce: 1757000000000n,
      expiresAt: 1757021600,
    })).toBe(
      'Tosh Admin Config Update\n' +
      'rate:        0.12\n' +
      'floorWei:    25000000000000000\n' +
      'maxAllocWei: 500000000000000000\n' +
      'nonce:       1757000000000\n' +
      'expiresAt:   1757021600',
    )
  })

  it('renders a rate the way a wallet will, not padded', () => {
    // `0.5` must sign as `0.5`. Anything that reformats numbers on one side of
    // this exchange invalidates every signature without saying so.
    expect(buildAdminConfigMessage({ rate: 0.5, nonce: 1n, expiresAt: 2 }))
      .toContain('rate:        0.5\n')
  })

  it('signs an untouched dial as an explicit sentinel, not as a blank', () => {
    // "Leave the ceiling alone" has to be a statement inside the signed bytes.
    // A blank, or an omitted line, would let the server choose between several
    // texts the owner might have signed — and the ceiling is the per-wallet
    // deposit cap, so that choice is worth attacking.
    const msg = buildAdminConfigMessage({ rate: 0.5, nonce: 1n, expiresAt: 2 })
    expect(msg).toContain(`floorWei:    ${ADMIN_CONFIG_KEEP}\n`)
    expect(msg).toContain(`maxAllocWei: ${ADMIN_CONFIG_KEEP}\n`)
    // And an explicitly-null dial is the same statement as an absent one.
    expect(buildAdminConfigMessage({
      rate: 0.5, floorWei: null, maxAllocWei: null, nonce: 1n, expiresAt: 2,
    })).toBe(msg)
  })

  it('renders a wei dial from a bigint and a string identically', () => {
    // The route parses a bigint out of a decimal string; the CLI holds the
    // string it wrote into its artefact. Both must produce the same bytes, or
    // the flow signs in one place and verifies in another.
    const asBig = buildAdminConfigMessage({
      rate: 0.5, floorWei: 25_000_000_000_000_000n, nonce: 1n, expiresAt: 2,
    })
    expect(buildAdminConfigMessage({
      rate: 0.5, floorWei: '25000000000000000', nonce: 1n, expiresAt: 2,
    })).toBe(asBig)
  })

  it('accepts a nonce as bigint, string or number identically', () => {
    // The route parses a bigint, the admin panel holds a bigint, and the CLI
    // reads a number out of JSON. All three must produce the same bytes.
    const asBig = buildAdminConfigMessage({ rate: 0.2, nonce: 42n, expiresAt: 99 })
    expect(buildAdminConfigMessage({ rate: 0.2, nonce: '42', expiresAt: 99 })).toBe(asBig)
    expect(buildAdminConfigMessage({ rate: 0.2, nonce: 42, expiresAt: 99 })).toBe(asBig)
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

    const expected = buildAdminConfigMessage({
      rate: 0.12, nonce: 1757000000000n, expiresAt: 1757021600,
    })
    for (const line of expected.split('\n')) {
      expect(out).toContain(`    ${line}`)
    }
  })

  it('agrees with the CLI on the two dials, and on their two different scales', () => {
    // The CLI takes `--floor 0.025` because nobody types eighteen zeros
    // correctly, and signs the base units. A conversion that disagreed with this
    // side would sign a floor nobody chose.
    //
    // ⚠ THE TWO DIALS ARE NOT ON THE SAME SCALE, and that is the whole point of
    //   this case. `--floor` measures gas history on ETH-settled chains, so it is
    //   18-decimal. `--max-alloc` measures a deposit, which is BEM, so it is
    //   8-decimal. Identical-looking inputs of `0.5` therefore have to come out
    //   10^10 apart, and a CLI that scaled both the same way would look right in
    //   every review: the band stays internally coherent, `pogBandProblem`
    //   accepts it, and the error only appears as every wallet pinning to the
    //   on-chain cap. See pogQuota.ts's QUOTE_SCALE_GAP note.
    const out = execFileSync(
      process.execPath,
      [
        'scripts/rotateGasRate.mjs', 'template',
        '--rate', '0.5', '--floor', '0.025', '--max-alloc', '0.5',
        '--nonce', '1757000000000', '--expiresAt', '1757021600',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    )

    const expected = buildAdminConfigMessage({
      rate: 0.5,
      floorWei: 25_000_000_000_000_000n,  // 0.025 ETH at 18 decimals
      maxAllocWei: 50_000_000n,           // 0.5 BEM at 8 decimals
      nonce: 1757000000000n,
      expiresAt: 1757021600,
    })
    for (const line of expected.split('\n')) {
      expect(out).toContain(`    ${line}`)
    }
  })

  it('would notice if the template stopped being parseable', () => {
    // Guards the guard: the assertion above passes vacuously if the parser
    // silently returns something else, so pin the shape it depends on.
    expect(ADMIN_CONFIG_MESSAGE_TEMPLATE).toMatch(/^'?Tosh Admin Config Update/)
    expect(ADMIN_CONFIG_MESSAGE_TEMPLATE).toContain('{rate}')
    expect(ADMIN_CONFIG_MESSAGE_TEMPLATE).toContain('{floorWei}')
    expect(ADMIN_CONFIG_MESSAGE_TEMPLATE).toContain('{maxAllocWei}')
    expect(ADMIN_CONFIG_MESSAGE_TEMPLATE).toContain('{nonce}')
    expect(ADMIN_CONFIG_MESSAGE_TEMPLATE).toContain('{expiresAt}')
  })
})
