import { describe, expect, test, vi } from "vitest"
import { inspectPluginTree } from "@claxedo/server-core/agent-plugins/artifacts/acquire"
import { agentPluginTree } from "@claxedo/server-core/agent-plugins/artifacts/tree"
import { hostedAgentPluginArtifactStore, type AgentPluginR2Bucket } from "./r2-artifact-adapter"

function stream(bytes: Uint8Array) {
  return new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close() } })
}

function memoryBucket() {
  const values = new Map<string, Uint8Array>()
  const bucket: AgentPluginR2Bucket = {
    async get(key) {
      const bytes = values.get(key)
      return bytes ? { size: bytes.byteLength, body: stream(bytes) } : null
    },
    put: vi.fn(async (key: string, bytes: Uint8Array) => {
      if (values.has(key)) return null
      values.set(key, bytes.slice())
      return { etag: "created" }
    }),
  }
  return { bucket, values }
}

async function artifact() {
  return inspectPluginTree(agentPluginTree([
    { path: "plugin.json", kind: "file", executableMode: 0, bytes: new TextEncoder().encode(JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "review",
    })) },
  ]))
}

describe("hostedAgentPluginArtifactStore", () => {
  test("creates once and reopens only digest-verified retained bytes", async () => {
    const { bucket } = memoryBucket()
    const store = hostedAgentPluginArtifactStore(bucket)
    const inspected = await artifact()
    expect(await store.put(inspected)).toMatchObject({ digest: inspected.digest })
    expect(await store.put(inspected)).toMatchObject({ digest: inspected.digest })
    expect(await store.get(inspected.digest)).toMatchObject({ plugin: { manifest: { name: "review" } } })
    expect(bucket.put).toHaveBeenCalledTimes(2)
  })

  test("reads, verifies, and inspects a retained artifact once per isolate; a miss is not remembered", async () => {
    const { bucket } = memoryBucket()
    const reads = vi.fn(bucket.get)
    const store = hostedAgentPluginArtifactStore({ ...bucket, get: reads })
    const inspected = await artifact()
    await store.put(inspected)
    const before = reads.mock.calls.length
    await store.get(inspected.digest)
    await store.get(inspected.digest)
    expect(reads.mock.calls.length).toBe(before + 1)
    const missing = `sha256:${"0".repeat(64)}` as const
    expect(await store.get(missing)).toBeUndefined()
    expect(await store.get(missing)).toBeUndefined()
    expect(reads.mock.calls.length).toBe(before + 3)
  })

  test("rejects corrupted retained bytes rather than synthesizing a result", async () => {
    const { bucket, values } = memoryBucket()
    const store = hostedAgentPluginArtifactStore(bucket)
    const inspected = await artifact()
    await store.put(inspected)
    const [key, bytes] = [...values][0]!
    const corrupt = bytes.slice()
    corrupt[corrupt.byteLength - 1] ^= 1
    values.set(key, corrupt)
    await expect(store.get(inspected.digest)).rejects.toMatchObject({ code: "artifact-corrupt" })
  })
})
