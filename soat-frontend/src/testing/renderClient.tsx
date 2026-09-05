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
  unmount(): void
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
    unmount() {
      act(() => { root.unmount() })
      container.remove()
    },
  }
}
