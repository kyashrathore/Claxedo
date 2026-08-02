import { afterAll, beforeAll, describe, expect, test, vi } from "vitest"
import { mkdirSync, realpathSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { Hono } from "hono"
import { localOnlyAuthAdapter, type ClerkVerifier, type ControlPlaneAuthConfig } from "../authority/auth"
import type { ProjectAction, WorkspaceAuthority } from "../authority/authority"
import { createLocalManagedDocumentWorkspace, managedDocumentRelativePath } from "../documents/local-managed"
import {
  createLocalRepositoryFileAuthority,
  createLocalRepositoryGitAuthority,
  createRepositoryDocumentWorkspace,
  type RepositoryDocumentHandle,
} from "../documents/repository"
import type { LocalManagedDocumentHandle } from "../documents/local-managed"
import type { DocumentEntry } from "../documents/port"
import { DocumentStorageError } from "../documents/errors"
import {
  archiveDocumentIndexEntry,
  createDocumentIndexEntry,
  findDocumentIndexEntry,
  findRepositoryDocumentIndexEntry,
  listDocumentIndex,
  listDocumentStatuses,
  removeDocumentIndexEntry,
  relocateRepositoryDocumentIndexEntry,
  restoreDocumentIndexEntry,
  transitionDocumentStatus,
  updateDocumentIndexMetadata,
} from "../documents/index-store"
import type { DocumentIndexEntry } from "../documents/index-store"
import { setDocumentChangedSink, subscribeDocumentEvents } from "../documents/backend"
import { ClaxedoDB } from "../adapters/storage/db"
import { DocumentsRoutes, type DocumentsRouteBackend } from "./documents"
import { peerAddressStamp } from "./local-only-projection"
import {
  disposeHydratedSessionDocuments,
  hydrateSessionDocument,
  hydratedSessionDocumentPaths,
} from "../documents/session-hydration"

const execFileAsync = promisify(execFile)

const root = path.join(realpathSync(os.tmpdir()), `document-routes-${randomUUID().slice(0, 8)}`)
const previousDataDir = process.env.CLAXEDO_DATA_DIR
process.env.CLAXEDO_DATA_DIR = root
mkdirSync(root, { recursive: true })

const workspace = createLocalManagedDocumentWorkspace({ dataRoot: root })

const backend: DocumentsRouteBackend<Awaited<ReturnType<typeof workspace.resolve>>> = {
  index: {
    list: listDocumentIndex,
    find: findDocumentIndexEntry,
    findRepository: findRepositoryDocumentIndexEntry,
    create: createDocumentIndexEntry,
    remove: removeDocumentIndexEntry,
    update: updateDocumentIndexMetadata,
    relocate: relocateRepositoryDocumentIndexEntry,
    archive: archiveDocumentIndexEntry,
    restore: restoreDocumentIndexEntry,
    listStatuses: listDocumentStatuses,
    transitionStatus: transitionDocumentStatus,
    resolveLocalProjectId: () => "project_local",
  },
  workspace,
  managedRelativePath: managedDocumentRelativePath,
  placement: "local",
  async agentOpen(entry, sessionId) {
    const handle = await workspace.resolve({
      origin: "managed",
      placement: "local",
      projectId: entry.project_id,
      documentId: entry.id,
      relativePath: entry.managed_relative_path!,
    })
    const read = await workspace.read(handle)
    const workspaceRoot = path.join(root, "session-workspace")
    await fs.mkdir(workspaceRoot, { recursive: true })
    return {
      path: await hydrateSessionDocument({
        sessionId,
        workspaceRoot,
        documentId: entry.id,
        displayName: entry.display_name,
        markdown: read.markdown,
        baseVersion: read.version,
        sync: async (_markdown, expectedVersion) => expectedVersion,
      }),
    }
  },
}

const authConfig: ControlPlaneAuthConfig = {
  enabled: true,
  issuer: "https://clerk.example.test",
  jwksUrl: "https://clerk.example.test/.well-known/jwks.json",
}

const verifier: ClerkVerifier = async (token, config) => ({
  mode: "signed",
  user: { subject: token, tokenIdentifier: `${config.issuer}|${token}`, issuer: config.issuer },
})

function authority(allowed: readonly ProjectAction[] = ["read", "write", "admin"]) {
  return {
    usersMe: vi.fn(async () => ({})),
    resolveOrgId: vi.fn(async () => "org_tenant_a" as never),
    authorizeProject: vi.fn(async (_auth, input: { action: ProjectAction }) =>
      allowed.includes(input.action)
        ? {
            ok: true as const,
            role: input.action === "admin" ? ("admin" as const) : ("editor" as const),
            orgId: "org_tenant_a" as never,
          }
        : { ok: false as const },
    ),
  } as unknown as WorkspaceAuthority
}

function signedApp(allowed?: readonly ProjectAction[]) {
  const services = { auth: { config: authConfig, verifier }, authority: authority(allowed) } as never
  return new Hono().route("/documents", DocumentsRoutes({ backend, services, authConfig, verifier }))
}

function localApp() {
  return new Hono().use(peerAddressStamp()).route(
    "/documents",
    DocumentsRoutes({
      backend,
      services: { auth: localOnlyAuthAdapter() } as never,
    }),
  )
}

async function repositoryApp() {
  const directory = path.join(root, `repository-${randomUUID()}`)
  await fs.mkdir(directory, { recursive: true })
  const git = async (args: readonly string[], cwd = directory, options?: { env?: Readonly<Record<string, string>> }) =>
    (await execFileAsync("git", [...args], { cwd, env: { ...process.env, ...options?.env } })).stdout.trim()
  await git(["init"])
  await git(["config", "user.email", "documents@example.com"])
  await git(["config", "user.name", "Documents Test"])
  await fs.writeFile(path.join(directory, "document.md"), "# Repository\n")
  await git(["add", "document.md"])
  await git(["commit", "-m", "initial"])
  await fs.symlink("document.md", path.join(directory, "alias.md"))
  const workspaces = new Map([["workspace_repo", directory]])
  const repository = createRepositoryDocumentWorkspace({
    workspace: {
      resolve: async (workspaceId) => {
        const workspace = workspaces.get(workspaceId)
        return workspace ? { directory: workspace } : undefined
      },
    },
    files: createLocalRepositoryFileAuthority(),
    git: createLocalRepositoryGitAuthority((args, cwd, options) => git(args, cwd, options)),
  })
  type Handle = LocalManagedDocumentHandle | RepositoryDocumentHandle
  const composite = {
    create: workspace.create,
    resolve: (entry: DocumentEntry): Promise<Handle> =>
      entry.origin === "managed" ? workspace.resolve(entry) : repository.resolve(entry),
    read: (handle: Handle) => (handle.origin === "managed" ? workspace.read(handle) : repository.read(handle)),
    write: (handle: Handle, request: Parameters<typeof workspace.write>[1]) =>
      handle.origin === "managed" ? workspace.write(handle, request) : repository.write(handle, request),
    snapshot: (handle: Handle, request: Parameters<typeof workspace.snapshot>[1]) =>
      handle.origin === "managed" ? workspace.snapshot(handle, request) : repository.snapshot(handle, request),
    listSnapshots: (handle: Handle) =>
      handle.origin === "managed" ? workspace.listSnapshots(handle) : repository.listSnapshots(handle),
    readSnapshot: (handle: Handle, snapshotId: Parameters<typeof workspace.readSnapshot>[1]) =>
      handle.origin === "managed"
        ? workspace.readSnapshot(handle, snapshotId)
        : repository.readSnapshot(handle, snapshotId),
    pinSnapshot: (handle: Handle, snapshotId: Parameters<typeof workspace.pinSnapshot>[1], pin: string) =>
      handle.origin === "managed"
        ? workspace.pinSnapshot(handle, snapshotId, pin)
        : repository.pinSnapshot(handle, snapshotId, pin),
    unpinSnapshot: (handle: Handle, snapshotId: Parameters<typeof workspace.unpinSnapshot>[1], pin: string) =>
      handle.origin === "managed"
        ? workspace.unpinSnapshot(handle, snapshotId, pin)
        : repository.unpinSnapshot(handle, snapshotId, pin),
    collectSnapshots: (handle: Handle) =>
      handle.origin === "managed" ? workspace.collectSnapshots(handle) : repository.collectSnapshots(handle),
    restore: (
      handle: Handle,
      snapshotId: Parameters<typeof workspace.restore>[1],
      request: Parameters<typeof workspace.restore>[2],
    ) =>
      handle.origin === "managed"
        ? workspace.restore(handle, snapshotId, request)
        : repository.restore(handle, snapshotId, request),
  }
  const routeBackend = {
    ...backend,
    workspace: composite,
    repository: {
      async inspect(entry: DocumentEntry) {
        const handle = await repository.resolve(entry)
        return {
          identityKey: await repository.identityKey(entry),
          relativePath: handle.relativePath,
          availability: await repository.availability(entry),
        }
      },
      availability: (entry: DocumentEntry, expectedVersion?: Parameters<typeof repository.availability>[1]) =>
        repository.availability(entry, expectedVersion),
      async relocate(
        entry: DocumentEntry,
        relativePath: string,
        expectedVersion: Parameters<typeof repository.relocate>[2],
      ) {
        const handle = await repository.relocate(entry, relativePath, expectedVersion)
        return {
          identityKey: await repository.identityKey({ ...entry, relativePath: handle.relativePath } as DocumentEntry),
          relativePath: handle.relativePath,
          version: (await repository.read(handle)).version,
        }
      },
      async gitSnapshot(entry: DocumentEntry) {
        return await repository.gitSnapshot(await repository.resolve(entry))
      },
      async commit(
        entry: DocumentEntry,
        request: { message: string; expected: { baseCommit?: string; baseBlobSha?: string } },
      ) {
        const handle = await repository.resolve(entry)
        const committed = await repository.commit(handle, {
          markdown: (await repository.read(handle)).markdown,
          ...request,
        })
        return { ...committed, version: (await repository.read(handle)).version }
      },
    },
  }
  return {
    app: new Hono().route(
      "/documents",
      DocumentsRoutes({
        backend: routeBackend,
        services: { auth: localOnlyAuthAdapter() } as never,
      }),
    ),
    directory,
    git,
    workspaces,
  }
}

async function createDocument(app = localApp(), input: Record<string, unknown> = {}) {
  const response = await app.request("http://localhost/documents", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ project_id: "project_local", display_name: "Plan", markdown: "# Exact\n", ...input }),
  })
  expect(response.status).toBe(201)
  return (await response.json()) as { id: string; last_known_file_version: string }
}

