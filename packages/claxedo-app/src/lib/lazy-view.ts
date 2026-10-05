import { lazy, type Component } from "solid-js"
import { tabStorage } from "./persisted"

const RELOADED_FOR_BUILD = "claxedo.lazy-view.reloaded-for-build"

export const STALE_BUILD_MESSAGE = "The app was updated while this view was loading. Reload to continue."

export function isModuleLoadFailure(error: unknown): boolean {
  return error instanceof TypeError || error instanceof SyntaxError
}

export type ChunkLoadRecovery = "reload" | "stale" | "rethrow"

export function chunkLoadRecovery(input: { error: unknown; buildId: string | undefined; reloadedFor: string | null }): ChunkLoadRecovery {
  if (!isModuleLoadFailure(input.error)) return "rethrow"
  if (input.buildId === undefined || input.reloadedFor === input.buildId) return "stale"
  return "reload"
}

export function documentBuildId(doc: Document): string | undefined {
  return doc.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src || undefined
}

async function loadChunk<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load()
  } catch (error) {
    const buildId = documentBuildId(document)
    const storage = tabStorage()
    const recovery = chunkLoadRecovery({ error, buildId, reloadedFor: storage?.getItem(RELOADED_FOR_BUILD) ?? null })
    if (recovery === "rethrow") throw error
    if (recovery === "stale") throw new Error(STALE_BUILD_MESSAGE, { cause: error })
    storage?.setItem(RELOADED_FOR_BUILD, buildId!)
    window.location.reload()
    return new Promise<T>(() => {})
  }
}

export function lazyView<Props extends Record<string, unknown>>(load: () => Promise<Component<Props>>): Component<Props> {
  return lazy(async () => ({ default: await loadChunk(load) }))
}
