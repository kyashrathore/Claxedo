import { describe, expect, test } from "vitest"
import { createHostedDocumentIndex } from "./index"
import {
  createHostedManagedDocumentWorkspace,
  createR2ConditionalObjectStore,
  hostedManagedRelativePath,
  objectListing,
  resumeAfterKey,
  type ConditionalObjectStore,
  type R2BucketBinding,
} from "./managed"
import { projectIndexKey } from "./project-index"
import type { DocumentIndexEntry } from "../../index-contract"
import type { DocumentEntry } from "../../port"
import { createDocumentsService } from "../../service"

/**
 * An in-memory `ConditionalObjectStore` that counts every operation, so cost claims are measured
 * rather than asserted. Listings honour `limit`/`cursor` exactly as the R2 adapter does.
 */
function countingStore() {
  const objects = new Map<string, { body: Uint8Array; etag: string; uploadedAt: number }>()
  let clock = 0
  const counts = { get: 0, put: 0, delete: 0, list: 0 }
  const store: ConditionalObjectStore = {
    async get(key) {
      counts.get++
      const object = objects.get(key)
      return object ? { key, body: object.body.slice(), etag: object.etag, uploadedAt: object.uploadedAt } : undefined
    },
    async put(key, body, condition) {
      counts.put++
      const current = objects.get(key)
      if (condition.absent && current) return undefined
      if (condition.etag && current?.etag !== condition.etag) return undefined
      const etag = `etag-${++clock}`
      objects.set(key, { body: body.slice(), etag, uploadedAt: ++clock })
      return { etag, uploadedAt: clock }
    },
    async delete(key) {
      counts.delete++
      objects.delete(key)
    },
    async list(prefix, options) {
      counts.list++
      const after = resumeAfterKey(options?.cursor)
      const all = [...objects.entries()]
        .filter(([key]) => key.startsWith(prefix) && (!after || key > after))
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, object]) => ({ key, etag: object.etag, uploadedAt: object.uploadedAt }))
      if (options?.limit !== undefined && all.length > options.limit) {
        const kept = all.slice(0, options.limit)
        return objectListing(kept, { truncated: true, cursor: `after:${kept.at(-1)!.key}` })
      }
      return objectListing(all, { truncated: false })
    },
  }
  const total = () => counts.get + counts.put + counts.delete + counts.list
  return { store, objects, counts, total }
}

function entry(position: number, overrides: Partial<DocumentIndexEntry> = {}) {
  const stamp = new Date(1_700_000_000_000 + position).toISOString()
  return {
    id: `document_${position}`,
    org_id: "org_1",
    project_id: "project_1",
    display_name: `Doc ${position}`,
    origin_kind: "managed",
    placement_kind: "hosted",
    placement_id: "r2",
    managed_relative_path: `document_${position}/doc.md`,
    repository_id: null,
    workspace_id: null,
    repository_relative_path: null,
    branch: null,
    status: "draft",
    session_id: null,
    archived_at: null,
    created_at: stamp,
    updated_at: stamp,
    last_opened_at: null,
    last_known_file_version: null,
    ...overrides,
  } as DocumentIndexEntry
}

function repositoryEntry(position: number, repositoryId: string) {
  return entry(position, {
    origin_kind: "repository",
    managed_relative_path: null,
    repository_id: repositoryId,
    workspace_id: "workspace_1",
    repository_relative_path: `docs/file-${position}.md`,
    branch: null,
  })
}

const scope = { orgId: "org_1", projectId: "project_1" }

