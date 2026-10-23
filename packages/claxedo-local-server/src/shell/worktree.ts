import { controlBus } from "@claxedo/server-core/platform/runtime/lib/bus"

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
