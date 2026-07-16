import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import {
  DocumentNotFoundError,
  DocumentNotTextError,
  DocumentPathError,
  DocumentStorageError,
  DocumentTooLargeError,
  DocumentVersionConflictError,
} from "./errors"
import { createDocumentHistory } from "./history"
import { createLocalManagedDocumentWorkspace, managedDocumentRelativePath } from "./local-managed"
import type { DocumentActor, DocumentEntry } from "./port"
import { documentWorkspaceConformance } from "./port-conformance"

const actor: DocumentActor = { type: "user", id: "user_1" }
const roots = new Set<string>()

afterEach(async () => {
  await Promise.all([...roots].map((root) => fs.rm(root, { recursive: true, force: true })))
  roots.clear()
})

async function fixture(options: Parameters<typeof createLocalManagedDocumentWorkspace>[0] = {}) {
  const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-documents-"))
  roots.add(dataRoot)
  const workspace = createLocalManagedDocumentWorkspace({ dataRoot, ...options })
  const entry: DocumentEntry = {
    origin: "managed",
    placement: "local",
    projectId: "project_1",
    documentId: "document_1",
    relativePath: managedDocumentRelativePath({
      projectId: "project_1",
      documentId: "document_1",
      slug: "initial",
    }),
  }
  await workspace.create(entry, { markdown: "# Initial\n", actor })
  return { dataRoot, workspace, entry }
}

describe("local managed DocumentWorkspace conformance", () => {
  documentWorkspaceConformance(async () => {
    const value = await fixture()
    return {
      workspace: value.workspace,
      entry: value.entry,
      dispose: async () => {
        await fs.rm(value.dataRoot, { recursive: true, force: true })
        roots.delete(value.dataRoot)
      },
    }
  })
})

