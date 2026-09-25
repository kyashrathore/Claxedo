import type { ComposerPersistence, PersistedEntry } from "./persistence"

export const DRAFT_SAVE_IDLE_MS = 1_000

export type DeferredPersistence = ComposerPersistence & { readonly flush: () => void; readonly dispose: () => void }

export function createDeferredPersistence(target: ComposerPersistence, view: Window | undefined): DeferredPersistence {
  const pending = new Map<string, PersistedEntry>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    clearTimeout(timer)
    timer = undefined
    for (const [key, entry] of pending) target.save(key, entry)
    pending.clear()
  }
  const flushWhenHidden = () => {
    if (view?.document.visibilityState === "hidden") flush()
  }
  view?.addEventListener("pagehide", flush)
  view?.addEventListener("blur", flush)
  view?.document.addEventListener("visibilitychange", flushWhenHidden)
  return {
    load: (key) => pending.get(key) ?? target.load(key),
    save: (key, entry) => {
      pending.set(key, entry)
      clearTimeout(timer)
      timer = setTimeout(flush, DRAFT_SAVE_IDLE_MS)
    },
    flush,
    dispose: () => {
      flush()
      view?.removeEventListener("pagehide", flush)
      view?.removeEventListener("blur", flush)
      view?.document.removeEventListener("visibilitychange", flushWhenHidden)
    },
  }
}
