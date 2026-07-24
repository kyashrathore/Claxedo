import { describe, expect, test } from "bun:test"
import { workspaceCapabilities } from "./capabilities"
import { workspaceProfile } from "./profile"

describe("workspace profile helpers", () => {
  test("uses the single workspace profile", () => {
    expect(workspaceProfile()).toBe("workspace")
  })

  test("marks enabled capabilities without changing workspace profile", () => {
    expect(workspaceCapabilities(true)).toEqual({
      api_version: 2,
      profile: "workspace",
      workspace_harness_enabled: true,
      session_host: true,
      harness_host: true,
      command: true,
      pty: true,
      process: true,
      process_observer: true,
      diff: true,
      config: true,
      mcp: true,
      lsp: true,
      vcs: true,
    })

    expect(workspaceCapabilities(false)).toEqual({
      api_version: 2,
      profile: "workspace",

      workspace_harness_enabled: false,
      session_host: false,
      harness_host: false,
      command: false,
      pty: true,
      process: true,
      process_observer: true,
      diff: true,
      config: true,
      mcp: false,
      lsp: false,
      vcs: false,
    })
  })
})
