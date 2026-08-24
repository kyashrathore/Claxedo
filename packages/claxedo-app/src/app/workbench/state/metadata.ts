import { storePath } from "solid-js"
// Metadata slice — content registry.
//
// Each content tracked by the Workbench has exactly one ContentMeta entry
// keyed by Workbench contentId. The slice exposes simple CRUD with no
// orchestration — that lives in `orchestration.ts`.

import { type StoreSetter } from "solid-js"
import { createSignal, type Accessor } from "solid-js"
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
  setState: StoreSetter<ClaxedoState>
  onChange?: (metas: ContentMeta[]) => void
}): MetadataSliceApi {
  const { state, setState } = input
  const [version, setVersion] = createSignal(0)
  const bump = () => setVersion((current) => current + 1)

  const all = (): ContentMeta[] => Object.values(state.meta).filter((meta): meta is ContentMeta => !!meta)

  const get = (id: string) => state.meta[id]

  const notify = () => input.onChange?.(all())

  const set = (id: string, meta: ContentMeta) => {
    setState(storePath("meta", id, meta))
    bump()
    notify()
  }

  const upsert = (meta: ContentMeta) => {
    setState(storePath("meta", meta.id, meta))
    bump()
    notify()
  }

  const patch = (id: string, patch: Partial<ContentMeta>) => {
    const existing = state.meta[id]
    if (!existing) return
    if (sameMetaPatch(existing, patch)) return
    setState(storePath("meta", id, { ...existing, ...patch }))
    bump()
    notify()
  }

  const remove = (id: string) => {
    setState(($state) => {
      const all = $state["meta"]
      delete all[id]
    })
    bump()
    notify()
  }

  const find = (predicate: (meta: ContentMeta) => boolean) => {
    return all().find(predicate)
  }

  const findAll = (predicate: (meta: ContentMeta) => boolean) => {
    return all().filter(predicate)
  }

  const ids = (() => {
    version()
    return all().map((meta) => meta.id)
  }) as Accessor<string[]>

  notify()

  return { get, set, upsert, patch, remove, find, findAll, all, ids }
}

function sameMetaPatch(existing: ContentMeta, patch: Partial<ContentMeta>) {
  return Object.entries(patch).every(([key, value]) => sameMetaValue(existing[key as keyof ContentMeta], value))
}

function sameMetaValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false
  const leftEntries = Object.entries(left)
  const rightEntries = Object.entries(right)
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([key, value]) => sameMetaValue(value, (right as Record<string, unknown>)[key]))
  )
}