describe("local managed document file semantics", () => {
  test("EC-A4 rejects invalid UTF-8 and keeps the latest valid snapshot restorable", async () => {
    const value = await fixture()
    const handle = await value.workspace.resolve(value.entry)
    await fs.writeFile(handle.canonicalPath, Buffer.from([0xc3, 0x28]))

    const error = await value.workspace.read(handle).catch((cause) => cause)
    expect(error).toBeInstanceOf(DocumentNotTextError)
    expect(error).toMatchObject({ code: "document_not_text", currentVersion: expect.any(String) })

    const [latest] = await value.workspace.listSnapshots(handle)
    await value.workspace.restore(handle, latest!.id, {
      expectedVersion: error.currentVersion,
      actor,
    })
    expect((await value.workspace.read(handle)).markdown).toBe("# Initial\n")
  })

  test("EC-A4 rejects NUL bytes as non-text", async () => {
    const value = await fixture()
    const handle = await value.workspace.resolve(value.entry)
    await fs.writeFile(handle.canonicalPath, Buffer.from("before\0after"))

    await expect(value.workspace.read(handle)).rejects.toBeInstanceOf(DocumentNotTextError)
  })

  test("EC-A7 rejects files and writes above the configured hard byte limit", async () => {
    const value = await fixture({ maxDocumentBytes: 12 })
    const handle = await value.workspace.resolve(value.entry)
    const current = await value.workspace.read(handle)

    await expect(
      value.workspace.write(handle, {
        markdown: "thirteen bytes",
        expectedVersion: current.version,
        actor,
      }),
    ).rejects.toBeInstanceOf(DocumentTooLargeError)

    await fs.writeFile(handle.canonicalPath, "already much too large")
    await expect(value.workspace.read(handle)).rejects.toBeInstanceOf(DocumentTooLargeError)
  })

  test("EC-A8 accepts an in-root symlink and rejects a symlink escape", async () => {
    const value = await fixture()
    const documentsRoot = path.join(value.dataRoot, "documents")
    const insideTarget = path.join(documentsRoot, "inside.md")
    await fs.writeFile(insideTarget, "inside")
    const insideEntry = entryAt("document_inside", "document_inside/link.md")
    await fs.mkdir(path.dirname(path.join(documentsRoot, insideEntry.relativePath)), { recursive: true })
    await fs.symlink(insideTarget, path.join(documentsRoot, insideEntry.relativePath))

    expect((await value.workspace.resolve(insideEntry)).canonicalPath).toBe(await fs.realpath(insideTarget))

    const outside = path.join(value.dataRoot, "outside.md")
    await fs.writeFile(outside, "outside")
    const outsideEntry = entryAt("document_outside", "document_outside/link.md")
    await fs.mkdir(path.dirname(path.join(documentsRoot, outsideEntry.relativePath)), { recursive: true })
    await fs.symlink(outside, path.join(documentsRoot, outsideEntry.relativePath))

    await expect(value.workspace.resolve(outsideEntry)).rejects.toBeInstanceOf(DocumentPathError)
  })

  test("EC-A9 surfaces permission failures as typed storage errors", async () => {
    const value = await fixture({
      faults: {
        beforeTempOpen() {
          throw Object.assign(new Error("read-only filesystem"), { code: "EACCES" })
        },
      },
    })
    const handle = await value.workspace.resolve(value.entry)
    const current = await value.workspace.read(handle)

    await expect(
      value.workspace.write(handle, {
        markdown: "cannot write",
        expectedVersion: current.version,
        actor,
      }),
    ).rejects.toMatchObject({ code: "document_permission_denied" } satisfies Partial<DocumentStorageError>)
  })

  test("EC-A10 a crash after temp-file fsync and before rename leaves the authority untouched", async () => {
    const value = await fixture({
      faults: {
        beforeRename() {
          throw new Error("simulated crash")
        },
      },
    })
    const handle = await value.workspace.resolve(value.entry)
    const current = await value.workspace.read(handle)

    await expect(
      value.workspace.write(handle, {
        markdown: "partial replacement",
        expectedVersion: current.version,
        actor,
      }),
    ).rejects.toBeInstanceOf(DocumentStorageError)
    expect(await fs.readFile(handle.canonicalPath, "utf8")).toBe("# Initial\n")
    expect((await fs.readdir(path.dirname(handle.canonicalPath))).filter((name) => name.endsWith(".tmp"))).toEqual([])
  })

  test("EC-A11 a deleted managed file keeps identity and restores from its latest snapshot", async () => {
    const value = await fixture()
    const handle = await value.workspace.resolve(value.entry)
    const [latest] = await value.workspace.listSnapshots(handle)
    await fs.unlink(handle.canonicalPath)

    await expect(value.workspace.read(handle)).rejects.toBeInstanceOf(DocumentNotFoundError)
    const restored = await value.workspace.restore(handle, latest!.id, { expectedVersion: null, actor })
    expect(restored.markdown).toBe("# Initial\n")
    expect((await value.workspace.read(handle)).markdown).toBe("# Initial\n")
  })

  test("EC-A12 generated physical names are ASCII and document-id isolated", () => {
    const first = managedDocumentRelativePath({ projectId: "project_1", documentId: "document_a", slug: "Cafe Notes" })
    const second = managedDocumentRelativePath({ projectId: "project_1", documentId: "document_b", slug: "cafe notes" })

    expect(first).toBe("project_1/document_a/cafe-notes.md")
    expect(second).toBe("project_1/document_b/cafe-notes.md")
    expect(first).not.toBe(second)
    expect([...first, ...second].every((character) => character.charCodeAt(0) < 128)).toBe(true)
  })

  test("EC-A12 rejects case-folding project and document identifiers", () => {
    expect(() => managedDocumentRelativePath({ projectId: "Project", documentId: "document_a", slug: "notes" })).toThrow(
      "Invalid project id",
    )
    expect(() => managedDocumentRelativePath({ projectId: "project", documentId: "Document", slug: "notes" })).toThrow(
      "Invalid document id",
    )
  })
})

