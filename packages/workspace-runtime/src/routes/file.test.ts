import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Hono } from "hono"
import fs from "node:fs/promises"
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
