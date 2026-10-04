import { isAgentContentPart, isAgentMessageInfo, isAgentSnapshotFileDiff, isAgentTodo, parseBackgroundWork } from "@claxedo/agent-runtime-contract"
import type { ServerEvent } from "../events"
import { placementId as asPlacementId, projectId, requestId } from "../ids"
import type { SessionLocation } from "../types"
import { provisionStatus } from "./cloud"
import { goalFromWire } from "./goal"
import { connectionStateFromWire, harnessHealthFromWire } from "./harness-state"
import { subagentFromWire } from "./subagents"
import { isPermissionWire, isQuestionWire, requestFromPermission, requestFromQuestion } from "./requests"
import { isSessionWire, lastTurnFromWire, listedStatusFromListItem, readerFromWire, sessionLocationFor, sessionRowFromSession, type Address } from "./session-row"
import { sessionStatusFromTurnError, sessionStatusFromWire } from "./status"
import { terminalEvent } from "./terminals"
import { isRecord, nonEmptyString } from "@claxedo/helpers/guards"

export type Frame = {
  readonly directory?: string
  readonly workspaceId?: string
  readonly type: string
  readonly properties?: Record<string, unknown>
  readonly raw: Record<string, unknown>
}

export function frameFromWire(input: unknown): Frame | undefined {
  if (!isRecord(input)) return undefined
  const payload = isRecord(input.payload) ? input.payload : input
  const type = nonEmptyString(payload.type)
  if (!type) return undefined
  const directory = nonEmptyString(payload.directory) ?? nonEmptyString(input.directory)
  const workspaceId = nonEmptyString(payload.workspaceId) ?? nonEmptyString(input.workspaceId)
  return {
    ...(directory ? { directory } : {}),
    ...(workspaceId ? { workspaceId } : {}),
    type,
    ...(isRecord(payload.properties) ? { properties: payload.properties } : {}),
    raw: payload,
  }
}

export function frameSessionId(frame: Frame): string | undefined {
  const properties = frame.properties ?? {}
  const info = isRecord(properties.info) ? properties.info : undefined
  const part = isRecord(properties.part) ? properties.part : undefined
  return nonEmptyString(properties.sessionID) ?? nonEmptyString(info?.sessionID) ?? nonEmptyString(info?.id) ?? nonEmptyString(part?.sessionID)
}

export function placementDirectory(frame: Frame): string | undefined {
  return frame.directory !== undefined && frame.directory !== "global" ? frame.directory : undefined
}

function refOf(frame: Frame, address: Address): SessionLocation | undefined {
  const sessionId = frameSessionId(frame)
  if (!sessionId || !frame.directory) return undefined
  return sessionLocationFor(address, { directory: frame.directory, workspaceId: frame.workspaceId, sessionId })
}

function framePlacementId(frame: Frame, address: Address) {
  return frame.directory ? address.placementFor(frame.directory, frame.workspaceId)?.placementId : undefined
}

function retractedParts(value: unknown) {
  return (Array.isArray(value) ? value : []).flatMap((item) => {
    const messageId = isRecord(item) ? nonEmptyString(item.messageID) : undefined
    const partId = isRecord(item) ? nonEmptyString(item.partID) : undefined
    return messageId && partId ? [{ messageId, partId }] : []
  })
}

