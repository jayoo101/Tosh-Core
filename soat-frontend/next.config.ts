import type { NextConfig } from "next";
import path from "path";
import { withSentryConfig } from "@sentry/nextjs";

/**
 * Headers that cannot break a page. No `script-src`: Next's hydration scripts
 * are inline, so a strict one needs per-request nonces, and the wallet
 * connectors load from origins that change with the connector. What is here
 * stops the launch, buy and admin pages being framed for clickjacking.
 */
const SECURITY_HEADERS = [
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; object-src 'none'; base-uri 'self'" },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
] as const

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname),
  },
  async headers() {
    return [{ source: '/:path*', headers: [...SECURITY_HEADERS] }]
  },
};

/**
 * Source maps are uploaded only when a build actually has a token to do it
 * with (pre-mainnet item #26). CI and local `npm run build` have neither the
 * token nor an org, and a Sentry plugin that fails the build over a missing
 * upload credential would make the frontend gate useless.
 */
const canUploadSourcemaps = Boolean(
  process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT,
);

export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  silent: !process.env.CI,
  sourcemaps: { disable: !canUploadSourcemaps },
  // No `disableLogger` here: it is a webpack-only tree-shake that Turbopack
  // ignores, and setting it just prints a deprecation warning on every build.
  // Routes browser events through the app's own origin so a wallet extension
  // or a corporate ad-blocker cannot silently drop every error report.
  tunnelRoute: "/monitoring",
});
