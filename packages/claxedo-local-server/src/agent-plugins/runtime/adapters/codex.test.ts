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
  test("generates a Codex local marketplace over the retained generation", async () => {
    const generationRoot = await temporary("claxedo-codex-generation-")
    const codexHome = await temporary("claxedo-codex-home-")
    const retainedRoot = path.join(generationRoot, "plugins", "review-retained")
    const adapter = codexAgentPluginAdapter({ codexHome })
    const projected = await adapter.project({
      generationRoot,
      plugins: [await plugin(retainedRoot, "claxedo-review")],
    })

    const projectedRoot = projected.pluginRoots[0]!.root
    expect(JSON.parse(await fs.readFile(path.join(generationRoot, ".agents", "plugins", "marketplace.json"), "utf8")))
      .toEqual({
        name: "claxedo-agent-plugins",
        plugins: [{
          name: "review",
          source: {
            source: "local",
            path: `./${path.relative(generationRoot, projectedRoot).split(path.sep).join("/")}`,
          },
        }],
      })
    expect(JSON.parse(await fs.readFile(projected.configFile!, "utf8"))).toEqual({
      marketplace: {
        name: "claxedo-agent-plugins",
        source: generationRoot,
      },
      plugins: ["review@claxedo-agent-plugins"],
    })
    expect(projected.pluginRoots).toEqual([{
      pluginInstanceId: "claxedo-review",
      root: projectedRoot,
      dataRoot: path.join(generationRoot, "plugins", "data", "claxedo-review"),
    }])
    expect(projectedRoot.startsWith(path.join(generationRoot, "harnesses", "codex", "plugins"))).toBe(true)
    expect(projectedRoot).not.toBe(retainedRoot)
    expect(await fs.readFile(path.join(codexHome, "config.toml"), "utf8")).toBe([
      "# BEGIN CLAXEDO AGENT PLUGINS",
      "[marketplaces.claxedo-agent-plugins]",
      'source_type = "local"',
      `source = ${JSON.stringify(generationRoot)}`,
      "",
      '[plugins."review@claxedo-agent-plugins"]',
      "enabled = true",
      "",
      "# END CLAXEDO AGENT PLUGINS",
      "",
    ].join("\n"))
    await expect(fs.stat(path.join(codexHome, "claxedo-agent-plugins.config.toml")))
      .rejects.toMatchObject({ code: "ENOENT" })
    await expect(fs.readFile(path.join(
      codexHome,
      "plugins",
      "cache",
      "claxedo-agent-plugins",
      "review",
      "1.0.0",
      "plugin.json",
    ), "utf8")).resolves.toContain('"name":"review"')
    expect(JSON.parse(await fs.readFile(path.join(
      codexHome,
      "plugins",
      "cache",
      "claxedo-agent-plugins",
      "review",
      "1.0.0",
      ".mcp.json",
    ), "utf8"))).toEqual({
      mcpServers: {
        review: {
          type: "http",
          url: "https://review.example/mcp",
        },
      },
    })
    expect(JSON.parse(await fs.readFile(path.join(
      codexHome,
      "plugins",
      "cache",
      "claxedo-agent-plugins",
      "review",
      "1.0.0",
      ".codex-plugin",
      "plugin.json",
    ), "utf8"))).toEqual({
      name: "review",
      version: "1.0.0",
      mcpServers: "./.mcp.json",
    })

    const disabled = await adapter.project({ generationRoot, plugins: [] })
    expect(JSON.parse(await fs.readFile(disabled.configFile!, "utf8"))).toEqual({})
    expect(await fs.readFile(path.join(codexHome, "config.toml"), "utf8")).toBe("")
  })

  test("preserves unmanaged Codex config while replacing its owned activation block", async () => {
    const generationRoot = await temporary("claxedo-codex-generation-")
    const codexHome = await temporary("claxedo-codex-home-")
    await fs.writeFile(path.join(codexHome, "config.toml"), [
      'model = "gpt-5"',
      "",
      "# BEGIN CLAXEDO AGENT PLUGINS",
      '[plugins."old@claxedo-agent-plugins"]',
      "enabled = true",
      "",
      "# END CLAXEDO AGENT PLUGINS",
      "",
      "[features]",
      "web_search = true",
      "",
    ].join("\n"))

    await codexAgentPluginAdapter({ codexHome }).project({
      generationRoot,
      plugins: [await plugin(path.join(generationRoot, "plugins", "review"), "claxedo-review")],
    })

    expect(await fs.readFile(path.join(codexHome, "config.toml"), "utf8")).toBe([
      'model = "gpt-5"',
      "",
      "[features]",
      "web_search = true",
      "",
      "# BEGIN CLAXEDO AGENT PLUGINS",
      "[marketplaces.claxedo-agent-plugins]",
      'source_type = "local"',
      `source = ${JSON.stringify(generationRoot)}`,
      "",
      '[plugins."review@claxedo-agent-plugins"]',
      "enabled = true",
      "",
      "# END CLAXEDO AGENT PLUGINS",
      "",
    ].join("\n"))
  })

  test("fails explicitly when Codex cannot represent two active same-name plugins", async () => {
    const generationRoot = await temporary("claxedo-codex-generation-")
    const codexHome = await temporary("claxedo-codex-home-")
    await expect(codexAgentPluginAdapter({ codexHome }).project({
      generationRoot,
      plugins: [
        await plugin(path.join(generationRoot, "plugins", "one"), "personal-review"),
        await plugin(path.join(generationRoot, "plugins", "two"), "org-review"),
      ],
    })).rejects.toThrow("cannot activate two plugins named")
  })
})
