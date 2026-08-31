import { digestPluginTree, inspectPluginTree } from "@claxedo/server-core/agent-plugins/artifacts/acquire"
import {
  MAX_ENCODED_AGENT_PLUGIN_BYTES,
  decodePluginTree,
  encodePluginTree,
} from "@claxedo/server-core/agent-plugins/artifacts/codec"
import {
  AgentPluginArtifactError,
  type AgentPluginArtifactStore,
} from "@claxedo/server-core/agent-plugins/artifacts/types"

export type AgentPluginR2Object = Readonly<{
  size: number
  body: ReadableStream<Uint8Array>
}>

export type AgentPluginR2Bucket = Readonly<{
  get(key: string): Promise<AgentPluginR2Object | null>
  put(
    key: string,
    value: Uint8Array,
    options: Readonly<{ onlyIf: Readonly<{ etagDoesNotMatch: "*" }> }>,
  ): Promise<Readonly<{ etag: string }> | null>
}>

const PREFIX = "agent-plugins/artifacts/"

function objectKey(digest: string) {
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new AgentPluginArtifactError("artifact-corrupt", "Agent Plugin artifact digest is invalid")
  }
  return `${PREFIX}${digest.slice("sha256:".length)}.clxplugin`
}

async function readBounded(object: AgentPluginR2Object) {
  if (object.size > MAX_ENCODED_AGENT_PLUGIN_BYTES) {
    throw new AgentPluginArtifactError("artifact-corrupt", "Hosted Agent Plugin artifact exceeds its storage bound")
  }
  const output = new Uint8Array(object.size)
  const reader = object.body.getReader()
  let offset = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      if (offset + result.value.byteLength > output.byteLength) {
        throw new AgentPluginArtifactError("artifact-corrupt", "Hosted Agent Plugin artifact changed size while reading")
      }
      output.set(result.value, offset)
      offset += result.value.byteLength
    }
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  if (offset !== object.size) {
    throw new AgentPluginArtifactError("artifact-corrupt", "Hosted Agent Plugin artifact is truncated")
  }
  return output
}

/** Feature-owned immutable R2 storage; no catalog source is needed after acquisition. */
export function hostedAgentPluginArtifactStore(bucket: AgentPluginR2Bucket): AgentPluginArtifactStore {
  const get: AgentPluginArtifactStore["get"] = async (digest) => {
    const object = await bucket.get(objectKey(digest))
    if (!object) return undefined
    const tree = decodePluginTree(await readBounded(object))
    if (await digestPluginTree(tree) !== digest) {
      throw new AgentPluginArtifactError("artifact-corrupt", `Hosted Agent Plugin artifact ${digest} failed digest verification`)
    }
    const inspected = await inspectPluginTree(tree)
    return { digest, tree: inspected.tree, plugin: inspected.plugin }
  }
  return {
    async put(artifact) {
      if (await digestPluginTree(artifact.tree) !== artifact.digest) {
        throw new AgentPluginArtifactError("artifact-corrupt", "Inspected Agent Plugin digest does not match its bytes")
      }
      const key = objectKey(artifact.digest)
      const created = await bucket.put(key, encodePluginTree(artifact.tree), {
        onlyIf: { etagDoesNotMatch: "*" },
      })
      if (!created) {
        const existing = await get(artifact.digest)
        if (!existing) throw new AgentPluginArtifactError("artifact-corrupt", `Hosted Agent Plugin artifact ${artifact.digest} disappeared during acquisition`)
        return existing
      }
      return { digest: artifact.digest, tree: artifact.tree, plugin: artifact.plugin }
    },
    get,
  }
}
