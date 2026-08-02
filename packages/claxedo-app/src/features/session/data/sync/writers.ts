import { shellDataKeys } from "@/platform/sync/keys"
import type { SessionRequestsQueryData, SessionStatus, SnapshotFileDiff, Todo } from "./queries"

export type ShellQueryDataWriter = {
  setQueryData<T>(
    queryKey: readonly unknown[],
    value: T | undefined | ((previous: T | undefined) => T | undefined),
  ): unknown
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
  input.queryClient.setQueryData(shellDataKeys.sessionId(input.sessionId, "requests"), input.requests)
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
