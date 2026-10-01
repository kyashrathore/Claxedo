import { mkdirSync } from "node:fs"
import path from "node:path"
import { sweepHarnessHomeRoot } from "./home-use"
import { userHomeDir } from "@claxedo/helpers/path"
import type { HarnessCompositionOptions } from "@claxedo/harness/compose"
import type { AttachInput, MachineLoginPolicy } from "@claxedo/harness/contract"
import type { AgentRuntimeStore } from "@claxedo/session-core"
import { missingSessionHandoff } from "@claxedo/session-core"
import { requireCursorWorker } from "./executables/cursor"
import { requireClaudeExecutable } from "./executables/claude"
import { requireCodexExecutable } from "./executables/codex"
import { piRuntime, requirePiExecutable } from "./executables/pi"

export type HarnessCompositionInput = {
  env: NodeJS.ProcessEnv
  placement: MachineLoginPolicy
  /** Where this runtime keeps every Claxedo-owned harness home; shared by every workspace of one user. */
  harnessStateRoot: string
  /** Where the OpenCode engine of this host keeps its database. */
  opencodeRoot: string
  store: () => AgentRuntimeStore
}

export function defaultHarnessStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(userHomeDir(env), ".claxedo", "harness")
}

export function harnessCompositionOptions(input: HarnessCompositionInput): HarnessCompositionOptions {
  const { env, placement, harnessStateRoot } = input
  const home = userHomeDir(env)
  return {
    acp: () => ({
      missingContext: async (attach: AttachInput) => missingSessionHandoff(input.store().getMessages(attach.sessionId), attach.config.harness),
    }),
    pi: (command) => ({
      binary: command ?? requirePiExecutable(env),
      runtime: piRuntime(),
      env,
      ...placement,
      stateRoot: path.join(harnessStateRoot, "pi"),
      ownerAgentDir: env.PI_CODING_AGENT_DIR ?? path.join(home, ".pi", "agent"),
    }),
    codex: () => ({
      binary: requireCodexExecutable(env),
      homeRoot: path.join(harnessStateRoot, "codex", "homes"),
      ownerHome: env.CODEX_HOME ?? path.join(home, ".codex"),
      env,
    }),
    claude: () => ({
      executable: requireClaudeExecutable(env),
      configRoot: path.join(harnessStateRoot, "claude", "config"),
      userConfigRoot: env.CLAUDE_CONFIG_DIR ?? path.join(home, ".claude"),
      env,
    }),
    cursor: () => ({
      env,
      homeRoot: path.join(harnessStateRoot, "cursor", "homes"),
      worker: requireCursorWorker(env),
      ...placement,
    }),
    opencode: () => {
      mkdirSync(input.opencodeRoot, { recursive: true })
      return { databasePath: path.join(input.opencodeRoot, "opencode.db"), persistEvents: true }
    },
  }
}

export async function sweepIdleHarnessHomes(harnessStateRoot: string, now = Date.now()): Promise<string[]> {
  const removed: string[] = []
  for (const kind of ["codex", "cursor"]) removed.push(...await sweepHarnessHomeRoot(path.join(harnessStateRoot, kind, "homes"), now))
  return removed
}
