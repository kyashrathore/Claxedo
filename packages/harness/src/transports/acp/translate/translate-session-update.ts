import { asRecord, type AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import type { SessionUpdate } from "./types"
import type { TranslatorContext } from "./state"
import { diagnoseTranslation, shape } from "./diagnostics"
import { agentMessage, userMessageChunk } from "./content-chunks"
import { decodeConfigOptions, planUpdate } from "./config-updates"
import { toolUpdate } from "./tool-updates"
import { noticeEvent } from "./notice"
import { own } from "../../../translate/value"

type Handlers = {
  [K in SessionUpdate["sessionUpdate"]]: {
    required?: readonly (readonly [string, "string" | "number"])[]
    advertised?: false
    translate: (update: Extract<SessionUpdate, { sessionUpdate: K }>, ctx: TranslatorContext) => AgentRuntimeEvent[]
  }
}

function unadvertised(update: SessionUpdate, ctx: TranslatorContext): AgentRuntimeEvent[] {
  diagnoseTranslation(ctx.diagnostics, "acp.dropped_content", {
    reason: "unadvertised_session_update",
    shape: shape(update),
  })
  return []
}

const handlers: Handlers = {
  agent_message_chunk: { translate: agentMessage },
  agent_thought_chunk: { translate: agentMessage },
  user_message_chunk: { translate: userMessageChunk },
  tool_call: { required: [["toolCallId", "string"]], translate: toolUpdate },
  tool_call_update: { required: [["toolCallId", "string"]], translate: toolUpdate },
  plan: { translate: planUpdate },
  plan_update: { translate: planUpdate },
  plan_removed: { translate: planUpdate },
  available_commands_update: { translate: (update) => [{ type: "available-commands-update",
    commands: Array.isArray(update.availableCommands) ? update.availableCommands : [] }] },
  current_mode_update: { required: [["currentModeId", "string"]],
    translate: (update) => [{ type: "session-agent", agentId: update.currentModeId }] },
  config_option_update: { translate: (update, ctx) => {
    const options = decodeConfigOptions(update.configOptions, ctx.diagnostics)
    return options.length ? [{ type: "config-update", options }] : []
  } },
  session_info_update: { translate: (update) => [{ type: "session-info",
    ...(Object.hasOwn(update, "title") ? { title: update.title ?? null } : {}),
    ...(Object.hasOwn(update, "updatedAt") ? { updatedAt: update.updatedAt ?? null } : {}) }] },
  usage_update: { required: [["size", "number"], ["used", "number"]],
    translate: (update) => [{ type: "usage", contextSize: update.size, contextUsed: update.used,
      ...(update.cost ? { cost: { amount: update.cost.amount, currency: update.cost.currency } } : {}) }] },
  notice: { required: [["severity", "string"], ["title", "string"]], translate: (update) => [noticeEvent(update)] },
  compaction_update: { required: [["compactionId", "string"], ["status", "string"]], advertised: false, translate: unadvertised },
  compaction_summary_chunk: { required: [["compactionId", "string"]], advertised: false, translate: unadvertised },
}

export function isSessionUpdate(value: unknown): value is SessionUpdate {
  const row = asRecord(value)
  const definition = row && typeof row.sessionUpdate === "string" ? own(handlers, row.sessionUpdate) : undefined
  return !!definition && (definition.required ?? []).every(([field, kind]) => typeof row![field] === kind)
}

export function isAdvertisedUpdate(kind: string): boolean {
  const definition = own(handlers, kind)
  return !!definition && definition.advertised !== false
}

export function translateSessionUpdate(update: SessionUpdate, ctx: TranslatorContext): AgentRuntimeEvent[] {
  const handler = handlers[update.sessionUpdate].translate as (
    update: SessionUpdate,
    ctx: TranslatorContext,
  ) => AgentRuntimeEvent[]
  return handler(update, ctx)
}
