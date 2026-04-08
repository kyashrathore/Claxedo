import fs from "fs/promises"
import path from "path"
import { randomUUID } from "crypto"
import { afterAll, beforeEach, describe, expect, test } from "bun:test"

const root = path.join(process.cwd(), `.tmp-mcp-resolver-test-${randomUUID().slice(0, 8)}`)
const prev = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const mod = await import("./mcp-resolver")

describe("mcp resolver", () => {
  beforeEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
    process.env.CLAXEDO_DATA_DIR = prev
  })

  test("loads managed MCP defaults from source code", async () => {
    const state = await mod.loadManagedMcpState(4310)

    expect(state.port).toBe(4310)
    expect(state.overrides).toEqual({})
    expect(state.servers["claxedo-mcp"]).toEqual({
      opencode: true,
      claude: true,
      codex: true,
      gemini: true,
      cursor: true,
    })
  })

  test("stores only sparse overrides when a user changes settings", async () => {
    await mod.setManagedMcpOverride("claxedo-mcp", "codex", false, 4310)
    const state = await mod.loadManagedMcpState()

    expect(state.port).toBe(4310)
    expect(state.overrides).toEqual({
      "claxedo-mcp": {
        codex: false,
      },
    })
    expect(state.servers["claxedo-mcp"].codex).toBe(false)
    expect(state.servers["claxedo-mcp"].claude).toBe(true)
  })

  test("clears overrides when the user returns to the default", async () => {
    await mod.setManagedMcpOverride("claxedo-mcp", "codex", false, 4310)
    await mod.setManagedMcpOverride("claxedo-mcp", "codex", true, 4310)
    const state = await mod.loadManagedMcpState()

    expect(state.overrides).toEqual({})
    expect(state.servers["claxedo-mcp"].codex).toBe(true)
  })

  test("merges managed and user-defined MCP into one effective set", async () => {
    const state = await mod.loadManagedMcpState(4310)
    const out = mod.resolveEffectiveMcp({
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

    expect(out.mcp["claxedo-mcp"]).toBeDefined()
    expect(out.mcp.remote).toMatchObject({
      transport: "remote",
      url: "https://mcp.example.com",
    })
  })
})
