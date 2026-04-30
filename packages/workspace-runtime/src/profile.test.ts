import { describe, expect, test } from "bun:test"
import { workspaceCapabilities } from "./capabilities"
import { harnessMode, profileFromEnv, workspaceProfile } from "./profile"

describe("workspace profile helpers", () => {
  test("normalizes harness mode input", () => {
    expect(harnessMode("central")).toBe("central")
    expect(harnessMode("workspace")).toBe("workspace")
    expect(harnessMode("weird")).toBe("workspace")
    expect(harnessMode(undefined)).toBe("workspace")
  })

  test("derives workspace profile from harness mode", () => {
    expect(workspaceProfile("workspace")).toBe("full")
    expect(workspaceProfile("central")).toBe("minimal")
  })

  test("reads profile from env", () => {
    expect(profileFromEnv({ CLAXEDO_HARNESS_MODE: "workspace" })).toBe("full")
    expect(profileFromEnv({ CLAXEDO_HARNESS_MODE: "central" })).toBe("minimal")
    expect(profileFromEnv({})).toBe("full")
  })

  test("marks full and minimal capabilities distinctly", () => {
    expect(workspaceCapabilities("full")).toEqual({
      profile: "full",
      session_host: true,
      runner_host: true,
      command: true,
      pty: true,
      process: true,
      diff: true,
      config: true,
      mcp: true,
      lsp: true,
      vcs: true,
    })

    expect(workspaceCapabilities("minimal")).toEqual({
      profile: "minimal",
      session_host: false,
      runner_host: false,
      command: false,
      pty: true,
      process: true,
      diff: true,
      config: true,
      mcp: false,
      lsp: false,
      vcs: false,
    })
  })
})
