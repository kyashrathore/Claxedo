import { AgentPluginArtifactError } from "./types"

export const MAX_AGENT_PLUGIN_FILES = 5_000
export const MAX_AGENT_PLUGIN_BYTES = 20 * 1024 * 1024

export type AgentPluginTreeEntry =
  | { path: string; kind: "directory" }
  | { path: string; kind: "file"; bytes: Uint8Array; executableMode: number }
  | { path: string; kind: "invalid"; reason: "path-escape" | "unsupported-entry" }

export type AgentPluginTree = {
  entries: readonly AgentPluginTreeEntry[]
}

function validPath(value: string) {
  if (!value || value.startsWith("/") || value.endsWith("/") || value.includes("\\")) return false
  const parts = value.split("/")
  return parts.every((part) => part && part !== "." && part !== ".." && !part.includes("\0"))
}

/** Canonicalize and bound a portable plugin tree at every adapter boundary. */
export function agentPluginTree(entries: readonly AgentPluginTreeEntry[]): AgentPluginTree {
  if (entries.length > MAX_AGENT_PLUGIN_FILES) {
    throw new AgentPluginArtifactError("artifact-unsupported-entry", `Plugin contains more than ${MAX_AGENT_PLUGIN_FILES} entries`)
  }
  const seen = new Set<string>()
  let bytes = 0
  const normalized = entries.map((entry): AgentPluginTreeEntry => {
    if (!validPath(entry.path) || seen.has(entry.path)) {
      throw new AgentPluginArtifactError("artifact-path-escape", `Invalid or duplicate plugin path: ${entry.path}`)
    }
    seen.add(entry.path)
    if (entry.kind === "directory") return { path: entry.path, kind: "directory" }
    if (entry.kind === "invalid") return { path: entry.path, kind: "invalid", reason: entry.reason }
    if (!Number.isSafeInteger(entry.executableMode) || entry.executableMode < 0 || entry.executableMode > 0o111) {
      throw new AgentPluginArtifactError("artifact-unsupported-entry", `Invalid executable mode for ${entry.path}`)
    }
    const content = new Uint8Array(entry.bytes)
    bytes += content.byteLength
    return { path: entry.path, kind: "file", bytes: content, executableMode: entry.executableMode }
  }).toSorted((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  if (bytes > MAX_AGENT_PLUGIN_BYTES) {
    throw new AgentPluginArtifactError("artifact-unsupported-entry", `Plugin exceeds ${MAX_AGENT_PLUGIN_BYTES} bytes`)
  }
  const byPath = new Map(normalized.map((entry) => [entry.path, entry]))
  for (const entry of normalized) {
    const parts = entry.path.split("/")
    for (let index = 1; index < parts.length; index++) {
      const parent = parts.slice(0, index).join("/")
      const parentEntry = byPath.get(parent)
      if (!parentEntry || parentEntry.kind !== "directory") {
        throw new AgentPluginArtifactError("artifact-unsupported-entry", `Plugin path ${entry.path} has no directory entry for ${parent}`)
      }
    }
  }
  return { entries: normalized }
}

export function treeEntry(tree: AgentPluginTree, relativePath: string) {
  const normalized = relativePath === "." ? "" : relativePath.replace(/^\.\//, "").replace(/\/$/, "")
  if (!normalized) return { path: "", kind: "directory" as const }
  return tree.entries.find((entry) => entry.path === normalized)
    ?? tree.entries.find((entry) => entry.kind === "invalid" && normalized.startsWith(`${entry.path}/`))
}

export function treeText(tree: AgentPluginTree, relativePath: string): string | undefined {
  const entry = treeEntry(tree, relativePath)
  if (!entry || entry.kind !== "file") return undefined
  return new TextDecoder("utf-8", { fatal: true }).decode(entry.bytes)
}

export function treeChildren(tree: AgentPluginTree, relativeDirectory: string) {
  const prefix = relativeDirectory ? `${relativeDirectory.replace(/\/$/, "")}/` : ""
  const names = new Set<string>()
  for (const entry of tree.entries) {
    if (!entry.path.startsWith(prefix)) continue
    const remainder = entry.path.slice(prefix.length)
    if (!remainder || remainder.includes("/")) continue
    names.add(remainder)
  }
  return [...names].sort()
}
