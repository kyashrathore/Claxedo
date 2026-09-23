import { parse as parseShellCommand } from "shell-quote"
import { isTerminalAgentBinary } from "./terminal-agents"

export function terminalLaunchCommand(input?: string) {
  if (!input?.trim()) return undefined
  const parsed = parseShellCommand(input)
  if (!parsed.every((item): item is string => typeof item === "string")) return undefined

  const command = parsed[0]
  if (!command) return undefined

  const name = command.split(/[\\/]/).pop()
  if (!name || !isTerminalAgentBinary(name)) return undefined

  return {
    command,
    args: parsed.slice(1),
  }
}
