import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { RuntimeDocumentHydrationRoutes, forgetRuntimeDocuments } from "./document-hydration"

const originalFetch = globalThis.fetch
const roots: string[] = []
afterEach(async () => {
  globalThis.fetch = originalFetch
  for (const root of roots.splice(0)) {
    await forgetRuntimeDocuments()
    await fs.rm(root, { recursive: true, force: true })
  }
})

test("hydration refuses a revoked document before writing its content", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "private-document-"))
  roots.push(root)
  const calls: string[] = []
  globalThis.fetch = (async (url: string | URL | Request) => {
    calls.push(String(url))
    return new Response(null, { status: 404 })
  }) as typeof fetch
  const routes = RuntimeDocumentHydrationRoutes({
    workspaceId: "ws_1",
    workspaceRoot: root,
    controlPlaneOrigin: "https://control.test",
    verifyJob: async () => ({}),
  })
  const response = await routes.request("http://runtime.test/api/wr/documents/hydrate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      sessionId: "private_session",
      documentId: "private_document",
      displayName: "Private",
      markdown: "secret",
      baseVersion: "v1",
      writeback: {
        url: "https://control.test/documents/private_document/runtime-writeback",
        renewUrl: "https://control.test/documents/private_document/runtime-capability/renew",
        token: "writeback",
        expiresAt: Date.now() + 60_000,
      },
      job: {
        token: "signed-job",
        userId: "member",
        orgId: "org",
        projectId: "project",
      },
    }),
  })
  expect(response.status).toBe(404)
  expect(calls).toEqual(["https://control.test/documents/private_document/runtime-authorization"])
  expect(await fs.readdir(root)).toEqual([])
})
