export const TERMINAL_FIT_EVENT = "claxedo:terminal-fit"

export function emitTerminalFit(): void {
  window.dispatchEvent(new Event(TERMINAL_FIT_EVENT))
}
