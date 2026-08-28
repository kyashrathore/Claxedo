import type { Context } from "hono"
import type { SseReplayBuffer } from "@claxedo/agent-sdk-runtime/sse"
import { eventSessionId, type CompatEnvelope } from "../compat-events"
import type { WorkspaceRuntimeEvent } from "../bus"
import {
  sessionAccessContext,
  sessionAccessDenied,
  type SessionAccessPolicy,
} from "../session-access-policy"

export type SessionEventScope =
  | { managed: false }
  | { managed: true; sessionId: string }

/**
 * Managed-private event streams are session resources, not workspace-wide
 * broadcast channels. The session id is supplied by the caller and admitted
 * through the same verified relay identity and authority oracle as the REST
 * session routes. Unmanaged/local runtimes retain their existing broad stream.
 */
export async function authorizeSessionEventScope(
  c: Context,
  policy: SessionAccessPolicy | undefined,
  queryName: "sessionID" | "parentSessionId",
): Promise<SessionEventScope | Response> {
  if (policy?.sessionAuthority !== "managed-private") return { managed: false }

  const sessionId = c.req.query(queryName)?.trim()
  if (!sessionId) {
    return Response.json({
      error: {
        code: "session_event_scope_required",
        message: `Managed private event streams require ${queryName}`,
      },
    }, { status: 400 })
  }

  const decision = await policy.authorize({
    ...sessionAccessContext(c as never),
    operation: "session_event_stream",
    sessionId,
    method: c.req.method,
    path: c.req.path,
  })
  if (!decision.allowed) return sessionAccessDenied(decision)
  return { managed: true, sessionId }
}

export function compatEnvelopeSessionId(event: CompatEnvelope) {
  return eventSessionId(event.payload)
}

export function workspaceRuntimeEventSessionId(event: WorkspaceRuntimeEvent): string | undefined {
  switch (event.type) {
    case "agent.lifecycle":
      return event.sessionId
    case "session.lifecycle":
      return event.sessionID
    case "session.updated": {
      const properties = record(event.properties)
      const info = record(properties?.info)
      return text(properties?.sessionID) ?? text(properties?.sessionId) ?? text(info?.sessionID) ?? text(info?.id)
    }
    default:
      return undefined
  }
}

/** Extracts only producer-owned session identifiers; it never guesses from directory/tab ids. */
export function unknownEventSessionId(event: unknown): string | undefined {
  const row = record(event)
  if (!row) return undefined
  const properties = record(row.properties)
  const info = record(properties?.info)
  const part = record(properties?.part)
  const payload = record(row.payload)
  return text(row.sessionID)
    ?? text(row.sessionId)
    ?? text(properties?.sessionID)
    ?? text(properties?.sessionId)
    ?? text(info?.sessionID)
    ?? text(info?.id)
    ?? text(part?.sessionID)
    ?? (payload ? unknownEventSessionId(payload) : undefined)
}

export function scopedReplay<T>(
  replay: SseReplayBuffer<T>,
  allows: (event: T) => boolean,
): SseReplayBuffer<T> {
  return {
    push: (event) => replay.push(event),
    idFor: (event) => replay.idFor(event),
    lastId: () => replay.lastId(),
    hasGap: (lastEventId, throughId) => replay.hasGap(lastEventId, throughId),
    replayAfter: (lastEventId, throughId) => replay.replayAfter(lastEventId, throughId)
      .filter((event) => allows(event.payload)),
    isTerminal: (event) => replay.isTerminal(event),
  }
}

function record(input: unknown): Record<string, unknown> | undefined {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? input as Record<string, unknown>
    : undefined
}

function text(input: unknown) {
  return typeof input === "string" && input.length > 0 ? input : undefined
}
