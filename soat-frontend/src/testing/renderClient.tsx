/**
 * The smallest thing that can mount a client component and poke at it.
 *
 * Deliberately not `@testing-library/react`. React 19 exports `act` itself and
 * `react-dom/client` is already a dependency, so the only piece genuinely
 * missing was a DOM — and this repo counts a dependency added to run a check as
 * a real cost (`scripts/runTsGuard.mjs` makes the same argument about not adding
 * a TypeScript runner). What the component tests need is to mount, type into an
 * `<input>`, and read a `<button>`; that is this file.
 *
 * Not shipped: nothing under `src/app` or `src/components` imports it, so it
 * never enters the Next build graph. `tsc --noEmit` still checks it.
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ReactNode } from 'react'

export interface Mounted {
  readonly container: HTMLElement
  /** Every `<button>` currently rendered, in document order. */
  buttons(): HTMLButtonElement[]
  /**
   * The button whose visible text is exactly `text`.
   *
   * `Button` swaps its label for `disabledLabel` when disabled, and the admin
   * gates set `disabledLabel` to the blocker's label — so the button's text IS
   * the verdict, which is what makes this a useful query.
   */
  button(text: string): HTMLButtonElement
  /** The single `<input>`, for panels that have exactly one. */
  input(): HTMLInputElement
  /** Type into an input the way React's onChange expects. */
  type(value: string): void
  text(): string
  /**
   * Every string this render puts in front of a user, one per entry, in
   * document order.
   *
   * ⚠ THIS EXISTS TO MAKE THE i18n EXTRACTION PROVABLE RATHER THAN REVIEWED.
   *
   *   Moving ~930 hardcoded English strings into a dictionary is a mechanical
   *   edit across ~60 files whose worst failure mode is silent: two blockers
   *   swapping `reason` strings renders a page that states the wrong cause for
   *   why a deposit is refused. That passes `tsc`, passes eslint, passes every
   *   existing test, and looks correct in a screenshot. The same class of
   *   invisible money bug is written up in `scripts/checkQuoteFormat.ts`, where
   *   four surfaces rendered 8-decimal amounts on the 18-decimal scale and the
   *   result was still a plausible-looking price.
   *
   *   Snapshotting this array before the extraction and requiring it to be
   *   unchanged afterwards converts "60 files of edits nobody can fully review"
   *   into "the English output is byte-identical or the build is red".
   *
   * `text()` cannot serve that purpose: it concatenates the whole subtree into
   * one unbroken run (`Price1.00e-5TQUOTE · genesis P₀Phase…`), so a diff on it
   * points at a character offset rather than at a string. One entry per string
   * also makes the snapshot double as the extraction worklist.
   *
   * Includes the three attributes `textContent` cannot see. A `placeholder` is
   * read aloud, shown in an empty field and needs translating like any other
   * copy — and being invisible to `textContent` is precisely what makes it the
   * string an extraction walks past.
   */
  strings(): string[]
  unmount(): void
}

/**
 * User-facing copy that lives in an attribute rather than in a text node.
 *
 * `alt` is deliberately absent: this app renders no content images, and the
 * decorative ones carry `aria-hidden` instead.
 */
const COPY_ATTRS = ['placeholder', 'aria-label', 'title'] as const

function collectStrings(node: Node, out: string[]): void {
  if (node.nodeType === Node.TEXT_NODE) {
    const t = (node.textContent ?? '').trim()
    if (t) out.push(t)
    return
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return

  const el = node as Element
  // Tagged rather than bare, so a snapshot line says WHERE the string has to
  // come from. An extraction that moves a `placeholder` into a text node is a
  // real change even when the words survive.
  for (const attr of COPY_ATTRS) {
    const v = el.getAttribute(attr)?.trim()
    if (v) out.push(`[${attr}] ${v}`)
  }
  for (const child of Array.from(el.childNodes)) collectStrings(child, out)
}

/**
 * React reads `value` off the DOM node through its own descriptor, so assigning
 * `el.value` and firing `input` is not enough — the assignment has to go through
 * the native setter or React sees no change and the state never updates.
 */
function setNativeValue(el: HTMLInputElement, value: string): void {
  const proto = Object.getPrototypeOf(el) as object
  const desc = Object.getOwnPropertyDescriptor(proto, 'value')
  if (desc?.set) desc.set.call(el, value)
  else el.value = value
}

export function mount(node: ReactNode): Mounted {
  const container = document.createElement('div')
  document.body.appendChild(container)

  let root: Root
  act(() => {
    root = createRoot(container)
    root.render(node)
  })

  const buttons = () => Array.from(container.querySelectorAll('button')) as HTMLButtonElement[]

  const button = (text: string) => {
    const found = buttons().filter((b) => (b.textContent ?? '').trim() === text)
    if (found.length === 0) {
      throw new Error(
        `no button reading ${JSON.stringify(text)}. Buttons present: `
        + JSON.stringify(buttons().map((b) => (b.textContent ?? '').trim())),
      )
    }
    if (found.length > 1) throw new Error(`${found.length} buttons read ${JSON.stringify(text)}`)
    return found[0]
  }

  const input = () => {
    const found = Array.from(container.querySelectorAll('input')) as HTMLInputElement[]
    if (found.length !== 1) throw new Error(`expected exactly one <input>, found ${found.length}`)
    return found[0]
  }

  return {
    container,
    buttons,
    button,
    input,
    type(value: string) {
      const el = input()
      act(() => {
        setNativeValue(el, value)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      })
    },
    text: () => container.textContent ?? '',
    strings() {
      const out: string[] = []
      collectStrings(container, out)
      return out
    },
    unmount() {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}
