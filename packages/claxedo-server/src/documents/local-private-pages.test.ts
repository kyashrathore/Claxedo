import { expect, test } from "vitest"
import { createLocalDocumentsBackend } from "@claxedo/server-core/documents/backends/local/backend"
import { createDocumentsService } from "@claxedo/server-core/documents/service"
import { localControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { dataDir } from "@claxedo/server-core/platform/runtime/lib/paths"

test("local create persists the authenticated creator and authorizes reads from persisted metadata", async () => {
  const backend = createLocalDocumentsBackend({ dataDir, resolveWorkspace: async () => undefined, sessionMeta: async () => undefined, runGit: async () => "", reportError: () => {} })
  const scope = { orgId: "__local__", projectId: "local-project", actor: { type: "user" as const, id: localControlPlaneAuth().user.subject } }
  const page = await createDocumentsService(backend).create(scope, { displayName: "Local private", markdown: "private", status: "draft", sessionId: null })
  expect((await backend.index.find(scope.orgId, page.id))?.creator_id).toBe(scope.actor.id)
  expect((await createDocumentsService(backend).readContent(scope, page.id)).markdown).toBe("private")
  await expect(createDocumentsService(backend).readContent({ ...scope, actor: { type: "user", id: "stranger" } }, page.id)).rejects.toMatchObject({ status: 404 })
})
