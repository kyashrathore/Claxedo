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

export function setSessionRequestsQueryData(input: {
  queryClient: ShellQueryDataWriter
  sessionId: string
  requests: SessionRequestsQueryData | ((previous: SessionRequestsQueryData | undefined) => SessionRequestsQueryData)
}) {
  setSessionQueryData({ ...input, resource: "requests", value: input.requests })
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
