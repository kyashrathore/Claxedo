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
  test("maintains only marker-owned Cursor local plugins and clears them on disable", async () => {
    const home = await temporary("claxedo-cursor-home-")
    const source = await temporary("claxedo-cursor-plugin-")
    const localRoot = path.join(home, ".cursor", "plugins", "local")
    const userPlugin = path.join(localRoot, "user-owned")
    await fs.mkdir(userPlugin, { recursive: true })
    await fs.writeFile(path.join(userPlugin, "keep.txt"), "keep")
    const adapter = cursorAgentPluginAdapter({ userHomeDirectory: home })

    const enabled = await adapter.project({ generationRoot: source, plugins: [await generationPlugin(source, "v1")] })
    expect(enabled.pluginRoots).toHaveLength(1)
    expect(enabled.pluginRoots[0]!.root).toContain(path.join(".cursor", "plugins", "local", "claxedo--"))
    expect(await fs.readFile(path.join(enabled.pluginRoots[0]!.root, "marker.txt"), "utf8")).toBe("v1")
    expect(await fs.readFile(path.join(userPlugin, "keep.txt"), "utf8")).toBe("keep")

    const disabled = await adapter.project({ generationRoot: source, plugins: [] })
    expect(disabled.pluginRoots).toEqual([])
    await expect(fs.stat(enabled.pluginRoots[0]!.root)).rejects.toMatchObject({ code: "ENOENT" })
    expect(await fs.readFile(path.join(userPlugin, "keep.txt"), "utf8")).toBe("keep")
  })

  test("refuses to overwrite a destination after its ownership marker is removed", async () => {
    const home = await temporary("claxedo-cursor-home-")
    const source = await temporary("claxedo-cursor-plugin-")
    const adapter = cursorAgentPluginAdapter({ userHomeDirectory: home })
    const plugin = await generationPlugin(source, "v1")
    const first = await adapter.project({ generationRoot: source, plugins: [plugin] })
    await fs.rm(path.join(first.pluginRoots[0]!.root, ".claxedo-agent-plugin.json"))

    await expect(adapter.project({ generationRoot: source, plugins: [plugin] }))
      .rejects.toThrow("is not owned by Claxedo")
    expect(await fs.readFile(path.join(first.pluginRoots[0]!.root, "marker.txt"), "utf8")).toBe("v1")
  })
})
