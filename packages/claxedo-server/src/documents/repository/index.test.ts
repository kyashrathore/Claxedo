import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, test } from "vitest"
import { DocumentPathError, DocumentVersionConflictError } from "../errors"
import { documentWorkspaceConformance } from "../port-conformance"
import type { DocumentActor, DocumentEntry, SnapshotID, SnapshotRef } from "../port"
import { MAX_SNAPSHOT_METADATA_BYTES } from "../snapshot-pins"
import { contentHash } from "../version"
import {
  createLocalRepositoryFileAuthority,
  createLocalRepositoryGitAuthority,
  createRepositoryDocumentWorkspace,
  type LocalRepositoryFileAuthorityOptions,
  type LocalRepositoryGitAuthorityOptions,
  type RepositoryGitRun,
  RepositoryGitConflictError,
} from "./index"

const execFileAsync = promisify(execFile)
const actor: DocumentActor = { type: "user", id: "repository-test" }
const roots: string[] = []

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function git(root: string, args: readonly string[], options?: Parameters<RepositoryGitRun>[2]) {
  return (
    await execFileAsync("git", [...args], {
      cwd: root,
      env: { ...process.env, ...options?.env },
    })
  ).stdout.trim()
}

async function fixture(
  options: Readonly<{
    files?: LocalRepositoryFileAuthorityOptions
    git?: LocalRepositoryGitAuthorityOptions
  }> = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-repository-document-"))
  roots.push(root)
  await git(root, ["init"])
  await git(root, ["config", "user.email", "documents@example.com"])
  await git(root, ["config", "user.name", "Documents Test"])
  await fs.writeFile(path.join(root, "doc.md"), "# Initial\n")
  await git(root, ["add", "doc.md"])
  await git(root, ["commit", "-m", "initial"])
  const workspaces = new Map([["workspace-1", root]])
  const workspace = repositoryWorkspace(workspaces, options)
  const entry = {
    origin: "repository",
    placement: "local",
    projectId: "project-1",
    documentId: "document-1",
    workspaceId: "workspace-1",
    relativePath: "doc.md",
  } as const satisfies DocumentEntry
  return { root, workspaces, workspace, entry }
}

function repositoryWorkspace(
  workspaces: Map<string, string>,
  options: Readonly<{
    files?: LocalRepositoryFileAuthorityOptions
    git?: LocalRepositoryGitAuthorityOptions
  }> = {},
) {
  return createRepositoryDocumentWorkspace({
    workspace: {
      resolve: async (workspaceId) => {
        const directory = workspaces.get(workspaceId)
        return directory ? { directory } : undefined
      },
    },
    files: createLocalRepositoryFileAuthority(options.files),
    git: createLocalRepositoryGitAuthority(
      (args, directory, runOptions) => git(directory, args, runOptions),
      options.git,
    ),
  })
}

describe("repository document workspace conformance", () => {
  documentWorkspaceConformance(async () => {
    const value = await fixture()
    return {
      workspace: value.workspace,
      entry: value.entry,
      dispose: async () => undefined,
    }
  })
})

