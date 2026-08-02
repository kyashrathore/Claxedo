import type { Session } from "@opencode-ai/sdk/v2/client"
import { useGlobalSync } from "@/features/session/app-ports"
import { queryClient } from "@/platform/query/query-client"
import { directorySessionCacheQueryOptions, type DirectorySessionCacheValue } from "./queries"

export type DirectorySessionCacheRefresh = (
  directory: string,
  harnessType?: string,
  options?: { quiet?: boolean },
) => Promise<unknown> | unknown
export type DirectorySessionCacheFocusSource = {
  setFocusedDirectory?: (directory: string | undefined) => void
}

export function directorySessionCache(directory: string) {
  return queryClient.getQueryData<DirectorySessionCacheValue>(
    directorySessionCacheQueryOptions({ directory }).queryKey,
  )
}

export function directorySessionCacheQuery(directory: string) {
  return {
    ...directorySessionCacheQueryOptions({ directory }),
    enabled: false,
  }
}

export function hasDirectorySessionCache(directory: string) {
  return directorySessionCache(directory) !== undefined
}

export async function ensureDirectorySessionCache(input: {
  directory: string
  refresh: DirectorySessionCacheRefresh
  harnessType?: string
  quiet?: boolean
}) {
  if (hasDirectorySessionCache(input.directory)) return
  await refreshDirectorySessionCache(input)
}

export async function refreshDirectorySessionCache(input: {
  directory: string
  refresh: DirectorySessionCacheRefresh
  harnessType?: string
  quiet?: boolean
}) {
  await input.refresh(input.directory, input.harnessType, {
    quiet: input.quiet,
  })
}

export function focusDirectorySessionCache(input: {
  source: DirectorySessionCacheFocusSource
  directory?: string
}) {
  input.source.setFocusedDirectory?.(input.directory)
}

export function setDirectorySessionCache(directory: string, value: DirectorySessionCacheValue) {
  queryClient.setQueryData<DirectorySessionCacheValue>(directorySessionCacheQueryOptions({ directory }).queryKey, value)
}

export function directorySessions(directory: string, fallback?: Session) {
  const sessions = directorySessionCache(directory)?.session ?? []
  if (!fallback || sessions.some((session) => session.id === fallback.id)) return sessions
  return [fallback, ...sessions]
}

export function upsertDirectorySession(directory: string, session: Session) {
  queryClient.setQueryData<DirectorySessionCacheValue>(
    directorySessionCacheQueryOptions({ directory }).queryKey,
    (cache) => {
      if (!cache) {
        return {
          at: Date.now(),
          limit: 10,
          total: session.parentID ? 0 : 1,
          session: [session],
        }
      }
      const exists = cache.session.some((item) => item.id === session.id)
      return {
        ...cache,
        at: Date.now(),
        total: cache.total + (!exists && !session.parentID ? 1 : 0),
        session: [...cache.session.filter((item) => item.id !== session.id), session].sort((a, b) =>
          a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
        ),
      }
    },
  )
}

export function updateDirectorySession(directory: string, sessionID: string, update: (session: Session) => Session) {
  queryClient.setQueryData<DirectorySessionCacheValue>(
    directorySessionCacheQueryOptions({ directory }).queryKey,
    (cache) => cache
      ? {
          ...cache,
          at: Date.now(),
          session: cache.session.map((session) => session.id === sessionID ? update(session) : session),
        }
      : cache,
  )
}

export function removeDirectorySession(directory: string, sessionID: string) {
  queryClient.setQueryData<DirectorySessionCacheValue>(
    directorySessionCacheQueryOptions({ directory }).queryKey,
    (cache) => {
      const stale = cache?.session.find((session) => session.id === sessionID)
      if (!cache || !stale) return cache
      return {
        ...cache,
        at: Date.now(),
        total: Math.max(0, cache.total - (stale.parentID ? 0 : 1)),
        session: cache.session.filter((session) => session.id !== sessionID),
      }
    },
  )
}

export function removeDirectorySessionTree(directory: string, sessionID: string) {
  const removed = new Set<string>([sessionID])
  let changed = true
  while (changed) {
    changed = false
    for (const session of directorySessions(directory)) {
      if (!session.parentID || !removed.has(session.parentID) || removed.has(session.id)) continue
      removed.add(session.id)
      changed = true
    }
  }

  queryClient.setQueryData<DirectorySessionCacheValue>(
    directorySessionCacheQueryOptions({ directory }).queryKey,
    (cache) => {
      if (!cache) return cache
      const removedRoots = cache.session.filter((session) => removed.has(session.id) && !session.parentID).length
      return {
        ...cache,
        at: Date.now(),
        total: Math.max(0, cache.total - removedRoots),
        session: cache.session.filter((session) => !removed.has(session.id)),
      }
    },
  )

  return removed
}

export function useDirectorySessionCacheActions() {
  const globalSync = useGlobalSync()
  return {
    ensure: (input: { directory: string; harnessType?: string; quiet?: boolean }) =>
      ensureDirectorySessionCache({
        ...input,
        quiet: input.quiet ?? true,
        refresh: globalSync.refreshDirectory,
      }),
    refresh: (input: { directory: string; harnessType?: string; quiet?: boolean }) =>
      refreshDirectorySessionCache({
        ...input,
        refresh: globalSync.refreshDirectory,
      }),
    setFocused: (directory: string | undefined) =>
      focusDirectorySessionCache({
        source: globalSync,
        directory,
      }),
  }
}
