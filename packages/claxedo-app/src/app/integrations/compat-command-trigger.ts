import type { Command, CommandSource } from "./command-bus"

export type CommandTriggerCompatSource = "palette" | "keybind" | "slash" | undefined

export type LegacyCommandTriggerCommand = Command<
  "command.trigger",
  {
    id: string
    legacySource?: CommandTriggerCompatSource
  }
>

export const legacyCommandTriggerType = "command.trigger"

export function legacyCommandSource(source: CommandTriggerCompatSource): CommandSource {
  if (source === "slash") return { kind: "slash" }
  return { kind: "ui", surface: source ?? "api" }
}

export function legacyCommandTrigger(
  id: string,
  legacySource?: CommandTriggerCompatSource,
): LegacyCommandTriggerCommand {
  return {
    type: legacyCommandTriggerType,
    payload: {
      id,
      legacySource,
    },
    source: legacyCommandSource(legacySource),
  }
}

export function serverCommandTrigger(id: string, eventId?: string): LegacyCommandTriggerCommand {
  return {
    type: legacyCommandTriggerType,
    payload: { id },
    source: { kind: "server", eventId },
  }
}

export function serverCommandTriggerFromEvent(event: unknown): LegacyCommandTriggerCommand | undefined {
  if (!event || typeof event !== "object") return
  const payload = event as {
    id?: unknown
    type?: unknown
    properties?: {
      id?: unknown
      commandId?: unknown
      command?: unknown
    }
  }
  if (payload.type === legacyCommandTriggerType) {
    const id =
      typeof payload.properties?.id === "string"
        ? payload.properties.id
        : typeof payload.properties?.commandId === "string"
          ? payload.properties.commandId
          : undefined
    if (!id) return
    return serverCommandTrigger(id, typeof payload.id === "string" ? payload.id : undefined)
  }
  if (payload.type === "tui.command.execute" && typeof payload.properties?.command === "string") {
    return serverCommandTrigger(payload.properties.command, typeof payload.id === "string" ? payload.id : undefined)
  }
}

export function agentCommandFromEvent(event: unknown): Command | undefined {
  if (!event || typeof event !== "object") return
  const payload = event as {
    type?: unknown
    properties?: {
      agentId?: unknown
      commandType?: unknown
      command?: unknown
      payload?: unknown
    }
  }
  const source = agentCommandSource(payload.type, payload.properties?.agentId)
  if (!source) return
  const type =
    typeof payload.properties?.commandType === "string"
      ? payload.properties.commandType
      : typeof payload.properties?.command === "string"
        ? payload.properties.command
        : undefined
  if (!type) return
  return {
    type,
    payload: payload.properties?.payload,
    source,
  }
}

function agentCommandSource(type: unknown, agentId: unknown): CommandSource | undefined {
  if (typeof agentId !== "string" || agentId.length === 0) return
  if (type === "voice-agent.command.execute") return { kind: "voice-agent", agentId }
  if (type === "remote-agent.command.execute") return { kind: "remote-agent", agentId }
}