describe("hosted project index", () => {
  test("POSITIVE CONTROL: listing a 1,000-document project costs O(1) R2 operations", async () => {
    const storage = countingStore()
    const index = createHostedDocumentIndex(storage.store)
    for (let position = 0; position < 1_000; position++) await index.create(entry(position))

    const before = storage.total()
    const listed = await index.list(scope)
    const spent = storage.total() - before

    expect(listed).toHaveLength(1_000)
    // One GET for the cached roll-up plus one LIST to verify it against the authoritative key set.
    // Pre-fix this cost 1 LIST + 2 GETs per document (2,001 operations for this project).
    expect(spent).toBeLessThanOrEqual(4)
    // And listing again must not grow: cost is independent of document count.
    const second = storage.total()
    await index.list(scope)
    expect(storage.total() - second).toBe(spent)
  })

  test("listing scales flat: 100 and 1,000 documents cost the same", async () => {
    const cost = async (documents: number) => {
      const storage = countingStore()
      const index = createHostedDocumentIndex(storage.store)
      for (let position = 0; position < documents; position++) await index.create(entry(position))
      const before = storage.total()
      expect(await index.list(scope)).toHaveLength(documents)
      return storage.total() - before
    }

    expect(await cost(1_000)).toBe(await cost(100))
  })

  test("a cache miss rebuilds from the authoritative objects and serves the same entries", async () => {
    const storage = countingStore()
    const index = createHostedDocumentIndex(storage.store)
    for (let position = 0; position < 5; position++) await index.create(entry(position))
    const expected = await index.list(scope)

    storage.objects.delete(projectIndexKey(scope))
    expect(await index.list(scope)).toEqual(expected)
    // The rebuild republished the cache, so the next read is cheap again.
    const before = storage.total()
    await index.list(scope)
    expect(storage.total() - before).toBeLessThanOrEqual(4)
  })

  test("a corrupt cache is rebuilt rather than served", async () => {
    const storage = countingStore()
    const index = createHostedDocumentIndex(storage.store)
    await index.create(entry(1))
    const expected = await index.list(scope)

    storage.objects.set(projectIndexKey(scope), {
      body: new TextEncoder().encode("{ not json"),
      etag: "corrupt",
      uploadedAt: 1,
    })
    expect(await index.list(scope)).toEqual(expected)
  })

  test("a cache that disagrees with an authoritative object loses: the object wins", async () => {
    const storage = countingStore()
    const index = createHostedDocumentIndex(storage.store)
    await index.create(entry(1))
    await index.list(scope)

    // Rewrite the authoritative object behind the cache's back, exactly as a divergent writer would.
    const key = [...storage.objects.keys()].find((candidate) =>
      candidate.startsWith("document-index/org_1/project_1/document_1/"),
    )!
    const poisoned = { ...entry(1), display_name: "Written behind the cache" }
    await storage.store.put(key, new TextEncoder().encode(JSON.stringify(poisoned)), {
      etag: storage.objects.get(key)!.etag,
    })

    expect((await index.list(scope))[0]?.display_name).toBe("Written behind the cache")
  })

  test("a document added behind the cache still appears", async () => {
    const storage = countingStore()
    const first = createHostedDocumentIndex(storage.store)
    await first.create(entry(1))
    await first.list(scope)

    // A second isolate creates a document; the first isolate's cache never saw it.
    await createHostedDocumentIndex(storage.store).create(entry(2))

    expect((await first.list(scope)).map((value) => value.id).sort()).toEqual(["document_1", "document_2"])
  })

  test("archive, update, and remove stay visible through the cache", async () => {
    const storage = countingStore()
    const index = createHostedDocumentIndex(storage.store)
    await index.create(entry(1))
    await index.create(entry(2))

    await index.update(scope, "document_1", { display_name: "Renamed" })
    expect((await index.list(scope)).find((value) => value.id === "document_1")?.display_name).toBe("Renamed")

    await index.archive(scope, "document_2")
    expect((await index.list(scope)).map((value) => value.id)).toEqual(["document_1"])
    expect((await index.list(scope, { archived: "archived" })).map((value) => value.id)).toEqual(["document_2"])
    expect(await index.list(scope, { archived: "all" })).toHaveLength(2)

    await index.remove(scope, "document_1")
    expect((await index.list(scope, { archived: "all" })).map((value) => value.id)).toEqual(["document_2"])
  })

  test("findRepository resolves without scanning the project", async () => {
    const storage = countingStore()
    const index = createHostedDocumentIndex(storage.store)
    for (let position = 0; position < 200; position++) await index.create(entry(position))
    await index.create(repositoryEntry(900, "repo:src/plan.md"))

    const before = { ...storage.counts }
    const found = await index.findRepository(scope, "repo:src/plan.md")

    expect(found?.id).toBe("document_900")
    // Pre-fix this listed the whole project with `archived: "all"` and read every document; now it
    // is a fixed pointer lookup (pointer, locator, entry, and `find`'s locator re-read for CAS).
    expect(storage.counts.list - before.list).toBe(0)
    expect(storage.counts.get - before.get).toBeLessThanOrEqual(4)
    await expect(index.findRepository(scope, "repo:absent.md")).resolves.toBeUndefined()
  })

  test("findRepository still finds a document whose pointer is missing, then stops scanning", async () => {
    const storage = countingStore()
    const index = createHostedDocumentIndex(storage.store)
    await index.create(repositoryEntry(1, "repo:legacy.md"))
    // Simulate a document indexed before per-repository pointers existed.
    for (const key of [...storage.objects.keys()].filter((key) => key.startsWith("document-index-repositories/"))) {
      storage.objects.delete(key)
    }

    expect((await index.findRepository(scope, "repo:legacy.md"))?.id).toBe("document_1")
    const before = { ...storage.counts }
    expect((await index.findRepository(scope, "repo:legacy.md"))?.id).toBe("document_1")
    expect(storage.counts.list - before.list).toBe(0)
  })

  test("a stale repository pointer does not resolve to the wrong document", async () => {
    const storage = countingStore()
    const index = createHostedDocumentIndex(storage.store)
    await index.create(repositoryEntry(1, "repo:moved.md"))
    await index.relocate(scope, "document_1", {
      repository_id: "repo:destination.md",
      repository_relative_path: "docs/destination.md",
      last_known_file_version: "v2",
    })

    await expect(index.findRepository(scope, "repo:moved.md")).resolves.toBeUndefined()
    expect((await index.findRepository(scope, "repo:destination.md"))?.id).toBe("document_1")
  })

  test("an interrupted create leaves no orphan, and pre-existing orphans are swept on read", async () => {
    const storage = countingStore()
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

    await expect(index.create(entry(1))).rejects.toThrow("create interrupted")
    await index.create(entry(1))

    const entryObjects = () =>
      [...storage.objects.keys()].filter((key) => key.startsWith("document-index/org_1/project_1/document_1/"))
    // The retry reused the surviving locator instead of minting a second UUID key.
    expect(entryObjects()).toHaveLength(1)

    // A genuine orphan from an older code path is collected by the next read.
    const live = entryObjects()[0]!
    const orphan = `document-index/org_1/project_1/document_1/${crypto.randomUUID()}.json`
    await storage.store.put(orphan, storage.objects.get(live)!.body, { absent: true })
    storage.objects.delete(projectIndexKey(scope))

    expect(await index.list(scope)).toHaveLength(1)
    expect(storage.objects.has(orphan)).toBe(false)
    expect(storage.objects.has(live)).toBe(true)
  })

  test("removing a document sweeps the objects under its prefix", async () => {
    const storage = countingStore()
    const index = createHostedDocumentIndex(storage.store)
    await index.create(entry(1))
    await index.remove(scope, "document_1")

    expect(
      [...storage.objects.keys()].filter((key) => key.startsWith("document-index/org_1/project_1/document_1/")),
    ).toEqual([])
  })
})

