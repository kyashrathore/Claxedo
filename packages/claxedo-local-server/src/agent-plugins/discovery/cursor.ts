import fs from "node:fs/promises"
import path from "node:path"
import type { MachineInstalledEntry } from "./types"

/** The ownership marker `cursorAgentPluginAdapter` writes into every directory it manages (see `../runtime/adapters/cursor.ts`). */
const OWNERSHIP_MARKER = ".claxedo-agent-plugin.json"

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

async function isOwnedByClaxedo(entryRoot: string): Promise<boolean> {
  try {
    await fs.access(path.join(entryRoot, OWNERSHIP_MARKER))
    return true
  } catch {
    return false
  }
}

async function manifestNameAndVersion(entryRoot: string): Promise<{ name?: string; version?: string }> {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(entryRoot, "plugin.json"), "utf8")) as unknown
    if (!record(parsed)) return {}
    return {
      ...(typeof parsed.name === "string" && parsed.name ? { name: parsed.name } : {}),
      ...(typeof parsed.version === "string" && parsed.version ? { version: parsed.version } : {}),
    }
  } catch {
    return {}
  }
}

/**
 * Lists Cursor's local plugin directory (`~/.cursor/plugins/local/*`, one plugin per immediate child — the
 * same contract `cursorAgentPluginAdapter` targets). Entries Claxedo manages carry its ownership marker and
 * are still included, flagged `ownedByClaxedo: true`, so the caller can filter them out of "Personal".
 */
export async function readCursorInstalled(input: { home: string }): Promise<MachineInstalledEntry[]> {
  const localRoot = path.join(input.home, ".cursor", "plugins", "local")
  let names: string[]
  try {
    names = await fs.readdir(localRoot)
  } catch {
    return []
  }

  const entries: MachineInstalledEntry[] = []
  for (const name of names) {
    const entryRoot = path.join(localRoot, name)
    try {
      if (!(await fs.lstat(entryRoot)).isDirectory()) continue
    } catch {
      continue
    }
    const [ownedByClaxedo, meta] = await Promise.all([isOwnedByClaxedo(entryRoot), manifestNameAndVersion(entryRoot)])
    entries.push({
      name: meta.name ?? name,
      ...(meta.version ? { version: meta.version } : {}),
      root: entryRoot,
      ownedByClaxedo,
    })
  }
  return entries
}
