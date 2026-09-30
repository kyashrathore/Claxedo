import type { AgentEventEnvelope, AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import { boundKeyedMap } from "@claxedo/harness/translate"
import { withDir } from "../presentation-events"
import { withAnnouncedAssistantMessage, type AnnouncedAssistantIdentity } from "./assistant-row"
import type { CompatContext } from "./context"
import { projectionDiagnostic, projectionException } from "./diagnostics"
import { normalizePresentationEventWithDiagnostics } from "./normalize"
import {
  createClientPresentationProjectionState,
  RETAINED_PART_IDS_MAX,
  RETAINED_TOOL_CALLS_MAX,
  type ClientPresentationProjectionState,
} from "./state"
import { endReasoning, REASONING_ENDS_ON } from "./text-parts"
import { terminalizeOpenTools } from "./tool-lifecycle"
import { translateRuntimeEventToCompat } from "./translate"

type ClientPresentationProjection = {
  name: "client-presentation"
  ingest: (event: AgentRuntimeEvent) => AgentEventEnvelope[]
  state: () => ClientPresentationProjectionState
  terminalizeOpenTools: (error: string) => AgentEventEnvelope[]
}

type ClientPresentationProjectionOptions = {
  sessionId: string
  directory: string
  assistantMessageId: string
  /**
   * Whether this projection is the turn's ONLY producer of OpenCode-shaped
   * events, and so owes its consumers the assistant message row its parts hang
   * from.
   *
   * The OpenCode consumers file a part against an EXISTING message, so a turn's
   * row has to precede its first part. A projection composed beside a compat
   * producer that already opens every turn with that row — one that knows the
   * agent and model this lane never carries — leaves this off, or it would
   * overwrite a complete row with a thinner one. The projection that is the
   * turn's whole producer of OpenCode-shaped events (the runtime's prompt
   * projection, whose adapter lanes yield stream events and never the row)
   * turns it on.
   */
  announcesAssistantMessage?: boolean
  announceAssistantIdentity?: AnnouncedAssistantIdentity
  clock?: () => number
}

/** Per-call stores are keyed by wire `toolCallId`s; cap each before the turn grows them without bound. */
function boundRetainedState(state: ClientPresentationProjectionState) {
  boundKeyedMap(state.partIdMap, RETAINED_PART_IDS_MAX)
  boundKeyedMap(state.toolNamesByCallId, RETAINED_TOOL_CALLS_MAX)
  boundKeyedMap(state.toolInputsByCallId, RETAINED_TOOL_CALLS_MAX)
  boundKeyedMap(state.toolDisplaysByCallId, RETAINED_TOOL_CALLS_MAX)
  boundKeyedMap(state.toolMetadataByCallId, RETAINED_TOOL_CALLS_MAX)
  boundKeyedMap(state.toolStatusByCallId, RETAINED_TOOL_CALLS_MAX)
  boundKeyedMap(state.toolOutputsByCallId, RETAINED_TOOL_CALLS_MAX)
  boundKeyedMap(state.toolAttachmentsByCallId, RETAINED_TOOL_CALLS_MAX)
  boundKeyedMap(state.toolErrorsByCallId, RETAINED_TOOL_CALLS_MAX)
}

function syncState(ctx: CompatContext, state: ClientPresentationProjectionState) {
  state.assistantMsgId = ctx.assistantMsgId
  state.announcedAssistantMsgId = ctx.announcedAssistantMsgId
  state.announcedUserMsgId = ctx.announcedUserMsgId
  state.agentId = ctx.agentId
  state.accumulatedText = ctx.accumulatedText
  state.accumulatedThinkingText = ctx.accumulatedThinkingText
  state.proposedPlanText = ctx.proposedPlanText
  state.textPartSeq = ctx.textPartSeq
  state.reasoningPartSeq = ctx.reasoningPartSeq
  state.splitText = ctx.splitText
  state.splitReasoning = ctx.splitReasoning
  state.openReasoning = ctx.openReasoning
}

function createContext(
  options: ClientPresentationProjectionOptions,
  state: ClientPresentationProjectionState,
): CompatContext {
  return {
    ...state,
    sessionId: options.sessionId,
    directory: options.directory,
    assistantMsgId: state.assistantMsgId ?? options.assistantMessageId,
    turnAssistantMsgId: options.assistantMessageId,
  }
}

function normalizeProjectionEvents(
  ctx: CompatContext,
  phase: "ingest" | "terminalize",
  eventType: string | undefined,
  events: AgentEventEnvelope[],
) {
  const normalized = events.map((event) => {
    const result = normalizePresentationEventWithDiagnostics(event.payload)
    return {
      envelope: { directory: event.directory, payload: result.event },
      issues: result.issues,
    }
  })
  const issues = [...new Set(normalized.flatMap((event) => event.issues))]
  if (issues.length === 0) return normalized.map((event) => event.envelope)
  return [
    withDir(ctx.directory, projectionDiagnostic({
      sessionID: ctx.sessionId,
      phase,
      code: "projection.client_presentation.sanitized_event",
      message: "Claxedo client-presentation projection sanitized non-JSON-safe compat event data",
      ...(eventType ? { eventType } : {}),
      issues,
    })),
    ...normalized.map((event) => event.envelope),
  ]
}

export function createClientPresentationProjection(options: ClientPresentationProjectionOptions): ClientPresentationProjection {
  let state = createClientPresentationProjectionState()
  const now = options.clock ?? Date.now

  const run = (
    phase: "ingest" | "terminalize",
    eventType: string | undefined,
    project: (ctx: CompatContext) => AgentEventEnvelope[],
  ) => {
    const next = createClientPresentationProjectionState(state)
    const ctx = createContext(options, next)
    try {
      const events = normalizeProjectionEvents(
        ctx,
        phase,
        eventType,
        withAnnouncedAssistantMessage(ctx, project(ctx), now, options.announcesAssistantMessage === true, options.announceAssistantIdentity),
      )
      syncState(ctx, next)
      boundRetainedState(next)
      state = next
      return events
    } catch (error) {
      return [projectionException(createContext(options, state), phase, eventType, error)]
    }
  }

  return {
    name: "client-presentation",
    ingest(event) {
      return run("ingest", event.type, (ctx) => [
        ...(REASONING_ENDS_ON.has(event.type) ? endReasoning(ctx, now) : []),
        ...translateRuntimeEventToCompat(event, ctx, now),
      ])
    },
    terminalizeOpenTools(error) {
      return run("terminalize", undefined, (ctx) => [...endReasoning(ctx, now), ...terminalizeOpenTools(ctx, error, now)])
    },
    state: () => state,
  } satisfies ClientPresentationProjection
}
