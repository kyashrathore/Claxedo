import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import {
  digestPluginTree,
  inspectPluginTree,
} from "@claxedo/server-core/agent-plugins/artifacts/acquire"
import { loadAgentPluginTreeFromDirectory } from "@claxedo/server-core/agent-plugins/artifacts/node-tree"
import {
  AgentPluginArtifactError,
  type AgentPluginArtifactStore,
  type InspectedAgentPluginArtifact,
  type RetainedAgentPluginArtifact,
} from "@claxedo/server-core/agent-plugins/artifacts/types"
import type { ArtifactDigest } from "@claxedo/server-core/agent-plugins/activation/types"

function digestSegment(digest: ArtifactDigest) {
  const segment = digest.slice("sha256:".length)
  if (!/^[a-f0-9]{64}$/.test(segment)) {
    throw new AgentPluginArtifactError("artifact-corrupt", `Invalid artifact digest ${digest}`)
  }
  return segment
}

export class LocalAgentPluginArtifactStore implements AgentPluginArtifactStore {
  readonly #artifactsRoot: string

  constructor(dataRoot: string) {
    this.#artifactsRoot = path.join(dataRoot, "agent-plugins", "artifacts")
  }

  #path(digest: ArtifactDigest) {
    return path.join(this.#artifactsRoot, digestSegment(digest))
  }

  async put(artifact: InspectedAgentPluginArtifact): Promise<RetainedAgentPluginArtifact> {
    await fs.mkdir(this.#artifactsRoot, { recursive: true })
    const target = this.#path(artifact.digest)
    const existing = await fs.stat(target).then((item) => item.isDirectory()).catch(() => false)
    if (existing) return (await this.get(artifact.digest))!

    const staging = path.join(this.#artifactsRoot, `.staging-${digestSegment(artifact.digest)}-${randomUUID()}`)
    try {
      await fs.mkdir(staging, { recursive: false })
      for (const entry of artifact.tree.entries.filter((entry) => entry.kind === "directory")) {
        await fs.mkdir(path.join(staging, ...entry.path.split("/")), { recursive: true })
      }
      for (const entry of artifact.tree.entries) {
        if (entry.kind !== "file") continue
        const file = path.join(staging, ...entry.path.split("/"))
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, entry.bytes, { mode: 0o600 | entry.executableMode, flag: "wx" })
        await fs.chmod(file, 0o600 | entry.executableMode)
      }
      const copiedTree = await loadAgentPluginTreeFromDirectory(staging)
      const copiedDigest = await digestPluginTree(copiedTree)
      if (copiedDigest !== artifact.digest) {
        throw new AgentPluginArtifactError("artifact-corrupt", `Artifact changed while being retained: expected ${artifact.digest}, got ${copiedDigest}`)
      }
      await fs.rename(staging, target).catch(async (error) => {
        const raced = await fs.stat(target).then((item) => item.isDirectory()).catch(() => false)
        if (!raced) throw error
      })
    } finally {
      await fs.rm(staging, { recursive: true, force: true })
    }
    return (await this.get(artifact.digest))!
  }

  async get(digest: ArtifactDigest): Promise<RetainedAgentPluginArtifact | undefined> {
    const root = this.#path(digest)
    const present = await fs.stat(root).then((item) => item.isDirectory()).catch(() => false)
    if (!present) return undefined
    const tree = await loadAgentPluginTreeFromDirectory(root)
    const actual = await digestPluginTree(tree)
    if (actual !== digest) {
      throw new AgentPluginArtifactError("artifact-corrupt", `Retained artifact ${digest} has digest ${actual}`)
    }
    const inspected = await inspectPluginTree(tree)
    if (inspected.digest !== digest) {
      throw new AgentPluginArtifactError("artifact-corrupt", `Retained artifact ${digest} failed validation`)
    }
    return { digest, root, tree, plugin: { ...inspected.plugin, root } }
  }
}
