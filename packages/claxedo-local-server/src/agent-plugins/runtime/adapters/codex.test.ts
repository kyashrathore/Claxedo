import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { inspectPluginDirectory } from "@claxedo/server-core/agent-plugins/artifacts/node-tree"
import { codexAgentPluginAdapter } from "./codex"

const roots: string[] = []
async function temporary(prefix: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  roots.push(root)
  return root
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))))

async function plugin(root: string, instanceId: string) {
  await fs.mkdir(root, { recursive: true })
  await fs.writeFile(path.join(root, "plugin.json"), JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
    name: "review",
  }))
  await fs.writeFile(path.join(root, "mcp.json"), JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
    mcpServers: {
      review: {
        type: "streamable-http",
        url: "https://review.example/mcp",
      },
    },
  }))
  return {
    pluginInstanceId: instanceId,
    artifactDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const,
    plugin: (await inspectPluginDirectory(root)).plugin,
    root,
    dataRoot: path.join(path.dirname(root), "data", instanceId),
  }
}

describe("codexAgentPluginAdapter", () => {
  test("an empty generation needs no personal Codex configuration", async () => {
    const generationRoot = await temporary("claxedo-codex-empty-")
    expect(await codexAgentPluginAdapter().project({ generationRoot, plugins: [] })).toEqual({ harnessId: "codex", pluginRoots: [], mcpServers: [], notApplied: [] })
  })

  test("projects Codex metadata and MCP into the generation for the profile's sole marketplace writer", async () => {
    const generationRoot = await temporary("claxedo-codex-generation-")
    const retainedRoot = path.join(generationRoot, "plugins", "review")
    const retained = await plugin(retainedRoot, "claxedo-review")
    const projected = await codexAgentPluginAdapter().project({ generationRoot, plugins: [retained] })
    const root = projected.pluginRoots[0].root
    expect(projected.pluginRoots).toEqual([{ pluginInstanceId: "claxedo-review", root, dataRoot: retained.dataRoot, skillNames: [] }])
    expect(root.startsWith(path.join(generationRoot, "harnesses", "codex", "plugins"))).toBe(true)
    expect(root).not.toBe(retainedRoot)
    expect(JSON.parse(await fs.readFile(path.join(root, ".codex-plugin/plugin.json"), "utf8"))).toEqual({ name: "review", version: "1.0.0", mcpServers: "./.mcp.json" })
    expect(JSON.parse(await fs.readFile(path.join(root, ".mcp.json"), "utf8"))).toEqual({ mcpServers: { review: { type: "http", url: "https://review.example/mcp" } } })
    await expect(fs.stat(path.join(generationRoot, ".agents/plugins/marketplace.json"))).rejects.toMatchObject({ code: "ENOENT" })
    await expect(fs.stat(path.join(generationRoot, "harnesses/codex/launch.json"))).rejects.toMatchObject({ code: "ENOENT" })
    expect((await codexAgentPluginAdapter().project({ generationRoot, plugins: [] })).pluginRoots).toEqual([])
    expect(await fs.readFile(path.join(retainedRoot, "mcp.json"), "utf8")).toContain("streamable-http")
  })

  test("same-name instances remain separate roots for the profile to validate", async () => {
    const generationRoot = await temporary("claxedo-codex-generation-")
    const projected = await codexAgentPluginAdapter().project({ generationRoot, plugins: [
      await plugin(path.join(generationRoot, "plugins/one"), "personal-review"),
      await plugin(path.join(generationRoot, "plugins/two"), "org-review"),
    ] })
    expect(new Set(projected.pluginRoots.map((item) => item.root)).size).toBe(2)
  })
})
