import type { PermissionRequest, QuestionRequest, Session, SnapshotFileDiff, Todo } from "@opencode-ai/sdk/v2/client"
import { Binary } from "@/lib/binary"
import { diffs as list } from "@/lib/diffs"
import { queryClient } from "@/platform/query/query-client"
import {
  dispatchSessionRequestsEvent,
  dispatchSessionTodoEvent,
} from "../../store/session-status-dispatcher"
import { shellDataKeys } from "@/platform/sync/keys"
import { setSessionDiffQueryData } from "./queries"

type DirectoryEvent = {
  type: string
  properties?: unknown
}

function removeSessionShellQueries(sessionID: string) {
  queryClient.removeQueries({ queryKey: shellDataKeys.sessionId(sessionID) })
}

function upsertById<T extends { id: string }>(items: T[], item: T) {
  const next = items.slice()
  const idx = Binary.search(next, item.id, (current) => current.id)
  if (idx.found) {
    next[idx.index] = item
    return next
  }
  next.splice(idx.index, 0, item)
  return next
}

function removeById<T extends { id: string }>(items: T[], id: string) {
  const idx = Binary.search(items, id, (item) => item.id)
  if (!idx.found) return items
  const next = items.slice()
  next.splice(idx.index, 1)
  return next
}

function updateSessionRequests(
  sessionID: string,
  update: (cache: { permissions: PermissionRequest[]; questions: QuestionRequest[] }) => {
    permissions: PermissionRequest[]
    questions: QuestionRequest[]
  },
) {
  dispatchSessionRequestsEvent({
    event: {
      type: "session.requests",
      source: "server",
      sessionID,
      requests: (cache) => update(cache ?? { permissions: [], questions: [] }),
    },
  })
}

export function applyDirectoryEventToShellQueries(input: {
  event: DirectoryEvent
  directory: string
}) {
  switch (input.event.type) {
    case "session.updated": {
      const info = (input.event.properties as { info: Session }).info
      if (info.time?.archived) {
        removeSessionShellQueries(info.id)
      }
      break
    }
    case "session.deleted": {
      const info = (input.event.properties as { info: Session }).info
      removeSessionShellQueries(info.id)
      break
    }
    case "session.diff": {
      const props = input.event.properties as { sessionID: string; diff: SnapshotFileDiff[] }
      setSessionDiffQueryData({ queryClient, sessionId: props.sessionID, diff: list(props.diff) })
      break
    }
    case "todo.updated": {
      const props = input.event.properties as { sessionID: string; todos: Todo[] }
      dispatchSessionTodoEvent({
        event: { type: "session.todo", source: "server", sessionID: props.sessionID, todos: props.todos },
      })
      break
    }
    case "permission.asked": {
      const permission = input.event.properties as PermissionRequest
      updateSessionRequests(permission.sessionID, (cache) => ({
        ...cache,
        permissions: upsertById(cache.permissions, permission),
      }))
      break
    }
    case "permission.replied": {
      const props = input.event.properties as { sessionID: string; requestID: string }
      updateSessionRequests(props.sessionID, (cache) => ({
        ...cache,
        permissions: removeById(cache.permissions, props.requestID),
      }))
      break
    }
    case "question.asked": {
      const question = input.event.properties as QuestionRequest
      updateSessionRequests(question.sessionID, (cache) => ({
        ...cache,
        questions: upsertById(cache.questions, question),
      }))
      break
    }
    case "question.replied":
    case "question.rejected": {
      const props = input.event.properties as { sessionID: string; requestID: string }
      updateSessionRequests(props.sessionID, (cache) => ({
        ...cache,
        questions: removeById(cache.questions, props.requestID),
      }))
      break
    }
  }
}
