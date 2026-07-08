import { describe, expect, test } from "vitest"
import { claxedoMcpMode, claxedoMcpReadOnly } from "./tool-policy"

describe("MCP tool policy", () => {
  test("defaults to full-control mode for backwards compatibility", () => {
    expect(claxedoMcpMode({})).toBe("full")
    expect(claxedoMcpReadOnly({})).toBe(false)
  })

  test("supports explicit read-only mode env", () => {
    expect(claxedoMcpMode({ CLAXEDO_MCP_MODE: "read-only" })).toBe("read-only")
    expect(claxedoMcpReadOnly({ CLAXEDO_MCP_MODE: "read-only" })).toBe(true)
  })

  test("supports boolean read-only env", () => {
    expect(claxedoMcpMode({ CLAXEDO_MCP_READ_ONLY: "1" })).toBe("read-only")
    expect(claxedoMcpMode({ CLAXEDO_MCP_READ_ONLY: "true" })).toBe("read-only")
    expect(claxedoMcpMode({ CLAXEDO_MCP_READ_ONLY: "yes" })).toBe("read-only")
  })
})
