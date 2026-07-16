import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { ClaxedoDB } from "../storage/db"
import { createLocalDocumentsBackend } from "./local-backend"

const roots: string[] = []
const execFileAsync = promisify(execFile)
const databaseRoot = path.join(os.tmpdir(), `local-documents-backend-db-${crypto.randomUUID()}`)
const previousDataDir = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = databaseRoot

beforeEach(async () => {
  ClaxedoDB.close()
  await fs.rm(databaseRoot, { recursive: true, force: true })
  await fs.mkdir(databaseRoot, { recursive: true })
})

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

afterAll(async () => {
  ClaxedoDB.close()
  await fs.rm(databaseRoot, { recursive: true, force: true })
  if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
  else process.env.CLAXEDO_DATA_DIR = previousDataDir
})

describe("local documents backend composition", () => {
  test("uses the injected data directory without importing server composition", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-documents-backend-"))
    roots.push(root)
    const dataDir = vi.fn(() => root)
    const backend = createLocalDocumentsBackend({
      dataDir,
      async resolveWorkspace() {
        return undefined
      },
      async sessionMeta() {
        return undefined
      },
      reportError() {},
      async runGit() {
        throw new Error("Git is not required for managed documents")
      },
    })
    const relativePath = backend.managedRelativePath({
      projectId: "project_1",
      documentId: "document_1",
      slug: "Plan",
    })
    const handle = await backend.workspace.resolve({
      origin: "managed",
      placement: "local",
      projectId: "project_1",
      documentId: "document_1",
      relativePath,
    })

    await backend.workspace.create(
      {
        origin: "managed",
        placement: "local",
        projectId: "project_1",
        documentId: "document_1",
        relativePath,
      },
      { markdown: "# Plan\n", actor: { type: "user", id: "user_1" } },
    )

    expect(dataDir).toHaveBeenCalledOnce()
    expect(handle.origin).toBe("managed")
    expect(handle.canonicalPath.startsWith(path.join(await fs.realpath(root), "documents") + path.sep)).toBe(true)
    expect((await backend.workspace.read(handle)).markdown).toBe("# Plan\n")
  })

  test("restores the managed index when a direct writer races the archive claim", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-documents-backend-move-"))
    const repository = await fs.mkdtemp(path.join(os.tmpdir(), "local-documents-backend-repository-"))
    roots.push(root, repository)
    await git(repository, ["init"])
    await git(repository, ["config", "user.email", "documents@example.com"])
    await git(repository, ["config", "user.name", "Documents Test"])
    await fs.writeFile(path.join(repository, "README.md"), "repository\n")
    await git(repository, ["add", "README.md"])
    await git(repository, ["commit", "-m", "initial"])
    let race = false
    const backend = createLocalDocumentsBackend(
      {
        dataDir: () => root,
        async resolveWorkspace(input) {
          if (input.workspaceId !== "workspace_1") return undefined
          return {
            id: "workspace_1",
            project_id: "project_1",
            directory: repository,
            kind: "local",
            created_at: 1,
            updated_at: 1,
          }
        },
        async sessionMeta() {
          return undefined
        },
        reportError() {},
        runGit: (args, directory, options) => git(directory, args, options),
      },
      {
        managed: {
          faults: {
            async afterArchiveClaimed(input) {
              if (race) await fs.writeFile(input.target, "# Agent winner\n")
            },
          },
        },
      },
    )
    const relativePath = backend.managedRelativePath({
      projectId: "project_1",
      documentId: "document_1",
      slug: "Plan",
    })
    const entry = {
      origin: "managed",
      placement: "local",
      projectId: "project_1",
      documentId: "document_1",
      relativePath,
    } as const
    const created = await backend.workspace.create(entry, {
      markdown: "# Plan\n",
      actor: { type: "user", id: "user_1" },
    })
    const timestamp = new Date().toISOString()
    const indexed = backend.index.create({
      id: "document_1",
      org_id: "org_1",
      project_id: "project_1",
      display_name: "Plan",
      origin_kind: "managed",
      placement_kind: "local",
      placement_id: "local",
      managed_relative_path: relativePath,
      repository_id: null,
      workspace_id: null,
      repository_relative_path: null,
      branch: null,
      status: "draft",
      session_id: null,
      archived_at: null,
      created_at: timestamp,
      updated_at: timestamp,
      last_opened_at: null,
      last_known_file_version: created.version,
    })
    race = true

    await expect(
      backend.moveToRepository(indexed, { workspaceId: "workspace_1", relativePath: "docs/plan.md" }),
    ).rejects.toMatchObject({ code: "document_version_conflict" })
    expect(backend.index.find("org_1", "document_1")).toMatchObject({
      origin_kind: "managed",
      managed_relative_path: relativePath,
    })
    expect(await fs.readFile(path.join(root, "documents", relativePath), "utf8")).toBe("# Agent winner\n")
    expect(await fs.readFile(path.join(repository, "docs", "plan.md"), "utf8")).toBe("# Plan\n")
  })
})

async function git(
  directory: string,
  args: readonly string[],
  options?: Readonly<{ env?: Readonly<Record<string, string>> }>,
) {
  return (
    await execFileAsync("git", [...args], {
      cwd: directory,
      ...(options?.env ? { env: { ...process.env, ...options.env } } : {}),
    })
  ).stdout.trim()
}
