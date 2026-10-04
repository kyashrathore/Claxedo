import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"
import { acquirePluginArtifact } from "./acquire"
import type { AgentPluginArtifactStore } from "./types"
import { loadAgentPluginTreeFromDirectory } from "./node-tree"
import { agentPluginTree } from "./tree"

const roots: string[] = []

async function plugin() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-plugin-acquire-"))
  roots.push(root)
  await fs.writeFile(path.join(root, "plugin.json"), JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "review",
  }))
  return await loadAgentPluginTreeFromDirectory(root)
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe("acquirePluginArtifact", () => {
  test("validates and stores immutable bytes before committing authority metadata", async () => {
    const tree = await plugin()
    const order: string[] = []
    const store: AgentPluginArtifactStore = {
      put: vi.fn(async (artifact) => {
        order.push(`store:${artifact.digest}`)
        return { digest: artifact.digest, root: "/retained/artifact", tree: artifact.tree, plugin: artifact.plugin }
      }),
      get: vi.fn(),
    }

    const acquired = await acquirePluginArtifact({
      tree,
      store,
      commit: async (artifact) => {
        order.push(`commit:${artifact.digest}`)
      },
    })

    expect(acquired.digest).toMatch(/^sha256:/)
    expect(order).toEqual([`store:${acquired.digest}`, `commit:${acquired.digest}`])
  })

  test("does not commit metadata when validation or storage fails", async () => {
    const invalid = agentPluginTree([])
    const commit = vi.fn()
    const store: AgentPluginArtifactStore = {
      put: vi.fn(async () => { throw new Error("object store unavailable") }),
      get: vi.fn(),
    }

    await expect(acquirePluginArtifact({ tree: invalid, store, commit })).rejects.toMatchObject({
      code: "plugin-invalid",
    })
    expect(store.put).not.toHaveBeenCalled()
    expect(commit).not.toHaveBeenCalled()

    await expect(acquirePluginArtifact({ tree: await plugin(), store, commit })).rejects.toThrow("object store unavailable")
    expect(commit).not.toHaveBeenCalled()
  })

  test("a metadata failure leaves only an unpinned immutable artifact", async () => {
    const tree = await plugin()
    const store: AgentPluginArtifactStore = {
      put: vi.fn(async (artifact) => ({ digest: artifact.digest, root: "/retained/artifact", tree: artifact.tree, plugin: artifact.plugin })),
      get: vi.fn(),
    }

    await expect(acquirePluginArtifact({
      tree,
      store,
      commit: async () => { throw new Error("revision conflict") },
    })).rejects.toThrow("revision conflict")
    expect(store.put).toHaveBeenCalledOnce()
  })
})
