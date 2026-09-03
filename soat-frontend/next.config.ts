import type { NextConfig } from "next";
import path from "path";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  turbopack: {
    root: path.resolve(__dirname),
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
