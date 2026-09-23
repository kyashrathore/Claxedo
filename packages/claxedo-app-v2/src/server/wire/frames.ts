import { isAgentContentPart, isAgentMessageInfo, type AgentSession } from "@claxedo/agent-runtime-contract"
import type { ServerEvent } from "../events"
import { projectId, requestId } from "../ids"
import type { FileDiff, SessionRef, Todo } from "../types"
import { isPermissionWire, isQuestionWire, permissionRequest, questionRequest } from "./requests"
import { sessionRefFor, sessionRowFromSession, type Address } from "./session-row"
import { sessionStatusFailed, sessionStatusFromWire } from "./status"

export type Frame = {
  readonly directory?: string
  readonly workspaceId?: string
  readonly type: string
  readonly properties?: Record<string, unknown>
  readonly raw: Record<string, unknown>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

function isSessionInfo(value: unknown): value is AgentSession {
  return isRecord(value) && typeof value.id === "string"
}

export function frameOf(input: unknown): Frame | undefined {
  if (!isRecord(input)) return undefined
  const payload = isRecord(input.payload) ? input.payload : input
  const type = text(payload.type)
  if (!type) return undefined
  const directory = text(payload.directory) ?? text(input.directory)
  const workspaceId = text(payload.workspaceId) ?? text(input.workspaceId)
  return {
    ...(directory ? { directory } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    type,
    ...(isRecord(payload.properties) ? { properties: payload.properties } : {}),
    raw: payload,
  }
}

function sessionIdOf(frame: Frame): string | undefined {
  const properties = frame.properties ?? {}
  const info = isRecord(properties.info) ? properties.info : undefined
  const part = isRecord(properties.part) ? properties.part : undefined
  return text(properties.sessionID) ?? text(info?.sessionID) ?? text(info?.id) ?? text(part?.sessionID)
}

export function frameNeedsAddress(frame: Frame) {
  return frame.directory !== undefined && frame.directory !== "global"
}

function refOf(frame: Frame, address: Address): SessionRef | undefined {
  const sessionId = sessionIdOf(frame)
  if (!sessionId || !frame.directory) return undefined
  return sessionRefFor(address, { directory: frame.directory, workspaceId: frame.workspaceId, sessionId })
}

function placementOf(frame: Frame, address: Address) {
  return frame.directory ? address.placementFor(frame.directory, frame.workspaceId)?.placementId : undefined
}

function todosOf(value: unknown): Todo[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is Todo => isRecord(item) && typeof item.content === "string" && typeof item.status === "string")
}

function diffOf(value: unknown): FileDiff[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is FileDiff => isRecord(item) && typeof item.additions === "number" && typeof item.deletions === "number")
}

function transcriptEvent(frame: Frame, ref: SessionRef): ServerEvent | undefined {
  const properties = frame.properties ?? {}
  switch (frame.type) {
    case "message.updated":
      return isAgentMessageInfo(properties.info) ? { type: "messageUpserted", ref, message: properties.info } : undefined
    case "message.removed": {
      const messageId = text(properties.messageID)
      return messageId ? { type: "messageRemoved", ref, messageId } : undefined
    }
    case "message.part.updated":
      return isAgentContentPart(properties.part) ? { type: "partUpserted", ref, part: properties.part } : undefined
    case "message.part.removed": {
      const messageId = text(properties.messageID)
      const partId = text(properties.partID)
      return messageId && partId ? { type: "partRemoved", ref, messageId, partId } : undefined
    }
    case "message.part.delta": {
      const messageId = text(properties.messageID)
      const partId = text(properties.partID)
      const field = text(properties.field)
      if (!messageId || !partId || !field || typeof properties.delta !== "string") return undefined
      return { type: "partDelta", ref, messageId, partId, field, delta: properties.delta }
    }
    default:
      return undefined
  }
}

