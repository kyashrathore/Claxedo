import type { TurnInput } from "../../contract"
import type { OpenCodeRuntime } from "./runtime"
import type { WorkspaceScope } from "./scope"

export type CommandInvocation = { command: string; text: string }

const COMMAND_TEXT = /^\/(\S+)(?:\s+([\s\S]*))?$/

export async function declaredCommand(runtime: OpenCodeRuntime, scope: WorkspaceScope, turn: TurnInput): Promise<CommandInvocation | undefined> {
  if (turn.system !== undefined || turn.prompt.parts.some((part) => part.type !== "text")) return undefined
  const match = COMMAND_TEXT.exec(turn.prompt.parts.map((part) => part.type === "text" ? part.text : "").join("\n").trim())
  const command = match?.[1]
  if (!command) return undefined
  const declared = await runtime.catalog.commands(scope)
  return declared.some((entry) => entry.name === command) ? { command, text: match[2]?.trim() ?? "" } : undefined
}
