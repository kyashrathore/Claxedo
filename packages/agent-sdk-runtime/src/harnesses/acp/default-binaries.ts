import { createRequire } from "node:module"
import fs from "node:fs"
import path from "node:path"

// The ACP adapter binaries ship as dependencies of THIS package (the code
// that spawns them), not of workspace-runtime — hosts composing a runtime get
// them transitively, and image builds collect the pins from here.
const ACP_BIN_PACKAGES: Record<string, string> = {
  "claude-agent-acp": "@agentclientprotocol/claude-agent-acp",
  "codex-acp": "@agentclientprotocol/codex-acp",
}

/**
 * Resolve the default ACP adapter binary shipped with this package's
 * dependencies. Falls back to the bare command name for PATH lookup (sandbox
 * images symlink the bins into /usr/local/bin).
 */
export function defaultAcpBinary(name: string): string {
  // The packaged Electron desktop runs this code from a bundle, where the
  // `require.resolve` below cannot find the npm package. It ships the adapters
  // under CLAXEDO_ACP_DIR and points here — the same override claxedo-server's
  // agent-config resolver honors, so both spawn paths agree on the binary.
  const acpDir = process.env.CLAXEDO_ACP_DIR
  if (acpDir) {
    const bundled = bundledAcpBinary(acpDir, name)
    if (bundled) return bundled
  }
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

export function bundledAcpBinary(acpDir: string, name: string, platform = process.platform) {
  const names = platform === "win32" ? [`${name}.exe`, name] : [name]
  return names.map((candidate) => path.join(acpDir, candidate)).find((candidate) => fs.existsSync(candidate))
}
