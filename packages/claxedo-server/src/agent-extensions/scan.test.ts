import { afterAll, beforeEach, describe, expect, test } from "vitest"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { detachDiscoveredAgentExtensionConfig, scanExistingAgentExtensionConfig, setDiscoveredAgentExtensionConfigState } from "./scan"

const root = path.join(os.tmpdir(), `agent-extensions-scan-${randomUUID().slice(0, 8)}`)

async function touch(file: string) {
  await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true })
  await fs.writeFile(path.join(root, file), "")
}

async function mkdir(dir: string) {
  await fs.mkdir(path.join(root, dir), { recursive: true })
}

describe("Agent Extension config scan", () => {
  beforeEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
    await fs.mkdir(root, { recursive: true })
  })

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  test("discovers existing runner config without modifying it", async () => {
    await Promise.all([
      mkdir(".claude"),
      mkdir(".codex"),
      mkdir(".cursor"),
      mkdir(".opencode"),
      mkdir(".agents/skills"),
      touch("AGENTS.md"),
      touch("CLAUDE.md"),
      touch("opencode.json"),
      touch("mcp.json"),
      touch(".vscode/mcp.json"),
    ])
    const before = await Promise.all([
      fs.stat(path.join(root, "AGENTS.md")),
      fs.stat(path.join(root, ".agents/skills")),
    ])

    await expect(scanExistingAgentExtensionConfig(root)).resolves.toEqual([
      { path: ".claude", kind: "harness-config-dir", state: "discovered" },
      { path: ".codex", kind: "harness-config-dir", state: "discovered" },
      { path: ".cursor", kind: "harness-config-dir", state: "discovered" },
      { path: ".opencode", kind: "harness-config-dir", state: "discovered" },
      { path: ".agents/skills", kind: "skills-dir", state: "discovered" },
      { path: "AGENTS.md", kind: "instruction-file", state: "discovered" },
      { path: "CLAUDE.md", kind: "instruction-file", state: "discovered" },
      { path: "opencode.json", kind: "opencode-config", state: "discovered" },
      { path: "mcp.json", kind: "mcp-config", state: "discovered" },
      { path: ".vscode/mcp.json", kind: "mcp-config", state: "discovered" },
    ])

    const after = await Promise.all([
      fs.stat(path.join(root, "AGENTS.md")),
      fs.stat(path.join(root, ".agents/skills")),
    ])
    expect(after.map((item) => item.mtimeMs)).toEqual(before.map((item) => item.mtimeMs))
  })

  test("ignores missing candidates", async () => {
    await mkdir(".cursor")

    await expect(scanExistingAgentExtensionConfig(root)).resolves.toEqual([
      { path: ".cursor", kind: "harness-config-dir", state: "discovered" },
    ])
  })

  test("tracks adopted and ignored discovery states without modifying runner files", async () => {
    await Promise.all([
      mkdir(".cursor"),
      touch("AGENTS.md"),
    ])
    const before = await fs.stat(path.join(root, "AGENTS.md"))

    await expect(setDiscoveredAgentExtensionConfigState({
      root,
      path: "AGENTS.md",
      state: "adopted",
      now: 100,
    })).resolves.toEqual({
      path: "AGENTS.md",
      kind: "instruction-file",
      state: "adopted",
    })
    await expect(setDiscoveredAgentExtensionConfigState({
      root,
      path: ".cursor",
      state: "ignored",
      now: 200,
    })).resolves.toEqual({
      path: ".cursor",
      kind: "harness-config-dir",
      state: "ignored",
    })

    await expect(scanExistingAgentExtensionConfig(root)).resolves.toEqual([
      { path: ".cursor", kind: "harness-config-dir", state: "ignored" },
      { path: "AGENTS.md", kind: "instruction-file", state: "adopted" },
    ])
    expect((await fs.stat(path.join(root, "AGENTS.md"))).mtimeMs).toBe(before.mtimeMs)

    await expect(detachDiscoveredAgentExtensionConfig({
      root,
      path: "AGENTS.md",
    })).resolves.toEqual({
      path: "AGENTS.md",
      kind: "instruction-file",
      state: "discovered",
    })
    await expect(scanExistingAgentExtensionConfig(root)).resolves.toEqual([
      { path: ".cursor", kind: "harness-config-dir", state: "ignored" },
      { path: "AGENTS.md", kind: "instruction-file", state: "discovered" },
    ])
  })

  test("rejects unknown or missing discovery state paths", async () => {
    await expect(setDiscoveredAgentExtensionConfigState({
      root,
      path: "../AGENTS.md",
      state: "adopted",
    })).rejects.toThrow("unknown Agent Extension discovery path")
    await expect(setDiscoveredAgentExtensionConfigState({
      root,
      path: "AGENTS.md",
      state: "adopted",
    })).rejects.toThrow("Agent Extension discovery path does not exist")
  })
})
