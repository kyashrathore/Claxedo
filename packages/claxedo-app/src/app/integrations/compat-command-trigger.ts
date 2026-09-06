import { asRecord, readString } from "@/lib/record"
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

const compatSources = ["palette", "keybind", "slash"] as const

function compatSource(value: string | undefined): CommandTriggerCompatSource {
  return compatSources.find((item) => item === value)
}

/**
 * The trigger payload, read back off a command that crossed the bus.
 *
 * The bus is keyed by a string and carries an `unknown` payload — a handler
 * that wants this command's fields has to read them, which is what
 * `legacyCommandTrigger` above is the matching writer for.
 */
export function legacyCommandTriggerPayload(command: Command) {
  const payload = asRecord(command.payload)
  const id = readString(payload, "id")
  if (!id) return undefined
  return { id, legacySource: compatSource(readString(payload, "legacySource")) }
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
