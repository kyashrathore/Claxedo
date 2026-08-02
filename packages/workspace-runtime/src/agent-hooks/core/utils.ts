/**
 * Generic helpers — file I/O, shell quoting, template rendering.
 */

import * as fs from "fs"
import { Log } from "../../log"
import { templates, type TemplateName } from "./templates"

const log = Log.create({ service: "agent-hooks" })

export function loadTemplate(name: TemplateName, vars: Record<string, string>): string {
  return Object.entries(vars).reduce(
    (content, [key, value]) => content.replaceAll(`{{${key}}}`, value),
    templates[name],
  )
}

export const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'"

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