function lifecycleEvent(frame: Frame, ref: SessionRef): ServerEvent | undefined {
  const properties = frame.properties ?? {}
  switch (frame.type) {
    case "session.status": {
      const status = sessionStatusFromWire(properties.status)
      return status ? { type: "statusChanged", ref, status } : undefined
    }
    case "session.idle":
      return { type: "statusChanged", ref, status: { kind: "idle" } }
    case "session.error":
      return { type: "statusChanged", ref, status: sessionStatusFailed(properties.error) }
    case "session.updated":
      return isSessionInfo(properties.info) ? { type: "sessionUpserted", row: sessionRowFromSession(properties.info, ref) } : undefined
    case "session.deleted":
      return { type: "sessionRemoved", ref }
    case "session.diff": {
      const diff = diffOf(properties.diff)
      return diff ? { type: "diffChanged", ref, diff } : undefined
    }
    case "todo.updated": {
      const todos = todosOf(properties.todos)
      return todos ? { type: "todosChanged", ref, todos } : undefined
    }
    default:
      return undefined
  }
}

function requestEvent(frame: Frame, ref: SessionRef): ServerEvent | undefined {
  const properties = frame.properties ?? {}
  switch (frame.type) {
    case "permission.asked":
      return isPermissionWire(properties) ? { type: "requestOpened", ref, request: permissionRequest(properties) } : undefined
    case "question.asked":
      return isQuestionWire(properties) ? { type: "requestOpened", ref, request: questionRequest(properties) } : undefined
    case "permission.replied":
    case "question.replied":
    case "question.rejected": {
      const id = text(properties.requestID)
      return id ? { type: "requestClosed", ref, requestId: requestId(id) } : undefined
    }
    default:
      return undefined
  }
}

function controlEvent(frame: Frame, address: Address): ServerEvent | undefined {
  const raw = frame.raw
  const placementId = placementOf(frame, address)
  const scoped = placementId ? { placementId } : {}
  switch (frame.type) {
    case "file.watcher.updated":
    case "vcs.branch.updated":
      return placementId ? { type: "filesChanged", placementId } : undefined
    case "project.updated": {
      const info = isRecord(frame.properties?.info) ? frame.properties.info : undefined
      const id = text(info?.id)
      return id ? { type: "projectChanged", projectId: projectId(id) } : { type: "placementsChanged" }
    }
    case "session.lifecycle":
    case "session.inventory.changed":
    case "session.share.changed":
      return { type: "sessionsChanged", ...scoped }
    case "document.changed":
      return { type: "documentsChanged", ...scoped }
    case "usage.quota.changed":
      return { type: "usageChanged" }
    case "provision":
    case "worktree.ready":
    case "worktree.failed":
      return { type: "placementsChanged" }
    case "pty.created":
    case "pty.updated":
    case "pty.exited":
    case "pty.deleted": {
      const info = isRecord(raw.info) ? raw.info : undefined
      const terminalId = text(raw.id) ?? text(info?.id)
      if (!terminalId) return undefined
      const change = frame.type === "pty.created" ? "created" : frame.type === "pty.updated" ? "updated" : frame.type === "pty.exited" ? "exited" : "removed"
      return { type: "terminalChanged", ...scoped, terminalId, change }
    }
    case "agent.lifecycle":
      return agentActivity(frame, placementId)
    default:
      return undefined
  }
}

function agentActivity(frame: Frame, placementId: ReturnType<typeof placementOf>): ServerEvent | undefined {
  const raw = frame.raw
  const eventType = raw.eventType
  const activity = eventType === "Busy" ? "busy" : eventType === "Idle" ? "idle" : eventType === "UserActionRequired" ? "waitingOnUser" : eventType === "Error" ? "failed" : undefined
  if (!activity) return undefined
  const terminalId = text(raw.terminalId) ?? text(raw.tabId)
  const sessionId = text(raw.sessionId)
  return {
    type: "agentActivity",
    ...(placementId ? { placementId } : {}),
    ...(terminalId ? { terminalId } : {}),
    ...(sessionId ? { sessionId } : {}),
    activity,
  }
}

const SESSION_FRAME = /^(message\.|session\.(status|idle|error|updated|deleted|diff)$|todo\.updated$|permission\.|question\.)/

export function serverEventFromFrame(frame: Frame, address: Address): ServerEvent | undefined {
  if (!SESSION_FRAME.test(frame.type)) return controlEvent(frame, address)
  const ref = refOf(frame, address)
  if (!ref) return undefined
  return transcriptEvent(frame, ref) ?? lifecycleEvent(frame, ref) ?? requestEvent(frame, ref)
}
