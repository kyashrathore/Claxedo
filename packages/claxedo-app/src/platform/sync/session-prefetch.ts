import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { queryClient } from "@/platform/query/query-client"
import { shellDataKeys } from "@/platform/sync/keys"

export const SESSION_PREFETCH_TTL = 15_000

export type SessionPrefetchMeta = {
  directory: string
  limit: number
  cursor?: string
  complete: boolean
  at: number
  messages?: Message[]
  parts?: Array<{ id: string; part: Part[] }>
}

export function sameWorkspaceSessionPrefetchIds(sessions: readonly { id: string }[], activeId?: string, limit = 10) {
  if (!activeId) return sessions.slice(0, limit).map((session) => session.id)
  const index = sessions.findIndex((session) => session.id === activeId)
  if (index === -1) return sessions.slice(0, limit).map((session) => session.id)
  return sessions
    .map((session, sessionIndex) => ({
      id: session.id,
      distance: Math.abs(sessionIndex - index),
      direction: sessionIndex > index ? 0 : 1,
    }))
    .filter((session) => session.distance > 0)
    .sort((left, right) => left.distance - right.distance || left.direction - right.direction)
    .slice(0, limit)
    .map((session) => session.id)
}

export function shouldSkipSessionPrefetch(input: {
  message: boolean
  info?: SessionPrefetchMeta
  chunk: number
  now?: number
}) {
  if (input.message) {
    if (!input.info) return true
    if (input.info.complete) return true
    if (input.info.limit > input.chunk) return true
  } else {
    if (!input.info) return false
  }

  return (input.now ?? Date.now()) - input.info.at < SESSION_PREFETCH_TTL
}

const version = (sessionID: string) => queryClient.getQueryData<number>(prefetchRevisionKey(sessionID)) ?? 0

export function getSessionPrefetch(sessionID: string) {
  return queryClient.getQueryData<SessionPrefetchMeta>(prefetchMetaKey(sessionID))
}

export function getSessionPrefetchPromise(sessionID: string) {
  return queryClient.getQueryCache().find({ queryKey: prefetchRequestKey(sessionID, version(sessionID), generation()) })
    ?.promise
}

export function clearSessionPrefetchInflight() {
  queryClient.setQueryData<number>(prefetchGenerationKey(), generation() + 1)
}

export function isSessionPrefetchCurrent(sessionID: string, value: number) {
  return version(sessionID) === value
}

export function runSessionPrefetch(input: {
  directory: string
  sessionID: string
  task: (value: number) => Promise<SessionPrefetchMeta | undefined>
}) {
  const value = version(input.sessionID)
  return queryClient
    .fetchQuery({
      queryKey: prefetchRequestKey(input.sessionID, value, generation()),
      queryFn: async () => (await input.task(value)) ?? null,
    })
    .then((result) => result ?? undefined)
}

export function setSessionPrefetch(input: {
  directory: string
  sessionID: string
  limit: number
  cursor?: string
  complete: boolean
  at?: number
  messages?: Message[]
  parts?: Array<{ id: string; part: Part[] }>
}) {
  queryClient.setQueryData<SessionPrefetchMeta>(prefetchMetaKey(input.sessionID), {
    directory: input.directory,
    limit: input.limit,
    cursor: input.cursor,
    complete: input.complete,
    at: input.at ?? Date.now(),
    ...(input.messages ? { messages: input.messages } : {}),
    ...(input.parts ? { parts: input.parts } : {}),
  })
}

export function clearSessionPrefetch(sessionIDs: Iterable<string>) {
  for (const sessionID of sessionIDs) {
    if (!sessionID) continue
    bumpPrefetchRevision(sessionID)
    queryClient.removeQueries({
      queryKey: shellDataKeys.sessionId(sessionID),
      predicate: (query) => prefetchQueryInfo(query.queryKey)?.type === "meta",
    })
  }
}

export function clearSessionPrefetchDirectory(directory: string) {
  const sessionIDs = new Set(
    queryClient
      .getQueryCache()
      .findAll({
        queryKey: ["shell", "session"],
        predicate: (query) => prefetchQueryInfo(query.queryKey)?.directory === directory,
      })
      .map((query) => prefetchQueryInfo(query.queryKey)?.sessionID)
      .filter((sessionID): sessionID is string => !!sessionID),
  )
  for (const sessionID of sessionIDs) bumpPrefetchRevision(sessionID)
  queryClient.removeQueries({
    queryKey: ["shell", "session"],
    predicate: (query) => {
      const info = prefetchQueryInfo(query.queryKey)
      return info?.type === "meta" && info.directory === directory
    },
  })
}

function generation() {
  return queryClient.getQueryData<number>(prefetchGenerationKey()) ?? 0
}

function bumpPrefetchRevision(sessionID: string) {
  queryClient.setQueryData<number>(prefetchRevisionKey(sessionID), version(sessionID) + 1)
}

function prefetchMetaKey(sessionID: string) {
  return shellDataKeys.sessionId(sessionID, "message-prefetch")
}

function prefetchRequestKey(sessionID: string, revision: number, generation: number) {
  return shellDataKeys.sessionId(sessionID, "message-prefetch-request", revision, generation)
}

function prefetchRevisionKey(sessionID: string) {
  return shellDataKeys.sessionId(sessionID, "message-prefetch-revision")
}

function prefetchGenerationKey() {
  return ["shell", "message-prefetch-generation"] as const
}

function prefetchQueryInfo(queryKey: readonly unknown[]) {
  if (queryKey[0] !== "shell" || queryKey[1] !== "session" || typeof queryKey[2] !== "string") return
  if (queryKey[3] === "message-prefetch") {
    const data = queryClient.getQueryData<SessionPrefetchMeta>(queryKey)
    return { type: "meta" as const, sessionID: queryKey[2], directory: data?.directory }
  }
  if (queryKey[3] === "message-prefetch-request") {
    return { type: "request" as const, sessionID: queryKey[2], directory: undefined }
  }
  if (queryKey[3] === "message-prefetch-revision") {
    return { type: "revision" as const, sessionID: queryKey[2], directory: undefined }
  }
}
