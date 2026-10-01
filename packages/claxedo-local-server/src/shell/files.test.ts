import fs from "fs"
import os from "os"
import path from "path"
import { afterEach, describe, expect, test, vi } from "vitest"
import { globSearch, grepSearch } from "./files"
import { mountWorkspaceFiles } from "@claxedo/workspace-runtime/host"
import { Hono } from "hono"

const scratch: string[] = []

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })))
})

describe("globSearch", () => {
  test("shares a listing with the runtime caller while retaining substring and fuzzy matching", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "claxedo-shared-file-index-"))
    scratch.push(root)
    await fs.promises.mkdir(path.join(root, "src", "panel"), { recursive: true })
    await fs.promises.writeFile(path.join(root, "src", "panel", "widget.ts"), "")
    const readdir = fs.promises.readdir
    const spy = vi.spyOn(fs.promises, "readdir").mockImplementation((dir, options) => readdir(dir, options as never) as never)
    const previousDirectory = process.env.WORKSPACE_RUNTIME_DIRECTORY
    process.env.WORKSPACE_RUNTIME_DIRECTORY = root
    try {
      expect(await globSearch(root, "widget", "file", 50)).toEqual(["src/panel/widget.ts"])
      const reads = spy.mock.calls.length
      expect(reads).toBeGreaterThan(0)
      const app = new Hono()
      mountWorkspaceFiles(app)
      expect(await (await app.request("/api/wr/find/file?dirs=false&query=spwidget")).json()).toEqual(["src/panel/widget.ts"])
      expect(spy.mock.calls.length).toBe(reads)
      expect(await globSearch(root, "spwidget", "file", 50)).toEqual([])
    } finally {
      spy.mockRestore()
      if (previousDirectory === undefined) delete process.env.WORKSPACE_RUNTIME_DIRECTORY
      else process.env.WORKSPACE_RUNTIME_DIRECTORY = previousDirectory
    }
  })

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

describe("grepSearch", () => {
  test("matches a regular expression with line numbers, offsets and submatches", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "claxedo-grep-"))
    scratch.push(root)
    await fs.promises.writeFile(path.join(root, "a.txt"), "hello world\nfoo bar\nhello again\n")

    const found = await grepSearch(root, "hel+o")
    expect(found).toEqual([
      {
        path: { text: "a.txt" },
        lines: { text: "hello world" },
        line_number: 1,
        absolute_offset: 0,
        submatches: [{ match: { text: "hello" }, start: 0, end: 5 }],
      },
      {
        path: { text: "a.txt" },
        lines: { text: "hello again" },
        line_number: 3,
        absolute_offset: 20,
        submatches: [{ match: { text: "hello" }, start: 0, end: 5 }],
      },
    ])
  })

  test("keeps regex semantics for metacharacters and returns nothing for an invalid pattern", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "claxedo-grep-"))
    scratch.push(root)
    await fs.promises.writeFile(path.join(root, "a.txt"), "foo.bar\nfooXbar\n")

    // `.` still matches any character — the pattern is a regex, not a literal.
    expect((await grepSearch(root, "foo.bar")).map((hit) => hit.line_number)).toEqual([1, 2])
    expect(await grepSearch(root, "foo\\.bar")).toEqual([
      expect.objectContaining({ line_number: 1, lines: { text: "foo.bar" } }),
    ])
    expect(await grepSearch(root, "([")).toEqual([])
    expect(await grepSearch(root, "hello", 0)).toEqual([])
  })

  test("a catastrophic pattern terminates on the scan deadline instead of hanging", async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "claxedo-grep-"))
    scratch.push(root)
    await fs.promises.writeFile(path.join(root, "a.txt"), `${"a".repeat(100_000)}!\n`)

    const started = Date.now()
    const found = await grepSearch(root, "(a+)+$")
    const elapsed = Date.now() - started
    expect(found).toEqual([])
    // The unbounded evaluation is effectively forever; the worker deadline must
    // cut it off in seconds. Generous slack keeps slow CI from flaking.
    expect(elapsed).toBeLessThan(15_000)

    // A search after a terminated worker still gets a fresh, working scanner.
    await fs.promises.writeFile(path.join(root, "b.txt"), "needle here\n")
    expect(await grepSearch(root, "needle")).toEqual([
      expect.objectContaining({ path: { text: "b.txt" }, line_number: 1 }),
    ])
  }, 30_000)
})
