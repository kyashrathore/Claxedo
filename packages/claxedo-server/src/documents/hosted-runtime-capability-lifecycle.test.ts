import { exportPKCS8, exportSPKI, generateKeyPair } from "jose"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { describe, expect, test, vi } from "vitest"
import { flushRuntimeDocument, forgetRuntimeDocuments } from "../../../workspace-runtime/src"
import { RuntimeDocumentHydrationRoutes } from "../../../workspace-runtime/src/routes/document-hydration"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import type { ControlPlaneServices } from "../authority/services"
import { mintDocumentSessionToken } from "../platform/auth/runtime-access-token"
import { createHostedDocumentsBackend } from "./backends/hosted/backend"
import type { DocumentIndexEntry } from "./index-store"
import { createHostedDocumentRuntimeBroker } from "./backends/hosted/runtime-broker"

const entry = {
  id: "document_1",
  org_id: "org_1",
  project_id: "project_1",
  display_name: "Plan",
  origin_kind: "managed",
  placement_kind: "hosted",
  placement_id: "r2",
  managed_relative_path: "document_1/plan.md",
  repository_id: null,
  workspace_id: null,
  repository_relative_path: null,
  branch: null,
  status: "draft",
  session_id: "session_1",
  archived_at: null,
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
  last_opened_at: null,
  last_known_file_version: null,
} satisfies DocumentIndexEntry

