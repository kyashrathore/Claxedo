import path from "node:path"
import type { AgentCliEnv } from "./isolated-env"
import { PINNED_CLAUDE } from "./pinned-claude"
import { PINNED_CODEX } from "./pinned-codex"

const FAULT_SWITCHES = ["H11_DROP_ACP_IMAGE", "H1_DROP_ACP_TOOL_OUTPUT", "H13_DROP_ACP_USAGE", "CLAXEDO_E2E_ACP_WITHHOLD_ONCE_OPTION"] as const

export function pinnedAgentEnv(): AgentCliEnv {
  return {
    // The runtime resolves Codex on PATH, so the pinned CLI's directory leads it.
    path: [path.dirname(PINNED_CODEX)],
    env: {
      CLAUDE_CODE_EXECUTABLE: PINNED_CLAUDE,
      ...Object.fromEntries(FAULT_SWITCHES.flatMap((name) => (process.env[name] === "1" ? [[name, "1"]] : []))),
      ...(process.env.CLAXEDO_E2E_ACP_FAULT ? { CLAXEDO_E2E_ACP_FAULT: process.env.CLAXEDO_E2E_ACP_FAULT } : {}),
    },
  }
}
