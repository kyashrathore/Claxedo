import { createContext, createSignal, useContext } from "solid-js"
import type { QuoteSource } from "../model"
import type { ComposerKey } from "../store"

export type QuoteSurfaces = {
  readonly register: (key: string, root: HTMLElement) => () => void
  readonly root: (key: string) => HTMLElement | undefined
}

export function quoteSurfaceKey(composerKey: ComposerKey, source: QuoteSource): string {
  return `${composerKey}|${source.kind === "file" ? `file:${source.path}` : source.kind}`
}

export function createQuoteSurfaces(): QuoteSurfaces {
  const [roots, setRoots] = createSignal<ReadonlyMap<string, HTMLElement>>(new Map())
  const unregister = (key: string, root: HTMLElement) =>
    setRoots((current) => {
      if (current.get(key) !== root) return current
      const next = new Map(current)
      next.delete(key)
      return next
    })
  return {
    register: (key, root) => {
      setRoots((current) => new Map(current).set(key, root))
      return () => unregister(key, root)
    },
    root: (key) => roots().get(key),
  }
}

export const QuoteSurfacesContext = createContext<QuoteSurfaces>()

export function useQuoteSurfaces(): QuoteSurfaces {
  const surfaces = useContext(QuoteSurfacesContext)
  if (!surfaces) throw new Error("useQuoteSurfaces needs a ComposerStoreProvider above it")
  return surfaces
}
