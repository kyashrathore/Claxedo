/**
 * The DOM event the terminal surface dispatches when its host resized. The
 * canonical consumer is `features/terminal/workbench/terminal-fit.ts`, which
 * re-declares the literal as `FIT_EVENT`; `fit-event.test.ts` welds the two
 * together so they cannot drift.
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
