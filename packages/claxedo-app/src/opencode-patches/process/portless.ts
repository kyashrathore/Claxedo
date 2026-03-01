/**
 * Portless integration: command construction, config diffing, and binary resolution.
 */

import * as fs from "fs"
import * as path from "path"
import type { Process } from "./process"

/**
 * Sanitize a value for safe interpolation into a shell command.
 * Strips any characters that could escape out of the intended position
 * (quotes, backticks, semicolons, pipes, etc.). Only allows
 * alphanumeric, hyphens, underscores, dots, and forward slashes.
 */
export function sanitizeShellArg(value: string): string {
  return value.replace(/[^a-zA-Z0-9._\-\/]/g, "")
}

/**
 * Build the portless-wrapped command string.
 *
 * Three modes:
 * - env + "PORT"  → `portless hostname command` (native, portless sets PORT)
 * - env + custom  → `portless hostname sh -c 'export CUSTOM=$PORT; exec command'`
 * - flag          → `portless hostname sh -c 'exec command --port $PORT'`
 *
 * hostname and portValue are sanitized to prevent shell injection.
 */
export function buildPortlessCommand(
  fullCommand: string,
  portlessBin: string,
  hostname: string,
  portMode: string,
  portValue: string,
): string {
  const safeHostname = sanitizeShellArg(hostname)
  const safePortValue = sanitizeShellArg(portValue)
  const escaped = fullCommand.replace(/'/g, "'\\''")
  const quotedBin = `'${portlessBin.replace(/'/g, "'\\''")}'`
  if (portMode === "env" && safePortValue === "PORT") {
    return `${quotedBin} ${safeHostname} ${fullCommand}`
  } else if (portMode === "env") {
    return `${quotedBin} ${safeHostname} sh -c 'export ${safePortValue}=$PORT; exec ${escaped}'`
  } else {
    return `${quotedBin} ${safeHostname} sh -c 'exec ${escaped} ${safePortValue} $PORT'`
  }
}

/**
 * Check if two process configs differ in execution-relevant fields.
 * Changes to name, color, autoStart are NOT considered execution-relevant.
 */
export function configChanged(a: Process.ProcessConfig, b: Process.ProcessConfig): boolean {
  if (a.command !== b.command) return true
  if (JSON.stringify(a.args) !== JSON.stringify(b.args)) return true
  if (a.cwd !== b.cwd) return true
  if (JSON.stringify(a.env) !== JSON.stringify(b.env)) return true
  if (a.restartPolicy !== b.restartPolicy) return true
  if (a.maxRestarts !== b.maxRestarts) return true
  const ap = a.portless
  const bp = b.portless
  if (!ap && !bp) return false
  if (!ap || !bp) return true
  if (ap.hostname !== bp.hostname) return true
  if (ap.portMode !== bp.portMode) return true
  if (ap.portValue !== bp.portValue) return true
  return false
}

/**
 * Resolve the portless binary path.
 *
 * Checks three locations in order:
 * 1. Bun.which("portless") — works in dev mode (opencode-dev.ts prepends node_modules/.bin to PATH)
 * 2. Sibling of process.execPath — works in Tauri sidecar mode (portless compiled alongside opencode-cli)
 * 3. Walk up from Instance.directory checking node_modules/.bin/portless — monorepo fallback
 */
export async function resolvePortlessBin(): Promise<string | undefined> {
  // 1. PATH lookup (works in dev mode where opencode-dev.ts prepends node_modules/.bin)
  const fromPath = Bun.which("portless")
  if (fromPath) return fromPath

  // 2. Sibling of the running binary (Tauri sidecar mode)
  const execDir = path.dirname(process.execPath)
  try {
    const entries = fs.readdirSync(execDir)
    for (const entry of entries) {
      if (entry === "portless" || entry.startsWith("portless-")) {
        const candidate = path.join(execDir, entry)
        try {
          fs.accessSync(candidate, fs.constants.X_OK)
          return candidate
        } catch {}
      }
    }
  } catch {}

  // 3. Walk up from Instance.directory looking for node_modules/.bin/portless
  let dir: string
  try {
    const { Instance } = await import("@/project/instance")
    dir = Instance.directory
  } catch {
    return undefined
  }
  const root = path.parse(dir).root
  while (dir !== root) {
    const candidate = path.join(dir, "node_modules", ".bin", "portless")
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {}
    dir = path.dirname(dir)
  }

  return undefined
}
