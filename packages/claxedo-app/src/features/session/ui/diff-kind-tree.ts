// Build the per-path change-kind map ("add" | "del" | "mix") that the session
// file tree colours its rows with. Extracted from `session.tsx`'s inline
// `kinds()` memo. Pure over the diff list.

export type DiffKind = "add" | "del" | "mix"

export type DiffKindInput = {
  file?: string | null
  status?: string | null
}

function merge(a: DiffKind | undefined, b: DiffKind): DiffKind {
  if (!a) return b
  if (a === b) return a
  return "mix"
}

function normalize(path: string): string {
  return path.replaceAll("\\\\", "/").replace(/\/+$/, "")
}

function kindForStatus(status: string | null | undefined): DiffKind {
  if (status === "added") return "add"
  if (status === "deleted") return "del"
  return "mix"
}

/**
 * Map every file (and each of its ancestor directories) to a change kind.
 *
 * A file's own kind is derived from its diff `status` (added → "add",
 * deleted → "del", anything else → "mix"). Each ancestor directory
 * accumulates the merge of its descendants' kinds: uniform children keep the
 * shared kind, divergent children become "mix". Paths are normalized
 * (backslashes → "/", trailing slashes trimmed) before splitting so tree keys
 * are stable across platforms.
 */
export function buildDiffKindTree(diffs: readonly DiffKindInput[]): Map<string, DiffKind> {
  const out = new Map<string, DiffKind>()
  for (const diff of diffs) {
    const file = normalize(diff.file ?? "")
    const kind = kindForStatus(diff.status)

    out.set(file, kind)

    const parts = file.split("/")
    for (const [idx] of parts.slice(0, -1).entries()) {
      const dir = parts.slice(0, idx + 1).join("/")
      if (!dir) continue
      out.set(dir, merge(out.get(dir), kind))
    }
  }
  return out
}
