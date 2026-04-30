// Metadata slice — content registry.
//
// Each content tracked by the Workbench has exactly one ContentMeta entry
// keyed by Workbench contentId. The slice exposes simple CRUD with no
// orchestration — that lives in `orchestration.ts`.

import type { SetStoreFunction } from "solid-js/store"
import type { Accessor } from "solid-js"
import type { ClaxedoState, ContentMeta } from "./types"

export type MetadataSliceApi = {
  get(id: string): ContentMeta | undefined
  set(id: string, meta: ContentMeta): void
  /** Replace the whole entry (creates if missing). */
  upsert(meta: ContentMeta): void
  /** Apply a shallow patch; no-op if id is missing. */
  patch(id: string, patch: Partial<ContentMeta>): void
  /** Remove the entry. */
  remove(id: string): void
  /** First entry matching predicate, scanned in registry order. */
  find(predicate: (meta: ContentMeta) => boolean): ContentMeta | undefined
  /** All entries matching predicate, in registry order. */
  findAll(predicate: (meta: ContentMeta) => boolean): ContentMeta[]
  /** All entries (snapshot, in registry order). */
  all(): ContentMeta[]
  /** Reactive accessor over the keys of `meta` — useful for reactive `For` lists. */
  ids: Accessor<string[]>
}

export function createMetadataSlice(input: {
  state: ClaxedoState
  setState: SetStoreFunction<ClaxedoState>
}): MetadataSliceApi {
  const { state, setState } = input

  const all = (): ContentMeta[] => {
    const out: ContentMeta[] = []
    for (const id of Object.keys(state.meta)) {
      const m = state.meta[id]
      if (m) out.push(m)
    }
    return out
  }

  const get = (id: string) => state.meta[id]

  const set = (id: string, meta: ContentMeta) => {
    setState("meta", id, meta)
  }

  const upsert = (meta: ContentMeta) => {
    setState("meta", meta.id, meta)
  }

  const patch = (id: string, patch: Partial<ContentMeta>) => {
    const existing = state.meta[id]
    if (!existing) return
    setState("meta", id, { ...existing, ...patch })
  }

  const remove = (id: string) => {
    setState("meta", id, undefined as unknown as ContentMeta)
  }

  const find = (predicate: (meta: ContentMeta) => boolean) => {
    for (const id of Object.keys(state.meta)) {
      const m = state.meta[id]
      if (m && predicate(m)) return m
    }
    return undefined
  }

  const findAll = (predicate: (meta: ContentMeta) => boolean) => {
    const out: ContentMeta[] = []
    for (const id of Object.keys(state.meta)) {
      const m = state.meta[id]
      if (m && predicate(m)) out.push(m)
    }
    return out
  }

  const ids = (() => Object.keys(state.meta)) as Accessor<string[]>

  return { get, set, upsert, patch, remove, find, findAll, all, ids }
}
