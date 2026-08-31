import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { validatePluginTree } from "@claxedo/server-core/agent-plugins/catalog/validate-plugin"
import { loadAgentPluginTreeFromDirectory } from "@claxedo/server-core/agent-plugins/artifacts/node-tree"
import { claudeAgentPluginAdapter } from "./claude"

const roots: string[] = []
async function temporary(prefix: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  roots.push(root)
  return root
}
afterEach(async () => Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))))

describe("claudeAgentPluginAdapter", () => {
  test("creates one Claude directory plugin without writing user configuration", async () => {
    const pluginRoot = await temporary("claxedo-standard-plugin-")
    const generationRoot = await temporary("claxedo-generation-")
    const dataRoot = await temporary("claxedo-plugin-data-")
    await fs.mkdir(path.join(pluginRoot, "skills", "review"), { recursive: true })
    await fs.writeFile(path.join(pluginRoot, "plugin.json"), JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "review",
      version: "1.0.0",
    }))
    await fs.writeFile(path.join(pluginRoot, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Review code\n---\n")
    await fs.writeFile(path.join(pluginRoot, "mcp.json"), JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        review: { type: "stdio", command: "review-server", args: ["${PLUGIN_DATA}/state"] },
      },
    }))
    const validated = validatePluginTree(await loadAgentPluginTreeFromDirectory(pluginRoot), pluginRoot)
    if (validated.status !== "valid") throw new Error("invalid fixture")

    const result = await claudeAgentPluginAdapter().project({
      generationRoot,
      plugins: [{ pluginInstanceId: "claxedo/review", artifactDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", plugin: validated.plugin, root: pluginRoot, dataRoot }],
    })

    const view = result.pluginRoots[0]!.root
    expect(JSON.parse(await fs.readFile(path.join(view, ".claude-plugin", "plugin.json"), "utf8"))).toEqual({
      name: "review",
      version: "1.0.0",
    })
    expect(JSON.parse(await fs.readFile(path.join(view, ".mcp.json"), "utf8"))).toMatchObject({
      mcpServers: { review: { command: "review-server", args: ["${CLAUDE_PLUGIN_DATA}/state"] } },
    })
    expect(await fs.stat(path.join(view, "skills", "review", "SKILL.md")).then((item) => item.isFile())).toBe(true)
  })
})
