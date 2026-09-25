/**
 * The env vars `src/lib/contracts.ts` throws on at import time.
 *
 * WHY A SETUP FILE AND NOT A `vi.stubEnv` PER TEST. `NEXT_PUBLIC_FACTORY_ADDRESS`
 * is stubbed per test, and correctly so: several suites vary it deliberately, and a
 * shared default would be a fixture they have to fight. The quote asset is the
 * opposite case — no test varies it, every suite that reaches `contracts.ts` needs
 * it, and eight files failed at import with the same message when it was introduced
 * without one. A stub repeated in all eight would be eight places to update and
 * nothing gained.
 *
 * Tests that do want to vary it still can: `vi.stubEnv` inside a file overrides
 * this, and `isolate: true` keeps that override out of every other file.
 *
 * WHY NOT ALSO SUPPLY THE FACTORY HERE. Because the suites that stub it check what
 * happens when it is absent or wrong, and a default would make those tests pass for
 * the wrong reason.
 *
 * The address is deliberately not the real BEM deployment. Nothing under test reads
 * the value — they check payload shapes, route behaviour and arithmetic — and a real
 * mainnet address in a fixture invites someone to treat a passing test as evidence
 * about a deployment. `npm run check:quote` is what makes that claim, against a live
 * chain.
 *
 * ASSIGNED, NOT DEFAULTED. The golden masters snapshot the ticker, so whatever
 * the shell exports would be baked into them: `frontend.yml` sets `mBEM` at job
 * level for the build, and with `||=` that leaked into `npm test` and failed 269
 * snapshots recorded as `TQUOTE` on a machine that exports nothing.
 */
process.env.NEXT_PUBLIC_QUOTE_ASSET = '0x2222222222222222222222222222222222222222'
process.env.NEXT_PUBLIC_QUOTE_SYMBOL = 'TQUOTE'
