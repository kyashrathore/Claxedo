import { describe, expect, it } from "bun:test"
import { assertTarget, workspaceDir, workspaceId } from "./target"

describe("workspaceDir", () => {
  it("rejects multi-directory configuration", () => {
    expect(() =>
      workspaceDir({ CLAXEDO_WR_DIRECTORY: "/tmp/a,/tmp/b" } as NodeJS.ProcessEnv)
    ).toThrow("CLAXEDO_WR_DIRECTORY must contain exactly one directory")
  })

  it("resolves a single configured directory", () => {
    expect(workspaceDir({ CLAXEDO_WR_DIRECTORY: "./tmp/demo" } as NodeJS.ProcessEnv)).toContain("/tmp/demo")
  })
})

describe("assertTarget", () => {
  it("accepts the configured directory", () => {
    expect(assertTarget("/tmp/demo", { CLAXEDO_WR_DIRECTORY: "/tmp/demo" } as NodeJS.ProcessEnv)).toBe("/tmp/demo")
  })

  it("rejects mismatched directories", () => {
    expect(() =>
      assertTarget("/tmp/other", { CLAXEDO_WR_DIRECTORY: "/tmp/demo" } as NodeJS.ProcessEnv)
    ).toThrow("workspace-runtime is pinned to /tmp/demo")
  })
})

describe("workspaceId", () => {
  it("stays stable for process env fallback", () => {
    const a = workspaceId()
    const b = workspaceId()
    expect(a).toBe(b)
  })

  it("prefers the configured id", () => {
    expect(workspaceId({ CLAXEDO_WR_WORKSPACE_ID: "wr_123" } as NodeJS.ProcessEnv)).toBe("wr_123")
  })
})
