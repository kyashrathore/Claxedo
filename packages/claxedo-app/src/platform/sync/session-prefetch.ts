import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import type { SessionMessagePageRequest } from "@/platform/runtime/session"
import { queryClient } from "@/platform/query/query-client"
import { shellDataKeys } from "@/platform/sync/keys"

// Completed transcript snapshots remain useful until an authoritative session
// event or directory reset invalidates them. A 15-second timer made the same
// visible row fall back to the 80-message request during an ordinary switching
// sweep; keep a bounded five-minute safety net for missed external events.
export const SESSION_PREFETCH_TTL = 5 * 60_000
// Older-history pagination keeps its established numeric page size. Initial
// history uses the bounded semantic latest-surface view below and therefore carries no
// numeric limit or cursor.
export const SESSION_OLDER_HISTORY_PAGE_MESSAGE_COUNT = 200
// The synchronous cold surface only needs the latest complete turn. Older
// messages are already present in the same prefetched page and are folded in
// after the first paint, so a cold switch does not project arbitrary history.
export const SESSION_PREFETCH_FIRST_FOLD_MESSAGE_COUNT = 2
export type SessionPrefetchDirectory = string

export type SessionPrefetchPage = {
  messages: Message[]
  parts: Array<{ id: string; part: Part[] }>
}

export type SessionPrefetchMeta = {
  directory: SessionPrefetchDirectory
  limit: number
  cursor?: string
  complete: boolean
  at: number
  page?: SessionPrefetchPage
}

export function sessionHistoryPageRequest(before?: string): SessionMessagePageRequest {
  if (before) {
    return {
      before,
      limit: SESSION_OLDER_HISTORY_PAGE_MESSAGE_COUNT,
    }
  }
  return {
    view: "latest-surface",
  }
}

export function splitSessionPrefetchPage(
  info: SessionPrefetchMeta,
  count = SESSION_PREFETCH_FIRST_FOLD_MESSAGE_COUNT,
) {
  const page = info.page
  if (!page || page.messages.length === 0) return
  const budget = Math.max(2, count)
  const tail = page.messages.at(-1)!
  const owningUser = page.messages.findLastIndex((message) => message.role === "user")
  const selected = new Set<string>()
  // Keep the semantic anchors (the owning user and final response) while
  // deferring intermediate assistant/tool messages. A latest turn may contain
  // arbitrarily many assistant records, so walking back to the user and taking
  // the whole suffix would make the supposedly bounded first fold unbounded.
  if (owningUser >= 0) selected.add(page.messages[owningUser]!.id)
  selected.add(tail.id)
  for (let index = page.messages.length - 2; index >= 0 && selected.size < budget; index--) {
    if (index === owningUser) continue
    selected.add(page.messages[index]!.id)
  }
  const firstFoldMessages = page.messages.filter((message) => selected.has(message.id))
  const firstFoldIds = new Set(firstFoldMessages.map((message) => message.id))
  const firstFoldParts = page.parts.filter((row) => firstFoldIds.has(row.id))
  const deferredParts = page.parts.filter((row) => !firstFoldIds.has(row.id))
  return {
    firstFold: {
      messages: firstFoldMessages,
      parts: firstFoldParts,
    },
    deferred: {
      messages: page.messages.filter((message) => !firstFoldIds.has(message.id)),
      parts: deferredParts,
    },
  }
}

export function shouldSkipSessionPrefetch(input: { message: boolean; info?: SessionPrefetchMeta; chunk: number; now?: number }) {
  if (input.message) {
    if (!input.info) return true
    if (input.info.complete) return true
    if (input.info.limit > input.chunk) return true
  } else {
    if (!input.info) return false
  }

  return (input.now ?? Date.now()) - input.info.at < SESSION_PREFETCH_TTL
}

const version = (directory: SessionPrefetchDirectory, sessionID: string) =>
  queryClient.getQueryData<number>(prefetchRevisionKey(directory, sessionID)) ?? 0

export function getSessionPrefetch(directory: SessionPrefetchDirectory, sessionID: string) {
  return queryClient.getQueryData<SessionPrefetchMeta>(prefetchMetaKey(directory, sessionID))
}

export function getSessionPrefetchPromise(directory: SessionPrefetchDirectory, sessionID: string) {
  return queryClient
    .getQueryCache()
    .find({ queryKey: prefetchRequestKey(directory, sessionID, version(directory, sessionID), generation()) })
    ?.promise
}

export function clearSessionPrefetchInflight() {
  queryClient.setQueryData<number>(prefetchGenerationKey(), generation() + 1)
}

