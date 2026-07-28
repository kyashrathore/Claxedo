import fs from "fs"
import os from "os"
import path from "path"
import { HTTPException } from "hono/http-exception"
import { afterEach, describe, expect, test } from "vitest"
import { directoryEntriesBody, fileContentBody } from "./opencode-compat-file-browser"

const scratch: string[] = []

afterEach(async () => {
  await Promise.all(scratch.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })))
})

function ctx(directory: string, target: string) {
  return {
    req: {
      query: (key: string) => (key === "directory" ? directory : key === "path" ? target : undefined),
      header: () => undefined,
    },
  }
}

/** Unwrap the thrown `HTTPException` into the response the client would see. */
async function rejection(body: Promise<unknown>) {
  const thrown = await body.then(() => undefined, (error: unknown) => error)
  expect(thrown, "expected the containment guard to reject").toBeInstanceOf(HTTPException)
  const res = (thrown as HTTPException).getResponse()
  return { status: res.status, body: await res.json() }
}

describe("fileContentBody", () => {
  test("returns binary files as explicitly encoded base64", async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "claxedo-file-content-"))
    scratch.push(directory)
    await fs.promises.writeFile(path.join(directory, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]))

    const result = await fileContentBody({
      req: {
        query: (key) => key === "directory" ? directory : key === "path" ? "image.png" : undefined,
        header: () => undefined,
      },
    })

    expect(result).toEqual({
      type: "binary",
      content: "iVBORw==",
      encoding: "base64",
    })
  })

  test("classifies UTF-8-valid content containing NUL bytes as binary", async () => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "claxedo-file-content-"))
    scratch.push(directory)
    await fs.promises.writeFile(path.join(directory, "image.bmp"), Buffer.from([0x42, 0x4d, 0x00, 0x00]))

    const result = await fileContentBody({
      req: {
        query: (key) => key === "directory" ? directory : key === "path" ? "image.bmp" : undefined,
        header: () => undefined,
      },
    })

    expect(result).toEqual({
      type: "binary",
      content: "Qk0AAA==",
      encoding: "base64",
    })
  })
})

/**
 * Both body functions wrap their `fs` call in a catch that degrades to an empty
 * result — `[]` for a listing, empty content for a read. `workspacePath()` is
 * awaited OUTSIDE that catch on purpose: moved inside, a traversal probe would
 * be answered with a plausible 200 and the rejection would vanish. Nothing in
 * the helper's own tests can catch that regression, because it is a property of
 * where the call sits in these two functions.
 */
describe("the containment rejection is not swallowed by the fs catch", () => {
  const outside = ["../../../etc/passwd", "/etc/passwd"]

  test.each(outside)("fileContentBody rejects %s instead of returning empty content", async (target) => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "claxedo-file-escape-"))
    scratch.push(directory)

    expect(await rejection(fileContentBody(ctx(directory, target)))).toEqual({
      status: 400,
      body: {
        error: {
          code: "opencode_path_outside_workspace",
          message: "path resolves outside the workspace root",
        },
      },
    })
  })

  test.each(outside)("directoryEntriesBody rejects %s instead of returning an empty listing", async (target) => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "claxedo-dir-escape-"))
    scratch.push(directory)

    expect((await rejection(directoryEntriesBody(ctx(directory, target)))).status).toBe(400)
  })

  test("a symlink inside the root pointing outward is refused by both", async () => {
    // The §6.6 residual, exercised through the real handlers rather than the
    // helper: `escape` passes a lexical containment check and is only caught
    // once the path is canonicalized.
    const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), "claxedo-browser-symlink-"))
    scratch.push(base)
    const root = path.join(base, "root")
    await fs.promises.mkdir(path.join(base, "outside"), { recursive: true })
    await fs.promises.mkdir(root)
    await fs.promises.writeFile(path.join(base, "outside", "secret.txt"), "stolen")
    try {
      await fs.promises.symlink(path.join(base, "outside"), path.join(root, "escape"), "dir")
    } catch {
      return // Symlinks need privileges on some platforms; the helper suite covers this too.
    }

    expect((await rejection(fileContentBody(ctx(root, "escape/secret.txt")))).status).toBe(400)
    expect((await rejection(directoryEntriesBody(ctx(root, "escape")))).status).toBe(400)
  })

  test("an in-root read still succeeds through the same handlers", async () => {
    // The control: the guard rejects escapes without breaking ordinary reads.
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "claxedo-file-ok-"))
    scratch.push(directory)
    await fs.promises.writeFile(path.join(directory, "note.txt"), "hello")

    expect(await fileContentBody(ctx(directory, "note.txt"))).toEqual({ type: "text", content: "hello" })
    // The `absolute` field the client round-trips back as `?path=` still works.
    expect(await fileContentBody(ctx(directory, path.join(directory, "note.txt")))).toEqual({
      type: "text",
      content: "hello",
    })
    expect((await directoryEntriesBody(ctx(directory, "."))).map((entry) => entry.name)).toEqual(["note.txt"])
  })
})
