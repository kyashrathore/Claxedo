import type { TerminalCheckpoint } from "@claxedo/workspace-runtime/client"
import type { ServerEvent } from "../events"
import { sessionId, terminalId, type PlacementId } from "../ids"
import type { Terminal, TerminalAgentStatus, TerminalFrame } from "../terminal-types"
import { isRecord, nonEmptyString } from "@claxedo/helpers/guards"

export const PTY_PATH = "/api/wr/pty"
export const TERMINAL_HOOK_PATH = "/api/wr/hook/terminal-session"
export const PTY_NOT_FOUND = "pty_session_not_found"

export type ParsedTerminalFrame = { readonly ok: true; readonly frame?: TerminalFrame } | { readonly ok: false; readonly reason: string }

export function terminalFromWire(value: unknown, placementId: PlacementId): Terminal | undefined {
  if (!isRecord(value)) return undefined
  const id = nonEmptyString(value.id)
  if (!id) return undefined
  const cwd = nonEmptyString(value.cwd)
  const owner = nonEmptyString(value.sessionId)
  const command = nonEmptyString(value.command)
  const createRequestId = nonEmptyString(value.createRequestId)
  return {
    id: terminalId(id),
    placementId,
    title: nonEmptyString(value.title) ?? id,
    ...(cwd ? { cwd } : {}),
    ...(owner ? { sessionId: sessionId(owner) } : {}),
    ...(command ? { command } : {}),
    ...(createRequestId ? { createRequestId } : {}),
  }
}

export function agentStatusFromWire(eventType: unknown): TerminalAgentStatus | undefined {
  switch (eventType) {
    case "Busy":
      return "working"
    case "Idle":
      return "idle"
    case "UserActionRequired":
      return "waitingOnUser"
    case "Error":
      return "failed"
    default:
      return undefined
  }
}

export function terminalEvent(type: string, raw: Record<string, unknown>, placementId: PlacementId): ServerEvent | undefined {
  switch (type) {
    case "pty.created":
    case "pty.updated": {
      const terminal = terminalFromWire(raw.info, placementId)
      if (!terminal) return undefined
      return { type: type === "pty.created" ? "terminalCreated" : "terminalUpdated", terminal }
    }
    case "pty.exited": {
      const id = nonEmptyString(raw.id)
      if (!id) return undefined
      return { type: "terminalExited", placementId, terminalId: terminalId(id), ...(typeof raw.exitCode === "number" ? { code: raw.exitCode } : {}) }
    }
    case "pty.deleted": {
      const id = nonEmptyString(raw.id)
      return id ? { type: "terminalRemoved", placementId, terminalId: terminalId(id) } : undefined
    }
    case "agent.lifecycle": {
      const status = agentStatusFromWire(raw.eventType)
      const id = nonEmptyString(raw.terminalId) ?? nonEmptyString(raw.tabId)
      return status && id ? { type: "terminalAgentStatusChanged", placementId, terminalId: terminalId(id), status } : undefined
    }
    default:
      return undefined
  }
}

function isCheckpoint(value: unknown): value is TerminalCheckpoint {
  return isRecord(value)
    && value.version === 1
    && typeof value.cols === "number"
    && typeof value.rows === "number"
    && typeof value.screen === "string"
    && typeof value.continuation === "string"
    && isRecord(value.state)
}

function metaFrame(json: string): ParsedTerminalFrame {
  let control: unknown
  try {
    control = JSON.parse(json)
  } catch (error) {
    return { ok: false, reason: `The terminal meta frame is not JSON: ${error instanceof Error ? error.message : String(error)}` }
  }
  if (!isRecord(control) || typeof control.cursor !== "number" || !Number.isSafeInteger(control.cursor) || control.cursor < 0) {
    return { ok: false, reason: "The terminal meta frame names no cursor" }
  }
  if (control.checkpoint !== undefined && !isCheckpoint(control.checkpoint)) {
    return { ok: false, reason: "The terminal checkpoint is malformed" }
  }
  return { ok: true, frame: { kind: "cursor", cursor: control.cursor, ...(control.checkpoint ? { checkpoint: control.checkpoint } : {}) } }
}

export function terminalFrameOf(data: unknown, decoder: TextDecoder): ParsedTerminalFrame {
  if (typeof data === "string") return { ok: true, ...(data ? { frame: { kind: "output", data } } : {}) }
  if (!(data instanceof ArrayBuffer)) return { ok: false, reason: "The terminal frame is neither text nor bytes" }
  const bytes = new Uint8Array(data)
  if (bytes[0] === 0) return metaFrame(new TextDecoder().decode(bytes.subarray(1)))
  const output = decoder.decode(bytes, { stream: true })
  return { ok: true, ...(output ? { frame: { kind: "output", data: output } } : {}) }
}
