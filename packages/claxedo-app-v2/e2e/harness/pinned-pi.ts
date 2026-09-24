import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { PI_VERSION } from "../../../agent-sdk-runtime/src/harnesses/pi/executable"
import { run } from "./app"

const RUNTIME_DIR = path.resolve(import.meta.dirname, "../../../agent-sdk-runtime")
const PREFIX = path.join(RUNTIME_DIR, ".artifacts/pi")
const MANIFEST = path.join(PREFIX, "node_modules/@earendil-works/pi-coding-agent/package.json")

export const PINNED_PI = path.join(PREFIX, "node_modules/.bin/pi")

function installedVersion() {
  if (!existsSync(MANIFEST) || !existsSync(PINNED_PI)) return undefined
  return (JSON.parse(readFileSync(MANIFEST, "utf8")) as { version?: string }).version
}

export async function ensurePinnedPi(): Promise<{ installed: boolean; version: string }> {
  if (installedVersion() === PI_VERSION) return { installed: false, version: PI_VERSION }
  const result = await run("pi install", "bun", ["run", "pi:install"], { cwd: RUNTIME_DIR })
  if (result.code !== 0 || installedVersion() !== PI_VERSION) {
    throw new Error(`bun run pi:install did not install Pi ${PI_VERSION}:\n${result.tail()}`)
  }
  return { installed: true, version: PI_VERSION }
}
