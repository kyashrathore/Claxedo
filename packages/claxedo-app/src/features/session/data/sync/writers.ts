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
      return sameSessionRequests(previous, next) ? previous as SessionRequestsQueryData : next
    },
  })
}

export function setSessionCapabilitiesQueryData<T>(input: {
  queryClient: ShellQueryDataWriter
  queryKey: readonly unknown[]
  capabilities: T
}) {
  setShellQueryData({ ...input, value: input.capabilities })
}

export function setDirectorySessionMetaQueryData<T>(input: {
  queryClient: ShellQueryDataWriter
  queryKey: readonly unknown[]
  value: T
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
