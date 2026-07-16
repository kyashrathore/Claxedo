import { describe, expect, test, vi } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { FSWatcher } from "node:fs"
import {
  disposeHydratedSessionDocuments,
  forgetHydratedSessionRuntime,
  hydrateSessionDocument,
  hydratedSessionDocumentPaths,
  reachableLocalSessionWorkspace,
  recoverHydratedSessionDocument,
  syncHydratedSessionDocuments,
} from "./session-hydration"

describe("managed document session hydration", () => {
  test("hydrates only selected documents and conditionally syncs ordinary file edits", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "document-hydration-"))
    let canonical = "before"
    let writes = 0
    const hydrated = await hydrateSessionDocument({
      sessionId: "session-a",
      workspaceRoot: root,
      documentId: "document-a",
      displayName: "Plan",
      markdown: canonical,
      baseVersion: "version-1",
      sync: async (markdown) => {
        canonical = markdown
        writes++
        return `version-${writes + 1}`
      },
    })

    expect(hydrated).toContain(`${path.sep}.claxedo${path.sep}sessions${path.sep}session-a${path.sep}docs${path.sep}document-a${path.sep}plan.md`)
    expect(hydratedSessionDocumentPaths("session-a")).toEqual([hydrated])
    expect((await fs.readdir(sessionDocs(root, "session-a"))).sort()).toEqual(["document-a", "manifest.json"])
    await syncHydratedSessionDocuments("session-a")
    expect(writes).toBe(0)
    const replacement = `${hydrated}.replacement`
    await fs.writeFile(replacement, "agent edit")
    await fs.rename(replacement, hydrated)
    for (let attempt = 0; attempt < 40 && writes === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    expect({ canonical, writes }).toEqual({ canonical: "agent edit", writes: 1 })
    await syncHydratedSessionDocuments("session-a")
    expect(writes).toBe(1)
    await disposeHydratedSessionDocuments("session-a")
    expect(hydratedSessionDocumentPaths("session-a")).toEqual([])
    await fs.rm(root, { recursive: true, force: true })
  })

  test("does not expose a sibling document that was never hydrated", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "document-hydration-sibling-"))
    await hydrateSessionDocument({
      sessionId: "session-a", workspaceRoot: root, documentId: "document-a", displayName: "A", markdown: "a",
      baseVersion: "version-1", sync: async (_markdown, version) => version,
    })
    expect(await fs.stat(path.join(sessionDocs(root, "session-a"), "document-b", "b.md")).then(() => true, () => false)).toBe(false)
    await disposeHydratedSessionDocuments("session-a")
    await fs.rm(root, { recursive: true, force: true })
  })

  test("fails virtual and cloud placements closed while resolving local workspaces", async () => {
    const resolveWorkspace = async (workspaceId: string) => workspaceId === "local"
      ? { kind: "local", directory: "/repo" }
      : { kind: "cloud", directory: "/workspace" }
    await expect(reachableLocalSessionWorkspace({
      host: "central", toolSandbox: { kind: "virtual" }, resolveWorkspace,
    })).resolves.toBeUndefined()
    await expect(reachableLocalSessionWorkspace({
      host: "central", toolSandbox: { kind: "workspace-runtime", workspaceId: "cloud" }, resolveWorkspace,
    })).resolves.toBeUndefined()
    await expect(reachableLocalSessionWorkspace({
      host: "central", toolSandbox: { kind: "workspace-runtime", workspaceId: "local" }, resolveWorkspace,
    })).resolves.toEqual({ workspaceId: "local", root: "/repo" })
  })

  test("rejects a symlinked hydration root before writing a document outside the workspace", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "document-hydration-escape-"))
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "document-hydration-outside-"))
    await fs.symlink(outside, path.join(root, ".claxedo"))
    await expect(hydrateSessionDocument({
      sessionId: "session-escape", workspaceRoot: root, documentId: "../../escape", displayName: "Escape",
      markdown: "secret", baseVersion: "version-1", sync: async (_markdown, version) => version,
    })).rejects.toThrow("escapes the workspace")
    expect(await fs.readdir(outside)).toEqual([])
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(outside, { recursive: true, force: true })
  })

  test("rejects hostile session ids instead of mapping distinct ids onto one namespace", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "document-hydration-session-id-"))
    for (const sessionId of ["../session", "___session", "session/a"]) {
      const opened = hydrateSessionDocument({
        sessionId, workspaceRoot: root, documentId: "document-a", displayName: "Plan",
        markdown: "before", baseVersion: "version-1", sync: async (_markdown, version) => version,
      })
      if (sessionId === "___session") await expect(opened).resolves.toContain("___session")
      else await expect(opened).rejects.toThrow("id is invalid")
      forgetHydratedSessionRuntime(sessionId)
    }
    expect((await fs.readdir(path.join(root, ".claxedo", "sessions"))).sort()).toEqual(["___session"])
    await fs.rm(root, { recursive: true, force: true })
  })

  test("reconciles a dirty persisted manifest before reopening after runtime loss", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "document-hydration-restart-"))
    let canonical = "before"
    const sync = async (markdown: string, expectedVersion: string) => {
      expect(expectedVersion).toBe("version-1")
      canonical = markdown
      return "version-2"
    }
    const hydrated = await hydrateSessionDocument({
      sessionId: "session-restart", workspaceRoot: root, documentId: "document-a", displayName: "Plan",
      markdown: canonical, baseVersion: "version-1", sync,
    })
    await fs.writeFile(hydrated, "dirty after crash")
    forgetHydratedSessionRuntime("session-restart")
    const reopened = await hydrateSessionDocument({
      sessionId: "session-restart", workspaceRoot: root, documentId: "document-a", displayName: "Plan",
      markdown: "before", baseVersion: "version-1", sync,
    })
    expect(canonical).toBe("dirty after crash")
    expect(await fs.readFile(reopened, "utf8")).toBe("dirty after crash")
    await disposeHydratedSessionDocuments("session-restart")
    await fs.rm(root, { recursive: true, force: true })
  })

  test("keeps same-workspace sessions isolated and disposes them independently", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "document-hydration-isolated-"))
    let canonical = "before"
    let version = "version-1"
    const openSession = (sessionId: string) => hydrateSessionDocument({
      sessionId,
      workspaceRoot: root,
      documentId: "document-a",
      displayName: "Plan",
      markdown: canonical,
      baseVersion: version,
      sync: async (markdown, expectedVersion) => {
        if (expectedVersion !== version) throw new Error("version conflict")
        canonical = markdown
        version = `${version}-next`
        return version
      },
    })
    const [first, second] = await Promise.all([openSession("session-one"), openSession("session-two")])
    expect(first).not.toBe(second)
    await fs.writeFile(first, "first")
    await fs.writeFile(second, "second")
    const settled = await Promise.allSettled([
      syncHydratedSessionDocuments("session-one"),
      syncHydratedSessionDocuments("session-two"),
    ])
    expect(settled.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"])
    await disposeHydratedSessionDocuments(settled[0]!.status === "fulfilled" ? "session-one" : "session-two")
    expect(await exists(settled[0]!.status === "fulfilled" ? second : first)).toBe(true)
    forgetHydratedSessionRuntime("session-one")
    forgetHydratedSessionRuntime("session-two")
    await fs.rm(root, { recursive: true, force: true })
  })

  test("recovers a persisted conflict after restart while preserving the session draft", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "document-hydration-recovery-"))
    const hydrated = await hydrateSessionDocument({
      sessionId: "session-recovery", workspaceRoot: root, documentId: "document-a", displayName: "Plan",
      markdown: "before", baseVersion: "version-1", sync: async () => { throw new Error("version conflict") },
    })
    await fs.writeFile(hydrated, "session draft")
    await expect(syncHydratedSessionDocuments("session-recovery")).rejects.toThrow("version conflict")
    forgetHydratedSessionRuntime("session-recovery")
    const reopened = await recoverHydratedSessionDocument({
      sessionId: "session-recovery",
      workspaceRoot: root,
      documentId: "document-a",
      displayName: "Plan",
      remoteMarkdown: "browser version",
      remoteVersion: "version-2",
      resolution: "use-remote",
      sync: async (_markdown, expectedVersion) => expectedVersion,
    })
    expect(await fs.readFile(reopened, "utf8")).toBe("browser version")
    const preserved = (await fs.readdir(path.dirname(reopened))).find((name) => name.includes(".conflict-"))
    expect(await fs.readFile(path.join(path.dirname(reopened), preserved!), "utf8")).toBe("session draft")
    await disposeHydratedSessionDocuments("session-recovery")
    await fs.rm(root, { recursive: true, force: true })
  })

  test("parks conflicts and preserves the hydrated draft during final disposal", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "document-hydration-conflict-"))
    const hydrated = await hydrateSessionDocument({
      sessionId: "session-conflict", workspaceRoot: root, documentId: "document-a", displayName: "Plan",
      markdown: "before", baseVersion: "version-1", sync: async () => { throw new Error("version conflict") },
    })
    await fs.writeFile(hydrated, "preserve me")
    await expect(syncHydratedSessionDocuments("session-conflict")).rejects.toThrow("version conflict")
    const failures = await disposeHydratedSessionDocuments("session-conflict")
    expect(failures).toMatchObject([{ documentId: "document-a", path: hydrated, error: expect.any(Error) }])
    expect(await fs.readFile(hydrated, "utf8")).toBe("preserve me")
    const manifest = JSON.parse(await fs.readFile(path.join(sessionDocs(root, "session-conflict"), "manifest.json"), "utf8")) as { documents: Array<{ state: string }> }
    expect(manifest.documents[0]?.state).toBe("conflicted")
    forgetHydratedSessionRuntime("session-conflict")
    await fs.rm(root, { recursive: true, force: true })
  })

  test("performs a final conditional sweep before deleting a clean session copy", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "document-hydration-final-"))
    let canonical = "before"
    const hydrated = await hydrateSessionDocument({
      sessionId: "session-final", workspaceRoot: root, documentId: "document-a", displayName: "Plan",
      markdown: canonical, baseVersion: "version-1", sync: async (markdown) => { canonical = markdown; return "version-2" },
    })
    await fs.writeFile(hydrated, "last edit")
    await disposeHydratedSessionDocuments("session-final")
    expect(canonical).toBe("last edit")
    expect(await exists(hydrated)).toBe(false)
    await fs.rm(root, { recursive: true, force: true })
  })

  test("serializes replacement hydration behind disposal and keeps the replacement identity", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "document-hydration-dispose-race-"))
    const originalRm = fs.rm.bind(fs)
    const cleanupEntered = deferred<void>()
    const releaseCleanup = deferred<void>()
    let held = false
    const remove = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (!held && String(target).includes(`${path.sep}session-race${path.sep}docs${path.sep}document-a`)) {
        held = true
        cleanupEntered.resolve()
        await releaseCleanup.promise
      }
      return await originalRm(target, options)
    })
    try {
      await hydrateSessionDocument({
        sessionId: "session-race",
        workspaceRoot: root,
        documentId: "document-a",
        displayName: "Old",
        markdown: "old",
        baseVersion: "version-1",
        sync: async (_markdown, version) => version,
      })
      const disposing = disposeHydratedSessionDocuments("session-race")
      await cleanupEntered.promise
      const replacing = hydrateSessionDocument({
        sessionId: "session-race",
        workspaceRoot: root,
        documentId: "document-a",
        displayName: "Replacement",
        markdown: "replacement",
        baseVersion: "version-2",
        sync: async (_markdown, version) => version,
      })

      const replacementPath = path.join(sessionDocs(root, "session-race"), "document-a", "replacement.md")
      for (let attempt = 0; attempt < 200 && !(await exists(replacementPath)); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 1))
      }
      releaseCleanup.resolve()
      const [failures, replacement] = await Promise.all([disposing, replacing])

      expect(failures).toEqual([])
      expect(hydratedSessionDocumentPaths("session-race")).toEqual([replacement])
      expect(await fs.readFile(replacement, "utf8")).toBe("replacement")
      expect(
        JSON.parse(await fs.readFile(path.join(sessionDocs(root, "session-race"), "manifest.json"), "utf8")),
      ).toMatchObject({
        documents: [{ documentId: "document-a", path: replacement, baseVersion: "version-2", state: "active" }],
      })
      await disposeHydratedSessionDocuments("session-race")
    } finally {
      releaseCleanup.resolve()
      remove.mockRestore()
      forgetHydratedSessionRuntime("session-race")
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("waits for an admitted hydration before disposing the session", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "document-hydration-admission-race-"))
    const writeEntered = deferred<void>()
    const releaseWrite = deferred<void>()
    try {
      const hydrating = hydrateSessionDocument({
        sessionId: "session-admission",
        workspaceRoot: root,
        documentId: "document-a",
        displayName: "Plan",
        markdown: "before",
        baseVersion: "version-1",
        sync: async (_markdown, version) => version,
        faults: {
          beforeWriteOpen: async () => {
            writeEntered.resolve()
            await releaseWrite.promise
          },
        },
      })
      await writeEntered.promise
      const disposing = disposeHydratedSessionDocuments("session-admission")
      let disposalSettled = false
      void disposing.then(() => {
        disposalSettled = true
      })
      await new Promise((resolve) => setImmediate(resolve))
      expect(disposalSettled).toBe(false)

      releaseWrite.resolve()
      const [hydrated, failures] = await Promise.all([hydrating, disposing])
      expect(failures).toEqual([])
      expect(hydratedSessionDocumentPaths("session-admission")).toEqual([])
      expect(await exists(hydrated)).toBe(false)
    } finally {
      releaseWrite.resolve()
      forgetHydratedSessionRuntime("session-admission")
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("does not admit a manual sync while session disposal is removing the document", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "document-hydration-sync-dispose-race-"))
    const originalRm = fs.rm.bind(fs)
    const cleanupEntered = deferred<void>()
    const releaseCleanup = deferred<void>()
    let writes = 0
    const remove = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (String(target).includes(`${path.sep}session-sync-dispose${path.sep}docs${path.sep}document-a`)) {
        cleanupEntered.resolve()
        await releaseCleanup.promise
      }
      return await originalRm(target, options)
    })
    try {
      const hydrated = await hydrateSessionDocument({
        sessionId: "session-sync-dispose",
        workspaceRoot: root,
        documentId: "document-a",
        displayName: "Plan",
        markdown: "before",
        baseVersion: "version-1",
        sync: async (_markdown, version) => {
          writes++
          return version
        },
      })
      const disposing = disposeHydratedSessionDocuments("session-sync-dispose")
      await cleanupEntered.promise
      await fs.writeFile(hydrated, "late edit")
      const flushing = syncHydratedSessionDocuments("session-sync-dispose")
      await new Promise((resolve) => setImmediate(resolve))
      expect(writes).toBe(0)

      releaseCleanup.resolve()
      await Promise.all([disposing, flushing])
      expect(writes).toBe(0)
    } finally {
      releaseCleanup.resolve()
      remove.mockRestore()
      forgetHydratedSessionRuntime("session-sync-dispose")
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("drops watcher syncs queued after session disposal begins", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "document-hydration-watcher-dispose-race-"))
    const originalRm = fs.rm.bind(fs)
    const cleanupEntered = deferred<void>()
    const releaseCleanup = deferred<void>()
    let watcher: FSWatcher | undefined
    let writes = 0
    const remove = vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
      if (String(target).includes(`${path.sep}session-watcher-dispose${path.sep}docs${path.sep}document-a`)) {
        cleanupEntered.resolve()
        await releaseCleanup.promise
      }
      return await originalRm(target, options)
    })
    try {
      const hydrated = await hydrateSessionDocument({
        sessionId: "session-watcher-dispose",
        workspaceRoot: root,
        documentId: "document-a",
        displayName: "Plan",
        markdown: "before",
        baseVersion: "version-1",
        sync: async (_markdown, version) => {
          writes++
          return version
        },
        faults: {
          afterWatcherCreated: (value) => {
            watcher = value
          },
        },
      })
      const disposing = disposeHydratedSessionDocuments("session-watcher-dispose")
      await cleanupEntered.promise
      await fs.writeFile(hydrated, "late watcher edit")
      watcher?.emit("change", "change", path.basename(hydrated))
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(writes).toBe(0)

      releaseCleanup.resolve()
      await disposing
      expect(writes).toBe(0)
    } finally {
      releaseCleanup.resolve()
      remove.mockRestore()
      forgetHydratedSessionRuntime("session-watcher-dispose")
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("rejects corrupt manifests, forged paths, and pre-existing target symlinks", async () => {
    const corruptRoot = await fs.mkdtemp(path.join(os.tmpdir(), "document-hydration-corrupt-"))
    await fs.mkdir(sessionDocs(corruptRoot, "session-corrupt"), { recursive: true })
    await fs.writeFile(path.join(sessionDocs(corruptRoot, "session-corrupt"), "manifest.json"), "not json")
    await expect(open(corruptRoot, "session-corrupt")).rejects.toThrow()

    const forgedRoot = await fs.mkdtemp(path.join(os.tmpdir(), "document-hydration-forged-"))
    const outside = path.join(forgedRoot, "..", "forged.md")
    await fs.writeFile(outside, "outside")
    await fs.mkdir(sessionDocs(forgedRoot, "session-forged"), { recursive: true })
    await fs.writeFile(path.join(sessionDocs(forgedRoot, "session-forged"), "manifest.json"), JSON.stringify({
      version: 1,
      documents: [{ documentId: "document-a", path: outside, baseVersion: "version-1", lastSyncedHash: "wrong", state: "active" }],
    }))
    await expect(open(forgedRoot, "session-forged")).rejects.toThrow("escapes the workspace")

    const symlinkRoot = await fs.mkdtemp(path.join(os.tmpdir(), "document-hydration-target-link-"))
    const directory = path.join(sessionDocs(symlinkRoot, "session-link"), "document-a")
    const outsideTarget = path.join(symlinkRoot, "outside.md")
    await fs.mkdir(directory, { recursive: true })
    await fs.writeFile(outsideTarget, "outside")
    await fs.symlink(outsideTarget, path.join(directory, "plan.md"))
    await expect(open(symlinkRoot, "session-link")).rejects.toThrow("already exists")
    expect(await fs.readFile(outsideTarget, "utf8")).toBe("outside")
    await fs.rm(corruptRoot, { recursive: true, force: true })
    await fs.rm(forgedRoot, { recursive: true, force: true })
    await fs.rm(outside, { force: true })
    await fs.rm(symlinkRoot, { recursive: true, force: true })
  })

  test("detects a post-check parent swap before reading escaped content", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "document-hydration-swap-"))
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "document-hydration-swap-outside-"))
    let swapped = false
    const hydrated = await hydrateSessionDocument({
      sessionId: "session-swap", workspaceRoot: root, documentId: "document-a", displayName: "Plan",
      markdown: "inside", baseVersion: "version-1", sync: async (_markdown, version) => version,
      faults: { beforeReadOpen: async () => {
        if (swapped) return
        swapped = true
        const directory = path.dirname(hydrated)
        await fs.rename(directory, `${directory}.moved`)
        await fs.mkdir(path.join(outside, "placeholder"), { recursive: true })
        await fs.writeFile(path.join(outside, "plan.md"), "outside")
        await fs.symlink(outside, directory)
      } },
    })
    await fs.writeFile(hydrated, "dirty")
    await expect(syncHydratedSessionDocuments("session-swap")).rejects.toThrow("changed while opening")
    expect(await fs.readFile(path.join(outside, "plan.md"), "utf8")).toBe("outside")
    forgetHydratedSessionRuntime("session-swap")
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(outside, { recursive: true, force: true })
  })

  test("detects a parent swap after the write parent check before mutating escaped content", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "document-hydration-write-swap-"))
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "document-hydration-write-swap-outside-"))
    const outsideTarget = path.join(outside, "plan.md")
    await fs.writeFile(outsideTarget, "outside")
    await expect(hydrateSessionDocument({
      sessionId: "session-write-swap", workspaceRoot: root, documentId: "document-a", displayName: "Plan",
      markdown: "inside", baseVersion: "version-1", sync: async (_markdown, version) => version,
      faults: { beforeWriteOpen: async () => {
        const directory = path.join(sessionDocs(root, "session-write-swap"), "document-a")
        await fs.rename(directory, `${directory}.moved`)
        await fs.symlink(outside, directory)
      } },
    })).rejects.toThrow("changed while opening")
    expect(await fs.readFile(outsideTarget, "utf8")).toBe("outside")
    await fs.rm(root, { recursive: true, force: true })
    await fs.rm(outside, { recursive: true, force: true })
  })

  test("parks and persists watcher errors instead of emitting an unhandled error", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "document-hydration-watcher-error-"))
    let watcher: FSWatcher | undefined
    const report = vi.spyOn(console, "error").mockImplementation(() => {})
    const hydrated = await hydrateSessionDocument({
      sessionId: "session-watcher-error", workspaceRoot: root, documentId: "document-a", displayName: "Plan",
      markdown: "before", baseVersion: "version-1", sync: async (_markdown, version) => version,
      faults: { afterWatcherCreated: (value) => { watcher = value } },
    })
    watcher?.emit("error", new Error("watcher unavailable"))
    const manifestPath = path.join(sessionDocs(root, "session-watcher-error"), "manifest.json")
    for (let attempt = 0; attempt < 40; attempt++) {
      const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as { documents: Array<{ state: string }> }
      if (manifest.documents[0]?.state === "conflicted") break
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    await expect(syncHydratedSessionDocuments("session-watcher-error")).rejects.toThrow("watcher unavailable")
    expect(JSON.parse(await fs.readFile(manifestPath, "utf8"))).toMatchObject({
      documents: [{ documentId: "document-a", state: "conflicted" }],
    })
    expect(report).toHaveBeenCalledWith(
      "[session-hydration] watcher failed for document-a:",
      expect.objectContaining({ message: "watcher unavailable" }),
    )
    expect(await disposeHydratedSessionDocuments("session-watcher-error")).toHaveLength(1)
    expect(await fs.readFile(hydrated, "utf8")).toBe("before")
    forgetHydratedSessionRuntime("session-watcher-error")
    report.mockRestore()
    await fs.rm(root, { recursive: true, force: true })
  })

  test("serializes concurrent manifest mutations without losing document entries", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "document-hydration-manifest-concurrency-"))
    const documents = Array.from({ length: 12 }, (_, index) => ({
      documentId: `document-${index}`,
      sessionId: `session-concurrent-${index}`,
    }))
    await Promise.all(documents.map((document) => hydrateSessionDocument({
      ...document,
      workspaceRoot: root,
      displayName: document.documentId,
      markdown: document.documentId,
      baseVersion: "version-1",
      sync: async (_markdown, version) => version,
    })))
    const manifests = await Promise.all(documents.map(async (document) => JSON.parse(
      await fs.readFile(path.join(sessionDocs(root, document.sessionId), "manifest.json"), "utf8"),
    ) as { documents: Array<{ documentId: string }> }))
    expect(manifests.flatMap((manifest) => manifest.documents.map((document) => document.documentId)).sort()).toEqual(
      documents.map((document) => document.documentId).sort(),
    )
    await Promise.all(documents.map((document) => disposeHydratedSessionDocuments(document.sessionId)))
    await fs.rm(root, { recursive: true, force: true })
  })
})

function exists(value: string) {
  return fs.access(value).then(() => true, () => false)
}

function sessionDocs(root: string, sessionId: string) {
  return path.join(root, ".claxedo", "sessions", sessionId, "docs")
}

function open(root: string, sessionId: string) {
  return hydrateSessionDocument({
    sessionId, workspaceRoot: root, documentId: "document-a", displayName: "Plan", markdown: "before",
    baseVersion: "version-1", sync: async (_markdown, version) => version,
  })
}

function deferred<T>() {
  let resolve = (_value: T | PromiseLike<T>): void => undefined
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
