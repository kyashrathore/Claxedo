/**
 * localStorage key naming for the terminal's one-shot reload marker. The key
 * used to be `opencode.pty.{id}.reload` (pre-rename); it is now
 * `claxedo.pty.{id}.reload`. `legacyTerminalReloadStorageKey` and
 * `resolveTerminalReloadFlag` implement a one-time read-old-write-new
 * migration so a value written under the old key by a previous app version
 * is still honored once, then folded into the new key.
 */
export function terminalReloadStorageKey(id: string): string {
  return `claxedo.pty.${id}.reload`
}

export function legacyTerminalReloadStorageKey(id: string): string {
  return `opencode.pty.${id}.reload`
}

/**
 * Reads the reload marker for a given PTY id, migrating a legacy
 * `opencode.pty.{id}.reload` value to the new `claxedo.pty.{id}.reload` key
 * if present. Always consumes (removes) both keys as part of the read, since
 * the caller treats this as a one-shot "was this mount caused by a reload"
 * check. Returns whether a reload marker (either key) was present.
 */
export function resolveTerminalReloadFlag(
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">,
  id: string,
): boolean {
  const key = terminalReloadStorageKey(id)
  const legacyKey = legacyTerminalReloadStorageKey(id)
  let isReload = false
  try {
    if (storage.getItem(key)) {
      isReload = true
    } else {
      const legacyValue = storage.getItem(legacyKey)
      if (legacyValue) {
        isReload = true
        storage.setItem(key, legacyValue)
      }
    }
  } catch {}
  try {
    storage.removeItem(key)
    storage.removeItem(legacyKey)
  } catch {}
  return isReload
}
