import type { AgentSession } from "@claxedo/agent-runtime-contract"
import { ServerError } from "./errors"
import type { ServerEvent } from "./events"
import type { RuntimeRoute, Transport } from "./transport"
import type { SessionRef, SessionStatus } from "./types"
import { sessionStatusFromWire } from "./wire/status"

export type StatusOwner = {
  readonly read: (route: RuntimeRoute, sessionId: string, row: AgentSession) => Promise<SessionStatus>
  readonly readPlacement: (route: RuntimeRoute) => Promise<ReadonlyMap<string, SessionStatus>>
  readonly apply: (event: ServerEvent) => ServerEvent | undefined
  readonly forget: (ref: SessionRef) => void
}

const STATUS_PATH = "/session/status"

function statusFromLastTurn(row: AgentSession): SessionStatus {
  const outcome = row.lastTurn
  if (outcome?.status !== "failed") return { kind: "idle" }
  return { kind: "failed", error: new ServerError({ class: "internal", message: outcome.error }) }
}

function statusesOf(body: unknown): Map<string, SessionStatus> {
  const statuses = new Map<string, SessionStatus>()
  if (!body || typeof body !== "object") return statuses
  for (const [id, value] of Object.entries(body)) {
    const status = sessionStatusFromWire(value)
    if (status) statuses.set(id, status)
  }
  return statuses
}

export function createStatusOwner(transport: Transport): StatusOwner {
  const latest = new Map<string, SessionStatus>()
  const readPlacement = async (route: RuntimeRoute) => statusesOf(await transport.runtimeJson<unknown>(route, STATUS_PATH))
  return {
    read: async (route, sessionId, row) => {
      const live = (await readPlacement(route)).get(sessionId)
      const status = live && live.kind !== "idle" ? live : statusFromLastTurn(row)
      latest.set(sessionId, status)
      return status
    },
    readPlacement,
    apply: (event) => {
      if (event.type !== "statusChanged") return event
      if (event.status.kind === "idle" && latest.get(event.ref.sessionId)?.kind === "failed") return undefined
      latest.set(event.ref.sessionId, event.status)
      return event
    },
    forget: (ref) => {
      latest.delete(ref.sessionId)
    },
  }
}
