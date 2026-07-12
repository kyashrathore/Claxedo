/**
 * Canonical event name for "the terminal grid should re-fit to its
 * container". This is the single source of truth for the event
 * string — every dispatch/listen site in the app must import this
 * constant (or the emitTerminalFit/requestTerminalFitOnPaneChange
 * helpers below) instead of re-typing the literal.
 */
export const FIT_EVENT = "claxedo:terminal-fit"

export function emitTerminalFit(target?: Pick<Window, "dispatchEvent">) {
  const t = target ?? (typeof window !== "undefined" ? window : undefined)
  if (!t) return
  t.dispatchEvent(new Event(FIT_EVENT))
}

export function requestTerminalFitOnPaneChange(input?: {
  delay?: number
  target?: Pick<Window, "dispatchEvent" | "setTimeout">
}) {
  const t = input?.target ?? (typeof window !== "undefined" ? window : undefined)
  if (!t) return
  emitTerminalFit(t)
  const delay = input?.delay ?? 150
  t.setTimeout(() => emitTerminalFit(t), delay)
}
