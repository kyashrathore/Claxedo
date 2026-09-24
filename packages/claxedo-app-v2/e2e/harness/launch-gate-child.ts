import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const PACKAGES_DIR = path.resolve(import.meta.dirname, "../../..")
const HELPERS_DIR = path.join(PACKAGES_DIR, "claxedo-helpers")
const RUNTIME_DIR = path.join(PACKAGES_DIR, "agent-sdk-runtime")
const LAUNCH_GATE_CHILD = path.join(RUNTIME_DIR, "dist/launch/launch-gate-child.mjs")

function buildPackage(dir: string) {
  return execFileAsync("bun", ["scripts/build.ts"], { cwd: dir, maxBuffer: 16 * 1024 * 1024 })
}

export async function ensureLaunchGateChild(): Promise<{ built: boolean; ms: number }> {
  if (existsSync(LAUNCH_GATE_CHILD)) return { built: false, ms: 0 }
  const started = Date.now()
  if (!existsSync(path.join(HELPERS_DIR, "dist"))) await buildPackage(HELPERS_DIR)
  await buildPackage(RUNTIME_DIR)
  if (!existsSync(LAUNCH_GATE_CHILD)) throw new Error(`bun scripts/build.ts in ${RUNTIME_DIR} did not produce ${LAUNCH_GATE_CHILD}`)
  return { built: true, ms: Date.now() - started }
}
