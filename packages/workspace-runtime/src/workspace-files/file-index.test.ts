import { afterEach, describe, expect, mock, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as machineFiles from "@claxedo/workspace-runtime/file-index"
import { runGit } from "../git"

const scratch: string[] = []
afterEach(async () => {
  await Promise.all(scratch.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function root() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "machine-file-index-"))
  scratch.push(dir)
  return dir
}

const noGit = async () => { throw new Error("not a repository") }

describe("machine file index", () => {
  test("exposes the machine-owned factory", () => {
    expect(machineFiles).toHaveProperty("createFileIndex")
  })

  test("refuses cache and traversal options that cannot enforce finite bounds", () => {
    for (const maxRoots of [0, -1, 1.5, Infinity, NaN]) {
      expect(() => machineFiles.createFileIndex({ maxRoots })).toThrow(RangeError)
    }
    for (const maxFiles of [0, -1, 1.5, Infinity, NaN]) {
      expect(() => machineFiles.createFileIndex({ maxFiles })).toThrow(RangeError)
    }
    for (const ttlMs of [-1, Infinity, NaN]) {
      expect(() => machineFiles.createFileIndex({ ttlMs })).toThrow(RangeError)
    }
  })

  test("lists tracked and untracked files in one Git invocation with standard ignores", async () => {
    const dir = await root()
    await runGit(["init"], dir)
    await fs.writeFile(path.join(dir, ".gitignore"), "ignored/\ntracked.txt\n")
    await fs.mkdir(path.join(dir, "ignored"))
    await fs.writeFile(path.join(dir, "ignored", "secret.txt"), "")
    await fs.writeFile(path.join(dir, "tracked.txt"), "")
    await runGit(["add", "-f", "tracked.txt"], dir)
    const special = " 雪 furniture\nnotes.txt "
    await fs.writeFile(path.join(dir, special), "")
    const git = mock(runGit)
    const index = machineFiles.createFileIndex({ git })
    expect((await index.get(dir)).files).toEqual([special, ".gitignore", "tracked.txt"].sort())
    expect(git).toHaveBeenCalledTimes(1)
    expect(git.mock.calls[0]?.[0]).toEqual(["-c", "core.fsmonitor=false", "ls-files", "-c", "-o", "--exclude-standard", "-z"])
  })

  test("Git listing stays relative to a selected subtree and deduplicates staged files", async () => {
    const dir = await root()
    await runGit(["init"], dir)
    await fs.mkdir(path.join(dir, "sub"))
    await fs.writeFile(path.join(dir, "outside.txt"), "")
    await fs.writeFile(path.join(dir, "sub", "inside.txt"), "")
    await runGit(["add", "."], dir)
    expect(await machineFiles.createFileIndex().list(path.join(dir, "sub"))).toEqual(["inside.txt"])
  })

  test("walks non-repositories, derives sorted parents and skips dependency/build output", async () => {
    const dir = await root()
    for (const name of ["src/nested", ".git", "node_modules", "dist", "build", ".next", ".turbo", ".vercel", ".cache"]) {
      await fs.mkdir(path.join(dir, name), { recursive: true })
      await fs.writeFile(path.join(dir, name, "file.txt"), "")
    }
    await fs.writeFile(path.join(dir, ".DS_Store"), "")
    await fs.writeFile(path.join(dir, " 雪 desk.txt "), "")
    expect(await machineFiles.createFileIndex({ git: noGit }).get(dir)).toEqual({
      files: [" 雪 desk.txt ", "src/nested/file.txt"],
      directories: ["src", "src/nested"],
      all: [" 雪 desk.txt ", "src", "src/nested", "src/nested/file.txt"],
    })
  })

  test("walks do not follow file or directory symlinks, including loops and outside targets", async () => {
    const dir = await root()
    const outside = await root()
    await fs.writeFile(path.join(outside, "secret.txt"), "")
    await fs.writeFile(path.join(dir, "safe.txt"), "")
    await fs.symlink(outside, path.join(dir, "escape"))
    await fs.symlink(dir, path.join(dir, "loop"))
    await fs.symlink(path.join(outside, "secret.txt"), path.join(dir, "link.txt"))
    expect(await machineFiles.createFileIndex({ git: noGit }).list(dir)).toEqual(["safe.txt"])
  })

  test("bounds fallback file traversal and reports unreadable roots as empty", async () => {
    const dir = await root()
    for (const name of ["a.txt", "b.txt", "c.txt"]) await fs.writeFile(path.join(dir, name), "")
    const index = machineFiles.createFileIndex({ git: noGit, maxFiles: 2 })
    expect(await index.list(dir)).toEqual(["a.txt", "b.txt"])
    expect(await index.list(path.join(dir, "missing"))).toEqual([])
  })

  test("shares pending builds and keys cache entries by resolved root", async () => {
    const dir = await root()
    const git = mock(async () => "src/a.txt\0")
    const index = machineFiles.createFileIndex({ git })
    const [one, two] = await Promise.all([index.get(dir), index.get(path.join(dir, "..", path.basename(dir)))])
    expect(one).toBe(two)
    expect(git).toHaveBeenCalledTimes(1)
    expect(index.size).toBe(1)
  })

  test("evicts the least recently used root without exceeding the cache bound", async () => {
    const dir = await root()
    const git = mock(async () => "a.txt\0")
    const index = machineFiles.createFileIndex({ git, maxRoots: 2 })
    const a = path.join(dir, "a")
    const b = path.join(dir, "b")
    const c = path.join(dir, "c")
    await index.get(a)
    await index.get(b)
    await index.get(a)
    await index.get(c)
    expect(index.size).toBe(2)
    expect(git).toHaveBeenCalledTimes(3)
    await index.get(a)
    expect(git).toHaveBeenCalledTimes(3)
    await index.get(b)
    expect(git).toHaveBeenCalledTimes(4)
    expect(index.size).toBe(2)
  })

  test("sweeps expired roots and rebuilds an expired entry", async () => {
    const dir = await root()
    let now = 0
    const git = mock(async () => "a.txt\0")
    const index = machineFiles.createFileIndex({ git, now: () => now, ttlMs: 10 })
    await index.get(dir)
    await index.get(path.join(dir, "b"))
    now = 10
    await index.get(dir)
    expect(index.size).toBe(1)
    expect(git).toHaveBeenCalledTimes(3)
  })

  test("invalidates a root or every root and keeps uncached listings fresh", async () => {
    const dir = await root()
    const index = machineFiles.createFileIndex({ git: noGit })
    await fs.writeFile(path.join(dir, "a.txt"), "")
    expect((await index.get(dir)).files).toEqual(["a.txt"])
    await fs.writeFile(path.join(dir, "b.txt"), "")
    expect((await index.get(dir)).files).toEqual(["a.txt"])
    expect(await index.list(dir)).toEqual(["a.txt", "b.txt"])
    index.invalidate(path.join(dir, "."))
    expect((await index.get(dir)).files).toEqual(["a.txt", "b.txt"])
    index.invalidate()
    expect(index.size).toBe(0)
  })

  test("invalidation during a pending build cannot replace the next entry", async () => {
    const dir = await root()
    let finish: (value: string) => void = () => {}
    const git = mock(() => new Promise<string>((resolve) => { finish = resolve }))
    const index = machineFiles.createFileIndex({ git })
    const stale = index.get(dir)
    index.invalidate(dir)
    finish("old.txt\0")
    await stale
    const next = index.get(dir)
    finish("new.txt\0")
    expect((await next).files).toEqual(["new.txt"])
    expect((await index.get(dir)).files).toEqual(["new.txt"])
    expect(git).toHaveBeenCalledTimes(2)
  })
})
