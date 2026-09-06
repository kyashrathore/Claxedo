import { TERMINAL_FIT_EVENT } from "../core/fit-event"

// Preserve the workbench-facing export while the protocol has one owner.
export const FIT_EVENT = TERMINAL_FIT_EVENT

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
