import { queryClient } from "@/platform/query/query-client"
import { workspaceIdFromRef } from "@/platform/identity/legacy-resolver"
import { same } from "@/lib/same"

const normalize = (directory: string) => directory.replace(/[\\/]+$/, "")

export type WorktreeState =
  | {
      status: "pending"
    }
  | {
      status: "ready"
    }
  | {
      status: "failed"
      message: string
    }

export const Worktree = {
  get(directory: string) {
    return readWorktreeState(normalize(directory))
  },
  pending(directory: string) {
    const key = normalize(directory)
    const current = readWorktreeState(key)
    if (current && current.status !== "pending") return
    writeWorktreeState(key, { status: "pending" })
  },
  ready(directory: string) {
    const key = normalize(directory)
    const next = { status: "ready" } as const
    writeWorktreeState(key, next)
  },
  failed(directory: string, message: string) {
    const key = normalize(directory)
    const next = { status: "failed", message } as const
    writeWorktreeState(key, next)
  },
  wait(directory: string) {
    const key = normalize(directory)
    const current = readWorktreeState(key)
    if (current && current.status !== "pending") return Promise.resolve(current)

    const existing = queryClient.getQueryData<Promise<WorktreeState>>(worktreeWaitKey(key))
    if (existing) return existing

    const promise = waitForWorktreeState(key).finally(() => {
      queryClient.removeQueries({ queryKey: worktreeWaitKey(key) })
    })
    queryClient.setQueryData(worktreeWaitKey(key), promise)
    return promise
  },
}

/** Project the server-owned worktree lifecycle into the state prompt dispatch awaits. */
export function applyWorktreeLifecycleEvent(input: unknown) {
  if (!input || typeof input !== "object") return
  const event = input as { type?: unknown; directory?: unknown; message?: unknown }
  if (typeof event.directory !== "string" || !event.directory) return
  if (event.type === "worktree.ready") {
    Worktree.ready(event.directory)
    return
  }
  if (event.type !== "worktree.failed" || typeof event.message !== "string") return
  Worktree.failed(event.directory, event.message)
}

function readWorktreeState(key: string) {
  return queryClient.getQueryData<WorktreeState>(worktreeStateKey(key))
}

function writeWorktreeState(key: string, state: WorktreeState) {
  queryClient.setQueryData(worktreeStateKey(key), state)
}

function waitForWorktreeState(key: string) {
  return new Promise<WorktreeState>((resolve) => {
    const current = readWorktreeState(key)
    if (current && current.status !== "pending") {
      resolve(current)
      return
    }

    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (!same(event.query.queryKey, worktreeStateKey(key))) return
      const next = readWorktreeState(key)
      if (!next || next.status === "pending") return
      unsubscribe()
      resolve(next)
    })
  })
}

function worktreeStateKey(key: string) {
  return ["shell", "worktree", key, "state"] as const
}

function worktreeWaitKey(key: string) {
  return ["shell", "worktree", key, "wait"] as const
}

export function validWorktree(input: string | undefined) {
  if (!input) return false
  const value = input.trim()
  if (!value) return false
  if (value.includes("\0")) return false
  if (value === "/" || value === "\\") return false
  if (value.length > 4096) return false

  const abs = value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\")
  if (!abs) return false

  if (/^[A-Za-z]:[\\/]?$/.test(value)) return false
  if (/[\\/]\.{1,2}(?:[\\/]|$)/.test(value)) return false

  // /workspace is the cloud container WORKSPACE_DIR — never a valid local worktree
  if (value === "/workspace") return false
  return true
}

export function validProjectRef(input: string | undefined) {
  if (!input) return false
  const value = input.trim()
  if (workspaceIdFromRef(value)) return true
  return validWorktree(input)
}
