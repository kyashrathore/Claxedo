import { execFile } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { afterEach, describe, expect, test, vi } from "vitest"
import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { Hono } from "hono"
import {
  createWorkspaceRelay,
  createWorkspaceRelayDirectory,
  mintRuntimeAccessToken,
} from "@claxedo/workspace-relay"
import {
  createWorkspaceRuntimeApp,
  flushRuntimeDocument,
  forgetRuntimeDocuments,
  relayWorkspaceRuntimeExposure,
} from "../../../workspace-runtime/src/index"
import { localOnlyAuthAdapter, type ClerkVerifier, type ControlPlaneAuthConfig, type SignedControlPlaneAuth } from "../control-plane/auth"
import type { ControlPlaneServices } from "../control-plane/services"
import { DocumentsRoutes, type DocumentsRouteBackend } from "../routes/documents"
import { createHostedDocumentsBackend } from "./hosted-backend"
import { createHostedLocalDocumentRelay } from "./hosted-local-relay"
import { createHostedDocumentRuntimeBroker } from "./hosted-runtime-broker"
import type { DocumentIndexEntry } from "./index-store"
import { LocalInstallationDocumentBroker } from "./local-installation-broker"
import { createLocalManagedDocumentWorkspace, managedDocumentRelativePath } from "./local-managed"
import {
  createLocalRepositoryFileAuthority,
  createLocalRepositoryGitAuthority,
  createRepositoryDocumentWorkspace,
} from "./repository"
import type { DocumentEntry } from "./port"

const exec = promisify(execFile)
const roots = new Set<string>()
const originalFetch = globalThis.fetch

afterEach(async () => {
  forgetRuntimeDocuments()
  globalThis.fetch = originalFetch
  await Promise.all([...roots].map((root) => fs.rm(root, { recursive: true, force: true })))
  roots.clear()
})

