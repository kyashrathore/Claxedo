import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const PACKAGES_DIR = path.resolve(import.meta.dirname, "../../..")

type WorkspaceDist = { dir: string; artifact: string; build: readonly string[] }

export const HELPERS_DIST: WorkspaceDist = { dir: "claxedo-helpers", artifact: "dist", build: ["scripts/build.ts"] }
export const CONTRACT_DIST: WorkspaceDist = { dir: "agent-runtime-contract", artifact: "dist/index.mjs", build: ["run", "build"] }
export async function ensureWorkspaceDist(dist: WorkspaceDist): Promise<boolean> {
  const dir = path.join(PACKAGES_DIR, dist.dir)
  const artifact = path.join(dir, dist.artifact)
  if (existsSync(artifact)) return false
  await execFileAsync("bun", [...dist.build], { cwd: dir, maxBuffer: 16 * 1024 * 1024 })
  if (!existsSync(artifact)) throw new Error(`bun ${dist.build.join(" ")} in ${dir} did not produce ${artifact}`)
  return true
}
