import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { validatePluginTree } from "./validate-plugin"
import { loadAgentPluginTreeFromDirectory } from "../artifacts/node-tree"

async function validatePluginDirectory(root: string) {
  return validatePluginTree(await loadAgentPluginTreeFromDirectory(root), root)
}

const roots: string[] = []

async function fixture(files: Record<string, string>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-agent-plugin-"))
  roots.push(root)
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, content)
  }
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

describe("validatePluginDirectory", () => {
  test("loads the standard fixed component locations", async () => {
    const root = await fixture({
      "plugin.json": JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "review-tools",
        version: "1.2.3",
      }),
      "skills/review/SKILL.md": "---\nname: review\ndescription: Review code changes\n---\n\n# Review\n",
      "mcp.json": JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: {
          local: { type: "stdio", command: "./bin/server", args: ["${PLUGIN_DATA}/state"] },
          remote: { type: "streamable-http", url: "https://mcp.example.test/api" },
        },
      }),
      "bin/server": "binary",
    })

    const result = await validatePluginDirectory(root)

    expect(result.status).toBe("valid")
    expect(result.plugin?.manifest).toMatchObject({ name: "review-tools", version: "1.2.3" })
    expect(result.plugin?.skills.map((skill) => skill.name)).toEqual(["review"])
    expect(result.plugin?.mcp.status).toBe("valid")
    expect(result.plugin?.mcp.servers.map((server) => server.name)).toEqual(["local", "remote"])
    expect(result.diagnostics).toEqual([])
  })

  test("rejects a fatal manifest error before discovering components", async () => {
    const root = await fixture({
      "plugin.json": JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "Invalid Name",
      }),
      "skills/review/SKILL.md": "---\nname: review\ndescription: Review code\n---\n",
    })

    const result = await validatePluginDirectory(root)

    expect(result.status).toBe("invalid")
    expect(result.plugin).toBeUndefined()
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "manifest_invalid", path: "plugin.json" }),
    ]))
  })

  test("rejects unknown manifest fields", async () => {
    const root = await fixture({
      "plugin.json": JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "review-tools",
        invented: true,
        extensions: "not-an-object",
      }),
    })

    const result = await validatePluginDirectory(root)

    expect(result.status).toBe("invalid")
    expect(result.plugin).toBeUndefined()
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "manifest_invalid", path: "plugin.json#/invented" }),
    ])
  })

  test("rejects malformed extension namespaces", async () => {
    const root = await fixture({
      "plugin.json": JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "review-tools",
        extensions: { "com.example.invalid": "not-an-object" },
      }),
    })

    const result = await validatePluginDirectory(root)

    expect(result.status).toBe("invalid")
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "manifest_invalid", path: "plugin.json" }),
    ])
  })

  test("does not validate data for client extension namespaces it does not implement", async () => {
    const root = await fixture({
      "plugin.json": JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "review-tools",
        extensions: {
          "com.example.unimplemented": { privateShape: ["stays", "opaque"] },
        },
      }),
    })

    const result = await validatePluginDirectory(root)

    expect(result.status).toBe("valid")
    expect(result.plugin?.manifest.extensions).toEqual({
      "com.example.unimplemented": { privateShape: ["stays", "opaque"] },
    })
    expect(result.diagnostics).toEqual([])
  })

  test("invalid mcp configuration disables MCP without hiding valid skills", async () => {
    const root = await fixture({
      "plugin.json": JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "review-tools",
      }),
      "skills/review/SKILL.md": "---\nname: review\ndescription: Review code\n---\n",
      "mcp.json": JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: [],
      }),
    })

    const result = await validatePluginDirectory(root)

    expect(result.status).toBe("valid")
    expect(result.plugin?.skills.map((skill) => skill.name)).toEqual(["review"])
    expect(result.plugin?.mcp).toEqual({ status: "invalid", servers: [] })
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "mcp_invalid", path: "mcp.json" }),
    ]))
  })

  test("skips one invalid MCP server while preserving valid siblings", async () => {
    const root = await fixture({
      "plugin.json": JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "review-tools",
      }),
      "mcp.json": JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: {
          valid: { type: "streamable-http", url: "https://mcp.example.test/api" },
          insecure: { type: "streamable-http", url: "http://mcp.example.test/api" },
          secretEnv: { type: "stdio", command: "server", env: { PLUGIN_DATA: "bad" } },
        },
      }),
    })

    const result = await validatePluginDirectory(root)

    expect(result.plugin?.mcp).toMatchObject({ status: "valid" })
    expect(result.plugin?.mcp.servers.map((server) => server.name)).toEqual(["valid"])
    expect(result.diagnostics.filter((item) => item.code === "mcp_server_invalid")).toHaveLength(2)
  })

  test("applies the narrow skill failure boundary to an escaping symlink", async () => {
    const outside = await fixture({
      "SKILL.md": "---\nname: stolen\ndescription: Escaped skill\n---\n",
    })
    const root = await fixture({
      "plugin.json": JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "review-tools",
      }),
      "skills/valid/SKILL.md": "---\nname: valid\ndescription: Valid skill\n---\n",
    })
    await fs.symlink(outside, path.join(root, "skills", "escaped"), "dir")

    const result = await validatePluginDirectory(root)

    expect(result.status).toBe("valid")
    expect(result.plugin?.skills.map((skill) => skill.name)).toEqual(["valid"])
    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "skill_path_escape", path: "skills/escaped/SKILL.md" }),
    ]))
  })

  test("parses Agent Skills frontmatter as YAML rather than a line-based approximation", async () => {
    const root = await fixture({
      "plugin.json": JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "review-tools",
      }),
      "skills/review/SKILL.md": [
        "---",
        "name: review",
        "description: >-",
        "  Review: changes carefully",
        "---",
        "",
        "# Review",
      ].join("\n"),
    })

    const result = await validatePluginDirectory(root)

    expect(result.plugin?.skills).toEqual([
      expect.objectContaining({ name: "review", description: "Review: changes carefully" }),
    ])
  })

  test("skips skills that violate Agent Skills name and metadata constraints", async () => {
    const root = await fixture({
      "plugin.json": JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "review-tools",
      }),
      "skills/review/SKILL.md": "---\nname: different\ndescription: Review code\n---\n",
      "skills/valid/SKILL.md": "---\nname: valid\ndescription: Valid skill\nmetadata:\n  count: 2\n---\n",
    })

    const result = await validatePluginDirectory(root)

    expect(result.plugin?.skills).toEqual([])
    expect(result.diagnostics.filter((item) => item.code === "skill_invalid")).toHaveLength(2)
  })

  test("enforces executable tokens and the full IP loopback range for MCP servers", async () => {
    const root = await fixture({
      "plugin.json": JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
        name: "review-tools",
      }),
      "mcp.json": JSON.stringify({
        $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: {
          loopback: { type: "streamable-http", url: "http://127.42.0.1/mcp" },
          shell: { type: "stdio", command: "server --unsafe" },
          externalHttp: { type: "streamable-http", url: "http://192.0.2.2/mcp" },
        },
      }),
    })

    const result = await validatePluginDirectory(root)

    expect(result.plugin?.mcp.servers.map((server) => server.name)).toEqual(["loopback"])
    expect(result.diagnostics.filter((item) => item.code === "mcp_server_invalid")).toHaveLength(2)
  })
})
