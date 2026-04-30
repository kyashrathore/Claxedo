import { describe, expect, test } from "vitest"
import { Hono } from "hono"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { DiffRoutes } from "./diff"

const execFileAsync = promisify(execFile)

async function git(directory: string, args: string[]) {
  await execFileAsync("git", args, { cwd: directory })
}

async function withGitRepo(fn: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "claxedo-diff-"))
  try {
    await git(directory, ["init"])
    await git(directory, ["config", "user.email", "test@example.com"])
    await git(directory, ["config", "user.name", "Test User"])
    await writeFile(path.join(directory, "tracked.txt"), "before\n")
    await git(directory, ["add", "."])
    await git(directory, ["commit", "-m", "initial"])
    await fn(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

describe("DiffRoutes", () => {
  test("returns session-review compatible status names", async () => {
    const app = new Hono().route("/api/claxedo/diff", DiffRoutes())

    await withGitRepo(async (directory) => {
      await writeFile(path.join(directory, "tracked.txt"), "after\n")
      await writeFile(path.join(directory, "new.txt"), "new\n")

      const response = await app.request(
        `/api/claxedo/diff/vcs?${new URLSearchParams({ directory, mode: "uncommitted" })}`,
      )
      const diffs = await response.json() as Array<{ file: string; status?: string }>

      expect(response.status).toBe(200)
      expect(diffs.find((diff) => diff.file === "tracked.txt")?.status).toBe("modified")
      expect(diffs.find((diff) => diff.file === "new.txt")?.status).toBe("added")
      expect(diffs.every((diff) => diff.status !== "M" && diff.status !== "A")).toBe(true)
    })
  })

  test("separates uncommitted, staged, and unstaged file sets", async () => {
    const app = new Hono().route("/api/claxedo/diff", DiffRoutes())

    await withGitRepo(async (directory) => {
      await writeFile(path.join(directory, "staged.txt"), "staged\n")
      await writeFile(path.join(directory, "tracked.txt"), "unstaged\n")
      await writeFile(path.join(directory, "new.txt"), "new\n")
      await git(directory, ["add", "staged.txt"])

      const request = async (mode: string) => {
        const response = await app.request(
          `/api/claxedo/diff/vcs?${new URLSearchParams({ directory, mode })}`,
        )
        expect(response.status).toBe(200)
        return (await response.json() as Array<{ file: string }>).map((diff) => diff.file).sort()
      }

      expect(await request("staged")).toEqual(["staged.txt"])
      expect(await request("unstaged")).toEqual(["new.txt", "tracked.txt"])
      expect(await request("uncommitted")).toEqual(["new.txt", "staged.txt", "tracked.txt"])
    })
  })
})