describe("hosted remote documents genuine integration", () => {
  test("discovers, hydrates, writes, renews, streams, resolves conflicts, and roundtrips repository origin across isolates", async () => {
    const signing = await generateKeyPair("EdDSA", { extractable: true })
    const env = {
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(signing.privateKey),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(signing.publicKey),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM: "EdDSA",
      CLAXEDO_PUBLIC_URL: "https://control.test",
    }
    const previous = {
      root: process.env.WORKSPACE_RUNTIME_DIRECTORY,
      publicKey: process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM,
      algorithm: process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM,
      control: process.env.CLAXEDO_CONTROL_PLANE_URL,
      localControl: process.env.CLAXEDO_LOCAL_CONTROL_PLANE_URL,
    }
    const cloudRoot = await temporary("hosted-cloud-runtime-")
    process.env.WORKSPACE_RUNTIME_DIRECTORY = cloudRoot
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM = env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM = "EdDSA"
    process.env.CLAXEDO_CONTROL_PLANE_URL = "https://control.test"
    process.env.CLAXEDO_LOCAL_CONTROL_PLANE_URL = "http://local.test"
    const localRoot = await temporary("hosted-local-documents-")
    const repositoryRoot = await temporary("hosted-local-repository-")
    await git(repositoryRoot, ["init"])
    await git(repositoryRoot, ["config", "user.email", "documents@example.com"])
    await git(repositoryRoot, ["config", "user.name", "Documents Integration"])
    await fs.writeFile(path.join(repositoryRoot, "repository.md"), "repository before")
    await git(repositoryRoot, ["add", "repository.md"])
    await git(repositoryRoot, ["commit", "-m", "initial"])

    const managed = createLocalManagedDocumentWorkspace({ dataRoot: localRoot })
    const repository = createRepositoryDocumentWorkspace({
      workspace: { resolve: async (workspaceId) => workspaceId === "local_ws" ? { directory: repositoryRoot } : undefined },
      files: createLocalRepositoryFileAuthority(),
      git: createLocalRepositoryGitAuthority(async (args, directory, options) =>
        (await exec("git", [...args], { cwd: directory, env: { ...process.env, ...options?.env } })).stdout.trim()),
    })
    const rows = new Map<string, DocumentIndexEntry>()
    const now = new Date().toISOString()
    const managedEntry = entry({
      id: "managed_remote", displayName: "Managed", origin: "managed",
      managedPath: managedDocumentRelativePath({ projectId: "project_1", documentId: "managed_remote", slug: "Managed" }),
    }, now)
    const repositoryEntry = entry({
      id: "repository_remote", displayName: "Repository", origin: "repository", repositoryPath: "repository.md",
    }, now)
    rows.set(managedEntry.id, managedEntry)
    rows.set(repositoryEntry.id, repositoryEntry)
    await managed.create(portEntry(managedEntry), { markdown: "managed before", actor: { type: "user", id: "user_1" } })
    const localBackend = localDocumentsBackend(rows, managed, repository)

    const localControl = new Hono()
      .route("/internal/documents", LocalInstallationDocumentBroker({
        backend: localBackend,
        installationToken: "installation-secret",
        env,
      }))
      .route("/documents", DocumentsRoutes({
        backend: localBackend,
        services: { auth: localOnlyAuthAdapter() } as never,
      }))

    const localRuntime = createWorkspaceRuntimeApp({
      exposure: relayWorkspaceRuntimeExposure({ key: signing.publicKey, workspaceId: "local_ws", hostId: "local_host" }),
      internalSecrets: { localDocumentBrokerToken: "installation-secret" },
    })
    const cloudRuntime = createWorkspaceRuntimeApp({
      exposure: relayWorkspaceRuntimeExposure({ key: signing.publicKey, workspaceId: "cloud_ws", hostId: "cloud_host" }),
      internalSecrets: {},
    })
    const directory = createWorkspaceRelayDirectory({ sweepIntervalMs: 0 })
    directory.registerHostTunnel({ hostId: "local_host", workspaceIds: ["local_ws"] })
    directory.registerHostTunnel({ hostId: "cloud_host", workspaceIds: ["cloud_ws"] })
    const sessionTokens = new Map<string, string>()
    const relay = createWorkspaceRelay({
      runtimeAccessKey: signing.publicKey,
      relayHostSigningKey: signing.privateKey,
      relayHostAlgorithm: "EdDSA",
      isRuntimeAccessTokenActive: async () => ({ active: true }),
      resolveTarget: async (claims) => claims.workspace_id === "local_ws"
        ? { workspaceId: "local_ws", hostId: "local_host", baseUrl: "http://local.runtime", access: "user-hosted", backing: "local-worktree" }
        : { workspaceId: "cloud_ws", hostId: "cloud_host", baseUrl: "http://cloud.runtime", access: "cloud", backing: "cloud-vm" },
      directory,
      fetch: (async (request: RequestInfo | URL, init?: RequestInit) => {
        const source = request instanceof Request ? request : new Request(request, init)
        const runtime = new URL(source.url).hostname === "local.runtime" ? localRuntime : cloudRuntime
        const url = new URL(source.url)
        if (runtime === cloudRuntime && url.pathname.endsWith("/api/wr/documents/hydrate")) {
          const body = await source.clone().json() as { sessionId: string; writeback: { token: string } }
          sessionTokens.set(body.sessionId, body.writeback.token)
        }
        if (runtime === cloudRuntime && url.pathname.endsWith("/resolve")) {
          const body = await source.clone().json() as { writeback: { token: string } }
          const sessionId = url.pathname.split("/").at(-3)
          if (sessionId) sessionTokens.set(sessionId, body.writeback.token)
        }
        return runtime.app.fetch(new Request(`http://runtime.test${url.pathname}${url.search}`, source))
      }) as unknown as typeof fetch,
    })
    const relayFetch = (async (input: string | URL | Request, init?: RequestInit) =>
      await relay.fetch(input instanceof Request ? input : new Request(input, init))) as unknown as typeof fetch

    const signed: SignedControlPlaneAuth = {
      mode: "signed",
      token: "user-bearer",
      user: { subject: "user_1", tokenIdentifier: "token_1", issuer: "https://issuer.test" },
    }
    const services = controlPlaneServices(signing.privateKey, signed)
    const bucket = r2Bucket()
    const options = {
      runtime: createHostedDocumentRuntimeBroker(services, env, relayFetch),
      localRelay: createHostedLocalDocumentRelay(services, env, relayFetch),
      resolveSessionWorkspace: async () => "cloud_ws",
      resolveLocalWorkspace: async () => "local_ws",
      listLocalWorkspaces: async () => [{ workspaceId: "local_ws", projectId: "project_1" }],
      reauthorizeJob: async ({ auth, entry: current }: { auth: SignedControlPlaneAuth; entry: DocumentIndexEntry }) => {
        if (auth.user.subject !== signed.user.subject || current.project_id !== "project_1") throw new Error("reauthorization denied")
      },
      env,
    }
    const firstBackend = createHostedDocumentsBackend(bucket, options)
    const secondBackend = createHostedDocumentsBackend(bucket, options)
    const authConfig: ControlPlaneAuthConfig = {
      enabled: true, issuer: "https://issuer.test", jwksUrl: "https://issuer.test/jwks",
    }
    const verifier: ClerkVerifier = async () => ({ ...signed, token: undefined } as never)
    const central = (backend: ReturnType<typeof createHostedDocumentsBackend>) => new Hono().route(
      "/documents",
      DocumentsRoutes({ backend: backend as never, services, authConfig, verifier }),
    )
    const firstApp = central(firstBackend)
    const secondApp = central(secondBackend)
    let activeCentral = firstApp
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (new URL(request.url).hostname === "local.test") return await localControl.fetch(request)
      if (new URL(request.url).hostname === "control.test") return await activeCentral.fetch(request)
      throw new Error(`unexpected integration fetch ${request.url}`)
    }) as typeof fetch

    try {
      const headers = { authorization: "Bearer user-bearer", "content-type": "application/json" }
      const discovered = await firstApp.request("https://control.test/documents/remote?project_id=project_1&local_workspace_id=local_ws&cloud_workspace_id=cloud_ws&session_id=session_1", { headers })
      expect(await discovered.json()).toMatchObject([{ id: "managed_remote" }, { id: "repository_remote", origin_kind: "repository" }])

      const managedOpenResponse = await firstApp.request("https://control.test/documents/managed_remote/agent-open", {
        method: "POST", headers, body: JSON.stringify({ session_id: "session_1" }),
      })
      const managedOpen = await managedOpenResponse.json() as { path: string }
      activeCentral = secondApp
      await fs.writeFile(managedOpen.path, "managed agent")
      await flushRuntimeDocument("session_1", "managed_remote")
      expect((await managed.read(await managed.resolve(portEntry(managedEntry)))).markdown).toBe("managed agent")

      const external = await managed.read(await managed.resolve(portEntry(managedEntry)))
      await localControl.request(`http://localhost/documents/managed_remote/content?project_id=project_1`, {
        method: "PUT", headers: { "content-type": "application/json", "if-match": external.version },
        body: JSON.stringify({ markdown: "managed durable" }),
      })
      await fs.writeFile(managedOpen.path, "managed draft")
      await expect(flushRuntimeDocument("session_1", "managed_remote")).rejects.toThrow("conflicted")
      const resolved = await secondApp.request("https://control.test/documents/managed_remote/runtime-conflict/resolve", {
        method: "POST", headers, body: JSON.stringify({ session_id: "session_1", choice: "durable" }),
      })
      expect(resolved.status).toBe(200)
      expect(await fs.readFile(managedOpen.path, "utf8")).toBe("managed durable")
      const renewed = await secondApp.request("https://control.test/documents/managed_remote/runtime-capability/renew?org_id=org_1&project_id=project_1&workspace_id=cloud_ws&session_id=session_1", {
        method: "POST", headers: { authorization: `Bearer ${sessionTokens.get("session_1")}` },
      })
      expect(renewed.status).toBe(200)
      expect(await renewed.json()).toMatchObject({ token: expect.any(String), expiresAt: expect.any(Number) })

      activeCentral = firstApp
      const repositoryOpenResponse = await firstApp.request("https://control.test/documents/repository_remote/agent-open", {
        method: "POST", headers, body: JSON.stringify({ session_id: "session_2" }),
      })
      const repositoryOpen = await repositoryOpenResponse.json() as { path: string }
      activeCentral = secondApp
      await fs.writeFile(repositoryOpen.path, "repository agent")
      await flushRuntimeDocument("session_2", "repository_remote")
      expect(await fs.readFile(path.join(repositoryRoot, "repository.md"), "utf8")).toBe("repository agent")
      expect((await secondApp.request("https://control.test/documents/repository_remote/runtime-capability/renew?org_id=org_1&project_id=project_1&workspace_id=cloud_ws&session_id=session_2", {
        method: "POST", headers: { authorization: `Bearer ${sessionTokens.get("session_2")}` },
      })).status).toBe(200)
    } finally {
      directory.dispose()
      await localRuntime.host.dispose()
      await cloudRuntime.host.dispose()
      restore(process.env, "WORKSPACE_RUNTIME_DIRECTORY", previous.root)
      restore(process.env, "CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM", previous.publicKey)
      restore(process.env, "CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM", previous.algorithm)
      restore(process.env, "CLAXEDO_CONTROL_PLANE_URL", previous.control)
      restore(process.env, "CLAXEDO_LOCAL_CONTROL_PLANE_URL", previous.localControl)
    }
  })
})

