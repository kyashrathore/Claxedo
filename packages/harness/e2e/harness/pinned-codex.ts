import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { CODEX_VERSION } from "./config"

const execFileAsync = promisify(execFile)
export { CODEX_VERSION }
const PREFIX = path.resolve(import.meta.dirname, "../.artifacts/codex")
const MANIFEST = path.join(PREFIX, "node_modules/@openai/codex/package.json")
export const PINNED_CODEX = path.join(PREFIX, "node_modules/.bin/codex")

function installedVersion(): string | undefined {
  if (!existsSync(MANIFEST) || !existsSync(PINNED_CODEX)) return undefined
  return (JSON.parse(readFileSync(MANIFEST, "utf8")) as { version?: string }).version
}

export async function ensurePinnedCodex(): Promise<{ installed: boolean; version: string }> {
  if (installedVersion() === CODEX_VERSION) return { installed: false, version: CODEX_VERSION }
  await fs.mkdir(PREFIX, { recursive: true })
  await execFileAsync("npm", ["install", "--prefix", PREFIX, "--no-save", "--no-package-lock", "--no-audit", "--no-fund", `@openai/codex@${CODEX_VERSION}`], {
    env: { ...process.env, NPM_CONFIG_CACHE: path.join(PREFIX, "npm-cache") },
    maxBuffer: 16 * 1024 * 1024,
  })
  if (installedVersion() !== CODEX_VERSION) throw new Error(`npm install did not install Codex ${CODEX_VERSION}`)
  return { installed: true, version: CODEX_VERSION }
}
