import { describe, expect, it } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { assertTarget, resolveWorkspacePath, workspaceDir, workspaceId } from "./target"

describe("workspaceDir", () => {
  it("rejects multi-directory configuration", () => {
    expect(() =>
      workspaceDir({ WORKSPACE_RUNTIME_DIRECTORY: "/tmp/a,/tmp/b" } as NodeJS.ProcessEnv)
    ).toThrow("WORKSPACE_RUNTIME_DIRECTORY must contain exactly one directory")
  })

  it("resolves a single configured directory", () => {
    expect(workspaceDir({ WORKSPACE_RUNTIME_DIRECTORY: "./tmp/demo" } as NodeJS.ProcessEnv)).toContain("/tmp/demo")
    expect(workspaceDir({ WORKSPACE_RUNTIME_DIRECTORY: "./tmp/demo" } as NodeJS.ProcessEnv)).toContain("/tmp/demo")
  })
})

describe("assertTarget", () => {
  it("accepts the configured directory", () => {
    expect(assertTarget("/tmp/demo", { WORKSPACE_RUNTIME_DIRECTORY: "/tmp/demo" } as NodeJS.ProcessEnv)).toBe("/tmp/demo")
  })

  it("accepts the configured synthetic workspace directory", () => {
    expect(assertTarget(
      "workspace:ws_123",
      {
        WORKSPACE_RUNTIME_DIRECTORY: "/tmp/demo",
        WORKSPACE_RUNTIME_WORKSPACE_ID: "ws_123",
      } as NodeJS.ProcessEnv,
    )).toBe("/tmp/demo")
  })

  it("rejects mismatched directories", () => {
    expect(() =>
      assertTarget("/tmp/other", { WORKSPACE_RUNTIME_DIRECTORY: "/tmp/demo" } as NodeJS.ProcessEnv)
    ).toThrow("workspace-runtime is pinned to /tmp/demo")
  })
})

describe("resolveWorkspacePath", () => {
  it("keeps relative paths inside the workspace", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-runtime-target-"))
    try {
      await fs.mkdir(path.join(tmp, "src"))
      await fs.writeFile(path.join(tmp, "src", "index.ts"), "")

      expect(await resolveWorkspacePath(tmp, "src/index.ts")).toBe(path.join(tmp, "src", "index.ts"))
      await expect(resolveWorkspacePath(tmp, path.join(tmp, "src", "index.ts"))).rejects.toThrow("workspace path must be relative")
      await expect(resolveWorkspacePath(tmp, "../index.ts")).rejects.toThrow("workspace path escapes configured directory")
      await expect(resolveWorkspacePath(tmp, "bad\u0000path")).rejects.toThrow("workspace path cannot contain null bytes")
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
    }
  })

  it("rejects symlink realpath escapes", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-runtime-target-"))
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-runtime-target-outside-"))
    try {
      await fs.writeFile(path.join(outside, "secret.txt"), "secret")
      await fs.symlink(outside, path.join(tmp, "linked-out"))

      await expect(resolveWorkspacePath(tmp, "linked-out/secret.txt")).rejects.toThrow(
        "workspace path escapes configured directory",
      )
    } finally {
      await fs.rm(tmp, { recursive: true, force: true })
      await fs.rm(outside, { recursive: true, force: true })
    }
  })
})

describe("workspaceId", () => {
  it("stays stable for process env fallback", () => {
    const a = workspaceId()
    const b = workspaceId()
    expect(a).toBe(b)
  })

  it("prefers the configured id", () => {
    expect(workspaceId({ WORKSPACE_RUNTIME_WORKSPACE_ID: "wr_123" } as NodeJS.ProcessEnv)).toBe("wr_123")
    expect(workspaceId({ WORKSPACE_RUNTIME_WORKSPACE_ID: "wr_123" } as NodeJS.ProcessEnv)).toBe("wr_123")
  })
})
