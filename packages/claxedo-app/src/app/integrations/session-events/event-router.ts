// target-layer: data
import { applyRegisteredConversationEvent } from "../../../features/session/conversation/conversation-registry"
import { isConversationEventType } from "../../../features/session/conversation/conversation-event"
import { applySessionStatusSseEvent } from "../../../features/session/store/session-status-dispatcher"
import { shellDataKeys } from "@/platform/sync/keys"
import { applyDirectoryEventToShellQueries } from "../../../features/session/data/sync/directory-event-projector"
import { applyDirectorySessionCacheEvent } from "../../../features/session/data/sync/session-list-events"
import type { DirectorySessionCacheValue } from "../../../features/session/data/sync/queries"

export type StreamSyncAction =
  | {
      type: "conversation"
      sessionId?: string
      event: RoutableEvent
    }
  | {
      type: "targeted"
      queryKeys: readonly (readonly unknown[])[]
      event: RoutableEvent
    }
  | {
      type: "coarse"
      event: RoutableEvent
    }

export type RoutableEvent = {
  type: string
  properties?: unknown
}

type DirectoryRef = string

export type DirectoryEventRouterSinks = {
  schedule?: (event: RoutableEvent) => void
  mark?: () => void
  cache: () => DirectorySessionCacheValue
  cacheSessions: (cache: DirectorySessionCacheValue) => void
  push: (directory: DirectoryRef) => void
}

export function classifyStreamEvent(event: RoutableEvent): StreamSyncAction {
  if (isConversationEventType(event.type)) {
    return {
      type: "conversation",
      sessionId: sessionIdFromEvent(event),
      event,
    }
  }

  const queryKeys = targetedQueryKeys(event)
  if (queryKeys.length > 0) {
    return {
      type: "targeted",
      queryKeys,
      event,
    }
  }

  return {
    type: "coarse",
    event,
  }
}

export function routeDirectoryEvent(input: {
  event: RoutableEvent
  directory: DirectoryRef
  sinks: DirectoryEventRouterSinks
}) {
  const action = classifyStreamEvent(input.event)
  if (action.type === "conversation") {
    applyRegisteredConversationEvent(input.event as Parameters<typeof applyRegisteredConversationEvent>[0])
  }

  input.sinks.schedule?.(input.event)
  applyDirectoryEventToShellQueries({ event: input.event, directory: input.directory })
  input.sinks.mark?.()
  applySessionStatusSseEvent({ event: input.event, directory: input.directory })

  const next = applyDirectorySessionCacheEvent({
    event: input.event,
    directory: input.directory,
    cache: input.sinks.cache(),
    push: input.sinks.push,
  })
  if (next) input.sinks.cacheSessions(next)
  return action
}

function targetedQueryKeys(event: RoutableEvent) {
  const props = record(event.properties)
  const sessionId = sessionIdFromEvent(event)
  if (sessionId && (
    event.type === "permission.asked" ||
    event.type === "permission.replied" ||
    event.type === "question.asked" ||
    event.type === "question.replied" ||
    event.type === "question.rejected"
  )) {
    return [
      shellDataKeys.sessionId(sessionId, "requests"),
    ]
  }
  if (sessionId && event.type === "todo.updated") {
    return [
      shellDataKeys.sessionId(sessionId, "todo"),
    ]
  }
  if (sessionId && event.type === "session.diff") {
    return [
      shellDataKeys.sessionId(sessionId, "diff"),
    ]
  }
  if (sessionId && event.type.startsWith("session.")) {
    return [
      shellDataKeys.sessionId(sessionId, "row"),
    ]
  }

  const workspaceId = text(props?.workspaceId)
  if (workspaceId && (
    event.type.startsWith("file.") ||
    event.type.startsWith("vcs.") ||
    event.type.startsWith("mcp.") ||
    event.type.startsWith("lsp.")
  )) {
    return [
      shellDataKeys.workspace(workspaceId, event.type.split(".")[0]),
    ]
  }

  return []
}

function sessionIdFromEvent(event: RoutableEvent) {
  const props = record(event.properties)
  return text(props?.sessionID) ??
    text(props?.sessionId) ??
    text(record(props?.info)?.sessionID) ??
    text(record(props?.session)?.id)
}

function record(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined
}

function text(input: unknown) {
  return typeof input === "string" && input.length > 0 ? input : undefined
}
