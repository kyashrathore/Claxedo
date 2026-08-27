import { describe, expect, test } from "bun:test"
import { Hono } from "hono"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { createDiffRoutes, DiffRoutes } from "./diff"

const execFileAsync = promisify(execFile)

async function git(directory: string, args: string[]) {
  await execFileAsync("git", args, { cwd: directory })
}

async function withGitRepo(fn: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "workspace-runtime-diff-"))
  const previous = process.env.WORKSPACE_RUNTIME_DIRECTORY
  try {
    process.env.WORKSPACE_RUNTIME_DIRECTORY = directory
    await git(directory, ["init"])
    await git(directory, ["config", "user.email", "test@example.com"])
    await git(directory, ["config", "user.name", "Test User"])
    await writeFile(path.join(directory, "tracked.txt"), "before\n")
    await git(directory, ["add", "."])
    await git(directory, ["commit", "-m", "initial"])
    await fn(directory)
  } finally {
    if (previous === undefined) delete process.env.WORKSPACE_RUNTIME_DIRECTORY
    else process.env.WORKSPACE_RUNTIME_DIRECTORY = previous
    await rm(directory, { recursive: true, force: true })
  }
}

describe("DiffRoutes", () => {
  test("returns structured validation errors", async () => {
    const app = new Hono().route("/api/wr/diff", DiffRoutes())

    for (const endpoint of ["targets", "vcs", "refs"]) {
      const response = await app.request(`/api/wr/diff/${endpoint}`)
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        error: {
          code: "diff_directory_required",
          message: "Missing required query param: directory",
        },
      })
    }

    await withGitRepo(async (directory) => {
      const response = await app.request(
        `/api/wr/diff/vcs?${new URLSearchParams({ directory, mode: "to-from" })}`,
      )
      expect(response.status).toBe(400)
      expect(await response.json()).toEqual({
        error: {
          code: "diff_refs_required",
          message: "to-from mode requires fromRef and toRef",
        },
      })
    })
  })

  test("keeps untracked files out of uncommitted stats", async () => {
    const app = new Hono().route("/api/wr/diff", DiffRoutes())

    await withGitRepo(async (directory) => {
      await writeFile(path.join(directory, "tracked.txt"), "after\n")
      await writeFile(path.join(directory, "new.txt"), "new\n")

      const request = async (mode: string) => {
        const response = await app.request(
          `/api/wr/diff/vcs?${new URLSearchParams({ directory, mode })}`,
        )
        expect(response.status).toBe(200)
        return (await response.json() as Array<{ file: string }>).map((diff) => diff.file).sort()
      }

      expect(await request("unstaged")).toEqual(["new.txt", "tracked.txt"])
      expect(await request("uncommitted")).toEqual(["tracked.txt"])
    })
  })

  test("loads summaries first and file patches on demand", async () => {
    const app = new Hono().route("/api/wr/diff", DiffRoutes())

    await withGitRepo(async (directory) => {
      await writeFile(path.join(directory, "tracked.txt"), "after\n")

      const summaryResponse = await app.request(
        `/api/wr/diff/vcs?${new URLSearchParams({ directory, mode: "uncommitted", content: "summary" })}`,
      )
      const summaries = await summaryResponse.json() as Array<{
        file: string
        before?: string
        after?: string
        patch?: string
        additions: number
        deletions: number
      }>

      expect(summaryResponse.status).toBe(200)
      expect(summaries).toHaveLength(1)
      expect(summaries[0]).toMatchObject({ file: "tracked.txt", additions: 1, deletions: 1 })
      expect(summaries[0]?.before).toBeUndefined()
      expect(summaries[0]?.after).toBeUndefined()
      expect(summaries[0]?.patch).toBeUndefined()

      const patchResponse = await app.request(
        `/api/wr/diff/vcs/file?${new URLSearchParams({ directory, mode: "uncommitted", file: "tracked.txt" })}`,
      )
      const patch = await patchResponse.json() as { file: string; patch: string }

      expect(patchResponse.status).toBe(200)
      expect(patch.file).toBe("tracked.txt")
      expect(patch.patch).toContain("-before")
      expect(patch.patch).toContain("+after")
    })
  })

  test("uses the pinned workspace directory when relay requests omit directory", async () => {
    const app = new Hono().route("/api/wr/diff", DiffRoutes())

    await withGitRepo(async (directory) => {
      await writeFile(path.join(directory, "tracked.txt"), "after\n")

      const summaryResponse = await app.request(
        `/api/wr/diff/vcs?${new URLSearchParams({ mode: "uncommitted", content: "summary" })}`,
      )
      const patchResponse = await app.request(
        `/api/wr/diff/vcs/file?${new URLSearchParams({ mode: "uncommitted", file: "tracked.txt" })}`,
      )

      expect(summaryResponse.status).toBe(200)
      expect(await summaryResponse.json()).toEqual([
        expect.objectContaining({ file: "tracked.txt", additions: 1, deletions: 1 }),
      ])
      expect(patchResponse.status).toBe(200)
      expect((await patchResponse.json() as { patch: string }).patch).toContain("+after")
    })
  })

  test("rejects caller-selected directories outside the pinned workspace", async () => {
    const app = new Hono().route("/api/wr/diff", DiffRoutes())

    await withGitRepo(async () => {
      const outside = await mkdtemp(path.join(tmpdir(), "workspace-runtime-diff-outside-"))
      try {
        for (const route of [
          `/targets?${new URLSearchParams({ directory: outside })}`,
          `/vcs?${new URLSearchParams({ directory: outside, mode: "uncommitted" })}`,
          `/vcs/file?${new URLSearchParams({ directory: outside, mode: "uncommitted", file: "tracked.txt" })}`,
          `/refs?${new URLSearchParams({ directory: outside })}`,
        ]) {
          const response = await app.request(`/api/wr/diff${route}`)
          expect(response.status).toBe(400)
          expect(await response.json()).toEqual({
            error: {
              code: "diff_invalid_directory",
              message: "Diff directory must match configured workspace",
            },
          })
        }
      } finally {
        await rm(outside, { recursive: true, force: true })
      }
    })
  })

  test("rejects absolute and escaping diff file paths", async () => {
    const app = new Hono().route("/api/wr/diff", DiffRoutes())

    await withGitRepo(async (directory) => {
      for (const file of [
        path.join(directory, "tracked.txt"),
        "../tracked.txt",
        "safe\u0000.txt",
      ]) {
        const response = await app.request(
          `/api/wr/diff/vcs/file?${new URLSearchParams({ directory, mode: "uncommitted", file })}`,
        )
        expect(response.status).toBe(400)
        expect(await response.json()).toEqual({
          error: {
            code: "diff_invalid_file_path",
            message: "Invalid relative diff file path",
          },
        })
      }
    })
  })

  test("rejects unsafe or non-existent range refs before invoking diff", async () => {
    const app = new Hono().route("/api/wr/diff", DiffRoutes())

    await withGitRepo(async (directory) => {
      for (const fromRef of ["-bad", "HEAD~1", "tracked.txt"]) {
        const summary = await app.request(
          `/api/wr/diff/vcs?${new URLSearchParams({ directory, mode: "to-from", fromRef, toRef: "HEAD", content: "summary" })}`,
        )
        expect(summary.status).toBe(400)
        expect(await summary.json()).toEqual({
          error: {
            code: "diff_invalid_ref",
            message: "Invalid git ref",
          },
        })

        const file = await app.request(
          `/api/wr/diff/vcs/file?${new URLSearchParams({ directory, mode: "to-from", fromRef, toRef: "HEAD", file: "tracked.txt" })}`,
        )
        expect(file.status).toBe(400)
        expect(await file.json()).toEqual({
          error: {
            code: "diff_invalid_ref",
            message: "Invalid git ref",
          },
        })
      }
    })
  })

  test("uses -- to separate range refs from file paths", async () => {
    const calls: string[][] = []
    const app = new Hono().route("/api/wr/diff", createDiffRoutes({
      git: async (args) => {
        calls.push(args)
        if (args[0] === "rev-parse") return { stdout: "abc123\n" }
        return { stdout: "" }
      },
    }))

    await withGitRepo(async (directory) => {
      const response = await app.request(
        `/api/wr/diff/vcs/file?${new URLSearchParams({ directory, mode: "range", fromRef: "origin/dev", toRef: "HEAD", file: "-looks-like-option.ts" })}`,
      )
      expect(response.status).toBe(200)
      expect(calls).toContainEqual([
        "diff",
        "--patch",
        "--no-ext-diff",
        "--unified=3",
        "origin/dev",
        "HEAD",
        "--",
        "-looks-like-option.ts",
      ])
    })
  })

  test("limits concurrent git subprocesses per diff route instance", async () => {
    let active = 0
    let maxActive = 0
    const app = new Hono().route("/api/wr/diff", createDiffRoutes({
      gitConcurrency: 2,
      git: async (args) => {
        active += 1
        maxActive = Math.max(maxActive, active)
        await new Promise((resolve) => setTimeout(resolve, 25))
        active -= 1
        if (args[0] === "for-each-ref") return { stdout: "refs/heads/main\0main\0\n" }
        if (args[0] === "tag") return { stdout: "v1\n" }
        return { stdout: "abc123 commit subject\n" }
      },
    }))

    await withGitRepo(async (directory) => {
      const response = await app.request(`/api/wr/diff/refs?${new URLSearchParams({ directory })}`)
      expect(response.status).toBe(200)
      expect(maxActive).toBeLessThanOrEqual(2)
      expect(await response.json()).toEqual({
        branches: ["main"],
        branchChoices: [{ gitRef: "main" }],
        tags: ["v1"],
        recent: [{ hash: "abc123", subject: "commit subject" }],
      })
    })
  })

  test("marks only origin-backed refs as cloud branches and excludes symbolic remote HEAD", async () => {
    const app = new Hono().route("/api/wr/diff", DiffRoutes())

    await withGitRepo(async (directory) => {
      const current = (await execFileAsync("git", ["branch", "--show-current"], { cwd: directory })).stdout.trim()
      await git(directory, ["update-ref", `refs/remotes/origin/${current}`, "HEAD"])
      await git(directory, ["update-ref", "refs/remotes/upstream/feature/e2e", "HEAD"])
      await git(directory, ["symbolic-ref", "refs/remotes/upstream/HEAD", "refs/remotes/upstream/feature/e2e"])

      const response = await app.request(`/api/wr/diff/refs?${new URLSearchParams({ directory })}`)
      const body = await response.json() as {
        branches: string[]
        branchChoices: { gitRef: string; sourceBranch?: string }[]
      }

      expect(response.status).toBe(200)
      expect(body.branchChoices).toContainEqual({ gitRef: current, sourceBranch: current })
      expect(body.branchChoices).toContainEqual({ gitRef: `origin/${current}`, sourceBranch: current })
      expect(body.branchChoices).toContainEqual({ gitRef: "upstream/feature/e2e" })
      expect(body.branches).not.toContain("upstream/HEAD")
      expect(body.branchChoices.some((choice) => choice.gitRef.endsWith("/HEAD"))).toBe(false)
    })
  })

  test("returns 504 when git commands exceed the route timeout", async () => {
    const app = new Hono().route("/api/wr/diff", createDiffRoutes({
      gitTimeoutMs: 5,
      git: async () => await new Promise(() => {}),
    }))

    await withGitRepo(async (directory) => {
      const response = await app.request(`/api/wr/diff/refs?${new URLSearchParams({ directory })}`)
      expect(response.status).toBe(504)
      expect(await response.json()).toEqual({
        error: {
          code: "diff_git_timeout",
          message: "Git command timed out",
        },
      })
    })
  })

  test("uses rename-aware stats for uncommitted files", async () => {
    const app = new Hono().route("/api/wr/diff", DiffRoutes())

    await withGitRepo(async (directory) => {
      await git(directory, ["mv", "tracked.txt", "renamed.txt"])
      await writeFile(path.join(directory, "renamed.txt"), "before\nafter\n")

      const response = await app.request(
        `/api/wr/diff/vcs?${new URLSearchParams({ directory, mode: "uncommitted" })}`,
      )
      const diffs = await response.json() as Array<{ file: string; additions: number; deletions: number }>

      expect(response.status).toBe(200)
      expect(diffs).toHaveLength(1)
      expect(diffs[0]).toMatchObject({ file: "renamed.txt", additions: 1, deletions: 0 })
    })
  })
})
