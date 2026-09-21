import { describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { constants, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import fs from "node:fs/promises"
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { createDiffRuntime, filePatchDiff, uncommittedDiff, unstagedDiff } from "./diff"
import { workspaceFileStatus } from "./file"
import { gitWorktreeStatus } from "./git-worktree"
import { readWorkingTreeText, workspaceRelativeFile } from "./working-tree"

const execFileAsync = promisify(execFile)
const SECRET = "synthetic-secret-value-for-p85\n"

async function git(directory: string, args: string[]) {
  await execFileAsync("git", args, { cwd: directory })
}

type Workspace = {
  directory: string
  outside: string
  secret: string
}

async function withWorkspace(fn: (workspace: Workspace) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "workspace-files-tree-"))
  const outside = await mkdtemp(path.join(tmpdir(), "workspace-files-outside-"))
  try {
    const secret = path.join(outside, "synthetic-secret.txt")
    await writeFile(secret, SECRET)
    await git(directory, ["init"])
    await git(directory, ["config", "user.email", "test@example.com"])
    await git(directory, ["config", "user.name", "Test User"])
    await writeFile(path.join(directory, "tracked.txt"), "before\n")
    await git(directory, ["add", "."])
    await git(directory, ["commit", "-m", "initial"])
    await fn({ directory, outside, secret })
  } finally {
    await rm(directory, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
}

/**
 * Runs `swap` inside the reader's own `open` call, after every path check and
 * before the syscall the descriptor comes from — the exact window a separate
 * classify-then-read pair would have left open.
 */
async function swappingAtOpen(swap: () => void, run: () => Promise<void>) {
  const realOpen = fs.open
  let swapped = false
  fs.open = (async (...args: unknown[]) => {
    fs.open = realOpen
    swap()
    swapped = true
    return await (realOpen as (...rest: unknown[]) => unknown)(...args)
  }) as unknown as typeof fs.open
  try {
    await run()
  } finally {
    fs.open = realOpen
  }
  expect(swapped).toBe(true)
}

/** Runs `run` as Windows sees the filesystem: no no-follow flag for `open` to use. */
async function withoutNoFollowOpen(run: () => Promise<void>) {
  const real = constants.O_NOFOLLOW
  Object.defineProperty(constants, "O_NOFOLLOW", { value: undefined, configurable: true, writable: true })
  try {
    await run()
  } finally {
    Object.defineProperty(constants, "O_NOFOLLOW", { value: real, configurable: true, writable: true })
  }
}

/** Runs `run` on a host that claims to publish descriptor paths, as Linux does. */
async function claimingDescriptorPaths(run: () => Promise<void>) {
  const real = process.platform
  Object.defineProperty(process, "platform", { value: "linux", configurable: true })
  try {
    await run()
  } finally {
    Object.defineProperty(process, "platform", { value: real, configurable: true })
  }
}

function entry<T extends { file: string }>(diffs: T[], file: string) {
  const found = diffs.find((diff) => diff.file === file)
  expect(found).toBeDefined()
  return found!
}

describe("working-tree reads", () => {
  test("an untracked symlink out of the workspace reads as its target path", async () => {
    await withWorkspace(async ({ directory, secret }) => {
      await symlink(secret, path.join(directory, "escape.txt"))
      const runtime = createDiffRuntime()

      const diff = entry(await unstagedDiff(runtime, directory), "escape.txt")
      expect(diff.after).toBe(secret)
      expect(diff.after).not.toContain(SECRET.trim())
      expect(diff.additions).toBe(1)

      const patch = await filePatchDiff({ runtime, directory, mode: "unstaged", file: "escape.txt" })
      expect(patch.after).toBe(secret)
      expect(patch.after).not.toContain(SECRET.trim())

      const status = await workspaceFileStatus(directory)
      expect(status).toContainEqual({ path: "escape.txt", added: 1, removed: 0, status: "added" })

      const worktree = await gitWorktreeStatus(directory)
      expect(worktree.unstaged).toContainEqual({ path: "escape.txt", status: "untracked", additions: 1, deletions: 0 })
    })
  })

  test("a symlink inside the workspace reads as its target path, not the file it points at", async () => {
    await withWorkspace(async ({ directory }) => {
      await writeFile(path.join(directory, "inside.txt"), "inside content\n")
      await symlink("inside.txt", path.join(directory, "inside-link.txt"))

      const diffs = await unstagedDiff(createDiffRuntime(), directory)
      expect(entry(diffs, "inside-link.txt").after).toBe("inside.txt")
      expect(entry(diffs, "inside.txt").after).toBe("inside content\n")
    })
  })

  test("a tracked symlink repointed outside diffs as link text on both sides", async () => {
    await withWorkspace(async ({ directory, secret }) => {
      const pointer = path.join(directory, "pointer.txt")
      await symlink("tracked.txt", pointer)
      await git(directory, ["add", "pointer.txt"])
      await git(directory, ["commit", "-m", "add pointer"])

      await unlink(pointer)
      await symlink(secret, pointer)

      const diff = entry(await uncommittedDiff(createDiffRuntime(), directory), "pointer.txt")
      expect(diff.before).toBe("tracked.txt")
      expect(diff.after).toBe(secret)
      expect(diff.after).not.toContain(SECRET.trim())
    })
  })

  test("a file swapped for a symlink at the open is reported as a link, never read", async () => {
    await withWorkspace(async ({ directory, secret }) => {
      const swapped = path.join(directory, "swapped.txt")
      await writeFile(swapped, "regular content\n")

      let text: string | undefined
      await swappingAtOpen(
        () => {
          unlinkSync(swapped)
          symlinkSync(secret, swapped)
        },
        async () => {
          text = await readWorkingTreeText({ directory, file: "swapped.txt" })
        },
      )

      expect(text).toBe(secret)
      expect(text).not.toContain(SECRET.trim())
    })
  })

  test("a symlink swapped for a file at the open reads the file that is actually opened", async () => {
    await withWorkspace(async ({ directory, secret }) => {
      const swapped = path.join(directory, "swapped.txt")
      await symlink(secret, swapped)

      let text: string | undefined
      await swappingAtOpen(
        () => {
          unlinkSync(swapped)
          writeFileSync(swapped, "regular content\n")
        },
        async () => {
          text = await readWorkingTreeText({ directory, file: "swapped.txt" })
        },
      )

      expect(text).toBe("regular content\n")
    })
  })

  test("without a no-follow open flag a symlink is still reported rather than followed", async () => {
    await withWorkspace(async ({ directory, secret }) => {
      await symlink(secret, path.join(directory, "escape.txt"))
      await writeFile(path.join(directory, "plain.txt"), "regular content\n")

      await withoutNoFollowOpen(async () => {
        const text = await readWorkingTreeText({ directory, file: "escape.txt" })
        expect(text).toBe(secret)
        expect(text).not.toContain(SECRET.trim())
        expect(await readWorkingTreeText({ directory, file: "plain.txt" })).toBe("regular content\n")
      })
    })
  })

  test("without a no-follow open flag a file swapped for a symlink at the open is refused unread", async () => {
    await withWorkspace(async ({ directory, secret }) => {
      const swapped = path.join(directory, "swapped.txt")
      await writeFile(swapped, "regular content\n")

      let text: string | undefined
      await withoutNoFollowOpen(async () => {
        await swappingAtOpen(
          () => {
            unlinkSync(swapped)
            symlinkSync(secret, swapped)
          },
          async () => {
            text = await readWorkingTreeText({ directory, file: "swapped.txt" })
          },
        )
      })

      expect(text).toBeUndefined()
    })
  })

  test.skipIf(process.platform === "linux")("a host that publishes descriptor paths but cannot answer refuses the read", async () => {
    await withWorkspace(async ({ directory }) => {
      await claimingDescriptorPaths(async () => {
        expect(await readWorkingTreeText({ directory, file: "tracked.txt" })).toBeUndefined()
      })
      expect(await readWorkingTreeText({ directory, file: "tracked.txt" })).toBe("before\n")
    })
  })

  test.skipIf(process.platform !== "linux")("a parent swapped for a symlink at the open is not read", async () => {
    await withWorkspace(async ({ directory, outside }) => {
      const sub = path.join(directory, "sub")
      await mkdir(sub)
      await writeFile(path.join(sub, "file.txt"), "inside\n")
      await writeFile(path.join(outside, "file.txt"), SECRET)

      let text: string | undefined
      await swappingAtOpen(
        () => {
          rmSync(sub, { recursive: true, force: true })
          symlinkSync(outside, sub)
        },
        async () => {
          text = await readWorkingTreeText({ directory, file: "sub/file.txt" })
        },
      )

      expect(text).toBeUndefined()
    })
  })

  test("names that begin or end with a space keep their exact spelling", async () => {
    await withWorkspace(async ({ directory }) => {
      for (const [dir, content] of [[" lead", "exact leading\n"], ["lead", "decoy leading\n"], ["trail ", "exact trailing\n"], ["trail", "decoy trailing\n"]]) {
        await mkdir(path.join(directory, dir))
        await writeFile(path.join(directory, dir, "file.txt"), content)
      }
      await writeFile(path.join(directory, "keep "), "exact file\n")
      await writeFile(path.join(directory, "keep"), "decoy file\n")

      expect(await readWorkingTreeText({ directory, file: " lead/file.txt" })).toBe("exact leading\n")
      expect(await readWorkingTreeText({ directory, file: "trail /file.txt" })).toBe("exact trailing\n")
      expect(await readWorkingTreeText({ directory, file: "keep " })).toBe("exact file\n")

      const diffs = await unstagedDiff(createDiffRuntime(), directory)
      expect(entry(diffs, " lead/file.txt").after).toBe("exact leading\n")
      expect(entry(diffs, "trail /file.txt").after).toBe("exact trailing\n")
      expect(entry(diffs, "keep ").after).toBe("exact file\n")
    })
  })

  test("regular files keep reading their content", async () => {
    await withWorkspace(async ({ directory }) => {
      await writeFile(path.join(directory, "tracked.txt"), "after\n")
      await writeFile(path.join(directory, "new.txt"), "new\n")

      const diffs = await unstagedDiff(createDiffRuntime(), directory)
      const tracked = entry(diffs, "tracked.txt")
      expect(tracked.before).toBe("before\n")
      expect(tracked.after).toBe("after\n")
      expect(entry(diffs, "new.txt").after).toBe("new\n")

      const status = await workspaceFileStatus(directory)
      expect(status).toContainEqual({ path: "new.txt", added: 2, removed: 0, status: "added" })
    })
  })

  test("a deleted path reads as empty and stays a deletion", async () => {
    await withWorkspace(async ({ directory }) => {
      await unlink(path.join(directory, "tracked.txt"))

      const diff = entry(await uncommittedDiff(createDiffRuntime(), directory), "tracked.txt")
      expect(diff.status).toBe("deleted")
      expect(diff.before).toBe("before\n")
      expect(diff.after).toBe("")

      expect(await workspaceFileStatus(directory)).toContainEqual({
        path: "tracked.txt",
        added: 0,
        removed: 0,
        status: "deleted",
      })
    })
  })

  test("paths that leave the workspace read as nothing", async () => {
    await withWorkspace(async ({ directory, outside, secret }) => {
      await symlink(outside, path.join(directory, "escape-dir"))

      expect(await readWorkingTreeText({ directory, file: path.relative(directory, secret) })).toBeUndefined()
      expect(await readWorkingTreeText({ directory, file: secret })).toBeUndefined()
      expect(await readWorkingTreeText({ directory, file: "escape-dir/synthetic-secret.txt" })).toBeUndefined()
      expect(await readWorkingTreeText({ directory, file: "missing.txt" })).toBeUndefined()
      expect(await readWorkingTreeText({ directory, file: "tracked.txt" })).toBe("before\n")
    })
  })

  test("only relative in-workspace paths are accepted", () => {
    expect(workspaceRelativeFile("src/index.ts")).toBe("src/index.ts")
    expect(workspaceRelativeFile("")).toBeUndefined()
    expect(workspaceRelativeFile("../escape.txt")).toBeUndefined()
    expect(workspaceRelativeFile("src/../../escape.txt")).toBeUndefined()
    expect(workspaceRelativeFile("/etc/passwd")).toBeUndefined()
    expect(workspaceRelativeFile("src/\0.ts")).toBeUndefined()
  })
})
