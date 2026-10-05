import { lazy, type Component } from "solid-js"

const RELOADED_FOR_BUILD = "claxedo.lazy-view.reloaded-for-build"

export const STALE_BUILD_MESSAGE = "The app was updated while this view was loading. Reload to continue."

/**
 * A module request that the browser could not turn into a module: the chunk
 * is gone (a deploy replaced the build this page loaded) or the host answered
 * it with HTML, which the module parser reports as a syntax error.
 */
export function isChunkLoadError(error: unknown): boolean {
  if (error instanceof SyntaxError) return true
  if (!(error instanceof TypeError)) return false
  return /dynamically imported module|module script/i.test(error.message)
}

export type ChunkLoadRecovery = "reload" | "stale" | "rethrow"

/** One reload per build: a second failure on the same build means the reload did not bring a build that has the chunk. */
export function chunkLoadRecovery(input: { error: unknown; buildId: string | undefined; reloadedFor: string | null }): ChunkLoadRecovery {
  if (!isChunkLoadError(input.error)) return "rethrow"
  if (input.buildId === undefined || input.reloadedFor === input.buildId) return "stale"
  return "reload"
}

/** The hashed entry module names the build this document came from. */
export function documentBuildId(doc: Document): string | undefined {
  return doc.querySelector<HTMLScriptElement>('script[type="module"][src]')?.src || undefined
}

function storage(): Storage | undefined {
  try {
    return window.sessionStorage
  } catch {
    return undefined
  }
}

async function loadChunk<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load()
  } catch (error) {
    const buildId = documentBuildId(document)
    const store = storage()
    const recovery = chunkLoadRecovery({ error, buildId, reloadedFor: store?.getItem(RELOADED_FOR_BUILD) ?? null })
    if (recovery === "rethrow") throw error
    if (recovery === "stale") throw new Error(STALE_BUILD_MESSAGE, { cause: error })
    store?.setItem(RELOADED_FOR_BUILD, buildId!)
    window.location.reload()
    return new Promise<T>(() => {})
  }
}

export function lazyView<Props extends Record<string, unknown>>(load: () => Promise<Component<Props>>): Component<Props> {
  return lazy(async () => ({ default: await loadChunk(load) }))
}
