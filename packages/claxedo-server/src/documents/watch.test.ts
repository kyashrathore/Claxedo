import { describe, expect, test } from "vitest"
import type { DocumentVersion, SnapshotRef } from "./port"
import { localDocumentVersion } from "./version"
import { DocumentNotFoundError } from "./errors"
import { createDocumentWatchService } from "./watch"

const handle = {
  origin: "managed" as const,
  placement: "local" as const,
  projectId: "project-1",
  documentId: "document-1",
  canonicalPath: "/documents/project-1/document-1/plan.md",
}

const version = (value: string) =>
  localDocumentVersion(Buffer.from(value), { size: Buffer.byteLength(value), mtimeMs: 1 })
const snapshot = { id: "snapshot" } as SnapshotRef

function harness(input: { snapshot?: () => Promise<SnapshotRef> } = {}) {
  let current: { markdown: string; version: DocumentVersion; modifiedAt: number } | undefined = {
    markdown: "before",
    version: version("v1"),
    modifiedAt: 1,
  }
  const changes: Array<
    Readonly<{
      type: "changed" | "missing"
      previousVersion: DocumentVersion
      currentVersion: DocumentVersion | null
    }>
  > = []
  const snapshots: string[] = []
  const errors: unknown[] = []
  const callbacks = new Set<() => void>()
  const scheduled: Array<() => void | Promise<void>> = []
  let watcherClosed = 0
  const service = createDocumentWatchService({
    read: async () => {
      if (!current) throw new DocumentNotFoundError(handle.documentId)
      return current
    },
    snapshot: async (_handle, request) => {
      snapshots.push(request.reason)
      if (input.snapshot) return await input.snapshot()
      return snapshot
    },
    watch: (_target, change, error) => {
      callbacks.add(change)
      return {
        close() {
          callbacks.delete(change)
          watcherClosed++
        },
        error,
      }
    },
    schedule: (run) => {
      scheduled.push(run)
      return () => {
        const index = scheduled.indexOf(run)
        if (index >= 0) scheduled.splice(index, 1)
      }
    },
    onChange: (change) => {
      changes.push(change)
    },
    onError: (error) => errors.push(error),
  })
  return {
    service,
    changes,
    snapshots,
    errors,
    callbacks,
    scheduled,
    watcherClosed: () => watcherClosed,
    setCurrent(markdown: string, token: string) {
      current = { markdown, version: version(token), modifiedAt: (current?.modifiedAt ?? 0) + 1 }
    },
    remove() {
      current = undefined
    },
    async drain() {
      while (scheduled.length) await scheduled.shift()!()
      await Promise.resolve()
    },
  }
}

