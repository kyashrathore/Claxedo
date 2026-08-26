import { createStore, storePath } from "solid-js"
import { createStagedMap, STAGED_DELETE } from "@/lib/staged-reads"
import type { SessionRef } from "@/platform/identity/session-ref"
import { sessionViewKey } from "@/platform/identity/session-view-key"
import type { SessionInventoryRow } from "@/features/session/data/query/types"
import {
  isConcreteSessionTitle,
  stableSessionTitle,
  type StableSessionTitle,
} from "@/features/session/lib/session-title-sync"

export type SessionTitleTarget = {
  sessionId: string
  directory?: string
  workspaceId?: string
  sessionRef?: SessionRef
}

export type SessionTitleProjectionEntry = {
  inventory?: SessionInventoryRow
  provisionalTitle?: string
  canonical?: {
    title: string
    updatedAt?: number
  }
  resolved?: StableSessionTitle
}

export type SessionTitleProjectionSelection = {
  entry(): SessionTitleProjectionEntry | undefined
  title(): string | undefined
  inventory(): SessionInventoryRow | undefined
}

export type SessionTitleProjectionApi = {
  select(target: SessionTitleTarget): SessionTitleProjectionSelection
  entry(target: SessionTitleTarget): SessionTitleProjectionEntry | undefined
  title(target: SessionTitleTarget): string | undefined
  inventory(target: SessionTitleTarget): SessionInventoryRow | undefined
  replaceInventory(rows: readonly SessionInventoryRow[]): void
  publishProvisional(target: SessionTitleTarget & { title: string }): void
  publishCanonical(target: SessionTitleTarget & { title: string; updatedAt?: number }): void
  remove(target: SessionTitleTarget): void
}

type ProjectionState = {
  byKey: Record<string, SessionTitleProjectionEntry | undefined>
}

function normalized(value: string | undefined) {
  return value?.trim() || undefined
}

function centralTarget(
  sessionRef: SessionRef | undefined,
  directory: string | undefined,
  workspaceId: string | undefined,
) {
  if (sessionRef?.host === "central") return true
  if (directory === "global") return true
  return !directory && !workspaceId && sessionRef?.host !== "workspace"
}

function targetKeys(target: SessionTitleTarget) {
  const sessionId = normalized(target.sessionId)
  if (!sessionId || sessionId === "new") return []
  const ref = target.sessionRef
  const targetDirectory = normalized(target.directory)
  const targetWorkspaceId = normalized(target.workspaceId)
  if (centralTarget(ref, targetDirectory, targetWorkspaceId)) return [sessionViewKey({ sessionId })]

  const workspaceId =
    targetWorkspaceId ??
    normalized(ref?.toolSandbox?.kind === "workspace" ? ref.toolSandbox.workspaceId : ref?.workspaceId)
  const directory = targetDirectory ?? normalized(ref?.toolSandbox?.kind === "local" ? ref.toolSandbox.cwd : ref?.cwd)
  const keys = [
    workspaceId ? sessionViewKey({ sessionId, workspaceId }) : undefined,
    directory ? sessionViewKey({ sessionId, directory }) : undefined,
  ].filter((key): key is string => !!key)
  return [...new Set(keys)]
}

function inventoryTarget(row: SessionInventoryRow): SessionTitleTarget {
  if (row.directory === "global" || row.tags.includes("global")) {
    return { sessionId: row.id }
  }
  return {
    sessionId: row.id,
    directory: row.directory,
    workspaceId: row.workspaceId,
  }
}

function inventoryUpdatedAt(row: SessionInventoryRow | undefined) {
  return row?.time.updated ?? row?.time.created
}

function preferInventoryRow(current: SessionInventoryRow | undefined, next: SessionInventoryRow) {
  if (!current) return next
  const currentConcrete = isConcreteSessionTitle(normalized(current.title))
  const nextConcrete = isConcreteSessionTitle(normalized(next.title))
  if (currentConcrete !== nextConcrete) return nextConcrete ? next : current
  return (inventoryUpdatedAt(next) ?? 0) > (inventoryUpdatedAt(current) ?? 0) ? next : current
}