function entry(input: {
  id: string; displayName: string; origin: "managed" | "repository"; managedPath?: string; repositoryPath?: string
}, now: string): DocumentIndexEntry {
  const common = {
    id: input.id, org_id: "__local__", project_id: "project_1", display_name: input.displayName,
    placement_kind: "local" as const, placement_id: "local",
    status: "draft", session_id: null, archived_at: null, created_at: now, updated_at: now,
    last_opened_at: null, last_known_file_version: null,
  }
  if (input.origin === "managed") return {
    ...common,
    origin_kind: "managed",
    managed_relative_path: input.managedPath!,
    repository_id: null,
    workspace_id: null,
    repository_relative_path: null,
    branch: null,
  }
  return {
    ...common,
    origin_kind: "repository",
    managed_relative_path: null,
    repository_id: `repository:${input.id}`,
    workspace_id: "local_ws",
    repository_relative_path: input.repositoryPath!,
    branch: "main",
  }
}

function localDocumentsBackend(
  rows: Map<string, DocumentIndexEntry>,
  managed: ReturnType<typeof createLocalManagedDocumentWorkspace>,
  repository: ReturnType<typeof createRepositoryDocumentWorkspace>,
) {
  const index = {
    list: async (scope: { projectId: string }, options?: { archived?: "active" | "archived" | "all" }) => [...rows.values()].filter((row) =>
      row.project_id === scope.projectId && (options?.archived === "all" || !row.archived_at)),
    find: async (_orgId: string, id: string) => rows.get(id),
    findRepository: async (_scope: unknown, id: string) => [...rows.values()].find((row) => row.repository_id === id),
    create: async (value: DocumentIndexEntry) => (rows.set(value.id, value), value),
    remove: async (_scope: unknown, id: string) => { rows.delete(id) },
    update: async (_scope: unknown, id: string, input: Partial<DocumentIndexEntry>) => {
      const next = { ...rows.get(id)!, ...input, updated_at: new Date().toISOString() } as DocumentIndexEntry
      rows.set(id, next)
      return next
    },
    relocate: async () => { throw new Error("not used") },
    archive: async (_scope: unknown, id: string) => index.update({}, id, { archived_at: new Date().toISOString() }),
    restore: async (_scope: unknown, id: string) => index.update({}, id, { archived_at: null }),
    listStatuses: async () => [],
    transitionStatus: async (_scope: unknown, id: string, status: string) => index.update({}, id, { status }),
    resolveLocalProjectId: async () => "project_1",
  }
  const workspace = {
    create: managed.create,
    resolve: (value: DocumentEntry) => value.origin === "managed" ? managed.resolve(value) : repository.resolve(value),
    read: (handle: Awaited<ReturnType<typeof managed.resolve>> | Awaited<ReturnType<typeof repository.resolve>>) =>
      handle.origin === "managed" ? managed.read(handle) : repository.read(handle),
    write: (handle: Awaited<ReturnType<typeof managed.resolve>> | Awaited<ReturnType<typeof repository.resolve>>, request: never) =>
      handle.origin === "managed" ? managed.write(handle, request) : repository.write(handle, request),
    snapshot: (handle: Awaited<ReturnType<typeof managed.resolve>> | Awaited<ReturnType<typeof repository.resolve>>, request: never) =>
      handle.origin === "managed" ? managed.snapshot(handle, request) : repository.snapshot(handle, request),
    listSnapshots: (handle: Awaited<ReturnType<typeof managed.resolve>> | Awaited<ReturnType<typeof repository.resolve>>) =>
      handle.origin === "managed" ? managed.listSnapshots(handle) : repository.listSnapshots(handle),
    readSnapshot: (handle: Awaited<ReturnType<typeof managed.resolve>> | Awaited<ReturnType<typeof repository.resolve>>, snapshotId: never) =>
      handle.origin === "managed" ? managed.readSnapshot(handle, snapshotId) : repository.readSnapshot(handle, snapshotId),
    pinSnapshot: (handle: Awaited<ReturnType<typeof managed.resolve>> | Awaited<ReturnType<typeof repository.resolve>>, snapshotId: never, pin: string) =>
      handle.origin === "managed" ? managed.pinSnapshot(handle, snapshotId, pin) : repository.pinSnapshot(handle, snapshotId, pin),
    unpinSnapshot: (handle: Awaited<ReturnType<typeof managed.resolve>> | Awaited<ReturnType<typeof repository.resolve>>, snapshotId: never, pin: string) =>
      handle.origin === "managed" ? managed.unpinSnapshot(handle, snapshotId, pin) : repository.unpinSnapshot(handle, snapshotId, pin),
    collectSnapshots: (handle: Awaited<ReturnType<typeof managed.resolve>> | Awaited<ReturnType<typeof repository.resolve>>) =>
      handle.origin === "managed" ? managed.collectSnapshots(handle) : repository.collectSnapshots(handle),
    restore: (handle: Awaited<ReturnType<typeof managed.resolve>> | Awaited<ReturnType<typeof repository.resolve>>, snapshotId: never, request: never) =>
      handle.origin === "managed" ? managed.restore(handle, snapshotId, request) : repository.restore(handle, snapshotId, request),
  }
  return { index, workspace, managedRelativePath: managedDocumentRelativePath, placement: "local" as const } as unknown as DocumentsRouteBackend
}

