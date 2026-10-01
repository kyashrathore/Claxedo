import { asRecord, type AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import type { SessionUpdate } from "./types"
import type { TranslatorContext } from "./state"
import { diagnoseTranslation, shape } from "./diagnostics"
import { agentMessage, userMessageChunk } from "./content-chunks"
import { configOptionUpdate } from "./config-options"
import { planUpdate } from "./plan-updates"
import { toolUpdate } from "./tool-updates"
import { noticeEvent } from "./notice"
import { own } from "../../../translate/value"

type UpdateOf<K extends SessionUpdate["sessionUpdate"]> = Extract<SessionUpdate, { sessionUpdate: K }>

type Handlers = {
  [K in SessionUpdate["sessionUpdate"]]: {
    required?: readonly (readonly [string, "string" | "number"])[]
    advertised?: false
    translate: (update: UpdateOf<K>, ctx: TranslatorContext) => AgentRuntimeEvent[]
  }
}

function unadvertised(update: SessionUpdate, ctx: TranslatorContext): AgentRuntimeEvent[] {
  diagnoseTranslation(ctx.diagnostics, "acp.dropped_content", {
    reason: "unadvertised_session_update",
    shape: shape(update),
  })
  return []
}

function availableCommands(update: UpdateOf<"available_commands_update">): AgentRuntimeEvent[] {
  return [
    {
      type: "available-commands-update",
      commands: Array.isArray(update.availableCommands) ? update.availableCommands : [],
    },
  ]
}

function currentMode(update: UpdateOf<"current_mode_update">): AgentRuntimeEvent[] {
  return [{ type: "session-agent", agentId: update.currentModeId }]
}

function sessionInfo(update: UpdateOf<"session_info_update">): AgentRuntimeEvent[] {
  return [
    {
      type: "session-info",
      ...(Object.hasOwn(update, "title") ? { title: update.title ?? null } : {}),
      ...(Object.hasOwn(update, "updatedAt") ? { updatedAt: update.updatedAt ?? null } : {}),
    },
  ]
}

function usage(update: UpdateOf<"usage_update">): AgentRuntimeEvent[] {
  return [
    {
      type: "usage",
      contextSize: update.size,
      contextUsed: update.used,
      ...(update.cost ? { cost: { amount: update.cost.amount, currency: update.cost.currency } } : {}),
    },
  ]
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
  available_commands_update: { translate: availableCommands },
  current_mode_update: { required: [["currentModeId", "string"]], translate: currentMode },
  config_option_update: { translate: configOptionUpdate },
  session_info_update: { translate: sessionInfo },
  usage_update: { required: [["size", "number"], ["used", "number"]], translate: usage },
  notice: { required: [["severity", "string"], ["title", "string"]], translate: (update) => [noticeEvent(update)] },
  compaction_update: {
    required: [["compactionId", "string"], ["status", "string"]],
    advertised: false,
    translate: unadvertised,
  },
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
