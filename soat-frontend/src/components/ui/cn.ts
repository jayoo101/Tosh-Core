/**
 * Class-name joiner.
 *
 * One job: drop falsy entries and join the rest with a space.
 *
 * NON-OBVIOUS CONSTRAINT — this does NOT resolve Tailwind conflicts.  Two
 * utilities in the same group (`px-5` and `px-8`) have identical specificity,
 * so the winner is decided by their order in the generated stylesheet, not by
 * their order in the attribute.  Every primitive in this directory therefore
 * treats its own `className` prop as ADDITIVE — use it for layout concerns the
 * component does not own (`w-full`, `mt-section`, `sm:col-span-2`) and use the
 * component's props (`size`, `variant`, `tone`) for anything it does.
 */
export type ClassValue = string | false | null | undefined

export function cn(...parts: ClassValue[]): string {
  let out = ''
  for (const part of parts) {
    if (!part) continue
    out = out.length === 0 ? part : `${out} ${part}`
  }
  return out
}
