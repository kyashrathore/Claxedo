import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { afterAll, afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { Hono } from "hono"
import { DocumentsRoutes } from "@claxedo/server-core/documents/routes/index"
import { ClaxedoDB } from "../../../platform/db"
import { createSqliteWorkspaceAuthority } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority"
import { openAuthorityDb } from "@claxedo/server-core/authority/adapters/sqlite/workspace-authority-store"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { disposeHydratedSessionDocuments, hydratedSessionDocumentPaths, syncHydratedSessionDocuments } from "@claxedo/server-core/documents/session-hydration"
import { createLocalDocumentsBackend, type LocalDocumentsBackendDependencies } from "@claxedo/server-core/documents/backends/local/backend"

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
  test("private-session authority gates hydration and revocation stops writeback", async () => {
    const file = path.join(databaseRoot, "private-session-authority.db")
    const authority = createSqliteWorkspaceAuthority({ path: file })
    const database = openAuthorityDb({ path: file })
    const auth = (subject: string): SignedControlPlaneAuth => ({ mode: "signed", token: subject,
      user: { subject, tokenIdentifier: `https://idp.example|${subject}`, issuer: "https://idp.example" } })
    const alice = auth("alice"), bob = auth("bob")
    await authority.createCloudWorkspace(alice, { workspaceId: "workspace_1", displayName: "Shared project" })
    await authority.usersMe(bob)
    const opened = await authority.openWorkspace(alice, { workspaceId: "workspace_1" })
    const projectId = opened.workspace!.project_id!
    const orgId = opened.workspace!.org_id!
    bob.user.orgId = orgId
    database().prepare("INSERT INTO org_memberships (org_id, token_identifier, role, created_at, updated_at) VALUES (?, ?, 'member', ?, ?)")
      .run(opened.workspace!.org_id, bob.user.tokenIdentifier, Date.now(), Date.now())
    database().prepare("INSERT INTO project_memberships (project_id, token_identifier, role, created_at, updated_at) VALUES (?, ?, 'editor', ?, ?)")
      .run(opened.workspace!.project_id, bob.user.tokenIdentifier, Date.now(), Date.now())
    for (const [sessionId, caller] of [["ses_alice", alice], ["ses_bob", bob]] as const) {
      await authority.reserveSession(caller, { operationId: `op_${sessionId}`, sessionId, workspaceId: "workspace_1", kind: "create" })
      await authority.registerRuntimeSession({ principalKind: "user", actorKind: "human", actorId: caller.user.tokenIdentifier,
        operationId: `op_${sessionId}`, sessionId, workspaceId: "workspace_1" })
    }
    const fixture = await moveFixture(undefined, {
      sessionAuthority: authority,
      sessionMeta: async (sessionID) => ({ sessionID, workspaceID: "workspace_1", projectID: projectId, host: "workspace",
        createdAt: 1, updatedAt: 1, tags: [], attachments: [] }),
    }, projectId, orgId)
    const app = new Hono().route("/documents", DocumentsRoutes({
      backend: fixture.backend, authority,
      authConfig: { enabled: true, issuer: "https://idp.example", jwksUrl: "https://idp.example/jwks" },
      verifier: async () => bob,
    }))
    const request = (sessionId: string) => app.request(`https://signed.example/documents/${fixture.indexed.id}/agent-open`, {
      method: "POST", headers: { authorization: "Bearer bob", "content-type": "application/json" },
      body: JSON.stringify({ session_id: sessionId }),
    })
    const context = { auth: bob, origin: "https://local.example" }
    const target = { sessionId: "ses_alice", workspaceId: "workspace_1", participantActorId: bob.user.tokenIdentifier }
    try {
      await expect(fixture.backend.agentOpen(fixture.indexed, "ses_alice", context)).rejects.toMatchObject({ status: 403 })
      expect((await request("ses_alice")).status).toBe(403)
      expect(hydratedSessionDocumentPaths("ses_alice")).toEqual([])
      await expect(fs.stat(path.join(fixture.repository, ".claxedo", "sessions", "ses_alice"))).rejects.toMatchObject({ code: "ENOENT" })
      const ownSession = await request("ses_bob")
      expect(ownSession.status).toBe(200)
      expect(await ownSession.json()).toMatchObject({ path: expect.stringContaining("ses_bob") })
      await authority.grantSessionParticipant(alice, target)
      const hydrated = await fixture.backend.agentOpen(fixture.indexed, "ses_alice", context)
      await fs.writeFile(hydrated.path, "authorized writeback")
      await syncHydratedSessionDocuments("ses_alice")
      const handle = await fixture.backend.workspace.resolve({ origin: "managed", placement: "local", projectId,
        documentId: fixture.indexed.id, relativePath: fixture.indexed.managed_relative_path! })
      expect((await fixture.backend.workspace.read(handle)).markdown).toBe("authorized writeback")
      await authority.revokeSessionParticipant(alice, target)
      await fs.writeFile(hydrated.path, "revoked writeback")
      await expect(syncHydratedSessionDocuments("ses_alice")).rejects.toThrow()
      expect((await fixture.backend.workspace.read(handle)).markdown).toBe("authorized writeback")
    } finally {
      await disposeHydratedSessionDocuments("ses_alice")
      await disposeHydratedSessionDocuments("ses_bob")
      authority.close(); database.close()
    }
  })

  test("signed hydration fails closed without a private-session authority", async () => {
    const fixture = await moveFixture(undefined, {
      sessionMeta: async (sessionID) => ({ sessionID, workspaceID: "workspace_1", projectID: "project_1", host: "workspace",
        createdAt: 1, updatedAt: 1, tags: [], attachments: [] }),
    })
    await expect(fixture.backend.agentOpen(fixture.indexed, "ses_missing_authority", {
      auth: { mode: "signed", token: "token", user: { subject: "bob", tokenIdentifier: "actor_bob", issuer: "test" } }, origin: "https://local.example",
    })).rejects.toMatchObject({ status: 503, code: "document_session_authority_unavailable" })
    expect(hydratedSessionDocumentPaths("ses_missing_authority")).toEqual([])
  })

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
    await fs.mkdir(path.join(repository, "docs"))
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

  test("rejects a repository move through a symlink before creating outside directories", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-documents-backend-symlink-root-"))
    const repository = await fs.mkdtemp(path.join(os.tmpdir(), "local-documents-backend-symlink-repository-"))
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "local-documents-backend-symlink-outside-"))
    roots.push(root, repository, outside)
    await git(repository, ["init"])
    await fs.symlink(outside, path.join(repository, "escape"))
    const backend = createLocalDocumentsBackend({
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
    })
    const relativePath = backend.managedRelativePath({
      projectId: "project_1",
      documentId: "document_symlink",
      slug: "Plan",
    })
    const created = await backend.workspace.create({
      origin: "managed",
      placement: "local",
      projectId: "project_1",
      documentId: "document_symlink",
      relativePath,
    }, { markdown: "# Plan\n", actor: { type: "user", id: "user_1" } })
    const timestamp = new Date().toISOString()
    const indexed = backend.index.create({
      id: "document_symlink",
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

    await expect(
      backend.moveToRepository(indexed, {
        workspaceId: "workspace_1",
        relativePath: "escape/created/plan.md",
      }),
    ).rejects.toThrow()
    await expect(fs.access(path.join(outside, "created"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("rejects repository moves whose destination parent does not already exist", async () => {
    const value = await moveFixture()

    await expect(
      value.backend.moveToRepository(value.indexed, {
        workspaceId: "workspace_1",
        relativePath: "missing/plan.md",
      }),
    ).rejects.toMatchObject({ code: "document_not_found" })
    await expect(fs.access(path.join(value.repository, "missing"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  test("rejects a repository move when its verified parent is swapped for an escaping symlink", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "local-documents-backend-parent-swap-outside-"))
    roots.push(outside)
    let detached = ""
    let swapped = false
    const value = await moveFixture({
      faults: {
        async afterRepositoryMoveParentVerified({ parent }) {
          if (swapped) return
          swapped = true
          detached = `${parent}-detached`
          await fs.rename(parent, detached)
          await fs.symlink(outside, parent)
        },
      },
    })
    await fs.mkdir(path.join(value.repository, "docs"))

    try {
      await expect(
        value.backend.moveToRepository(value.indexed, {
          workspaceId: "workspace_1",
          relativePath: "docs/plan.md",
        }),
      ).rejects.toMatchObject({ code: "document_not_found" })
      await expect(fs.access(path.join(outside, "plan.md"))).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      await fs.rm(path.join(value.repository, "docs"), { force: true })
      if (detached) await fs.rename(detached, path.join(value.repository, "docs"))
    }
  })

  test("bounds reads of an existing repository move destination", async () => {
    const value = await moveFixture()
    await fs.mkdir(path.join(value.repository, "docs"))
    await fs.writeFile(path.join(value.repository, "docs", "plan.md"), "x".repeat(2 * 1024 * 1024 + 1))

    await expect(
      value.backend.moveToRepository(value.indexed, {
        workspaceId: "workspace_1",
        relativePath: "docs/plan.md",
      }),
    ).rejects.toMatchObject({ code: "document_too_large" })
  })
})

async function moveFixture(options?: Parameters<typeof createLocalDocumentsBackend>[1], dependencies: Partial<LocalDocumentsBackendDependencies> = {}, projectId = "project_1", orgId = "org_1") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-documents-backend-move-fixture-"))
  const repository = await fs.mkdtemp(path.join(os.tmpdir(), "local-documents-backend-move-repository-"))
  roots.push(root, repository)
  await git(repository, ["init"])
  await git(repository, ["config", "user.email", "documents@example.com"])
  await git(repository, ["config", "user.name", "Documents Test"])
  await fs.writeFile(path.join(repository, "README.md"), "repository\n")
  await git(repository, ["add", "README.md"])
  await git(repository, ["commit", "-m", "initial"])
  const backend = createLocalDocumentsBackend(
    {
      dataDir: () => root,
      async resolveWorkspace(input) {
        if (input.workspaceId !== "workspace_1") return undefined
        return {
          id: "workspace_1",
          project_id: projectId,
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
      runGit: (args, directory, runOptions) => git(directory, args, runOptions),
      ...dependencies,
    },
    options,
  )
  const relativePath = backend.managedRelativePath({
    projectId,
    documentId: "document_fixture",
    slug: "Plan",
  })
  const created = await backend.workspace.create(
    {
      origin: "managed",
      placement: "local",
      projectId,
      documentId: "document_fixture",
      relativePath,
    },
    { markdown: "# Plan\n", actor: { type: "user", id: "user_1" } },
  )
  const timestamp = new Date().toISOString()
  const indexed = backend.index.create({
    id: "document_fixture",
    org_id: orgId,
    project_id: projectId,
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
  return { backend, indexed, repository }
}

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
