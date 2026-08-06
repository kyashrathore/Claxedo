import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * Load `packages/claxedo-server/.env` into `process.env` for development runs.
 *
 * The embedded server is forked with a copy of this process's environment and
 * reads its configuration from nothing else — there is no dotenv in the tree.
 * A key that lives only in the server's `.env` (the GitHub app credentials, the
 * sandbox provider tokens) is therefore absent at runtime unless the launching
 * shell exported it first, and the feature that needs it fails in a way that
 * reads as a bug rather than as missing configuration.
 *
 * DEVELOPMENT ONLY, and the caller enforces that. Those files hold real secrets
 * belonging to whoever checked the repository out; a packaged app has no source
 * tree beside it and must never go looking for one.
 *
 * Never overwrites a value already in the environment: an explicit
 * `FOO=bar bun dev` is an intentional override, and the launch scripts set the
 * throwaway profile's directories before this runs.
 */
export function loadServerEnvForDevelopment(input: {
  repoRoot: string
  env?: NodeJS.ProcessEnv
  log?: (message: string) => void
}) {
  const env = input.env ?? process.env
  let loaded = 0
  // Scoped to this call, not the module: two loads must not leak precedence
  // into each other.
  const ownKeys = new Set<string>()
  // `.env.local` second so it wins on conflict, matching the usual convention.
  for (const name of [".env", ".env.local"]) {
    const file = join(input.repoRoot, "packages", "claxedo-server", name)
    if (!existsSync(file)) continue
    let text: string
    try {
      text = readFileSync(file, "utf8")
    } catch {
      continue
    }
    for (const [key, value] of parseEnvFile(text)) {
      // A key this loader already set from `.env` is not a caller override, so
      // `.env.local` may still replace it.
      if (env[key] !== undefined && !ownKeys.has(key)) continue
      env[key] = value
      ownKeys.add(key)
      loaded += 1
    }
  }
  if (loaded > 0) input.log?.(`loaded ${loaded} value(s) from packages/claxedo-server/.env*`)
  return loaded
}

export function resolveDesktopServerDataDir(input: {
  channel: "dev" | "beta" | "prod"
  home: string
  configured?: string
}) {
  if (input.configured?.trim()) return input.configured
  return join(input.home, input.channel === "prod" ? ".claxedo" : `.claxedo-${input.channel}`)
}

export function parseEnvFile(text: string): Array<[string, string]> {
  return text.split("\n").flatMap((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) return []
    const at = trimmed.indexOf("=")
    if (at < 0) return []
    const key = trimmed.slice(0, at).trim().replace(/^export\s+/, "")
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return []
    return [[key, unquote(trimmed.slice(at + 1).trim())]] as Array<[string, string]>
  })
}

/** One layer of surrounding quotes, only when the pair matches. */
function unquote(value: string) {
  const quoted = (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  return quoted && value.length >= 2 ? value.slice(1, -1) : value
}