describe("document watch service", () => {
  test("watches only while a document is open and reference-counts tabs", async () => {
    const value = harness()
    const first = value.service.open(handle, version("v1"))
    const second = value.service.open(handle, version("v1"))
    expect(value.callbacks.size).toBe(1)

    first.close()
    expect(value.watcherClosed()).toBe(0)
    second.close()
    expect(value.watcherClosed()).toBe(1)
    expect(value.service.active()).toEqual([])
  })

  test("EC-D4 suppresses byte-identical events and debounces a rapid writer", async () => {
    const value = harness()
    const registration = value.service.open(handle, version("v1"))
    await value.drain()
    value.callbacks.forEach((change) => {
      change()
      change()
      change()
    })
    expect(value.scheduled).toHaveLength(1)
    await value.drain()
    expect(value.changes).toEqual([])
    expect(value.snapshots).toEqual([])
    registration.close()
  })

  test("EC-B10 snapshots and emits one boundary for the final distinct version", async () => {
    const value = harness()
    const scoped: typeof value.changes = []
    const registration = value.service.open(handle, version("v1"), (change) => {
      scoped.push(change)
    })
    await value.drain()
    value.setCurrent("agent edit one", "v2")
    value.callbacks.forEach((change) => change())
    value.setCurrent("agent edit two", "v3")
    value.callbacks.forEach((change) => change())
    await value.drain()

    expect(value.snapshots).toEqual(["document.external_change"])
    expect(value.changes).toMatchObject([
      {
        type: "changed",
        documentId: "document-1",
        projectId: "project-1",
        previousVersion: version("v1"),
        currentVersion: version("v3"),
      },
    ])
    expect(scoped).toEqual(value.changes)
    registration.close()
  })

  test("publishes only to active scoped registrations", async () => {
    const value = harness()
    const first: typeof value.changes = []
    const second: typeof value.changes = []
    const firstRegistration = value.service.open(handle, version("v1"), (change) => {
      first.push(change)
    })
    const secondRegistration = value.service.open(handle, version("v1"), (change) => {
      second.push(change)
    })
    await value.drain()
    firstRegistration.close()
    value.setCurrent("agent edit", "v2")
    value.callbacks.forEach((change) => change())
    await value.drain()
    expect(first).toEqual([])
    expect(second).toHaveLength(1)
    secondRegistration.close()
  })

  test("EC-D3 emits a recovery boundary when an open document disappears", async () => {
    const value = harness()
    const registration = value.service.open(handle, version("v1"))
    await value.drain()
    value.remove()
    value.callbacks.forEach((change) => change())
    await value.drain()
    value.callbacks.forEach((change) => change())
    await value.drain()
    expect(value.changes).toMatchObject([
      {
        type: "missing",
        documentId: "document-1",
        projectId: "project-1",
        previousVersion: version("v1"),
        currentVersion: null,
      },
    ])
    registration.close()
  })

  test("checks immediately after registration so an attach-boundary edit is not missed", async () => {
    const value = harness()
    value.setCurrent("changed before native notification", "v2")
    const registration = value.service.open(handle, version("v1"))
    await value.drain()
    expect(value.changes).toHaveLength(1)
    registration.close()
  })

  test("EC-B8 reports watcher failures without changing the CAS authority", () => {
    let fail: ((error: unknown) => void) | undefined
    const value = harness()
    const service = createDocumentWatchService({
      read: async () => ({ markdown: "before", version: version("v1"), modifiedAt: 1 }),
      snapshot: async () => snapshot,
      watch: (_target, _change, error) => {
        fail = error
        return { close() {} }
      },
      schedule: () => () => {},
      onChange: () => {},
      onError: (error) => value.errors.push(error),
    })
    const registration = service.open(handle, version("v1"))
    fail?.(new Error("watcher died"))
    expect(value.errors[0]).toEqual(new Error("watcher died"))
    registration.close()
  })

  test("still publishes a truthful change when recovery snapshot storage fails", async () => {
    const failure = new Error("history unavailable")
    const value = harness({ snapshot: async () => { throw failure } })
    const registration = value.service.open(handle, version("v1"))
    await value.drain()
    value.setCurrent("agent edit", "v2")
    value.callbacks.forEach((change) => change())
    await value.drain()
    expect(value.errors).toEqual([failure])
    expect(value.changes).toMatchObject([{ type: "changed", currentVersion: version("v2") }])
    registration.close()
  })

  test("serializes overlapping refreshes and publishes only the newest stable version", async () => {
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let snapshots = 0
    const value = harness({
      snapshot: async () => {
        snapshots++
        if (snapshots === 1) await blocked
        return snapshot
      },
    })
    const registration = value.service.open(handle, version("v1"))
    await value.drain()
    value.setCurrent("agent edit two", "v2")
    value.callbacks.forEach((change) => change())
    const first = Promise.resolve(value.scheduled.shift()?.())
    while (snapshots === 0) await Promise.resolve()
    value.setCurrent("agent edit three", "v3")
    value.callbacks.forEach((change) => change())
    await value.scheduled.shift()?.()
    release()
    await first
    expect(value.changes).toMatchObject([{ type: "changed", currentVersion: version("v3") }])
    expect(value.changes).toHaveLength(1)
    expect(value.errors).toEqual([])
    registration.close()
  })
})
