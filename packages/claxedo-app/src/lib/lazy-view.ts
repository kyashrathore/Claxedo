import { lazy, type Component } from "solid-js"
import { tabStorage } from "./persisted"

const RELOADED_FOR_BUILD = "claxedo.lazy-view.reloaded-for-build"

export const STALE_BUILD_MESSAGE = "The app was updated while this view was loading. Reload to continue."

export function isModuleLoadFailure(error: unknown): boolean {
  return error instanceof TypeError || error instanceof SyntaxError
}

export type ChunkLoadRecovery = "reload" | "stale" | "rethrow"

export type ChunkLoadFacts = {
  readonly error: unknown
  readonly loadedBuild: string | undefined
  readonly servedBuild: string | undefined
  readonly reloadedFor: string | null
}

export function chunkLoadRecovery(input: ChunkLoadFacts): ChunkLoadRecovery {
  if (!isModuleLoadFailure(input.error) || !input.loadedBuild || !input.servedBuild || input.servedBuild === input.loadedBuild) return "rethrow"
  return input.reloadedFor === input.servedBuild ? "stale" : "reload"
}

export function documentBuildId(doc: Document): string | undefined {
  const source = doc.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute("src")
  return source ? new URL(source, document.baseURI).href : undefined
}

async function servedBuildId(failure: unknown): Promise<string | undefined> {
  let response: Response
  try {
    response = await fetch(new URL("/", document.baseURI), { cache: "no-store" })
  } catch (error) {
    console.warn("A view failed to load, and the server could not be reached to check for a newer app", { error })
    throw failure
  }
  if (!response.ok) return undefined
  return documentBuildId(new DOMParser().parseFromString(await response.text(), "text/html"))
}

async function recoverChunk(error: unknown): Promise<ChunkLoadRecovery> {
  if (!isModuleLoadFailure(error)) return "rethrow"
  const storage = tabStorage()
  const facts = { error, loadedBuild: documentBuildId(document), servedBuild: await servedBuildId(error), reloadedFor: storage?.getItem(RELOADED_FOR_BUILD) ?? null }
  const recovery = chunkLoadRecovery(facts)
  if (recovery === "reload") storage?.setItem(RELOADED_FOR_BUILD, facts.servedBuild!)
  return recovery
}

async function loadChunk<T>(load: () => Promise<T>): Promise<T> {
  try {
    return await load()
  } catch (error) {
    const recovery = await recoverChunk(error)
    if (recovery === "rethrow") throw error
    if (recovery === "stale") throw new Error(STALE_BUILD_MESSAGE, { cause: error })
    window.location.reload()
    return new Promise<T>(() => {})
  }
}

export function lazyView<Props extends Record<string, unknown>>(load: () => Promise<Component<Props>>): Component<Props> {
  return lazy(async () => ({ default: await loadChunk(load) }))
}
