import { mkdirSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { userHomeDir } from "@claxedo/helpers/path"
import type { HarnessCompositionOptions } from "@claxedo/harness/compose"
import type { AttachInput, MachineLoginPolicy } from "@claxedo/harness/contract"
import type { AgentRuntimeStore } from "./contracts"
import { missingSessionHandoff } from "./handoff"
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

/** Codex and Cursor homes are keyed by owner, credential and plugin set; one unused for this long is removed at the next composition. */
export const HARNESS_HOME_MAX_IDLE_MS = 30 * 24 * 60 * 60 * 1000

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
    pi: () => ({
      binary: requirePiExecutable(env),
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
      ...placement,
    }),
    opencode: () => {
      mkdirSync(input.opencodeRoot, { recursive: true })
      return { login: placement, databasePath: path.join(input.opencodeRoot, "opencode.db"), persistEvents: true }
    },
  }
}

/**
 * Removes Codex and Cursor homes nobody launched for `HARNESS_HOME_MAX_IDLE_MS`.
 * A home is rebuilt from its owner's real home and the projection on every
 * start, so removing an idle one loses nothing that a launch does not restore.
 */
export async function sweepIdleHarnessHomes(harnessStateRoot: string, now = Date.now()): Promise<string[]> {
  const removed: string[] = []
  for (const root of [path.join(harnessStateRoot, "codex", "homes"), path.join(harnessStateRoot, "cursor", "homes")]) {
    const entries = await fs.readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return []
      throw error
    })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const home = path.join(root, entry.name)
      const stat = await fs.stat(home)
      if (now - stat.mtimeMs < HARNESS_HOME_MAX_IDLE_MS) continue
      await fs.rm(home, { recursive: true, force: true })
      removed.push(home)
    }
  }
  return removed
}
