/**
 * OpenCode's subagent rail.
 *
 * Every other harness discovers a delegation from a vendor protocol message
 * (`claudeSubagentObservations`, the codex `collabAgentToolCall` items, the ACP
 * `_meta` extensions). OpenCode's "vendor protocol" is its OWN compat event
 * stream, and its `task` tool publishes the correlation the host needs directly
 * onto the parent's tool part: `state.metadata` carries
 * `{ parentSessionId, sessionId }` — the engine's authoritative link between the
 * spawning tool call and the real child Session it created
 * (`packages/opencode/src/tool/task.ts`). That pair is the ONLY thing this
 * translator reads; nothing here infers a child from a title, an agent name, or
 * a session-list scan.
 *
 * A `task` part is only recognised once BOTH metadata fields are present. That
 * is deliberate:
 *
 *  - `ToolStatePending` carries no metadata at all, so a pending part cannot
 *    identify anything to observe, and
 *  - `task` is not an OpenCode-exclusive tool name (Cursor's native SDK uses it
 *    too, and that rail admits its own observations through the SDK adapter).
 *    Requiring the engine-minted pair keeps this rail from double-admitting
 *    another rail's delegation.
 *
 * `observationId` is content-addressed rather than sequenced: the engine
 * re-publishes a part on every state change, the same part can be replayed, and
 * the admission boundary rejects a reused observation id whose content changed.
 * Hashing the derived body makes an identical repeat a no-op and a real
 * transition a new observation.
 */
import { createHash } from "node:crypto"
import type { CompatEvent } from "../../compat-events"
import type { SubagentObservation } from "../../subagent-admission"

/** Provider namespace for OpenCode-engine child sessions. */
export const OPENCODE_SUBAGENT_PROVIDER_KIND = "opencode-session"

type ObservationBody = Omit<SubagentObservation, "observationId">

/**
 * Translate one OpenCode compat event into the subagent observations it
 * carries. Returns `[]` for every event that is not a `task` tool part bound to
 * an engine child session.
 */
export function opencodeSubagentObservations(event: CompatEvent): SubagentObservation[] {
  if (event.type !== "message.part.updated") return []
  const part = event.properties.part as {
    type?: string
    tool?: string
    callID?: string
    state?: {
      status?: string
      input?: Record<string, unknown>
      metadata?: Record<string, unknown>
    }
  }
  if (part.type !== "tool" || part.tool !== "task" || !part.callID) return []
  const state = part.state
  if (!state) return []
  const metadata = state.metadata
  const childSessionId = text(metadata?.sessionId)
  if (!childSessionId || !text(metadata?.parentSessionId)) return []

  const input = state.input ?? {}
  const description = text(input.description) ?? text(input.prompt)
  const body: ObservationBody = {
    toolCallId: part.callID,
    toolCallRole: "spawn",
    mode: metadata?.background === true || input.background === true ? "background" : "foreground",
    status: subagentStatus(state.status),
    ...(text(input.subagent_type) ? { subagentType: text(input.subagent_type) } : {}),
    ...(description ? { description } : {}),
    providerId: childSessionId,
    providerKind: OPENCODE_SUBAGENT_PROVIDER_KIND,
    childSessionId,
    // The child is a first-class Session in the same host, so its transcript is
    // read through the ordinary session routes — no file handle, no replay copy.
    transcript: { kind: "live", ref: childSessionId },
  }
  return [{ observationId: observationId(part.callID, body), ...body }]
}

// `ToolState` is a closed four-member union; an id outside it can only come
// from an engine newer than this build, and "the delegation is in flight" is the
// only honest reading of a state whose terminality is unknown.
function subagentStatus(status: string | undefined): SubagentObservation["status"] {
  switch (status) {
    case "pending": return "pending"
    case "running": return "running"
    case "completed": return "completed"
    case "error": return "failed"
    default: return "running"
  }
}

function observationId(callId: string, body: ObservationBody) {
  const digest = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16)
  return `opencode:task:${callId}:${digest}`
}

function text(value: unknown) {
  return typeof value === "string" && value ? value : undefined
}
