import { asRecord as object, asText as text, userMessageIdForAssistantReply } from "@claxedo/agent-runtime-contract"
import type { AgentEventEnvelope, AgentMessageInfo } from "@claxedo/agent-runtime-contract"
import { messageUpdated, withDir } from "../presentation-events"
import type { CompatContext } from "./context"
import { projectionDiagnostic } from "./diagnostics"

/**
 * What the announced row knows about its turn — the prompt's agent, model
 * and variant. The row stands in for the one the store would emit at turn
 * start, so its identity fields must match; sparse values would overwrite a
 * populated row's chips with empty text on the merge.
 */
export type AnnouncedAssistantIdentity = {
  agent?: string
  model?: { modelID: string; providerID: string }
  variant?: string
}

/**
 * The assistant row a turn's parts hang from.
 *
 * The OpenCode compat consumers file a part against an EXISTING message: the
 * transcript store's `upsertPart` / `appendPartDelta` drop a part whose message
 * row it has never seen. The runtime's own compat producer opens every turn
 * with this row (`sdk-runtime-adapter`'s `start`: busy, the user row, then the
 * assistant row) before a single part, and a projection that is the turn's
 * whole producer stands in for it, so it owes its consumers the same row.
 *
 * `parentID` is the turn's user message, recovered from the reply id by the
 * runtime's own convention (`userMessageIdForAssistantReply`): an
 * `AgentRuntimeEvent` names the reply and nothing else, and a consumer's
 * timeline hangs every row off the user message a reply answers.
 *
 * Cost and tokens stay zero — the lane names no usage — and the session's own
 * settled transcript remains authoritative for them.
 */
function announcedAssistantMessage(
  ctx: CompatContext,
  now: number,
  parentID: string,
  identity?: AnnouncedAssistantIdentity,
): AgentMessageInfo & { sessionID: string } {
  return {
    id: ctx.assistantMsgId,
    sessionID: ctx.sessionId,
    role: "assistant",
    time: { created: now },
    parentID,
    modelID: identity?.model?.modelID ?? "",
    providerID: identity?.model?.providerID ?? "",
    mode: "auto",
    agent: identity?.agent ?? ctx.agentId,
    path: { cwd: ctx.directory, root: ctx.directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...(identity?.variant ? { variant: identity.variant } : {}),
  }
}

const PART_BEARING_COMPAT_EVENTS = new Set([
  "message.part.updated",
  "message.part.delta",
  "message.completed",
])

/** The message a part-bearing compat event files against, if it is one. */
function partBearingMessageId(event: AgentEventEnvelope): string | undefined {
  if (!PART_BEARING_COMPAT_EVENTS.has(event.payload.type)) return undefined
  const properties = object(event.payload.properties)
  return text(object(properties?.part)?.messageID) ?? text(properties?.messageID)
}

/**
 * Prepends the turn's assistant row the first time this projection emits
 * anything that hangs off it. Announcing on the first PART rather than on turn
 * start keeps a session that only ever reports status/diagnostics free of an
 * empty reply row.
 *
 * A reply id outside the runtime's turn convention names no user message, so
 * there is no row to announce: the frame's producer broke the contract this
 * lane carries, and the projection says so once per turn instead of parenting
 * the reply on something it invented.
 */
export function withAnnouncedAssistantMessage(
  ctx: CompatContext,
  events: AgentEventEnvelope[],
  now: () => number,
  announces: boolean,
  identity?: AnnouncedAssistantIdentity,
) {
  if (!announces) return events
  if (ctx.announcedAssistantMsgId === ctx.assistantMsgId) return events
  // The turn's PROMPT parts hang off their own row, which the lane opens
  // itself; only a part filed against the reply needs the reply's row first.
  if (!events.some((event) => partBearingMessageId(event) === ctx.assistantMsgId)) return events
  ctx.announcedAssistantMsgId = ctx.assistantMsgId
  const parentID = userMessageIdForAssistantReply(ctx.turnAssistantMsgId)
  if (!parentID) {
    return [
      withDir(ctx.directory, projectionDiagnostic({
        sessionID: ctx.sessionId,
        phase: "ingest",
        code: "projection.opencode_compat.reply_id_outside_turn_convention",
        message:
          "OpenCode compatibility projection cannot announce a reply whose id names no user message; " +
          "the runtime names a turn's reply after the message it answers",
        severity: "error",
        raw: ctx.turnAssistantMsgId,
      })),
      ...events,
    ]
  }
  return [withDir(ctx.directory, messageUpdated(announcedAssistantMessage(ctx, now(), parentID, identity))), ...events]
}
