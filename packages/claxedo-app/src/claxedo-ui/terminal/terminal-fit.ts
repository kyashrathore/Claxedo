const FIT_EVENT = "opencode:terminal-fit"

function emitTerminalFit(target?: Pick<Window, "dispatchEvent">) {
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