function deferred() {
  let resolve = () => {}
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("DocumentsRoutes", () => {
  beforeAll(() => ClaxedoDB.Drizzle())

  afterAll(async () => {
    ClaxedoDB.close()
    await fs.rm(root, { recursive: true, force: true })
    if (previousDataDir === undefined) delete process.env.CLAXEDO_DATA_DIR
    else process.env.CLAXEDO_DATA_DIR = previousDataDir
  })

  test("opens a local managed document as a contained session-owned file", async () => {
    const app = localApp()
    const document = await createDocument(app, { project_id: "project_agent_open" })
    const response = await app.request(`http://localhost/documents/${document.id}/agent-open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "session-document-roundtrip" }),
    })

    expect(response.status).toBe(200)
    const opened = (await response.json()) as { document_id: string; display_name: string; path: string }
    expect(opened).toMatchObject({ document_id: document.id, display_name: "Plan" })
    expect(await fs.realpath(opened.path)).toBe(opened.path)
    expect(opened.path).toContain(
      `${path.sep}.claxedo${path.sep}sessions${path.sep}session-document-roundtrip${path.sep}docs${path.sep}${document.id}${path.sep}plan.md`,
    )
    expect(hydratedSessionDocumentPaths("session-document-roundtrip")).toEqual([opened.path])
    await disposeHydratedSessionDocuments("session-document-roundtrip")
  })

  test("unsigned local directory identity overrides transient workspace project metadata", async () => {
    const response = await localApp().request("http://localhost/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project_id: "transient_workspace_project",
        directory: "/workspace/project",
        display_name: "Stable project document",
      }),
    })

    expect(response.status).toBe(201)
    const document = (await response.json()) as { id: string; project_id: string }
    expect(document).toMatchObject({ project_id: "project_local" })
    const archived = await localApp().request(`http://localhost/documents/${document.id}/archive`, {
      method: "POST",
    })
    expect(archived.status).toBe(200)
  })

  test("fails closed when the current placement cannot expose a canonical path", async () => {
    const document = await createDocument(localApp(), { project_id: "project_agent_remote" })
    const unavailableBackend = { ...backend, placement: "hosted" as const, agentOpen: undefined }
    const app = new Hono().route(
      "/documents",
      DocumentsRoutes({
        backend: unavailableBackend,
        services: { auth: localOnlyAuthAdapter() } as never,
      }),
    )
    const response = await app.request(`http://localhost/documents/${document.id}/agent-open`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ session_id: "session-remote" }),
    })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "document_placement_unreachable" },
    })
  })

  test("requires document write authority before granting a session file root", async () => {
    const document = await createDocument(localApp(), { project_id: "project_agent_authority" })
    const response = await signedApp(["read"]).request(`http://signed.test/documents/${document.id}/agent-open`, {
      method: "POST",
      headers: { authorization: "Bearer viewer", "content-type": "application/json" },
      body: JSON.stringify({ session_id: "session-viewer" }),
    })

    expect(response.status).toBe(404)
    expect(hydratedSessionDocumentPaths("session-viewer")).toEqual([])
  })

  test("authenticates the human runtime-conflict choice and trusts no caller content or version", async () => {
    const createdResponse = await signedApp().request("http://signed.test/documents", {
      method: "POST",
      headers: { authorization: "Bearer user_1", "content-type": "application/json" },
      body: JSON.stringify({ project_id: "project_conflict", display_name: "Conflict", markdown: "durable" }),
    })
    const created = (await createdResponse.json()) as DocumentIndexEntry
    const resolve = vi.fn(async () => ({ path: "/workspace/conflict.md", version: "canonical-v3" }))
    const routeBackend = { ...backend, runtimeResolve: resolve }
    const app = (allowed: readonly ProjectAction[] = ["read", "write", "admin"]) =>
      new Hono().route(
        "/documents",
        DocumentsRoutes({
          backend: routeBackend,
          services: { auth: { config: authConfig, verifier }, authority: authority(allowed) } as never,
          authConfig,
          verifier,
        }),
      )
    const url = `http://signed.test/documents/${created.id}/runtime-conflict/resolve`
    expect(
      (
        await app().request(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session_id: "session_1", choice: "draft" }),
        })
      ).status,
    ).toBe(401)
    expect(
      (
        await app(["read"]).request(url, {
          method: "POST",
          headers: { authorization: "Bearer user_1", "content-type": "application/json" },
          body: JSON.stringify({ session_id: "session_1", choice: "draft" }),
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await app().request(url, {
          method: "POST",
          headers: { authorization: "Bearer user_1", "content-type": "application/json" },
          body: JSON.stringify({
            session_id: "session_1",
            choice: "draft",
            remoteVersion: "attacker",
            remoteMarkdown: "attacker",
          }),
        })
      ).status,
    ).toBe(400)
    const accepted = await app().request(url, {
      method: "POST",
      headers: { authorization: "Bearer user_1", "content-type": "application/json" },
      body: JSON.stringify({ session_id: "session_1", choice: "draft" }),
    })
    expect(accepted.status).toBe(200)
    expect(resolve).toHaveBeenCalledWith(expect.objectContaining({ id: created.id }), {
      auth: expect.objectContaining({ user: expect.objectContaining({ subject: "user_1" }) }),
      sessionId: "session_1",
      choice: "draft",
    })
    expect(
      (
        await app().request(`${url}-other`, {
          method: "POST",
          headers: { authorization: "Bearer user_1", "content-type": "application/json" },
          body: JSON.stringify({ session_id: "session_1", choice: "draft" }),
        })
      ).status,
    ).toBe(404)
    resolve.mockRejectedValueOnce(new Error("revoked or stale"))
    expect(
      (
        await app().request(url, {
          method: "POST",
          headers: { authorization: "Bearer user_1", "content-type": "application/json" },
          body: JSON.stringify({ session_id: "session_1", choice: "durable" }),
        })
      ).status,
    ).toBe(403)
    await backend.index.archive({ orgId: "org_tenant_a", projectId: "project_conflict" }, created.id)
    expect(
      (
        await app().request(url, {
          method: "POST",
          headers: { authorization: "Bearer user_1", "content-type": "application/json" },
          body: JSON.stringify({ session_id: "session_1", choice: "durable" }),
        })
      ).status,
    ).toBe(404)
  })

  test("serves metadata-only list/index CRUD and exact file export", async () => {
    const app = localApp()
    const created = await createDocument(app, { markdown: "\ufeff# Exact\r\nbody" })
    const list = await app.request("http://localhost/documents?project_id=project_local")
    expect(list.status).toBe(200)
    const rows = (await list.json()) as Record<string, unknown>[]
    expect(rows).toHaveLength(1)
    expect(rows[0]).not.toHaveProperty("markdown")
    expect(rows[0]).not.toHaveProperty("content")

    const statuses = await app.request("http://localhost/documents/statuses?project_id=project_local")
    expect(statuses.status).toBe(200)
    await expect(statuses.json()).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: "draft" })]))

    const patched = await app.request(`http://localhost/documents/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "if-match": created.last_known_file_version },
      body: JSON.stringify({ display_name: "Renamed", session_id: "session_1" }),
    })
    expect(patched.status).toBe(200)
    await expect(patched.json()).resolves.toMatchObject({ display_name: "Renamed", session_id: "session_1" })

    const exported = await app.request(`http://localhost/documents/${created.id}/export`)
    expect(exported.status).toBe(200)
    expect(new Uint8Array(await exported.arrayBuffer())).toEqual(new TextEncoder().encode("\ufeff# Exact\r\nbody"))
  })

  test("rejects Tiptap JSON at every document write route", async () => {
    const app = localApp()
    const create = await app.request("http://localhost/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project_id: "project_local",
        display_name: "JSON document",
        content: { type: "doc", content: [] },
      }),
    })
    expect(create.status).toBe(400)

    const document = await createDocument(app, { markdown: "# Markdown" })
    const update = await app.request(`http://localhost/documents/${document.id}/content`, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": document.last_known_file_version },
      body: JSON.stringify({ markdown: { type: "doc", content: [] } }),
    })
    expect(update.status).toBe(400)
  })

  test("pins and returns the exact immutable snapshot used for WorkGraph intake", async () => {
    const pinSnapshot = vi.fn(backend.workspace.pinSnapshot)
    const unpinSnapshot = vi.fn(backend.workspace.unpinSnapshot)
    const app = new Hono().route(
      "/documents",
      DocumentsRoutes({
        backend: { ...backend, workspace: { ...backend.workspace, pinSnapshot, unpinSnapshot } },
        services: { auth: localOnlyAuthAdapter() } as never,
      }),
    )
    const created = await createDocument(app, { display_name: "Intake", markdown: "# Exact\r\nbytes\n" })
    const response = await app.request(`http://localhost/documents/${created.id}/work-source`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target_stream_id: "stream_1", directory: "/worktree" }),
    })

    expect(response.status).toBe(200)
    const intake = (await response.json()) as {
      locator: {
        projectId: string
        documentId: string
        snapshotId: string
        placement: string
        targetStreamId: string
        directory: string
      }
      documentTitle: string
      markdown: string
      contentHash: string
    }
    expect(intake).toMatchObject({
      locator: {
        projectId: "project_local",
        documentId: created.id,
        placement: "local",
        targetStreamId: "stream_1",
        directory: "/worktree",
      },
      documentTitle: "Intake",
      markdown: "# Exact\r\nbytes\n",
    })
    expect(intake.locator.snapshotId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/)
    expect(intake.contentHash).toMatch(/^[a-f0-9]{64}$/)
    const snapshots = (await (
      await app.request(`http://localhost/documents/${created.id}/snapshots`)
    ).json()) as Array<{ id: string; sha256: string; pins: string[] }>
    expect(snapshots.find((snapshot) => snapshot.id === intake.locator.snapshotId)).toMatchObject({
      sha256: intake.contentHash,
      pins: [expect.stringMatching(/^lease:\d+:/)],
    })
    pinSnapshot.mockClear()
    unpinSnapshot.mockClear()
    const pinned = await app.request(
      `http://localhost/documents/${created.id}/snapshots/${intake.locator.snapshotId}/work-source-pin`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ work_source_id: "source_1", revision_id: "revision_1" }),
      },
    )
    await expect(pinned.json()).resolves.toMatchObject({ pins: ["workgraph:source_1:revision_1"] })
    expect(pinSnapshot).toHaveBeenCalledTimes(1)
    expect(unpinSnapshot).toHaveBeenCalledTimes(1)
    expect(pinSnapshot.mock.invocationCallOrder[0]).toBeLessThan(unpinSnapshot.mock.invocationCallOrder[0]!)
  })

  test("enforces signed read/write/admin actions and hides unauthorized ids", async () => {
    const created = await createDocument()
    const readOnly = signedApp(["read"])
    expect(
      (
        await readOnly.request(`http://app.example/documents/${created.id}`, {
          headers: { authorization: "Bearer tenant_a" },
        })
      ).status,
    ).toBe(404)

    const signedCreated = await signedApp().request("http://app.example/documents", {
      method: "POST",
      headers: { authorization: "Bearer tenant_a", "content-type": "application/json" },
      body: JSON.stringify({ project_id: "project_auth", display_name: "Signed", markdown: "body" }),
    })
    expect(signedCreated.status).toBe(201)
    const document = (await signedCreated.json()) as { id: string; last_known_file_version: string }

    expect(
      (
        await signedApp(["read"]).request(`http://app.example/documents/${document.id}/content`, {
          headers: { authorization: "Bearer tenant_a" },
        })
      ).status,
    ).toBe(200)
    const intake = (await (
      await signedApp().request(`http://app.example/documents/${document.id}/work-source`, {
        method: "POST",
        headers: { authorization: "Bearer tenant_a", "content-type": "application/json" },
        body: "{}",
      })
    ).json()) as { locator: { snapshotId: string } }
    const pinUrl = `http://app.example/documents/${document.id}/snapshots/${intake.locator.snapshotId}/work-source-pin`
    expect(
      (
        await signedApp(["read"]).request(pinUrl, {
          method: "POST",
          headers: { authorization: "Bearer tenant_a", "content-type": "application/json" },
          body: JSON.stringify({ work_source_id: "source_auth", revision_id: "revision_auth" }),
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await signedApp(["read", "write"]).request(pinUrl, {
          method: "POST",
          headers: { authorization: "Bearer tenant_a", "content-type": "application/json" },
          body: JSON.stringify({ work_source_id: "source_auth", revision_id: "revision_auth" }),
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await signedApp(["read"]).request(`http://app.example/documents/${document.id}/content`, {
          method: "PUT",
          headers: {
            authorization: "Bearer tenant_a",
            "content-type": "application/json",
            "if-match": document.last_known_file_version,
          },
          body: JSON.stringify({ markdown: "denied" }),
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await signedApp(["read", "write"]).request(`http://app.example/documents/${document.id}/archive`, {
          method: "POST",
          headers: { authorization: "Bearer tenant_a", "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(404)
    expect(
      (
        await signedApp().request(`http://app.example/documents/${document.id}/archive`, {
          method: "POST",
          headers: { authorization: "Bearer tenant_a", "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(200)
  })

  test("allows unsigned loopback and rejects unsigned non-loopback", async () => {
    expect((await localApp().request("http://localhost/documents?project_id=project_local")).status).toBe(200)
    expect((await localApp().request("http://app.example/documents?project_id=project_local")).status).toBe(401)
    expect((await localApp().request(
      "http://localhost/documents?project_id=project_local",
      { headers: { "x-forwarded-for": "127.0.0.2, 203.0.113.7" } },
      { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
    )).status).toBe(401)
  })

  test("fails honestly when a hosted composition has not supplied D11 storage", async () => {
    const unavailable = new Hono().route(
      "/documents",
      DocumentsRoutes({
        services: { auth: { config: authConfig, verifier }, authority: authority() } as never,
        authConfig,
        verifier,
      }),
    )
    const response = await unavailable.request("http://app.example/documents?project_id=project_hosted", {
      headers: { authorization: "Bearer tenant_a" },
    })
    expect(response.status).toBe(503)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "document_backend_unavailable" } })
  })

  test("reports repository moves as unavailable when the placement has no move authority", async () => {
    const document = await createDocument()
    const response = await localApp().request(`http://localhost/documents/${document.id}/move-to-repository`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspace_id: "workspace_1", path: "docs/document.md" }),
    })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({ error: { code: "document_move_unavailable" } })
  })

  test("requires If-Match and returns the current version on stale writes", async () => {
    const app = localApp()
    const created = await createDocument(app)
    const missing = await app.request(`http://localhost/documents/${created.id}/content`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ markdown: "first" }),
    })
    expect(missing.status).toBe(428)

    const first = await app.request(`http://localhost/documents/${created.id}/content`, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": created.last_known_file_version },
      body: JSON.stringify({ markdown: "first", display_name: "First title" }),
    })
    expect(first.status).toBe(200)
    const current = (await first.json()) as { version: string }

    const stale = await app.request(`http://localhost/documents/${created.id}/content`, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": created.last_known_file_version },
      body: JSON.stringify({ markdown: "stale", display_name: "Stale title" }),
    })
    expect(stale.status).toBe(409)
    await expect(stale.json()).resolves.toMatchObject({ currentVersion: current.version })
    await expect((await app.request(`http://localhost/documents/${created.id}`)).json()).resolves.toMatchObject({
      display_name: "First title",
    })
  })

  test("accepts title-only saves across content-equivalent local tokens", async () => {
    const app = localApp()
    const created = await createDocument(app)
    const first = await app.request(`http://localhost/documents/${created.id}/content`, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": created.last_known_file_version },
      body: JSON.stringify({ markdown: "# Exact\n", display_name: "First title" }),
    })
    expect(first.status).toBe(200)

    const second = await app.request(`http://localhost/documents/${created.id}/content`, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": created.last_known_file_version },
      body: JSON.stringify({ markdown: "# Exact\n", display_name: "Second title" }),
    })
    expect(second.status).toBe(200)
    await expect(second.json()).resolves.toMatchObject({ version: expect.any(String) })
    await expect((await app.request(`http://localhost/documents/${created.id}`)).json()).resolves.toMatchObject({
      display_name: "Second title",
    })
  })

  test("serializes overlapping same-Markdown title saves", async () => {
    const entered = deferred()
    const release = deferred()
    let writes = 0
    const gatedBackend = {
      ...backend,
      workspace: {
        ...workspace,
        async write(...input: Parameters<typeof workspace.write>) {
          writes += 1
          if (writes === 1) {
            entered.resolve()
            await release.promise
          }
          return await workspace.write(...input)
        },
      },
    }
    const app = new Hono().route(
      "/documents",
      DocumentsRoutes({
        backend: gatedBackend,
        services: { auth: localOnlyAuthAdapter() } as never,
      }),
    )
    const created = await createDocument(app)
    const request = (display_name: string) =>
      app.request(`http://localhost/documents/${created.id}/content`, {
        method: "PUT",
        headers: { "content-type": "application/json", "if-match": created.last_known_file_version },
        body: JSON.stringify({ markdown: "# Exact\n", display_name }),
      })
    const first = request("First concurrent title")
    await entered.promise
    const second = request("Second concurrent title")
    await Promise.resolve()
    expect(writes).toBe(1)
    release.resolve()
    const responses = await Promise.all([first, second])
    expect(responses.map((response) => response.status)).toEqual([200, 200])
    expect(writes).toBe(2)
    await expect((await app.request(`http://localhost/documents/${created.id}`)).json()).resolves.toMatchObject({
      display_name: "Second concurrent title",
    })
  })

  test("serializes PATCH rename against a composite PUT", async () => {
    const entered = deferred()
    const release = deferred()
    let writes = 0
    const gatedBackend = {
      ...backend,
      workspace: {
        ...workspace,
        async write(...input: Parameters<typeof workspace.write>) {
          writes += 1
          if (writes === 1) {
            entered.resolve()
            await release.promise
          }
          return await workspace.write(...input)
        },
      },
    }
    const app = new Hono().route(
      "/documents",
      DocumentsRoutes({
        backend: gatedBackend,
        services: { auth: localOnlyAuthAdapter() } as never,
      }),
    )
    const created = await createDocument(app)
    const rename = app.request(`http://localhost/documents/${created.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "if-match": created.last_known_file_version },
      body: JSON.stringify({ display_name: "PATCH title" }),
    })
    await entered.promise
    const save = app.request(`http://localhost/documents/${created.id}/content`, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": created.last_known_file_version },
      body: JSON.stringify({ markdown: "# Exact\n", display_name: "PUT title" }),
    })
    release.resolve()
    expect((await rename).status).toBe(200)
    expect((await save).status).toBe(200)
    await expect((await app.request(`http://localhost/documents/${created.id}`)).json()).resolves.toMatchObject({
      display_name: "PUT title",
    })
  })

  test("a delayed GET observation cannot roll back a newer PUT token", async () => {
    const entered = deferred()
    const release = deferred()
    const delayedBackend = {
      ...backend,
      workspace: {
        ...workspace,
        async read(...input: Parameters<typeof workspace.read>) {
          const read = await workspace.read(...input)
          entered.resolve()
          await release.promise
          return read
        },
      },
    }
    const app = new Hono().route(
      "/documents",
      DocumentsRoutes({
        backend: delayedBackend,
        services: { auth: localOnlyAuthAdapter() } as never,
      }),
    )
    const created = await createDocument(app)
    const observed = app.request(`http://localhost/documents/${created.id}/content`)
    await entered.promise
    const save = app.request(`http://localhost/documents/${created.id}/content`, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": created.last_known_file_version },
      body: JSON.stringify({ markdown: "newer" }),
    })
    release.resolve()
    expect((await observed).status).toBe(200)
    const saved = await save
    expect(saved.status).toBe(200)
    const written = (await saved.json()) as { version: string }
    await expect((await app.request(`http://localhost/documents/${created.id}`)).json()).resolves.toMatchObject({
      last_known_file_version: written.version,
    })
  })

  test("rejects invalid and oversized JSON bodies", async () => {
    const invalid = await localApp().request("http://localhost/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: "project_local", display_name: "Invalid", markdown: 1 }),
    })
    expect(invalid.status).toBe(400)
    await expect(invalid.json()).resolves.toMatchObject({ error: { code: "document_invalid_body" } })

    const oversized = await localApp().request("http://localhost/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        project_id: "project_local",
        display_name: "Large",
        markdown: "x".repeat(2 * 1024 * 1024),
      }),
    })
    expect(oversized.status).toBe(413)
  })

  test("cancels a chunked body as soon as it crosses 2 MiB", async () => {
    let pulls = 0
    let canceled = false
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1
        controller.enqueue(new Uint8Array(1024 * 1024))
        if (pulls === 100) controller.close()
      },
      cancel() {
        canceled = true
      },
    })
    const response = await localApp().request(
      new Request("http://localhost/documents", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" }),
    )

    expect(response.status).toBe(413)
    expect(pulls).toBeLessThan(100)
    expect(canceled).toBe(true)
  })

  test("rolls back the pending index row when managed file creation fails", async () => {
    const failingBackend = {
      ...backend,
      workspace: {
        ...workspace,
        async create() {
          throw new DocumentStorageError("document_storage_failed", "creating a managed document")
        },
      },
    }
    const app = new Hono().route(
      "/documents",
      DocumentsRoutes({
        backend: failingBackend,
        services: { auth: localOnlyAuthAdapter() } as never,
      }),
    )
    const response = await app.request("http://localhost/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project_id: "project_failed_create", display_name: "Fails", markdown: "body" }),
    })
    expect(response.status).toBe(500)
    expect(listDocumentIndex({ orgId: "__local__", projectId: "project_failed_create" })).toEqual([])
  })

  test("indexes, deduplicates, recovers, relocates, and commits repository documents", async () => {
    const fixture = await repositoryApp()
    const add = (sourcePath: string) =>
      fixture.app.request("http://localhost/documents/from-repo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          project_id: "project_repo",
          workspace_id: "workspace_repo",
          path: sourcePath,
          display_name: "Repository document",
        }),
      })
    const createdResponse = await add("document.md")
    expect(createdResponse.status).toBe(201)
    const created = (await createdResponse.json()) as {
      id: string
      repository_id: string
      last_known_file_version: string
    }
    expect(created).not.toHaveProperty("markdown")

    const duplicateResponse = await add("alias.md")
    expect(duplicateResponse.status).toBe(200)
    await expect(duplicateResponse.json()).resolves.toMatchObject({
      id: created.id,
      repository_id: created.repository_id,
    })

    const content = await fixture.app.request(`http://localhost/documents/${created.id}/content`)
    expect(content.status).toBe(200)
    await expect(content.json()).resolves.toMatchObject({ markdown: "# Repository\n" })
    await fs.unlink(path.join(fixture.directory, "alias.md"))
    await fs.rename(path.join(fixture.directory, "document.md"), path.join(fixture.directory, "moved.md"))

    const moved = await fixture.app.request(`http://localhost/documents/${created.id}/availability`)
    expect(moved.status).toBe(200)
    await expect(moved.json()).resolves.toEqual({ state: "moved", relativePath: "moved.md" })

    const relocatedResponse = await fixture.app.request(`http://localhost/documents/${created.id}/relocate`, {
      method: "POST",
      headers: { "content-type": "application/json", "if-match": created.last_known_file_version },
      body: JSON.stringify({ path: "moved.md" }),
    })
    expect(relocatedResponse.status).toBe(200)
    const relocated = (await relocatedResponse.json()) as { last_known_file_version: string }

    await fixture.git(["add", "-A"])
    await fixture.git(["commit", "-m", "move document"])
    const snapshotResponse = await fixture.app.request(`http://localhost/documents/${created.id}/git/snapshot`)
    expect(snapshotResponse.status).toBe(200)
    const snapshot = (await snapshotResponse.json()) as { head: string; blobSha: string }

    const conflict = await fixture.app.request(`http://localhost/documents/${created.id}/git/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "stale",
        expected: { baseCommit: "0".repeat(40), baseBlobSha: snapshot.blobSha },
      }),
    })
    expect(conflict.status).toBe(409)
    await expect(conflict.json()).resolves.toMatchObject({ error: { code: "git_source_conflict" } })

    const committed = await fixture.app.request(`http://localhost/documents/${created.id}/git/commit`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        message: "document checkpoint",
        expected: { baseCommit: snapshot.head, baseBlobSha: snapshot.blobSha },
      }),
    })
    expect(committed.status).toBe(200)

    const latest = await fixture.app.request(`http://localhost/documents/${created.id}`)
    const latestEntry = (await latest.json()) as { last_known_file_version: string }
    const edited = await fixture.app.request(`http://localhost/documents/${created.id}/content`, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": latestEntry.last_known_file_version },
      body: JSON.stringify({ markdown: "dirty\n" }),
    })
    expect(edited.status).toBe(200)
    const dirty = await fixture.app.request(`http://localhost/documents/${created.id}/git/snapshot`)
    expect(dirty.status).toBe(409)
    await expect(dirty.json()).resolves.toMatchObject({ error: { code: "git_source_conflict" } })

    await fs.unlink(path.join(fixture.directory, "moved.md"))
    const missing = await fixture.app.request(`http://localhost/documents/${created.id}/availability`)
    await expect(missing.json()).resolves.toEqual({ state: "missing" })
    fixture.workspaces.delete("workspace_repo")
    const unavailable = await fixture.app.request(`http://localhost/documents/${created.id}/availability`)
    await expect(unavailable.json()).resolves.toEqual({ state: "workspace-unavailable" })
    expect(relocated.last_known_file_version).toBeTruthy()
  })

  test("lists snapshots and reports restore CAS conflicts", async () => {
    const app = localApp()
    const created = await createDocument(app)
    const first = await app.request(`http://localhost/documents/${created.id}/content`, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": created.last_known_file_version },
      body: JSON.stringify({ markdown: "second" }),
    })
    const current = (await first.json()) as { version: string }
    const snapshots = await app.request(`http://localhost/documents/${created.id}/snapshots`)
    const rows = (await snapshots.json()) as { id: string }[]
    expect(rows.length).toBeGreaterThan(0)

    const conflict = await app.request(`http://localhost/documents/${created.id}/snapshots/${rows[0]!.id}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json", "if-match": created.last_known_file_version },
      body: "{}",
    })
    expect(conflict.status).toBe(409)
    await expect(conflict.json()).resolves.toMatchObject({ currentVersion: current.version })
  })

  // Project-scoped delivery moved off the SSE onto the central `document.changed`
  // doorbell, so this exercises the in-process
  // listener registry that both the doorbell sink and the document-scoped stream
  // are fed from. `publishDocumentEvent` is synchronous, so every event is
  // already recorded by the time each awaited request resolves.
  test("emits every mutation reason and invalidation hints to document event listeners", async () => {
    const app = localApp()
    const seen: Record<string, unknown>[] = []
    // localApp() authenticates through localOnlyAuthAdapter, whose org is __local__.
    const unsubscribe = subscribeDocumentEvents("__local__", "project_local", (event) => seen.push(event))
    const nextReason = () => seen.at(-1)?.reason

    const document = await createDocument(app, { display_name: "Evented" })
    expect(seen.at(-1)).toMatchObject({
      type: "document.changed",
      reason: "document.created",
      invalidate: ["index", "content", "snapshots"],
    })
    const reasons = [nextReason()]

    const metadataResponse = await app.request(`http://localhost/documents/${document.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", "if-match": document.last_known_file_version },
      body: JSON.stringify({ display_name: "Evented again" }),
    })
    expect(metadataResponse.status).toBe(200)
    const metadata = (await metadataResponse.json()) as { last_known_file_version: string }
    reasons.push(nextReason())

    expect(
      (
        await app.request(`http://localhost/documents/${document.id}/session`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ session_id: "session_event" }),
        })
      ).status,
    ).toBe(200)
    reasons.push(nextReason())

    expect(
      (
        await app.request(`http://localhost/documents/${document.id}/status`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "in_review" }),
        })
      ).status,
    ).toBe(200)
    reasons.push(nextReason())

    const content = await app.request(`http://localhost/documents/${document.id}/content`, {
      method: "PUT",
      headers: { "content-type": "application/json", "if-match": metadata.last_known_file_version },
      body: JSON.stringify({ markdown: "event content" }),
    })
    expect(content.status).toBe(200)
    const current = (await content.json()) as { version: string }
    reasons.push(nextReason())

    const snapshots = (await (await app.request(`http://localhost/documents/${document.id}/snapshots`)).json()) as {
      id: string
    }[]
    expect(
      (
        await app.request(`http://localhost/documents/${document.id}/snapshots/${snapshots[0]!.id}/restore`, {
          method: "POST",
          headers: { "content-type": "application/json", "if-match": current.version },
          body: "{}",
        })
      ).status,
    ).toBe(200)
    reasons.push(nextReason())

    expect((await app.request(`http://localhost/documents/${document.id}/archive`, { method: "POST" })).status).toBe(
      200,
    )
    reasons.push(nextReason())
    expect((await app.request(`http://localhost/documents/${document.id}/restore`, { method: "POST" })).status).toBe(
      200,
    )
    reasons.push(nextReason())

    expect(reasons).toEqual([
      "document.created",
      "document.metadata_updated",
      "document.session_changed",
      "document.status_changed",
      "document.content_updated",
      "document.snapshot_restored",
      "document.archived",
      "document.restored",
    ])
    unsubscribe()
  })

  test("publishes a camelCase document.changed doorbell for saves", async () => {
    const published: Record<string, unknown>[] = []
    const restore = setDocumentChangedSink((event) => published.push(event))
    try {
      const app = localApp()
      const document = await createDocument(app, { display_name: "Doorbell" })
      // ⚠ The two `document.changed` shapes share a discriminant. The bus envelope
      // must be the camelCase one, carrying identity only — never the legacy
      // snake_case SSE payload with `reason`/`invalidate` passed straight through.
      expect(published.at(-1)).toEqual({
        type: "document.changed",
        documentId: document.id,
        orgId: "__local__",
        projectId: "project_local",
        version: expect.any(String),
        ts: expect.any(Number),
      })
      expect(published.at(-1)).not.toHaveProperty("document_id")
      expect(published.at(-1)).not.toHaveProperty("reason")
      expect(published.at(-1)).not.toHaveProperty("invalidate")

      const content = await app.request(`http://localhost/documents/${document.id}/content`, {
        method: "PUT",
        headers: { "content-type": "application/json", "if-match": document.last_known_file_version },
        body: JSON.stringify({ markdown: "doorbell content" }),
      })
      expect(content.status).toBe(200)
      expect(published.at(-1)).toMatchObject({ documentId: document.id, type: "document.changed" })

      // Metadata-only changes are not content writes, so they ring without a version.
      const renamed = await app.request(`http://localhost/documents/${document.id}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "if-match": ((await content.json()) as { version: string }).version,
        },
        body: JSON.stringify({ display_name: "Doorbell renamed" }),
      })
      expect(renamed.status).toBe(200)
      expect(published.at(-1)).not.toHaveProperty("version")
    } finally {
      restore()
    }
  })

  test("keeps a failing doorbell sink from failing the write that rang it", async () => {
    // CAS-at-write is the correctness mechanism; the doorbell is a fire-and-forget
    // hint. A broken sink may cost freshness, never a write.
    const restore = setDocumentChangedSink(() => {
      throw new Error("bus exploded")
    })
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const app = localApp()
      await expect(createDocument(app, { display_name: "Resilient" })).resolves.toMatchObject({
        display_name: "Resilient",
      })
    } finally {
      errors.mockRestore()
      restore()
    }
  })

  test("emits no doorbell when no sink is installed (hosted composition)", async () => {
    setDocumentChangedSink(undefined)
    const app = localApp()
    await expect(createDocument(app, { display_name: "Sinkless" })).resolves.toMatchObject({
      display_name: "Sinkless",
    })
  })

})
