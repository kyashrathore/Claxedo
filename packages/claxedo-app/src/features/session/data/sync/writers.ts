// target-layer: data
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
  input.queryClient.setQueryData(shellDataKeys.sessionId(input.sessionId, "status"), input.status)
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
  input.queryClient.setQueryData(shellDataKeys.sessionId(input.sessionId, "todo"), input.todos)
}

export function setSessionDiffQueryData(input: {
  queryClient: ShellQueryDataWriter
  sessionId: string
  diff: SnapshotFileDiff[]
}) {
  input.queryClient.setQueryData(shellDataKeys.sessionId(input.sessionId, "diff"), input.diff)
}