function sameResolved(left: StableSessionTitle | undefined, right: StableSessionTitle | undefined) {
  return (
    left?.sessionKey === right?.sessionKey &&
    left?.title === right?.title &&
    left?.source === right?.source &&
    left?.updatedAt === right?.updatedAt
  )
}

function sameCanonical(
  left: SessionTitleProjectionEntry["canonical"],
  right: SessionTitleProjectionEntry["canonical"],
) {
  return left?.title === right?.title && left?.updatedAt === right?.updatedAt
}

function sameEntry(left: SessionTitleProjectionEntry | undefined, right: SessionTitleProjectionEntry | undefined) {
  return (
    sameInventory(left?.inventory, right?.inventory) &&
    left?.provisionalTitle === right?.provisionalTitle &&
    sameCanonical(left?.canonical, right?.canonical) &&
    sameResolved(left?.resolved, right?.resolved)
  )
}

function sameInventory(left: SessionInventoryRow | undefined, right: SessionInventoryRow | undefined) {
  // Solid 1 compared the unwrapped raws here because the same row read through
  // two proxies was not `===`. Solid 2's `snapshot` is NOT a drop-in for that:
  // it returns raw identity only for subtrees unmodified relative to source and
  // a FRESH COPY for owned (written) ones, so `snapshot(a) === snapshot(b)`
  // would go permanently false the moment a row was written — defeating this
  // dedup and re-resolving every title on every commit. Compare the logical row
  // instead: same id, same revision.
  if (left === right) return true
  if (!left || !right) return false
  return left.id === right.id && inventoryUpdatedAt(left) === inventoryUpdatedAt(right)
}

function resolveEntry(
  key: string,
  previous: SessionTitleProjectionEntry | undefined,
  next: Omit<SessionTitleProjectionEntry, "resolved">,
  resetInventoryResolution = false,
): SessionTitleProjectionEntry | undefined {
  if (!next.inventory && !next.provisionalTitle && !next.canonical) return
  const prior =
    resetInventoryResolution &&
    (previous?.resolved?.source === "inventory" || previous?.resolved?.source === "placeholder")
      ? undefined
      : previous?.resolved
  const resolved = stableSessionTitle(prior, {
    sessionKey: key,
    directoryTitle: next.canonical?.title,
    directoryUpdatedAt: next.canonical?.updatedAt,
    inventoryTitle: next.inventory?.title,
    inventoryUpdatedAt: inventoryUpdatedAt(next.inventory),
    provisionalTitle: next.provisionalTitle,
  })
  return { ...next, ...(resolved ? { resolved } : {}) }
}

function strongestCanonical(entries: readonly (SessionTitleProjectionEntry | undefined)[]) {
  return entries.reduce<SessionTitleProjectionEntry["canonical"]>((best, entry) => {
    const candidate = entry?.canonical
    if (!candidate) return best
    if (!best) return candidate
    return (candidate.updatedAt ?? 0) > (best.updatedAt ?? 0) ? candidate : best
  }, undefined)
}

