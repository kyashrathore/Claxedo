import fs from "node:fs/promises"
import path from "node:path"

export type DaemonDirs = { acpScriptDir: string; workspaces: string }

export async function daemonDirs(dataDir: string): Promise<DaemonDirs> {
  const dirs = {
    acpScriptDir: path.join(dataDir, "acp-scripts"),
    workspaces: path.join(dataDir, "workspaces"),
  }
  await Promise.all(Object.values(dirs).map((dir) => fs.mkdir(dir, { recursive: true })))
  return dirs
}
