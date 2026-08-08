import fs from "fs/promises"
import path from "path"
import { randomUUID } from "crypto"
import { dataDir } from "@claxedo/server-core/platform/runtime/lib/paths"
import type { Workspace } from "@claxedo/server-core/workspace/store/index"

const GLOBAL_ID = "global"

export function globalRoot() {
  return path.join(dataDir(), "global-sessions")
}

export function isGlobalDirectory(directory: string | undefined) {
  if (!directory) return false
  const root = path.resolve(globalRoot())
  const target = path.resolve(directory)
  return target === root || target.startsWith(root + path.sep)
}

export async function createGlobalDirectory() {
  const dir = path.join(globalRoot(), randomUUID())
  await fs.mkdir(dir, { recursive: true })
  return dir
}

export function globalWorkspace(directory: string): Workspace {
  const stamp = Date.now()
  return {
    id: GLOBAL_ID,
    directory,
    kind: "local",
    created_at: stamp,
    updated_at: stamp,
  }
}
