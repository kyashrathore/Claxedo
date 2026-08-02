import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"
import { agentExtensionCacheRoot, cachePackageRoot, copyPackageToCache, digestDirectory } from "./cache"

const root = path.join(os.tmpdir(), `agent-extensions-cache-${randomUUID().slice(0, 8)}`)
const source = path.join(root, "source")
const data = path.join(root, "data")

describe("Agent Extension cache", () => {
  beforeEach(async () => {
    await fs.rm(root, { recursive: true, force: true })
    await fs.mkdir(path.join(source, "packages", "review"), { recursive: true })
    await fs.writeFile(path.join(source, "packages", "review", "SKILL.md"), "skill")
  })

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true })
  })

  test("uses a Claxedo-owned cache root and safe package paths", () => {
    expect(agentExtensionCacheRoot({ dataRoot: data })).toBe(path.join(data, "agent-extensions", "cache"))
    expect(cachePackageRoot({
      dataRoot: data,
      resolvedSha: "ABCDEF1",
      packagePath: "packages/review",
    })).toBe(path.join(data, "agent-extensions", "cache", "abcdef1", "packages", "review"))
    expect(() => cachePackageRoot({ dataRoot: data, resolvedSha: "not-a-sha" })).toThrow("resolved SHA")
    expect(() => cachePackageRoot({ dataRoot: data, resolvedSha: "abcdef1", packagePath: "../escape" })).toThrow("must stay inside")
  })

  test("digests directories deterministically from relative paths and content", async () => {
    const first = await digestDirectory(path.join(source, "packages", "review"))
    const second = await digestDirectory(path.join(source, "packages", "review"))
    expect(first).toBe(second)

    await fs.writeFile(path.join(source, "packages", "review", "README.md"), "readme")
    expect(await digestDirectory(path.join(source, "packages", "review"))).not.toBe(first)
  })

  test("copies selected package roots into the cache", async () => {
    const result = await copyPackageToCache({
      sourceRoot: source,
      resolvedSha: "abcdef1234567890",
      packagePath: "packages/review",
      dataRoot: data,
    })

    expect(result.path).toBe(path.join(data, "agent-extensions", "cache", "abcdef1234567890", "packages", "review"))
    expect(result.checksum).toBe(await digestDirectory(result.path))
    await expect(fs.readFile(path.join(result.path, "SKILL.md"), "utf8")).resolves.toBe("skill")
  })

  test("rejects package paths that escape the fetched root", async () => {
    await expect(copyPackageToCache({
      sourceRoot: source,
      resolvedSha: "abcdef1",
      packagePath: "../source",
      dataRoot: data,
    })).rejects.toThrow("must stay inside")
  })

  test("rejects symlinks before caching package bytes", async () => {
    await fs.symlink(path.join(root, "outside"), path.join(source, "packages", "review", "outside"))

    await expect(copyPackageToCache({
      sourceRoot: source,
      resolvedSha: "abcdef1",
      packagePath: "packages/review",
      dataRoot: data,
    })).rejects.toThrow("Cache source symlink")
  })
})
