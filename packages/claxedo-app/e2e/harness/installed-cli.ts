import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { ensurePinnedClaude, PINNED_CLAUDE } from "../../../harness/e2e/harness/pinned-claude"
import { ensurePinnedCodex, PINNED_CODEX } from "../../../harness/e2e/harness/pinned-codex"

const execFileAsync = promisify(execFile)

export type CliName = "claude" | "codex"

export type CliAvailability =
  | { available: true; path: string; version: string }
  | { available: false; reason: string }

export const PINNED_CLIS: Record<CliName, { path: string; ensure: () => Promise<{ installed: boolean; version: string }> }> = {
  claude: { path: PINNED_CLAUDE, ensure: ensurePinnedClaude },
  codex: { path: PINNED_CODEX, ensure: ensurePinnedCodex },
}

export async function installedCli(name: CliName): Promise<CliAvailability> {
  const pinned = PINNED_CLIS[name]
  try {
    await pinned.ensure()
    const version = (await execFileAsync(pinned.path, ["--version"], { timeout: 10_000 })).stdout.trim()
    return { available: true, path: pinned.path, version }
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error)
    return { available: false, reason: `the pinned ${name} could not be installed or does not run (${detail})` }
  }
}
