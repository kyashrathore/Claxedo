// Metadata slice — content registry.
//
// Each content tracked by the Workbench has exactly one ContentMeta entry
// keyed by Workbench contentId. The slice exposes simple CRUD with no
// orchestration — that lives in `orchestration.ts`.
//
// Wake granularity contract: `set`/`upsert`/`patch` diff into the existing
// entity node (identity preserved), so a field change wakes only readers of
// that field. Key structure changes (add/remove) wake `ids` readers and
// absent-key `get` readers; field patches wake neither.
//
// Read-your-writes contract: Solid 2 stages store writes until the scheduler
// flushes, so a plain committed read in the same task as a mutation would not
// see it. Orchestration chains reads and writes inside one task constantly
// (dedupe lookups, reuse decisions, duplicate sweeps), so every read here goes
// through the shared same-task overlay in `@/lib/staged-reads` — which also
// documents why Solid 2's own write-callback draft cannot serve this shape.
// Reads still touch the store first, so reactive tracking is unchanged.

import { createSignal, reconcile, type Accessor, type StoreSetter } from "solid-js"
import { createStagedMap, STAGED_DELETE } from "@/lib/staged-reads"
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
  /** All entries (in registry order). */
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
  setState: StoreSetter<ClaxedoState>
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

  const updateTypeIndex = (id: string, previous: ContentMeta | undefined, next: ContentMeta | undefined) => {
    if (previous?.type === next?.type) return
    if (previous) {
      typeIds.set(
        previous.type,
        (typeIds.get(previous.type) ?? []).filter((entryId) => entryId !== id),
      )
      typeRevisions.get(previous.type)?.[1]((value) => value + 1)
    }
    if (next) {
      const current = typeIds.get(next.type) ?? []
      if (!current.includes(id)) typeIds.set(next.type, [...current, id])
      typeRevisions.get(next.type)?.[1]((value) => value + 1)
    }
  }

  const updateDirectoryIndex = (previous: ContentMeta | undefined, next: ContentMeta | undefined) => {
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

  // Staged entries hold plain snapshots (shallow merges), never store proxies.
  const staged = createStagedMap<ContentMeta>()

  const get = (id: string) => staged.read(id, state.meta[id]) // store read first: keeps tracking

  const all = (): ContentMeta[] => staged.entries(state.meta).map(([, meta]) => meta)

  // Store nodes are live proxies. Capture the previous top-level value before
  // `setState` reconciles the replacement into that proxy, otherwise mutation
  // observers receive the new value in both `previous` and `next`.
  const snapshot = (meta: ContentMeta | undefined) => (meta ? { ...meta } : undefined)

  const notify = (change: MetadataChange) => input.onChange?.(change)

  const replace = (id: string, meta: ContentMeta) => {
    staged.stage(id, meta)
    setState(($state) => {
      const existing = $state.meta[id]
      if (existing) reconcile(meta)(existing)
      else $state.meta[id] = meta
    })
  }

  const set = (id: string, meta: ContentMeta) => {
    const previous = snapshot(get(id))
    replace(id, meta)
    updateTypeIndex(id, previous, meta)
    updateDirectoryIndex(previous, meta)
    notify({ id, previous, next: meta })
  }

  const upsert = (meta: ContentMeta) => {
    const previous = snapshot(get(meta.id))
    measureRendererPhase("meta.upsert.setState", () => {
      replace(meta.id, meta)
      updateTypeIndex(meta.id, previous, meta)
      updateDirectoryIndex(previous, meta)
    })
    measureRendererPhase("meta.upsert.notify", () => notify({ id: meta.id, previous, next: meta }))
  }

  const patch = (id: string, patch: Partial<ContentMeta>) => {
    // Existence and equality are decided against the staged view, never the
    // committed snapshot alone: a patch right after a same-task upsert must
    // apply, and a patch that reverts a field to its committed value after a
    // same-task change must not be skipped as "already equal".
    const existing = get(id)
    if (!existing) return
    if (sameMetaPatch(existing, patch)) return
    const previous = snapshot(existing)
    const next = { ...existing, ...patch } as ContentMeta
    staged.stage(id, next)
    // Field-level writes, not an entry replacement: only the fields this patch
    // actually changes wake their readers, and the entity node keeps identity.
    setState(($state) => {
      const target = $state.meta[id]
      if (!target) return
      for (const [key, value] of Object.entries(patch)) {
        const slot = key as keyof ContentMeta
        if (sameMetaValue(target[slot], value)) continue
        if (value && typeof value === "object" && target[slot] && typeof target[slot] === "object") {
          reconcile(value)(target[slot] as object)
        } else {
          ;(target as Record<string, unknown>)[slot] = value
        }
      }
    })
    updateTypeIndex(id, previous, next)
    updateDirectoryIndex(previous, next)
    notify({ id, previous, next })
  }

  const remove = (id: string) => {
    const previous = snapshot(get(id))
    if (!previous) return
    staged.stage(id, STAGED_DELETE)
    setState(($state) => {
      delete $state.meta[id]
    })
    updateTypeIndex(id, previous, undefined)
    updateDirectoryIndex(previous, undefined)
    notify({ id, previous })
  }

  const find = (predicate: (meta: ContentMeta) => boolean) => {
    return all().find(predicate)
  }

  const findAll = (predicate: (meta: ContentMeta) => boolean) => {
    return all().filter(predicate)
  }

  // Reading each key's slot (not its fields) tracks key structure and entry
  // replacement only — field patches write in place, so they do not wake `ids`
  // readers, and membership changes do not publish every metadata patch to
  // every mounted content surface.
  const ids: Accessor<string[]> = () => staged.entries(state.meta).map(([id]) => id)
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
