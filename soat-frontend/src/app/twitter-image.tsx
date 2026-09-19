/*
 * twitter-image.tsx — the same card, under the name X looks for
 * ───────────────────────────────────────────────────────────────────────────
 *  Next treats `opengraph-image` and `twitter-image` as two separate file
 *  conventions and emits `twitter:image` only from this one. With just the
 *  former, X and the platforms that read its markup fall back to `og:image` on
 *  some surfaces and to nothing on others.
 *
 *  A re-export rather than a second drawing. The two cards have no reason to
 *  differ, and the failure mode of copying the JSX is that one of them gets a
 *  fix and the other does not — which nobody would notice, because you only
 *  ever see one at a time.
 */
export { alt, size, contentType, default } from './opengraph-image'