function transcriptEvent(frame: Frame, ref: SessionLocation): ServerEvent | undefined {
  const properties = frame.properties ?? {}
  switch (frame.type) {
    case "message.updated":
      return isAgentMessageInfo(properties.info) ? { type: "messageUpserted", ref, message: properties.info } : undefined
    case "message.removed": {
      const messageId = nonEmptyString(properties.messageID)
      return messageId ? { type: "messageRemoved", ref, messageId } : undefined
    }
    case "message.part.updated":
      return isAgentContentPart(properties.part) ? { type: "partUpserted", ref, part: properties.part } : undefined
    case "message.part.removed": {
      const messageId = nonEmptyString(properties.messageID)
      const partId = nonEmptyString(properties.partID)
      return messageId && partId ? { type: "partRemoved", ref, messageId, partId } : undefined
    }
    case "message.part.retracted": {
      const reason = nonEmptyString(properties.reason)
      return reason ? { type: "partsRetracted", ref, reason, parts: retractedParts(properties.parts) } : undefined
    }
    case "message.part.delta": {
      const messageId = nonEmptyString(properties.messageID)
      const partId = nonEmptyString(properties.partID)
      const field = nonEmptyString(properties.field)
      if (!messageId || !partId || !field || typeof properties.delta !== "string") return undefined
      return { type: "partDelta", ref, messageId, partId, field, delta: properties.delta }
    }
    default:
      return undefined
  }
}

function harnessHealthEvent(properties: Record<string, unknown>, ref: SessionLocation): ServerEvent | undefined {
  const health = harnessHealthFromWire(properties.harnessHealth)
  if (!health) return undefined
  const connectionState = connectionStateFromWire(properties.connectionState)
  return { type: "harnessHealthChanged", ref, health, ...(connectionState ? { connectionState } : {}) }
}

function turnEnd(properties: Record<string, unknown>) {
  const lastTurn = lastTurnFromWire(properties.lastTurn)
  return lastTurn ? { lastTurn } : {}
}

function activityEvent(frame: Frame, ref: SessionLocation): ServerEvent | undefined {
  const properties = frame.properties ?? {}
  switch (frame.type) {
    case "session.status": {
      const status = sessionStatusFromWire(properties.status)
      return status ? { type: "statusChanged", ref, status } : undefined
    }
    case "session.idle":
      return { type: "statusChanged", ref, status: { kind: "idle" }, ...turnEnd(properties) }
    case "session.error":
      return { type: "statusChanged", ref, status: sessionStatusFromTurnError(properties.error), ...turnEnd(properties) }
    case "session.background-work": {
      const work = parseBackgroundWork(properties)
      return work ? { type: "backgroundWorkChanged", ref, work } : undefined
    }
    case "harness.health":
      return harnessHealthEvent(properties, ref)
    default:
      return undefined
  }
}

function lifecycleEvent(frame: Frame, ref: SessionLocation): ServerEvent | undefined {
  const properties = frame.properties ?? {}
  switch (frame.type) {
    case "session.updated":
      return isSessionWire(properties.info) ? { type: "sessionUpserted", row: sessionRowFromSession(properties.info, ref) } : undefined
    case "session.deleted":
      return { type: "sessionRemoved", ref }
    case "session.diff": {
      const diff = properties.diff
      return Array.isArray(diff) ? { type: "diffChanged", ref, diff: diff.filter(isAgentSnapshotFileDiff) } : undefined
    }
    case "goal.updated": {
      const goal = goalFromWire(properties.goal)
      return goal ? { type: "goalChanged", ref, goal } : undefined
    }
    case "goal.cleared":
      return { type: "goalChanged", ref, goal: undefined }
    case "subagent.updated": {
      const subagent = subagentFromWire(properties.update)
      return subagent ? { type: "subagentUpdated", ref, subagent } : undefined
    }
    case "todo.updated": {
      const todos = properties.todos
      return Array.isArray(todos) ? { type: "todosChanged", ref, todos: todos.filter(isAgentTodo) } : undefined
    }
    default:
      return undefined
  }
}

function requestEvent(frame: Frame, ref: SessionLocation): ServerEvent | undefined {
  const properties = frame.properties ?? {}
  switch (frame.type) {
    case "permission.asked":
      return isPermissionWire(properties) ? { type: "requestOpened", ref, request: requestFromPermission(properties) } : undefined
    case "question.asked":
      return isQuestionWire(properties) ? { type: "requestOpened", ref, request: requestFromQuestion(properties) } : undefined
    case "permission.replied":
    case "permission.expired":
    case "question.replied":
    case "question.rejected":
    case "question.expired": {
      const id = nonEmptyString(properties.requestID)
      return id ? { type: "requestClosed", ref, requestId: requestId(id) } : undefined
    }
    default:
      return undefined
  }
}

