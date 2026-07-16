import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import { describe, expect, test, vi } from "vitest"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  createWorkspaceRuntimeApp,
  flushRuntimeDocument,
  forgetRuntimeDocuments,
  relayWorkspaceRuntimeExposure,
} from "../../../workspace-runtime/src/index"
import type { SignedControlPlaneAuth } from "../control-plane/auth"
import type { ControlPlaneServices } from "../control-plane/services"
import { createHostedDocumentRuntimeBroker } from "./hosted-runtime-broker"
import type { DocumentIndexEntry } from "./index-store"
import { verifyDocumentRelayJobToken, verifyDocumentSessionToken } from "../control-plane/runtime-access-token"

const auth = { user: { subject: "user_1" } } as SignedControlPlaneAuth
const entry = {
  id: "document_1", org_id: "org_1", project_id: "project_1", display_name: "Plan",
  origin_kind: "managed", placement_kind: "hosted", placement_id: "r2",
  managed_relative_path: "document_1/plan.md", repository_id: null, workspace_id: null,
  repository_relative_path: null, branch: null, status: "draft", session_id: "session_1",
  archived_at: null, created_at: new Date(0).toISOString(), updated_at: new Date(0).toISOString(),
  last_opened_at: null, last_known_file_version: "v1",
} satisfies DocumentIndexEntry

