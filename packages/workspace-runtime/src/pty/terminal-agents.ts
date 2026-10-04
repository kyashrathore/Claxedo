import os from "node:os"
import { resolveClaudeExecutable } from "../host/executables/claude"
import { resolveCodexExecutable } from "../host/executables/codex"
import { resolveOnPath } from "../host/executables/path-lookup"

export type TerminalAgentId = "claude" | "codex" | "cursor"

const INSTALLED: Record<TerminalAgentId, (env: NodeJS.ProcessEnv, home: string) => boolean> = {
  claude: (env, home) => resolveClaudeExecutable(env, process.platform, home) !== undefined,
  codex: (env) => resolveCodexExecutable(env) !== undefined,
  cursor: (env) => resolveOnPath("cursor-agent", process.platform, env) !== undefined,
}

/** The agent CLIs a terminal on this runtime can start, read off what is installed here. */
export function installedTerminalAgents(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): TerminalAgentId[] {
  return (Object.keys(INSTALLED) as TerminalAgentId[]).filter((id) => INSTALLED[id](env, home))
}