describe("repository document recovery and Git contracts", () => {
  test("a committed repository write remains successful when snapshot bookkeeping fails", async () => {
    const value = await fixture({
      git: {
        faults: {
          beforeSnapshotContentWrite() {
            throw new Error("snapshot storage unavailable")
          },
        },
      },
    })
    const handle = await value.workspace.resolve(value.entry)
    const initial = await value.workspace.read(handle)

    const written = await value.workspace.write(handle, {
      markdown: "committed despite bookkeeping failure\n",
      expectedVersion: initial.version,
      actor,
    })
    expect(written).toMatchObject({ markdown: "committed despite bookkeeping failure\n" })
    expect(written.snapshot).toBeUndefined()
    await expect(fs.readFile(path.join(value.root, "doc.md"), "utf8")).resolves.toBe(
      "committed despite bookkeeping failure\n",
    )
  })

  test("EC-C1 reports a deleted file as missing without losing its index identity", async () => {
    const value = await fixture()
    const handle = await value.workspace.resolve(value.entry)
    await fs.rm(path.join(value.root, "doc.md"))

    await expect(value.workspace.availability(value.entry)).resolves.toEqual({ state: "missing" })
    await expect(value.workspace.read(handle)).rejects.toMatchObject({ code: "document_not_found" })
  })

  test("EC-C2 detects a moved file by content version and relocates only to the expected content", async () => {
    const value = await fixture()
    const handle = await value.workspace.resolve(value.entry)
    const current = await value.workspace.read(handle)
    await fs.mkdir(path.join(value.root, "notes"))
    await fs.rename(path.join(value.root, "doc.md"), path.join(value.root, "notes", "moved.md"))

    await expect(value.workspace.availability(value.entry, current.version)).resolves.toEqual({
      state: "moved",
      relativePath: path.join("notes", "moved.md"),
    })
    const relocated = await value.workspace.relocate(value.entry, "notes/moved.md", current.version)
    await expect(value.workspace.read(relocated)).resolves.toMatchObject({ markdown: "# Initial\n" })
    await expect(
      value.workspace.relocate(value.entry, "notes/moved.md", "stale" as typeof current.version),
    ).rejects.toBeInstanceOf(DocumentVersionConflictError)
  })

  test("EC-C2 does not guess a moved path when multiple files have the same content", async () => {
    const value = await fixture()
    const handle = await value.workspace.resolve(value.entry)
    const current = await value.workspace.read(handle)
    await fs.writeFile(path.join(value.root, "copy-one.md"), "# Initial\n")
    await fs.writeFile(path.join(value.root, "copy-two.md"), "# Initial\n")
    await fs.rm(path.join(value.root, "doc.md"))

    await expect(value.workspace.availability(value.entry, current.version)).resolves.toEqual({ state: "missing" })
  })

  test("EC-C3 branch switches change the content version and stale writes conflict", async () => {
    const value = await fixture()
    const handle = await value.workspace.resolve(value.entry)
    const initial = await value.workspace.read(handle)
    await git(value.root, ["checkout", "-b", "other"])
    await fs.writeFile(path.join(value.root, "doc.md"), "# Other branch\n")
    await git(value.root, ["commit", "-am", "other branch"])

    const switched = await value.workspace.read(handle)
    expect(switched.version).not.toBe(initial.version)
    await expect(
      value.workspace.write(handle, {
        markdown: "human draft",
        expectedVersion: initial.version,
        actor,
      }),
    ).rejects.toMatchObject({
      code: "document_version_conflict",
      currentVersion: switched.version,
    })
    expect(await fs.readFile(path.join(value.root, "doc.md"), "utf8")).toBe("# Other branch\n")
  })

  test("EC-C4 preserves merge-conflict markers as text and exposes a source-mode hint", async () => {
    const value = await fixture()
    await fs.writeFile(path.join(value.root, "doc.md"), "<<<<<<< ours\nleft\n=======\nright\n>>>>>>> theirs\n")
    const handle = await value.workspace.resolve(value.entry)

    await expect(value.workspace.read(handle)).resolves.toMatchObject({
      markdown: "<<<<<<< ours\nleft\n=======\nright\n>>>>>>> theirs\n",
      sourceHint: "merge-conflict-markers",
    })
  })

  test("EC-C5 resolves one stable repository identity for the same indexed path", async () => {
    const value = await fixture()
    expect(await value.workspace.identityKey(value.entry)).toBe(await value.workspace.identityKey({ ...value.entry }))
    expect(await value.workspace.resolve(value.entry)).toEqual(await value.workspace.resolve({ ...value.entry }))
  })

  test("EC-C6 rejects traversal, absolute paths, and symlink escapes", async () => {
    const value = await fixture()
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-repository-outside-"))
    roots.push(outside)
    await fs.writeFile(path.join(outside, "outside.md"), "outside")
    await fs.symlink(path.join(outside, "outside.md"), path.join(value.root, "escape.md"))
    await fs.symlink(outside, path.join(value.root, "escape-directory"))

    for (const relativePath of [
      "../outside.md",
      path.join(value.root, "doc.md"),
      "escape.md",
      "escape-directory/outside.md",
    ]) {
      await expect(value.workspace.resolve({ ...value.entry, relativePath })).rejects.toBeInstanceOf(DocumentPathError)
    }
  })

  test("canonical identity deduplicates in-root symlink and configured case aliases", async () => {
    const value = await fixture({ files: { caseInsensitive: true } })
    await fs.symlink(path.join(value.root, "doc.md"), path.join(value.root, "alias.md"))

    const canonical = await value.workspace.identityKey(value.entry)
    expect(await value.workspace.identityKey({ ...value.entry, relativePath: "alias.md" })).toBe(canonical)
    expect(await value.workspace.identityKey({ ...value.entry, relativePath: "DOC.md" })).toBe(canonical)
    value.workspaces.set("workspace-alias", value.root)
    expect(await value.workspace.identityKey({ ...value.entry, workspaceId: "workspace-alias" })).toBe(canonical)
  })

  test("CAS preserves a competing pathname writer after the old authority is claimed", async () => {
    const value = await fixture({
      files: {
        faults: {
          afterAuthorityClaimed: async ({ target }) => fs.writeFile(target, "competing pathname writer\n"),
        },
      },
    })
    const handle = await value.workspace.resolve(value.entry)
    const current = await value.workspace.read(handle)

    await expect(
      value.workspace.write(handle, {
        markdown: "human draft\n",
        expectedVersion: current.version,
        actor,
      }),
    ).rejects.toMatchObject({ code: "document_version_conflict" })
    expect(await fs.readFile(path.join(value.root, "doc.md"), "utf8")).toBe("competing pathname writer\n")
  })

  test("CAS preserves a writer that changes the newly installed pathname inode", async () => {
    const value = await fixture({
      files: {
        faults: {
          afterReplacementInstalled: async ({ target }) => fs.writeFile(target, "new-target writer\n"),
        },
      },
    })
    const handle = await value.workspace.resolve(value.entry)
    const current = await value.workspace.read(handle)

    await expect(
      value.workspace.write(handle, {
        markdown: "human draft\n",
        expectedVersion: current.version,
        actor,
      }),
    ).rejects.toMatchObject({ code: "document_version_conflict" })
    expect(await fs.readFile(path.join(value.root, "doc.md"), "utf8")).toBe("new-target writer\n")
  })

  test("CAS rollback bounds a writer that enlarges the newly installed file", async () => {
    const oversized = "x".repeat(2 * 1024 * 1024 + 1)
    const value = await fixture({
      files: {
        faults: {
          afterReplacementInstalled: async ({ target }) => fs.writeFile(target, oversized),
        },
      },
    })
    const handle = await value.workspace.resolve(value.entry)
    const current = await value.workspace.read(handle)

    await expect(
      value.workspace.write(handle, {
        markdown: "human draft\n",
        expectedVersion: current.version,
        actor,
      }),
    ).rejects.toMatchObject({ code: "document_too_large" })
    expect((await fs.stat(path.join(value.root, "doc.md"))).size).toBe(Buffer.byteLength(oversized))
  })

  test("CAS preserves a retained-descriptor writer on the claimed old inode", async () => {
    let retained: Awaited<ReturnType<typeof fs.open>> | undefined
    const value = await fixture({
      files: {
        faults: {
          afterReplacementInstalled: async () => {
            await retained!.truncate(0)
            await retained!.writeFile("retained descriptor writer\n")
            await retained!.sync()
          },
        },
      },
    })
    retained = await fs.open(path.join(value.root, "doc.md"), "r+")
    const handle = await value.workspace.resolve(value.entry)
    const current = await value.workspace.read(handle)
    try {
      await expect(
        value.workspace.write(handle, {
          markdown: "human draft\n",
          expectedVersion: current.version,
          actor,
        }),
      ).rejects.toMatchObject({ code: "document_version_conflict" })
    } finally {
      await retained.close()
    }
    expect(await fs.readFile(path.join(value.root, "doc.md"), "utf8")).toBe("retained descriptor writer\n")
  })

  test("CAS aborts without following a parent directory replaced by an escaping symlink", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-repository-parent-swap-"))
    roots.push(outside)
    let detached = ""
    const value = await fixture({
      files: {
        faults: {
          afterAuthorityClaimed: async ({ target }) => {
            const parent = path.dirname(target)
            detached = `${parent}-detached`
            await fs.rename(parent, detached)
            await fs.symlink(outside, parent)
          },
        },
      },
    })
    await fs.mkdir(path.join(value.root, "nested"))
    await fs.rename(path.join(value.root, "doc.md"), path.join(value.root, "nested", "doc.md"))
    const nestedEntry = { ...value.entry, relativePath: "nested/doc.md" }
    const handle = await value.workspace.resolve(nestedEntry)
    const current = await value.workspace.read(handle)

    await expect(
      value.workspace.write(handle, {
        markdown: "must stay contained\n",
        expectedVersion: current.version,
        actor,
      }),
    ).rejects.toBeInstanceOf(DocumentPathError)
    expect(await fs.readdir(outside)).toEqual([])

    await fs.rm(path.join(value.root, "nested"))
    await fs.rename(detached, path.join(value.root, "nested"))
  })

  test("EC-C7 reports workspace deletion as unavailable instead of a blank document", async () => {
    const value = await fixture()
    value.workspaces.delete("workspace-1")
    await fs.rm(value.root, { recursive: true, force: true })

    await expect(value.workspace.availability(value.entry)).resolves.toEqual({ state: "workspace-unavailable" })
    await expect(value.workspace.resolve(value.entry)).rejects.toMatchObject({ state: "workspace-unavailable" })
  })

  test("EC-C8 dirty and untracked Git snapshots conflict without changing either file", async () => {
    const value = await fixture()
    const handle = await value.workspace.resolve(value.entry)
    const evidence = await value.workspace.gitSnapshot(handle)
    await fs.writeFile(path.join(value.root, "doc.md"), "dirty draft\n")

    await expect(value.workspace.gitSnapshot(handle)).rejects.toMatchObject({
      code: "git_source_conflict",
      evidence: { currentCommit: evidence.head, dirty: true },
    })
    expect(await fs.readFile(path.join(value.root, "doc.md"), "utf8")).toBe("dirty draft\n")

    await fs.writeFile(path.join(value.root, "new.md"), "untracked draft\n")
    const untracked = await value.workspace.resolve({
      ...value.entry,
      documentId: "document-2",
      relativePath: "new.md",
    })
    await expect(value.workspace.gitSnapshot(untracked)).rejects.toBeInstanceOf(RepositoryGitConflictError)
    expect(await fs.readFile(path.join(value.root, "new.md"), "utf8")).toBe("untracked draft\n")
  })

  test("EC-C9 moved base commit and blob conflicts preserve the requested draft and disk", async () => {
    const value = await fixture()
    const handle = await value.workspace.resolve(value.entry)
    const base = await value.workspace.gitSnapshot(handle)
    await fs.writeFile(path.join(value.root, "other.txt"), "advance\n")
    await git(value.root, ["add", "other.txt"])
    await git(value.root, ["commit", "-m", "advance base"])

    await expect(
      value.workspace.commit(handle, {
        markdown: "human draft\n",
        message: "update document",
        expected: { baseCommit: base.head, baseBlobSha: base.blobSha },
      }),
    ).rejects.toMatchObject({ code: "git_source_conflict" })
    expect(await fs.readFile(path.join(value.root, "doc.md"), "utf8")).toBe("# Initial\n")

    const moved = await value.workspace.gitSnapshot(handle)
    await fs.writeFile(path.join(value.root, "doc.md"), "agent edit\n")
    await git(value.root, ["commit", "-am", "agent edit"])
    await expect(
      value.workspace.commit(handle, {
        markdown: "second human draft\n",
        message: "stale blob",
        expected: { baseCommit: moved.head, baseBlobSha: moved.blobSha },
      }),
    ).rejects.toMatchObject({ code: "git_source_conflict" })
    expect(await fs.readFile(path.join(value.root, "doc.md"), "utf8")).toBe("agent edit\n")
  })

  test("repository-global commit serialization makes different-path same-base commits conflict cleanly", async () => {
    const entered = deferred()
    const release = deferred()
    let calls = 0
    const value = await fixture({
      git: {
        faults: {
          afterContentInstalled: async () => {
            calls++
            if (calls === 1) {
              entered.resolve()
              await release.promise
            }
          },
        },
      },
    })
    await fs.writeFile(path.join(value.root, "second.md"), "second\n")
    await git(value.root, ["add", "second.md"])
    await git(value.root, ["commit", "-m", "second file"])
    const first = await value.workspace.resolve(value.entry)
    const second = await value.workspace.resolve({
      ...value.entry,
      documentId: "document-2",
      relativePath: "second.md",
    })
    const firstBase = await value.workspace.gitSnapshot(first)
    const secondBase = await value.workspace.gitSnapshot(second)
    const firstCommit = value.workspace.commit(first, {
      markdown: "first committed\n",
      message: "first commit",
      expected: { baseCommit: firstBase.head, baseBlobSha: firstBase.blobSha },
    })
    await entered.promise
    let secondEntered = false
    const secondCommit = value.workspace
      .commit(second, {
        markdown: "second committed\n",
        message: "second commit",
        expected: { baseCommit: secondBase.head, baseBlobSha: secondBase.blobSha },
      })
      .finally(() => {
        secondEntered = true
      })
    await Promise.resolve()
    expect(secondEntered).toBe(false)
    release.resolve()

    await expect(firstCommit).resolves.toMatchObject({ commit: expect.any(String) })
    await expect(secondCommit).rejects.toMatchObject({ code: "git_source_conflict" })
    expect(await fs.readFile(path.join(value.root, "second.md"), "utf8")).toBe("second\n")
  })

  test("commit rechecks HEAD before its atomic update and conditionally rolls back its own content", async () => {
    const value = await fixture({
      git: {
        faults: {
          beforeHeadUpdate: async ({ repoRoot }) => {
            await fs.writeFile(path.join(repoRoot, "external.txt"), "external\n")
            await git(repoRoot, ["add", "external.txt"])
            await git(repoRoot, ["commit", "-m", "external head"])
          },
        },
      },
    })
    const handle = await value.workspace.resolve(value.entry)
    const base = await value.workspace.gitSnapshot(handle)

    await expect(
      value.workspace.commit(handle, {
        markdown: "human draft\n",
        message: "human commit",
        expected: { baseCommit: base.head, baseBlobSha: base.blobSha },
      }),
    ).rejects.toMatchObject({ code: "git_source_conflict" })
    expect(await git(value.root, ["log", "-1", "--pretty=%s"])).toBe("external head")
    expect(await fs.readFile(path.join(value.root, "doc.md"), "utf8")).toBe("# Initial\n")
  })

  test("commit never rolls back over a concurrent worktree writer after the temporary index is fixed", async () => {
    const value = await fixture({
      git: {
        faults: {
          afterTemporaryIndexAdd: async ({ target }) => fs.writeFile(target, "external worktree bytes\n"),
        },
      },
    })
    const handle = await value.workspace.resolve(value.entry)
    const base = await value.workspace.gitSnapshot(handle)

    await expect(
      value.workspace.commit(handle, {
        markdown: "human draft\n",
        message: "human commit",
        expected: { baseCommit: base.head, baseBlobSha: base.blobSha },
      }),
    ).rejects.toMatchObject({ code: "git_source_conflict" })
    expect(await fs.readFile(path.join(value.root, "doc.md"), "utf8")).toBe("external worktree bytes\n")
    expect(await git(value.root, ["rev-parse", "HEAD"])).toBe(base.head)
  })

  test("a post-ref external write remains dirty while the requested commit succeeds", async () => {
    const value = await fixture({
      git: {
        faults: {
          afterHeadUpdate: async ({ target }) => fs.writeFile(target, "post-ref writer\n"),
        },
      },
    })
    const handle = await value.workspace.resolve(value.entry)
    const base = await value.workspace.gitSnapshot(handle)

    await expect(
      value.workspace.commit(handle, {
        markdown: "committed bytes\n",
        message: "committed safely",
        expected: { baseCommit: base.head, baseBlobSha: base.blobSha },
      }),
    ).resolves.toMatchObject({ commit: expect.any(String) })
    expect(await git(value.root, ["show", "HEAD:doc.md"])).toBe("committed bytes")
    expect(await fs.readFile(path.join(value.root, "doc.md"), "utf8")).toBe("post-ref writer\n")
    expect(await git(value.root, ["status", "--porcelain", "--", "doc.md"])).not.toBe("")
  })

  test("repairs a snapshot interrupted between its content and metadata writes", async () => {
    const value = await fixture()
    const handle = await value.workspace.resolve(value.entry)
    const markdown = (await value.workspace.read(handle)).markdown
    const id = contentHash(markdown)
    const directory = path.join(value.root, ".git", "claxedo-document-snapshots", "document-1")
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(path.join(directory, `${id}.md`), markdown, { mode: 0o400 })

    await expect(value.workspace.snapshot(handle, { reason: "recovered", actor })).resolves.toMatchObject({ id })
    await expect(fs.readFile(path.join(directory, `${id}.json`), "utf8")).resolves.toContain('"reason":"recovered"')
  })

  test("returns typed missing and corrupt repository snapshot failures", async () => {
    const value = await fixture()
    const handle = await value.workspace.resolve(value.entry)
    await expect(value.workspace.readSnapshot(handle, "missing" as SnapshotID)).rejects.toMatchObject({
      code: "document_snapshot_not_found",
    })
    const snapshot = await value.workspace.snapshot(handle, { reason: "corrupt", actor })
    const content = path.join(value.root, ".git", "claxedo-document-snapshots", "document-1", `${snapshot.id}.md`)
    await fs.chmod(content, 0o600)
    await fs.writeFile(content, "corrupt")
    await expect(value.workspace.readSnapshot(handle, snapshot.id)).rejects.toMatchObject({
      code: "document_snapshot_corrupt",
    })
  })

  test("bounds and repairs oversized repository snapshot content during capture", async () => {
    const value = await fixture()
    const handle = await value.workspace.resolve(value.entry)
    const markdown = (await value.workspace.read(handle)).markdown
    const snapshot = await value.workspace.snapshot(handle, { reason: "bounded capture", actor })
    const content = path.join(
      value.root,
      ".git",
      "claxedo-document-snapshots",
      "document-1",
      `${snapshot.id}.md`,
    )
    await fs.chmod(content, 0o600)
    await fs.writeFile(content, "x".repeat(2 * 1024 * 1024 + 1))

    await expect(value.workspace.snapshot(handle, { reason: "repair oversized", actor })).resolves.toMatchObject({
      id: snapshot.id,
    })
    expect((await fs.stat(content)).size).toBe(Buffer.byteLength(markdown))
  })

  test("rejects malformed repository snapshot sidecars before list or GC can consume them", async () => {
    const value = await fixture()
    const handle = await value.workspace.resolve(value.entry)
    const snapshot = await value.workspace.snapshot(handle, { reason: "validate metadata", actor })
    const metadata = path.join(
      value.root,
      ".git",
      "claxedo-document-snapshots",
      "document-1",
      `${snapshot.id}.json`,
    )
    const valid = JSON.parse(await fs.readFile(metadata, "utf8"))

    for (const invalid of [
      { ...valid, pins: [42] },
      { ...valid, actor: { type: "operator", id: "actor" } },
      { ...valid, createdAt: Number.MAX_VALUE },
      { ...valid, size: Number.MAX_VALUE },
    ]) {
      await fs.writeFile(metadata, JSON.stringify(invalid))
      await expect(value.workspace.listSnapshots(handle)).rejects.toMatchObject({
        code: "document_snapshot_corrupt",
      })
      await expect(value.workspace.collectSnapshots(handle)).rejects.toMatchObject({
        code: "document_snapshot_corrupt",
      })
    }
  })

  test("rejects oversized repository snapshot sidecars with a typed corrupt error", async () => {
    const value = await fixture()
    const handle = await value.workspace.resolve(value.entry)
    const snapshot = await value.workspace.snapshot(handle, { reason: "bounded metadata", actor })
    await fs.writeFile(
      path.join(value.root, ".git", "claxedo-document-snapshots", "document-1", `${snapshot.id}.json`),
      " ".repeat(MAX_SNAPSHOT_METADATA_BYTES + 1),
    )

    await expect(value.workspace.listSnapshots(handle)).rejects.toMatchObject({
      code: "document_snapshot_corrupt",
    })
    await expect(value.workspace.readSnapshot(handle, snapshot.id)).rejects.toMatchObject({
      code: "document_snapshot_corrupt",
    })
  })

  test("snapshot GC is count and age bounded while durable pins survive authority restart", async () => {
    let now = 1
    const options = { now: () => now, maxSnapshots: 2, maxSnapshotAgeMs: 1_000 }
    const value = await fixture({ git: options })
    const handle = await value.workspace.resolve(value.entry)
    const first = await value.workspace.snapshot(handle, { reason: "first", actor })
    await Promise.all([
      value.workspace.pinSnapshot(handle, first.id, "pin-a"),
      value.workspace.pinSnapshot(handle, first.id, "pin-b"),
    ])
    for (const [timestamp, markdown] of [
      [2, "two\n"],
      [3, "three\n"],
      [4, "four\n"],
    ] as const) {
      now = timestamp
      await fs.writeFile(path.join(value.root, "doc.md"), markdown)
      await value.workspace.snapshot(handle, { reason: markdown.trim(), actor })
    }

    const restarted = repositoryWorkspace(value.workspaces, { git: options })
    const restartedHandle = await restarted.resolve(value.entry)
    const retained = await restarted.listSnapshots(restartedHandle)
    expect(retained).toHaveLength(3)
    expect(retained.find((snapshot) => snapshot.id === first.id)?.pins).toEqual(["pin-a", "pin-b"])

    now = 2_000
    const aged = repositoryWorkspace(value.workspaces, {
      git: { now: () => now, maxSnapshots: 2, maxSnapshotAgeMs: 5 },
    })
    const agedHandle = await aged.resolve(value.entry)
    await aged.collectSnapshots(agedHandle)
    const afterAge = await aged.listSnapshots(agedHandle)
    expect(afterAge.find((snapshot) => snapshot.id === first.id)?.pins).toEqual(["pin-a", "pin-b"])
    expect(afterAge.filter((snapshot) => snapshot.pins.length === 0)).toHaveLength(1)
  })

  test("repository snapshot pins are bounded and repeated leases replace their purpose", async () => {
    const value = await fixture()
    const handle = await value.workspace.resolve(value.entry)
    const snapshot = await value.workspace.snapshot(handle, { reason: "bounded pins", actor })
    for (let index = 0; index < 200; index++) {
      await value.workspace.pinSnapshot(handle, snapshot.id, `lease:${Date.now() + 60_000 + index}:work-source`)
    }
    expect(
      (await value.workspace.listSnapshots(handle))[0]!.pins.filter((pin) => pin.startsWith("lease:")),
    ).toHaveLength(1)
    for (let index = 0; index < 127; index++) {
      await value.workspace.pinSnapshot(handle, snapshot.id, `permanent:${index}`)
    }
    await expect(value.workspace.pinSnapshot(handle, snapshot.id, "permanent:overflow")).rejects.toThrow("pin limit")
    await expect(value.workspace.pinSnapshot(handle, snapshot.id, "x".repeat(513))).rejects.toThrow("invalid or too large")
    expect((await value.workspace.listSnapshots(handle))[0]!.pins).toHaveLength(128)
  })

  test("repository snapshot GC prunes expired leases and collects snapshots they no longer pin", async () => {
    let now = 1_000
    const value = await fixture({ git: { now: () => now, maxSnapshots: 1 } })
    const handle = await value.workspace.resolve(value.entry)
    const first = await value.workspace.snapshot(handle, { reason: "first", actor })
    await value.workspace.pinSnapshot(handle, first.id, "lease:1500:work-source")
    await fs.writeFile(path.join(value.root, "doc.md"), "second\n")
    const second = await value.workspace.snapshot(handle, { reason: "second", actor })
    await value.workspace.pinSnapshot(handle, second.id, "lease:1500:work-source")
    expect((await value.workspace.listSnapshots(handle)).find((snapshot) => snapshot.id === first.id)).toBeDefined()

    now = 2_000
    await value.workspace.collectSnapshots(handle)
    const retained = await value.workspace.listSnapshots(handle)
    expect(retained.map((snapshot) => snapshot.id)).toEqual([second.id])
    expect(retained[0]!.pins).toEqual([])
  })

  test("repository snapshot metadata reads are bounded without truncating ordered or pinned results", async () => {
    let now = 1
    const value = await fixture({ git: { now: () => now, maxSnapshots: 20 } })
    const handle = await value.workspace.resolve(value.entry)
    const created: SnapshotRef[] = []
    for (let index = 0; index < 12; index++) {
      now++
      await fs.writeFile(path.join(value.root, "doc.md"), `snapshot ${index}\n`)
      created.push(await value.workspace.snapshot(handle, { reason: `snapshot ${index}`, actor }))
    }
    await value.workspace.pinSnapshot(handle, created[0]!.id, "work-source:metadata-concurrency")

    let active = 0
    let maximum = 0
    const restarted = repositoryWorkspace(value.workspaces, {
      git: {
        now: () => now,
        maxSnapshots: 20,
        faults: {
          async beforeSnapshotMetadataRead() {
            active++
            maximum = Math.max(maximum, active)
            await new Promise((resolve) => setTimeout(resolve, 5))
            active--
          },
        },
      },
    })
    const snapshots = await restarted.listSnapshots(await restarted.resolve(value.entry))
    expect(maximum).toBeGreaterThan(1)
    expect(maximum).toBeLessThanOrEqual(8)
    expect(snapshots).toHaveLength(12)
    expect(snapshots.map((snapshot) => snapshot.createdAt)).toEqual(
      [...snapshots].map((snapshot) => snapshot.createdAt).sort((left, right) => right - left),
    )
    expect(snapshots.find((snapshot) => snapshot.id === created[0]!.id)?.pins).toEqual([
      "work-source:metadata-concurrency",
    ])
  })

  test("snapshot GC removes metadata before content so interrupted cleanup is restart-safe", async () => {
    let crash = false
    const value = await fixture({
      git: {
        maxSnapshots: 1,
        faults: {
          afterSnapshotMetadataRemoved: async () => {
            if (crash) throw new Error("simulated GC crash")
          },
        },
      },
    })
    const handle = await value.workspace.resolve(value.entry)
    const first = await value.workspace.snapshot(handle, { reason: "first", actor })
    await fs.writeFile(path.join(value.root, "doc.md"), "second\n")
    crash = true
    await expect(value.workspace.snapshot(handle, { reason: "second", actor })).rejects.toThrow("simulated GC crash")

    const restarted = repositoryWorkspace(value.workspaces, { git: { maxSnapshots: 1 } })
    const restartedHandle = await restarted.resolve(value.entry)
    expect((await restarted.listSnapshots(restartedHandle)).map((snapshot) => snapshot.id)).not.toContain(first.id)
    await expect(restarted.readSnapshot(restartedHandle, first.id)).rejects.toMatchObject({
      code: "document_snapshot_not_found",
    })
  })

  test("recovery scanning bounds concurrent reads, skips heavy directories, and suppresses typed non-candidates", async () => {
    let active = 0
    let maximum = 0
    const value = await fixture({
      files: {
        scanConcurrency: 2,
        faults: {
          beforeScanCandidate: async () => {
            active++
            maximum = Math.max(maximum, active)
            await Promise.resolve()
            active--
          },
        },
      },
    })
    const handle = await value.workspace.resolve(value.entry)
    const current = await value.workspace.read(handle)
    await fs.mkdir(path.join(value.root, "moved"))
    await fs.rename(path.join(value.root, "doc.md"), path.join(value.root, "moved", "doc.md"))
    await fs.mkdir(path.join(value.root, "node_modules", "duplicate"), { recursive: true })
    await fs.writeFile(path.join(value.root, "node_modules", "duplicate", "doc.md"), "# Initial\n")
    await fs.writeFile(path.join(value.root, "binary.md"), Buffer.from([0xff, 0xfe]))
    await fs.writeFile(path.join(value.root, "large.md"), "x".repeat(2 * 1024 * 1024 + 1))
    await Promise.all(
      Array.from({ length: 6 }, (_, index) => fs.writeFile(path.join(value.root, `other-${index}.md`), `${index}`)),
    )

    await expect(value.workspace.availability(value.entry, current.version)).resolves.toEqual({
      state: "moved",
      relativePath: path.join("moved", "doc.md"),
    })
    expect(maximum).toBe(2)
  })

  test("recovery scanning propagates unexpected candidate failures", async () => {
    const failure = new Error("scan authority failed")
    const value = await fixture({
      files: {
        faults: {
          beforeScanCandidate: async (candidate) => {
            if (candidate.endsWith("fatal.md")) throw failure
          },
        },
      },
    })
    const handle = await value.workspace.resolve(value.entry)
    const current = await value.workspace.read(handle)
    await fs.rm(path.join(value.root, "doc.md"))
    await fs.writeFile(path.join(value.root, "fatal.md"), "fatal")

    await expect(value.workspace.availability(value.entry, current.version)).rejects.toBe(failure)
  })
})
