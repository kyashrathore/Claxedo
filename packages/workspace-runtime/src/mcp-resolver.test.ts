import { realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { afterAll, beforeEach, describe, expect, test } from "bun:test"

const root = path.join(realpathSync(os.tmpdir()), `mcp-resolver-test-${randomUUID().slice(0, 8)}`)
const prev = process.env.WORKSPACE_RUNTIME_DATA_DIR
process.env.WORKSPACE_RUNTIME_DATA_DIR = root

const mod = await import("./mcp-resolver")

describe("mcp resolver", () => {
  beforeEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
    process.env.WORKSPACE_RUNTIME_DATA_DIR = prev
  })

  test("loads no app-managed MCP defaults", async () => {
    const state = await mod.loadManagedMcpState(4310)

    expect(state.port).toBe(4310)
    expect(state.overrides).toEqual({})
    expect(state.defaults).toEqual({})
    expect(state.servers).toEqual({})
  })

  test("rejects overrides for unmanaged MCP servers", async () => {
    await expect(mod.setManagedMcpOverride("local-tool", "codex", false, 4310)).rejects.toThrow(
      "Unknown managed MCP server: local-tool",
    )
  })

  test("resolves user-defined MCP without app-managed servers", async () => {
    const state = await mod.loadManagedMcpState(4310)
    const out = mod.resolveEffectiveMcp({
      state,
      agent: "claude",
      control: "generated-config",
      userMcp: {
        remote: {
          type: "remote",
          url: "https://mcp.example.com",
          headers: { Authorization: "Bearer test" },
        },
      },
      strict: true,
    })

    expect(Object.keys(out.status)).toEqual([])
    expect(out.mcp.remote).toMatchObject({
      transport: "remote",
      url: "https://mcp.example.com",
    })
  })

  test("mcpControl is provider-neutral", () => {
    expect(mod.mcpControl("claude")).toBe("managed")
    expect(mod.mcpControl("gemini")).toBe("generated-config")
  })
})
