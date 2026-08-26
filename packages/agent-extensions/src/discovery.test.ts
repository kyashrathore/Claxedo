import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { discoverAgentExtensionComponents } from "./discovery"

const root = path.join(os.tmpdir(), `agent-extension-discovery-${randomUUID().slice(0, 8)}`)

describe("discoverAgentExtensionComponents", () => {
  beforeEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
    await fs.mkdir(root, { recursive: true })
  })

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  test("discovers Eve-like conventional component directories", async () => {
    await fs.mkdir(path.join(root, "skills", "review"), { recursive: true })
    await fs.mkdir(path.join(root, "mcp"), { recursive: true })
    await fs.mkdir(path.join(root, "plugins", "cursor", "notes"), { recursive: true })
    await fs.mkdir(path.join(root, "hooks"), { recursive: true })
    await fs.writeFile(path.join(root, "skills", "review", "SKILL.md"), "review")
    await fs.writeFile(path.join(root, "mcp", "docs.json"), JSON.stringify({ servers: { docs: { command: "node" } } }))
    await fs.writeFile(path.join(root, "plugins", "cursor", "notes", "plugin.json"), JSON.stringify({ name: "notes" }))
    await fs.writeFile(path.join(root, "hooks", "claude.json"), JSON.stringify({ hooks: {} }))

    await expect(discoverAgentExtensionComponents(root)).resolves.toEqual([
      { type: "skill", name: "review", path: path.join(root, "skills", "review") },
      { type: "mcp", name: "docs", path: path.join(root, "mcp", "docs.json") },
      { type: "plugin", runner: "cursor", name: "notes", path: path.join(root, "plugins", "cursor", "notes") },
      { type: "hook", runner: "claude", name: "claude", path: path.join(root, "hooks", "claude.json") },
    ])
  })

  test("keeps legacy root-level package shapes discoverable", async () => {
    await fs.writeFile(path.join(root, "SKILL.md"), "legacy skill")
    await fs.writeFile(path.join(root, "mcp.json"), JSON.stringify({ servers: { docs: { command: "node" } } }))

    await expect(discoverAgentExtensionComponents(root)).resolves.toEqual([
      { type: "skill", name: path.basename(root), path: root },
      { type: "mcp", name: path.basename(root), path: path.join(root, "mcp.json") },
    ])
  })

  test("refuses a manifest name that escapes the plugin directory (H4)", async () => {
    // Conventional single-plugin shape: this is the branch that reads
    // `name` out of repo-controlled JSON. Nested directories take their name
    // from readdir, which can never contain separators.
    await fs.mkdir(path.join(root, "plugins", "cursor"), { recursive: true })
    await fs.writeFile(
      path.join(root, "plugins", "cursor", "plugin.json"),
      JSON.stringify({ name: "../../.ssh" }),
    )

    await expect(discoverAgentExtensionComponents(root)).rejects.toThrow("single safe path segment")
  })
})
