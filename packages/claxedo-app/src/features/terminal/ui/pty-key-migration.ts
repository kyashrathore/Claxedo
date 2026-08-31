/** localStorage key naming for the terminal's one-shot reload marker. */
export function terminalReloadStorageKey(id: string): string {
  return `claxedo.pty.${id}.reload`
}

/** Reads and consumes the one-shot reload marker for a PTY id. */
export function resolveTerminalReloadFlag(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  id: string,
): boolean {
  const key = terminalReloadStorageKey(id)
  let isReload = false
  try {
    isReload = !!storage.getItem(key)
  } catch {}
  try {
    storage.removeItem(key)
  } catch {}
  return isReload
}
