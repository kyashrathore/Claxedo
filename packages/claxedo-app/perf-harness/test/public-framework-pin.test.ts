import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { assertPinnedPublicFramework } from "../src/public-framework-pin"

const manifestPath = path.join(import.meta.dir, "../package.json")
const installedRoot = new URL("../", import.meta.resolve("agent-app-benchmark/driver-sdk"))

async function framework(tag?: string) {
  const root = await mkdtemp(path.join(tmpdir(), "claxedo-framework-pin-"))
  if (tag !== undefined) await writeFile(path.join(root, ".bun-tag"), tag)
  return root
}

describe("public framework pin", () => {
  test("accepts the installed tree this harness resolves its driver SDK from", async () => {
    const pin = await assertPinnedPublicFramework({ manifestPath, frameworkRoot: installedRoot })
    expect(pin.pinnedCommit).toMatch(/^[0-9a-f]{40}$/u)
    expect(pin.pinnedCommit.startsWith(pin.installedCommit)).toBe(true)
  })

  test("rejects a tree installed from another commit of the same repository", async () => {
    const root = await framework("kyashrathore-agent-app-benchmark-3e2c78d")
    try {
      await expect(assertPinnedPublicFramework({ manifestPath, frameworkRoot: root })).rejects.toThrow(
        /Installed agent-app-benchmark is 3e2c78d but .*package\.json pins [0-9a-f]{40}; run bun install --frozen-lockfile/u,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("rejects a tree that carries no pinned-commit marker", async () => {
    const root = await framework()
    try {
      await expect(assertPinnedPublicFramework({ manifestPath, frameworkRoot: root })).rejects.toThrow(
        "has no pinned-commit marker",
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  test("reads a tree whose directory name contains a URL delimiter", async () => {
    const parent = await mkdtemp(path.join(tmpdir(), "claxedo-framework-pin-"))
    const root = path.join(parent, "worktree#f8cc01d?stale")
    try {
      await mkdir(root)
      await writeFile(path.join(root, ".bun-tag"), "kyashrathore-agent-app-benchmark-3e2c78d")
      await expect(assertPinnedPublicFramework({ manifestPath, frameworkRoot: root })).rejects.toThrow(
        "Installed agent-app-benchmark is 3e2c78d",
      )
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })

  test("rejects a manifest that floats the framework instead of pinning a commit", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "claxedo-framework-manifest-"))
    const floating = path.join(root, "package.json")
    try {
      await writeFile(
        floating,
        JSON.stringify({ dependencies: { "agent-app-benchmark": "github:kyashrathore/agent-app-benchmark" } }),
      )
      await expect(
        assertPinnedPublicFramework({ manifestPath: floating, frameworkRoot: installedRoot }),
      ).rejects.toThrow("must pin agent-app-benchmark to a full git commit")
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
