import fs from "fs"
import os from "os"
import path from "path"
import { afterEach, describe, expect, test, vi } from "vitest"
import { fileSearchCacheSize, globSearch } from "./files"

const scratch: string[] = []

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })))
})

describe("globSearch", () => {
  test("indexes searchable files and directories without dependency or build output", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "claxedo-file-search-"))
    scratch.push(root)
    await Promise.all([
      fs.promises.mkdir(path.join(root, "src", "nested"), { recursive: true }),
      fs.promises.mkdir(path.join(root, "node_modules", "needle-package"), { recursive: true }),
      fs.promises.mkdir(path.join(root, "dist"), { recursive: true }),
    ])
    await Promise.all([
      fs.promises.writeFile(path.join(root, "src", "nested", "needle-file.ts"), ""),
      fs.promises.writeFile(path.join(root, "node_modules", "needle-package", "index.js"), ""),
      fs.promises.writeFile(path.join(root, "dist", "needle-build.js"), ""),
    ])

    expect(await globSearch(root, "needle", "file", 50)).toEqual(["src/nested/needle-file.ts"])
    expect(await globSearch(root, "nested", "directory", 50)).toEqual(["src/nested"])
    expect(await globSearch(root, "needle", "any", 50)).toEqual(["src/nested/needle-file.ts"])
  })

  test("returns independent results for concurrent searches", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "claxedo-file-search-"))
    scratch.push(root)
    await fs.promises.mkdir(path.join(root, "src"))
    await Promise.all([
      fs.promises.writeFile(path.join(root, "src", "alpha.ts"), ""),
      fs.promises.writeFile(path.join(root, "src", "beta.ts"), ""),
    ])

    expect(await Promise.all([
      globSearch(root, "alpha", "file", 50),
      globSearch(root, "beta", "file", 50),
    ])).toEqual([["src/alpha.ts"], ["src/beta.ts"]])
  })

  test("caps retained roots by evicting the oldest, and sweeps expired entries", async () => {
    vi.useFakeTimers()
    try {
      const roots: string[] = []
      for (let i = 0; i < 34; i++) {
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), `claxedo-file-search-${i}-`))
        scratch.push(root)
        roots.push(root)
        await globSearch(root, "", "file", 50)
      }
      expect(fileSearchCacheSize()).toBe(32)

      // The two oldest roots were evicted: searching them again reindexes
      // without pushing the cache past its bound.
      const readdir = fs.promises.readdir
      const reads: string[] = []
      const spy = vi.spyOn(fs.promises, "readdir").mockImplementation(async (dir, options) => {
        reads.push(String(dir))
        return readdir(dir, options as never) as never
      })
      try {
        await globSearch(roots[0], "", "file", 50)
      } finally {
        spy.mockRestore()
      }
      expect(reads.length).toBeGreaterThan(0)
      expect(fileSearchCacheSize()).toBe(32)

      // Once every entry has expired, a single new search discards them all
      // instead of accumulating obsolete roots.
      vi.setSystemTime(Date.now() + 11_000)
      const fresh = await fs.promises.mkdtemp(path.join(os.tmpdir(), "claxedo-file-search-fresh-"))
      scratch.push(fresh)
      await globSearch(fresh, "", "file", 50)
      expect(fileSearchCacheSize()).toBe(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("globSearch for directories", () => {
  test("walks the directory tree only, bounded in depth, skipping hidden and dependency folders", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "claxedo-dir-search-"))
    scratch.push(root)
    await Promise.all([
      fs.promises.mkdir(path.join(root, "test", "opencode", "packages", "app", "src", "deep"), { recursive: true }),
      fs.promises.mkdir(path.join(root, ".cache", "test-hidden"), { recursive: true }),
      fs.promises.mkdir(path.join(root, "node_modules", "test-dep"), { recursive: true }),
      fs.promises.mkdir(path.join(root, "Library", "Caches", "test-app"), { recursive: true }),
    ])
    await fs.promises.writeFile(path.join(root, "test", "opencode", "test-file.txt"), "")

    const found = await globSearch(root, "test", "directory", 50)
    expect(found).toEqual(["test", "Library/Caches/test-app"])
    expect(found).not.toContain("test/opencode/test-file.txt")
    expect(await globSearch(root, "", "directory", 50)).toEqual(["Library", "test"])
    expect(await globSearch(root, "packages", "directory", 50)).toEqual(["test/opencode/packages"])
    expect(await globSearch(root, "app", "directory", 50)).toEqual(["Library/Caches/test-app"])
  })

  test("a name that matches nothing stops after the directory budget instead of reading the tree", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "claxedo-dir-budget-"))
    scratch.push(root)
    await Promise.all(Array.from({ length: 600 }, (_, i) => fs.promises.mkdir(path.join(root, `d${String(i).padStart(3, "0")}`, "inner"), { recursive: true })))
    const reads: string[] = []
    const readdir = fs.promises.readdir
    const spy = vi.spyOn(fs.promises, "readdir").mockImplementation(async (dir, options) => { reads.push(String(dir)); return readdir(dir, options as never) as never })
    try {
      expect(await globSearch(root, "nothing-here", "directory", 50)).toEqual([])
    } finally {
      spy.mockRestore()
    }
    expect(reads.length).toBeLessThanOrEqual(400)
  })
})
