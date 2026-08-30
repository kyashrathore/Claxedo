import { realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import {
  loadManagedMcpState,
  mcpControl,
  resolveEffectiveMcp,
  harnessAgent,
} from "./mcp-resolver"

const root = path.join(realpathSync(os.tmpdir()), `agent-sdk-mcp-resolver-test-${randomUUID().slice(0, 8)}`)
const prev = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

describe("mcp resolver", () => {
  beforeEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
    if (prev === undefined) delete process.env.CLAXEDO_DATA_DIR
    else process.env.CLAXEDO_DATA_DIR = prev
  })

  test("keeps managed MCP defaults explicitly empty while preserving user MCP", async () => {
    const state = await loadManagedMcpState(4310)
    const resolved = resolveEffectiveMcp({
      state,
      agent: "opencode",
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

    expect(state.defaults).toEqual({})
    expect(state.servers).toEqual({})
    expect(resolved.status).toEqual({})
    expect(resolved.mcp.remote).toMatchObject({
      transport: "remote",
      url: "https://mcp.example.com",
    })
  })

  test("does not derive MCP control from ambient OpenCode URL", () => {
    const value = process.env.OPENCODE_URL
    process.env.OPENCODE_URL = "http://ambient-opencode.test"
    try {
      expect(mcpControl("opencode")).toBe("managed")
      expect(mcpControl("opencode", { externalOpencode: true })).toBe("external-unmanaged")
    } finally {
      if (value === undefined) delete process.env.OPENCODE_URL
      else process.env.OPENCODE_URL = value
    }
  })

  test("maps harness identities to MCP agents through harness metadata", () => {
    expect(harnessAgent("claude")).toBe("claude")
    expect(harnessAgent("codex")).toBe("codex")
    expect(harnessAgent("cursor")).toBe("cursor")
    expect(harnessAgent("opencode")).toBe("opencode")
    expect(harnessAgent("acp:openclaw")).toBeNull()
  })
})
