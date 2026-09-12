import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import fs from "node:fs/promises"
import fsNode from "node:fs"
import os from "node:os"
import path from "node:path"
import { FileRoutes } from "./file"

let previousDirectory: string | undefined
let tmp: string

async function bytes(res: Response) {
  return new Uint8Array(await res.arrayBuffer())
}

beforeEach(async () => {
  previousDirectory = process.env.WORKSPACE_RUNTIME_DIRECTORY
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-runtime-file-"))
  process.env.WORKSPACE_RUNTIME_DIRECTORY = tmp
})

afterEach(async () => {
  if (previousDirectory === undefined) {
    delete process.env.WORKSPACE_RUNTIME_DIRECTORY
  } else {
    process.env.WORKSPACE_RUNTIME_DIRECTORY = previousDirectory
  }
  await fs.rm(tmp, { recursive: true, force: true })
})

describe("FileRoutes raw file streaming", () => {
  test("lists all tracked or walked files", async () => {
    const app = new Hono().route("/", FileRoutes())
    await fs.mkdir(path.join(tmp, "src"), { recursive: true })
    await fs.writeFile(path.join(tmp, "README.md"), "hello")
    await fs.writeFile(path.join(tmp, "src", "index.ts"), "export {}")

    const res = await app.request("http://localhost/file/all")
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      paths: ["README.md", path.join("src", "index.ts")],
    })
  })

  test("labels a raw image by its own type so a page can render it, and refuses to be sniffed", async () => {
    const app = new Hono().route("/", FileRoutes())
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    await fs.mkdir(path.join(tmp, "docs"), { recursive: true })
    await fs.writeFile(path.join(tmp, "docs", "shot.PNG"), png)
    await fs.writeFile(path.join(tmp, "docs", "logo.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\"/>")

    const image = await app.request("http://localhost/file/raw?path=docs/shot.PNG")
    expect(image.status).toBe(200)
    expect(image.headers.get("content-type")).toBe("image/png")
    expect(image.headers.get("x-content-type-options")).toBe("nosniff")
    expect(await bytes(image)).toEqual(png)

    const svg = await app.request("http://localhost/file/raw?path=docs/logo.svg")
    expect(svg.headers.get("content-type")).toBe("image/svg+xml")
    expect(svg.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox")
  })

  test("streams raw file bytes without changing the JSON content route", async () => {
    const app = new Hono().route("/", FileRoutes())
    await fs.writeFile(path.join(tmp, "large.bin"), new Uint8Array([1, 2, 3, 4, 5]))

    const raw = await app.request("http://localhost/file/raw?path=large.bin")
    expect(raw.status).toBe(200)
    expect(raw.headers.get("content-type")).toBe("application/octet-stream")
    expect(raw.headers.get("content-length")).toBe("5")
    expect(await bytes(raw)).toEqual(new Uint8Array([1, 2, 3, 4, 5]))

    const json = await app.request("http://localhost/file/content?path=large.bin")
    expect(json.status).toBe(200)
    await expect(json.json()).resolves.toEqual({
      type: "text",
      content: "\u0001\u0002\u0003\u0004\u0005",
    })
  })

  test("rejects absolute and escaping raw file paths", async () => {
    const app = new Hono().route("/", FileRoutes())

    const absolute = await app.request(`http://localhost/file/raw?path=${encodeURIComponent(path.join(tmp, "x"))}`)
    expect(absolute.status).toBe(400)
    await expect(absolute.json()).resolves.toEqual({
      error: {
        code: "file_invalid_relative_path",
        message: "Invalid relative file path",
      },
    })

    const escaping = await app.request("http://localhost/file/raw?path=../x")
    expect(escaping.status).toBe(400)
    await expect(escaping.json()).resolves.toEqual({
      error: {
        code: "file_invalid_relative_path",
        message: "Invalid relative file path",
      },
    })
  })

  test("rejects escaping paths across JSON file routes", async () => {
    const app = new Hono().route("/", FileRoutes())
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-runtime-file-outside-"))

    try {
      await fs.writeFile(path.join(outside, "secret.txt"), "secret")
      await fs.symlink(outside, path.join(tmp, "linked-out"))

      for (const target of [
        "/file",
        "/file/content",
        "/file/raw",
      ]) {
        const absolute = await app.request(
          `http://localhost${target}?path=${encodeURIComponent(path.join(outside, "secret.txt"))}`,
        )
        expect(absolute.status).toBe(400)

        const parent = await app.request(`http://localhost${target}?path=${encodeURIComponent("../secret.txt")}`)
        expect(parent.status).toBe(400)

        const nul = await app.request(`http://localhost${target}?path=${encodeURIComponent("safe\u0000.txt")}`)
        expect(nul.status).toBe(400)
      }

      const symlinkList = await app.request("http://localhost/file?path=linked-out")
      expect(symlinkList.status).toBe(400)

      const symlinkContent = await app.request("http://localhost/file/content?path=linked-out/secret.txt")
      expect(symlinkContent.status).toBe(400)

      const symlinkRaw = await app.request("http://localhost/file/raw?path=linked-out/secret.txt")
      expect(symlinkRaw.status).toBe(400)
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  test("rejects caller-selected directories across file routes", async () => {
    const app = new Hono().route("/", FileRoutes())
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-runtime-file-outside-"))

    try {
      for (const target of [
        "/find/file",
        "/file",
        "/file/content",
        "/file/raw",
        "/file/status",
        "/file/all",
      ]) {
        const response = await app.request(
          `http://localhost${target}?directory=${encodeURIComponent(outside)}`,
        )
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({
          error: {
            code: "file_invalid_directory",
            message: "File directory must match configured workspace",
          },
        })
      }
    } finally {
      await fs.rm(outside, { recursive: true, force: true })
    }
  })

  test("returns structured missing raw file errors", async () => {
    const app = new Hono().route("/", FileRoutes())

    const missing = await app.request("http://localhost/file/raw?path=missing.txt")
    expect(missing.status).toBe(404)
    await expect(missing.json()).resolves.toEqual({
      error: {
        code: "file_not_found",
        message: "File not found",
      },
    })
  })
})

describe("FileRoutes file search", () => {
  const search = async (query: string, extra = "") => {
    const app = new Hono().route("/", FileRoutes())
    const res = await app.request(
      `http://localhost/find/file?directory=${encodeURIComponent(tmp)}&query=${encodeURIComponent(query)}${extra}`,
    )
    return (await res.json()) as string[]
  }

  beforeEach(async () => {
    await fs.mkdir(path.join(tmp, "src/panel"), { recursive: true })
    await fs.writeFile(path.join(tmp, "src/panel/widget.ts"), "")
    await fs.writeFile(path.join(tmp, "src/panel/toolbar.ts"), "")
    await fs.mkdir(path.join(tmp, "node_modules/pkg/deep"), { recursive: true })
    await fs.writeFile(path.join(tmp, "node_modules/pkg/deep/widget.ts"), "")
    await fs.mkdir(path.join(tmp, "dist/bundle"), { recursive: true })
    await fs.writeFile(path.join(tmp, "dist/bundle/widget.ts"), "")
  })

  test("does not descend into ignored directories", async () => {
    expect(await search("widget", "&dirs=false")).toEqual(["src/panel/widget.ts"])
  })

  test("matches a subsequence the way the picker does, not just a literal substring", async () => {
    expect(await search("spwidget", "&dirs=false")).toEqual(["src/panel/widget.ts"])
  })

  test("returns directories derived from the indexed files", async () => {
    expect(await search("panel", "&type=directory")).toEqual(["src/panel"])
  })

  test("reuses one listing across queries instead of walking per keystroke", async () => {
    const readdir = fsNode.promises.readdir
    let walks = 0
    // @ts-expect-error -- counting the real calls the route makes
    fsNode.promises.readdir = (...args: Parameters<typeof readdir>) => {
      walks += 1
      return readdir(...args)
    }
    try {
      await search("w", "&dirs=false")
      const afterFirst = walks
      expect(afterFirst).toBeGreaterThan(0)

      // A query that matches nothing is the case the old walk could not cut
      // short: it read every directory before it could report zero hits.
      expect(await search("qqzzxx", "&dirs=false")).toEqual([])
      expect(await search("wid", "&dirs=false")).toEqual(["src/panel/widget.ts"])
      expect(walks).toBe(afterFirst)
    } finally {
      fsNode.promises.readdir = readdir
    }
  })

  test("honours the result limit", async () => {
    expect((await search("", "&dirs=false&limit=2")).length).toBe(2)
  })
})
