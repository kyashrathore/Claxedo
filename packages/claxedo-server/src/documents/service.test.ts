import { describe, expect, test, vi } from "vitest"
import type { DocumentsBackend } from "./backend"
import { createDocumentsService } from "./service"
import type { DocumentHandle, DocumentVersion, SnapshotID, SnapshotRef } from "./port"
import type { DocumentIndexEntry, DocumentIndexScope } from "./index-store"

const handle = {
  origin: "managed",
  placement: "local",
  projectId: "project_1",
  documentId: "document_1",
} as const satisfies DocumentHandle

const snapshot = (pins: readonly string[]): SnapshotRef => ({
  id: "snapshot_1" as SnapshotID,
  sha256: "sha256",
  size: 1,
  reason: "test",
  actor: { type: "user", id: "user_1" },
  createdAt: 1,
  pins,
})

function fixture() {
  let entry: DocumentIndexEntry | undefined = {
    id: "document_1",
    org_id: "org_1",
    project_id: "project_1",
    display_name: "Plan",
    origin_kind: "managed",
    placement_kind: "local",
    placement_id: "local",
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
    last_known_file_version: "v1",
  }
  const remove = vi.fn(async () => {
    entry = undefined
  })
  const update = vi.fn(async (_scope, _documentId, input: Record<string, unknown>) => {
    entry = { ...entry!, ...input } as DocumentIndexEntry
    return entry
  })
  const workspace = {
    resolve: vi.fn(async () => handle),
    create: vi.fn(async () => ({
      markdown: "",
      version: "v1" as DocumentVersion,
      modifiedAt: 1,
      snapshot: snapshot([]),
    })),
    read: vi.fn(async () => ({ markdown: "body", version: "v2" as DocumentVersion, modifiedAt: 2 })),
    write: vi.fn(),
    listSnapshots: vi.fn(async () => [snapshot([])]),
    snapshot: vi.fn(async () => snapshot([])),
    readSnapshot: vi.fn(async () => ({ markdown: "body", version: "v2" as DocumentVersion, modifiedAt: 2 })),
    restore: vi.fn(),
    pinSnapshot: vi.fn(async (_handle: typeof handle, _snapshotId: SnapshotID, _pin: string) => snapshot([])),
    unpinSnapshot: vi.fn(async (_handle: typeof handle, _snapshotId: SnapshotID, _pin: string) => snapshot([])),
    collectSnapshots: vi.fn(async () => undefined),
  }
  const runtimeWriteback = vi.fn(async () => ({
    markdown: "runtime",
    version: "v2" as DocumentVersion,
    modifiedAt: 2,
    snapshot: snapshot([]),
  }))
  const runtimeRenew = vi.fn(async () => ({ token: "rotated", expiresAt: Date.now() + 300_000 }))
  const runtimeResolve = vi.fn(async () => ({ path: "/workspace/plan.md", version: "v2" }))
  const backend = {
    index: {
      list: vi.fn(async () => (entry ? [entry] : [])),
      find: vi.fn(async () => entry),
      findRepository: vi.fn(async () => undefined),
      create: vi.fn(async (next: DocumentIndexEntry) => {
        entry = next
        return next
      }),
      remove,
      update,
      relocate: vi.fn(),
      archive: vi.fn(async (_scope: DocumentIndexScope, _documentId: string) => {
        entry = { ...entry!, archived_at: new Date().toISOString() }
        return entry
      }),
      restore: vi.fn(async (_scope: DocumentIndexScope, _documentId: string) => {
        entry = { ...entry!, archived_at: null }
        return entry
      }),
      listStatuses: vi.fn(async () => []),
      resolveLocalProjectId: vi.fn(async () => "project_1"),
    },
    workspace,
    managedRelativePath: ({ documentId }: { documentId: string }) => `${documentId}/plan.md`,
    placement: "local",
    runtimeWriteback,
    runtimeRenew,
    runtimeResolve,
  } satisfies DocumentsBackend<typeof handle>
  return {
    backend,
    workspace,
    remove,
    update,
    runtimeWriteback,
    runtimeRenew,
    runtimeResolve,
    getEntry: () => entry,
    setEntry: (next?: DocumentIndexEntry) => (entry = next),
  }
}

const scope = {
  orgId: "org_1",
  projectId: "project_1",
  actor: { type: "user", id: "user_1" },
} as const

