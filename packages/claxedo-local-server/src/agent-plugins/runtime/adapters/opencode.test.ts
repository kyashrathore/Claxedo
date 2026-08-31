import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { validatePluginTree } from "@claxedo/server-core/agent-plugins/catalog/validate-plugin"
import { loadAgentPluginTreeFromDirectory } from "@claxedo/server-core/agent-plugins/artifacts/node-tree"
import { openCodeAgentPluginAdapter } from "./opencode"

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe("OpenCode Agent Plugins projection", () => {
  test("generates module-owned skill and MCP config with expanded standard placeholders", async () => {
    const generationRoot = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-opencode-view-"))
    roots.push(generationRoot)
    const root = path.join(generationRoot, "plugins", "review")
    await fs.mkdir(path.join(root, "skills", "review"), { recursive: true })
    await fs.mkdir(path.join(root, "bin"), { recursive: true })
    await fs.writeFile(path.join(root, "bin", "server"), "#!/bin/sh\n", { mode: 0o755 })
    await fs.writeFile(path.join(root, "plugin.json"), JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name: "review",
    }))
    await fs.writeFile(path.join(root, "skills", "review", "SKILL.md"), "---\nname: review\ndescription: Review code\n---\n")
    await fs.writeFile(path.join(root, "mcp.json"), JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
      mcpServers: {
        local: { type: "stdio", command: "./bin/server", args: ["${PLUGIN_DATA}/state"], cwd: "${PLUGIN_ROOT}" },
      },
    }))
    const validated = validatePluginTree(await loadAgentPluginTreeFromDirectory(root), root)
    expect(validated.status).toBe("valid")
    if (validated.status !== "valid") return
    const dataRoot = path.join(generationRoot, "data", "review")

    const projection = await openCodeAgentPluginAdapter().project({
      generationRoot,
      plugins: [{ pluginInstanceId: "[\"claxedo\",\"review\"]", artifactDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", plugin: validated.plugin, root, dataRoot }],
    })

    const config = JSON.parse(await fs.readFile(projection.configFile!, "utf8"))
    expect(config.skills.paths).toEqual([path.join(root, "skills")])
    expect(Object.values(config.mcp)).toEqual([{
      type: "local",
      command: ["./bin/server", `${dataRoot}/state`],
      cwd: root,
    }])
  })
})
