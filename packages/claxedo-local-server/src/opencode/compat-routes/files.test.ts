import fs from "fs"
import os from "os"
import path from "path"
import { afterEach, describe, expect, test } from "vitest"
import { globSearch } from "./files"

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
})
