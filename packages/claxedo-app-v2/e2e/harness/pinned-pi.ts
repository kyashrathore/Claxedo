import { existsSync, readFileSync } from "node:fs"
import path from "node:path"
import { run } from "./app"
import { CONTRACT_DIST, ensureWorkspaceDist } from "./workspace-dists"

const RUNTIME_DIR = path.resolve(import.meta.dirname, "../../../agent-sdk-runtime")
const PREFIX = path.join(RUNTIME_DIR, ".artifacts/pi")
const MANIFEST = path.join(PREFIX, "node_modules/@earendil-works/pi-coding-agent/package.json")

export const PINNED_PI = path.join(PREFIX, "node_modules/.bin/pi")

function installedVersion() {
  if (!existsSync(MANIFEST) || !existsSync(PINNED_PI)) return undefined
  return (JSON.parse(readFileSync(MANIFEST, "utf8")) as { version?: string }).version
}

async function pinnedVersion() {
  await ensureWorkspaceDist(CONTRACT_DIST)
  const { PI_VERSION } = await import("../../../agent-sdk-runtime/src/harnesses/pi/executable")
  return PI_VERSION
}

export async function ensurePinnedPi(): Promise<{ installed: boolean; version: string }> {
  const version = await pinnedVersion()
  if (installedVersion() === version) return { installed: false, version }
  const result = await run("pi install", "bun", ["run", "pi:install"], { cwd: RUNTIME_DIR })
  if (result.code !== 0 || installedVersion() !== version) {
    throw new Error(`bun run pi:install did not install Pi ${version}:\n${result.tail()}`)
  }
  return { installed: true, version }
}