describe("hosted document runtime broker", () => {
  test("relays exactly one selected object and keeps capability out of the response", async () => {
    const key = await generateKeyPair("EdDSA", { extractable: true })
    const env = {
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM: "EdDSA",
      CLAXEDO_PUBLIC_URL: "https://control.test",
    }
    const authorizeSessionRead = vi.fn(async () => undefined)
    const services = {
      authority: {
        resolveSession: vi.fn(async () => ({ workspace_id: "ws_1" })),
        authorizeSessionRead,
        openWorkspace: vi.fn(async () => ({ role: "editor", workspace: { workspace_id: "ws_1", org_id: "org_1", project_id: "project_1" } })),
      },
      sandbox: { sandboxManager: { target: vi.fn(async () => ({ status: "ready", hostId: "host_1", homeRegion: "us-east" })) } },
      relay: { provider: {
        mintRuntimeAccessToken: vi.fn(async () => ({ token: "runtime-token", expiresAt: Date.now() + 300_000 })),
        getRelayEndpoint: vi.fn(async () => "https://relay.test"),
      } },
    } as unknown as ControlPlaneServices
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(body).toMatchObject({ documentId: "document_1", markdown: "selected", baseVersion: "v1" })
      expect(JSON.stringify(body)).not.toContain("document_2")
      expect(body.writeback).toMatchObject({ url: expect.stringMatching(/^https:\/\/control\.test\//) })
      return Response.json({ path: "/workspace/.claxedo/sessions/session_1/docs/document_1/plan.md" })
    })
    const opened = await createHostedDocumentRuntimeBroker(services, env, fetcher).open({
      entry, sessionId: "session_1", auth, origin: "https://attacker.test",
      read: { markdown: "selected", version: "v1" as never, modifiedAt: 1 },
    })
    expect(opened.path).toContain("document_1")
    expect(authorizeSessionRead).toHaveBeenCalledWith(auth, { sessionId: "session_1", workspaceId: "ws_1" })
    expect(services.relay.provider!.mintRuntimeAccessToken).toHaveBeenCalledWith(expect.objectContaining({ role: "editor" }))
  })

  test("registers the write capability after hydration ACK and before runtime activation", async () => {
    const fixture = await runtimeFixture()
    const order: string[] = []
    const registerCapability = vi.fn(async () => {
      order.push("register")
    })
    const received = Promise.withResolvers<void>()
    const hydration = Promise.withResolvers<Response>()
    const opened = createHostedDocumentRuntimeBroker(fixture.services, fixture.env, async (_input, init) => {
      const body = JSON.parse(String(init?.body))
      if ("writeback" in body) {
        order.push("hydrate")
        expect(body).toMatchObject({ writeback: { token: expect.any(String) } })
        received.resolve()
        return await hydration.promise
      }
      order.push("activate")
      expect(registerCapability).toHaveBeenCalledOnce()
      expect(body).toEqual({})
      return Response.json({ path: "/workspace/document.md" })
    }).open({ ...fixture.input, registerCapability })
    await received.promise
    expect(registerCapability).not.toHaveBeenCalled()
    hydration.resolve(Response.json({ path: "/workspace/document.md" }))
    await expect(opened).resolves.toEqual({ path: "/workspace/document.md" })
    expect(registerCapability).toHaveBeenCalledOnce()
    expect(order).toEqual(["hydrate", "register", "activate"])
  })

  test("does not activate a capability received by a runtime that rejects hydration", async () => {
    const fixture = await runtimeFixture()
    const registerCapability = vi.fn(async () => undefined)
    let runtimeToken = ""
    await expect(createHostedDocumentRuntimeBroker(fixture.services, fixture.env, async (_input, init) => {
      runtimeToken = (JSON.parse(String(init?.body)) as { writeback: { token: string } }).writeback.token
      return new Response("hydration rejected", { status: 503 })
    }).open({ ...fixture.input, registerCapability })).rejects.toThrow("hydration failed: 503")
    expect(runtimeToken).not.toBe("")
    expect(registerCapability).not.toHaveBeenCalled()
  })

  test("fails closed when the session runtime is unreachable", async () => {
    const services = {
      authority: {
        resolveSession: vi.fn(async () => ({ workspace_id: "ws_1" })),
        authorizeSessionRead: vi.fn(async () => undefined),
        openWorkspace: vi.fn(async () => ({ role: "editor", workspace: { workspace_id: "ws_1", org_id: "org_1", project_id: "project_1" } })),
      },
      sandbox: { sandboxManager: { target: vi.fn(async () => ({ status: "missing" })) } },
      relay: { provider: {} },
    } as unknown as ControlPlaneServices
    await expect(createHostedDocumentRuntimeBroker(services, {}).open({
      entry, sessionId: "session_1", auth, origin: "https://control.test",
      read: { markdown: "selected", version: "v1" as never, modifiedAt: 1 },
    })).rejects.toThrow("unreachable")
  })

  test("denies viewer hydration before minting a writable runtime token", async () => {
    const mint = vi.fn()
    const services = {
      authority: {
        resolveSession: vi.fn(async () => ({ workspace_id: "ws_1" })),
        authorizeSessionRead: vi.fn(async () => undefined),
        openWorkspace: vi.fn(async () => ({ role: "viewer", workspace: {
          workspace_id: "ws_1", org_id: "org_1", project_id: "project_1",
        } })),
      },
      sandbox: { sandboxManager: { target: vi.fn() } },
      relay: { provider: { mintRuntimeAccessToken: mint } },
    } as unknown as ControlPlaneServices
    await expect(createHostedDocumentRuntimeBroker(services, {}).open({
      entry, sessionId: "session_1", auth, origin: "https://control.test",
      read: { markdown: "selected", version: "v1" as never, modifiedAt: 1 },
    })).rejects.toThrow("write access")
    expect(mint).not.toHaveBeenCalled()
  })

  test("mints a fresh resolve-only capability from the canonical version and human choice", async () => {
    const key = await generateKeyPair("EdDSA", { extractable: true })
    const env = {
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM: "EdDSA",
      CLAXEDO_PUBLIC_URL: "https://control.test",
    }
    const services = {
      authority: {
        resolveSession: vi.fn(async () => ({ workspace_id: "cloud_ws" })),
        authorizeSessionRead: vi.fn(async () => undefined),
        openWorkspace: vi.fn(async () => ({ role: "editor", workspace: {
          workspace_id: "cloud_ws", org_id: "org_1", project_id: "project_1",
        } })),
      },
      sandbox: { sandboxManager: { target: vi.fn(async () => ({ status: "ready", hostId: "cloud_host", homeRegion: "us-east" })) } },
      relay: { provider: {
        mintRuntimeAccessToken: vi.fn(async () => ({ token: "editor-rat", expiresAt: Date.now() + 300_000 })),
        getRelayEndpoint: vi.fn(async () => "https://relay.test"),
      } },
    } as unknown as ControlPlaneServices
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        strategy: string; remoteVersion: string; remoteMarkdown?: string
        job: { token: string }
      }
      expect(body).toMatchObject({ strategy: "use-remote", remoteVersion: "canonical-v3", remoteMarkdown: "canonical" })
      await expect(verifyDocumentRelayJobToken(body.job.token, {
        userId: "user_1", orgId: "org_1", projectId: "project_1",
        localWorkspaceId: "local_ws", cloudWorkspaceId: "cloud_ws",
        sessionId: "session_1", documentId: "document_1", operation: "resolve",
      }, env)).resolves.toMatchObject({ operations: ["resolve"] })
      return Response.json({ path: "/workspace/plan.md", preserved: "/workspace/plan.conflict.md" })
    })
    await expect(createHostedDocumentRuntimeBroker(services, env, fetcher).resolve({
      entry,
      sessionId: "session_1",
      auth,
      localWorkspaceId: "local_ws",
      cloudWorkspaceId: "cloud_ws",
      choice: "durable",
      current: { markdown: "canonical", version: "canonical-v3" as never, modifiedAt: 3 },
      jobExpiresAt: Math.floor(Date.now() / 1000) + 900,
      writeback: { token: "fresh-writeback", expiresAt: Date.now() + 300_000 },
    })).resolves.toMatchObject({ version: "canonical-v3", preserved: expect.stringContaining("conflict") })
    expect(services.relay.provider!.mintRuntimeAccessToken).toHaveBeenCalledWith(expect.objectContaining({ role: "editor" }))
  })

  test("roundtrips through relay-owned runtime hydration and conditional callback", async () => {
    const signing = await generateKeyPair("EdDSA", { extractable: true })
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "document-relay-roundtrip-"))
    const previousRoot = process.env.WORKSPACE_RUNTIME_DIRECTORY
    const previousControl = process.env.CLAXEDO_CONTROL_PLANE_URL
    const previousPublic = process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM
    process.env.WORKSPACE_RUNTIME_DIRECTORY = root
    process.env.CLAXEDO_CONTROL_PLANE_URL = "https://control.test"
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM = await exportSPKI(signing.publicKey)
    const runtime = createWorkspaceRuntimeApp({
      exposure: relayWorkspaceRuntimeExposure({
        key: signing.publicKey, workspaceId: "ws_1", hostId: "host_1", trustedDirectToken: "runtime-token",
      }),
    })
    let canonical = "before"
    let version = "v1"
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const expected = new Headers(init?.headers).get("if-match")
      if (expected !== version) return new Response("conflict", { status: 409 })
      canonical = (JSON.parse(String(init?.body)) as { markdown: string }).markdown
      version = "v2"
      return Response.json({ version })
    }) as unknown as typeof fetch
    try {
      const services = {
        authority: {
          resolveSession: vi.fn(async () => ({ workspace_id: "ws_1" })),
          authorizeSessionRead: vi.fn(async () => undefined),
          openWorkspace: vi.fn(async () => ({ role: "editor", workspace: { workspace_id: "ws_1", org_id: "org_1", project_id: "project_1" } })),
        },
        sandbox: { sandboxManager: { target: vi.fn(async () => ({ status: "ready", hostId: "host_1", homeRegion: "us-east" })) } },
        relay: { provider: {
          mintRuntimeAccessToken: vi.fn(async () => ({ token: "runtime-token", expiresAt: Date.now() + 300_000 })),
          getRelayEndpoint: vi.fn(async () => "https://relay.test"),
        } },
      } as unknown as ControlPlaneServices
      const broker = createHostedDocumentRuntimeBroker(services, {
        CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(signing.privateKey),
        CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM: "EdDSA",
        CLAXEDO_PUBLIC_URL: "https://control.test",
      }, async (input, init) => {
        const pathname = new URL(String(input)).pathname
        return await runtime.app.fetch(new Request(`http://runtime.test${pathname.slice(pathname.indexOf("/api/wr/"))}`, init))
      })
      const opened = await broker.open({
        entry, sessionId: "session_1", auth, origin: "https://control.test",
        read: { markdown: canonical, version: version as never, modifiedAt: 1 },
        registerCapability: async () => undefined,
      })
      await fs.writeFile(opened.path, "agent edit")
      await flushRuntimeDocument("session_1", "document_1")
      expect({ canonical, version }).toEqual({ canonical: "agent edit", version: "v2" })
    } finally {
      forgetRuntimeDocuments()
      await runtime.host.dispose()
      globalThis.fetch = originalFetch
      if (previousRoot === undefined) delete process.env.WORKSPACE_RUNTIME_DIRECTORY
      else process.env.WORKSPACE_RUNTIME_DIRECTORY = previousRoot
      if (previousControl === undefined) delete process.env.CLAXEDO_CONTROL_PLANE_URL
      else process.env.CLAXEDO_CONTROL_PLANE_URL = previousControl
      if (previousPublic === undefined) delete process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM
      else process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM = previousPublic
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test("registers replacement authority before activating a dirty restart flush", async () => {
    const signing = await generateKeyPair("EdDSA", { extractable: true })
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "document-relay-dirty-restart-"))
    const previousRoot = process.env.WORKSPACE_RUNTIME_DIRECTORY
    const previousControl = process.env.CLAXEDO_CONTROL_PLANE_URL
    const previousPublic = process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM
    const env = {
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(signing.privateKey),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM: "EdDSA",
      CLAXEDO_PUBLIC_URL: "https://control.test",
    }
    process.env.WORKSPACE_RUNTIME_DIRECTORY = root
    process.env.CLAXEDO_CONTROL_PLANE_URL = "https://control.test"
    process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM = await exportSPKI(signing.publicKey)
    const runtime = createWorkspaceRuntimeApp({
      exposure: relayWorkspaceRuntimeExposure({
        key: signing.publicKey,
        workspaceId: "ws_1",
        hostId: "host_1",
        trustedDirectToken: "runtime-token",
      }),
    })
    const order: string[] = []
    let canonical = "before"
    let version = "v1"
    let activeJti: string | undefined
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      order.push("writeback")
      const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer\s+/i, "")
      if (!token) return new Response("missing", { status: 401 })
      const claims = await verifyDocumentSessionToken(
        token,
        {
          orgId: "org_1",
          projectId: "project_1",
          workspaceId: "ws_1",
          sessionId: "session_1",
          documentId: "document_1",
        },
        env,
      )
      if (claims.jti !== activeJti) return new Response("inactive", { status: 403 })
      if (new Headers(init?.headers).get("if-match") !== version) return new Response("conflict", { status: 409 })
      canonical = (JSON.parse(String(init?.body)) as { markdown: string }).markdown
      version = "v2"
      return Response.json({ version })
    }) as unknown as typeof fetch

    try {
      const services = {
        authority: {
          resolveSession: vi.fn(async () => ({ workspace_id: "ws_1" })),
          authorizeSessionRead: vi.fn(async () => undefined),
          openWorkspace: vi.fn(async () => ({
            role: "editor",
            workspace: { workspace_id: "ws_1", org_id: "org_1", project_id: "project_1" },
          })),
        },
        sandbox: {
          sandboxManager: {
            target: vi.fn(async () => ({ status: "ready", hostId: "host_1", homeRegion: "us-east" })),
          },
        },
        relay: {
          provider: {
            mintRuntimeAccessToken: vi.fn(async () => ({ token: "runtime-token", expiresAt: Date.now() + 300_000 })),
            getRelayEndpoint: vi.fn(async () => "https://relay.test"),
          },
        },
      } as unknown as ControlPlaneServices
      const relay = async (input: string | URL | Request, init?: RequestInit) => {
        const pathname = new URL(String(input)).pathname
        const runtimePath = pathname.slice(pathname.indexOf("/api/wr/"))
        order.push(runtimePath.endsWith("/activate") ? "activate" : "hydrate")
        return await runtime.app.fetch(new Request(`http://runtime.test${runtimePath}`, init))
      }
      const broker = createHostedDocumentRuntimeBroker(services, env, relay)
      const first = await broker.open({
        entry,
        sessionId: "session_1",
        auth,
        origin: "https://control.test",
        read: { markdown: canonical, version: version as never, modifiedAt: 1 },
      })
      await fs.writeFile(first.path, "dirty after runtime crash")
      forgetRuntimeDocuments()

      const reopened = await broker.open({
        entry,
        sessionId: "session_1",
        auth,
        origin: "https://control.test",
        read: { markdown: canonical, version: version as never, modifiedAt: 1 },
        registerCapability: async (capability) => {
          order.push("register")
          activeJti = capability.jti
        },
      })

      expect(reopened.path).toBe(first.path)
      expect({ canonical, version }).toEqual({ canonical: "dirty after runtime crash", version: "v2" })
      expect(order).toEqual(["hydrate", "hydrate", "register", "activate", "writeback"])
    } finally {
      forgetRuntimeDocuments()
      await runtime.host.dispose()
      globalThis.fetch = originalFetch
      if (previousRoot === undefined) delete process.env.WORKSPACE_RUNTIME_DIRECTORY
      else process.env.WORKSPACE_RUNTIME_DIRECTORY = previousRoot
      if (previousControl === undefined) delete process.env.CLAXEDO_CONTROL_PLANE_URL
      else process.env.CLAXEDO_CONTROL_PLANE_URL = previousControl
      if (previousPublic === undefined) delete process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM
      else process.env.CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM = previousPublic
      await fs.rm(root, { recursive: true, force: true })
    }
  })

  test.each([
    ["declared success", () => new Response(JSON.stringify({ path: `/${"x".repeat(128)}` }), {
      headers: { "content-length": "256", "content-type": "application/json" },
    })],
    ["chunked error", () => streamedRuntimeResponse(["x".repeat(128)], 503)],
  ])("rejects an oversized %s response", async (_case, response) => {
    const fixture = await runtimeFixture()
    await expect(createHostedDocumentRuntimeBroker(fixture.services, fixture.env, async () => response(), {
      maxResponseBytes: 64,
    }).open(fixture.input)).rejects.toThrow("too large")
  })

  test("aborts runtime hydration when the relay never resolves", async () => {
    const fixture = await runtimeFixture()
    const registerCapability = vi.fn(async () => undefined)
    let signal: AbortSignal | undefined
    let runtimeToken = ""
    await expect(createHostedDocumentRuntimeBroker(fixture.services, fixture.env, async (_input, init) => {
      signal = init?.signal ?? undefined
      runtimeToken = (JSON.parse(String(init?.body)) as { writeback: { token: string } }).writeback.token
      return await new Promise<Response>(() => undefined)
    }, { requestTimeoutMs: 10 }).open({ ...fixture.input, registerCapability })).rejects.toThrow("timed out")
    expect(runtimeToken).not.toBe("")
    expect(registerCapability).not.toHaveBeenCalled()
    expect(signal?.aborted).toBe(true)
  })
})

