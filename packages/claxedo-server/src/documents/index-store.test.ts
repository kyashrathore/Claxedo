import { randomUUID } from "node:crypto"
import { mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs"
import os from "node:os"
import path from "node:path"
import { afterAll, beforeEach, describe, expect, test } from "vitest"
import { ClaxedoDB } from "../storage/db"
import { createHostedDocumentIndex } from "./hosted-index"
import {
  archiveDocumentIndexEntry,
  createDocumentIndexEntry,
  DocumentIndexEntrySchema,
  findDocumentIndexEntry,
  findRepositoryDocumentIndexEntry,
  listDocumentIndex,
  listDocumentStatuses,
  lookupDocumentIndexEntry,
  moveManagedDocumentIndexToRepository,
  resolveLocalProjectId,
  restoreDocumentIndexEntry,
  relocateRepositoryDocumentIndexEntry,
  transitionDocumentStatus,
  updateDocumentIndexMetadata,
} from "./index-store"

const root = path.join(realpathSync(os.tmpdir()), `document-index-${randomUUID()}`)
const previousDataDir = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const common = {
  id: "document_1",
  org_id: "__local__",
  project_id: "project_1",
  display_name: "Release notes",
  placement_kind: "local" as const,
  placement_id: "device_1",
  status: "draft",
  session_id: null,
  archived_at: null,
  created_at: "2026-07-16T00:00:00.000Z",
  updated_at: "2026-07-16T00:00:00.000Z",
  last_opened_at: null,
  last_known_file_version: null,
}

describe("document index store", () => {
  beforeEach(() => {
    ClaxedoDB.close()
    rmSync(root, { recursive: true, force: true })
    mkdirSync(root, { recursive: true })
  })

  afterAll(() => {
    ClaxedoDB.close()
    rmSync(root, { recursive: true, force: true })
    if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
    else process.env.CLAXEDO_DATA_DIR = previousDataDir
  })

  test("origin validation rejects records that mix managed and repository locators", () => {
    const result = DocumentIndexEntrySchema.safeParse({
      ...common,
      origin_kind: "managed",
      managed_relative_path: "document_1/release-notes.md",
      repository_id: "repository_1",
      workspace_id: "workspace_1",
      repository_relative_path: "docs/release-notes.md",
      branch: "main",
    })

    expect(result.success).toBe(false)
  })

  test("duplicate display names remain distinct and lists return metadata only", () => {
    createDocumentIndexEntry({
      ...common,
      id: "document_1",
      origin_kind: "managed",
      managed_relative_path: "document_1/release-notes.md",
      repository_id: null,
      workspace_id: null,
      repository_relative_path: null,
      branch: null,
    })
    createDocumentIndexEntry({
      ...common,
      id: "document_2",
      origin_kind: "managed",
      managed_relative_path: "document_2/release-notes.md",
      repository_id: null,
      workspace_id: null,
      repository_relative_path: null,
      branch: null,
    })

    const entries = listDocumentIndex({ orgId: "__local__", projectId: "project_1" })

    expect(entries.map((entry) => entry.id).sort()).toEqual(["document_1", "document_2"])
    expect(entries.every((entry) => entry.display_name === "Release notes")).toBe(true)
    expect(entries.every((entry) => !("content" in entry) && !("markdown" in entry))).toBe(true)
  })

  test("invalid SQL rows are rejected before metadata lists can observe them", () => {
    expect(() => ClaxedoDB.raw().prepare(`
      INSERT INTO claxedo_document_index (
        id, org_id, project_id, display_name, origin_kind, placement_kind, placement_id,
        managed_relative_path, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "document_invalid",
      "__local__",
      "project_1",
      "",
      "managed",
      "local",
      "device_1",
      "document_invalid/document.md",
      "draft",
      "2026-07-16T00:00:00.000Z",
      "2026-07-16T00:00:00.000Z",
    )).toThrow()
    expect(listDocumentIndex({ orgId: "__local__", projectId: "project_1" })).toEqual([])
  })

  test("unsigned-local directories keep distinct stable project identities across restarts", () => {
    const first = resolveLocalProjectId("/work/alpha/../alpha")
    const other = resolveLocalProjectId("/work/beta")

    ClaxedoDB.close()

    expect(resolveLocalProjectId("/work/alpha")).toBe(first)
    expect(other).not.toBe(first)
    expect(first).toMatch(/^project_/)
  })

  test("unsigned-local project identity canonicalizes real-directory and symlink aliases", () => {
    const directory = path.join(root, "project-real")
    const alias = path.join(root, "project-alias")
    mkdirSync(directory)
    symlinkSync(directory, alias, "dir")

    expect(resolveLocalProjectId(alias)).toBe(resolveLocalProjectId(directory))
  })

  test("archive and restore preserve the document locator and expose honest lookup states", () => {
    createDocumentIndexEntry({
      ...common,
      origin_kind: "managed",
      managed_relative_path: "document_1/release-notes.md",
      repository_id: null,
      workspace_id: null,
      repository_relative_path: null,
      branch: null,
    })

    const archived = archiveDocumentIndexEntry(
      { orgId: "__local__", projectId: "project_1" },
      "document_1",
      "2026-07-16T01:00:00.000Z",
    )

    expect(archived.archived_at).toBe("2026-07-16T01:00:00.000Z")
    expect(archived.managed_relative_path).toBe("document_1/release-notes.md")
    expect(listDocumentIndex({ orgId: "__local__", projectId: "project_1" })).toEqual([])
    expect(lookupDocumentIndexEntry({ orgId: "__local__", projectId: "project_1" }, "document_1").state)
      .toBe("archived")
    expect(lookupDocumentIndexEntry({ orgId: "__local__", projectId: "project_1" }, "missing")).toEqual({
      state: "missing",
    })

    const restored = restoreDocumentIndexEntry(
      { orgId: "__local__", projectId: "project_1" },
      "document_1",
      "2026-07-16T02:00:00.000Z",
    )

    expect(restored.archived_at).toBeNull()
    expect(restored.managed_relative_path).toBe("document_1/release-notes.md")
    expect(lookupDocumentIndexEntry({ orgId: "__local__", projectId: "project_1" }, "document_1").state)
      .toBe("available")
  })

  test("finds direct ids within an organization and updates content-free metadata", () => {
    createDocumentIndexEntry({
      ...common,
      origin_kind: "managed",
      managed_relative_path: "document_1/release-notes.md",
      repository_id: null,
      workspace_id: null,
      repository_relative_path: null,
      branch: null,
    })

    expect(findDocumentIndexEntry("org_other", "document_1")).toBeUndefined()
    expect(updateDocumentIndexMetadata(
      { orgId: "__local__", projectId: "project_1" },
      "document_1",
      {
        display_name: "Renamed",
        session_id: "session_1",
        last_known_file_version: "opaque-version",
        updated_at: "2026-07-16T03:00:00.000Z",
      },
    )).toMatchObject({
      display_name: "Renamed",
      session_id: "session_1",
      last_known_file_version: "opaque-version",
      updated_at: "2026-07-16T03:00:00.000Z",
    })
    expect(findDocumentIndexEntry("__local__", "document_1")).not.toHaveProperty("markdown")
  })

  test("archive and restore reject missing document identities explicitly", () => {
    const scope = { orgId: "__local__", projectId: "project_1" }

    expect(() => archiveDocumentIndexEntry(scope, "missing")).toThrowError(expect.objectContaining({
      code: "document_index_not_found",
    }))
    expect(() => restoreDocumentIndexEntry(scope, "missing")).toThrowError(expect.objectContaining({
      code: "document_index_not_found",
    }))
  })

  test("flips a managed identity to its repository locator atomically and idempotently", () => {
    const scope = { orgId: "__local__", projectId: "project_1" }
    createDocumentIndexEntry({
      ...common,
      origin_kind: "managed",
      managed_relative_path: "document_1/release-notes.md",
      repository_id: null,
      workspace_id: null,
      repository_relative_path: null,
      branch: null,
    })
    const input = {
      repository_id: "repository_1",
      workspace_id: "workspace_1",
      repository_relative_path: "docs/release-notes.md",
      last_known_file_version: "version_1",
    }

    expect(moveManagedDocumentIndexToRepository(scope, "document_1", input)).toMatchObject({
      id: "document_1",
      origin_kind: "repository",
      managed_relative_path: null,
      ...input,
    })
    expect(moveManagedDocumentIndexToRepository(scope, "document_1", input)).toMatchObject(input)
    expect(() => moveManagedDocumentIndexToRepository(scope, "document_1", {
      ...input,
      repository_relative_path: "docs/other.md",
    })).toThrowError(expect.objectContaining({ code: "document_index_not_found" }))
  })

  test("status transitions retain the validated project workflow", () => {
    createDocumentIndexEntry({
      ...common,
      origin_kind: "managed",
      managed_relative_path: "document_1/release-notes.md",
      repository_id: null,
      workspace_id: null,
      repository_relative_path: null,
      branch: null,
    })

    expect(() => transitionDocumentStatus(
      { orgId: "__local__", projectId: "project_1" },
      "document_1",
      "done",
      "2026-07-16T01:00:00.000Z",
    )).toThrowError(expect.objectContaining({ code: "document_status_transition_not_allowed" }))

    const transitioned = transitionDocumentStatus(
      { orgId: "__local__", projectId: "project_1" },
      "document_1",
      "in_review",
      "2026-07-16T01:00:00.000Z",
    )

    expect(transitioned.status).toBe("in_review")
    expect(transitioned.updated_at).toBe("2026-07-16T01:00:00.000Z")
  })

  test("custom-only status workflows are retained without injecting defaults", () => {
    ClaxedoDB.raw().prepare(`
      INSERT INTO claxedo_page_status (id, project_id, name, color, position, transitions)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run("custom", "project_1", "Custom", "#000000", 0, "[]")

    expect(listDocumentStatuses("project_1")).toEqual([{
      id: "custom",
      name: "Custom",
      color: "#000000",
      position: 0,
      transitions: "[]",
    }])
  })

  test("local and hosted indexes expose the same default status workflow", async () => {
    const hosted = createHostedDocumentIndex({
      async get() { return undefined },
      async put() { return undefined },
      async delete() {},
      async list() { return [] },
    })

    expect(listDocumentStatuses("project_1").map((status) => ({
      ...status,
      transitions: JSON.parse(status.transitions),
    }))).toEqual(await hosted.listStatuses())
  })

  test("repository locators are scoped by organization and project", () => {
    const repository = {
      ...common,
      origin_kind: "repository" as const,
      managed_relative_path: null,
      repository_id: "repository_1",
      workspace_id: "workspace_1",
      repository_relative_path: "docs/release-notes.md",
      branch: "main",
    }
    createDocumentIndexEntry({ ...repository, id: "document_1" })
    createDocumentIndexEntry({ ...repository, id: "document_2", project_id: "project_2" })
    createDocumentIndexEntry({ ...repository, id: "document_3", org_id: "org_2" })

    expect(listDocumentIndex({ orgId: "__local__", projectId: "project_1" }).map((entry) => entry.id))
      .toEqual(["document_1"])
    expect(listDocumentIndex({ orgId: "__local__", projectId: "project_2" }).map((entry) => entry.id))
      .toEqual(["document_2"])
    expect(listDocumentIndex({ orgId: "org_2", projectId: "project_1" }).map((entry) => entry.id))
      .toEqual(["document_3"])

    const scope = { orgId: "__local__", projectId: "project_1" }
    expect(findRepositoryDocumentIndexEntry(scope, "repository_1")?.id).toBe("document_1")
    expect(findRepositoryDocumentIndexEntry({ ...scope, projectId: "missing" }, "repository_1")).toBeUndefined()

    const relocated = relocateRepositoryDocumentIndexEntry(scope, "document_1", {
      repository_id: "repository_2",
      repository_relative_path: "docs/renamed.md",
      last_known_file_version: "sha256:renamed",
      branch: "release",
    })
    expect(relocated).toMatchObject({
      id: "document_1",
      repository_id: "repository_2",
      repository_relative_path: "docs/renamed.md",
      last_known_file_version: "sha256:renamed",
      branch: "release",
    })
    expect(findRepositoryDocumentIndexEntry(scope, "repository_1")).toBeUndefined()
    expect(findRepositoryDocumentIndexEntry(scope, "repository_2")?.id).toBe("document_1")
  })
})
