import { describe, expect, test } from "vitest"
import fs from "fs"
import { claxedoWorkspaceRuntimeEntry, workspaceRuntimeVersion } from "./workspace-runtime-startup"

describe("workspace-runtime startup contract", () => {
  test("resolves a semver runtime version for image keying", () => {
    expect(workspaceRuntimeVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })

  test("the claxedo host entry exists and is the bundler input", () => {
    const entry = claxedoWorkspaceRuntimeEntry()
    expect(entry.endsWith("hosts/workspace-runtime/host-entry.ts")).toBe(true)
    expect(fs.existsSync(entry)).toBe(true)
  })
})
