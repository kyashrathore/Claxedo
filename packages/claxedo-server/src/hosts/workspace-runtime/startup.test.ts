import { describe, expect, test } from "vitest"
import fs from "fs"
import path from "node:path"
import os from "node:os"
import { claxedoWorkspaceRuntimeEntry, readWorkspaceRuntimeVersion, workspaceRuntimeVersion } from "./startup"

describe("workspace-runtime startup contract", () => {
  test("resolves a semver runtime version for image keying", () => {
    expect(workspaceRuntimeVersion()).toMatch(/^\d+\.\d+\.\d+/)
  })

  test("the claxedo host entry exists and is the bundler input", () => {
    const entry = claxedoWorkspaceRuntimeEntry()
    expect(entry.endsWith(path.join("hosts", "workspace-runtime", "host-entry.ts"))).toBe(true)
    expect(fs.existsSync(entry)).toBe(true)
  })

  test("rejects missing or malformed package metadata", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "runtime-version-"))
    try {
      expect(() => readWorkspaceRuntimeVersion(root)).toThrow("workspace-runtime package metadata")
      await fs.promises.writeFile(path.join(root, "package.json"), JSON.stringify({ version: 3 }))
      expect(() => readWorkspaceRuntimeVersion(root)).toThrow("workspace-runtime package metadata")
      await fs.promises.writeFile(path.join(root, "package.json"), JSON.stringify({ version: "not-semver" }))
      expect(() => readWorkspaceRuntimeVersion(root)).toThrow("workspace-runtime package metadata")
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true })
    }
  })

  test.each(["01.0.0", "1.0.0-.", "1.0.0-alpha..1", "1.0.0-01"])(
    "rejects malformed semantic version %s",
    async (version) => {
      const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "runtime-version-"))
      try {
        await fs.promises.writeFile(path.join(root, "package.json"), JSON.stringify({ version }))
        expect(() => readWorkspaceRuntimeVersion(root)).toThrow("workspace-runtime package metadata")
      } finally {
        await fs.promises.rm(root, { recursive: true, force: true })
      }
    },
  )

  test("accepts semantic versions with prerelease and build metadata", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "runtime-version-"))
    try {
      await fs.promises.writeFile(path.join(root, "package.json"), JSON.stringify({ version: "1.0.0-alpha.1+build.5" }))
      expect(readWorkspaceRuntimeVersion(root)).toBe("1.0.0-alpha.1+build.5")
    } finally {
      await fs.promises.rm(root, { recursive: true, force: true })
    }
  })
})
