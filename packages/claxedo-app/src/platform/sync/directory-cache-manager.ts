import type { Session } from "@opencode-ai/sdk/v2/client"
import type { ProjectMeta } from "@/platform/query/project-meta"
import { queryClient } from "@/platform/query/query-client"
import { queryKeys } from "@/platform/query/keys"

type SessionCacheValue = {
  at: number
  limit: number
  total: number
  session: Session[]
}

type DirState = {
  lastAccessAt: number
}

const MAX_DIR_STORES = 30
const DIR_IDLE_TTL_MS = 20 * 60 * 1000

function pickDirectoriesToEvict(input: {
  stores: string[]
  state: Map<string, DirState>
  pins: Set<string>
  max: number
  ttl: number
  now: number
}) {
  const overflow = Math.max(0, input.stores.length - input.max)
  let pendingOverflow = overflow
  const sorted = input.stores
    .filter((dir) => !input.pins.has(dir))
    .slice()
    .sort((a, b) => (input.state.get(a)?.lastAccessAt ?? 0) - (input.state.get(b)?.lastAccessAt ?? 0))
  const output: string[] = []
  for (const dir of sorted) {
    const last = input.state.get(dir)?.lastAccessAt ?? 0
    const idle = input.now - last >= input.ttl
    if (!idle && pendingOverflow <= 0) continue
    output.push(dir)
    if (pendingOverflow > 0) pendingOverflow -= 1
  }
  return output
}

function canDisposeDirectory(input: {
  directory: string
  hasStore: boolean
  pinned: boolean
  booting: boolean
  loadingSessions: boolean
}) {
  if (!input.directory) return false
  if (!input.hasStore) return false
  if (input.pinned) return false
  if (input.booting) return false
  if (input.loadingSessions) return false
  return true
}

export function createDirectoryCacheManager(input: {
  isBooting: (directory: string) => boolean
  isLoadingSessions: (directory: string) => boolean
  onDispose: (directory: string) => void
  resolveScopeKey?: (directory: string) => string | undefined
  translate: (key: string, vars?: Record<string, string | number>) => string
}) {
  const active = new Set<string>()
  const lifecycle = new Map<string, DirState>()
  const pins = new Map<string, number>()
  const aliases = new Map<string, Set<string>>()

  const scopeKey = (directory: string) => input.resolveScopeKey?.(directory) ?? directory

  const scopeAliases = (key: string, directory: string) => {
    const set = aliases.get(key) ?? new Set([key])
    set.add(directory)
    aliases.set(key, set)
    return [...set]
  }

  const cached = <T>(key: string, directory: string, query: (directory: string) => readonly unknown[]) => {
    for (const alias of scopeAliases(key, directory)) {
      const value = queryClient.getQueryData<T | undefined>(query(alias))
      if (value !== undefined) return value
    }
    return undefined
  }

  const mark = (directory: string) => {
    if (!directory) return
    const key = scopeKey(directory)
    active.add(key)
    scopeAliases(key, directory)
    lifecycle.set(key, { lastAccessAt: Date.now() })
    runEviction()
  }

  const pin = (directory: string) => {
    if (!directory) return
    const key = scopeKey(directory)
    active.add(key)
    scopeAliases(key, directory)
    pins.set(key, (pins.get(key) ?? 0) + 1)
    mark(key)
  }

  const unpin = (directory: string) => {
    if (!directory) return
    const key = scopeKey(directory)
    const next = (pins.get(key) ?? 0) - 1
    if (next > 0) {
      pins.set(key, next)
      return
    }
    pins.delete(key)
    runEviction()
  }

  const pinned = (directory: string) => (pins.get(scopeKey(directory)) ?? 0) > 0

  function disposeDirectory(directory: string) {
    const key = scopeKey(directory)
    if (
      !canDisposeDirectory({
        directory: key,
        hasStore: active.has(key),
        pinned: pinned(key),
        booting: input.isBooting(key),
        loadingSessions: input.isLoadingSessions(key),
      })
    ) {
      return false
    }

    active.delete(key)
    lifecycle.delete(key)
    aliases.delete(key)
    input.onDispose(key)
    return true
  }

  function runEviction() {
    const stores = [...active]
    if (stores.length === 0) return
    const list = pickDirectoriesToEvict({
      stores,
      state: lifecycle,
      pins: new Set(stores.filter(pinned)),
      max: MAX_DIR_STORES,
      ttl: DIR_IDLE_TTL_MS,
      now: Date.now(),
    })
    for (const directory of list) {
      disposeDirectory(directory)
    }
  }

  function has(directory: string) {
    return active.has(scopeKey(directory))
  }

  function directories() {
    return [...active]
  }

  function sessionCache(directory: string): SessionCacheValue {
    if (!directory) throw new Error(input.translate("error.childStore.storeCreateFailed"))
    const key = scopeKey(directory)
    active.add(key)
    const session = cached<SessionCacheValue>(key, directory, queryKeys.directory.sessionCache)
    mark(key)
    return {
      at: session?.at ?? Date.now(),
      limit: session?.limit ?? 5,
      total: session?.total ?? 0,
      session: session?.session ?? [],
    }
  }

  function aliasesFor(directory: string) {
    const key = scopeKey(directory)
    return scopeAliases(key, directory)
  }

  function projectMeta(directory: string, patch: ProjectMeta) {
    for (const alias of aliasesFor(directory)) {
      queryClient.setQueryData<ProjectMeta>(queryKeys.directory.projectMeta(alias), (previous = {}) => {
        const icon = patch.icon ? { ...(previous.icon ?? {}), ...patch.icon } : previous.icon
        const commands = patch.commands ? { ...(previous.commands ?? {}), ...patch.commands } : previous.commands
        return {
          ...previous,
          ...patch,
          icon,
          commands,
        }
      })
    }
  }

  function projectIcon(directory: string, value: string | undefined) {
    for (const alias of aliasesFor(directory)) {
      queryClient.setQueryData(queryKeys.directory.icon(alias), value)
    }
  }

  return {
    aliasesFor,
    directories,
    disposeDirectory,
    has,
    mark,
    pin,
    projectIcon,
    projectMeta,
    runEviction,
    scopeKey,
    sessionCache,
    unpin,
  }
}
