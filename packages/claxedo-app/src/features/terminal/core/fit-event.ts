/**
 * Local dispatch/listen helpers for the terminal-fit event used inside
 * `src/terminal/**`.
 *
 * The event name must stay byte-identical to FIT_EVENT in
 * `claxedo-ui/terminal/terminal-fit.ts` (the canonical cross-app
 * definition). It is intentionally re-declared here rather than imported:
 * `src/terminal/** -> src/claxedo-ui/**` would create a new
 * claxedo-ui<->terminal import cycle not present in
 * `src/architecture/layering-baseline.json`. A test-only drift check
 * (exempt from the layering scan) asserts the two literals stay equal.
 */
export const TERMINAL_FIT_EVENT = "claxedo:terminal-fit"

export function dispatchTerminalFitEvent(target: Pick<Window, "dispatchEvent"> = window): void {
  target.dispatchEvent(new Event(TERMINAL_FIT_EVENT))
}

export function onTerminalFitEvent(
  target: Pick<Window, "addEventListener" | "removeEventListener">,
  handler: () => void,
): () => void {
  target.addEventListener(TERMINAL_FIT_EVENT, handler)
  return () => target.removeEventListener(TERMINAL_FIT_EVENT, handler)
}