describe("hosted managed write cost", () => {
  const managed = {
    origin: "managed",
    placement: "hosted",
    orgId: "org_1",
    projectId: "project_1",
    documentId: "document_1",
    relativePath: hostedManagedRelativePath({ documentId: "document_1", slug: "Plan" }),
  } as const satisfies DocumentEntry
  const actor = { type: "user", id: "user_1" } as const

  test("a write does not re-list history once per phase, and history reads stay bounded", async () => {
    const storage = countingStore()
    const workspace = createHostedManagedDocumentWorkspace({ store: storage.store, maxSnapshots: 50 })
    const handle = await workspace.resolve(managed)
    let version = (await workspace.create(managed, { markdown: "v0", actor })).version

    // Fill history to the snapshot cap, where the pre-fix write paid ~3 LISTs and a serial
    // GET-per-object reduce over every snapshot.
    for (let revision = 1; revision <= 50; revision++) {
      version = (await workspace.write(handle, { markdown: `v${revision}`, expectedVersion: version, actor })).version
    }

    const before = { ...storage.counts }
    version = (await workspace.write(handle, { markdown: "measured", expectedVersion: version, actor })).version
    const spent = { list: storage.counts.list - before.list, get: storage.counts.get - before.get }

    // History is read once for the whole write rather than per phase.
    expect(spent.list).toBeLessThanOrEqual(1)
    // And the reads that remain are the bounded history walk, not the ~150 the pre-fix path made.
    expect(spent.get).toBeLessThan(120)
    expect((await workspace.read(handle)).markdown).toBe("measured")
  })

  test("snapshot timestamps stay strictly increasing, and rebuild from history when the head is lost", async () => {
    const storage = countingStore()
    // A frozen clock forces the monotonicity accelerator to do the work.
    const workspace = createHostedManagedDocumentWorkspace({ store: storage.store, now: () => 1_000 })
    const handle = await workspace.resolve(managed)
    let version = (await workspace.create(managed, { markdown: "v0", actor })).version
    for (let revision = 1; revision <= 4; revision++) {
      version = (await workspace.write(handle, { markdown: `v${revision}`, expectedVersion: version, actor })).version
    }

    const stamps = (await workspace.listSnapshots(handle)).map((snapshot) => snapshot.createdAt)
    expect(stamps).toEqual([...stamps].sort((left, right) => right - left))
    expect(new Set(stamps).size).toBe(stamps.length)

    // Drop the head object; history is authoritative, so the next write must still advance.
    for (const key of [...storage.objects.keys()].filter((key) => key.startsWith("document-history-head/"))) {
      storage.objects.delete(key)
    }
    const highest = Math.max(...stamps)
    await workspace.write(handle, { markdown: "after head loss", expectedVersion: version, actor })
    expect(Math.max(...(await workspace.listSnapshots(handle)).map((snapshot) => snapshot.createdAt))).toBeGreaterThan(
      highest,
    )
  })
})

