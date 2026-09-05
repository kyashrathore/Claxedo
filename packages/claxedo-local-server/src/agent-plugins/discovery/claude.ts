import fs from "node:fs/promises"
import path from "node:path"
import type { MachineInstalledEntry } from "./types"

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as unknown
  } catch {
    return undefined
  }
}

/**
 * Reads Claude Code's machine-wide plugin installation record
 * (`installed_plugins.json`, keyed `"<name>@<marketplaceId>"`). Claxedo's own Claude adapter never writes
 * here — it projects into a generation directory Claude reads over `--plugin-dir`, not `~/.claude/plugins`
 * — so every entry this finds is one the user installed themselves.
 *
 * `known_marketplaces.json` carries no information this route needs (the plugin key already names the
 * marketplace), but is read alongside it so a malformed copy is tolerated the same way, never thrown.
 */
export async function readClaudeInstalled(input: { home: string }): Promise<MachineInstalledEntry[]> {
  const pluginsDir = path.join(input.home, ".claude", "plugins")
  const installed = await readJson(path.join(pluginsDir, "installed_plugins.json"))
  if (!record(installed) || !record(installed.plugins)) return []

  const entries: MachineInstalledEntry[] = []
  for (const [key, value] of Object.entries(installed.plugins)) {
    if (!Array.isArray(value) || value.length === 0) continue
    const first: unknown = value[0]
    if (!record(first) || typeof first.installPath !== "string" || !first.installPath) continue
    const at = key.lastIndexOf("@")
    const name = at === -1 ? key : key.slice(0, at)
    const marketplace = at === -1 ? undefined : key.slice(at + 1)
    if (!name) continue
    entries.push({
      name,
      ...(typeof first.version === "string" && first.version ? { version: first.version } : {}),
      root: first.installPath,
      ...(marketplace ? { marketplace } : {}),
      ownedByClaxedo: false,
    })
  }
  return entries
}