describe("hosted runtime capability lifecycle", () => {
  test("tombstones a capability when hydration fails after registration", async () => {
    const key = await generateKeyPair("EdDSA", { extractable: true })
    const env = {
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM: "EdDSA",
    }
    let capability: Awaited<ReturnType<typeof mintDocumentSessionToken>> | undefined
    const backend = createHostedDocumentsBackend(memoryBucket(), {
      env,
      resolveSessionWorkspace: async () => "ws_1",
      runtime: {
        open: async (input) => {
          capability = await mintDocumentSessionToken({
            orgId: input.entry.org_id,
            projectId: input.entry.project_id,
            workspaceId: "ws_1",
            sessionId: input.sessionId,
            documentId: input.entry.id,
            jobExpiresAt: input.jobExpiresAt!,
          }, env)
          await input.registerCapability?.({ jti: capability.jti, jobExpiresAt: input.jobExpiresAt! })
          throw new Error("runtime hydration timed out")
        },
      },
    })
    await backend.index.create(entry)
    const created = await backend.workspace.create({
      origin: "managed",
      placement: "hosted",
      orgId: entry.org_id,
      projectId: entry.project_id,
      documentId: entry.id,
      relativePath: entry.managed_relative_path,
    }, { markdown: "before", actor: { type: "user", id: "user_1" } })
    await expect(backend.agentOpen!(entry, "session_1", {
      auth: { user: { subject: "user_1" } } as never,
      origin: "https://control.test",
    })).rejects.toThrow("hydration timed out")
    const scope = {
      token: capability!.token,
      orgId: entry.org_id,
      projectId: entry.project_id,
      workspaceId: "ws_1",
      sessionId: "session_1",
    }
    await expect(backend.runtimeWriteback!(entry, {
      ...scope,
      markdown: "late write",
      expectedVersion: created.version,
    })).rejects.toThrow("authority expired")
    await expect(backend.runtimeRenew!(entry, scope)).rejects.toThrow("authority expired")
    await expect(backend.workspace.read(await backend.workspace.resolve({
      origin: "managed",
      placement: "hosted",
      orgId: entry.org_id,
      projectId: entry.project_id,
      documentId: entry.id,
      relativePath: entry.managed_relative_path,
    }))).resolves.toMatchObject({ markdown: "before" })
  })

  test("keeps a failed activation pending and tombstones its registered capability", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "hosted-runtime-pending-activation-"))
    const key = await generateKeyPair("EdDSA", { extractable: true })
    const env = {
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PRIVATE_KEY_PEM: await exportPKCS8(key.privateKey),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_PUBLIC_KEY_PEM: await exportSPKI(key.publicKey),
      CLAXEDO_RUNTIME_ACCESS_TOKEN_ALGORITHM: "EdDSA",
      CLAXEDO_PUBLIC_URL: "https://control.test",
    }
    const activationEntered = Promise.withResolvers<void>()
    const rejectActivation = Promise.withResolvers<void>()
    const callback = vi.fn(async () => Response.json({ version: "v2" }))
    const originalFetch = globalThis.fetch
    globalThis.fetch = callback as unknown as typeof fetch
    let hydratedPath = ""
    let capabilityToken = ""
    const runtime = RuntimeDocumentHydrationRoutes({
      workspaceRoot: root,
      trustedTransport: true,
      controlPlaneOrigin: "https://control.test",
      verifyJob: async (_token, expected) => {
        if (expected.operation !== "write") return {}
        activationEntered.resolve()
        await rejectActivation.promise
        throw new Error("activation rejected")
      },
    })
    const relay = async (input: string | URL | Request, init?: RequestInit) => {
      const pathname = new URL(String(input)).pathname
      const runtimePath = pathname.slice(pathname.indexOf("/api/wr/"))
      if (runtimePath.endsWith("/hydrate")) {
        capabilityToken = (JSON.parse(String(init?.body)) as { writeback: { token: string } }).writeback.token
      }
      const response = await runtime.fetch(new Request(`http://runtime.test${runtimePath}`, init))
      if (runtimePath.endsWith("/hydrate")) {
        hydratedPath = ((await response.clone().json()) as { path: string }).path
      }
      return response
    }
    const backend = createHostedDocumentsBackend(memoryBucket(), {
      env,
      resolveSessionWorkspace: async () => "ws_1",
      runtime: createHostedDocumentRuntimeBroker(runtimeServices(), env, relay),
    })
    try {
      await backend.index.create(entry)
      const created = await backend.workspace.create({
        origin: "managed",
        placement: "hosted",
        orgId: entry.org_id,
        projectId: entry.project_id,
        documentId: entry.id,
        relativePath: entry.managed_relative_path,
      }, { markdown: "before", actor: { type: "user", id: "user_1" } })
      const opened = expect(backend.agentOpen!(entry, "session_1", {
        auth: { user: { subject: "user_1" } } as SignedControlPlaneAuth,
        origin: "https://control.test",
      })).rejects.toThrow("activation failed: 403")
      await activationEntered.promise
      await fs.writeFile(hydratedPath, "edit while activation hangs")
      await new Promise((resolve) => setTimeout(resolve, 150))
      await expect(flushRuntimeDocument("session_1", "document_1")).rejects.toThrow("not activated")
      expect(callback).not.toHaveBeenCalled()

      rejectActivation.resolve()
      await opened
      const scope = {
        token: capabilityToken,
        orgId: entry.org_id,
        projectId: entry.project_id,
        workspaceId: "ws_1",
        sessionId: "session_1",
      }
      await expect(backend.runtimeWriteback!(entry, {
        ...scope,
        markdown: "late write",
        expectedVersion: created.version,
      })).rejects.toThrow("authority expired")
      await expect(backend.runtimeRenew!(entry, scope)).rejects.toThrow("authority expired")
      await expect(backend.workspace.read(await backend.workspace.resolve({
        origin: "managed",
        placement: "hosted",
        orgId: entry.org_id,
        projectId: entry.project_id,
        documentId: entry.id,
        relativePath: entry.managed_relative_path,
      }))).resolves.toMatchObject({ markdown: "before" })
      expect(callback).not.toHaveBeenCalled()
    } finally {
      rejectActivation.resolve()
      forgetRuntimeDocuments()
      globalThis.fetch = originalFetch
      await fs.rm(root, { recursive: true, force: true })
    }
  })
})

function runtimeServices() {
  return {
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
}

function memoryBucket() {
  let generation = 0
  const objects = new Map<string, { body: Uint8Array; etag: string; uploaded: Date }>()
  return {
    async get(key: string) {
      const object = objects.get(key)
      if (!object) return null
      return {
        etag: object.etag,
        uploaded: object.uploaded,
        size: object.body.byteLength,
        body: new Response(object.body.slice()).body!,
      }
    },
    async put(key: string, body: Uint8Array, options?: { onlyIf?: { etagMatches?: string } }) {
      const current = objects.get(key)
      if (options?.onlyIf?.etagMatches ? current?.etag !== options.onlyIf.etagMatches : Boolean(current)) return null
      const value = { body: body.slice(), etag: `etag-${++generation}`, uploaded: new Date(generation) }
      objects.set(key, value)
      return { etag: value.etag, uploaded: value.uploaded }
    },
    async delete(key: string) {
      objects.delete(key)
    },
    async list({ prefix }: { prefix: string }) {
      return {
        objects: [...objects.entries()].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => ({
          key,
          etag: value.etag,
          uploaded: value.uploaded,
        })),
        truncated: false,
      }
    },
  }
}