describe("Listing bound", () => {
  function bucket(keys: readonly string[], pageSize = 1_000): R2BucketBinding {
    const sorted = [...keys].sort()
    return {
      async get() {
        return null
      },
      async put() {
        return null
      },
      async delete() {},
      async list({ prefix, cursor, startAfter }) {
        const matching = sorted.filter((key) => key.startsWith(prefix) && (!startAfter || key > startAfter))
        const offset = cursor ? Number(cursor) : 0
        const page = matching.slice(offset, offset + pageSize)
        const truncated = offset + page.length < matching.length
        return {
          objects: page.map((key) => ({ key, etag: `etag-${key}`, uploaded: new Date(1) })),
          truncated,
          ...(truncated ? { cursor: String(offset + page.length) } : {}),
        }
      },
    }
  }

  const keys = Array.from({ length: 12_345 }, (_, position) => `documents/org/${String(position).padStart(6, "0")}.md`)

  test("a project past the bound truncates with a warning instead of throwing", async () => {
    const store = createR2ConditionalObjectStore(bucket(keys), { maxListObjects: 10_000 })
    const warnings: string[] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => void warnings.push(args.join(" "))
    try {
      const listing = await store.list("documents/org/")

      expect(listing).toHaveLength(10_000)
      // The result says it is partial. Pre-fix this threw "listing exceeds the configured bound".
      expect(listing.truncated).toBe(true)
      expect(listing.cursor).toBeTruthy()
      expect(warnings.join("\n")).toContain("truncated at 10000 objects")
    } finally {
      console.warn = original
    }
  })

  test("the surfaced cursor pages the remainder exactly once each, in order", async () => {
    const store = createR2ConditionalObjectStore(bucket(keys), { maxListObjects: 5_000 })
    const seen: string[] = []
    let cursor: string | undefined
    let pages = 0
    do {
      const page = await store.list("documents/org/", cursor ? { cursor } : undefined)
      seen.push(...page.map((object) => object.key))
      cursor = page.truncated ? page.cursor : undefined
      pages++
    } while (cursor && pages < 10)

    expect(pages).toBe(3)
    expect(seen).toEqual(keys)
    expect(new Set(seen).size).toBe(keys.length)
  })

  test("a truncated project listing marks the index result truncated rather than lying", async () => {
    const storage = countingStore()
    const index = createHostedDocumentIndex({
      ...storage.store,
      // Stand in for a project whose object count exceeds the adapter's bound.
      list: async (prefix) => {
        const listed = await storage.store.list(prefix)
        return prefix.startsWith("document-index/")
          ? objectListing(listed, { truncated: true, cursor: "after:x" })
          : listed
      },
    })
    await index.create(entry(1))

    expect(await index.listPage(scope)).toMatchObject({ truncated: true })
    expect((await index.listPage(scope)).entries).toHaveLength(1)
  })

  test("a page boundary that lands exactly on the bound still reports truncation", async () => {
    const store = createR2ConditionalObjectStore(bucket(keys, 100), { maxListObjects: 100 })
    const listing = await store.list("documents/org/")

    expect(listing).toHaveLength(100)
    expect(listing.truncated).toBe(true)
    const next = await store.list("documents/org/", { cursor: listing.cursor })
    expect(next[0]?.key).toBe(keys[100])
  })

  test("the service reports truncation, and a backend without listPage reports complete", async () => {
    const storage = countingStore()
    const truncating = createHostedDocumentIndex({
      ...storage.store,
      list: async (prefix) => {
        const listed = await storage.store.list(prefix)
        return prefix.startsWith("document-index/")
          ? objectListing(listed, { truncated: true, cursor: "after:x" })
          : listed
      },
    })
    await truncating.create(entry(1))

    const service = createDocumentsService({
      index: truncating,
      workspace: {} as never,
      managedRelativePath: () => "document_1/doc.md",
      placement: "hosted",
    } as never)
    await expect(service.listPage(scope, "active")).resolves.toMatchObject({ truncated: true })

    // A backend that always enumerates fully has no listPage; the service must not claim truncation.
    const complete = createHostedDocumentIndex(countingStore().store)
    await complete.create(entry(1))
    const { listPage: _listPage, ...withoutListPage } = complete
    const plain = createDocumentsService({
      index: withoutListPage,
      workspace: {} as never,
      managedRelativePath: () => "document_1/doc.md",
      placement: "hosted",
    } as never)
    await expect(plain.listPage(scope, "active")).resolves.toMatchObject({ truncated: false })
  })

  test("a listing that fits the bound is not marked truncated", async () => {
    const store = createR2ConditionalObjectStore(bucket(keys.slice(0, 42)), { maxListObjects: 10_000 })
    const listing = await store.list("documents/org/")

    expect(listing).toHaveLength(42)
    expect(listing.truncated).toBe(false)
    expect(listing.cursor).toBeUndefined()
  })
})
