import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import type { SessionUpdate } from "./types"
import type { TranslatorContext } from "./state"
import { diagnoseTranslation, shape } from "./diagnostics"
import { agentMessage, userMessageChunk } from "./content-chunks"
import { planUpdate } from "./config-updates"
import { toolUpdate } from "./tool-updates"
import { sessionMetadata } from "./session-metadata"

type Handlers = {
  [K in SessionUpdate["sessionUpdate"]]: (
    update: Extract<SessionUpdate, { sessionUpdate: K }>,
    ctx: TranslatorContext,
  ) => AgentRuntimeEvent[]
}

function unadvertised(update: SessionUpdate, ctx: TranslatorContext): AgentRuntimeEvent[] {
  diagnoseTranslation(ctx.diagnostics, "acp.dropped_content", {
    reason: "unadvertised_session_update",
    shape: shape(update),
  })
  return []
}

const handlers: Handlers = {
  agent_message_chunk: agentMessage,
  agent_thought_chunk: agentMessage,
  user_message_chunk: userMessageChunk,
  tool_call: toolUpdate,
  tool_call_update: toolUpdate,
  plan: planUpdate,
  plan_update: planUpdate,
  plan_removed: planUpdate,
  available_commands_update: sessionMetadata,
  current_mode_update: sessionMetadata,
  config_option_update: sessionMetadata,
  session_info_update: sessionMetadata,
  usage_update: sessionMetadata,
  notice: sessionMetadata,
  compaction_update: unadvertised,
  compaction_summary_chunk: unadvertised,
}

export function translateSessionUpdate(update: SessionUpdate, ctx: TranslatorContext): AgentRuntimeEvent[] {
  const handler = handlers[update.sessionUpdate] as (
    update: SessionUpdate,
    ctx: TranslatorContext,
  ) => AgentRuntimeEvent[]
  return handler(update, ctx)
}
