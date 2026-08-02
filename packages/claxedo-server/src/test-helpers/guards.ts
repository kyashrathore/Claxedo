import fs from "node:fs"
import path from "node:path"

/**
 * Shared primitives for the static guard tests (architecture.test.ts,
 * control-plane/central-store-boundary.test.ts). The Worker import-graph guard
 * keeps its own specialized transitive walker.
 */

/** Recursively list every file under `dir`. */
export function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return walk(full)
    return full
  })
}

/**
 * Match a runtime `from "…<module>"` / `import * as x from "…<module>"`
 * reference to a module specifier (regex-escaped).
 */
export function importPattern(module: string) {
  const escaped = module.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(?:from\\s+["'][^"']*${escaped}|import\\s+\\*\\s+as\\s+\\w+\\s+from\\s+["'][^"']*${escaped})`)
}
