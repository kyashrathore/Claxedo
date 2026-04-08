/**
 * Generic helpers — file I/O, shell quoting, template loading.
 */

import * as fs from "fs"
import * as path from "path"
import { Log } from "../log"

const log = Log.create({ service: "agent-hooks" })

const TEMPLATES_DIR = path.join(import.meta.dirname!, "templates")

export function loadTemplate(name: string, vars: Record<string, string>): string {
  const template = fs.readFileSync(path.join(TEMPLATES_DIR, name), "utf-8")
  return Object.entries(vars).reduce(
    (content, [key, value]) => content.replaceAll(`{{${key}}}`, value),
    template,
  )
}

export const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"

export const asRecord = (value: unknown) => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

export const readJSON = async (filePath: string) => {
  try {
    const raw = await fs.promises.readFile(filePath, "utf-8")
    return JSON.parse(raw) as unknown
  } catch {
    return {}
  }
}

// ── Hook merging utilities ─────────────────────────────────────────────────

const MANAGED_HOOK_PATH_PATTERN = /\/\.claxedo(?:-[^/'"\s\\]+)?\//

/**
 * Check if a command string refers to a Claxedo-managed hook script.
 */
export function isManagedHookCommand(command: string | undefined, scriptName: string): boolean {
  if (!command) return false
  const normalized = command.replaceAll("\\", "/")
  if (!normalized.includes(`/hooks/${scriptName}`)) return false
  return MANAGED_HOOK_PATH_PATTERN.test(normalized)
}

interface ReconcileOptions<T> {
  current: T[] | undefined
  desired: T[]
  isManaged: (entry: T) => boolean
  isEquivalent: (entry: T, desiredEntry: T) => boolean
}

/**
 * Generic function for upserting managed entries into any agent config array.
 * Removes stale managed entries, preserves user entries, appends desired entries.
 */
export function reconcileManagedEntries<T>({
  current,
  desired,
  isManaged,
  isEquivalent,
}: ReconcileOptions<T>): { entries: T[]; replacedManagedEntries: T[] } {
  const existing = Array.isArray(current) ? current : []
  const entries: T[] = []
  const replacedManagedEntries: T[] = []

  for (const entry of existing) {
    if (!isManaged(entry)) {
      entries.push(entry)
      continue
    }
    if (!desired.some((d) => isEquivalent(entry, d))) {
      replacedManagedEntries.push(entry)
    }
  }

  entries.push(...desired)
  return { entries, replacedManagedEntries }
}

/**
 * Write file if content changed (atomic via temp file)
 */
export async function writeIfChanged(filePath: string, content: string, mode: number, force: boolean): Promise<boolean> {
  const tempPath = `${filePath}.tmp.${Date.now()}-${Math.random().toString(36).slice(2)}`
  try {
    if (!force && fs.existsSync(filePath)) {
      try {
        const existing = await fs.promises.readFile(filePath, "utf-8")
        if (existing === content) return false
      } catch {}
    }

    await fs.promises.writeFile(tempPath, content, { mode })

    try {
      await fs.promises.rename(tempPath, filePath)
    } catch (renameError) {
      await fs.promises.copyFile(tempPath, filePath)
      await fs.promises.unlink(tempPath)
      await fs.promises.chmod(filePath, mode)
    }

    return true
  } catch (error) {
    log.error("Failed to write file", { filePath, error })
    try {
      if (fs.existsSync(tempPath)) {
        await fs.promises.unlink(tempPath)
      }
    } catch {}
    throw error
  }
}