export function invalidateSessionPrefetchFromEvent(directory: SessionPrefetchDirectory, sessionID: string) {
  const matched = queryClient.getQueryCache().findAll({
    queryKey: shellDataKeys.sessionId(sessionID),
    predicate: (query) => {
      const info = prefetchQueryInfo(query.queryKey)
      return info?.directory === directory && (info.type === "meta" || info.type === "request")
    },
  })
  if (matched.length === 0) return false
  clearSessionPrefetchScope(directory, sessionID)
  return true
}

export function isSessionPrefetchCurrent(directory: SessionPrefetchDirectory, sessionID: string, value: number) {
  return version(directory, sessionID) === value
}

export function runSessionPrefetch(input: {
  directory: SessionPrefetchDirectory
  sessionID: string
  task: (value: number) => Promise<SessionPrefetchMeta | undefined>
}) {
  const value = version(input.directory, input.sessionID)
  return queryClient.fetchQuery({
    queryKey: prefetchRequestKey(input.directory, input.sessionID, value, generation()),
    queryFn: async () => await input.task(value) ?? null,
  }).then((result) => result ?? undefined)
}

export function setSessionPrefetch(input: {
  directory: SessionPrefetchDirectory
  sessionID: string
  limit: number
  cursor?: string
  complete: boolean
  at?: number
  page?: SessionPrefetchPage
}) {
  queryClient.setQueryData<SessionPrefetchMeta>(prefetchMetaKey(input.directory, input.sessionID), {
    directory: input.directory,
    limit: input.limit,
    cursor: input.cursor,
    complete: input.complete,
    at: input.at ?? Date.now(),
    ...(input.page ? { page: input.page } : {}),
  })
}

export function clearSessionPrefetch(sessionIDs: Iterable<string>) {
  for (const sessionID of sessionIDs) {
    if (!sessionID) continue
    const scopes = new Set(
      queryClient.getQueryCache().findAll({ queryKey: shellDataKeys.sessionId(sessionID) })
        .map((query) => prefetchQueryInfo(query.queryKey)?.directory)
        .filter((directory): directory is string => !!directory),
    )
    for (const directory of scopes) bumpPrefetchRevision(directory, sessionID)
    queryClient.removeQueries({ queryKey: shellDataKeys.sessionId(sessionID, "message-prefetch") })
  }
}

export function clearSessionPrefetchScope(directory: SessionPrefetchDirectory, sessionID: string) {
  bumpPrefetchRevision(directory, sessionID)
  queryClient.removeQueries({ queryKey: prefetchMetaKey(directory, sessionID) })
}

export function clearSessionPrefetchDirectory(directory: SessionPrefetchDirectory) {
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
  for (const sessionID of sessionIDs) bumpPrefetchRevision(directory, sessionID)
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

function bumpPrefetchRevision(directory: SessionPrefetchDirectory, sessionID: string) {
  queryClient.setQueryData<number>(prefetchRevisionKey(directory, sessionID), version(directory, sessionID) + 1)
}

function prefetchMetaKey(directory: SessionPrefetchDirectory, sessionID: string) {
  return shellDataKeys.sessionId(sessionID, "message-prefetch", directory)
}

function prefetchRequestKey(directory: SessionPrefetchDirectory, sessionID: string, revision: number, generation: number) {
  return shellDataKeys.sessionId(sessionID, "message-prefetch-request", directory, revision, generation)
}

function prefetchRevisionKey(directory: SessionPrefetchDirectory, sessionID: string) {
  return shellDataKeys.sessionId(sessionID, "message-prefetch-revision", directory)
}

function prefetchGenerationKey() {
  return ["shell", "message-prefetch-generation"] as const
}

function prefetchQueryInfo(queryKey: readonly unknown[]) {
  if (queryKey[0] !== "shell" || queryKey[1] !== "session" || typeof queryKey[2] !== "string") return
  if (queryKey[3] === "message-prefetch") {
    const data = queryClient.getQueryData<SessionPrefetchMeta>(queryKey)
    return { type: "meta" as const, sessionID: queryKey[2], directory: typeof queryKey[4] === "string" ? queryKey[4] : data?.directory }
  }
  if (queryKey[3] === "message-prefetch-request") {
    return { type: "request" as const, sessionID: queryKey[2], directory: typeof queryKey[4] === "string" ? queryKey[4] : undefined }
  }
  if (queryKey[3] === "message-prefetch-revision") {
    return { type: "revision" as const, sessionID: queryKey[2], directory: typeof queryKey[4] === "string" ? queryKey[4] : undefined }
  }
}
