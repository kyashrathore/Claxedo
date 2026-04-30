import fs from "fs/promises"
import path from "path"
import { randomUUID } from "crypto"
import { dataDir } from "./paths"
import type { Workspace } from "./workspace-store"

const GLOBAL_ID = "global"

export function globalRoot() {
  return path.join(dataDir(), "global-sessions")
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
