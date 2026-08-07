import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { afterAll, describe, expect, test } from "vitest"
import type { DocumentIndexEntry } from "../../documents/index-store"

const exec = promisify(execFile)
const root = await fs.mkdtemp(path.join(os.tmpdir(), "server-documents-"))
const previousDataDir = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root

const { localDocumentsBackend } = await import("../../deployments/local/documents-composition")
const { managedDocumentRelativePath } = await import("../../documents/backends/local/managed")
const { ensureWorkspace } = await import("../../workspace/store")
const { ClaxedoDB } = await import("../../platform/db/db")

afterAll(async () => {
  ClaxedoDB.close()
  if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previousDataDir
  await fs.rm(root, { recursive: true, force: true })
})

describe("local documents server composition", () => {
  test("denies a cross-project repository move before mutating the destination filesystem", async () => {
    const destination = path.join(root, "other-project")
    await fs.mkdir(destination)
    await exec("git", ["init", destination])
    await ensureWorkspace({
      workspaceId: "workspace_other",
      project_id: "project_other",
      directory: destination,
    })

    const backend = localDocumentsBackend()
    const managedRelativePath = managedDocumentRelativePath({
      projectId: "project_source",
      documentId: "document_cross_project",
      slug: "Cross project",
    })
    const now = new Date().toISOString()
    const entry = {
      id: "document_cross_project",
      org_id: "__local__",
      project_id: "project_source",
      display_name: "Cross project",
      origin_kind: "managed",
      placement_kind: "local",
      placement_id: "local",
      managed_relative_path: managedRelativePath,
      repository_id: null,
      workspace_id: null,
      repository_relative_path: null,
      branch: null,
      status: "draft",
      session_id: null,
      archived_at: null,
      created_at: now,
      updated_at: now,
      last_opened_at: null,
      last_known_file_version: null,
    } satisfies DocumentIndexEntry
    await backend.workspace.create({
      origin: "managed",
      placement: "local",
      projectId: entry.project_id,
      documentId: entry.id,
      relativePath: managedRelativePath,
    }, { markdown: "source", actor: { type: "user", id: "user_1" } })

    await expect(backend.moveToRepository(entry, {
      workspaceId: "workspace_other",
      relativePath: "nested/document.md",
    })).rejects.toMatchObject({ code: "document_not_found" })
    await expect(fs.stat(path.join(destination, "nested"))).rejects.toMatchObject({ code: "ENOENT" })
  })
})