describe("Documents service", () => {
  test("rings the injected document sink after an agent runtime writeback", async () => {
    const value = fixture()
    const documentChangedSink = vi.fn(async () => {})

    await createDocumentsService(value.backend, { documentChangedSink }).runtimeWriteback("document_1", {
      token: "session-token",
      orgId: "org_1",
      projectId: "project_1",
      workspaceId: "workspace_1",
      sessionId: "session_1",
      markdown: "updated by agent",
      expectedVersion: "v1" as DocumentVersion,
    })

    expect(documentChangedSink).toHaveBeenCalledWith({
      type: "document.changed",
      documentId: "document_1",
      orgId: "org_1",
      projectId: "project_1",
      version: "v2",
      ts: expect.any(Number),
    })
  })

  test.each(["writeback", "renew", "resolve"] as const)(
    "fences runtime %s behind archive and rechecks live archival state",
    async (operation) => {
      const value = fixture()
      const service = createDocumentsService(value.backend)
      const archiveEntered = Promise.withResolvers<void>()
      const releaseArchive = Promise.withResolvers<void>()
      value.backend.index.archive.mockImplementationOnce(async (archiveScope, documentId) => {
        expect(archiveScope).toMatchObject({ orgId: "org_1", projectId: "project_1" })
        expect(documentId).toBe("document_1")
        const current = value.getEntry()
        archiveEntered.resolve()
        await releaseArchive.promise
        const archived = { ...current!, archived_at: new Date().toISOString() }
        value.setEntry(archived)
        return archived
      })
      const archiving = service.archive(scope, "document_1")
      await archiveEntered.promise
      const input = {
        token: "session-token",
        orgId: "org_1",
        projectId: "project_1",
        workspaceId: "workspace_1",
        sessionId: "session_1",
      }
      const runtimeOperation =
        operation === "writeback"
          ? value.runtimeWriteback
          : operation === "renew"
            ? value.runtimeRenew
            : value.runtimeResolve
      const runtime =
        operation === "writeback"
          ? service.runtimeWriteback("document_1", { ...input, markdown: "late", expectedVersion: "v1" })
          : operation === "renew"
            ? service.runtimeRenew("document_1", input)
            : service.runtimeResolve(
                value.getEntry()!,
                { auth: { user: { subject: "user_1" } } as never, sessionId: "session_1", choice: "draft" },
              )
      const runtimeRejected = expect(runtime).rejects.toThrow()

      await Promise.resolve()
      expect(runtimeOperation).not.toHaveBeenCalled()
      releaseArchive.resolve()
      await expect(archiving).resolves.toMatchObject({ archived_at: expect.any(String) })
      await runtimeRejected
      expect(runtimeOperation).not.toHaveBeenCalled()
    },
  )

  test("rolls back the index when managed content creation fails", async () => {
    const value = fixture()
    value.workspace.create.mockRejectedValueOnce(new Error("storage unavailable"))

    await expect(
      createDocumentsService(value.backend).create(scope, {
        displayName: "New",
        markdown: "body",
        status: "draft",
        sessionId: null,
      }),
    ).rejects.toThrow("storage unavailable")

    expect(value.remove).toHaveBeenCalledTimes(1)
  })

  test("reconciles the index version after reading authoritative content", async () => {
    const value = fixture()

    await expect(createDocumentsService(value.backend).readContent(scope, "document_1")).resolves.toMatchObject({
      markdown: "body",
      version: "v2",
    })

    expect(value.update).toHaveBeenCalledWith(scope, "document_1", { last_known_file_version: "v2" })
  })

  test("rolls back a canonical write before reporting index reconciliation failure", async () => {
    const value = fixture()
    value.workspace.write
      .mockResolvedValueOnce({
        markdown: "committed",
        version: "v3" as DocumentVersion,
        modifiedAt: 3,
        snapshot: snapshot([]),
      })
      .mockResolvedValueOnce({
        markdown: "body",
        version: "v4" as DocumentVersion,
        modifiedAt: 4,
        snapshot: snapshot([]),
      })
    value.update.mockRejectedValueOnce(new Error("index unavailable"))

    await expect(
      createDocumentsService(value.backend).writeContent(scope, "document_1", {
        markdown: "committed",
        expectedVersion: "v1" as DocumentVersion,
      }),
    ).rejects.toThrow("index unavailable")
    expect(value.workspace.write).toHaveBeenLastCalledWith(
      handle,
      expect.objectContaining({ markdown: "body", expectedVersion: "v3" }),
    )
  })

  test("returns the committed write when index reconciliation and safe rollback both fail", async () => {
    const value = fixture()
    value.workspace.read
      .mockResolvedValueOnce({ markdown: "body", version: "v2" as DocumentVersion, modifiedAt: 2 })
      .mockResolvedValueOnce({ markdown: "committed", version: "v3" as DocumentVersion, modifiedAt: 3 })
    value.workspace.write
      .mockResolvedValueOnce({
        markdown: "committed",
        version: "v3" as DocumentVersion,
        modifiedAt: 3,
        snapshot: snapshot([]),
      })
      .mockRejectedValueOnce(new Error("rollback unavailable"))
    value.update.mockRejectedValueOnce(new Error("index unavailable"))
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined)

    await expect(
      createDocumentsService(value.backend).writeContent(scope, "document_1", {
        markdown: "committed",
        expectedVersion: "v1" as DocumentVersion,
      }),
    ).resolves.toMatchObject({ markdown: "committed", version: "v3" })
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining("index reconciliation and rollback failed"),
      expect.any(Error),
    )
    error.mockRestore()
  })

  test("pins a WorkGraph revision once before removing leases sequentially", async () => {
    const value = fixture()
    const order: string[] = []
    value.workspace.pinSnapshot.mockImplementationOnce(async () => {
      order.push("pin")
      return snapshot(["lease:10:first", "lease:20:second", "workgraph:source_1:revision_1"])
    })
    value.workspace.unpinSnapshot.mockImplementation(async (_handle, _snapshotId, pin) => {
      order.push(`unpin:${pin}`)
      return snapshot(
        pin.includes("first")
          ? ["lease:20:second", "workgraph:source_1:revision_1"]
          : ["workgraph:source_1:revision_1"],
      )
    })

    await expect(
      createDocumentsService(value.backend).pinWorkSource(scope, "document_1", "snapshot_1" as SnapshotID, {
        workSourceId: "source_1",
        revisionId: "revision_1",
      }),
    ).resolves.toMatchObject({ pins: ["workgraph:source_1:revision_1"] })

    expect(value.workspace.pinSnapshot).toHaveBeenCalledTimes(1)
    expect(order).toEqual(["pin", "unpin:lease:10:first", "unpin:lease:20:second"])
  })
})
