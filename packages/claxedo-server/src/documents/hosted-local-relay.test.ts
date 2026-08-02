import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { exportPKCS8, exportSPKI, generateKeyPair, SignJWT } from "jose"
import { afterEach, describe, expect, test, vi } from "vitest"
import { Hono } from "hono"
import { createWorkspaceRelay, createWorkspaceRelayDirectory, mintRuntimeAccessToken } from "@claxedo/workspace-relay"
import { createWorkspaceRuntimeApp, relayWorkspaceRuntimeExposure } from "../../../workspace-runtime/src/index"
import type { ControlPlaneServices } from "../authority/services"
import type { DocumentsRouteBackend } from "../routes/documents"
import { createLocalManagedDocumentWorkspace, managedDocumentRelativePath } from "./local-managed"
import { createLocalDocumentJobState, LocalInstallationDocumentBroker } from "./local-installation-broker"
import { createHostedLocalDocumentRelay } from "./hosted-local-relay"
import type { DocumentIndexEntry } from "./index-store"
import { documentRelayJobTokenAudience, mintDocumentRelayJobToken } from "../authority/runtime-access-token"
import { runtimeAccessTokenIssuer } from "@claxedo/workspace-relay"
import { captureWorkspaceRuntimeInternalSecrets } from "../../../workspace-runtime/src/internal-secrets"

