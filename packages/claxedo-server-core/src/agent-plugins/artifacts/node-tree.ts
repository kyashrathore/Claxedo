import fs from "node:fs/promises"
import path from "node:path"
import { AgentPluginArtifactError } from "./types"
import { inspectPluginTree } from "./acquire"
import { agentPluginTree, type AgentPluginTreeEntry } from "./tree"
import type { AgentPluginTree } from "./tree"
import type { AgentPluginCollectionSource } from "../catalog/types"

function inside(root: string, target: string) {
  const relative = path.relative(root, target)
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

/** Dereference one local plugin into the same bounded portable tree hosted adapters produce. */
export async function loadAgentPluginTreeFromDirectory(pluginRoot: string) {
  const root = await fs.realpath(pluginRoot)
  const entries: AgentPluginTreeEntry[] = []
  const visit = async (logicalDirectory: string, directory: string, ancestors: ReadonlySet<string>): Promise<void> => {
    const resolvedDirectory = await fs.realpath(directory)
    if (!inside(root, resolvedDirectory)) {
      if (!logicalDirectory) throw new AgentPluginArtifactError("artifact-path-escape", ". resolves outside the plugin root")
      entries.push({ path: logicalDirectory, kind: "invalid", reason: "path-escape" })
      return
    }
    if (ancestors.has(resolvedDirectory)) {
      if (!logicalDirectory) throw new AgentPluginArtifactError("artifact-path-escape", ". contains a symlink cycle")
      entries.push({ path: logicalDirectory, kind: "invalid", reason: "path-escape" })
      return
    }
    const nextAncestors = new Set(ancestors).add(resolvedDirectory)
    for (const name of (await fs.readdir(directory)).toSorted()) {
      const logical = logicalDirectory ? `${logicalDirectory}/${name}` : name
      const candidate = path.join(directory, name)
      const resolved = await fs.realpath(candidate).catch(() => undefined)
      if (!resolved) {
        entries.push({ path: logical, kind: "invalid", reason: "unsupported-entry" })
        continue
      }
      if (!inside(root, resolved)) {
        entries.push({ path: logical, kind: "invalid", reason: "path-escape" })
        continue
      }
      const stat = await fs.stat(resolved)
      if (stat.isDirectory()) {
        entries.push({ path: logical, kind: "directory" })
        await visit(logical, candidate, nextAncestors)
      } else if (stat.isFile()) {
        entries.push({ path: logical, kind: "file", bytes: await fs.readFile(candidate), executableMode: stat.mode & 0o111 })
      } else {
        entries.push({ path: logical, kind: "invalid", reason: "unsupported-entry" })
      }
    }
  }
  await visit("", root, new Set())
  return agentPluginTree(entries)
}

/** Node adapter convenience for tests and local artifact ingestion. */
export async function inspectPluginDirectory(pluginRoot: string) {
  return inspectPluginTree(await loadAgentPluginTreeFromDirectory(pluginRoot))
}

/** Materialize a validated portable tree into a new Node filesystem directory. */
export async function writeAgentPluginTreeToDirectory(tree: AgentPluginTree, destination: string) {
  const normalized = agentPluginTree(tree.entries)
  await fs.mkdir(destination, { recursive: false })
  try {
    for (const entry of normalized.entries) {
      const target = path.join(destination, ...entry.path.split("/"))
      if (!inside(destination, target)) {
        throw new AgentPluginArtifactError("artifact-path-escape", `Plugin path escapes materialization root: ${entry.path}`)
      }
      if (entry.kind === "invalid") {
        throw new AgentPluginArtifactError("artifact-unsupported-entry", `Plugin contains invalid entry ${entry.path}`)
      }
      if (entry.kind === "directory") {
        await fs.mkdir(target)
        continue
      }
      await fs.writeFile(target, entry.bytes, { flag: "wx", mode: 0o600 | entry.executableMode })
    }
  } catch (cause) {
    await fs.rm(destination, { recursive: true, force: true })
    throw cause
  }
}

export async function fileSystemCollectionSource(
  metadata: Omit<AgentPluginCollectionSource, "plugins" | "errors">,
  collectionRoot: string,
): Promise<AgentPluginCollectionSource> {
  const root = await fs.realpath(collectionRoot).catch(() => undefined)
  if (!root || !await fs.stat(root).then((item) => item.isDirectory()).catch(() => false)) {
    return {
      ...metadata,
      plugins: [],
      errors: [{ relativePath: ".", code: "source_unavailable", message: "Collection source is unavailable" }],
    }
  }
  const plugins: AgentPluginCollectionSource["plugins"][number][] = []
  const errors: NonNullable<AgentPluginCollectionSource["errors"]>[number][] = []
  for (const child of (await fs.readdir(root, { withFileTypes: true })).toSorted((a, b) => a.name.localeCompare(b.name))) {
    const childPath = path.join(root, child.name)
    const resolved = await fs.realpath(childPath).catch(() => undefined)
    if (!resolved || !await fs.stat(resolved).then((item) => item.isDirectory()).catch(() => false)) continue
    if (!inside(root, resolved)) {
      errors.push({ relativePath: child.name, code: "plugin_root_escape", message: "Plugin root resolves outside the collection" })
      continue
    }
    try {
      plugins.push({ relativePath: child.name, tree: await loadAgentPluginTreeFromDirectory(resolved) })
    } catch (cause) {
      errors.push({
        relativePath: child.name,
        code: cause instanceof AgentPluginArtifactError && cause.code === "artifact-path-escape"
          ? "plugin_root_escape"
          : "manifest_invalid",
        message: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }
  return { ...metadata, plugins, errors }
}
