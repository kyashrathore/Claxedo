import type {
  AgentPermission as PermissionRequest,
  AgentQuestion as QuestionRequest,
  AgentSnapshotFileDiff as SnapshotFileDiff,
  AgentTodo as Todo,
} from "@claxedo/agent-runtime-contract"
import { Binary } from "@opencode-ai/ui/utils/binary"
import { diffs as list } from "@/lib/diffs"
import { queryClient } from "@/platform/query/query-client"
import {
  dispatchSessionRequestsEvent,
  dispatchSessionTodoEvent,
} from "../../store/session-status-dispatcher"
import { shellDataKeys } from "@/platform/sync/keys"
import { setSessionDiffQueryData, sessionRequestResolved } from "./queries"
import { reconcileUpdatedSessionListQueryData } from "../query/session-list"
import { sessionEventInfoId, sessionEventSummary } from "./session-event-info"
import { asRecord, isRecord, readField, readFiniteNumber, readString } from "@/lib/record"

type DirectoryEvent = {
  type: string
  properties?: unknown
}

/**
 * Payload guards for the directory event bus.
 *
 * Events arrive as `{ type: string; properties?: unknown }` frames, so every
 * branch below has to establish its own payload. Each guard checks the fields
 * the branch actually consumes; a frame that fails one is dropped rather than
 * projected as a half-built row.
 */
function isFileDiffList(value: unknown): value is SnapshotFileDiff[] {
  return Array.isArray(value) && value.every((item) =>
    isRecord(item) && typeof item.additions === "number" && typeof item.deletions === "number")
}

// `priority` is declared on the contract but producers omit it, so the guard
// checks only the two fields the todo panel renders.
function isTodoList(value: unknown): value is Todo[] {
  return Array.isArray(value) && value.every((item) =>
    isRecord(item) && typeof item.content === "string" && typeof item.status === "string")
}

function isPermissionRequest(value: unknown): value is PermissionRequest {
  return isRecord(value) && typeof value.id === "string" && typeof value.sessionID === "string"
    && typeof value.permission === "string"
}

function isQuestionRequest(value: unknown): value is QuestionRequest {
  return isRecord(value) && typeof value.id === "string" && typeof value.sessionID === "string"
    && Array.isArray(value.questions)
}

/** The `{ sessionID, requestID }` pair every permission/question reply frame carries. */
function requestReply(properties: unknown): { sessionID: string; requestID: string } | undefined {
  const sessionID = readString(properties, "sessionID")
  const requestID = readString(properties, "requestID")
  return sessionID && requestID ? { sessionID, requestID } : undefined
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
    case "message.updated": {
      // The submitting client bumps its own rail optimistically; every other
      // pane learns recency only from the directory event stream, and turn
      // completion publishes no `session.updated`. The message row's own
      // timestamps are the canonical recency for that pane — monotonic so a
      // retained replay cannot drag a session backwards in the list.
      const info = asRecord(asRecord(input.event.properties)?.info)
      const sessionID = readString(info, "sessionID")
      const time = asRecord(info?.time)
      const created = readFiniteNumber(time, "created")
      const completed = readFiniteNumber(time, "completed")
      const at = completed ?? created
      if (!sessionID || !at) break
      reconcileUpdatedSessionListQueryData({
        sessionId: sessionID,
        directory: input.directory,
        updatedAt: at,
        ...(info?.role === "user" && created !== undefined ? { lastHumanTurnAt: created } : {}),
        monotonic: true,
      })
      break
    }
    case "session.updated": {
      const info = sessionEventSummary(input.event.properties)
      if (!info) break
      reconcileUpdatedSessionListQueryData({
        sessionId: info.id,
        directory: input.directory,
        title: info.title,
        updatedAt: info.updated,
      })
      if (info.archived) {
        removeSessionShellQueries(info.id)
      }
      break
    }
    case "session.deleted": {
      const sessionId = sessionEventInfoId(input.event.properties)
      if (sessionId) removeSessionShellQueries(sessionId)
      break
    }
    case "session.diff": {
      const sessionId = readString(input.event.properties, "sessionID")
      const diff = readField(input.event.properties, "diff")
      if (!sessionId || !isFileDiffList(diff)) break
      setSessionDiffQueryData({ queryClient, sessionId, diff: list(diff) })
      break
    }
    case "todo.updated": {
      const sessionID = readString(input.event.properties, "sessionID")
      const todos = readField(input.event.properties, "todos")
      if (!sessionID || !isTodoList(todos)) break
      dispatchSessionTodoEvent({
        event: { type: "session.todo", source: "server", sessionID, todos },
      })
      break
    }
    case "permission.asked": {
      const permission = input.event.properties
      if (!isPermissionRequest(permission)) break
      // Retained runtime replay redelivers asks for requests already resolved:
      // the ledger knows that answer even though the replay carries no reply.
      if (sessionRequestResolved({ queryClient, sessionId: permission.sessionID, id: permission.id })) break
      updateSessionRequests(permission.sessionID, (cache) => ({
        ...cache,
        permissions: upsertById(cache.permissions, permission),
      }))
      break
    }
    case "permission.replied": {
      const reply = requestReply(input.event.properties)
      if (!reply) break
      updateSessionRequests(reply.sessionID, (cache) => ({
        ...cache,
        permissions: removeById(cache.permissions, reply.requestID),
      }))
      break
    }
    case "question.asked": {
      const question = input.event.properties
      if (!isQuestionRequest(question)) break
      if (sessionRequestResolved({ queryClient, sessionId: question.sessionID, id: question.id })) break
      updateSessionRequests(question.sessionID, (cache) => ({
        ...cache,
        questions: upsertById(cache.questions, question),
      }))
      break
    }
    case "question.replied":
    case "question.rejected": {
      const reply = requestReply(input.event.properties)
      if (!reply) break
      updateSessionRequests(reply.sessionID, (cache) => ({
        ...cache,
        questions: removeById(cache.questions, reply.requestID),
      }))
      break
    }
  }
}