function noticeRef(raw: Record<string, unknown>, address: Address): SessionLocation | undefined {
  const id = nonEmptyString(raw.sessionId)
  const workspace = nonEmptyString(raw.workspaceId)
  return id && workspace ? sessionLocationFor(address, { directory: `workspace:${workspace}`, workspaceId: workspace, sessionId: id }) : undefined
}

function readerEvent(frame: Frame, address: Address): ServerEvent | undefined {
  const ref = noticeRef(frame.raw, address)
  return ref ? { type: "readerChanged", ref, reader: readerFromWire(frame.raw) } : undefined
}

function controlEvent(frame: Frame, address: Address): ServerEvent | undefined {
  const placementId = framePlacementId(frame, address)
  const scoped = placementId ? { placementId } : {}
  switch (frame.type) {
    case "file.watcher.updated":
    case "vcs.branch.updated":
      return placementId ? { type: "filesChanged", placementId } : undefined
    case "project.updated": {
      const info = isRecord(frame.properties?.info) ? frame.properties.info : undefined
      const id = nonEmptyString(info?.id)
      return id ? { type: "projectChanged", projectId: projectId(id) } : { type: "placementsChanged" }
    }
    case "session.reader.changed":
      return readerEvent(frame, address)
    case "session.lifecycle":
    case "session.inventory.changed":
    case "session.share.changed":
      return { type: "sessionsChanged", ...scoped }
    case "usage.quota.changed":
      return { type: "usageChanged" }
    case "plugins.changed":
      return { type: "pluginsChanged" }
    case "provision": {
      const workspaceId = nonEmptyString(frame.raw.workspaceId)
      return workspaceId ? { type: "cloudWorkspaceChanged", workspaceId: placementId ?? asPlacementId(workspaceId), status: provisionStatus(frame.raw) } : undefined
    }
    case "worktree.ready":
    case "worktree.failed":
      return { type: "placementsChanged" }
    case "pty.created":
    case "pty.updated":
    case "pty.exited":
    case "pty.deleted":
    case "agent.lifecycle":
      return placementId ? terminalEvent(frame.type, frame.raw, placementId) : undefined
    default:
      return undefined
  }
}

function statusNotice(frame: Frame, address: Address): ServerEvent | undefined {
  const { status, awaitingInput, backgroundWork, lastTurn, replayed } = frame.raw
  const listed = listedStatusFromListItem({ status: { kind: status, awaitingInput, backgroundWork } })
  const ref = noticeRef(frame.raw, address)
  if (!listed || !ref) return undefined
  const turn = lastTurnFromWire(lastTurn)
  return {
    type: "statusChanged",
    ref,
    status: listed.status,
    waitingOnUser: listed.waitingOnUser,
    backgroundWork: listed.backgroundWork,
    ...(turn ? { lastTurn: turn } : {}),
    ...(replayed === true ? { replayed } : {}),
  }
}

export const STATUS_NOTICE = "session.status.changed"

const SESSION_FRAME = /^(message\.|session\.(status|idle|error|updated|deleted|diff|background-work)$|todo\.updated$|goal\.(updated|cleared)$|subagent\.updated$|harness\.health$|permission\.|question\.)/

export function serverEventFromFrame(frame: Frame, address: Address): ServerEvent | undefined {
  if (frame.type === STATUS_NOTICE) return statusNotice(frame, address)
  if (!SESSION_FRAME.test(frame.type)) return controlEvent(frame, address)
  const ref = refOf(frame, address)
  if (!ref) return undefined
  return transcriptEvent(frame, ref) ?? activityEvent(frame, ref) ?? lifecycleEvent(frame, ref) ?? requestEvent(frame, ref)
}
