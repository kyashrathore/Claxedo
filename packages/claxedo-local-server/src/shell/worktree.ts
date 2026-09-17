import fs from "fs"
import path from "path"
import { randomUUID } from "crypto"
import { controlBus } from "@claxedo/server-core/platform/runtime/lib/bus"
import { dataDir } from "@claxedo/server-core/platform/runtime/lib/paths"
import { gitRun } from "./git"

function slug(input: string) {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
}

export async function nextWorktreeInfo(dir: string, project_id: string, name?: string) {
  const root = path.join(dataDir(), "worktree", project_id)
  await fs.promises.mkdir(root, { recursive: true })
  const base = name ? slug(name) : ""
  for (const i of Array.from({ length: 26 }, (_, idx) => idx)) {
    const next = base || `wt-${randomUUID().slice(0, 8)}`
    const item = i === 0 ? next : `${next}-${randomUUID().slice(0, 4)}`
    const branch = `claxedo/${item}`
    const directory = path.join(root, item)
    const hit = await fs.promises.stat(directory).then(() => true, () => false)
    if (hit) continue
    const ref = await gitRun(dir, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])
    if (ref.ok) continue
    return { name: item, branch, directory }
  }
  return undefined
}

export function publishWorktreeReady(info: { name: string; branch: string; directory: string }) {
  controlBus.publish({
    type: "worktree.ready",
    directory: info.directory,
    name: info.name,
    branch: info.branch,
  })
}

export function publishWorktreeFailed(directory: string, message: string) {
  controlBus.publish({
    type: "worktree.failed",
    directory,
    message,
  })
}