function portEntry(value: DocumentIndexEntry): DocumentEntry {
  return value.origin_kind === "managed"
    ? { origin: "managed", placement: "local", projectId: value.project_id, documentId: value.id, relativePath: value.managed_relative_path! }
    : { origin: "repository", placement: "local", projectId: value.project_id, documentId: value.id, workspaceId: value.workspace_id!, relativePath: value.repository_relative_path! }
}

function controlPlaneServices(privateKey: CryptoKey, auth: SignedControlPlaneAuth) {
  const provider = {
    mintRuntimeAccessToken: async (input: { workspaceId: string; hostId: string; subject: string; orgId: string; role: "viewer" | "editor" | "owner" }) => ({
      token: await mintRuntimeAccessToken({
        subject: input.subject, orgId: input.orgId, workspaceId: input.workspaceId, hostId: input.hostId, role: input.role,
      }, privateKey, "EdDSA"),
      expiresAt: Date.now() + 300_000,
    }),
    getRelayEndpoint: async () => "https://relay.test",
  }
  return {
    auth: { config: { enabled: true, issuer: "https://issuer.test", jwksUrl: "https://issuer.test/jwks" }, verifier: async () => auth },
    authority: {
      usersMe: async () => ({ id: "user_1" }),
      resolveOrgId: async () => "org_1",
      authorizeProject: async () => ({ ok: true, role: "editor", orgId: "org_1" }),
      resolveSession: async (_auth: SignedControlPlaneAuth, input: { sessionId: string }) => ({ workspace_id: "cloud_ws", session_id: input.sessionId }),
      authorizeSessionRead: async () => undefined,
      openWorkspace: async (_auth: SignedControlPlaneAuth, input: { workspaceId: string }) => input.workspaceId === "local_ws"
        ? { allowed: true, role: "editor", workspace: { workspace_id: "local_ws", org_id: "org_1", project_id: "project_1", access: "user-hosted", backing: "local-worktree" } }
        : { allowed: true, role: "editor", workspace: { workspace_id: "cloud_ws", org_id: "org_1", project_id: "project_1", access: "cloud", backing: "cloud-vm" } },
      activeLocalHostLink: async () => ({ active: true, host_id: "local_host", workspace_id: "local_ws", expires_at: Date.now() + 60_000, last_seen_at: Date.now() }),
      listWorkspaces: async () => [{ workspace_id: "local_ws", project_id: "project_1", access: "user-hosted", backing: "local-worktree" }],
    },
    sandbox: { sandboxManager: { target: async () => ({ status: "ready", hostId: "cloud_host", homeRegion: "us-east" }) } },
    relay: { provider },
  } as unknown as ControlPlaneServices
}

