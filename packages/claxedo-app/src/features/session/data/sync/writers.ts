import { shellDataKeys } from "@/platform/sync/keys"
import type { SessionRequestsQueryData, SessionStatus, SnapshotFileDiff, Todo } from "./queries"

export type ShellQueryDataWriter = {
  setQueryData<T>(
    queryKey: readonly unknown[],
    value: T | undefined | ((previous: T | undefined) => T | undefined),
  ): unknown
}

function setShellQueryData<T>(input: {
  queryClient: ShellQueryDataWriter
  queryKey: readonly unknown[]
  value: T | undefined | ((previous: T | undefined) => T | undefined)
}) {
  input.queryClient.setQueryData<T>(input.queryKey, input.value)
}

function setSessionQueryData<T>(input: {
  queryClient: ShellQueryDataWriter
  sessionId: string
  resource: string
  value: T | undefined | ((previous: T | undefined) => T | undefined)
}) {
  setShellQueryData({
    queryClient: input.queryClient,
    queryKey: shellDataKeys.sessionId(input.sessionId, input.resource),
    value: input.value,
  })
}

export function setSessionStatusQueryData(input: {
  queryClient: ShellQueryDataWriter
  sessionId: string
  status: SessionStatus
}) {
  input.queryClient.setQueryData<SessionStatus>(shellDataKeys.sessionId(input.sessionId, "status"), (previous) =>
    sameSessionStatus(previous, input.status) ? previous : input.status
  )
}

/**
 * Preserves the previous value when the incoming requests are equal, exactly as
 * the status and todo writers beside it do — this key was the only one of the
 * three writing a fresh object on every replayed poll response.
 *
 * Scope of the guarantee: identity only. A cache event is dispatched on every
 * write, whether or not the updater returns the same reference, so this does
 * NOT suppress `subscribeSessionActivity` notifications; it only spares
 * observers of the requests key a re-render for data that did not change.
 */
export function setSessionRequestsQueryData(input: {
  queryClient: ShellQueryDataWriter
  sessionId: string
  requests: SessionRequestsQueryData | ((previous: SessionRequestsQueryData | undefined) => SessionRequestsQueryData)
}) {
  setSessionQueryData<SessionRequestsQueryData>({
    ...input,
    resource: "requests",
    value: (previous) => {
      const next = typeof input.requests === "function" ? input.requests(previous) : input.requests
      recordResolvedSessionRequests({ queryClient: input.queryClient, sessionId: input.sessionId, previous, next })
      return previous !== undefined && sameSessionRequests(previous, next) ? previous : next
    },
  })
}

/**
 * Per session, the request ids this client has seen removed and no directory
 * read has stopped listing yet.
 *
 * Pending permissions and questions are a push-owned cache with two directory
 * hydration readers — the session pane's and the rail's — and three resolvers:
 * the `permission.replied` / `question.replied` / `question.rejected` frames
 * and the question dock's own clear on a successful reply. A read issued before
 * a resolution still carries the resolved request, so writing it through
 * re-seeds a question the user already answered; the dock paints it again until
 * the next read or frame clears it.
 *
 * The request id is what orders the two: the list read, the reply frame and the
 * dock's reply all name the same id, so a removal is remembered by id rather
 * than by clock, and a request the same stale payload reports for the first
 * time still reaches the dock. The ledger is a sibling of the entry it guards
 * so that it shares its lifetime — removing a session's shell queries drops
 * both.
 */
type ResolvedSessionRequestIds = {
  permissions: string[]
  questions: string[]
}

/** The cache access the guard needs: the ledger it reads, and the write that retires an entry. */
export type ResolvedSessionRequestStore = ShellQueryDataWriter & {
  getQueryData(queryKey: readonly unknown[]): ResolvedSessionRequestIds | undefined
}

/**
 * The requests of one authoritative directory read that are still open.
 *
 * Drops what this client has already resolved, and retires a remembered id the
 * moment a read stops listing it — that read is the server agreeing the request
 * is gone, and without it an id the server asks again could never be shown.
 * Pass only a leg the read itself answered: a cached list replayed through here
 * retires the guard it is supposed to respect.
 */
export function pendingSessionRequests<P extends { id: string }, Q extends { id: string }>(input: {
  queryClient: ResolvedSessionRequestStore
  sessionId: string
  permissions?: P[]
  questions?: Q[]
}): { permissions?: P[]; questions?: Q[] } {
  const resolved = input.queryClient.getQueryData(resolvedSessionRequestsKey(input.sessionId))
  if (!resolved) return { permissions: input.permissions, questions: input.questions }
  const pending = {
    permissions: input.permissions?.filter((item) => !resolved.permissions.includes(item.id)),
    questions: input.questions?.filter((item) => !resolved.questions.includes(item.id)),
  }
  retireResolvedSessionRequests(input)
  return pending
}

