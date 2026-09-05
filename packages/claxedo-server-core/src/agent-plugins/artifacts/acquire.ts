import type { ArtifactDigest } from "../activation/types"
import { validatePluginTree } from "../catalog/validate-plugin"
import type { AgentPluginTree } from "./tree"
import { agentPluginTree } from "./tree"
import {
  AgentPluginArtifactError,
  type AgentPluginArtifactStore,
  type InspectedAgentPluginArtifact,
  type RetainedAgentPluginArtifact,
} from "./types"

const encoder = new TextEncoder()

function frame(value: string | Uint8Array) {
  const bytes = typeof value === "string" ? encoder.encode(value) : value
  const framed = new Uint8Array(8 + bytes.byteLength)
  new DataView(framed.buffer).setBigUint64(0, BigInt(bytes.byteLength), false)
  framed.set(bytes, 8)
  return framed
}

function concatenate(chunks: readonly Uint8Array[]) {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0))
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

/** Runtime-neutral digest of the canonical, bounded logical package tree. */
export async function digestPluginTree(tree: AgentPluginTree): Promise<ArtifactDigest> {
  const chunks: Uint8Array[] = []
  for (const entry of tree.entries) {
    if (entry.kind === "invalid") {
      throw new AgentPluginArtifactError("artifact-unsupported-entry", `Invalid source entry cannot be retained: ${entry.path}`)
    }
    chunks.push(frame(entry.kind), frame(entry.path))
    if (entry.kind === "file") {
      chunks.push(frame(String(entry.executableMode)), frame(entry.bytes))
    }
  }
  const digest = await crypto.subtle.digest("SHA-256", concatenate(chunks))
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
  return `sha256:${hex}`
}

export async function inspectPluginTree(tree: AgentPluginTree): Promise<InspectedAgentPluginArtifact> {
  const validation = validatePluginTree(tree)
  if (validation.status === "invalid") {
    const reason = validation.diagnostics.map((item) => `${item.path}: ${item.message}`).join("; ")
    throw new AgentPluginArtifactError("plugin-invalid", reason || "Plugin is invalid")
  }
  const retainable = agentPluginTree(tree.entries.filter((entry) => entry.kind !== "invalid"))
  return {
    digest: await digestPluginTree(retainable),
    tree: retainable,
    plugin: validation.plugin,
    diagnostics: validation.diagnostics,
  }
}

/** Retain immutable bytes before atomically binding metadata to the digest. */
export async function acquirePluginArtifact(input: {
  tree: AgentPluginTree
  store: AgentPluginArtifactStore
  commit(artifact: RetainedAgentPluginArtifact): Promise<void>
}): Promise<RetainedAgentPluginArtifact> {
  const inspected = await inspectPluginTree(input.tree)
  const retained = await input.store.put(inspected)
  await input.commit(retained)
  return retained
}
