import { describe, expect, test } from "vitest"
import fs from "fs"
import path from "path"
import { claxedoWorkspaceRuntimeEntry, workspaceRuntimeVersion } from "./startup"

describe("workspace-runtime startup contract", () => {
  test("resolves a semver runtime version for image keying", () => {
    expect(workspaceRuntimeVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })

  test("the claxedo host entry exists and is the bundler input", () => {
    const entry = claxedoWorkspaceRuntimeEntry()
    // The entry is an OS path; compare in forward-slash form for Windows.
    expect(entry.split(path.sep).join("/").endsWith("hosts/workspace-runtime/host-entry.ts")).toBe(true)
    expect(fs.existsSync(entry)).toBe(true)
  })
})