function r2Bucket() {
  let clock = 0
  const values = new Map<string, { body: Uint8Array; etag: string; uploaded: Date }>()
  return {
    get: async (key: string) => {
      const value = values.get(key)
      return value
        ? {
            etag: value.etag,
            uploaded: value.uploaded,
            size: value.body.byteLength,
            body: new Response(value.body.slice()).body!,
          }
        : null
    },
    put: async (key: string, body: Uint8Array, options?: { onlyIf?: { etagMatches?: string; etagDoesNotMatch?: string } }) => {
      const current = values.get(key)
      if (options?.onlyIf?.etagMatches && current?.etag !== options.onlyIf.etagMatches) return null
      if (options?.onlyIf?.etagDoesNotMatch === "*" && current) return null
      const value = { body: body.slice(), etag: `etag-${++clock}`, uploaded: new Date(clock) }
      values.set(key, value)
      return { etag: value.etag, uploaded: value.uploaded }
    },
    delete: async (key: string) => { values.delete(key) },
    list: async ({ prefix }: { prefix: string }) => ({
      objects: [...values.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({ key, etag: value.etag, uploaded: value.uploaded })),
      truncated: false,
    }),
  }
}

async function temporary(prefix: string) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  roots.add(root)
  return root
}

async function git(directory: string, args: string[]) {
  await exec("git", args, { cwd: directory })
}

function restore(env: NodeJS.ProcessEnv, key: string, value?: string) {
  if (value === undefined) delete env[key]
  else env[key] = value
}
