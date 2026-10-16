import { existsSync, mkdirSync } from "node:fs"
import path from "node:path"
import { sweepHarnessHomeRoot } from "./home-use"
import { userHomeDir } from "@claxedo/helpers/path"
import type { HarnessCompositionOptions } from "@claxedo/harness/compose"
import type { MachineLoginPolicy } from "@claxedo/harness/contract"
import { requireCursorWorker } from "./executables/cursor"
import { requireClaudeExecutable } from "./executables/claude"
import { requireCodexExecutable } from "./executables/codex"

export type HarnessCompositionInput = {
  env: NodeJS.ProcessEnv
  placement: MachineLoginPolicy
  /** Where this runtime keeps every Claxedo-owned harness home; shared by every workspace of one user. */
  harnessStateRoot: string
  /** Where the OpenCode engine of this host keeps its database. */
  opencodeRoot: string
}

export function defaultHarnessStateRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(userHomeDir(env), ".claxedo", "harness")
}

export function harnessCompositionOptions(input: HarnessCompositionInput): HarnessCompositionOptions {
  const { env, placement, harnessStateRoot } = input
  const home = userHomeDir(env)
  return {
    pi: () => ({ stateRoot: path.join(harnessStateRoot, "pi"), env }),
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
      // Claude Code exits at launch when root is allowed to skip permissions, unless IS_SANDBOX=1;
      // every cloud sandbox image runs the runtime as root.
      env: placement.placement === "cloud" ? { ...env, IS_SANDBOX: "1" } : env,
    }),
    cursor: () => ({
      env,
      homeRoot: path.join(harnessStateRoot, "cursor", "homes"),
      ownerCursorDir: path.join(home, ".cursor"),
      worker: requireCursorWorker(env),
      ...placement,
    }),
    opencode: () => {
      mkdirSync(input.opencodeRoot, { recursive: true })
      return { databasePath: openCodeDatabasePath(input.opencodeRoot), persistEvents: true }
    },
  }
}

function openCodeDatabasePath(opencodeRoot: string) {
  return path.join(opencodeRoot, "opencode.db")
}

/**
 * The embedded engines this host prepares before it listens. OpenCode's boot
 * holds the event loop for seconds on a small sandbox, so it is prepared only
 * where its database shows the workspace has run it; the opencode-sdk README
 * has the measurements.
 */
export function harnessesToPrepare(input: Pick<HarnessCompositionInput, "opencodeRoot">): readonly "opencode"[] {
  return existsSync(openCodeDatabasePath(input.opencodeRoot)) ? ["opencode"] : []
}

export async function sweepIdleHarnessHomes(harnessStateRoot: string, now = Date.now()): Promise<string[]> {
  const removed: string[] = []
  for (const kind of ["codex", "cursor"]) removed.push(...await sweepHarnessHomeRoot(path.join(harnessStateRoot, kind, "homes"), now))
  return removed
}
