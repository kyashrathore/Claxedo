import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { inspectPluginDirectory } from "@claxedo/server-core/agent-plugins/artifacts/node-tree"
import { cursorAgentPluginAdapter } from "./cursor"

const roots: string[] = []
async function temporary(prefix: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  roots.push(root)
  return root
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))))

async function generationPlugin(root: string, marker: string) {
  await fs.writeFile(path.join(root, "plugin.json"), JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "review",
  }))
  await fs.writeFile(path.join(root, "marker.txt"), marker)
  const inspected = await inspectPluginDirectory(root)
  return { pluginInstanceId: '["claxedo","review"]', artifactDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const, plugin: inspected.plugin, root, dataRoot: path.join(root, "data") }
}

describe("cursorAgentPluginAdapter", () => {
  test("projects immutable generation roots and an empty selection has no roots", async () => {
    const source = await temporary("claxedo-cursor-plugin-")
    const generationRoot = await temporary("claxedo-cursor-generation-")
    const adapter = cursorAgentPluginAdapter()
    const enabled = await adapter.project({ generationRoot, plugins: [await generationPlugin(source, "v1")] })
    expect(enabled.pluginRoots).toHaveLength(1)
    expect(enabled.pluginRoots[0].root.startsWith(path.join(generationRoot, "harnesses", "cursor"))).toBe(true)
    expect(await fs.readFile(path.join(enabled.pluginRoots[0].root, "marker.txt"), "utf8")).toBe("v1")
    expect((await adapter.project({ generationRoot, plugins: [] })).pluginRoots).toEqual([])
    expect(await fs.readFile(path.join(enabled.pluginRoots[0].root, "marker.txt"), "utf8")).toBe("v1")
    await expect(fs.stat(path.join(enabled.pluginRoots[0].root, ".claxedo-agent-plugin.json"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("refuses to overwrite a generation view", async () => {
    const source = await temporary("claxedo-cursor-plugin-")
    const generationRoot = await temporary("claxedo-cursor-generation-")
    const adapter = cursorAgentPluginAdapter()
    const plugin = await generationPlugin(source, "v1")
    const first = await adapter.project({ generationRoot, plugins: [plugin] })
    await expect(adapter.project({ generationRoot, plugins: [plugin] })).rejects.toMatchObject({ code: "ERR_FS_CP_EEXIST" })
    expect(await fs.readFile(path.join(first.pluginRoots[0].root, "marker.txt"), "utf8")).toBe("v1")
  })
})
