import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { discoverAgentExtensionPackage } from "./manifest"

const root = path.join(os.tmpdir(), `agent-extensions-package-${randomUUID().slice(0, 8)}`)

async function write(file: string, content: string) {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await fs.writeFile(path.join(root, file), content)
}

describe("@claxedo/agent-extensions manifest", () => {
  beforeEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
    await fs.mkdir(root, { recursive: true })
  })

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  test("discovers standalone skill and MCP packages", async () => {
    await write("review/SKILL.md", "review")
    await write("docs/mcp.json", JSON.stringify({ servers: { docs: { command: "node" } } }))

    await expect(discoverAgentExtensionPackage(path.join(root, "review"))).resolves.toEqual({
      type: "standalone-skill",
      name: "review",
      skill_path: "SKILL.md",
    })
    await expect(discoverAgentExtensionPackage(path.join(root, "docs"))).resolves.toMatchObject({
      type: "standalone-mcp",
      name: "docs",
      config_path: "mcp.json",
    })
  })

  test("throws when catalog and package manifests both exist", async () => {
    await write(".cursor-plugin/marketplace.json", JSON.stringify({ packages: [] }))
    await write(".cursor-plugin/plugin.json", JSON.stringify({ name: "review" }))

    await expect(discoverAgentExtensionPackage(root)).rejects.toThrow("ambiguous")
  })

  test("selects marketplace manifests in Cursor, Codex, Claude order", async () => {
    await write(".agents/plugins/marketplace.json", JSON.stringify({ packages: [] }))
    await write(".claude-plugin/marketplace.json", JSON.stringify({ packages: [] }))

    await expect(discoverAgentExtensionPackage(root)).resolves.toMatchObject({
      type: "marketplace",
      runner: "codex",
      manifest_path: ".agents/plugins/marketplace.json",
    })

    await write(".cursor-plugin/marketplace.json", JSON.stringify({ packages: [] }))

    await expect(discoverAgentExtensionPackage(root)).resolves.toMatchObject({
      type: "marketplace",
      runner: "cursor",
      manifest_path: ".cursor-plugin/marketplace.json",
    })
  })

  test("requires matching names across multiple plugin manifests", async () => {
    await write(".claude-plugin/plugin.json", JSON.stringify({ name: "review" }))
    await write(".codex-plugin/plugin.json", JSON.stringify({ name: "review" }))

    await expect(discoverAgentExtensionPackage(root)).resolves.toMatchObject({
      type: "native-plugin",
      name: "review",
      manifests: [
        { runner: "claude", path: ".claude-plugin/plugin.json" },
        { runner: "codex", path: ".codex-plugin/plugin.json" },
      ],
    })

    await write(".cursor-plugin/plugin.json", JSON.stringify({ name: "other" }))

    await expect(discoverAgentExtensionPackage(root)).rejects.toThrow("must use the same name")
  })

  test("rejects catalog entries outside local non-empty package directories", async () => {
    await write(".cursor-plugin/marketplace.json", JSON.stringify({
      packages: [
        { name: "remote", path: "https://github.com/acme/remote" },
      ],
    }))

    await expect(discoverAgentExtensionPackage(root)).rejects.toThrow("Catalog entries must stay")

    await write(".cursor-plugin/marketplace.json", JSON.stringify({
      packages: [
        { name: "escape", path: "../escape" },
      ],
    }))

    await expect(discoverAgentExtensionPackage(root)).rejects.toMatchObject({
      name: "AgentExtensionManifestError",
      message: "catalog entry path must stay inside the package root",
    })

    await write(".cursor-plugin/marketplace.json", JSON.stringify({
      packages: [
        { name: "empty", path: "packages/empty" },
      ],
    }))
    await fs.mkdir(path.join(root, "packages/empty"), { recursive: true })

    await expect(discoverAgentExtensionPackage(root)).rejects.toThrow("non-empty local directory")
  })
})
