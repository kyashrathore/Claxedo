import type { AppError, FileNode, GitStatus } from "@/server"

export type FetchView<T> =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly data: T }
  | { readonly kind: "failed"; readonly error: AppError }

export type FetchResult<T> = {
  readonly status: "pending" | "error" | "success"
  readonly data: T | undefined
  readonly error: AppError | null
}

export function fetchView<T>(query: FetchResult<T>): FetchView<T> {
  if (query.status === "success" && query.data !== undefined) return { kind: "ready", data: query.data }
  if (query.status === "error" && query.error) return { kind: "failed", error: query.error }
  return { kind: "loading" }
}

export type ChangeMark = "added" | "deleted" | "modified"

function markOf(status: string): ChangeMark {
  if (status === "added" || status === "untracked") return "added"
  if (status === "deleted") return "deleted"
  return "modified"
}

function mergeMark(current: ChangeMark | undefined, next: ChangeMark): ChangeMark {
  if (!current || current === next) return next
  return "modified"
}

export function changeMarks(status: GitStatus | undefined): ReadonlyMap<string, ChangeMark> {
  const marks = new Map<string, ChangeMark>()
  if (!status) return marks
  for (const change of [...status.staged, ...status.unstaged]) {
    const path = change.path.replaceAll("\\", "/").replace(/\/+$/, "")
    const mark = markOf(change.status)
    marks.set(path, mergeMark(marks.get(path), mark))
    const parts = path.split("/")
    for (let index = 1; index < parts.length; index += 1) {
      const dir = parts.slice(0, index).join("/")
      marks.set(dir, mergeMark(marks.get(dir), mark))
    }
  }
  return marks
}

export function sortNodes(nodes: readonly FileNode[]): readonly FileNode[] {
  return [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}

export type TreeKeyAction =
  { readonly kind: "focus"; readonly index: number } | { readonly kind: "toggle" } | { readonly kind: "none" }

export function treeKeyAction(input: {
  readonly key: string
  readonly index: number
  readonly count: number
  readonly expanded: boolean | undefined
}): TreeKeyAction {
  const { key, index, count, expanded } = input
  if (count === 0) return { kind: "none" }
  const clamp = (value: number) => Math.max(0, Math.min(count - 1, value))
  if (key === "ArrowDown") return { kind: "focus", index: clamp(index + 1) }
  if (key === "ArrowUp") return { kind: "focus", index: clamp(index - 1) }
  if (key === "Home") return { kind: "focus", index: 0 }
  if (key === "End") return { kind: "focus", index: count - 1 }
  if (key === "ArrowRight" && expanded === false) return { kind: "toggle" }
  if (key === "ArrowRight" && expanded === true) return { kind: "focus", index: clamp(index + 1) }
  if (key === "ArrowLeft" && expanded === true) return { kind: "toggle" }
  if (key === "ArrowLeft") return { kind: "focus", index: clamp(index - 1) }
  return { kind: "none" }
}
