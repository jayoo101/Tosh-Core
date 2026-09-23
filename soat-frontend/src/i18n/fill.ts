/**
 * Substitute `{name}` placeholders in a dictionary string.
 *
 * Separate from the dictionary itself because the merged dictionary crosses the
 * server/client boundary as props and React cannot serialise a function. Storing
 * `(action: string) => \`Confirmed — ${action}\`` in `en.ts` would typecheck,
 * read better, and throw at runtime in the one place it matters.
 *
 * ⚠ AN UNKNOWN PLACEHOLDER IS LEFT ON SCREEN, not dropped. `{amount}` showing
 *   through in the UI is a bug anybody notices in a second; a silently empty
 *   space where a figure belongs is a bug that ships. On a page about money the
 *   loud failure is the safe one.
 *
 *   The quiet version of this is what `guard:i18n` is for: it compares the
 *   placeholder set of every locale's string against English, so a translator
 *   dropping `{action}` fails the build rather than reaching a user.
 */
export function fill(template: string, vars: Readonly<Record<string, string | number>>): string {
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  )
}

/** Every `{name}` in a template, in the order they appear. For `guard:i18n`. */
export function placeholdersIn(template: string): string[] {
  return Array.from(template.matchAll(/\{(\w+)\}/g), (m) => m[1])
}
