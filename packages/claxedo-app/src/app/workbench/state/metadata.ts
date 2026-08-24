// Metadata slice — content registry.
//
// Each content tracked by the Workbench has exactly one ContentMeta entry
// keyed by Workbench contentId. The slice exposes simple CRUD with no
// orchestration — that lives in `orchestration.ts`.

import { produce, type SetStoreFunction } from "solid-js/store"
import { batch, createSignal, type Accessor } from "solid-js"
import { measureRendererPhase } from "@/platform/performance/renderer-trace"
import { CONTENT_TYPES, type ClaxedoState, type ContentMeta, type ContentType } from "./types"

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
  /** Reactive structural index; entry patches do not invalidate unrelated type lists. */
  idsOfType(type: ContentType): readonly string[]
  /**
   * Reactive unique-directory index. Only changes when the set of directories
   * represented by metadata changes; title/status/content patches stay keyed.
   */
  directories: Accessor<readonly string[]>
}

export type MetadataChange = {
  id: string
  previous?: ContentMeta
  next?: ContentMeta
}

export function createMetadataSlice(input: {
  state: ClaxedoState
  setState: SetStoreFunction<ClaxedoState>
  onChange?: (change: MetadataChange) => void
}): MetadataSliceApi {
  const { state, setState } = input
  const typeIds = new Map<ContentType, readonly string[]>(CONTENT_TYPES.map((type) => [type, []]))
  const typeRevisions = new Map(CONTENT_TYPES.map((type) => [type, createSignal(0)] as const))
  const directoryRefCounts = new Map<string, number>()
  let directoryValues: readonly string[] = []
  const [directoryRevision, setDirectoryRevision] = createSignal(0)

  for (const meta of Object.values(state.meta)) {
    if (!meta) continue
    typeIds.set(meta.type, [...(typeIds.get(meta.type) ?? []), meta.id])
    if (!meta.directory) continue
    const count = directoryRefCounts.get(meta.directory) ?? 0
    directoryRefCounts.set(meta.directory, count + 1)
    if (count === 0) directoryValues = [...directoryValues, meta.directory]
  }

  const updateTypeIndex = (
    id: string,
    previous: ContentMeta | undefined,
    next: ContentMeta | undefined,
  ) => {
    if (previous?.type === next?.type) return
    if (previous) {
      typeIds.set(previous.type, (typeIds.get(previous.type) ?? []).filter((entryId) => entryId !== id))
      typeRevisions.get(previous.type)?.[1]((value) => value + 1)
    }
    if (next) {
      const current = typeIds.get(next.type) ?? []
      if (!current.includes(id)) typeIds.set(next.type, [...current, id])
      typeRevisions.get(next.type)?.[1]((value) => value + 1)
    }
  }

  const updateDirectoryIndex = (
    previous: ContentMeta | undefined,
    next: ContentMeta | undefined,
  ) => {
    const previousDirectory = previous?.directory
    const nextDirectory = next?.directory
    if (previousDirectory === nextDirectory) return

    let membershipChanged = false
    if (previousDirectory) {
      const count = directoryRefCounts.get(previousDirectory) ?? 0
      if (count <= 1) {
        directoryRefCounts.delete(previousDirectory)
        directoryValues = directoryValues.filter((directory) => directory !== previousDirectory)
        membershipChanged = true
      } else {
        directoryRefCounts.set(previousDirectory, count - 1)
      }
    }
    if (nextDirectory) {
      const count = directoryRefCounts.get(nextDirectory) ?? 0
      directoryRefCounts.set(nextDirectory, count + 1)
      if (count === 0) {
        directoryValues = [...directoryValues, nextDirectory]
        membershipChanged = true
      }
    }
    if (membershipChanged) setDirectoryRevision((revision) => revision + 1)
  }

  const all = (): ContentMeta[] =>
    Object.values(state.meta).filter((meta): meta is ContentMeta => !!meta)

  const get = (id: string) => state.meta[id]

  // Store nodes are live proxies. Capture the previous top-level value before
  // `setState` reconciles the replacement into that proxy, otherwise mutation
  // observers receive the new value in both `previous` and `next`.
  const snapshot = (meta: ContentMeta | undefined) => meta ? { ...meta } : undefined

  const notify = (change: MetadataChange) => input.onChange?.(change)

  const set = (id: string, meta: ContentMeta) => {
    const previous = snapshot(state.meta[id])
    batch(() => {
      setState("meta", id, meta)
      updateTypeIndex(id, previous, meta)
      updateDirectoryIndex(previous, meta)
    })
    notify({ id, previous, next: meta })
  }

  const upsert = (meta: ContentMeta) => {
    const previous = snapshot(state.meta[meta.id])
    measureRendererPhase("meta.upsert.setState", () => batch(() => {
      setState("meta", meta.id, meta)
      updateTypeIndex(meta.id, previous, meta)
      updateDirectoryIndex(previous, meta)
    }))
    measureRendererPhase("meta.upsert.notify", () => notify({ id: meta.id, previous, next: meta }))
  }

  const patch = (id: string, patch: Partial<ContentMeta>) => {
    const existing = state.meta[id]
    if (!existing) return
    if (sameMetaPatch(existing, patch)) return
    const previous = snapshot(existing)
    const next = { ...existing, ...patch }
    batch(() => {
      setState("meta", id, next)
      updateTypeIndex(id, previous, next)
      updateDirectoryIndex(previous, next)
    })
    notify({ id, previous, next })
  }

  const remove = (id: string) => {
    const previous = snapshot(state.meta[id])
    if (!previous) return
    batch(() => {
      setState("meta", produce((all) => {
        delete all[id]
      }))
      updateTypeIndex(id, previous, undefined)
      updateDirectoryIndex(previous, undefined)
    })
    notify({ id, previous })
  }

  const find = (predicate: (meta: ContentMeta) => boolean) => {
    return all().find(predicate)
  }

  const findAll = (predicate: (meta: ContentMeta) => boolean) => {
    return all().filter(predicate)
  }

  // Solid's store tracks own-key enumeration separately from keyed property
  // reads. This accessor therefore updates when membership changes without
  // publishing every metadata patch to every mounted content surface.
  const ids = (() => Object.keys(state.meta)) as Accessor<string[]>
  const idsOfType = (type: ContentType) => {
    typeRevisions.get(type)?.[0]()
    return typeIds.get(type) ?? []
  }
  const directories = () => {
    directoryRevision()
    return directoryValues
  }

  return { get, set, upsert, patch, remove, find, findAll, all, ids, idsOfType, directories }
}

function sameMetaPatch(existing: ContentMeta, patch: Partial<ContentMeta>) {
  return Object.entries(patch).every(([key, value]) =>
    sameMetaValue(existing[key as keyof ContentMeta], value))
}

function sameMetaValue(left: unknown, right: unknown): boolean {
  if (left === right) return true
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false
  const leftEntries = Object.entries(left)
  const rightEntries = Object.entries(right)
  return leftEntries.length === rightEntries.length &&
    leftEntries.every(([key, value]) => sameMetaValue(value, (right as Record<string, unknown>)[key]))
}
