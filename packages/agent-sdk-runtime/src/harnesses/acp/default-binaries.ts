import { createRequire } from "node:module"
import path from "node:path"

// The ACP adapter binaries ship as dependencies of THIS package (the code
// that spawns them), not of workspace-runtime — hosts composing a runtime get
// them transitively, and image builds collect the pins from here.
const ACP_BIN_PACKAGES: Record<string, string> = {
  "claude-agent-acp": "@zed-industries/claude-agent-acp",
  "codex-acp": "@zed-industries/codex-acp",
}

/**
 * Resolve the default ACP adapter binary shipped with this package's
 * dependencies. Falls back to the bare command name for PATH lookup (sandbox
 * images symlink the bins into /usr/local/bin).
 */
export function defaultAcpBinary(name: string): string {
  const pkgName = ACP_BIN_PACKAGES[name]
  if (!pkgName) return name
  try {
    const require = createRequire(import.meta.url)
    const pkgJsonPath = require.resolve(`${pkgName}/package.json`)
    const pkg = require(pkgJsonPath) as { bin?: string | Record<string, string> }
    const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.[name]
    if (rel) return path.join(path.dirname(pkgJsonPath), rel)
  } catch {
    // Resolution can fail in bundled or unusual layouts; PATH covers it.
  }
  return name
}
