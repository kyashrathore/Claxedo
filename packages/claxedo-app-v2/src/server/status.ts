import type { AgentSession } from "@claxedo/agent-runtime-contract"
import { ServerError } from "./errors"
import type { ServerEvent } from "./events"
import { sessionPath } from "./session-context"
import { withQuery, type RuntimeRoute, type Transport } from "./transport"
import type { SessionRef, SessionStatus } from "./types"
import { sessionStatusFromWire } from "./wire/status"

export type StatusAdmission =
  | { readonly kind: "admitted"; readonly event: ServerEvent }
  | { readonly kind: "held"; readonly ref: SessionRef }

export type StatusOwner = {
  readonly read: (route: RuntimeRoute, sessionId: string, row: AgentSession) => Promise<SessionStatus>
  readonly readPlacement: (route: RuntimeRoute) => Promise<ReadonlyMap<string, SessionStatus>>
  readonly settle: (route: RuntimeRoute, ref: SessionRef) => Promise<SessionStatus>
  readonly apply: (event: ServerEvent) => StatusAdmission
  readonly forget: (ref: SessionRef) => void
}

const STATUS_PATH = "/session/status"
const ROOT_SESSIONS_PATH = withQuery("/session", { roots: true })

function statusFromLastTurn(row: AgentSession): SessionStatus {
  const outcome = row.lastTurn
  if (outcome?.status !== "failed") return { kind: "idle" }
  return { kind: "failed", error: new ServerError({ class: "internal", message: outcome.error }) }
}

function settled(live: SessionStatus | undefined, row: AgentSession): SessionStatus {
  return live && live.kind !== "idle" ? live : statusFromLastTurn(row)
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

function isSessionRow(value: unknown): value is AgentSession {
  return !!value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string"
}

export function createStatusOwner(transport: Transport): StatusOwner {
  const latest = new Map<string, SessionStatus>()
  const live = async (route: RuntimeRoute) => statusesOf(await transport.runtimeJson<unknown>(route, STATUS_PATH))
  const readPlacement = async (route: RuntimeRoute) => {
    const [running, rows] = await Promise.all([live(route), transport.runtimeJson<unknown[]>(route, ROOT_SESSIONS_PATH)])
    const statuses = new Map(running)
    for (const row of rows.filter(isSessionRow)) statuses.set(row.id, settled(running.get(row.id), row))
    for (const [id, status] of statuses) latest.set(id, status)
    return statuses
  }
  const read = async (route: RuntimeRoute, sessionId: string, row: AgentSession) => {
    const status = settled((await live(route)).get(sessionId), row)
    latest.set(sessionId, status)
    return status
  }
  return {
    read,
    readPlacement,
    settle: async (route, ref) => read(route, ref.sessionId, await transport.runtimeJson<AgentSession>(route, sessionPath(ref))),
    apply: (event) => {
      if (event.type !== "statusChanged") return { kind: "admitted", event }
      if (event.status.kind === "idle" && latest.get(event.ref.sessionId)?.kind === "failed") return { kind: "held", ref: event.ref }
      latest.set(event.ref.sessionId, event.status)
      return { kind: "admitted", event }
    },
    forget: (ref) => {
      latest.delete(ref.sessionId)
    },
  }
}
