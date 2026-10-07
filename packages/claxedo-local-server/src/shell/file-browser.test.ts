import fs from "fs"
import os from "os"
import path from "path"
import { HTTPException } from "hono/http-exception"
import { afterEach, describe, expect, test } from "vitest"
import { allFilesBody, directoryEntriesBody, findFilesBody } from "./file-browser"
import { git } from "./git"

const scratch: string[] = []

async function expectGitFilenamePreserved(name: string) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "claxedo-git-filenames-"))
  scratch.push(directory)
  await git(directory, ["init"])
  await fs.promises.writeFile(path.join(directory, name), "")
  expect(await allFilesBody(ctx(directory, "."))).toEqual({ paths: [name] })
  expect(await findFilesBody({
    req: {
      query: (key) => key === "directory" ? directory : key === "dirs" ? "false" : "",
      header: () => undefined,
    },
  })).toEqual([name])
}

test("preserves whitespace and unicode in Git filenames on listing and search handlers", async () => {
  await expectGitFilenamePreserved(" 雪 furniture notes.txt")
})

// NTFS refuses a newline in a name and drops a trailing space.
test.skipIf(process.platform === "win32")("preserves newlines and trailing whitespace in Git filenames on listing and search handlers", async () => {
  await expectGitFilenamePreserved(" 雪 furniture\nnotes.txt ")
})

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

/**
 * `directoryEntriesBody` wraps its `fs` call in a catch that degrades to `[]`.
 * `workspacePath()` is awaited OUTSIDE that catch on purpose: moved inside, a
 * traversal probe would be answered with a plausible 200 and the rejection
 * would vanish. Nothing in the helper's own tests can catch that regression,
 * because it is a property of where the call sits in the body function.
 */
describe("the containment rejection is not swallowed by the fs catch", () => {
  const outside = ["../../../etc/passwd", "/etc/passwd"]

  test.each(outside)("directoryEntriesBody rejects %s instead of returning an empty listing", async (target) => {
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "claxedo-dir-escape-"))
    scratch.push(directory)

    expect(await rejection(directoryEntriesBody(ctx(directory, target)))).toEqual({
      status: 400,
      body: {
        error: {
          code: "claxedo_path_outside_workspace",
          message: "path resolves outside the workspace root",
        },
      },
    })
  })

  test("a symlink inside the root pointing outward is refused", async () => {
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

    expect((await rejection(directoryEntriesBody(ctx(root, "escape")))).status).toBe(400)
  })

  test("an in-root listing still succeeds through the same handler", async () => {
    // The control: the guard rejects escapes without breaking ordinary reads.
    const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), "claxedo-file-ok-"))
    scratch.push(directory)
    await fs.promises.writeFile(path.join(directory, "note.txt"), "hello")

    expect((await directoryEntriesBody(ctx(directory, "."))).map((entry) => entry.name)).toEqual(["note.txt"])
    // The `absolute` field the client round-trips back as `?path=` still works.
    expect((await directoryEntriesBody(ctx(directory, directory))).map((entry) => entry.name)).toEqual(["note.txt"])
  })
})
