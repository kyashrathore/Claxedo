import { describe, expect, test } from "vitest"
import {
  assertCloudWorkspaceLifecycleApproval,
  claxedoMcpMode,
  claxedoMcpReadOnly,
  cloudWorkspaceLifecycleApprovalRequired,
} from "./tool-policy"

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

  test("requires explicit approval for consequential workspace lifecycle actions", () => {
    expect(cloudWorkspaceLifecycleApprovalRequired("stop")).toBe(false)
    expect(cloudWorkspaceLifecycleApprovalRequired("restore")).toBe(true)
    expect(cloudWorkspaceLifecycleApprovalRequired("replace")).toBe(true)
    expect(cloudWorkspaceLifecycleApprovalRequired("cleanup")).toBe(true)
    expect(cloudWorkspaceLifecycleApprovalRequired("destroy")).toBe(true)
    expect(() => assertCloudWorkspaceLifecycleApproval("destroy", false)).toThrow(/Explicit approval/)
    expect(() => assertCloudWorkspaceLifecycleApproval("destroy", true)).not.toThrow()
  })
})