describe("local managed concurrency and versioning", () => {
  test("EC-B5 version tokens remain stable when the backend is reconstructed", async () => {
    const value = await fixture()
    const handle = await value.workspace.resolve(value.entry)
    const before = await value.workspace.read(handle)
    const restarted = createLocalManagedDocumentWorkspace({ dataRoot: value.dataRoot })
    const after = await restarted.read(await restarted.resolve(value.entry))

    expect(after.version).toBe(before.version)
  })

  test("two concurrent CAS writes serialize so exactly one wins", async () => {
    const value = await fixture()
    const handle = await value.workspace.resolve(value.entry)
    const secondWorkspace = createLocalManagedDocumentWorkspace({ dataRoot: value.dataRoot })
    const secondHandle = await secondWorkspace.resolve(value.entry)
    const current = await value.workspace.read(handle)
    const results = await Promise.allSettled([
      value.workspace.write(handle, { markdown: "writer one", expectedVersion: current.version, actor }),
      secondWorkspace.write(secondHandle, { markdown: "writer two", expectedVersion: current.version, actor }),
    ])

    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1)
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1)
    expect((results.find((result) => result.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(
      DocumentVersionConflictError,
    )
    expect(["writer one", "writer two"]).toContain((await value.workspace.read(handle)).markdown)
  })

  test("an external pathname writer after the authority claim is preserved and wins the CAS", async () => {
    let race = false
    const value = await fixture({
      faults: {
        async afterAuthorityClaimed(input) {
          if (race) await fs.writeFile(input.target, "agent winner")
        },
      },
    })
    const handle = await value.workspace.resolve(value.entry)
    const current = await value.workspace.read(handle)
    race = true

    await expect(
      value.workspace.write(handle, { markdown: "human loser", expectedVersion: current.version, actor }),
    ).rejects.toBeInstanceOf(DocumentVersionConflictError)
    expect(await fs.readFile(handle.canonicalPath, "utf8")).toBe("agent winner")
  })

  test("an old open-FD writer is detected after install and restored as authority", async () => {
    let writer: fs.FileHandle | undefined
    let race = false
    const value = await fixture({
      faults: {
        async beforeAuthorityClaim(input) {
          if (race) writer = await fs.open(input.target, "r+")
        },
        async afterReplacementInstalled() {
          if (!writer) return
          await writer.truncate(0)
          await writer.writeFile("agent through old fd")
          await writer.sync()
        },
      },
    })
    const handle = await value.workspace.resolve(value.entry)
    const current = await value.workspace.read(handle)
    race = true

    await expect(
      value.workspace.write(handle, { markdown: "human replacement", expectedVersion: current.version, actor }),
    ).rejects.toBeInstanceOf(DocumentVersionConflictError)
    await writer?.close()
    expect(await fs.readFile(handle.canonicalPath, "utf8")).toBe("agent through old fd")
  })

  test("a parent symlink swap before read never returns bytes from outside the managed root", async () => {
    let swap = false
    let restoreParent = async () => {}
    const value = await fixture({
      faults: {
        async beforeReadOpen(input) {
          if (!swap) return
          const backup = `${input.parent}.inside`
          const outside = path.join(value.dataRoot, "outside-read")
          await fs.mkdir(outside)
          await fs.writeFile(path.join(outside, path.basename(input.target)), "outside secret")
          await fs.rename(input.parent, backup)
          await fs.symlink(outside, input.parent, "dir")
          restoreParent = async () => {
            await fs.unlink(input.parent)
            await fs.rename(backup, input.parent)
          }
          swap = false
        },
      },
    })
    const handle = await value.workspace.resolve(value.entry)
    swap = true

    await expect(value.workspace.read(handle)).rejects.toBeInstanceOf(DocumentPathError)
    await restoreParent()
    expect((await value.workspace.read(handle)).markdown).toBe("# Initial\n")
  })

  test("a parent symlink swap before the authority claim mutates neither inside nor outside", async () => {
    let swap = false
    let insideAuthority = ""
    let restoreParent = async () => {}
    const value = await fixture({
      faults: {
        async beforeAuthorityClaim(input) {
          if (!swap) return
          const backup = `${input.parent}.inside`
          const outside = path.join(value.dataRoot, "outside-write")
          await fs.mkdir(outside)
          await fs.writeFile(path.join(outside, path.basename(input.target)), "outside authority")
          await fs.rename(input.parent, backup)
          await fs.symlink(outside, input.parent, "dir")
          insideAuthority = path.join(backup, path.basename(input.target))
          restoreParent = async () => {
            await fs.unlink(input.parent)
            await fs.rename(backup, input.parent)
          }
          swap = false
        },
      },
    })
    const handle = await value.workspace.resolve(value.entry)
    const current = await value.workspace.read(handle)
    swap = true

    await expect(
      value.workspace.write(handle, { markdown: "must not escape", expectedVersion: current.version, actor }),
    ).rejects.toBeInstanceOf(DocumentPathError)
    expect(await fs.readFile(path.join(value.dataRoot, "outside-write", "initial.md"), "utf8")).toBe("outside authority")
    expect(await fs.readFile(insideAuthority, "utf8")).toBe("# Initial\n")
    await restoreParent()
  })

  test("directory fsync failure rolls back the old authority before reporting failure", async () => {
    let fail = false
    const value = await fixture({
      faults: {
        beforeDirectoryFsync() {
          if (!fail) return
          fail = false
          throw Object.assign(new Error("fsync failed"), { code: "EIO" })
        },
      },
    })
    const handle = await value.workspace.resolve(value.entry)
    const current = await value.workspace.read(handle)
    fail = true

    await expect(
      value.workspace.write(handle, { markdown: "not durable", expectedVersion: current.version, actor }),
    ).rejects.toBeInstanceOf(DocumentStorageError)
    expect(await fs.readFile(handle.canonicalPath, "utf8")).toBe("# Initial\n")
    expect((await fs.readdir(path.dirname(handle.canonicalPath))).filter((name) => /\.(tmp|claim)$/.test(name))).toEqual([])
  })
})

describe("local managed lock ownership", () => {
  test("a stale heartbeat never reaps a live same-host lock owner", async () => {
    const value = await fixture()
    const workspace = createLocalManagedDocumentWorkspace({
      dataRoot: value.dataRoot,
      locking: { staleMs: 5, waitMs: 30, heartbeatMs: 2 },
    })
    const handle = await workspace.resolve(value.entry)
    const current = await workspace.read(handle)
    const lock = path.join(value.dataRoot, "document-history", handle.documentId, ".write.lock")
    await fs.writeFile(lock, JSON.stringify({
      pid: process.pid,
      hostname: os.hostname(),
      token: "live-owner",
      createdAt: 1,
      heartbeatAt: 1,
    }))
    await fs.utimes(lock, new Date(0), new Date(0))

    await expect(
      workspace.write(handle, { markdown: "must wait", expectedVersion: current.version, actor }),
    ).rejects.toMatchObject({ code: "document_lock_timeout" })
    expect(JSON.parse(await fs.readFile(lock, "utf8")).token).toBe("live-owner")
  })

  test("a stale lock from a crashed same-host PID is reclaimed", async () => {
    const value = await fixture()
    const workspace = createLocalManagedDocumentWorkspace({
      dataRoot: value.dataRoot,
      locking: { staleMs: 5, waitMs: 100, heartbeatMs: 2 },
    })
    const handle = await workspace.resolve(value.entry)
    const current = await workspace.read(handle)
    const lock = path.join(value.dataRoot, "document-history", handle.documentId, ".write.lock")
    await fs.writeFile(lock, JSON.stringify({
      pid: 2_147_483_647,
      hostname: os.hostname(),
      token: "crashed-owner",
      createdAt: 1,
      heartbeatAt: 1,
    }))
    await fs.utimes(lock, new Date(0), new Date(0))

    await expect(
      workspace.write(handle, { markdown: "recovered", expectedVersion: current.version, actor }),
    ).resolves.toMatchObject({ markdown: "recovered" })
  })

  test("an active lock carries an ownership token and advances its heartbeat", async () => {
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => { enter = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    let block = false
    const value = await fixture({
      locking: { staleMs: 100, waitMs: 200, heartbeatMs: 5 },
      faults: {
        async beforeTempOpen() {
          if (!block) return
          enter()
          await gate
        },
      },
    })
    const handle = await value.workspace.resolve(value.entry)
    const current = await value.workspace.read(handle)
    const lock = path.join(value.dataRoot, "document-history", handle.documentId, ".write.lock")
    block = true
    const writing = value.workspace.write(handle, { markdown: "heartbeat", expectedVersion: current.version, actor })
    await entered
    const metadata = JSON.parse(await fs.readFile(lock, "utf8"))
    const before = (await fs.stat(lock)).mtimeMs
    await new Promise((resolve) => setTimeout(resolve, 20))
    const after = (await fs.stat(lock)).mtimeMs
    release()

    await expect(writing).resolves.toMatchObject({ markdown: "heartbeat" })
    expect(metadata).toMatchObject({ pid: process.pid, hostname: os.hostname(), token: expect.any(String) })
    expect(after).toBeGreaterThan(before)
    await expect(fs.stat(lock)).rejects.toMatchObject({ code: "ENOENT" })
  })
})

describe("local managed history", () => {
  test("snapshots are immutable and content-hash verified", async () => {
    const value = await fixture()
    const handle = await value.workspace.resolve(value.entry)
    const [snapshot] = await value.workspace.listSnapshots(handle)
    const snapshotPath = path.join(value.dataRoot, "document-history", handle.documentId, `${snapshot!.id}.md`)

    await expect(fs.writeFile(snapshotPath, "mutated", { flag: "wx" })).rejects.toMatchObject({ code: "EEXIST" })
    await fs.chmod(snapshotPath, 0o600)
    await fs.writeFile(snapshotPath, "mutated")
    await expect(value.workspace.readSnapshot(handle, snapshot!.id)).rejects.toMatchObject({
      code: "document_snapshot_corrupt",
    })
  })

  test("bounded GC retains pinned snapshots beyond the unpinned limit", async () => {
    const value = await fixture({ history: { maxSnapshots: 2, maxAgeMs: Number.POSITIVE_INFINITY } })
    const handle = await value.workspace.resolve(value.entry)
    const [initial] = await value.workspace.listSnapshots(handle)
    await value.workspace.pinSnapshot(handle, initial!.id, "work-source:1")

    const first = await value.workspace.read(handle)
    const second = await value.workspace.write(handle, { markdown: "second", expectedVersion: first.version, actor })
    await value.workspace.write(handle, { markdown: "third", expectedVersion: second.version, actor })

    const retained = await value.workspace.listSnapshots(handle)
    expect(retained).toHaveLength(3)
    expect(retained.find((snapshot) => snapshot.id === initial!.id)?.pins).toEqual(["work-source:1"])

    await value.workspace.unpinSnapshot(handle, initial!.id, "work-source:1")
    await value.workspace.collectSnapshots(handle)
    expect(await value.workspace.listSnapshots(handle)).toHaveLength(2)
  })

  test("max-age GC and pins remain correct after history restart", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-history-restart-"))
    roots.add(dataRoot)
    let now = 10
    const firstHistory = createDocumentHistory({ root: dataRoot, maxSnapshots: 5, maxAgeMs: 50, now: () => now })
    const first = await firstHistory.create("document_restart", { markdown: "first", reason: "first", actor })
    await firstHistory.pin("document_restart", first.id, "work-source:restart")
    now = 20
    const second = await firstHistory.create("document_restart", { markdown: "second", reason: "second", actor })
    now = 1_000

    const restarted = createDocumentHistory({ root: dataRoot, maxSnapshots: 5, maxAgeMs: 50, now: () => now })
    await restarted.collect("document_restart")
    expect((await restarted.list("document_restart")).map((snapshot) => snapshot.id)).toEqual([second.id, first.id])
    expect((await restarted.list("document_restart")).find((snapshot) => snapshot.id === first.id)?.pins).toEqual([
      "work-source:restart",
    ])

    await restarted.unpin("document_restart", first.id, "work-source:restart")
    await restarted.collect("document_restart")
    expect((await restarted.list("document_restart")).map((snapshot) => snapshot.id)).toEqual([second.id])
  })

  test("history mkdir and cleanup failures are always typed", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-history-errors-"))
    roots.add(dataRoot)
    let failCleanup = false
    const history = createDocumentHistory({
      root: dataRoot,
      maxSnapshots: 1,
      maxAgeMs: Number.POSITIVE_INFINITY,
      faults: {
        beforeMkdir() {
          throw Object.assign(new Error("mkdir denied"), { code: "EACCES" })
        },
      },
    })
    await expect(
      history.create("document_error", { markdown: "one", reason: "mkdir", actor }),
    ).rejects.toMatchObject({ code: "document_permission_denied" })

    const cleanupHistory = createDocumentHistory({
      root: dataRoot,
      maxSnapshots: 1,
      maxAgeMs: Number.POSITIVE_INFINITY,
      faults: {
        beforeCleanup() {
          if (failCleanup) throw Object.assign(new Error("cleanup denied"), { code: "EACCES" })
        },
      },
    })
    await cleanupHistory.create("document_cleanup", { markdown: "one", reason: "one", actor })
    failCleanup = true
    await expect(
      cleanupHistory.create("document_cleanup", { markdown: "two", reason: "two", actor }),
    ).rejects.toMatchObject({ code: "document_permission_denied" })
  })

  test("partial GC removes metadata before content so an orphan is never listed as restorable", async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), "claxedo-history-partial-gc-"))
    roots.add(dataRoot)
    let fail = false
    const history = createDocumentHistory({
      root: dataRoot,
      maxSnapshots: 1,
      maxAgeMs: Number.POSITIVE_INFINITY,
      faults: {
        beforeContentCleanup() {
          if (fail) throw Object.assign(new Error("content cleanup denied"), { code: "EACCES" })
        },
      },
    })
    const first = await history.create("document_partial", { markdown: "one", reason: "one", actor })
    fail = true

    await expect(
      history.create("document_partial", { markdown: "two", reason: "two", actor }),
    ).rejects.toMatchObject({ code: "document_permission_denied" })
    expect((await history.list("document_partial")).map((snapshot) => snapshot.sha256)).toHaveLength(1)
    await expect(
      fs.stat(path.join(dataRoot, "document-history", "document_partial", `${first.id}.json`)),
    ).rejects.toMatchObject({ code: "ENOENT" })
    await expect(
      fs.stat(path.join(dataRoot, "document-history", "document_partial", `${first.id}.md`)),
    ).resolves.toBeDefined()
  })
})

function entryAt(documentId: string, relativePath: string): DocumentEntry {
  return {
    origin: "managed",
    placement: "local",
    projectId: "project_1",
    documentId,
    relativePath: `project_1/${relativePath}`,
  }
}