describe("hosted local document relay", () => {
  const originalFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test("bounds revoked JTIs and prunes active plus revoked state at expiry", () => {
    let now = 100
    const jobs = createLocalDocumentJobState({ now: () => now, maxRevoked: 2 })
    expect(jobs.activate("one", 110)).toBe(true)
    expect(jobs.revoke("one", 110)).toBe(true)
    expect(jobs.activate("two", 110)).toBe(true)
    expect(jobs.revoke("two", 110)).toBe(true)
    expect(jobs.activate("three", 110)).toBe(false)
    expect(jobs.active("one", 110)).toBe(false)
    expect(jobs.active("two", 110)).toBe(false)
    expect(jobs.size()).toEqual({ active: 0, revoked: 2 })
    now = 111
    expect(jobs.size()).toEqual({ active: 0, revoked: 0 })
    expect(jobs.activate("three", 120)).toBe(true)
  })

  test("discovers, reads, and conditionally writes through the retained installation broker", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "local-document-relay-"))
    const key = await generateKeyPair("EdDSA", { extractable: true })
    const privatePem = await exportPKCS8(key.privateKey)
    const publicPem = await exportSPKI(key.publicKey)
    const previous = {
      public: process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM,
      localUrl: process.env.CLAXEDO_LOCAL_CONTROL_PLANE_URL,
      installation: process.env.CLAXEDO_LOCAL_DOCUMENT_BROKER_TOKEN,
    }
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM = publicPem
    process.env.CLAXEDO_LOCAL_CONTROL_PLANE_URL = "http://local.test"
    process.env.CLAXEDO_LOCAL_DOCUMENT_BROKER_TOKEN = "installation-secret"
    const internalSecrets = captureWorkspaceRuntimeInternalSecrets()
    const managed = createLocalManagedDocumentWorkspace({ dataRoot: root })
    const entry = {
      id: "document_1",
      org_id: "__local__",
      project_id: "project_1",
      display_name: "Plan",
      origin_kind: "managed",
      placement_kind: "local",
      placement_id: "local",
      managed_relative_path: managedDocumentRelativePath({
        projectId: "project_1",
        documentId: "document_1",
        slug: "Plan",
      }),
      repository_id: null,
      workspace_id: null,
      repository_relative_path: null,
      branch: null,
      status: "draft",
      session_id: null,
      archived_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_opened_at: null,
      last_known_file_version: null,
    } satisfies DocumentIndexEntry
    const backend = {
      index: {
        list: async () => [entry],
        find: async (_org: string, id: string) => (id === entry.id ? entry : undefined),
        update: async () => entry,
      },
      workspace: managed,
    } as unknown as DocumentsRouteBackend
    const created = await managed.create(
      {
        origin: "managed",
        placement: "local",
        projectId: "project_1",
        documentId: entry.id,
        relativePath: entry.managed_relative_path,
      },
      { markdown: "before", actor: { type: "user", id: "user" } },
    )
    const local = new Hono().route(
      "/internal/documents",
      LocalInstallationDocumentBroker({
        backend,
        installationToken: "installation-secret",
      }),
    )
    let forwardedCapability: string | undefined
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      forwardedCapability = new Headers(init?.headers).get("x-claxedo-document-capability") ?? forwardedCapability
      return local.fetch(
        new Request(new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url), init),
      )
    }) as typeof fetch
    const untrusted = createWorkspaceRuntimeApp({
      exposure: { kind: "loopback" },
      internalSecrets,
    })
    expect((await untrusted.app.request("/api/wr/local-documents/broker", { method: "POST" })).status).toBe(404)
    const runtime = createWorkspaceRuntimeApp({
      exposure: relayWorkspaceRuntimeExposure({
        key: key.publicKey,
        workspaceId: "local_ws",
        hostId: "host_1",
      }),
      internalSecrets,
    })
    expect(process.env.CLAXEDO_LOCAL_DOCUMENT_BROKER_TOKEN).toBeUndefined()
    try {
      const installationHeaders = {
        authorization: "Bearer installation-secret",
        "x-claxedo-document-broker": "1",
      }
      expect(
        (
          await local.request("http://local.test/internal/documents/document_1?org_id=org_1&project_id=project_1", {
            headers: installationHeaders,
          })
        ).status,
      ).toBe(403)
      const jobScope = {
        userId: "user_1",
        orgId: "org_1",
        projectId: "project_1",
        localWorkspaceId: "local_ws",
        cloudWorkspaceId: "cloud_ws",
        sessionId: "session_1",
        documentId: "document_1",
        operations: ["read"] as const,
        jobExpiresAt: Math.floor(Date.now() / 1000) + 3600,
      }
      const job = await mintDocumentRelayJobToken(jobScope, {
        CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: privatePem,
        CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: publicPem,
        CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM: "EdDSA",
      })
      const jobHeaders = {
        ...installationHeaders,
        "x-claxedo-document-capability": job.token,
        "x-claxedo-document-user": "user_1",
        "x-claxedo-local-workspace": "local_ws",
        "x-claxedo-cloud-workspace": "cloud_ws",
        "x-claxedo-document-session": "session_1",
        "x-claxedo-document-id": "document_1",
        "x-claxedo-document-operation": "read",
      }
      expect(
        (
          await local.request("http://local.test/internal/documents/jobs/activate?org_id=org_1&project_id=project_1", {
            method: "POST",
            headers: jobHeaders,
          })
        ).status,
      ).toBe(200)
      expect(
        (
          await local.request("http://local.test/internal/documents/jobs/activate?org_id=org_1&project_id=project_1", {
            method: "POST",
            headers: { ...jobHeaders, "x-claxedo-document-operation": "write" },
          })
        ).status,
      ).toBe(403)
      expect(
        (
          await local.request("http://local.test/internal/documents/document_2?org_id=org_1&project_id=project_1", {
            headers: jobHeaders,
          })
        ).status,
      ).toBe(403)
      expect(
        (
          await local.request("http://local.test/internal/documents/document_1?org_id=org_1&project_id=project_2", {
            headers: jobHeaders,
          })
        ).status,
      ).toBe(403)
      const expired = await new SignJWT({
        user_id: "user_1",
        org_id: "org_1",
        project_id: "project_1",
        local_workspace_id: "local_ws",
        cloud_workspace_id: "cloud_ws",
        session_id: "session_1",
        document_id: "document_1",
        operations: ["read"],
        job_exp: Math.floor(Date.now() / 1000) - 1,
      })
        .setProtectedHeader({ alg: "EdDSA" })
        .setIssuer(runtimeAccessTokenIssuer)
        .setAudience(documentRelayJobTokenAudience)
        .setSubject("user_1")
        .setIssuedAt(Math.floor(Date.now() / 1000) - 10)
        .setExpirationTime(Math.floor(Date.now() / 1000) - 1)
        .setJti("expired-job")
        .sign(key.privateKey)
      expect(
        (
          await local.request("http://local.test/internal/documents/jobs/activate?org_id=org_1&project_id=project_1", {
            method: "POST",
            headers: { ...jobHeaders, "x-claxedo-document-capability": expired },
          })
        ).status,
      ).toBe(403)
      const wrongAudience = await mintRuntimeAccessToken(
        {
          subject: "user_1",
          orgId: "org_1",
          workspaceId: "local_ws",
          hostId: "host_1",
          role: "owner",
        },
        key.privateKey,
        "EdDSA",
      )
      expect(
        (
          await local.request("http://local.test/internal/documents/jobs/activate?org_id=org_1&project_id=project_1", {
            method: "POST",
            headers: { ...jobHeaders, "x-claxedo-document-capability": wrongAudience },
          })
        ).status,
      ).toBe(403)
      expect(
        (
          await local.request("http://local.test/internal/documents/jobs/revoke?org_id=org_1&project_id=project_1", {
            method: "POST",
            headers: jobHeaders,
          })
        ).status,
      ).toBe(200)
      expect(
        (
          await local.request("http://local.test/internal/documents/document_1?org_id=org_1&project_id=project_1", {
            headers: jobHeaders,
          })
        ).status,
      ).toBe(403)
      let active = true
      let role = "viewer"
      const services = {
        authority: {
          openWorkspace: vi.fn(async () => ({
            role,
            workspace: {
              workspace_id: "local_ws",
              org_id: "org_1",
              project_id: "project_1",
              access: "user-hosted",
              backing: "local-worktree",
            },
          })),
          activeLocalHostLink: vi.fn(async () => (active ? { active: true, host_id: "host_1" } : { active: false })),
        },
        relay: {
          provider: {
            mintRuntimeAccessToken: vi.fn(async () => ({
              token: await mintRuntimeAccessToken(
                {
                  subject: "user_1",
                  orgId: "org_1",
                  workspaceId: "local_ws",
                  hostId: "host_1",
                  role: "owner",
                },
                key.privateKey,
                "EdDSA",
              ),
              expiresAt: Date.now() + 300_000,
            })),
            getRelayEndpoint: vi.fn(async () => "https://relay.test"),
          },
        },
      } as unknown as ControlPlaneServices
      const directory = createWorkspaceRelayDirectory({ sweepIntervalMs: 0 })
      directory.registerHostTunnel({ hostId: "host_1", workspaceIds: ["local_ws"] })
      const workspaceRelay = createWorkspaceRelay({
        runtimeAccessKey: key.publicKey,
        relayHostSigningKey: key.privateKey,
        relayHostAlgorithm: "EdDSA",
        isRuntimeAccessTokenActive: async () => ({ active: true }),
        resolveTarget: async () => ({
          workspaceId: "local_ws",
          hostId: "host_1",
          baseUrl: "http://runtime.test",
          access: "user-hosted",
          backing: "local-worktree",
        }),
        directory,
        fetch: ((request: RequestInfo | URL, init?: RequestInit) => {
          const source = request instanceof Request ? request : new Request(request, init)
          const url = new URL(source.url)
          return runtime.app.fetch(new Request(`http://runtime.test${url.pathname}${url.search}`, source))
        }) as typeof fetch,
      })
      const relay = createHostedLocalDocumentRelay(
        services,
        {
          CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: privatePem,
        CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: publicPem,
          CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM: "EdDSA",
        },
        async (input, init) => await workspaceRelay.fetch(new Request(input, init)),
      )
      const auth = { user: { subject: "user_1" } } as never
      const common = {
        auth,
        orgId: "org_1",
        projectId: "project_1",
        localWorkspaceId: "local_ws",
        cloudWorkspaceId: "cloud_ws",
        sessionId: "session_1",
        documentId: entry.id,
        jobExpiresAt: Math.floor(Date.now() / 1000) + 3600,
      }
      const read = (await relay.request({ ...common, operation: "read" })) as {
        read: { markdown: string; version: string }
      }
      expect(read.read.markdown).toBe("before")
      expect(forwardedCapability).toBeTruthy()
      expect(
        (
          await local.request("http://local.test/internal/documents/jobs/activate?org_id=org_1&project_id=project_1", {
            method: "POST",
            headers: {
              ...jobHeaders,
              "x-claxedo-document-capability": forwardedCapability!,
              "x-claxedo-document-operation": "read",
            },
          })
        ).status,
      ).toBe(403)
      const listed = (await relay.request({ ...common, documentId: "*", operation: "list" })) as DocumentIndexEntry[]
      expect(listed).toMatchObject([{ id: "document_1", org_id: "org_1" }])
      await expect(
        relay.request({
          ...common,
          operation: "write",
          markdown: "viewer edit",
          expectedVersion: created.version,
        }),
      ).rejects.toThrow("write access")
      role = "editor"
      await expect(
        relay.request({
          ...common,
          operation: "write",
          markdown: "x".repeat(2 * 1024 * 1024 + 64 * 1024),
          expectedVersion: created.version,
        }),
      ).rejects.toThrow("413")
      const written = (await relay.request({
        ...common,
        operation: "write",
        markdown: "agent edit",
        expectedVersion: created.version,
      })) as { version: string }
      expect(written.version).not.toBe(created.version)
      expect(services.relay.provider!.mintRuntimeAccessToken).toHaveBeenLastCalledWith(
        expect.objectContaining({ role: "editor" }),
      )
      await expect(
        relay.request({
          ...common,
          operation: "write",
          markdown: "stale",
          expectedVersion: created.version,
        }),
      ).rejects.toThrow()
      await expect(relay.request({ ...common, documentId: "document_2", operation: "read" })).rejects.toThrow()
      await expect(relay.request({ ...common, projectId: "project_2", operation: "read" })).rejects.toThrow("scope")
      active = false
      await expect(relay.request({ ...common, operation: "read" })).rejects.toThrow("unreachable")
      directory.dispose()
    } finally {
      await untrusted.host.dispose()
      await runtime.host.dispose()
      if (previous.public === undefined) delete process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM
      else process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM = previous.public
      if (previous.localUrl === undefined) delete process.env.CLAXEDO_LOCAL_CONTROL_PLANE_URL
      else process.env.CLAXEDO_LOCAL_CONTROL_PLANE_URL = previous.localUrl
      if (previous.installation === undefined) delete process.env.CLAXEDO_LOCAL_DOCUMENT_BROKER_TOKEN
      else process.env.CLAXEDO_LOCAL_DOCUMENT_BROKER_TOKEN = previous.installation
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test.each([
    ["declared success", () => new Response(JSON.stringify({ value: "x".repeat(128) }), {
      headers: { "content-length": "256", "content-type": "application/json" },
    })],
    ["chunked conflict", () => streamedResponse([JSON.stringify({ currentVersion: "x".repeat(128) })], 409)],
    ["chunked error", () => streamedResponse(["x".repeat(128)], 503)],
  ])("rejects an oversized %s relay response", async (_case, response) => {
    const fixture = await relayFixture()
    await expect(
      createHostedLocalDocumentRelay(fixture.services, fixture.env, async () => response(), {
        maxResponseBytes: 64,
      }).request(fixture.input),
    ).rejects.toThrow("too large")
  })

  test("aborts a relay request that never resolves", async () => {
    const fixture = await relayFixture()
    let signal: AbortSignal | undefined
    await expect(
      createHostedLocalDocumentRelay(fixture.services, fixture.env, async (_input, init) => {
        signal = init?.signal ?? undefined
        return await new Promise<Response>(() => undefined)
      }, { requestTimeoutMs: 10 }).request(fixture.input),
    ).rejects.toThrow("timed out")
    expect(signal?.aborted).toBe(true)
  })

  test("cancels a relay response body that never completes", async () => {
    const fixture = await relayFixture()
    let cancelled = false
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{"))
      },
      cancel() {
        cancelled = true
      },
    }))
    await expect(
      createHostedLocalDocumentRelay(fixture.services, fixture.env, async () => response, {
        requestTimeoutMs: 10,
      }).request(fixture.input),
    ).rejects.toThrow("timed out")
    expect(cancelled).toBe(true)
  })

  test("rejects a malformed success envelope", async () => {
    const fixture = await relayFixture()
    await expect(
      createHostedLocalDocumentRelay(fixture.services, fixture.env, async () => Response.json("not-an-envelope"))
        .request(fixture.input),
    ).rejects.toThrow("response is invalid")
  })
})

