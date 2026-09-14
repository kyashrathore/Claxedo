import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { allImportSpecifiers, importSpecifiers, resolveImport } from "./import-graph"
import { prodSourcePaths } from "./scanners"

/**
 * Every chunk the Tasks UI is mounted from has to reach `tasks.css`.
 *
 * The surfaces are lazily imported, so each one is the root of a chunk of its
 * own and Vite emits the stylesheet only for the chunks whose graph names it.
 * The Presets section under Settings shipped for a while with no path to the
 * file: it rendered unstyled unless the reader had opened the Tasks tab first
 * in the same session, which loaded the stylesheet for the other chunk. Nothing
 * else can see that — the classes exist, the rules exist, and only the pairing
 * is missing.
 */
const appRoot = path.resolve(import.meta.dir, "../..")
const srcRoot = path.join(appRoot, "src")
const stylesheet = "features/tasks/ui/tasks.css"

/** The modules the app lazily mounts a Tasks surface from. */
function tasksChunkEntries() {
  const entries = new Set<string>()
  for (const file of prodSourcePaths(appRoot)) {
    for (const specifier of allImportSpecifiers(readFileSync(file, "utf8"))) {
      if (!specifier.startsWith("@/features/tasks/ui/")) continue
      const resolved = resolveImport(appRoot, file, specifier)
      if (resolved) entries.add(path.relative(srcRoot, resolved))
    }
  }
  return [...entries].sort()
}

function reachesStylesheet(entry: string) {
  const seen = new Set<string>()
  const queue = [path.join(srcRoot, entry)]
  while (queue.length) {
    const file = queue.shift()
    if (!file || !existsSync(file)) continue
    const rel = path.relative(srcRoot, file)
    if (seen.has(rel)) continue
    seen.add(rel)
    if (rel === stylesheet) return true
    for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
      const resolved = resolveImport(appRoot, file, specifier)
      if (resolved) queue.push(resolved)
    }
  }
  return false
}

describe("tasks stylesheet reach", () => {
  test("finds the lazily mounted Tasks surfaces", () => {
    expect(tasksChunkEntries().length).toBeGreaterThanOrEqual(2)
  })

  test("every Tasks chunk entry reaches the stylesheet", () => {
    const offenders = tasksChunkEntries()
      .filter((entry) => !reachesStylesheet(entry))
      .map((entry) => `${entry}: no path to ${stylesheet} -- this surface renders unstyled in its own chunk`)

    expect(offenders).toEqual([])
  })
})
