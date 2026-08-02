import fs from "fs"
import path from "path"
import { randomUUID } from "crypto"
import { claxedoBus, globalBus } from "../../platform/runtime/lib/bus"
import { dataDir } from "../../platform/runtime/lib/paths"
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
    const branch = `opencode/${item}`
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
  globalBus.publish({
    directory: info.directory,
    payload: {
      type: "worktree.ready",
      properties: {
        name: info.name,
        branch: info.branch,
      },
    },
  })
  claxedoBus.publish({
    type: "worktree.ready",
    directory: info.directory,
    name: info.name,
    branch: info.branch,
  })
}

export function publishWorktreeFailed(directory: string, message: string) {
  globalBus.publish({
    directory,
    payload: {
      type: "worktree.failed",
      properties: {
        message,
      },
    },
  })
  claxedoBus.publish({
    type: "worktree.failed",
    directory,
    message,
  })
}
