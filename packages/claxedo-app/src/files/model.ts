import type { FileChange, FileNode, GitStatus } from "@/server"

export type ChangeKind = "add" | "del" | "mix"

function kindForStatus(status: FileChange["status"]): ChangeKind {
  if (status === "added" || status === "untracked") return "add"
  if (status === "deleted") return "del"
  return "mix"
}

function mergeKind(current: ChangeKind | undefined, next: ChangeKind): ChangeKind {
  if (!current || current === next) return next
  return "mix"
}

export function buildKinds(status: GitStatus | undefined): ReadonlyMap<string, ChangeKind> {
  const out = new Map<string, ChangeKind>()
  for (const change of [...(status?.staged ?? []), ...(status?.unstaged ?? [])]) {
    const normalized = change.path.replaceAll("\\", "/").replace(/\/+$/, "")
    const kind = kindForStatus(change.status)
    out.set(normalized, mergeKind(out.get(normalized), kind))
    const parts = normalized.split("/")
    for (const [index] of parts.slice(0, -1).entries()) {
      const dir = parts.slice(0, index + 1).join("/")
      if (dir) out.set(dir, mergeKind(out.get(dir), kind))
    }
  }
  return out
}

export function sortNodes(nodes: readonly FileNode[]): readonly FileNode[] {
  return [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1
    return a.name.localeCompare(b.name)
  })
}
