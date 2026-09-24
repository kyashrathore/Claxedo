import { execFile } from "node:child_process"
import { existsSync, readFileSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import { promisify } from "node:util"
import { PI_VERSION } from "./config"

const execFileAsync = promisify(execFile)
const PREFIX = path.resolve(import.meta.dirname, "../.artifacts/pi")
const MANIFEST = path.join(PREFIX, "node_modules/@earendil-works/pi-coding-agent/package.json")

export const PINNED_PI = path.join(PREFIX, "node_modules/.bin/pi")

function installedVersion() {
  if (!existsSync(MANIFEST) || !existsSync(PINNED_PI)) return undefined
  return (JSON.parse(readFileSync(MANIFEST, "utf8")) as { version?: string }).version
}

export async function ensurePinnedPi(): Promise<{ installed: boolean; version: string }> {
  if (installedVersion() === PI_VERSION) return { installed: false, version: PI_VERSION }
  await fs.mkdir(PREFIX, { recursive: true })
  await execFileAsync("npm", ["install", "--prefix", PREFIX, "--no-save", "--no-package-lock", "--no-audit", "--no-fund", `@earendil-works/pi-coding-agent@${PI_VERSION}`], {
    env: { ...process.env, NPM_CONFIG_CACHE: path.join(PREFIX, "npm-cache") },
    maxBuffer: 16 * 1024 * 1024,
  })
  if (installedVersion() !== PI_VERSION) throw new Error(`npm install did not install Pi ${PI_VERSION}`)
  return { installed: true, version: PI_VERSION }
}
