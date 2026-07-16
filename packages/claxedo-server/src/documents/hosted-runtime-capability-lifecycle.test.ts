import { exportPKCS8, generateKeyPair } from "jose"
import { describe, expect, test } from "vitest"
import { mintDocumentSessionToken } from "../control-plane/runtime-access-token"
import { createHostedDocumentsBackend } from "./hosted-backend"
import type { DocumentIndexEntry } from "./index-store"

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
})

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
        arrayBuffer: async () => object.body.slice().buffer as ArrayBuffer,
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
