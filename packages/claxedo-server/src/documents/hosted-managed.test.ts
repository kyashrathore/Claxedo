import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { DocumentVersionConflictError } from "./errors"
import {
  createHostedManagedDocumentWorkspace,
  createR2ConditionalObjectStore,
  hostedManagedRelativePath,
  objectListing,
  resumeAfterKey,
  type ConditionalObjectStore,
} from "./hosted-managed"
import { createHostedDocumentIndex } from "./hosted-index"
import type { DocumentIndexEntry } from "./index-store"
import { createHostedDocumentsBackend } from "./hosted-backend"
import { mintDocumentSessionToken } from "../control-plane/runtime-access-token"
import { documentWorkspaceConformance } from "./port-conformance"
import type { DocumentEntry } from "./port"
import { MAX_SNAPSHOT_METADATA_BYTES } from "./snapshot-pins"
import { forgetHydratedSessionRuntime, hydrateSessionDocument, syncHydratedSessionDocuments } from "./session-hydration"

function emulator() {
  let clock = 0
  let reads = 0
  const objects = new Map<string, { body: Uint8Array; etag: string; uploadedAt: number }>()
  const store: ConditionalObjectStore = {
    async get(key) {
      reads++
      const object = objects.get(key)
      return object ? { key, body: object.body.slice(), etag: object.etag, uploadedAt: object.uploadedAt } : undefined
    },
    async put(key, body, condition) {
      const current = objects.get(key)
      if (condition.absent && current) return undefined
      if (condition.etag && current?.etag !== condition.etag) return undefined
      const etag = `etag-${++clock}`
      const uploadedAt = clock
      objects.set(key, { body: body.slice(), etag, uploadedAt })
      return { etag, uploadedAt }
    },
    async delete(key) {
      objects.delete(key)
    },
    async list(prefix, listOptions) {
      const after = resumeAfterKey(listOptions?.cursor)
      const all = [...objects.entries()]
        .filter(([key]) => key.startsWith(prefix) && (!after || key > after))
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, object]) => ({ key, etag: object.etag, uploadedAt: object.uploadedAt }))
      const limit = listOptions?.limit
      if (limit !== undefined && all.length > limit) {
        const kept = all.slice(0, limit)
        return objectListing(kept, { truncated: true, cursor: `after:${kept.at(-1)!.key}` })
      }
      return objectListing(all, { truncated: false })
    },
  }
  return { store, objects, reads: () => reads }
}

function fixture() {
  const storage = emulator()
  const workspace = createHostedManagedDocumentWorkspace({ store: storage.store })
  const entry = {
    origin: "managed",
    placement: "hosted",
    orgId: "org_1",
    projectId: "project_1",
    documentId: "document_1",
    relativePath: hostedManagedRelativePath({ documentId: "document_1", slug: "Plan" }),
  } as const satisfies DocumentEntry
  return { storage, workspace, entry }
}

function indexEntry(projectId = "project_1") {
  return {
    id: "document_1",
    org_id: "org_1",
    project_id: projectId,
    display_name: "Plan",
    origin_kind: "managed",
    placement_kind: "hosted",
    placement_id: "r2",
    managed_relative_path: "document_1/plan.md",
    repository_id: null,
    workspace_id: null,
    repository_relative_path: null,
    branch: null,
    status: "draft",
    session_id: null,
    archived_at: null,
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    last_opened_at: null,
    last_known_file_version: null,
  } as const satisfies DocumentIndexEntry
}

function r2(storage: ReturnType<typeof emulator>) {
  return {
    get: async (key: string) => {
      const object = await storage.store.get(key)
      return object
        ? {
            etag: object.etag,
            uploaded: new Date(object.uploadedAt),
            size: object.body.byteLength,
            body: new Response(object.body.slice()).body!,
          }
        : null
    },
    put: async (key: string, body: Uint8Array, options?: { onlyIf?: { etagMatches?: string } }) => {
      const written = await storage.store.put(
        key,
        body,
        options?.onlyIf?.etagMatches ? { etag: options.onlyIf.etagMatches } : { absent: true },
      )
      return written ? { etag: written.etag, uploaded: new Date(written.uploadedAt) } : null
    },
    delete: storage.store.delete,
    list: async ({ prefix }: { prefix: string }) => ({
      objects: (await storage.store.list(prefix)).map((object) => ({
        ...object,
        uploaded: new Date(object.uploadedAt),
      })),
      truncated: false,
    }),
  }
}

describe("hosted managed document workspace conformance", () => {
  documentWorkspaceConformance(async () => {
    const value = fixture()
    await value.workspace.create(value.entry, {
      markdown: "# Initial\n",
      actor: { type: "system", id: "conformance" },
    })
    return { workspace: value.workspace, entry: value.entry, dispose: async () => undefined }
  })
})