export function createSessionTitleProjection(): SessionTitleProjectionApi {
  const [state, setState] = createStore<ProjectionState>({ byKey: {} })
  let inventoryKeys = new Set<string>()

  // Solid 2 stages store writes until the scheduler flushes, but this
  // projection's API is imperative and chains within one task: `replaceInventory`
  // then `publishCanonical` then `title(...)`, each deriving from the last. A
  // committed-only read rebuilds from a stale base and drops the earlier write.
  // The shared overlay hands staged values back to imperative callers while
  // reactive readers keep seeing committed state, so component subscriptions are
  // unchanged.
  const staged = createStagedMap<SessionTitleProjectionEntry>()
  const entryAt = (key: string) => staged.read(key, state.byKey[key])

  const setEntry = (key: string, next: SessionTitleProjectionEntry | undefined) => {
    const current = entryAt(key)
    if (sameEntry(current, next)) return
    staged.stage(key, next ?? STAGED_DELETE)
    if (next) {
      setState(storePath("byKey", key, next))
      return
    }
    // `produce` is gone in Solid 2; the write callback's draft is the equivalent
    // and supports key deletion.
    setState(($state) => {
      delete $state.byKey[key]
    })
  }

  const expandedWriteKeys = (target: SessionTitleTarget) => {
    const keys = targetKeys(target)
    for (const key of keys.slice()) {
      const row = entryAt(key)?.inventory
      if (!row) continue
      for (const alias of targetKeys(inventoryTarget(row))) keys.push(alias)
    }
    return [...new Set(keys)]
  }

  const entryForKeys = (keys: readonly string[]) => {
    for (const key of keys) {
      const value = entryAt(key)
      if (value) return value
    }
  }

  const select = (target: SessionTitleTarget): SessionTitleProjectionSelection => {
    // Targets are immutable identities at the projection boundary. Resolve
    // their aliases once when a row/tab/session owner is created; reactive DOM
    // reads can then subscribe to the exact store keys without repeatedly
    // trimming identity strings and rebuilding/deduplicating alias arrays.
    const keys = targetKeys(target)
    const entry = () => entryForKeys(keys)
    return {
      entry,
      title: () => entry()?.resolved?.title,
      inventory: () => entry()?.inventory,
    }
  }

  const entry = (target: SessionTitleTarget) => entryForKeys(targetKeys(target))

  return {
    select,
    entry,
    title: (target) => entry(target)?.resolved?.title,
    inventory: (target) => entry(target)?.inventory,
    replaceInventory(rows) {
      const nextByKey = new Map<string, SessionInventoryRow>()
      for (const row of rows) {
        for (const key of targetKeys(inventoryTarget(row))) {
          nextByKey.set(key, preferInventoryRow(nextByKey.get(key), row))
        }
      }

      for (const key of inventoryKeys) {
        if (nextByKey.has(key)) continue
        const current = entryAt(key)
        setEntry(
          key,
          resolveEntry(
            key,
            current,
            {
              provisionalTitle: current?.provisionalTitle,
              canonical: current?.canonical,
            },
            true,
          ),
        )
      }

      const visited = new Set<string>()
      for (const [key, row] of nextByKey) {
        if (visited.has(key)) continue
        const aliases = targetKeys(inventoryTarget(row)).filter((alias) => nextByKey.has(alias))
        aliases.forEach((alias) => visited.add(alias))
        const existing = aliases.map((alias) => entryAt(alias))
        const canonical = strongestCanonical(existing)
        const provisionalTitle = existing.find((value) => value?.provisionalTitle)?.provisionalTitle
        for (const alias of aliases) {
          const current = entryAt(alias)
          const inventory = nextByKey.get(alias)
          setEntry(
            alias,
            resolveEntry(
              alias,
              current,
              {
                inventory,
                provisionalTitle: current?.provisionalTitle ?? provisionalTitle,
                canonical: current?.canonical ?? canonical,
              },
              !sameInventory(current?.inventory, inventory),
            ),
          )
        }
      }
      inventoryKeys = new Set(nextByKey.keys())
    },
    publishProvisional(target) {
      const title = normalized(target.title)
      if (!title) return
      for (const key of expandedWriteKeys(target)) {
        const current = entryAt(key)
        setEntry(
          key,
          resolveEntry(key, current, {
            inventory: current?.inventory,
            provisionalTitle: title,
            canonical: current?.canonical,
          }),
        )
      }
    },
    publishCanonical(target) {
      const title = normalized(target.title)
      if (!title) return
      for (const key of expandedWriteKeys(target)) {
        const current = entryAt(key)
        const canonical = { title, ...(target.updatedAt === undefined ? {} : { updatedAt: target.updatedAt }) }
        const next = resolveEntry(key, current, {
          inventory: current?.inventory,
          provisionalTitle: current?.provisionalTitle,
          canonical,
        })
        if (next?.resolved === current?.resolved || sameResolved(next?.resolved, current?.resolved)) continue
        setEntry(key, next)
      }
    },
    remove(target) {
      for (const key of expandedWriteKeys(target)) {
        inventoryKeys.delete(key)
        setEntry(key, undefined)
      }
    },
  }
}
