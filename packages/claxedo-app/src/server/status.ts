import type { AgentSession, AgentTurnOutcome } from "@claxedo/agent-runtime-contract"
import { ServerError } from "./errors"
import type { ServerEvent } from "./events"
import { sessionEndpoint } from "./session-context"
import type { PlacementId } from "./ids"
import { withQuery, type RuntimeRoute, type Transport } from "./transport"
import type { SessionRef, SessionStatus } from "./types"
import { OPEN_VIEW, sessionOpenFromWire, type SessionFact } from "./wire/session-open"

export type StatusAdmission =
  | { readonly kind: "admitted"; readonly event: ServerEvent }
  | { readonly kind: "held"; readonly ref: SessionRef }

export type StatusOwner = {
  readonly read: (ref: SessionRef, lastTurn: AgentTurnOutcome | undefined, live: SessionFact<SessionStatus | undefined>) => SessionStatus
  readonly listed: (ref: SessionRef, status: SessionStatus) => SessionStatus
  readonly settle: (route: RuntimeRoute, ref: SessionRef) => Promise<SessionStatus>
  readonly apply: (event: ServerEvent) => StatusAdmission
  readonly forget: (ref: SessionRef) => void
}

type FailedStatus = Extract<SessionStatus, { kind: "failed" }>

export const RUNNING_IN_BACKGROUND: Extract<SessionStatus, { kind: "runningInBackground" }> = { kind: "runningInBackground" }

export function sessionStatusWithBackgroundWork<S extends { readonly kind: string }>(status: S, backgroundWork: boolean): S | typeof RUNNING_IN_BACKGROUND {
  return backgroundWork && (status.kind === "idle" || status.kind === "unknown") ? RUNNING_IN_BACKGROUND : status
}

function statusFromLastTurn(outcome: AgentTurnOutcome | undefined): SessionStatus {
  if (outcome?.status !== "failed") return { kind: "idle" }
  return { kind: "failed", error: new ServerError({ class: "internal", message: outcome.error }) }
}

function liveOrLastTurnStatus(live: SessionStatus | undefined, lastTurn: AgentTurnOutcome | undefined): SessionStatus {
  return live && live.kind !== "idle" ? live : statusFromLastTurn(lastTurn)
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
  }
}

export function createStatusOwner(transport: Transport): StatusOwner {
  const failures = createFailures()
  const read = (ref: SessionRef, lastTurn: AgentTurnOutcome | undefined, live: SessionFact<SessionStatus | undefined>) => {
    if ("error" in live) throw live.error
    const read = liveOrLastTurnStatus(live.value, lastTurn)
    const known = failures.get(ref)
    if (!known) return read
    if (read.kind === "failed") return known
    failures.forget(ref)
    return read
  }
  return {
    read,
    listed: (ref, status) => (status.kind === "idle" ? (failures.get(ref) ?? status) : status),
    settle: async (route, ref) => {
      const [row, view] = await Promise.all([
        transport.runtimeJson<AgentSession>(route, sessionEndpoint(ref)),
        transport.runtimeJson<unknown>(route, withQuery(sessionEndpoint(ref), OPEN_VIEW)).then(sessionOpenFromWire),
      ])
      return read(ref, row.lastTurn, view.status)
    },
    apply: (event) => {
      if (event.type !== "statusChanged") return { kind: "admitted", event }
      if (event.status.kind === "idle" && failures.get(event.ref)) return { kind: "held", ref: event.ref }
      failures.record(event.ref, event.status)
      return { kind: "admitted", event }
    },
    forget: failures.forget,
  }
}
