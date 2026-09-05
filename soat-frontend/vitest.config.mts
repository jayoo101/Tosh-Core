import { defineConfig } from 'vitest/config'

/**
 * Node by default, a DOM only where one is asked for.
 *
 * Almost everything under test here is server code — route handlers, the RPC
 * resolver, the request guards. They run in Node in production, so they are
 * exercised in Node here. A DOM would only add a lie to the fixture.
 *
 * The exception is component tests, which need one. Rather than move the whole
 * suite into a DOM and change the environment of ~170 tests that neither want
 * nor need it, those files declare it per file:
 *
 *     // @vitest-environment happy-dom
 *
 * `happy-dom` over `jsdom` because it is 6 packages against roughly 40, and the
 * fidelity the component tests actually depend on is an `<input>`, an event and a
 * `keydown` listener. This repo treats a dependency added to run a check as a
 * real cost — see `scripts/runTsGuard.mjs` — and the same reasoning applies here:
 * React 19 exports `act`, and `react-dom/client` is already a dependency, so a
 * DOM is the only thing that was actually missing. No testing-library.
 */
export default defineConfig({
  resolve: {
    // Honours the `@/*` paths in tsconfig.json natively, so the imports in a
    // test read exactly like the imports in the module it covers.
    tsconfigPaths: true,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    // Several suites re-import the same module under different env vars.
    // Isolation keeps one file's `vi.stubEnv` out of another's module registry.
    isolate: true,
  },
})
