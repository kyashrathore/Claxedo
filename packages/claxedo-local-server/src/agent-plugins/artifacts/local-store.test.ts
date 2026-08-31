import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { inspectPluginDirectory } from "@claxedo/server-core/agent-plugins/artifacts/node-tree"
import { LocalAgentPluginArtifactStore } from "./local-store"

const roots: string[] = []

async function temp(prefix: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  roots.push(root)
  return root
}

async function plugin() {
  const root = await temp("claxedo-plugin-source-")
  await fs.writeFile(path.join(root, "plugin.json"), JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "review",
  }))
  await fs.mkdir(path.join(root, "skills", "review"), { recursive: true })
  await fs.writeFile(path.join(root, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Review code\n---\n")
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe("LocalAgentPluginArtifactStore", () => {
  test("retains an immutable plugin after its source disappears", async () => {
    const source = await plugin()
    const data = await temp("claxedo-plugin-data-")
    const inspected = await inspectPluginDirectory(source)
    const store = new LocalAgentPluginArtifactStore(data)

    const first = await store.put(inspected)
    await fs.rm(source, { recursive: true, force: true })
    const retained = await store.get(first.digest)

    expect(retained?.digest).toBe(first.digest)
    await expect(fs.readFile(path.join(retained!.root!, "plugin.json"), "utf8")).resolves.toContain('"name":"review"')
  })

  test("is idempotent for the same digest and verifies retained bytes on read", async () => {
    const source = await plugin()
    const data = await temp("claxedo-plugin-data-")
    const inspected = await inspectPluginDirectory(source)
    const store = new LocalAgentPluginArtifactStore(data)

    const first = await store.put(inspected)
    const second = await store.put(inspected)
    expect(second.root).toBe(first.root)

    await fs.writeFile(path.join(first.root!, "plugin.json"), "tampered")
    await expect(store.get(first.digest)).rejects.toMatchObject({ code: "artifact-corrupt" })
  })
})
