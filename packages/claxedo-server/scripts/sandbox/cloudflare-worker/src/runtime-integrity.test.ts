import { execFileSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import { runtimeDigest } from "../../runtime-digest"
import { RUNTIME_DIGEST_SCRIPT, versionBefore, workerRuntimeBuild } from "./runtime-integrity"

const made: string[] = []

function bundle() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claxedo-runtime-digest-"))
  made.push(root)
  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true })
    fs.writeFileSync(path.join(root, file), text)
  }
  write("workspace-runtime-host.mjs", "host")
  write("a-b.txt", "dash")
  write("a/b.txt", "slash")
  write("script/apply-dependency-patches.mjs", "patch")
  return { root, write }
}

function containerDigest(root: string, entry?: string) {
  return execFileSync("sh", ["-c", RUNTIME_DIGEST_SCRIPT, "digest", root, ...(entry ? [entry] : [])], { encoding: "utf8" }).trim()
}

afterEach(() => {
  for (const root of made.splice(0)) fs.rmSync(root, { recursive: true, force: true })
})

describe("runtime digest", () => {
  test("the container's shell computes the digest the image build records, whatever npm install writes beside the bundle", () => {
    const { root, write } = bundle()
    const recorded = runtimeDigest(root)
    write("node_modules/better-sqlite3/index.js", "installed")
    write("package-lock.json", "{}")
    expect(containerDigest(root)).toBe(recorded)
  })

  test("a changed, added or removed bundle file changes the digest", () => {
    const { root, write } = bundle()
    const recorded = runtimeDigest(root)
    write("workspace-runtime-host.mjs", "host, patched by an agent")
    expect(containerDigest(root)).not.toBe(recorded)
    write("workspace-runtime-host.mjs", "host")
    write("preload.mjs", "extra")
    expect(containerDigest(root)).not.toBe(recorded)
  })

  test("an entry point that no longer links to the bundle's host fails the check", () => {
    const { root } = bundle()
    const entry = path.join(root, "..", `${path.basename(root)}-entry`)
    made.push(entry)
    fs.symlinkSync(path.join(root, "workspace-runtime-host.mjs"), entry)
    expect(containerDigest(root, entry)).toBe(runtimeDigest(root))
    fs.rmSync(entry)
    fs.symlinkSync("/tmp/elsewhere.mjs", entry)
    expect(() => containerDigest(root, entry)).toThrow()
  })
})

describe("runtime builds", () => {
  test("a Worker deployed without its image's build identity has none", () => {
    const digest = "a".repeat(64)
    expect(workerRuntimeBuild({ RUNTIME_BUILD_ID: "b1", RUNTIME_VERSION: "0.5.2", RUNTIME_DIGEST: digest })).toEqual({ id: "b1", version: "0.5.2", digest })
    expect(workerRuntimeBuild({ RUNTIME_BUILD_ID: "b1", RUNTIME_VERSION: "0.5.2" })).toBeUndefined()
    expect(workerRuntimeBuild({ RUNTIME_BUILD_ID: "b1", RUNTIME_VERSION: "0.5.2", RUNTIME_DIGEST: "short" })).toBeUndefined()
  })

  test("versions compare numerically, and an unreadable one is older than any minimum", () => {
    expect(versionBefore("0.5.2", "0.5.10")).toBe(true)
    expect(versionBefore("0.6.0", "0.5.10")).toBe(false)
    expect(versionBefore("0.5.2", "0.5.2")).toBe(false)
    expect(versionBefore("dev", "0.5.2")).toBe(true)
    expect(() => versionBefore("0.5.2", "latest")).toThrow()
  })
})
