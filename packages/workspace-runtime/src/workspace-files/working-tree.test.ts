import { describe, expect, test } from "bun:test"
import { execFile } from "node:child_process"
import { constants, linkSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs"
import fs from "node:fs/promises"
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { createDiffRuntime, filePatchDiff, uncommittedDiff, unstagedDiff } from "./diff"
import { workspaceFileStatus } from "./file"
import { gitWorktreeStatus } from "./git-worktree"
import { dosPathFromFinalPath, readWorkingTreeText, workspaceRelativeFile } from "./working-tree"

const execFileAsync = promisify(execFile)
const SECRET = "synthetic-secret-value-for-p85\n"

const onWindows = process.platform === "win32"
/** The native lane promises these properties are checked, so an unmet precondition there is a failure, not a skip. */
const demandedOnWindows = onWindows && process.env.CLAXEDO_WINDOWS_ACL_ACCEPTANCE === "1"

// Loaded koffi libraries and their bound functions must stay reachable for the
// suite's life: a collected one finalizes mid-flight, and Bun panics when that
// finalizer runs inside GC.
const darwinHandles: unknown[] = []

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

type ReaderCall = "open" | "lstat"

/**
 * Runs `swap` inside the reader's own `open` or `lstat` call, after every path
 * check and before that syscall — the exact window a separate classify-then-read
 * pair would have left open. `lstat` is the classification a host without a
 * no-follow flag performs first, so a swap there is seen by the classification
 * and the open alike.
 */
async function swappingAt(call: ReaderCall, swap: () => void, run: () => Promise<void>) {
  const calls = fs as unknown as Record<ReaderCall, (...args: unknown[]) => Promise<unknown>>
  const real = calls[call]
  let swapped = false
  calls[call] = async (...args) => {
    calls[call] = real
    swap()
    swapped = true
    return await real(...args)
  }
  try {
    await run()
  } finally {
    calls[call] = real
  }
  expect(swapped).toBe(true)
}

/** A directory symlink needs a privilege on Windows that a lane may not hold; a junction needs none. */
function canSymlinkDirectory() {
  const probe = mkdtempSync(path.join(tmpdir(), "workspace-files-symlink-probe-"))
  try {
    symlinkSync(path.join(probe, "nothing"), path.join(probe, "link"), "dir")
    return true
  } catch {
    return false
  } finally {
    rmSync(probe, { recursive: true, force: true })
  }
}

/**
 * Swaps the parent directory for `link` to the outside directory inside the
 * reader's `call`. At `lstat` the classification and the open both see the
 * same outside file, so the inode identity agrees and only the descriptor's
 * reported path can refuse; at `open` the identity alone refuses.
 */
async function parentSwappedFor(link: "junction" | "dir", call: ReaderCall) {
  await withWorkspace(async ({ directory, outside }) => {
    const sub = path.join(directory, "sub")
    await mkdir(sub)
    await writeFile(path.join(sub, "file.txt"), "inside\n")
    await writeFile(path.join(outside, "file.txt"), SECRET)

    let text: string | undefined
    await swappingAt(
      call,
      () => {
        rmSync(sub, { recursive: true, force: true })
        symlinkSync(outside, sub, link)
      },
      async () => {
        text = await readWorkingTreeText({ directory, file: "sub/file.txt" })
      },
    )

    expect(text).toBeUndefined()
  })
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

  test.skipIf(constants.O_NOFOLLOW === undefined)("a file swapped for a symlink at the open is reported as a link, never read", async () => {
    await withWorkspace(async ({ directory, secret }) => {
      const swapped = path.join(directory, "swapped.txt")
      await writeFile(swapped, "regular content\n")

      let text: string | undefined
      await swappingAt(
        "open",
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

  test.skipIf(constants.O_NOFOLLOW === undefined)("a symlink swapped for a file at the open reads the file that is actually opened", async () => {
    await withWorkspace(async ({ directory, secret }) => {
      const swapped = path.join(directory, "swapped.txt")
      await symlink(secret, swapped)

      let text: string | undefined
      await swappingAt(
        "open",
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
        await swappingAt(
          "open",
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

  test.skipIf(process.platform === "win32")("a parent swapped for a symlink at the open is not read", async () => {
    await withWorkspace(async ({ directory, outside }) => {
      const sub = path.join(directory, "sub")
      await mkdir(sub)
      await writeFile(path.join(sub, "file.txt"), "inside\n")
      await writeFile(path.join(outside, "file.txt"), SECRET)

      let text: string | undefined
      await swappingAt(
        "open",
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

  test.skipIf(!onWindows)("a parent swapped for a junction at the classification is not read", async () => {
    await parentSwappedFor("junction", "lstat")
  })

  test.skipIf(!onWindows)("a parent swapped for a junction at the open is not read", async () => {
    await parentSwappedFor("junction", "open")
  })

  test.skipIf(!onWindows)("a parent swapped for a directory symlink at the classification is not read", async () => {
    if (!canSymlinkDirectory()) {
      // Creating one needs a privilege this host does not hold. Saying so is
      // the point; reporting a pass would claim a property nothing checked.
      if (demandedOnWindows) throw new Error("this host cannot create a directory symbolic link, so the property is unproven")
      return
    }
    await parentSwappedFor("dir", "lstat")
  })

  test.skipIf(!onWindows)("a file inside the workspace reads under any spelling of the root's case", async () => {
    await withWorkspace(async ({ directory }) => {
      await mkdir(path.join(directory, "sub"))
      await writeFile(path.join(directory, "sub", "file.txt"), "inside\n")

      expect(await readWorkingTreeText({ directory, file: "sub/file.txt" })).toBe("inside\n")
      expect(await readWorkingTreeText({ directory: directory.toLowerCase(), file: "sub/file.txt" })).toBe("inside\n")
      expect(await readWorkingTreeText({ directory: directory.toUpperCase(), file: "tracked.txt" })).toBe("before\n")
    })
  })

  test("a final path from the OS is spelled as the DOS path the containment check reads", () => {
    expect(dosPathFromFinalPath("\\\\?\\C:\\work\\file.txt")).toBe("C:\\work\\file.txt")
    expect(dosPathFromFinalPath("\\\\?\\UNC\\host\\share\\work\\file.txt")).toBe("\\\\host\\share\\work\\file.txt")
    expect(dosPathFromFinalPath("C:\\work\\file.txt")).toBe("C:\\work\\file.txt")
  })

  test("a file swapped for a hardlink of itself at the open is the same bytes and reads", async () => {
    await withWorkspace(async ({ directory }) => {
      const original = path.join(directory, "original.txt")
      const alias = path.join(directory, "alias.txt")
      await writeFile(original, "shared bytes\n")
      linkSync(original, alias)

      let text: string | undefined
      await withoutNoFollowOpen(async () => {
        await swappingAt(
          "open",
          () => {
            unlinkSync(alias)
            linkSync(original, alias)
          },
          async () => {
            text = await readWorkingTreeText({ directory, file: "alias.txt" })
          },
        )
      })

      expect(text).toBe("shared bytes\n")
    })
  })

  test("a file swapped for a hardlink of an outside file at the open is refused unread", async () => {
    await withWorkspace(async ({ directory, secret }) => {
      const swapped = path.join(directory, "swapped.txt")
      await writeFile(swapped, "regular content\n")

      let text: string | undefined
      await withoutNoFollowOpen(async () => {
        await swappingAt(
          "open",
          () => {
            unlinkSync(swapped)
            linkSync(secret, swapped)
          },
          async () => {
            text = await readWorkingTreeText({ directory, file: "swapped.txt" })
          },
        )
      })

      expect(text).toBeUndefined()
    })
  })

  test.skipIf(process.platform !== "darwin")("a parent rename-exchanged for a symlink at the open is not read", async () => {
    await withWorkspace(async ({ directory, outside }) => {
      const sub = path.join(directory, "sub")
      const slot = path.join(directory, "slot")
      await mkdir(sub)
      await writeFile(path.join(sub, "file.txt"), "inside\n")
      await writeFile(path.join(outside, "file.txt"), SECRET)
      await symlink(outside, slot)

      const { load } = await import("koffi")
      const lib = load("libSystem.B.dylib")
      const renamex = lib.func("int renamex_np(const char *from, const char *to, unsigned int flags)")
      darwinHandles.push(lib, renamex)
      const RENAME_SWAP = 0x2

      let text: string | undefined
      await swappingAt(
        "open",
        () => {
          expect(renamex(slot, sub, RENAME_SWAP)).toBe(0)
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
