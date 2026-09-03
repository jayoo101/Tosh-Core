import { defineConfig } from 'vitest/config'

/**
 * Node environment, not jsdom.
 *
 * Everything under test here is server code — route handlers, the RPC
 * resolver, the request guards. They run in Node in production, so they are
 * exercised in Node here. A DOM would only add a lie to the fixture.
 */
export default defineConfig({
  resolve: {
    // Honours the `@/*` paths in tsconfig.json natively, so the imports in a
    // test read exactly like the imports in the module it covers.
    tsconfigPaths: true,
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Several suites re-import the same module under different env vars.
    // Isolation keeps one file's `vi.stubEnv` out of another's module registry.
    isolate: true,
  },
})
