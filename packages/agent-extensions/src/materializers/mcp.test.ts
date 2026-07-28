import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { parse as parseJsonc, type ParseError } from "jsonc-parser"
import { materializeStandaloneMcp, removeStandaloneMcpEntries } from "./mcp"

const root = path.join(os.tmpdir(), `agent-extensions-mcp-${randomUUID().slice(0, 8)}`)
const project = path.join(root, "project")

const config = { servers: { docs: { command: "node" } } }

describe("standalone MCP materializer", () => {
  beforeEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
    await fs.mkdir(project, { recursive: true })
  })

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  test("refuses to materialize into an unparseable target config", async () => {
    const target = path.join(project, ".mcp.json")
    await fs.writeFile(target, "{ this is not json")

    await expect(materializeStandaloneMcp({
      config,
      runner: "claude",
      scope: "project",
      ownerId: "docs",
      projectDir: project,
    })).rejects.toThrow("invalid JSON")
    await expect(fs.readFile(target, "utf8")).resolves.toBe("{ this is not json")
  })

  test("refuses to remove entries from an unparseable config instead of deleting it", async () => {
    const target = path.join(project, ".mcp.json")
    await fs.writeFile(target, "{ this is not json")

    await expect(removeStandaloneMcpEntries({
      file: target,
      names: ["docs"],
    })).rejects.toThrow("invalid JSON")
    await expect(fs.readFile(target, "utf8")).resolves.toBe("{ this is not json")
  })

  test("merges with existing servers and removes only its own entries", async () => {
    const target = path.join(project, ".mcp.json")
    await fs.writeFile(target, JSON.stringify({
      mcpServers: { keep: { type: "stdio", command: "python", args: [], env: {} } },
      otherSetting: true,
    }, null, 2))

    const components = await materializeStandaloneMcp({
      config,
      runner: "claude",
      scope: "project",
      ownerId: "docs",
      projectDir: project,
    })
    expect(components).toEqual([{
      runner: "claude",
      component: "docs",
      type: "mcp",
      status: "applied",
      path: target,
    }])
    await expect(fs.readFile(target, "utf8").then(JSON.parse)).resolves.toMatchObject({
      mcpServers: {
        keep: { command: "python" },
        docs: { type: "stdio", command: "node" },
      },
      otherSetting: true,
    })

    await removeStandaloneMcpEntries({ file: target, names: ["docs"] })
    const remaining = JSON.parse(await fs.readFile(target, "utf8")) as Record<string, unknown>
    expect(Object.keys(remaining.mcpServers as Record<string, unknown>)).toEqual(["keep"])
    expect(remaining.otherSetting).toBe(true)
  })

  test("removes opencode entries with jsonc edits, preserving comments and formatting", async () => {
    const target = path.join(project, ".opencode", "opencode.jsonc")
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, [
      "{",
      "  // keep this comment",
      '  "theme": "dark",',
      '  "mcp": {',
      '    "docs": { "type": "local", "command": ["node"], "enabled": true }',
      "  }",
      "}",
      "",
    ].join("\n"))

    await removeStandaloneMcpEntries({ file: target, names: ["docs"] })

    const raw = await fs.readFile(target, "utf8")
    expect(raw).toContain("// keep this comment")
    expect(raw).toContain('"theme": "dark"')
    expect(raw).not.toContain("docs")
  })

  // The embedded opencode engine (packages/opencode/src/config/config.ts's
  // loadConfig) injects a missing $schema with a naive text-replace:
  // `text.replace(/^\s*\{/, '{\n  "$schema": "...",')`. When nothing else
  // follows the injected property (an empty object, or one that only had
  // comments), that leaves a trailing comma right before the closing brace —
  // valid JSONC, invalid strict JSON. This is what live-agent-extensions-
  // materialization.spec.ts's "behavior 3" hits for real once the embedded
  // engine has touched the scratch opencode.jsonc.
  const schemaInjectedTrailingComma = [
    "{",
    '  "$schema": "https://opencode.ai/config.json",',
    "  // kept: hand-written comment must survive the mcp merge",
    "}",
    "",
  ].join("\n")

  test("materializes standalone MCP into an opencode.jsonc left with a trailing comma by the engine's $schema injection", async () => {
    const target = path.join(project, ".opencode", "opencode.jsonc")
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, schemaInjectedTrailingComma)

    const components = await materializeStandaloneMcp({
      config,
      runner: "opencode",
      scope: "project",
      ownerId: "docs",
      projectDir: project,
    })

    expect(components).toEqual([{
      runner: "opencode",
      component: "docs",
      type: "mcp",
      status: "applied",
      path: target,
    }])

    const raw = await fs.readFile(target, "utf8")
    expect(raw).toContain("// kept: hand-written comment must survive the mcp merge")
    expect(raw).toContain('"$schema": "https://opencode.ai/config.json"')

    const errors: ParseError[] = []
    const parsed = parseJsonc(raw, errors, { allowTrailingComma: true })
    expect(errors).toEqual([])
    expect(parsed).toMatchObject({
      $schema: "https://opencode.ai/config.json",
      mcp: { docs: { type: "local", command: ["node"], enabled: true } },
    })
  })

  test("removes opencode entries from an opencode.jsonc left with a trailing comma by the engine's $schema injection", async () => {
    const target = path.join(project, ".opencode", "opencode.jsonc")
    await fs.mkdir(path.dirname(target), { recursive: true })
    // Same shape as the install case, but the mcp entry already exists (as it
    // would after a prior successful install) so uninstall has to parse this
    // file too, not just write to it.
    await fs.writeFile(target, [
      "{",
      '  "$schema": "https://opencode.ai/config.json",',
      "  // kept: hand-written comment must survive the mcp merge",
      '  "theme": "dark",',
      '  "mcp": {',
      '    "docs": { "type": "local", "command": ["node"], "enabled": true }',
      "  },",
      "}",
      "",
    ].join("\n"))

    await removeStandaloneMcpEntries({ file: target, names: ["docs"] })

    const raw = await fs.readFile(target, "utf8")
    expect(raw).toContain("// kept: hand-written comment must survive the mcp merge")
    expect(raw).toContain('"theme": "dark"')
    expect(raw).toContain('"$schema": "https://opencode.ai/config.json"')
    expect(raw).not.toContain("docs")

    const errors: ParseError[] = []
    parseJsonc(raw, errors, { allowTrailingComma: true })
    expect(errors).toEqual([])
  })

  test("keeps plain JSON targets strict: a trailing comma still fails materialize (only opencode.jsonc gets tolerance)", async () => {
    const target = path.join(project, ".mcp.json")
    await fs.writeFile(target, '{\n  "mcpServers": {},\n}\n')

    await expect(materializeStandaloneMcp({
      config,
      runner: "claude",
      scope: "project",
      ownerId: "docs",
      projectDir: project,
    })).rejects.toThrow("invalid JSON")
    await expect(fs.readFile(target, "utf8")).resolves.toBe('{\n  "mcpServers": {},\n}\n')
  })

  test("keeps plain JSON targets strict: a trailing comma still fails remove (only opencode.jsonc gets tolerance)", async () => {
    const target = path.join(project, ".mcp.json")
    await fs.writeFile(target, '{\n  "mcpServers": {},\n}\n')

    await expect(removeStandaloneMcpEntries({
      file: target,
      names: ["docs"],
    })).rejects.toThrow("invalid JSON")
    await expect(fs.readFile(target, "utf8")).resolves.toBe('{\n  "mcpServers": {},\n}\n')
  })

  test("does not recreate a deleted codex config when removing entries", async () => {
    const target = path.join(project, ".codex", "config.toml")

    await removeStandaloneMcpEntries({ file: target, names: ["docs"] })

    await expect(fs.stat(target)).rejects.toThrow()
  })

  test("conflicts instead of overwriting an unowned server with the same name", async () => {
    const target = path.join(project, ".mcp.json")
    await fs.writeFile(target, JSON.stringify({
      mcpServers: { docs: { type: "stdio", command: "someone-else", args: [], env: {} } },
    }, null, 2))

    await expect(materializeStandaloneMcp({
      config,
      runner: "claude",
      scope: "project",
      ownerId: "docs",
      projectDir: project,
    })).rejects.toThrow("already exists")
  })
})