function resolvedSessionRequestsKey(sessionId: string) {
  return shellDataKeys.sessionId(sessionId, "resolved-requests")
}

function retireResolvedSessionRequests(input: {
  queryClient: ShellQueryDataWriter
  sessionId: string
  permissions?: { id: string }[]
  questions?: { id: string }[]
}) {
  setShellQueryData<ResolvedSessionRequestIds>({
    queryClient: input.queryClient,
    queryKey: resolvedSessionRequestsKey(input.sessionId),
    value: (current) => {
      if (!current) return undefined
      const retired = {
        permissions: input.permissions ? stillListedIds(current.permissions, input.permissions) : current.permissions,
        questions: input.questions ? stillListedIds(current.questions, input.questions) : current.questions,
      }
      return sameResolvedRequestIds(current, retired) ? current : retired
    },
  })
}

function stillListedIds(resolved: string[], items: { id: string }[]) {
  const listed = new Set(items.map((item) => item.id))
  return resolved.filter((id) => listed.has(id))
}

function recordResolvedSessionRequests(input: {
  queryClient: ShellQueryDataWriter
  sessionId: string
  previous: SessionRequestsQueryData | undefined
  next: SessionRequestsQueryData
}) {
  setShellQueryData<ResolvedSessionRequestIds>({
    queryClient: input.queryClient,
    queryKey: resolvedSessionRequestsKey(input.sessionId),
    value: (current) => {
      const recorded = {
        permissions: resolvedIdsAfterWrite(current?.permissions ?? [], input.previous?.permissions, input.next.permissions),
        questions: resolvedIdsAfterWrite(current?.questions ?? [], input.previous?.questions, input.next.questions),
      }
      if (!current) {
        return recorded.permissions.length === 0 && recorded.questions.length === 0 ? undefined : recorded
      }
      return sameResolvedRequestIds(current, recorded) ? current : recorded
    },
  })
}

/**
 * A write that drops a request resolves it; a write that introduces one the
 * cache did not hold re-opens it, so an id the server asks again is shown
 * rather than suppressed by an older resolution. Re-listing an id the cache
 * already held asserts nothing either way, and neither does a write that
 * carries no list for this kind at all.
 */
function resolvedIdsAfterWrite(
  resolved: string[],
  previous: { id: string }[] | undefined,
  next: { id: string }[] | undefined,
) {
  if (!next) return resolved
  const held = new Set((previous ?? []).map((item) => item.id))
  const listed = new Set(next.map((item) => item.id))
  const ids = new Set(resolved)
  for (const id of held) {
    if (!listed.has(id)) ids.add(id)
  }
  for (const id of listed) {
    if (!held.has(id)) ids.delete(id)
  }
  return [...ids]
}

function sameResolvedRequestIds(previous: ResolvedSessionRequestIds, next: ResolvedSessionRequestIds) {
  return sameIdList(previous.permissions, next.permissions) && sameIdList(previous.questions, next.questions)
}

function sameIdList(previous: string[], next: string[]) {
  return previous.length === next.length && previous.every((id, index) => id === next[index])
}

export function setSessionCapabilitiesQueryData(input: {
  queryClient: ShellQueryDataWriter
  queryKey: readonly unknown[]
  capabilities: unknown
}) {
  setShellQueryData({ ...input, value: input.capabilities })
}

export function setDirectorySessionMetaQueryData(input: {
  queryClient: ShellQueryDataWriter
  queryKey: readonly unknown[]
  value: unknown
}) {
  setShellQueryData(input)
}

export function setSessionTodoQueryData(input: {
  queryClient: ShellQueryDataWriter
  sessionId: string
  todos: Todo[]
}) {
  input.queryClient.setQueryData<Todo[]>(shellDataKeys.sessionId(input.sessionId, "todo"), (previous) =>
    sameTodos(previous, input.todos) ? previous : input.todos
  )
}

export function setSessionDiffQueryData(input: {
  queryClient: ShellQueryDataWriter
  sessionId: string
  diff: SnapshotFileDiff[]
}) {
  input.queryClient.setQueryData(shellDataKeys.sessionId(input.sessionId, "diff"), input.diff)
}

function sameTodos(previous: Todo[] | undefined, next: Todo[]) {
  return !!previous &&
    previous.length === next.length &&
    previous.every((todo, index) =>
      todo.content === next[index]?.content &&
      todo.status === next[index]?.status &&
      todo.priority === next[index]?.priority
    )
}

function sameSessionStatus(previous: SessionStatus | undefined, next: SessionStatus) {
  return !!previous && JSON.stringify(previous) === JSON.stringify(next)
}

// Compared by value, like the status writer above: a permission or question can
// change in place (a decision recorded, a question answered) while keeping its
// id, so comparing ids alone would swallow a real change.
function sameSessionRequests(previous: SessionRequestsQueryData | undefined, next: SessionRequestsQueryData) {
  return !!previous && JSON.stringify(previous) === JSON.stringify(next)
}
