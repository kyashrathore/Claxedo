import type { AgentRuntimeEvent, AgentSnapshotFileDiff } from "@claxedo/agent-runtime-contract"

function splitLines(value: string) {
  if (!value) return []
  return value.endsWith("\n") ? value.slice(0, -1).split("\n") : value.split("\n")
}

function lineStats(oldText: string | undefined, newText: string) {
  if (oldText === undefined) return { additions: splitLines(newText).length, deletions: 0 }
  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)
  const shared = new Map<string, number>()
  oldLines.forEach((line) => shared.set(line, (shared.get(line) ?? 0) + 1))
  const common = newLines.reduce((count, line) => {
    const remaining = shared.get(line) ?? 0
    if (remaining <= 0) return count
    shared.set(line, remaining - 1)
    return count + 1
  }, 0)
  return {
    additions: Math.max(0, newLines.length - common),
    deletions: Math.max(0, oldLines.length - common),
  }
}

function unifiedPatch(path: string, oldText: string | undefined, newText: string) {
  if (newText.startsWith("diff --git ") || newText.startsWith("@@ ")) return newText
  if (oldText === undefined) return undefined
  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)
  return [
    `--- a/${path}`,
    `+++ b/${path}`,
    `@@ -1,${oldLines.length} +1,${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`),
    ...newLines.map((line) => `+${line}`),
    "",
  ].join("\n")
}

export function snapshotFileDiff(chunk: Extract<AgentRuntimeEvent, { type: "file-diff" }>): AgentSnapshotFileDiff {
  const stats = lineStats(chunk.oldText, chunk.newText)
  return {
    file: chunk.path,
    ...stats,
    status: chunk.oldText === undefined ? "added" : chunk.newText.length === 0 ? "deleted" : "modified",
    ...(unifiedPatch(chunk.path, chunk.oldText, chunk.newText) ? { patch: unifiedPatch(chunk.path, chunk.oldText, chunk.newText) } : {}),
  }
}
