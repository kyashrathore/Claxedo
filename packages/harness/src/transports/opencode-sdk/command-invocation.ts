import type { TurnInput } from "../../contract"
import type { CommandEntry } from "./catalog-port"

export type CommandInvocation = { command: string; text: string }

const COMMAND_TEXT = /^\/(\S+)(?:\s+([\s\S]*))?$/

export async function declaredCommand(commands: () => Promise<readonly CommandEntry[]>, turn: TurnInput): Promise<CommandInvocation | undefined> {
  if (turn.system !== undefined || turn.prompt.parts.some((part) => part.type !== "text")) return undefined
  const match = COMMAND_TEXT.exec(turn.prompt.parts.map((part) => part.type === "text" ? part.text : "").join("\n").trim())
  const command = match?.[1]
  if (!command) return undefined
  const declared = await commands()
  return declared.some((entry) => entry.name === command) ? { command, text: match[2]?.trim() ?? "" } : undefined
}