async function runtimeFixture() {
  const key = await generateKeyPair("EdDSA", { extractable: true })
  const services = {
    authority: {
      resolveSession: vi.fn(async () => ({ workspace_id: "ws_1" })),
      authorizeSessionRead: vi.fn(async () => undefined),
      openWorkspace: vi.fn(async () => ({ role: "editor", workspace: {
        workspace_id: "ws_1", org_id: "org_1", project_id: "project_1",
      } })),
    },
    sandbox: { sandboxManager: { target: vi.fn(async () => ({
      status: "ready", hostId: "host_1", homeRegion: "us-east",
    })) } },
    relay: { provider: {
      mintRuntimeAccessToken: vi.fn(async () => ({ token: "runtime-token", expiresAt: Date.now() + 300_000 })),
      getRelayEndpoint: vi.fn(async () => "https://relay.test"),
    } },
  } as unknown as ControlPlaneServices
  return {
    services,
    env: {
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM: "EdDSA",
      CLAXEDO_PUBLIC_URL: "https://control.test",
    },
    input: {
      entry,
      sessionId: "session_1",
      auth,
      origin: "https://control.test",
      read: { markdown: "selected", version: "v1" as never, modifiedAt: 1 },
    },
  }
}

function streamedRuntimeResponse(chunks: string[], status = 200) {
  return new Response(new ReadableStream({
    start(controller) {
      chunks.forEach((chunk) => controller.enqueue(new TextEncoder().encode(chunk)))
      controller.close()
    },
  }), { status, headers: { "content-type": "application/json" } })
}
