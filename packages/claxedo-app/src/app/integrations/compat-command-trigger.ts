import type { Command, CommandSource } from "./command-bus"

export type CommandTriggerCompatSource = "palette" | "keybind" | "slash" | undefined

export type LegacyCommandTriggerCommand = Command<"command.trigger", {
  id: string
  legacySource?: CommandTriggerCompatSource
}>

export const legacyCommandTriggerType = "command.trigger"

export function legacyCommandSource(source: CommandTriggerCompatSource): CommandSource {
  if (source === "slash") return { kind: "slash" }
  return { kind: "ui", surface: source ?? "api" }
}

export function legacyCommandTrigger(id: string, legacySource?: CommandTriggerCompatSource): LegacyCommandTriggerCommand {
  return {
    type: legacyCommandTriggerType,
    payload: {
      id,
      legacySource,
    },
    source: legacyCommandSource(legacySource),
  }
}
