/**
 * The CLI agents Claxedo offers to start in a terminal.
 *
 * Three surfaces read this list and would drift apart without it: the settings
 * pane that edits each command, the creator that offers the tile, and
 * `terminalLaunchCommand`, which splits a launch into command + args only for
 * an agent named here — anything else is handed to the shell verbatim.
 *
 * The runtime installs status hooks for more binaries than this (see
 * `agent-hooks/core/constants.ts`); these are the ones the app itself claims to
 * support, so they are the ones it offers to start.
 */

export type TerminalAgentId = "claude" | "codex" | "cursor" | "gemini"

/** Icon key on `ClaxedoIcon`; the catalog has no mark for every vendor. */
export type TerminalAgentIcon = "claude" | "openai" | "cursor" | "terminal"

export type TerminalAgent = {
  id: TerminalAgentId
  label: string
  /**
   * Every binary that counts as this agent being installed. Cursor ships its
   * CLI as `cursor-agent` and also answers to `cursor`, and either one means
   * the tile can start.
   */
  binaries: readonly [string, ...string[]]
  defaultCommand: string
  icon: TerminalAgentIcon
  /** What the settings row says the command is for. */
  hint: string
}

export const TERMINAL_AGENTS: readonly TerminalAgent[] = [
  {
    id: "claude",
    label: "Claude",
    binaries: ["claude"],
    defaultCommand: "claude --dangerously-skip-permissions",
    icon: "claude",
    hint: "Claude Code",
  },
  {
    id: "codex",
    label: "Codex",
    binaries: ["codex"],
    defaultCommand: 'codex -c model_reasoning_effort="high" --ask-for-approval never --sandbox danger-full-access',
    icon: "openai",
    hint: "OpenAI Codex CLI",
  },
  {
    id: "cursor",
    label: "Cursor",
    binaries: ["cursor-agent", "cursor"],
    defaultCommand: "cursor-agent",
    icon: "cursor",
    hint: "Cursor Agent CLI",
  },
  {
    id: "gemini",
    label: "Gemini",
    binaries: ["gemini"],
    defaultCommand: "gemini",
    icon: "terminal",
    hint: "Google Gemini CLI",
  },
]

export function terminalAgent(id: string): TerminalAgent | undefined {
  return TERMINAL_AGENTS.find((agent) => agent.id === id)
}

/** True when `installed` names any binary this agent answers to. */
export function terminalAgentInstalled(agent: TerminalAgent, installed: readonly string[]) {
  return agent.binaries.some((binary) => installed.includes(binary))
}

export function isTerminalAgentBinary(name: string) {
  return TERMINAL_AGENTS.some((agent) => (agent.binaries as readonly string[]).includes(name))
}
