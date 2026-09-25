import type { AgentSession } from "@claxedo/agent-runtime-contract"
import { ServerError } from "./errors"
import type { ServerEvent } from "./events"
import { sessionEndpoint } from "./session-context"
import type { PlacementId } from "./ids"
import type { RuntimeRoute, Transport } from "./transport"
import type { SessionRef, SessionStatus } from "./types"
import { sessionStatusFromWire } from "./wire/status"

export type StatusAdmission =
  | { readonly kind: "admitted"; readonly event: ServerEvent }
  | { readonly kind: "held"; readonly ref: SessionRef }

export type StatusOwner = {
  readonly read: (route: RuntimeRoute, ref: SessionRef, row: AgentSession) => Promise<SessionStatus>
  readonly readPlacement: (route: RuntimeRoute, placementId: PlacementId) => Promise<ReadonlyMap<string, SessionStatus>>
  readonly settle: (route: RuntimeRoute, ref: SessionRef) => Promise<SessionStatus>
  readonly apply: (event: ServerEvent) => StatusAdmission
  readonly forget: (ref: SessionRef) => void
}

const STATUS_PATH = "/session/status"

type FailedStatus = Extract<SessionStatus, { kind: "failed" }>

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

function failureKey(placementId: PlacementId, sessionId: string): string {
  return `${placementId}\u0000${sessionId}`
}

function createFailures() {
  const failures = new Map<string, FailedStatus>()
  return {
    get: (ref: SessionRef) => failures.get(failureKey(ref.placementId, ref.sessionId)),
    record: (ref: SessionRef, status: SessionStatus) => {
      const key = failureKey(ref.placementId, ref.sessionId)
      if (status.kind === "failed") failures.set(key, status)
      else if (status.kind !== "idle") failures.delete(key)
    },
    forget: (ref: SessionRef) => failures.delete(failureKey(ref.placementId, ref.sessionId)),
    ofPlacement: (placementId: PlacementId) => {
      const prefix = failureKey(placementId, "")
      return [...failures].flatMap(([key, status]) => (key.startsWith(prefix) ? [[key.slice(prefix.length), status] as const] : []))
    },
  }
}

export function createStatusOwner(transport: Transport): StatusOwner {
  const failures = createFailures()
  const live = async (route: RuntimeRoute) => statusesOf(await transport.runtimeJson<unknown>(route, STATUS_PATH))
  const readPlacement = async (route: RuntimeRoute, placementId: PlacementId) => {
    const statuses = await live(route)
    for (const [id, failed] of failures.ofPlacement(placementId)) if ((statuses.get(id)?.kind ?? "idle") === "idle") statuses.set(id, failed)
    return statuses
  }
  const read = async (route: RuntimeRoute, ref: SessionRef, row: AgentSession) => {
    const read = settled((await live(route)).get(ref.sessionId), row)
    const known = failures.get(ref)
    if (!known) return read
    if (read.kind === "failed") return known
    failures.forget(ref)
    return read
  }
  return {
    read,
    readPlacement,
    settle: async (route, ref) => read(route, ref, await transport.runtimeJson<AgentSession>(route, sessionEndpoint(ref))),
    apply: (event) => {
      if (event.type !== "statusChanged") return { kind: "admitted", event }
      if (event.status.kind === "idle" && failures.get(event.ref)) return { kind: "held", ref: event.ref }
      failures.record(event.ref, event.status)
      return { kind: "admitted", event }
    },
    forget: failures.forget,
  }
}
