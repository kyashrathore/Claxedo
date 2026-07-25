import { afterAll, afterEach, describe, expect, test } from "vitest"
import { execSync } from "child_process"
import { readFileSync, realpathSync } from "fs"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { randomUUID } from "crypto"

const root = path.join(realpathSync(os.tmpdir()), `find-routes-${randomUUID().slice(0, 8)}`)
const prev = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const { Hono } = await import("hono")
const { OpenCodeCompatRoutes } = await import("./routes/opencode-compat")

const app = new Hono()
app.route("/", OpenCodeCompatRoutes())

// The engine owns the file-route table; the compat layer must cover all of it
// or the frontend silently 404s (that is exactly how `/find` went missing).
const ENGINE_FILE_GROUP = path.resolve(
  import.meta.dirname,
  "../../opencode/src/server/routes/instance/httpapi/groups/file.ts",
)

function enginePaths() {
  const source = readFileSync(ENGINE_FILE_GROUP, "utf-8")
  const table = source.match(/export const FilePaths = \{([\s\S]*?)\} as const/)
  if (!table) throw new Error(`FilePaths table not found in ${ENGINE_FILE_GROUP}`)
  return Array.from(table[1]!.matchAll(/"(\/[^"]*)"/g)).map((hit) => hit[1]!)
}

function sh(cmd: string) {
  execSync(cmd, { stdio: "ignore" })
}

async function tree(name: string, git: boolean) {
  const dir = path.join(root, "repos", name)
  await fs.mkdir(path.join(dir, "src"), { recursive: true })
  await fs.writeFile(path.join(dir, "src", "todo.ts"), "const a = 1\n// TODO: wire this up\n")
  await fs.writeFile(path.join(dir, "README.md"), "# Docs\n")
  if (git) {
    sh(`git init -b main ${dir}`)
    sh(`git -C ${dir} config user.email test@example.com`)
    sh(`git -C ${dir} config user.name test`)
    sh(`git -C ${dir} add -A`)
    sh(`git -C ${dir} commit -m "init"`)
  }
  return dir
}

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

afterAll(() => {
  if (prev === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = prev
})

describe("opencode compat text search", () => {
  test("returns engine-shaped matches for a tracked file", async () => {
    const dir = await tree("git-tree", true)

    const res = await app.request(`/find?directory=${encodeURIComponent(dir)}&pattern=${encodeURIComponent("\\bTODO\\b")}`)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([
      {
        path: { text: "src/todo.ts" },
        lines: { text: "// TODO: wire this up" },
        line_number: 2,
        absolute_offset: 12,
        submatches: [{ match: { text: "TODO" }, start: 3, end: 7 }],
      },
    ])
  })

  test("searches directories that are not git repositories", async () => {
    const dir = await tree("plain-tree", false)

    const res = await app.request(`/find?directory=${encodeURIComponent(dir)}&pattern=TODO`)

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject([{ path: { text: "src/todo.ts" }, line_number: 2 }])
  })

  test("returns an empty result for a missing or invalid pattern", async () => {
    const dir = await tree("bad-pattern", false)

    const empty = await app.request(`/find?directory=${encodeURIComponent(dir)}`)
    expect(empty.status).toBe(200)
    expect(await empty.json()).toEqual([])

    const invalid = await app.request(`/find?directory=${encodeURIComponent(dir)}&pattern=${encodeURIComponent("(")}`)
    expect(invalid.status).toBe(200)
    expect(await invalid.json()).toEqual([])
  })

  test("answers /find/symbol with the engine's empty symbol list", async () => {
    const dir = await tree("symbols", false)

    const res = await app.request(`/find/symbol?directory=${encodeURIComponent(dir)}&query=todo`)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
  })
})

describe("opencode compat file route coverage", () => {
  test("routes every path the engine declares in FilePaths", async () => {
    const dir = await tree("coverage", false)
    const paths = enginePaths()
    expect(paths).toContain("/find")
    expect(paths.length).toBeGreaterThanOrEqual(6)

    const missing: string[] = []
    for (const route of paths) {
      const res = await app.request(
        `${route}?directory=${encodeURIComponent(dir)}&pattern=TODO&query=README&path=${encodeURIComponent("README.md")}`,
      )
      if (res.status === 404) missing.push(route)
    }

    expect(missing).toEqual([])
  })
})