describe("hosted managed documents and session write-back", () => {
  test("repeated hosted intake renewals replace one bounded lease and reject pin overflow atomically", async () => {
    const value = fixture()
    await value.workspace.create(value.entry, { markdown: "one", actor: { type: "user", id: "user" } })
    const handle = await value.workspace.resolve(value.entry)
    const [snapshot] = await value.workspace.listSnapshots(handle)
    for (let index = 0; index < 200; index++) {
      await value.workspace.pinSnapshot(handle, snapshot!.id, `lease:${Date.now() + 60_000 + index}:work-source`)
    }
    expect(
      (await value.workspace.listSnapshots(handle))[0]!.pins.filter((pin) => pin.startsWith("lease:")),
    ).toHaveLength(1)
    for (let index = 0; index < 127; index++)
      await value.workspace.pinSnapshot(handle, snapshot!.id, `permanent:${index}`)
    await expect(value.workspace.pinSnapshot(handle, snapshot!.id, "permanent:overflow")).rejects.toThrow("pin limit")
    expect((await value.workspace.listSnapshots(handle))[0]!.pins).toHaveLength(128)
  })

  const roots: string[] = []
  afterEach(async () => {
    vi.useRealTimers()
    await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
  })

  test("tenant scope is explicit and keys include org/project/document/slug", async () => {
    const value = fixture()
    await value.workspace.create(value.entry, { markdown: "content", actor: { type: "user", id: "user" } })
    expect([...value.storage.objects.keys()]).toContain("documents/org_1/project_1/document_1/plan.md")
    await expect(value.workspace.resolve({ ...value.entry, orgId: undefined })).rejects.toThrow("org scope")
  })

  test("R2 adapter maps ETags, create-only puts, conditional puts, and paginated lists", async () => {
    let value: { body: Uint8Array; etag: string; uploaded: Date } | undefined
    const bucket = {
      async get() {
        return value
          ? { ...value, size: value.body.byteLength, body: new Response(value.body.slice()).body! }
          : null
      },
      async put(
        _key: string,
        body: Uint8Array,
        options?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } },
      ) {
        if (options?.onlyIf?.etagMatches && options.onlyIf.etagMatches !== value?.etag) return null
        if (options?.onlyIf?.etagDoesNotMatch === "*" && value) return null
        value = { body: body.slice(), etag: `r2-${value ? 2 : 1}`, uploaded: new Date(value ? 2 : 1) }
        return value
      },
      async delete() {
        value = undefined
      },
      async list(options: { cursor?: string }) {
        if (!options.cursor)
          return { objects: [{ key: "a", etag: "1", uploaded: new Date(1) }], truncated: true, cursor: "next" }
        return { objects: [{ key: "b", etag: "2", uploaded: new Date(2) }], truncated: false }
      },
    }
    const store = createR2ConditionalObjectStore(bucket)
    expect((await store.put("doc", new TextEncoder().encode("one"), { absent: true }))?.etag).toBe("r2-1")
    await expect(store.put("doc", new TextEncoder().encode("lost"), { absent: true })).resolves.toBeUndefined()
    await expect(store.put("doc", new TextEncoder().encode("lost"), { etag: "stale" })).resolves.toBeUndefined()
    expect((await store.put("doc", new TextEncoder().encode("two"), { etag: "r2-1" }))?.etag).toBe("r2-2")
    expect((await store.list("")).map((object) => object.key)).toEqual(["a", "b"])
    const broken = createR2ConditionalObjectStore({
      ...bucket,
      async list() {
        return { objects: [], truncated: true }
      },
    })
    await expect(broken.list("")).rejects.toThrow("truncated without a cursor")
  })

  test("R2 reads reject declared and streamed overflow without unbounded buffering", async () => {
    let oversizedBodyReads = 0
    const oversized = createR2ConditionalObjectStore(
      {
        async get() {
          return {
            etag: "oversized",
            uploaded: new Date(1),
            size: 5,
            get body() {
              oversizedBodyReads++
              return new Response(new Uint8Array(5)).body!
            },
          }
        },
        async put() {
          return null
        },
        async delete() {},
        async list() {
          return { objects: [], truncated: false }
        },
      },
      { maxObjectBytes: 4 },
    )
    await expect(oversized.get("oversized")).rejects.toMatchObject({
      code: "document_too_large",
      actualBytes: 5,
      maxBytes: 4,
    })
    expect(oversizedBodyReads).toBe(0)

    const dishonest = createR2ConditionalObjectStore(
      {
        async get() {
          return {
            etag: "dishonest",
            uploaded: new Date(1),
            size: 1,
            body: new Response(new Uint8Array([1, 2, 3])).body!,
          }
        },
        async put() {
          return null
        },
        async delete() {},
        async list() {
          return { objects: [], truncated: false }
        },
      },
      { maxObjectBytes: 4 },
    )
    await expect(dishonest.get("dishonest")).rejects.toMatchObject({ code: "document_too_large" })
  })

  test("hosted snapshots are bounded while durable pins survive backend recreation", async () => {
    const storage = emulator()
    const firstWorkspace = createHostedManagedDocumentWorkspace({ store: storage.store, maxSnapshots: 1 })
    const value = fixture()
    const created = await firstWorkspace.create(value.entry, { markdown: "one", actor: { type: "user", id: "user" } })
    const handle = await firstWorkspace.resolve(value.entry)
    const first = (await firstWorkspace.listSnapshots(handle))[0]
    await firstWorkspace.pinSnapshot(handle, first.id, "work-source")
    const second = await firstWorkspace.write(handle, {
      markdown: "two",
      expectedVersion: created.version,
      actor: { type: "user", id: "user" },
    })
    await firstWorkspace.write(handle, {
      markdown: "three",
      expectedVersion: second.version,
      actor: { type: "user", id: "user" },
    })

    const restarted = createHostedManagedDocumentWorkspace({ store: storage.store, maxSnapshots: 1 })
    const retained = await restarted.listSnapshots(await restarted.resolve(value.entry))
    expect(retained).toHaveLength(2)
    expect(retained.find((snapshot) => snapshot.id === first.id)?.pins).toEqual(["work-source"])
  })

  test("rejects malformed hosted snapshot sidecars before reads, lists, or GC consume them", async () => {
    const value = fixture()
    await value.workspace.create(value.entry, { markdown: "one", actor: { type: "user", id: "user" } })
    const handle = await value.workspace.resolve(value.entry)
    const snapshot = (await value.workspace.listSnapshots(handle))[0]!
    const key = [...value.storage.objects.keys()].find(
      (candidate) => candidate.startsWith("document-history/") && candidate.endsWith(`${snapshot.id}.json`),
    )!
    const object = value.storage.objects.get(key)!
    const valid = JSON.parse(new TextDecoder().decode(object.body)) as Record<string, unknown>
    const cases: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
      ["id", { ...valid, id: "0".repeat(64) }],
      ["hash", { ...valid, sha256: "0".repeat(64) }],
      ["pins", { ...valid, pins: [""] }],
      ["actor", { ...valid, actor: { type: "root", id: "user" } }],
      ["reason", { ...valid, reason: "" }],
      ["session", { ...valid, sessionId: "" }],
      ["created timestamp", { ...valid, createdAt: -1 }],
      ["lifecycle timestamp", { ...valid, state: "pending", leaseUntil: "later" }],
      ["size", { ...valid, size: 2 * 1024 * 1024 + 1 }],
      ["state", { ...valid, state: "published" }],
    ]

    for (const [name, invalid] of cases) {
      value.storage.objects.set(key, { ...object, body: new TextEncoder().encode(JSON.stringify(invalid)) })
      await expect(value.workspace.listSnapshots(handle), name).rejects.toMatchObject({
        code: "document_snapshot_corrupt",
      })
      await expect(value.workspace.readSnapshot(handle, snapshot.id), name).rejects.toMatchObject({
        code: "document_snapshot_corrupt",
      })
      await expect(value.workspace.collectSnapshots(handle), name).rejects.toMatchObject({
        code: "document_snapshot_corrupt",
      })
    }
  })

  test("rejects oversized hosted snapshot sidecars with a typed corrupt error", async () => {
    const value = fixture()
    await value.workspace.create(value.entry, { markdown: "one", actor: { type: "user", id: "user" } })
    const handle = await value.workspace.resolve(value.entry)
    const snapshot = (await value.workspace.listSnapshots(handle))[0]!
    const key = [...value.storage.objects.keys()].find(
      (candidate) => candidate.startsWith("document-history/") && candidate.endsWith(`${snapshot.id}.json`),
    )!
    const object = value.storage.objects.get(key)!
    value.storage.objects.set(key, { ...object, body: new Uint8Array(MAX_SNAPSHOT_METADATA_BYTES + 1) })

    await expect(value.workspace.listSnapshots(handle)).rejects.toMatchObject({ code: "document_snapshot_corrupt" })
    await expect(value.workspace.readSnapshot(handle, snapshot.id)).rejects.toMatchObject({
      code: "document_snapshot_corrupt",
    })
    await expect(value.workspace.collectSnapshots(handle)).rejects.toMatchObject({
      code: "document_snapshot_corrupt",
    })
  })

  test("hosted index rejects object metadata that crosses its org/project/key scope", async () => {
    const storage = emulator()
    const index = createHostedDocumentIndex(storage.store)
    await index.create(indexEntry())
    const entry = {
      id: "document_1",
      org_id: "org_other",
      project_id: "project_1",
      display_name: "Poisoned",
      origin_kind: "managed",
      placement_kind: "hosted",
      placement_id: "r2",
      managed_relative_path: "document_1/plan.md",
      repository_id: null,
      workspace_id: null,
      repository_relative_path: null,
      branch: null,
      status: "draft",
      session_id: null,
      archived_at: null,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
      last_opened_at: null,
      last_known_file_version: null,
    } as const
    const key = [...storage.objects.keys()].find((candidate) =>
      candidate.startsWith("document-index/org_1/project_1/document_1/"),
    )!
    await storage.store.put(key, new TextEncoder().encode(JSON.stringify(entry)), {
      etag: storage.objects.get(key)!.etag,
    })
    await expect(index.list({ orgId: "org_1", projectId: "project_1" })).rejects.toMatchObject({
      code: "document_index_scope_mismatch",
    })
  })

  test("hosted index rejects parseable dates that are not ISO datetimes", async () => {
    const storage = emulator()
    const index = createHostedDocumentIndex(storage.store)
    await index.create(indexEntry())
    const entry = {
      id: "document_1",
      org_id: "org_1",
      project_id: "project_1",
      display_name: "Invalid date",
      origin_kind: "managed",
      placement_kind: "hosted",
      placement_id: "r2",
      managed_relative_path: "document_1/plan.md",
      repository_id: null,
      workspace_id: null,
      repository_relative_path: null,
      branch: null,
      status: "draft",
      session_id: null,
      archived_at: null,
      created_at: "July 16, 2026",
      updated_at: new Date(0).toISOString(),
      last_opened_at: null,
      last_known_file_version: null,
    } as const
    const key = [...storage.objects.keys()].find((candidate) =>
      candidate.startsWith("document-index/org_1/project_1/document_1/"),
    )!
    await storage.store.put(key, new TextEncoder().encode(JSON.stringify(entry)), {
      etag: storage.objects.get(key)!.etag,
    })

    await expect(index.list({ orgId: "org_1", projectId: "project_1" })).rejects.toMatchObject({
      code: "document_index_corrupt",
    })
  })

  test("hosted index ignores locator-less objects and never mutates them", async () => {
    const storage = emulator()
    const index = createHostedDocumentIndex(storage.store)
    const key = "document-index/org_1/project_1/document_1.json"
    await storage.store.put(key, new TextEncoder().encode(JSON.stringify(indexEntry())), { absent: true })

    await expect(index.list({ orgId: "org_1", projectId: "project_1" })).resolves.toEqual([])
    await expect(
      index.update({ orgId: "org_1", projectId: "project_1" }, "document_1", { display_name: "Ignored" }),
    ).rejects.toMatchObject({ code: "document_index_not_found" })
    await index.remove({ orgId: "org_1", projectId: "project_1" }, "document_1")

    expect(storage.objects.has(key)).toBe(true)
  })

  test("hosted exact lookup follows its locator without listing organization objects", async () => {
    const storage = emulator()
    const index = createHostedDocumentIndex({
      ...storage.store,
      async list() {
        throw new Error("exact lookup must not list")
      },
    })
    await index.create(indexEntry())

    await expect(index.find("org_1", "document_1")).resolves.toMatchObject({
      id: "document_1",
      project_id: "project_1",
    })
  })

  test("a partial create is resumable only by its claimed project", async () => {
    const storage = emulator()
    let interrupt = true
    const index = createHostedDocumentIndex({
      ...storage.store,
      async put(key, body, condition) {
        if (interrupt && key.startsWith("document-index/")) {
          interrupt = false
          throw new Error("create interrupted")
        }
        return await storage.store.put(key, body, condition)
      },
    })

    await expect(index.create(indexEntry())).rejects.toThrow("create interrupted")
    await expect(index.find("org_1", "document_1")).resolves.toBeUndefined()
    await expect(index.create(indexEntry("project_2"))).rejects.toThrow("already exists")
    await expect(index.create(indexEntry())).resolves.toMatchObject({ project_id: "project_1" })
    await expect(index.find("org_1", "document_1")).resolves.toMatchObject({ project_id: "project_1" })
  })

  test("a partial delete hides the old generation and can finish before cross-project recreation", async () => {
    const storage = emulator()
    let interrupt = true
    const index = createHostedDocumentIndex({
      ...storage.store,
      async delete(key) {
        if (interrupt && key.startsWith("document-index/")) {
          interrupt = false
          throw new Error("delete interrupted")
        }
        await storage.store.delete(key)
      },
    })
    await index.create(indexEntry())

    await expect(index.remove({ orgId: "org_1", projectId: "project_1" }, "document_1")).rejects.toThrow(
      "delete interrupted",
    )
    await expect(index.find("org_1", "document_1")).resolves.toBeUndefined()
    await index.remove({ orgId: "org_1", projectId: "project_1" }, "document_1")
    await expect(index.create(indexEntry("project_2"))).resolves.toMatchObject({ project_id: "project_2" })
    await expect(index.find("org_1", "document_1")).resolves.toMatchObject({ project_id: "project_2" })
  })

  test("a snapshot failure during create never publishes a live canonical object", async () => {
    const storage = emulator()
    const workspace = createHostedManagedDocumentWorkspace({
      store: {
        ...storage.store,
        async put(key, body, condition) {
          if (key.endsWith(".json")) throw new Error("snapshot metadata unavailable")
          return storage.store.put(key, body, condition)
        },
      },
    })
    const value = fixture()
    await expect(
      workspace.create(value.entry, {
        markdown: "draft",
        actor: { type: "user", id: "user" },
      }),
    ).rejects.toThrow("snapshot metadata unavailable")
    expect([...storage.objects.keys()].some((key) => key.startsWith("documents/"))).toBe(false)
  })

  test("an interrupted create resumes only the claimed content", async () => {
    const storage = emulator()
    let fail = true
    const workspace = createHostedManagedDocumentWorkspace({
      store: {
        ...storage.store,
        async put(key, body, condition) {
          if (fail && key.startsWith("document-history/") && key.endsWith(".json")) {
            fail = false
            throw new Error("publish interrupted")
          }
          return storage.store.put(key, body, condition)
        },
      },
    })
    const value = fixture()
    await expect(
      workspace.create(value.entry, {
        markdown: "claimed",
        actor: { type: "user", id: "user" },
      }),
    ).rejects.toThrow("interrupted")
    await expect(
      workspace.create(value.entry, {
        markdown: "other",
        actor: { type: "user", id: "user" },
      }),
    ).rejects.toThrow()
    await workspace.create(value.entry, { markdown: "claimed", actor: { type: "user", id: "user" } })
    const handle = await workspace.resolve(value.entry)
    expect((await workspace.read(handle)).markdown).toBe("claimed")
    expect(await workspace.listSnapshots(handle)).toHaveLength(1)
  })

  test("a losing concurrent create cannot publish its history", async () => {
    const storage = emulator()
    const workspace = createHostedManagedDocumentWorkspace({ store: storage.store })
    const value = fixture()
    const attempts = await Promise.allSettled(
      ["winner", "loser"].map((markdown) =>
        workspace.create(value.entry, {
          markdown,
          actor: { type: "user", id: markdown },
        }),
      ),
    )
    expect(attempts.map((attempt) => attempt.status).sort()).toEqual(["fulfilled", "rejected"])
    const handle = await workspace.resolve(value.entry)
    const canonical = await workspace.read(handle)
    const snapshots = await workspace.listSnapshots(handle)
    expect(snapshots).toHaveLength(1)
    expect((await workspace.readSnapshot(handle, snapshots[0]!.id)).markdown).toBe(canonical.markdown)
  })

  test("a sequential duplicate create cannot publish or collect losing history", async () => {
    const value = fixture()
    await value.workspace.create(value.entry, { markdown: "winner", actor: { type: "user", id: "winner" } })
    await expect(
      value.workspace.create(value.entry, {
        markdown: "loser",
        actor: { type: "user", id: "loser" },
      }),
    ).rejects.toThrow()
    const handle = await value.workspace.resolve(value.entry)
    const snapshots = await value.workspace.listSnapshots(handle)
    expect(snapshots).toHaveLength(1)
    expect((await value.workspace.readSnapshot(handle, snapshots[0]!.id)).markdown).toBe("winner")
  })

  test("snapshot collection cannot delete a snapshot pinned during its GC claim race", async () => {
    const storage = emulator()
    let release = () => {}
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let reached = () => {}
    const collecting = new Promise<void>((resolve) => {
      reached = resolve
    })
    let candidate: string | undefined
    const workspace = createHostedManagedDocumentWorkspace({
      store: storage.store,
      maxSnapshots: 1,
      beforeSnapshotGcClaim: async (snapshotId) => {
        candidate = snapshotId
        reached()
        await blocked
      },
    })
    const value = fixture()
    const created = await workspace.create(value.entry, { markdown: "one", actor: { type: "user", id: "user" } })
    const handle = await workspace.resolve(value.entry)
    const writing = workspace.write(handle, {
      markdown: "two",
      expectedVersion: created.version,
      actor: { type: "user", id: "user" },
    })
    await collecting
    await workspace.pinSnapshot(handle, candidate as never, "keep")
    release()
    await writing
    expect((await workspace.listSnapshots(handle)).find((snapshot) => snapshot.id === candidate)?.pins).toEqual([
      "keep",
    ])
  })

  test("snapshot collection prunes an expired intake lease before collecting abandoned history", async () => {
    const storage = emulator()
    let clock = 1_000
    const workspace = createHostedManagedDocumentWorkspace({
      store: storage.store,
      maxSnapshots: 1,
      snapshotDeleteGraceMs: 0,
      now: () => clock,
    })
    const value = fixture()
    const created = await workspace.create(value.entry, { markdown: "one", actor: { type: "user", id: "user" } })
    const handle = await workspace.resolve(value.entry)
    const first = (await workspace.listSnapshots(handle))[0]!
    await workspace.pinSnapshot(handle, first.id, "lease:1500:work-source")
    clock = 2_000
    await workspace.write(handle, {
      markdown: "two",
      expectedVersion: created.version,
      actor: { type: "user", id: "user" },
    })
    expect((await workspace.listSnapshots(handle)).map((snapshot) => snapshot.id)).not.toContain(first.id)
  })

  test("a permanent pin racing expired-lease pruning prevents collection", async () => {
    const storage = emulator()
    let clock = 1_000
    let candidate: string | undefined
    const workspace = createHostedManagedDocumentWorkspace({
      store: storage.store,
      maxSnapshots: 1,
      snapshotDeleteGraceMs: 0,
      now: () => clock,
      beforeSnapshotGcClaim: async (snapshotId) => {
        candidate = snapshotId
        await workspace.pinSnapshot(handle, snapshotId, "work-source:permanent")
      },
    })
    const value = fixture()
    const created = await workspace.create(value.entry, { markdown: "one", actor: { type: "user", id: "user" } })
    const handle = await workspace.resolve(value.entry)
    const first = (await workspace.listSnapshots(handle))[0]!
    await workspace.pinSnapshot(handle, first.id, "lease:1500:work-source")
    clock = 2_000
    await workspace.write(handle, {
      markdown: "two",
      expectedVersion: created.version,
      actor: { type: "user", id: "user" },
    })
    expect(candidate).toBe(first.id)
    expect((await workspace.listSnapshots(handle)).find((snapshot) => snapshot.id === first.id)?.pins).toContain(
      "work-source:permanent",
    )
  })

  test("snapshot collection resumes a deleting tombstone after restart", async () => {
    const storage = emulator()
    let fail = true
    const workspace = createHostedManagedDocumentWorkspace({
      store: storage.store,
      maxSnapshots: 1,
      afterSnapshotGcClaim: async () => {
        if (!fail) return
        fail = false
        throw new Error("collector crashed")
      },
    })
    const value = fixture()
    const created = await workspace.create(value.entry, { markdown: "one", actor: { type: "user", id: "user" } })
    const handle = await workspace.resolve(value.entry)
    await workspace.write(handle, {
      markdown: "two",
      expectedVersion: created.version,
      actor: { type: "user", id: "user" },
    })
    expect(
      [...storage.objects.keys()].some((key) => key.endsWith(".json") && key.startsWith("document-history/")),
    ).toBe(true)
    const restarted = createHostedManagedDocumentWorkspace({ store: storage.store, maxSnapshots: 1 })
    await restarted.collectSnapshots(await restarted.resolve(value.entry))
    expect(await restarted.listSnapshots(await restarted.resolve(value.entry))).toHaveLength(1)
  })

  test("a pin arriving after the GC claim revives the snapshot during grace", async () => {
    const storage = emulator()
    let release = () => {}
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let reached = () => {}
    const claimed = new Promise<void>((resolve) => {
      reached = resolve
    })
    const workspace = createHostedManagedDocumentWorkspace({
      store: storage.store,
      maxSnapshots: 1,
      afterSnapshotGcClaim: async () => {
        reached()
        await blocked
      },
    })
    const value = fixture()
    const created = await workspace.create(value.entry, { markdown: "one", actor: { type: "user", id: "user" } })
    const handle = await workspace.resolve(value.entry)
    const first = (await workspace.listSnapshots(handle))[0]!
    const writing = workspace.write(handle, {
      markdown: "two",
      expectedVersion: created.version,
      actor: { type: "user", id: "user" },
    })
    await claimed
    await workspace.pinSnapshot(handle, first.id, "work-source")
    release()
    await writing
    expect((await workspace.listSnapshots(handle)).find((snapshot) => snapshot.id === first.id)?.pins).toEqual([
      "work-source",
    ])
  })

  test("a committed write remains successful when snapshot retention maintenance fails", async () => {
    const storage = emulator()
    const report = vi.spyOn(console, "error").mockImplementation(() => {})
    const workspace = createHostedManagedDocumentWorkspace({
      maxSnapshots: 1,
      snapshotDeleteGraceMs: 0,
      store: {
        ...storage.store,
        delete: async (key) => {
          if (key.startsWith("document-history/")) throw new Error("retention unavailable")
          await storage.store.delete(key)
        },
      },
    })
    const value = fixture()
    const created = await workspace.create(value.entry, { markdown: "one", actor: { type: "user", id: "user" } })
    const handle = await workspace.resolve(value.entry)
    const written = await workspace.write(handle, {
      markdown: "two",
      expectedVersion: created.version,
      actor: { type: "user", id: "user" },
    })
    expect(await workspace.read(handle)).toMatchObject({ markdown: "two", version: written.version })
    expect(report).toHaveBeenCalled()
    report.mockRestore()
  })

  test("snapshot collection cannot delete a pending in-flight write lease", async () => {
    const storage = emulator()
    let release = () => {}
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    let reached = () => {}
    const pending = new Promise<void>((resolve) => {
      reached = resolve
    })
    const workspace = createHostedManagedDocumentWorkspace({
      store: storage.store,
      beforeCanonicalWrite: async () => {
        reached()
        await blocked
      },
    })
    const value = fixture()
    const created = await workspace.create(value.entry, { markdown: "one", actor: { type: "user", id: "user" } })
    const handle = await workspace.resolve(value.entry)
    const writing = workspace.write(handle, {
      markdown: "two",
      expectedVersion: created.version,
      actor: { type: "user", id: "user" },
    })
    await pending
    await workspace.collectSnapshots(handle)
    release()
    await writing
    expect(
      (await workspace.listSnapshots(handle)).map((snapshot) => workspace.readSnapshot(handle, snapshot.id)),
    ).toHaveLength(2)
  })

  test("hydrates only one selected object and VM loss keeps the last durable write-back", async () => {
    const value = fixture()
    const created = await value.workspace.create(value.entry, {
      markdown: "before",
      actor: { type: "user", id: "user" },
    })
    const handle = await value.workspace.resolve(value.entry)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hosted-hydration-"))
    roots.push(root)
    const reads = value.storage.reads()
    const hydrated = await hydrateSessionDocument({
      sessionId: "session-a",
      workspaceRoot: root,
      documentId: value.entry.documentId,
      displayName: "Plan",
      markdown: "before",
      baseVersion: created.version,
      sync: async (markdown, expectedVersion) =>
        (
          await value.workspace.write(handle, {
            markdown,
            expectedVersion: expectedVersion as typeof created.version,
            actor: { type: "agent", id: "session-a" },
          })
        ).version,
    })
    expect(value.storage.reads() - reads).toBe(0)
    expect((await fs.readdir(path.join(root, ".claxedo", "sessions", "session-a", "docs"))).sort()).toEqual([
      "document_1",
      "manifest.json",
    ])
    await fs.writeFile(hydrated, "agent write")
    await syncHydratedSessionDocuments("session-a")
    expect((await value.workspace.read(handle)).markdown).toBe("agent write")
    forgetHydratedSessionRuntime("session-a")
    await fs.rm(root, { recursive: true, force: true })
    expect((await value.workspace.read(handle)).markdown).toBe("agent write")
  })

  test("hosted capability applies one R2 CAS and rejects another document scope", async () => {
    const storage = emulator()
    const key = await generateKeyPair("EdDSA", { extractable: true })
    const env = {
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM: "EdDSA",
    }
    let registerCapability: ((input: { jti: string; jobExpiresAt: number }) => Promise<void>) | undefined
    const backend = createHostedDocumentsBackend(
      {
        get: async (key) => {
          const object = await storage.store.get(key)
          return object
            ? {
                etag: object.etag,
                uploaded: new Date(object.uploadedAt),
                size: object.body.byteLength,
                body: new Response(object.body.slice()).body!,
              }
            : null
        },
        put: async (key, body, options) => {
          const current = await storage.store.get(key)
          const condition = options?.onlyIf?.etagMatches
            ? { etag: options.onlyIf.etagMatches }
            : { absent: true as const }
          const written = await storage.store.put(key, body, condition)
          return written ? { etag: written.etag, uploaded: new Date(written.uploadedAt) } : null
        },
        delete: storage.store.delete,
        list: async ({ prefix }) => ({
          objects: (await storage.store.list(prefix)).map((object) => ({
            ...object,
            uploaded: new Date(object.uploadedAt),
          })),
          truncated: false,
        }),
      },
      {
        runtime: {
          open: async (input) => {
            registerCapability = input.registerCapability
            return { path: "/workspace/document.md" }
          },
        },
        resolveSessionWorkspace: async () => "ws_1",
        env,
      },
    )
    const now = new Date().toISOString()
    const indexed = {
      id: "document_1",
      org_id: "org_1",
      project_id: "project_1",
      display_name: "Plan",
      origin_kind: "managed" as const,
      placement_kind: "hosted" as const,
      placement_id: "r2",
      managed_relative_path: "document_1/plan.md",
      repository_id: null,
      workspace_id: null,
      repository_relative_path: null,
      branch: null,
      status: "draft",
      session_id: "session_1",
      archived_at: null,
      created_at: now,
      updated_at: now,
      last_opened_at: null,
      last_known_file_version: null,
    }
    await backend.index.create(indexed)
    const created = await backend.workspace.create(
      {
        origin: "managed",
        placement: "hosted",
        orgId: "org_1",
        projectId: "project_1",
        documentId: "document_1",
        relativePath: "document_1/plan.md",
      },
      { markdown: "before", actor: { type: "user", id: "user" } },
    )
    const jobExpiresAt = Math.floor(Date.now() / 1000) + 3600
    const capability = await mintDocumentSessionToken(
      {
        orgId: "org_1",
        projectId: "project_1",
        workspaceId: "ws_1",
        sessionId: "session_1",
        documentId: "document_1",
        jobExpiresAt,
      },
      env,
    )
    await backend.agentOpen!(indexed, "session_1", {
      auth: { user: { subject: "user_1" } } as never,
      origin: "https://control.test",
    })
    await registerCapability!({ jti: capability.jti, jobExpiresAt })
    const written = await backend.runtimeWriteback!(indexed, {
      token: capability.token,
      orgId: "org_1",
      projectId: "project_1",
      workspaceId: "ws_1",
      sessionId: "session_1",
      markdown: "agent edit",
      expectedVersion: created.version,
    })
    expect(
      (
        await backend.workspace.read(
          await backend.workspace.resolve({
            origin: "managed",
            placement: "hosted",
            orgId: "org_1",
            projectId: "project_1",
            documentId: "document_1",
            relativePath: "document_1/plan.md",
          }),
        )
      ).markdown,
    ).toBe("agent edit")
    const renewed = await backend.runtimeRenew!(indexed, {
      token: capability.token,
      orgId: "org_1",
      projectId: "project_1",
      workspaceId: "ws_1",
      sessionId: "session_1",
    })
    expect(renewed.token).not.toBe(capability.token)
    await expect(
      backend.runtimeRenew!(indexed, {
        token: capability.token,
        orgId: "org_1",
        projectId: "project_1",
        workspaceId: "ws_1",
        sessionId: "session_1",
      }),
    ).rejects.toThrow("inactive")
    await expect(
      backend.runtimeRenew!(
        { ...indexed, archived_at: new Date().toISOString() },
        {
          token: renewed.token,
          orgId: "org_1",
          projectId: "project_1",
          workspaceId: "ws_1",
          sessionId: "session_1",
        },
      ),
    ).rejects.toThrow("inactive")
    await expect(
      backend.runtimeWriteback!(indexed, {
        token: capability.token,
        orgId: "org_1",
        projectId: "project_1",
        workspaceId: "ws_1",
        sessionId: "session_2",
        markdown: "attack",
        expectedVersion: written.version,
      }),
    ).rejects.toThrow()
  })

  test("durable job authority survives isolate changes and rotates capability atomically", async () => {
    const storage = emulator()
    const key = await generateKeyPair("EdDSA", { extractable: true })
    const env = {
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM: "EdDSA",
    }
    let capability: Awaited<ReturnType<typeof mintDocumentSessionToken>> | undefined
    const runtime = {
      open: async (input: {
        entry: DocumentIndexEntry
        sessionId: string
        jobExpiresAt?: number
        registerCapability?: (value: { jti: string; jobExpiresAt: number }) => Promise<void>
      }) => {
        const jobExpiresAt = input.jobExpiresAt!
        capability = await mintDocumentSessionToken(
          {
            orgId: input.entry.org_id,
            projectId: input.entry.project_id,
            workspaceId: "ws_1",
            sessionId: input.sessionId,
            documentId: input.entry.id,
            jobExpiresAt,
          },
          env,
        )
        await input.registerCapability?.({ jti: capability.jti, jobExpiresAt })
        return { path: "/workspace/document.md" }
      },
    }
    const options = { runtime, resolveSessionWorkspace: async () => "ws_1", env }
    const first = createHostedDocumentsBackend(r2(storage), options)
    const now = new Date().toISOString()
    const entry = {
      id: "document_isolates",
      org_id: "org_1",
      project_id: "project_1",
      display_name: "Plan",
      origin_kind: "managed" as const,
      placement_kind: "hosted" as const,
      placement_id: "r2",
      managed_relative_path: "document_isolates/plan.md",
      repository_id: null,
      workspace_id: null,
      repository_relative_path: null,
      branch: null,
      status: "draft",
      session_id: "session_1",
      archived_at: null,
      created_at: now,
      updated_at: now,
      last_opened_at: null,
      last_known_file_version: null,
    }
    await first.index.create(entry)
    const created = await first.workspace.create(
      {
        origin: "managed",
        placement: "hosted",
        orgId: "org_1",
        projectId: "project_1",
        documentId: entry.id,
        relativePath: entry.managed_relative_path,
      },
      { markdown: "before", actor: { type: "user", id: "user" } },
    )
    await first.agentOpen!(entry, "session_1", {
      auth: {
        mode: "signed",
        token: "user-bearer",
        user: {
          subject: "user_1",
          tokenIdentifier: "token_1",
          issuer: "https://issuer.test",
        },
      },
      origin: "https://control.test",
    })
    const second = createHostedDocumentsBackend(r2(storage), options)
    const written = await second.runtimeWriteback!(entry, {
      token: capability!.token,
      orgId: "org_1",
      projectId: "project_1",
      workspaceId: "ws_1",
      sessionId: "session_1",
      markdown: "isolate two",
      expectedVersion: created.version,
    })
    const next = await second.runtimeRenew!(entry, {
      token: capability!.token,
      orgId: "org_1",
      projectId: "project_1",
      workspaceId: "ws_1",
      sessionId: "session_1",
    })
    const third = createHostedDocumentsBackend(r2(storage), options)
    await expect(
      third.runtimeWriteback!(entry, {
        token: capability!.token,
        orgId: "org_1",
        projectId: "project_1",
        workspaceId: "ws_1",
        sessionId: "session_1",
        markdown: "stale capability",
        expectedVersion: written.version,
      }),
    ).rejects.toThrow("inactive")
    await expect(
      third.runtimeWriteback!(entry, {
        token: next.token,
        orgId: "org_1",
        projectId: "project_1",
        workspaceId: "ws_1",
        sessionId: "session_1",
        markdown: "isolate three",
        expectedVersion: written.version,
      }),
    ).resolves.toMatchObject({ markdown: "isolate three" })
    const jobKey = [...storage.objects.keys()].find((key) => key.startsWith("document-jobs/"))!
    vi.useFakeTimers()
    vi.setSystemTime(Date.now() + 60 * 60 * 1000 + 1)
    await expect(
      third.runtimeEntry!(entry.id, {
        token: next.token,
        orgId: "org_1",
        projectId: "project_1",
        workspaceId: "ws_1",
        sessionId: "session_1",
      }),
    ).rejects.toThrow("expired")
    expect(new TextDecoder().decode(storage.objects.get(jobKey)!.body)).not.toContain("sealedAuth")
    vi.useRealTimers()
    await third.agentOpen!(entry, "session_dispose", {
      auth: {
        mode: "signed",
        token: "user-bearer",
        user: {
          subject: "user_1",
          tokenIdentifier: "token_1",
          issuer: "https://issuer.test",
        },
      },
      origin: "https://control.test",
    })
    await third.runtimeDispose!(entry, {
      token: capability!.token,
      orgId: "org_1",
      projectId: "project_1",
      workspaceId: "ws_1",
      sessionId: "session_dispose",
    })
    const disposed = [...storage.objects.entries()].find(([key]) => key.includes("session_dispose"))
    expect(new TextDecoder().decode(disposed![1].body)).not.toContain("sealedAuth")
    await third.agentOpen!(entry, "session_race", {
      auth: {
        mode: "signed",
        token: "user-bearer",
        user: {
          subject: "user_1",
          tokenIdentifier: "token_1",
          issuer: "https://issuer.test",
        },
      },
      origin: "https://control.test",
    })
    const raceKey = [...storage.objects.keys()].find((key) => key.includes("session_race"))!
    const raceObject = storage.objects.get(raceKey)!
    const replacementBody = raceObject.body.slice()
    storage.objects.set(raceKey, {
      ...raceObject,
      body: new TextEncoder().encode(
        JSON.stringify({
          ...JSON.parse(new TextDecoder().decode(raceObject.body)),
          jobExpiresAt: Math.floor(Date.now() / 1000) - 1,
        }),
      ),
    })
    const originalPut = storage.store.put
    let replaced = false
    ;(storage.store as { put: typeof storage.store.put }).put = async (key, body, condition) => {
      if (!replaced && key === raceKey && new TextDecoder().decode(body).includes('"expired":true')) {
        replaced = true
        storage.objects.set(raceKey, {
          body: replacementBody,
          etag: "concurrent-replacement",
          uploadedAt: Date.now(),
        })
        return undefined
      }
      return await originalPut(key, body, condition)
    }
    await expect(
      third.runtimeEntry!(entry.id, {
        token: capability!.token,
        orgId: "org_1",
        projectId: "project_1",
        workspaceId: "ws_1",
        sessionId: "session_race",
      }),
    ).rejects.toThrow("expired")
    expect(replaced).toBe(true)
    expect(new TextDecoder().decode(storage.objects.get(raceKey)!.body)).toContain("sealedAuth")
    ;(storage.store as { put: typeof storage.store.put }).put = originalPut
  })

  test("EC-D7/D9 parks a conflicted manifest and preserves browser plus VM copies", async () => {
    const value = fixture()
    const created = await value.workspace.create(value.entry, {
      markdown: "before",
      actor: { type: "user", id: "user" },
    })
    const handle = await value.workspace.resolve(value.entry)
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hosted-conflict-"))
    roots.push(root)
    const hydrated = await hydrateSessionDocument({
      sessionId: "session-conflict",
      workspaceRoot: root,
      documentId: value.entry.documentId,
      displayName: "Plan",
      markdown: "before",
      baseVersion: created.version,
      sync: async (markdown, expectedVersion) =>
        (
          await value.workspace.write(handle, {
            markdown,
            expectedVersion: expectedVersion as typeof created.version,
            actor: { type: "agent", id: "session-conflict" },
          })
        ).version,
    })
    await value.workspace.write(handle, {
      markdown: "browser write",
      expectedVersion: created.version,
      actor: { type: "user", id: "browser" },
    })
    await fs.writeFile(hydrated, "VM draft")
    await expect(syncHydratedSessionDocuments("session-conflict")).rejects.toBeInstanceOf(DocumentVersionConflictError)
    expect(await fs.readFile(hydrated, "utf8")).toBe("VM draft")
    expect((await value.workspace.read(handle)).markdown).toBe("browser write")
    await fs.writeFile(hydrated, "later VM draft")
    await expect(syncHydratedSessionDocuments("session-conflict")).rejects.toBeInstanceOf(DocumentVersionConflictError)
    expect((await value.workspace.read(handle)).markdown).toBe("browser write")
    forgetHydratedSessionRuntime("session-conflict")
  })

  test("EC-D10 two sessions hydrate together and object CAS parks the loser", async () => {
    const value = fixture()
    const created = await value.workspace.create(value.entry, {
      markdown: "before",
      actor: { type: "user", id: "user" },
    })
    const handle = await value.workspace.resolve(value.entry)
    const rootsForSessions = await Promise.all(
      ["a", "b"].map(async (session) => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), `hosted-${session}-`))
        roots.push(root)
        const hydrated = await hydrateSessionDocument({
          sessionId: session,
          workspaceRoot: root,
          documentId: value.entry.documentId,
          displayName: "Plan",
          markdown: "before",
          baseVersion: created.version,
          sync: async (markdown, expectedVersion) =>
            (
              await value.workspace.write(handle, {
                markdown,
                expectedVersion: expectedVersion as typeof created.version,
                actor: { type: "agent", id: session },
              })
            ).version,
        })
        return { session, hydrated }
      }),
    )
    await Promise.all(rootsForSessions.map((item) => fs.writeFile(item.hydrated, `write-${item.session}`)))
    const settled = await Promise.allSettled(rootsForSessions.map((item) => syncHydratedSessionDocuments(item.session)))
    expect(settled.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"])
    expect(["write-a", "write-b"]).toContain((await value.workspace.read(handle)).markdown)
    rootsForSessions.forEach((item) => forgetHydratedSessionRuntime(item.session))
  })
})
