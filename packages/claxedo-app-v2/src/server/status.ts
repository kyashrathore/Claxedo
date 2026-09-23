import type { AgentSession } from "@claxedo/agent-runtime-contract"
import { ServerError } from "./errors"
import type { ServerEvent } from "./events"
import type { RuntimeRoute, Transport } from "./transport"
import type { SessionRef, SessionStatus } from "./types"
import { sessionStatusFromWire } from "./wire/status"

export type StatusOwner = {
  readonly read: (route: RuntimeRoute, sessionId: string, row?: AgentSession) => Promise<SessionStatus>
  readonly apply: (event: ServerEvent) => ServerEvent | undefined
  readonly forget: (ref: SessionRef) => void
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

export function statusFromLastTurn(row: AgentSession | undefined): SessionStatus {
  const outcome = row?.lastTurn
  if (outcome?.status === "failed") {
    return { kind: "failed", error: new ServerError({ class: "internal", message: outcome.error }) }
  }
  return { kind: "idle" }
}

export function statusFromSnapshot(map: unknown, sessionId: string, row: AgentSession | undefined): SessionStatus {
  const entry = isRecord(map) ? map[sessionId] : undefined
  const live = sessionStatusFromWire(entry)
  if (live && live.kind !== "idle") return live
  return statusFromLastTurn(row)
}

export function createStatusOwner(transport: Transport): StatusOwner {
  const latest = new Map<string, SessionStatus>()
  return {
    read: async (route, sessionId, row) => {
      const map = await transport.runtimeJson<unknown>(route, "/session/status")
      const status = statusFromSnapshot(map, sessionId, row)
      latest.set(sessionId, status)
      return status
    },
    apply: (event) => {
      if (event.type !== "statusChanged") return event
      const current = latest.get(event.ref.sessionId)
      if (event.status.kind === "idle" && current?.kind === "failed") return undefined
      latest.set(event.ref.sessionId, event.status)
      return event
    },
    forget: (ref) => {
      latest.delete(ref.sessionId)
    },
  }
}
