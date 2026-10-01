import type { AgentRuntimeEvent } from "@claxedo/agent-runtime-contract"
import type { SessionUpdate } from "./types"
import type { TranslatorContext } from "./state"
import { decodeConfigOptions } from "./config-updates"
import { noticeEvent } from "./notice"

type MetadataUpdate = Extract<
  SessionUpdate,
  {
    sessionUpdate:
      | "available_commands_update"
      | "current_mode_update"
      | "config_option_update"
      | "session_info_update"
      | "usage_update"
      | "notice"
  }
>

export function sessionMetadata(update: MetadataUpdate, ctx: TranslatorContext): AgentRuntimeEvent[] {
  switch (update.sessionUpdate) {
    case "available_commands_update": {
      return [
        {
          type: "available-commands-update",
          commands: Array.isArray(update.availableCommands) ? update.availableCommands : [],
        },
      ]
    }

    case "current_mode_update": {
      return [{ type: "session-agent", agentId: update.currentModeId }]
    }

    case "config_option_update": {
      const options = decodeConfigOptions((update as { configOptions?: unknown }).configOptions, ctx.diagnostics)
      return options.length ? [{ type: "config-update", options }] : []
    }

    case "session_info_update": {
      return [
        {
          type: "session-info",
          ...(Object.hasOwn(update, "title") ? { title: update.title ?? null } : {}),
          ...(Object.hasOwn(update, "updatedAt") ? { updatedAt: update.updatedAt ?? null } : {}),
        },
      ]
    }

    case "usage_update": {
      return usageUpdate(update)
    }

    case "notice":
      return [noticeEvent(update)]
  }
}

function usageUpdate(update: Extract<SessionUpdate, { sessionUpdate: "usage_update" }>): AgentRuntimeEvent[] {
  const chunk: AgentRuntimeEvent = {
    type: "usage",
    contextSize: update.size,
    contextUsed: update.used,
  }
  if (update.cost) {
    return [{ ...chunk, cost: { amount: update.cost.amount, currency: update.cost.currency } }]
  }
  return [chunk]
}
