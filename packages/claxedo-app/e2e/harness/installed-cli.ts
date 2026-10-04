import { execFile } from "node:child_process"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

export type CliName = "claude" | "codex"

export type CliAvailability =
  | { available: true; path: string; version: string }
  | { available: false; reason: string }

const CLI_OVERRIDE_ENV: Record<CliName, string> = {
  claude: "CLAXEDO_E2E_CLAUDE_BIN",
  codex: "CLAXEDO_E2E_CODEX_BIN",
}

export async function installedCli(name: CliName): Promise<CliAvailability> {
  const binary = process.env[CLI_OVERRIDE_ENV[name]]?.trim() || name
  try {
    const resolved = binary.includes("/") ? binary : (await execFileAsync("which", [binary])).stdout.trim()
    if (!resolved) return { available: false, reason: `${name} is not on PATH` }
    const version = (await execFileAsync(resolved, ["--version"], { timeout: 10_000 })).stdout.trim()
    return { available: true, path: resolved, version }
  } catch (error) {
    const detail = error instanceof Error ? error.message.split("\n")[0] : String(error)
    return { available: false, reason: `${name} is not installed or does not run (${detail})` }
  }
}
