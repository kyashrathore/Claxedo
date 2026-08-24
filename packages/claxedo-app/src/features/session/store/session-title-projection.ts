import { createStore, produce, unwrap } from "solid-js/store"
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

  const workspaceId = targetWorkspaceId ??
    normalized(ref?.toolSandbox?.kind === "workspace" ? ref.toolSandbox.workspaceId : ref?.workspaceId)
  const directory = targetDirectory ??
    normalized(ref?.toolSandbox?.kind === "local" ? ref.toolSandbox.cwd : ref?.cwd)
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
  return left?.sessionKey === right?.sessionKey &&
    left?.title === right?.title &&
    left?.source === right?.source &&
    left?.updatedAt === right?.updatedAt
}

function sameCanonical(
  left: SessionTitleProjectionEntry["canonical"],
  right: SessionTitleProjectionEntry["canonical"],
) {
  return left?.title === right?.title && left?.updatedAt === right?.updatedAt
}

function sameEntry(left: SessionTitleProjectionEntry | undefined, right: SessionTitleProjectionEntry | undefined) {
  return sameInventory(left?.inventory, right?.inventory) &&
    left?.provisionalTitle === right?.provisionalTitle &&
    sameCanonical(left?.canonical, right?.canonical) &&
    sameResolved(left?.resolved, right?.resolved)
}

function sameInventory(left: SessionInventoryRow | undefined, right: SessionInventoryRow | undefined) {
  return left === right || (!!left && !!right && unwrap(left) === unwrap(right))
}

function resolveEntry(
  key: string,
  previous: SessionTitleProjectionEntry | undefined,
  next: Omit<SessionTitleProjectionEntry, "resolved">,
  resetInventoryResolution = false,
): SessionTitleProjectionEntry | undefined {
  if (!next.inventory && !next.provisionalTitle && !next.canonical) return
  const prior = resetInventoryResolution &&
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

  const setEntry = (key: string, next: SessionTitleProjectionEntry | undefined) => {
    const current = state.byKey[key]
    if (sameEntry(current, next)) return
    if (next) {
      setState("byKey", key, next)
      return
    }
    setState("byKey", produce((entries) => {
      delete entries[key]
    }))
  }

  const expandedWriteKeys = (target: SessionTitleTarget) => {
    const keys = targetKeys(target)
    for (const key of keys.slice()) {
      const row = state.byKey[key]?.inventory
      if (!row) continue
      for (const alias of targetKeys(inventoryTarget(row))) keys.push(alias)
    }
    return [...new Set(keys)]
  }

  const entryForKeys = (keys: readonly string[]) => {
    for (const key of keys) {
      const value = state.byKey[key]
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
        const current = state.byKey[key]
        setEntry(key, resolveEntry(key, current, {
          provisionalTitle: current?.provisionalTitle,
          canonical: current?.canonical,
        }, true))
      }

      const visited = new Set<string>()
      for (const [key, row] of nextByKey) {
        if (visited.has(key)) continue
        const aliases = targetKeys(inventoryTarget(row)).filter((alias) => nextByKey.has(alias))
        aliases.forEach((alias) => visited.add(alias))
        const existing = aliases.map((alias) => state.byKey[alias])
        const canonical = strongestCanonical(existing)
        const provisionalTitle = existing.find((value) => value?.provisionalTitle)?.provisionalTitle
        for (const alias of aliases) {
          const current = state.byKey[alias]
          const inventory = nextByKey.get(alias)
          setEntry(alias, resolveEntry(alias, current, {
            inventory,
            provisionalTitle: current?.provisionalTitle ?? provisionalTitle,
            canonical: current?.canonical ?? canonical,
          }, !sameInventory(current?.inventory, inventory)))
        }
      }
      inventoryKeys = new Set(nextByKey.keys())
    },
    publishProvisional(target) {
      const title = normalized(target.title)
      if (!title) return
      for (const key of expandedWriteKeys(target)) {
        const current = state.byKey[key]
        setEntry(key, resolveEntry(key, current, {
          inventory: current?.inventory,
          provisionalTitle: title,
          canonical: current?.canonical,
        }))
      }
    },
    publishCanonical(target) {
      const title = normalized(target.title)
      if (!title) return
      for (const key of expandedWriteKeys(target)) {
        const current = state.byKey[key]
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