async function relayFixture() {
  const key = await generateKeyPair("EdDSA", { extractable: true })
  return {
    env: {
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM: "EdDSA",
    },
    services: {
      authority: {
        openWorkspace: vi.fn(async () => ({
          role: "editor",
          workspace: {
            workspace_id: "local_ws",
            org_id: "org_1",
            project_id: "project_1",
            access: "user-hosted",
            backing: "local-worktree",
          },
        })),
        activeLocalHostLink: vi.fn(async () => ({ active: true, host_id: "host_1" })),
      },
      relay: { provider: {
        mintRuntimeAccessToken: vi.fn(async () => ({ token: "runtime-token", expiresAt: Date.now() + 300_000 })),
        getRelayEndpoint: vi.fn(async () => "https://relay.test"),
      } },
    } as unknown as ControlPlaneServices,
    input: {
      auth: { user: { subject: "user_1" } } as never,
      orgId: "org_1",
      projectId: "project_1",
      localWorkspaceId: "local_ws",
      cloudWorkspaceId: "cloud_ws",
      sessionId: "session_1",
      documentId: "document_1",
      operation: "read" as const,
      jobExpiresAt: Math.floor(Date.now() / 1000) + 300,
    },
  }
}

function streamedResponse(chunks: string[], status = 200) {
  return new Response(new ReadableStream({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(new TextEncoder().encode(chunk)))
      controller.close()
    },
  }), { status, headers: { "content-type": "application/json" } })
}
