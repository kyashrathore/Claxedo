import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { CLAUDE_CODE_VERSION } from "./config"

const execFileAsync = promisify(execFile)
const PREFIX = path.resolve(import.meta.dirname, "../.artifacts/claude")
const MANIFEST = path.join(PREFIX, "node_modules/@anthropic-ai/claude-code/package.json")
export const PINNED_CLAUDE = path.join(PREFIX, "node_modules/.bin", process.platform === "win32" ? "claude.cmd" : "claude")

function installedVersion(): string | undefined {
  if (!existsSync(MANIFEST) || !existsSync(PINNED_CLAUDE)) return undefined
  return (JSON.parse(readFileSync(MANIFEST, "utf8")) as { version?: string }).version
}

export async function ensurePinnedClaude(): Promise<{ installed: boolean; version: string }> {
  if (installedVersion() === CLAUDE_CODE_VERSION) return { installed: false, version: CLAUDE_CODE_VERSION }
  await fs.mkdir(PREFIX, { recursive: true })
  await execFileAsync("npm", ["install", "--prefix", PREFIX, "--no-save", "--no-package-lock", "--no-audit", "--no-fund", `@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`], {
    env: { ...process.env, NPM_CONFIG_CACHE: path.join(PREFIX, "npm-cache") },
    maxBuffer: 16 * 1024 * 1024,
  })
  if (installedVersion() !== CLAUDE_CODE_VERSION) throw new Error(`npm install did not install Claude Code ${CLAUDE_CODE_VERSION}`)
  return { installed: true, version: CLAUDE_CODE_VERSION }
}
