import { describe, expect, test, vi } from "vitest"
import type { DocumentsBackend } from "./backend"
import { createDocumentsService } from "./service"
import type { DocumentHandle, DocumentVersion, SnapshotID, SnapshotRef } from "./port"
import type { DocumentIndexEntry } from "./index-store"

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
      archive: vi.fn(),
      restore: vi.fn(),
      listStatuses: vi.fn(async () => []),
      transitionStatus: vi.fn(),
      resolveLocalProjectId: vi.fn(async () => "project_1"),
    },
    workspace,
    managedRelativePath: ({ documentId }: { documentId: string }) => `${documentId}/plan.md`,
    placement: "local",
  } satisfies DocumentsBackend<typeof handle>
  return { backend, workspace, remove, update, setEntry: (next?: DocumentIndexEntry) => (entry = next) }
}

const scope = {
  orgId: "org_1",
  projectId: "project_1",
  actor: { type: "user", id: "user_1" },
} as const

describe("Documents service", () => {
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
